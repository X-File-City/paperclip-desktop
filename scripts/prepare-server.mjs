#!/usr/bin/env node

/**
 * Installs @paperclipai/server from npm into a staging directory, then
 * assembles the server bundle that electron-builder packages into the app.
 *
 * Replaces the old pnpm-deploy-based approach from the monorepo.
 */

import { execSync } from "node:child_process";
import {
  rmSync, existsSync, readdirSync, readFileSync, writeFileSync,
  lstatSync, symlinkSync, realpathSync, mkdirSync, cpSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");

const stagingDir = path.join(projectRoot, "build", "server-staging");
const bundleDir = path.join(projectRoot, "build", "server-bundle");

// ── Read the target server version from package.json ────────────────────────

const projectPkg = JSON.parse(readFileSync(path.join(projectRoot, "package.json"), "utf8"));
const serverVersion = projectPkg.devDependencies["@paperclipai/server"];
if (!serverVersion) {
  console.error("[prepare-server] @paperclipai/server not found in devDependencies");
  process.exit(1);
}

console.log(`[prepare-server] Target server version: @paperclipai/server@${serverVersion}`);

// ── Step 1: Install @paperclipai/server into a staging directory ────────────

console.log("[prepare-server] Installing @paperclipai/server from npm...");

if (existsSync(stagingDir)) {
  rmSync(stagingDir, { recursive: true, force: true });
}
if (existsSync(bundleDir)) {
  rmSync(bundleDir, { recursive: true, force: true });
}

mkdirSync(stagingDir, { recursive: true });

// Write a minimal package.json for the staging install
writeFileSync(
  path.join(stagingDir, "package.json"),
  JSON.stringify({ private: true, dependencies: { "@paperclipai/server": serverVersion } }, null, 2),
);

execSync("npm install --production", { cwd: stagingDir, stdio: "inherit" });

// ── Step 2: Assemble the server bundle ──────────────────────────────────────

console.log("[prepare-server] Assembling server bundle...");

const serverPkgDir = path.join(stagingDir, "node_modules", "@paperclipai", "server");
const bundleServerDir = path.join(bundleDir, "server");

mkdirSync(bundleServerDir, { recursive: true });

// Copy server dist/ and package.json
cpSync(path.join(serverPkgDir, "dist"), path.join(bundleServerDir, "dist"), { recursive: true });
cpSync(path.join(serverPkgDir, "package.json"), path.join(bundleServerDir, "package.json"));

// Copy skills/ if present
const skillsSrc = path.join(serverPkgDir, "skills");
if (existsSync(skillsSrc)) {
  cpSync(skillsSrc, path.join(bundleServerDir, "skills"), { recursive: true });
}

// Copy entire node_modules (the server's runtime dependencies)
cpSync(path.join(stagingDir, "node_modules"), path.join(bundleServerDir, "node_modules"), { recursive: true });

console.log("[prepare-server] Server bundle assembled.");

// ── Step 3: Fix macOS dylib soname symlinks for embedded-postgres ───────────
// npm creates absolute symlinks (e.g. libzstd.1.dylib -> /abs/path/libzstd.1.5.7.dylib)
// that break when the staging dir is deleted or the app is relocated.
// We must ensure all dylib symlinks are RELATIVE so they survive packaging.

if (process.platform === "darwin") {
  console.log("[prepare-server] Fixing dylib symlinks for embedded-postgres...");

  /** Ensure all dylib soname/bare symlinks in a lib dir are relative. */
  function fixDylibSymlinks(libDir) {
    if (!existsSync(libDir)) return;
    for (const file of readdirSync(libDir)) {
      // Match versioned dylibs: libfoo.A.B.C.dylib or libfoo.A.B.dylib
      const m = file.match(/^(lib[^.]+)\.(\d+)(\.\d+)+\.dylib$/);
      if (!m) continue;
      const base = m[1]; // e.g. libzstd
      const major = m[2]; // e.g. 1

      for (const alias of [`${base}.${major}.dylib`, `${base}.dylib`]) {
        const aliasPath = path.join(libDir, alias);
        // Remove any existing symlink (may be absolute / broken)
        try { lstatSync(aliasPath); rmSync(aliasPath, { force: true }); } catch { /* doesn't exist */ }
        // Create a relative symlink: libzstd.1.dylib -> libzstd.1.5.7.dylib
        symlinkSync(file, aliasPath);
        console.log(`[prepare-server]   ${alias} -> ${file}`);
      }
    }
  }

  const nmDir = path.join(bundleServerDir, "node_modules");
  const embeddedPgScope = path.join(nmDir, "@embedded-postgres");

  if (existsSync(embeddedPgScope)) {
    for (const arch of readdirSync(embeddedPgScope)) {
      const libDir = path.join(embeddedPgScope, arch, "native", "lib");
      fixDylibSymlinks(libDir);
    }
  }
}

// ── Step 4: Download bundled Node.js binaries ───────────────────────────────

const NODE_VERSION = "v22.15.0";
const platform = process.platform;

const nodePlatform = platform === "win32" ? "win" : platform;
const ebPlatform = platform === "darwin" ? "mac" : platform === "win32" ? "win" : "linux";
const arches = platform === "darwin" ? ["x64", "arm64"] : ["x64"];

const nodeBinDir = path.join(projectRoot, "build", "node-bin");

for (const arch of arches) {
  const destDir = path.join(nodeBinDir, `${ebPlatform}-${arch}`);
  const destBin = path.join(destDir, platform === "win32" ? "node.exe" : "node");

  if (existsSync(destBin)) {
    console.log(`[prepare-server] Node ${NODE_VERSION} ${arch} already downloaded, skipping`);
    continue;
  }

  mkdirSync(destDir, { recursive: true });

  const ext = platform === "win32" ? "zip" : "tar.gz";
  const archiveName = `node-${NODE_VERSION}-${nodePlatform}-${arch}`;
  const url = `https://nodejs.org/dist/${NODE_VERSION}/${archiveName}.${ext}`;
  const archivePath = path.join(destDir, `node.${ext}`);

  console.log(`[prepare-server] Downloading Node ${NODE_VERSION} for ${nodePlatform}-${arch}...`);

  if (platform === "win32") {
    execSync(`powershell -Command "Invoke-WebRequest -Uri '${url}' -OutFile '${archivePath}'"`, { stdio: "inherit" });
  } else {
    execSync(`curl -fsSL -o "${archivePath}" "${url}"`, { stdio: "inherit" });
  }

  if (platform === "win32") {
    execSync(`powershell -Command "Expand-Archive -Path '${archivePath}' -DestinationPath '${destDir}' -Force"`, { stdio: "inherit" });
    cpSync(path.join(destDir, archiveName, "node.exe"), destBin);
    rmSync(path.join(destDir, archiveName), { recursive: true, force: true });
  } else {
    execSync(`tar -xzf "${archivePath}" -C "${destDir}" --strip-components=2 "${archiveName}/bin/node"`, { stdio: "inherit" });
  }

  rmSync(archivePath, { force: true });
  console.log(`[prepare-server] Node ${NODE_VERSION} ${arch} ready at ${destBin}`);
}

// ── Step 5: Remove macOS Finder duplicate files ─────────────────────────────

console.log("[prepare-server] Scanning for macOS Finder duplicate files...");
{
  function* walkDir(dir) {
    for (const entry of readdirSync(dir)) {
      const full = path.join(dir, entry);
      let stat;
      try { stat = lstatSync(full); } catch { continue; }
      if (stat.isSymbolicLink()) continue;
      if (stat.isDirectory()) { yield* walkDir(full); } else { yield full; }
    }
  }

  const dupes = [];
  for (const file of walkDir(bundleDir)) {
    const base = path.basename(file);
    if (/ \d+(\.[^/]+)?$/.test(base) && / \d+/.test(base)) {
      dupes.push(file);
    }
  }

  if (dupes.length > 0) {
    console.warn(`[prepare-server] WARNING: found ${dupes.length} Finder duplicate file(s). Removing them now.`);
    for (const f of dupes) {
      rmSync(f, { force: true });
      console.warn(`[prepare-server]   removed: ${path.relative(bundleDir, f)}`);
    }
  } else {
    console.log("[prepare-server] No Finder duplicates found.");
  }
}

// ── Step 6: Validate migration files ────────────────────────────────────────

{
  const migrationsDir = path.join(
    bundleServerDir, "node_modules", "@paperclipai", "db", "dist", "migrations",
  );

  if (existsSync(migrationsDir)) {
    const sqlFiles = readdirSync(migrationsDir).filter((f) => f.endsWith(".sql")).sort();
    console.log(`[prepare-server] Migration files validated: ${sqlFiles.length} SQL file(s) present.`);
    if (sqlFiles.length === 0) {
      console.error("[prepare-server] ERROR: No migration SQL files found in @paperclipai/db. The app will fail to initialise the database.");
      process.exit(1);
    }
  } else {
    console.error(`[prepare-server] ERROR: Migrations directory not found at ${migrationsDir}`);
    process.exit(1);
  }
}

// ── Cleanup staging dir ─────────────────────────────────────────────────────

console.log("[prepare-server] Cleaning up staging directory...");
rmSync(stagingDir, { recursive: true, force: true });

console.log("[prepare-server] Done.");
