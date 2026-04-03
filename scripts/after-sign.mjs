import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";

function requireEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Missing required environment variable ${name}.`);
  }
  return value;
}

export default async function afterSign(context) {
  if (context.electronPlatformName !== "darwin") return;

  const shouldRequireNotarization = process.env.PAPERCLIP_REQUIRE_MACOS_RELEASE_SIGNING === "1";
  const hasNotaryCredentials = process.env.APPLE_API_KEY && process.env.APPLE_API_KEY_ID && process.env.APPLE_API_ISSUER;

  if (!hasNotaryCredentials) {
    if (shouldRequireNotarization) {
      requireEnv("APPLE_API_KEY");
      requireEnv("APPLE_API_KEY_ID");
      requireEnv("APPLE_API_ISSUER");
    }

    console.log("[after-sign] Apple notarization credentials are not configured, skipping app notarization.");
    return;
  }

  const appPath = join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  const logDir = join(context.packager.projectDir, "release", "notarization");
  const logPath = join(logDir, `${basename(context.appOutDir)}-app.json`);

  mkdirSync(logDir, { recursive: true });

  console.log(`[after-sign] Submitting ${appPath} for notarization...`);
  const notarizeOutput = execFileSync(
    "xcrun",
    [
      "notarytool",
      "submit",
      appPath,
      "--key",
      requireEnv("APPLE_API_KEY"),
      "--key-id",
      requireEnv("APPLE_API_KEY_ID"),
      "--issuer",
      requireEnv("APPLE_API_ISSUER"),
      "--wait",
      "--output-format",
      "json",
    ],
    { encoding: "utf8" },
  );

  writeFileSync(logPath, notarizeOutput.endsWith("\n") ? notarizeOutput : `${notarizeOutput}\n`, "utf8");

  const submission = JSON.parse(notarizeOutput);
  if (submission.status !== "Accepted") {
    throw new Error(`Apple notarization did not succeed for ${appPath}: ${submission.status}`);
  }

  console.log(`[after-sign] Stapling notarization ticket to ${appPath}...`);
  execFileSync("xcrun", ["stapler", "staple", "-v", appPath], { stdio: "inherit" });
  execFileSync("xcrun", ["stapler", "validate", "-v", appPath], { stdio: "inherit" });
}
