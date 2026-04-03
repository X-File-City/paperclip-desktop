import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { existsSync, readdirSync, lstatSync, readlinkSync, rmSync } from "node:fs";

/**
 * afterPack hook: ad-hoc sign the macOS .app bundle with entitlements.
 *
 * Uses ad-hoc signing (--sign -) to avoid Team ID mismatches that occur
 * with self-signed certificates and Electron's embedded framework signatures.
 * For distribution builds, proper signing is handled by electron-builder
 * via CSC_LINK / CSC_KEY_PASSWORD environment variables.
 */

/** Remove broken symlinks recursively — codesign fails on dangling links. */
function removeBrokenSymlinks(dir) {
  if (!existsSync(dir)) return;
  let entries;
  try { entries = readdirSync(dir); } catch { return; }
  for (const entry of entries) {
    const full = join(dir, entry);
    let stat;
    try { stat = lstatSync(full); } catch { continue; }
    if (stat.isSymbolicLink()) {
      try {
        const target = readlinkSync(full);
        const resolved = target.startsWith("/") ? target : join(dir, target);
        if (!existsSync(resolved)) {
          rmSync(full, { force: true });
        }
      } catch {
        rmSync(full, { force: true });
      }
    } else if (stat.isDirectory()) {
      removeBrokenSymlinks(full);
    }
  }
}

/** Recursively sign all Mach-O binaries and dylibs in a directory (skips symlinks). */
function signAllBinaries(dir, signFn) {
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    let stat;
    try { stat = lstatSync(full); } catch { continue; }
    if (stat.isSymbolicLink()) continue;
    if (stat.isDirectory()) {
      signAllBinaries(full, signFn);
    } else if (
      entry.endsWith(".dylib") ||
      // Sign executable binaries (no extension, executable bit set)
      (!entry.includes(".") && (stat.mode & 0o111))
    ) {
      signFn(full);
    }
  }
}

export default async function afterPack(context) {
  if (context.electronPlatformName !== "darwin") return;

  const appPath = join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  const entitlements = join(context.packager.info.buildResourcesDir, "entitlements.mac.plist");

  // ── Step 0: Clean the bundle before signing ────────────────────────────────
  // codesign rejects any file with resource forks, Finder info, or extended
  // attributes. We must strip ALL of these before signing.

  // 0a. Remove broken symlinks (node_modules/.bin stubs, embedded-postgres dylibs)
  console.log(`[after-pack] Cleaning broken symlinks...`);
  removeBrokenSymlinks(join(appPath, "Contents"));

  // 0b. Merge AppleDouble files, then nuke all ._* files and .DS_Store
  console.log(`[after-pack] Cleaning AppleDouble / .DS_Store files...`);
  try { execFileSync("dot_clean", [appPath]); } catch { /* ok */ }
  execFileSync("sh", ["-c",
    `find "${appPath}" -name "._*" -delete 2>/dev/null; find "${appPath}" -name ".DS_Store" -delete 2>/dev/null; true`
  ]);

  // 0c. Strip ALL extended attributes from every non-symlink file/dir.
  //     Using find + xattr -c per-file is more reliable than xattr -cr which
  //     can bail out part-way through on permission errors.
  console.log(`[after-pack] Stripping ALL extended attributes...`);
  execFileSync("sh", ["-c",
    `find "${appPath}" ! -type l -print0 | xargs -0 -n 200 xattr -c 2>/dev/null; true`
  ]);

  // Ad-hoc sign inside-out — innermost binaries first, outermost .app last.
  // NEVER use --deep; it signs in the wrong order and causes Team ID mismatches.
  const frameworks = join(appPath, "Contents", "Frameworks");

  // All components must use --options runtime so macOS library validation
  // sees a consistent signing identity (ad-hoc + hardened runtime everywhere).
  const sign = (target, opts = []) => {
    const args = ["--force", "--options", "runtime", "--sign", "-", ...opts, target];
    console.log(`[after-pack]   codesign ${target}`);
    execFileSync("codesign", args, { stdio: "inherit" });
  };

  const signWithEntitlements = (target) =>
    sign(target, ["--entitlements", entitlements]);

  // 1. Sign helper apps (sign their internal binaries first, then the .app)
  console.log(`[after-pack] Signing helper apps...`);
  for (const name of readdirSync(frameworks)) {
    if (name.endsWith(".app")) {
      const helperApp = join(frameworks, name);
      // Sign any binaries inside the helper's MacOS/ and Frameworks/ dirs first
      signAllBinaries(join(helperApp, "Contents", "MacOS"), sign);
      signAllBinaries(join(helperApp, "Contents", "Frameworks"), sign);
      signWithEntitlements(helperApp);
    }
  }

  // 2. Sign Electron Framework — subcomponents first, then the binary, then the bundle
  console.log(`[after-pack] Signing Electron Framework...`);
  const efBase = join(frameworks, "Electron Framework.framework");
  const efVersionA = join(efBase, "Versions", "A");

  // 2a. Sign all helpers inside the framework (e.g. chrome_crashpad_handler)
  signAllBinaries(join(efVersionA, "Helpers"), sign);

  // 2b. Sign all libraries inside the framework
  signAllBinaries(join(efVersionA, "Libraries"), sign);

  // 2c. Sign the main framework binary
  const efBinary = join(efVersionA, "Electron Framework");
  if (existsSync(efBinary)) {
    sign(efBinary);
  }

  // 2d. Sign the framework bundle itself
  sign(efBase);

  // 3. Sign all remaining dylibs in Frameworks/
  console.log(`[after-pack] Signing dylibs...`);
  const signDylibs = (dir) => {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      let stat;
      try { stat = lstatSync(full); } catch { continue; }
      if (stat.isSymbolicLink()) continue;
      // Skip directories we've already handled
      if (stat.isDirectory() && !entry.endsWith(".framework") && !entry.endsWith(".app")) {
        signDylibs(full);
      } else if (entry.endsWith(".dylib")) {
        sign(full);
      }
    }
  };
  signDylibs(frameworks);

  // 4. Sign any remaining frameworks (e.g. Mantle, ReactiveObjC, Squirrel)
  console.log(`[after-pack] Signing remaining frameworks...`);
  for (const name of readdirSync(frameworks)) {
    if (name.endsWith(".framework") && name !== "Electron Framework.framework") {
      // Sign subcomponents of other frameworks too
      const fwVersionA = join(frameworks, name, "Versions", "A");
      if (existsSync(fwVersionA)) {
        signAllBinaries(fwVersionA, sign);
      }
      sign(join(frameworks, name));
    }
  }

  // 5. Sign the main app binary and bundle last
  console.log(`[after-pack] Signing main app...`);
  signWithEntitlements(appPath);

  // Verify
  try {
    execFileSync("codesign", ["--verify", "--deep", "--strict", appPath], { stdio: "inherit" });
    console.log(`[after-pack] Signature verified successfully.`);
  } catch (e) {
    console.warn(`[after-pack] WARNING: Signature verification failed: ${e.message}`);
  }
}