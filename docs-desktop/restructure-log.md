# Paperclip Desktop — Restructure Discussion Log

**Date:** 2026-03-25

## Context

We reviewed `paperclip-desktop/SETUP.md`, a template guide for setting up `paperclip-desktop` as a standalone Electron wrapper around the upstream [paperclipai/paperclip](https://github.com/paperclipai/paperclip) project.

The current repo is a full monorepo clone containing the entire Paperclip engine (`server/`, `ui/`, `packages/`, `cli/`, `docs/`), but the Electron app only needs to be a thin wrapper — it spawns the server as a child process and loads the UI via HTTP.

## Key Findings

### 1. Electron has zero code-level imports from the monorepo

The Electron main process (`electron/src/main.ts`) does not import any TypeScript/JavaScript from `@paperclipai/server`, `@paperclipai/ui`, or any workspace package. It interacts with the server entirely at runtime:

- **Server:** spawned as a child process via `spawn(node, ["server/dist/index.js"])`
- **UI:** loaded via `mainWindow.loadURL("http://localhost:{port}")`
- **Only direct dependency:** `tree-kill` (for process cleanup)

This means the Electron code is architecturally independent and can live in its own repo.

### 2. `prepare-server.mjs` bundles the server at build time

The script at `electron/scripts/prepare-server.mjs` runs before `electron-builder` and:

1. Uses `pnpm deploy --filter @paperclipai/server` to create a flat production `node_modules`
2. Patches `@paperclipai/*` workspace symlinks with their actual `dist/` builds
3. Hoists transitive dependencies and fixes macOS dylib symlinks
4. Downloads a bundled Node.js binary (v22.15.0) for the target platform
5. Validates that all `@paperclipai/db` migration files are present

In a standalone repo, this would be rewritten to install from npm instead of using `pnpm deploy`.

### 3. Published npm packages (all at `2026.325.0`)

| Package | On npm | Notes |
|---------|--------|-------|
| `@paperclipai/server` | Yes | `dist/index.js` entry — the server the Electron app spawns |
| `@paperclipai/shared` | Yes | Types and utilities |
| `@paperclipai/db` | Yes | Drizzle ORM schema + migrations |
| `@paperclipai/adapter-*` (7) | Yes | AI model adapters |
| `@paperclipai/plugin-sdk` | Yes | Plugin authoring SDK |
| `@paperclipai/adapter-utils` | Yes | Shared adapter utilities |
| `@paperclipai/create-paperclip-plugin` | Yes | Scaffolding CLI |
| `paperclipai` | Yes | CLI tool |
| **`@paperclipai/ui`** | **No** | **Not published — this is the blocker** |

### 4. Upstream repo releases

The upstream repo (`paperclipai/paperclip`) has 4 GitHub Releases but **none contain binary/download assets** — they are tag-only releases with markdown notes. All artifacts are published exclusively via npm.

Release channels:
- **Canary:** auto-published on every push to `master` (`2026.325.0-canary.1`)
- **Stable:** manually triggered via `workflow_dispatch` (`2026.325.0`)

### 5. What the SETUP.md template provides

Template files in `/Users/aronprins/Downloads/paperclip-desktop/`:

| File | Purpose | Exists in repo? |
|------|---------|-----------------|
| `.github/workflows/sync-upstream.yml` | Polls npm every 6h for new versions, auto-bumps, builds, tags | No |
| `.github/workflows/release.yml` | Builds macOS/Windows/Linux binaries on `v*` tags | No (current release.yml publishes npm, not desktop) |
| `electron-builder.yml` | Simpler config with `publish: github` for auto-updates | Partially (existing config lacks `publish` section) |
| `src/main/updater.ts` | In-app auto-updater using `electron-updater` | No |
| `build/entitlements.mac.plist` | macOS code signing entitlements | Yes (at `electron/assets/`) |

### 6. What already exists and works

- Electron app at `electron/` with main.ts, preload.ts, splash-preload.ts
- electron-builder.yml with macOS/Windows/Linux targets
- macOS entitlements and after-pack signing script
- Build scripts: dev.mjs, prepare-server.mjs, after-pack.mjs
- CI workflows for PR validation and npm publishing

## Decision

### The blocker

`@paperclipai/ui` is not published to npm and not available as a download artifact from GitHub Releases. A standalone Electron repo needs the built UI files to bundle into the app.

### Chosen approach

**Option 2: Clone upstream and build UI at CI time** — as an interim solution while working on getting `@paperclipai/ui` published to npm (option 1).

At build time, `prepare-server.mjs` will:
1. Install `@paperclipai/server` and all transitive deps from npm
2. Clone `paperclipai/paperclip` (shallow), build the UI, and copy `ui/dist/` into the bundle
3. When `@paperclipai/ui` is eventually published to npm, switch to installing it directly (one-line change)

### What does NOT apply from the SETUP.md

- **Step 2 (restructure as npm dependency)** — applies, but needs the UI workaround above
- **`sync-upstream.yml`** — fully applies once restructured; polls npm for new `@paperclipai/server` versions

### Target repo structure

```
src/
  main.ts
  preload.ts
  splash-preload.ts
  updater.ts              <- new: in-app auto-updater
scripts/
  dev.mjs
  prepare-server.mjs      <- rewritten: npm install + clone/build UI
  after-pack.mjs
assets/
  entitlements.mac.plist
  icon.*
electron-builder.yml      <- updated: add publish.github section
package.json              <- depends on @paperclipai/server from npm
tsconfig.json
.github/workflows/
  sync-upstream.yml        <- new: polls npm every 6h
  release.yml              <- new: desktop binary releases on v* tags
docs-desktop/
  restructure-log.md       <- this file
```

### Automation flow (post-restructure)

```
sync-upstream (every 6h)
  npm registry -> new @paperclipai/server version?
    -> update dep -> build -> test
    -> success: commit + tag v* -> triggers release workflow
    -> failure: open GitHub issue with logs

release (on v* tag push)
  -> build macOS/Windows/Linux binaries in parallel
  -> publish to GitHub Releases with latest.yml manifests

Electron app (user's machine)
  -> electron-updater checks GitHub Releases every 4h
  -> auto-downloads update -> prompts "Restart to update?" -> installs
```
