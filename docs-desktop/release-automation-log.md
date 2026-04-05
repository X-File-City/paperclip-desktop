# Paperclip Desktop — Release Automation Log And Operator Guide

## Purpose

This document records the current release-automation design for Paperclip Desktop and explains:

- what changed in the release workflow
- why the workflow was split
- what failed in the old design
- how another developer should run and maintain the process
- how to reason about build-only versus notarization work without needing any project history

This is a decision log and rationale summary. It is not a literal private chain-of-thought transcript.

## Executive summary

The macOS release flow is now intended to be a two-phase process:

1. build signed staged macOS artifacts for review
2. notarize approved prebuilt macOS app bundles later

That split is the core operational change.

The old release workflow mixed together:

- app build
- signing
- app notarization
- DMG notarization
- stapling
- artifact publishing

That was expensive, slow, and hard to reason about. It also wasted GitHub Actions macOS minutes because Apple-related steps ran before anyone had approved the artifacts.

## Why this was changed

### Problem 1: too many macOS runner minutes

The previous disabled release workflow used a macOS matrix for `x64` and `arm64`. That meant each architecture repeated:

- checkout
- dependency install
- server bundle preparation
- UI build
- packaging
- signing
- notarization work

That is expensive on macOS runners even before Apple APIs are involved.

### Problem 2: notarization happened too early

The old design attempted notarization during the main build workflow before the artifacts were manually tested and approved.

That is the wrong order operationally:

- if the built app is wrong, you waste Apple submission time
- if the build is only for verification, notarization is pure cost
- if the workflow fails late, the mac runner has already burned most of its time budget

### Problem 3: notarization was duplicated

The old disabled workflow effectively had two notarization paths:

- app notarization in `scripts/after-sign.mjs`
- DMG notarization in the workflow itself

That is the main reason the old approach could balloon into multi-thousand-minute macOS spend over repeated runs.

### Problem 4: build and release publication were coupled

Publishing a release should happen after:

- the app is built
- the artifacts are tested
- mac artifacts are approved
- notarization succeeds

The old design bundled too many of those steps into one path.

## Design principles used

The current release automation follows these rules:

- build first, notarize later
- sign locally in the build phase, but do not submit to Apple automatically
- test the exact built app before notarization
- avoid rebuilding the application just to notarize it
- do not notarize twice
- keep CI workflows narrow and explicit
- keep the packaging source of truth aligned with the staged local macOS flow

## Current file-level design

### Disabled build workflow

File:

- `/.github/workflows.disabled/release.yml.disabled`

Role:

- build artifacts only
- no mac notarization
- no mac stapling
- no publish step

Important behavior:

- macOS uses `pnpm release:mac:local`
- that single mac job builds both `x64` and `arm64`
- signed staged artifacts are uploaded as a GitHub artifact for later approval and notarization

### Disabled notarization workflow

File:

- `/.github/workflows.disabled/release-notarize.yml.disabled`

Role:

- manual follow-up workflow
- downloads approved staged mac artifacts from a previous GitHub Actions run
- notarizes the prebuilt `.app`
- staples the app
- repackages final ZIP/DMG from the approved notarized app
- verifies stapled output

### Staged mac build script

File:

- `/scripts/release-macos-local.mjs`

Role:

- build the real app into a temporary per-arch stage
- sign it
- verify it
- export local test artifacts

### Prebuilt mac repackaging script

File:

- `/scripts/repackage-prebuilt-macos.mjs`

Role:

- take a prebuilt `.app`
- ask Electron Builder to package ZIP/DMG using `--prepackaged`
- avoid a full app rebuild

### Prebuilt mac notarization script

File:

- `/scripts/notarize-prebuilt-macos.mjs`

Role:

- take approved staged app bundles
- submit them to Apple
- staple them
- repackage distributables
- verify stapled artifacts

## What “proper” looks like now

A proper macOS release process now looks like this:

### Phase 1. Build and verify

Goal:

- produce signed local or CI artifacts that can be tested

What happens:

- the staged build flow runs
- the app bundle is signed
- nested `node`, Postgres, `.node`, and `.dylib` payloads are signed
- the build is verified locally with `codesign`
- no Apple submission happens

Outputs:

- signed `.app`
- `.zip`
- `.dmg`
- verification summary

Decision point:

- a developer or operator tests the actual built app

### Phase 2. Approve and notarize

Goal:

- submit only approved mac artifacts to Apple

What happens:

- the approved prebuilt app bundle is downloaded
- the app bundle is notarized once
- the app bundle is stapled
- final ZIP/DMG are produced from that approved notarized app
- stapled output is verified

Decision point:

- only after successful notarization/stapling should those artifacts move toward publication

## What was wrong with the old disabled workflow

This is the short reasoning summary for future maintainers.

### 1. Per-arch matrix duplication

The old workflow created a separate mac job for `x64` and `arm64`.

