import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { tmpdir } from "node:os";

const outputDir = resolve(process.argv[2] || "release");
const expectedIdentity = process.env.APPLE_CODESIGN_IDENTITY?.trim() || null;
const expectedTeamId = process.env.APPLE_TEAM_ID?.trim() || null;

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    ...options,
  });

  if (result.status !== 0) {
    const message = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
    throw new Error(`${command} ${args.join(" ")} failed.\n${message}`);
  }

  return {
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

function walk(dir, out = []) {
  if (!existsSync(dir)) return out;

  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    let stat;
    try {
      stat = lstatSync(full);
    } catch {
      continue;
    }

    if (stat.isSymbolicLink()) continue;
    if (stat.isDirectory()) {
      out.push(full);
      walk(full, out);
      continue;
    }

    out.push(full);
  }

  return out;
}

function codesignMetadata(target) {
  const { stderr } = run("codesign", ["-dvv", target]);
  const lines = stderr.split(/\r?\n/);
  const authority = lines.find((line) => line.startsWith("Authority="))?.replace(/^Authority=/, "") || null;
  const teamIdentifier = lines.find((line) => line.startsWith("TeamIdentifier="))?.replace(/^TeamIdentifier=/, "") || null;

  if (expectedIdentity && authority !== expectedIdentity) {
    throw new Error(`Unexpected signing identity for ${target}: ${authority ?? "missing"} != ${expectedIdentity}`);
  }

  if (expectedTeamId && teamIdentifier !== expectedTeamId) {
    throw new Error(`Unexpected team identifier for ${target}: ${teamIdentifier ?? "missing"} != ${expectedTeamId}`);
  }

  return { authority, teamIdentifier };
}

function relativePaths(paths) {
  return paths.map((path) => path.replace(`${outputDir}/`, ""));
}

const entries = walk(outputDir);
const appBundles = entries.filter((entry) => entry.endsWith(".app"));
const dmgArtifacts = entries.filter((entry) => entry.endsWith(".dmg"));
const zipArtifacts = entries.filter((entry) => entry.endsWith(".zip"));

if (appBundles.length === 0) {
  throw new Error(`No macOS app bundle found under ${outputDir}.`);
}

if (dmgArtifacts.length === 0) {
  throw new Error(`No DMG artifact found under ${outputDir}.`);
}

if (zipArtifacts.length === 0) {
  throw new Error(`No ZIP artifact found under ${outputDir}.`);
}

const verification = {
  appBundles: [],
  dmgArtifacts: [],
  zipArtifacts: [],
};

for (const appPath of appBundles) {
  const allFiles = walk(appPath);
  const mainExecutable = walk(join(appPath, "Contents", "MacOS")).find((entry) => !entry.endsWith("/Contents/MacOS"));
  const helperExecutable = allFiles.find((entry) => /\/Contents\/Frameworks\/.+\.app\/Contents\/MacOS\//.test(entry));
  const nodeBinary = allFiles.find((entry) => entry.endsWith("/Contents/Resources/app-server/node-bin/node"));
  const postgresBinary = allFiles.find((entry) => /@embedded-postgres\/darwin-[^/]+\/native\/bin\/postgres$/.test(entry));
  const initdbBinary = allFiles.find((entry) => /@embedded-postgres\/darwin-[^/]+\/native\/bin\/initdb$/.test(entry));
  const pgCtlBinary = allFiles.find((entry) => /@embedded-postgres\/darwin-[^/]+\/native\/bin\/pg_ctl$/.test(entry));
  const nativeNodeModule = allFiles.find((entry) => entry.endsWith(".node"));
  const nativeDylib = allFiles.find((entry) => /libpq.*\.dylib$/.test(entry)) || allFiles.find((entry) => entry.endsWith(".dylib"));

  execFileSync("codesign", ["--verify", "--deep", "--strict", "--verbose=2", appPath], { stdio: "inherit" });
  execFileSync("xcrun", ["stapler", "validate", "-v", appPath], { stdio: "inherit" });
  execFileSync("spctl", ["-a", "-vv", "--type", "exec", appPath], { stdio: "inherit" });

  const checks = {};
  for (const [label, target] of [
    ["appBundle", appPath],
    ["mainExecutable", mainExecutable],
    ["helperExecutable", helperExecutable],
    ["nodeBinary", nodeBinary],
    ["postgresBinary", postgresBinary],
    ["initdbBinary", initdbBinary],
    ["pgCtlBinary", pgCtlBinary],
    ["nativeNodeModule", nativeNodeModule],
    ["nativeDylib", nativeDylib],
  ]) {
    if (!target) continue;
    execFileSync("codesign", ["--verify", "--strict", "--verbose=2", target], { stdio: "inherit" });
    checks[label] = {
      path: target.replace(`${outputDir}/`, ""),
      ...codesignMetadata(target),
    };
  }

  verification.appBundles.push({
    path: appPath.replace(`${outputDir}/`, ""),
    checks,
  });
}

for (const dmgPath of dmgArtifacts) {
  execFileSync("xcrun", ["stapler", "validate", "-v", dmgPath], { stdio: "inherit" });
  execFileSync("spctl", ["-a", "-vv", "--type", "open", dmgPath], { stdio: "inherit" });
  verification.dmgArtifacts.push({
    path: dmgPath.replace(`${outputDir}/`, ""),
    ...codesignMetadata(dmgPath),
  });
}

for (const zipPath of zipArtifacts) {
  const extractDir = mkdtempSync(join(tmpdir(), "paperclip-zip-verify-"));
  try {
    execFileSync("ditto", ["-x", "-k", zipPath, extractDir], { stdio: "inherit" });
    const extractedApp = walk(extractDir).find((entry) => entry.endsWith(".app"));
    if (!extractedApp) {
      throw new Error(`No .app bundle found inside ${zipPath}`);
    }

    execFileSync("xcrun", ["stapler", "validate", "-v", extractedApp], { stdio: "inherit" });
    execFileSync("spctl", ["-a", "-vv", "--type", "exec", extractedApp], { stdio: "inherit" });
    verification.zipArtifacts.push({
      path: zipPath.replace(`${outputDir}/`, ""),
      extractedApp: extractedApp.replace(`${extractDir}/`, ""),
      ...codesignMetadata(extractedApp),
    });
  } finally {
    rmSync(extractDir, { recursive: true, force: true });
  }
}

const reportDir = join(outputDir, "notarization");
mkdirSync(reportDir, { recursive: true });
const reportPath = join(reportDir, "verification-summary.json");
writeFileSync(reportPath, `${JSON.stringify(verification, null, 2)}\n`, "utf8");

console.log(`Verified macOS artifacts in ${outputDir}`);
console.log(`App bundles: ${relativePaths(appBundles).join(", ")}`);
console.log(`DMGs: ${relativePaths(dmgArtifacts).join(", ")}`);
console.log(`ZIPs: ${relativePaths(zipArtifacts).join(", ")}`);
console.log(`Verification summary: ${reportPath}`);
