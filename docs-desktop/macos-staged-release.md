# Paperclip Desktop — Staged macOS Release Guide

## Purpose

This document explains the current macOS release architecture in this repository:

- what changed
- why it works now
- how to build local signed artifacts
- how to verify them
- how to debug failures
- what a new developer needs to know to work on the flow safely

This guide is written for developers who know nothing about the project yet.

## Short version

The macOS packaging flow no longer treats the repo root as the packaging source of truth.

Instead, the release command:

1. builds the real runtime payload
2. creates a temporary stage directory for one architecture
3. copies only the app contents we intend to ship into that stage
4. generates a minimal package manifest and Electron Builder config in the stage
5. runs Electron Builder from the stage directory
6. exports the finished artifacts into `release/local-macos/{arch}`
7. verifies signatures on the resulting app bundle and nested native binaries

That staged approach is closer to how mature desktop packaging repos such as `pingdotgg/t3code` structure their release build.

## Why the old approach was not good enough

The old macOS flow built from the repo root. That had a few problems:

- the packaging context was larger than the app we actually ship
- the packaging step depended on repo-root layout rather than a clean ship payload
- it was harder to reason about exactly what was in the final app
- staged-signing issues in nested native payloads were mixed together with unrelated repo files

For release quality, the packaged app should be derived from a narrowly scoped runtime payload, not from the full development repository.

## What changed

Two main pieces were added:

1. `scripts/release-macos-local.mjs`
2. `scripts/stage-after-pack.mjs`

The package scripts were updated so the macOS local release path now goes through the staged flow:

```bash
pnpm release:mac:local
pnpm release:mac:local:x64
pnpm release:mac:local:arm64
pnpm dist:mac
```

## What the stage contains

For each mac architecture, the stage directory contains only the runtime payload needed to build the real app:

- `dist/`
  Electron main/preload compiled output
- `app-server/server/`
  bundled server output, bundled UI output, and production server dependencies
- `app-server/node-bin/`
  bundled Node runtime for the target architecture
- `build/icon.png`
- `build/icon.icns`
- `build/entitlements.mac.plist`
- `build/entitlements.mac.inherit.plist`
- generated minimal `package.json`
- generated minimal `electron-builder.json`

That stage is intentionally not a reduced placeholder. It is the actual app payload we want to ship.

## How the staged build works

### Step 1. Build the runtime inputs

The staged release script can run the normal build steps itself:

```bash
pnpm build
pnpm prepare-server
pnpm build-ui
```

Those produce:

- `dist/`
- `build/server-bundle/mac-x64/server`
- `build/server-bundle/mac-arm64/server`
- `build/node-bin/mac-x64`
- `build/node-bin/mac-arm64`

### Step 2. Create a temporary per-arch stage

For each requested architecture, the script creates a fresh temp directory under the system temp root. Example:

```text
/var/folders/.../paperclip-macos-stage-x64-XXXXXX
/var/folders/.../paperclip-macos-stage-arm64-XXXXXX
```

Each architecture is staged independently. This prevents one architecture’s payload from contaminating the other.

### Step 3. Copy only the app payload

The script copies the runtime files into the staged app layout:

- `dist` from the repo root
- the server bundle for the requested arch
- the Node runtime for the requested arch
- mac build resources and entitlements

It also normalizes symlinks inside the copied server bundle:

- removes broken symlinks
- rewrites copied absolute symlinks to relative ones where needed
- removes `node_modules/.bin` shims that are not part of the shipped runtime

This matters because broken symlinks and non-runtime shim files are common sources of `codesign` failure.

### Step 4. Generate a minimal stage package manifest

The stage does not reuse the repo’s full `package.json`.

Instead, the script generates a small runtime-only manifest that contains:

- app name
- version
- metadata such as description/author/homepage
- `main: dist/main.js`
- only runtime dependencies

This keeps the stage small and makes it obvious what Electron Builder is packaging.

### Step 5. Generate a minimal stage Electron Builder config

The script also generates a stage-local `electron-builder.json`.

That config tells Electron Builder to package:

- `dist/**/*`
- `package.json`
- `app-server/server/**/*` as extra resources
- `app-server/node-bin/**/*` as extra resources

It also configures mac targets, hardened runtime, entitlements, and `signIgnore` for the nested `app-server` payload.

### Step 6. Install only runtime dependencies in the stage

The stage runs:

```bash
npm install --omit=dev --ignore-scripts --no-audit --no-fund
```

This keeps the packaging environment focused on runtime dependencies and avoids dragging dev-only repo context into the release app.

### Step 7. Run Electron Builder from the stage

Electron Builder runs with:

- `--projectDir <stage app dir>`
- `--config <stage>/electron-builder.json`
- `--mac`
- `--x64` or `--arm64`
- `--publish never`