That duplicated:

- dependency installation
- build preparation
- server/UI bundling
- signing environment setup
- packaging overhead

This is acceptable only if there is a strong reason to isolate the architectures. Here it mostly multiplied cost.

### 2. App notarization plus DMG notarization

The old path notarized the app through `after-sign` and then notarized the DMG again in the workflow.

That was operationally excessive.

Even if both are individually defensible in some pipelines, doing both in the same build-verification path was the wrong default because it inflated mac time and introduced extra failure surface.

### 3. Publishing logic in the same release workflow

The old disabled workflow also included GitHub release publication logic.

That meant build, notarization, and publication were all entangled.

For a repo still refining its packaging architecture, that is too much coupling.

## Why the split works better

### Build workflow is cheap enough to run for verification

The build workflow is still not free, but it is materially cheaper because it removes Apple notarization waits from the default path.

### Approval happens before Apple submission

This is the key policy improvement.

The exact built app can be tested before the notarization phase begins.

### Notarization can work from approved prebuilt apps

The new helper scripts support taking a prebuilt `.app` and repackaging from it with Electron Builder `--prepackaged`.

That means we do not need to rerun the whole build just to create post-approval ZIP/DMG artifacts.

### The staged local flow remains the source of truth

The CI mac build path now follows the same staged mac packaging model as local release verification.

That reduces drift between local and CI behavior.

## Operator instructions

This section is written for someone new to the project.

### Scenario A: build mac artifacts for testing

Local:

```bash
pnpm release:mac:local
```

Or one architecture at a time:

```bash
pnpm release:mac:local:x64
pnpm release:mac:local:arm64
```

Expected outputs:

- `release/local-macos/x64/...`
- `release/local-macos/arm64/...`

What to test:

- launch the `.app`
- confirm server boot
- confirm UI load
- confirm embedded Postgres works
- inspect `verification-summary.json`

### Scenario B: run CI build verification

When GitHub Actions are re-enabled, use the build workflow only.

Expected result:

- uploaded staged mac artifact bundle
- no notarization
- no stapling
- no release publication

Use that run as the approval candidate.

### Scenario C: notarize approved CI output

When the artifact has been reviewed and approved:

1. trigger the notarization workflow manually
2. pass the source `build_run_id`
3. let the notarization workflow download the approved staged mac artifact
4. notarize the `.app`
5. staple it
6. repackage final ZIP/DMG
7. verify stapled output

Only after that should release publication happen.

## Required secrets and credentials

### Build-only workflow

Needed:

- `APPLE_CODESIGN_IDENTITY`
- `APPLE_TEAM_ID`
- `MAC_CERTIFICATE_P12_BASE64`
- `MAC_CERTIFICATE_PASSWORD`

Why:

- this workflow signs artifacts locally on the runner
- it does not require Apple notarization API credentials

### Notarization workflow

Needed:

- `APPLE_API_KEY_ID`
- `APPLE_API_ISSUER`
- `APPLE_API_KEY_P8`
- also the expected signing identity/team vars for verification

Why:

- this workflow talks to Apple notarization services

## Maintenance instructions

If you change the mac packaging path, keep these aligned:

- `scripts/release-macos-local.mjs`
- `scripts/stage-after-pack.mjs`
- `scripts/repackage-prebuilt-macos.mjs`
- `scripts/notarize-prebuilt-macos.mjs`
- `docs-desktop/macos-staged-release.md`
- this file

The release automation is only as good as the consistency between local flow, CI build flow, and operator docs.

## Important guardrails

- Do not reintroduce automatic notarization in the default build workflow
- Do not reintroduce both app notarization and DMG notarization in the same path
- Do not rebuild the full app in the approved notarization workflow unless there is a proven blocker
- Do not publish GitHub releases from the build-verification workflow
- Do not enable the disabled workflows until the team is comfortable with the split and the required secrets are configured

## Known caveats

### The workflows are still disabled

The workflow files still live under:

- `.github/workflows.disabled/`

That means they do not run yet.

This is intentional while the release process is still being hardened.

### Existing old `release/` contents are not the same as staged local outputs

If you inspect older artifacts under `release/`, those may come from the previous root-based packaging flow.

Do not use those as proof that the staged flow is working correctly.

Use the staged output under `release/local-macos/` when validating the new process.

## Recommended next steps

1. review this workflow split with anyone who will own releases
2. enable the build-only workflow first
3. run a manual mac build verification on GitHub Actions
4. test the downloaded staged artifacts locally
5. only then enable and test the notarization workflow
6. keep GitHub release publication separate until the mac path is trusted end to end

## Change record

This document corresponds to the release automation split introduced after the staged macOS packaging work:

- build-only staged mac workflow
- separate approved notarization workflow
- prebuilt app notarization and repackaging helpers

If that design changes materially, update this file rather than relying on tribal memory.
