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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function readSubmissionId(payload) {
  return payload.id || payload.submissionId || payload.notarizationId || null;
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
  const submitLogPath = join(logDir, `${basename(context.appOutDir)}-app.submit.json`);
  const timeoutMs = Number.parseInt(process.env.PAPERCLIP_NOTARY_TIMEOUT_MS || "", 10) || 45 * 60 * 1000;
  const pollIntervalMs = Number.parseInt(process.env.PAPERCLIP_NOTARY_POLL_INTERVAL_MS || "", 10) || 30 * 1000;

  mkdirSync(logDir, { recursive: true });

  console.log(`[after-sign] Submitting ${appPath} for notarization...`);
  const submitOutput = execFileSync(
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
      "--no-wait",
      "--output-format",
      "json",
    ],
    { encoding: "utf8" },
  );

  writeFileSync(submitLogPath, submitOutput.endsWith("\n") ? submitOutput : `${submitOutput}\n`, "utf8");

  const submitted = JSON.parse(submitOutput);
  const submissionId = readSubmissionId(submitted);
  if (!submissionId) {
    throw new Error(`Unable to determine notarization submission id for ${appPath}.`);
  }

  console.log(`[after-sign] Notarization submission id: ${submissionId}`);

  const startedAt = Date.now();
  let finalInfo = null;

  while (Date.now() - startedAt < timeoutMs) {
    await sleep(pollIntervalMs);

    const infoOutput = execFileSync(
      "xcrun",
      [
        "notarytool",
        "info",
        submissionId,
        "--key",
        requireEnv("APPLE_API_KEY"),
        "--key-id",
        requireEnv("APPLE_API_KEY_ID"),
        "--issuer",
        requireEnv("APPLE_API_ISSUER"),
        "--output-format",
        "json",
      ],
      { encoding: "utf8" },
    );

    finalInfo = JSON.parse(infoOutput);
    writeFileSync(logPath, infoOutput.endsWith("\n") ? infoOutput : `${infoOutput}\n`, "utf8");
    console.log(`[after-sign] Notarization status for ${basename(appPath)}: ${finalInfo.status}`);

    if (finalInfo.status === "Accepted") {
      break;
    }

    if (finalInfo.status === "Invalid" || finalInfo.status === "Rejected") {
      throw new Error(`Apple notarization failed for ${appPath}: ${finalInfo.status}`);
    }
  }

  if (!finalInfo || finalInfo.status !== "Accepted") {
    throw new Error(
      `Timed out waiting for Apple notarization of ${appPath} after ${Math.round(timeoutMs / 60000)} minute(s).`,
    );
  }

  console.log(`[after-sign] Stapling notarization ticket to ${appPath}...`);
  execFileSync("xcrun", ["stapler", "staple", "-v", appPath], { stdio: "inherit" });
  execFileSync("xcrun", ["stapler", "validate", "-v", appPath], { stdio: "inherit" });
}