That means the packaged app is built from the stage, not the repo root.

### Step 8. Export artifacts into the repo

After packaging, the script copies the stage output into:

```text
release/local-macos/x64
release/local-macos/arm64
```

Those output folders are the artifacts developers should test locally before any notarization decision.

## Why signing works now

### Stock Electron Builder is still used where it should be used

We kept stock Electron Builder signing for:

- the main `.app`
- the Electron frameworks
- the helper apps

That is the part Electron Builder handles well.

### Why the staged flow still needs a small custom sign step

The nested `Contents/Resources/app-server` payload includes:

- bundled `node`
- embedded Postgres binaries
- `.node` native modules
- `.dylib` files
- non-binary data files and symlinks

In staged packaging, letting Electron Builder treat that tree as a generic recursive sign target was not reliable enough, because it attempted to walk into content that should not be signed as code:

- broken symlinks
- copied packaging detritus
- non-Mach-O files in native package trees
- `.bin` shims

So the current design is:

- Electron Builder signs the app bundle normally
- `signIgnore` excludes `Contents/Resources/app-server/**` from Electron Builder’s recursive sign pass
- `scripts/stage-after-pack.mjs` signs only real Mach-O files under `app-server`

That hook:

- cleans bundle metadata
- removes broken symlinks
- clears `._*`, `.DS_Store`, and xattrs
- detects actual Mach-O binaries by header, not filename alone
- signs only:
  - executable Mach-O files
  - `.node` files
  - `.dylib` files

This is why the current flow is stable: it narrows the custom signing logic to the one subtree that Electron Builder could not safely recurse through in staged packaging.

### Ad hoc signing is gone

Ad hoc signing is fully removed from the current path.

The staged flow now requires a real `Developer ID Application` identity. If no valid identity is available, the build fails.

`scripts/release-macos-local.mjs` resolves the identity from the active keychain using:

```bash
security find-identity -v -p codesigning
```

The current build expects a `Developer ID Application: ...` identity and passes that into:

- the staged custom nested signer
- the post-build verification step

## Prerequisites for a new developer

To work on this flow locally, a developer needs:

### Required tooling

- macOS
- Xcode Command Line Tools
- Node.js compatible with the repo
- `pnpm`
- access to the repo

Install Xcode CLT:

```bash
xcode-select --install
```

### Required signing identity

For signed local macOS builds, the developer must have a valid `Developer ID Application` certificate installed in their login keychain.

Check it with:

```bash
security find-identity -v -p codesigning
```

Expected output includes something like:

```text
Developer ID Application: Your Name Or Team (TEAMID)
```

If there are multiple Developer ID Application identities installed, set one explicitly:

```bash
export APPLE_CODESIGN_IDENTITY="Developer ID Application: Your Name Or Team (TEAMID)"
export APPLE_TEAM_ID="TEAMID"
```

## Local build commands

### Build both architectures

```bash
pnpm release:mac:local
```

### Build x64 only

```bash
pnpm release:mac:local:x64
```

### Build arm64 only

```bash
pnpm release:mac:local:arm64
```

### Reuse already-built runtime artifacts

If `dist/`, `build/server-bundle/...`, and `build/node-bin/...` are already present, you can skip rebuilding those inputs:

```bash
node scripts/release-macos-local.mjs --arch x64 --skip-build --skip-install
node scripts/release-macos-local.mjs --arch arm64 --skip-build --skip-install
```

Useful flags:

- `--arch x64`
- `--arch arm64`
- `--skip-build`
- `--skip-install`
- `--keep-stage`
- `--output-root <dir>`

## What files to test

After a successful build:

### x64

- `release/local-macos/x64/mac/Paperclip.app`
- `release/local-macos/x64/Paperclip-1.0.0.dmg`
- `release/local-macos/x64/Paperclip-1.0.0-mac.zip`
- `release/local-macos/x64/verification-summary.json`

### arm64

- `release/local-macos/arm64/mac-arm64/Paperclip.app`
- `release/local-macos/arm64/Paperclip-1.0.0-arm64.dmg`
- `release/local-macos/arm64/Paperclip-1.0.0-arm64-mac.zip`
- `release/local-macos/arm64/verification-summary.json`

For first-pass local QA, launch the `.app` bundles directly.

## What to verify manually

Before approving notarization, test:

- the app launches
- the splash flow completes
- the bundled server starts
- the UI loads correctly
- the app can reach the bundled Node runtime
- embedded Postgres starts and basic product flows work
- the app launched from the ZIP artifact behaves the same way

## How verification works

After each staged build, the script runs:

```bash
node scripts/verify-macos-release.mjs release/local-macos/<arch>
```

That verifier checks:

- app bundle signature
- main app executable signature
- helper app executable signatures
- bundled `node`
- embedded Postgres binaries
- `.node` native modules
- `.dylib` files

It writes a machine-readable summary to:

```text
release/local-macos/<arch>/verification-summary.json
```

The verifier does not require stapling by default. That is intentional because local testing happens before notarization.

## Example verification commands

### Check the app bundle

```bash
codesign --verify --deep --strict --verbose=2 release/local-macos/x64/mac/Paperclip.app
codesign -dvv release/local-macos/x64/mac/Paperclip.app
```

### Check bundled Node

```bash
codesign --verify --strict --verbose=2 \
  release/local-macos/x64/mac/Paperclip.app/Contents/Resources/app-server/node-bin/node

codesign -dvv \
  release/local-macos/x64/mac/Paperclip.app/Contents/Resources/app-server/node-bin/node
```

### Check embedded Postgres

```bash
codesign --verify --strict --verbose=2 \
  release/local-macos/x64/mac/Paperclip.app/Contents/Resources/app-server/server/node_modules/@embedded-postgres/darwin-x64/native/bin/initdb
```

### Check a native module

```bash
codesign --verify --strict --verbose=2 \
  release/local-macos/x64/mac/Paperclip.app/Contents/Resources/app-server/server/node_modules/@img/sharp-darwin-x64/lib/sharp-darwin-x64.node
```

## Typical developer workflow

For a new developer working on mac packaging:

1. Install dependencies

```bash
pnpm install
```

2. Confirm signing identity

```bash
security find-identity -v -p codesigning
```

3. Build one architecture first

```bash
pnpm release:mac:local:arm64
```

4. Launch the built `.app`

5. Inspect `verification-summary.json`

6. If the packaging change is correct, build the second architecture

```bash
pnpm release:mac:local:x64
```

7. Test both artifacts

8. Only after approval, move on to any notarization work

## Troubleshooting

### Problem: no signing identity found

Symptom:

- the staged build fails before packaging or during the nested sign step

Check:

```bash
security find-identity -v -p codesigning
```

Fix:

- install the correct `Developer ID Application` certificate
- or set `APPLE_CODESIGN_IDENTITY` explicitly

### Problem: multiple Developer ID Application identities are installed

Symptom:

- the staged script refuses to choose one automatically

Fix:

```bash
export APPLE_CODESIGN_IDENTITY="Developer ID Application: Exact Team Name (TEAMID)"
export APPLE_TEAM_ID="TEAMID"
```

### Problem: `codesign` fails inside `app-server`

Common causes:

- broken symlinks
- copied `.bin` shims
- non-Mach-O files being treated as code

Why it is usually fixed now:

- the stage cleanup removes broken symlinks
- `.bin` shims are pruned before packaging
- the custom sign hook signs only actual Mach-O files

If this regresses, inspect:

- `scripts/release-macos-local.mjs`
- `scripts/stage-after-pack.mjs`
- `release/local-macos/<arch>/verification-summary.json`

### Problem: Electron Builder signs the app, but nested binaries are wrong

Symptom:

- the top-level `.app` is signed
- bundled `node`, Postgres, or `.node` files are missing the expected identity

Check:

```bash
codesign -dvv release/local-macos/arm64/mac-arm64/Paperclip.app/Contents/Resources/app-server/node-bin/node
```

Expected:

- `Authority=Developer ID Application: ...`
- `TeamIdentifier=<your team>`

If not, the likely breakage is in the staged nested sign step, not the top-level Electron Builder sign step.

### Problem: DMG shows unsigned

Current behavior:

- the verifier records DMG signature state
- the local process does not fail if the DMG itself is unsigned
- the important thing for pre-notarization local testing is that the contained app bundle is correctly signed

That is expected in the current local testing flow.

## What not to do

- Do not package mac releases for local review directly from arbitrary repo-root state
- Do not reintroduce ad hoc signing
- Do not notarize automatically as part of local build-and-test
- Do not broaden the custom signer to recurse blindly over `app-server`
- Do not treat non-binary resource files as sign targets

## Files that matter most

- `package.json`
- `electron-builder.yml`
- `scripts/release-macos-local.mjs`
- `scripts/stage-after-pack.mjs`
- `scripts/after-pack.mjs`
- `scripts/verify-macos-release.mjs`
- `build/entitlements.mac.plist`
- `build/entitlements.mac.inherit.plist`

## Current status

At the time this guide was written, the staged flow:

- builds per-arch temporary staging directories
- produces local signed app bundles for `x64` and `arm64`
- verifies the main app bundle and nested runtime binaries with `codesign`
- does not notarize
- does not staple
- is intended for local review before any Apple submission step
