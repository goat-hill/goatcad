# Releases & distribution

How GoatCAD reaches users, and how it updates once it is there. This is the source of truth for three surfaces that must agree: the **landing page** (`web/`), the **docs** (`web/src/content/docs/installation.md`), and the **release pipeline** (`.github/workflows/release.yml` + `electron/electron-builder.yml`). If they disagree, this file is right and the others are bugs.

Companion docs: [WEB.md](./WEB.md) §4 for the release-version contract that feeds the site, §6 for docs rules.

---

## 1. Principles

- **GitHub releases are the source of truth.** Every other channel wraps the same artifacts. Nothing is ever built twice for two channels. The files themselves live on R2 at `download.goatcad.com`, and the GitHub release is the record that links to them (§8).
- **Direct download is a first-class path, not a fallback.** Most macOS and Windows users will take the `.dmg` / `.exe` and never touch a package manager. The site treats that as the normal case.
- **The app is responsible for updating itself only when it installed itself.** A package manager owns the installs it made — an app that self-updates under `brew` or `apt` fights the manager and corrupts its state.
- **Only ship what exists.** A channel appears on the site the moment it is real and not before (§6). Aspirational install commands are worse than no install commands: the reader runs them and gets an error.

---

## 2. Artifacts

One build matrix, produced by `.github/workflows/release.yml` on a `v*.*.*` tag.

| Platform | Artifact            | Arch  | Notes                                                 |
| -------- | ------------------- | ----- | ----------------------------------------------------- |
| macOS    | `.dmg`              | arm64 | Apple silicon only — Intel is not a target (§2.1)     |
| macOS    | `.zip`              | arm64 | Not advertised — it is what electron-updater consumes |
| Windows  | `-setup.exe` (NSIS) | x64   | Per-user install, no admin rights                     |
| Linux    | `.AppImage`         | x64   | Self-contained; the "any distro" answer               |
| Linux    | `.deb`              | x64   | Debian/Ubuntu, the expectation on those systems       |
| all      | `latest*.yml`       | —     | Update metadata; required by electron-updater (§4)    |

**No snap.** Strict confinement blocks reading a local KiCad install's `/usr/share/kicad` libraries, which is exactly how standard libraries are provisioned. KiCad itself ships no snap either. The `electron-builder.yml` comment says the same thing — keep them in agreement.

**Builds say whose they are.** `release.yml`'s build sets `GOATCAD_OFFICIAL_BUILD=1`, which `electron.vite.config.ts` stamps into main beside the commit, so Share app feedback reports `release`, `source` (anyone else's packaged build) or `dev`. It tells triage what a reporter runs and does not prove it: a fork can set the same variable.

### 2.1 macOS is Apple silicon only

Intel Macs are a **deliberate non-target** (decided 2026-07-21). The two ways to serve them both cost more than they are worth: a universal artifact packages both slices into every download, so the Apple-silicon majority pays for a copy it never runs (and universal _builds_ both arches and then merges them, so it is slower too); separate `arm64` and `x64` artifacts avoid the fat download but add a second build, a second asset to keep straight, and a wrong-download failure mode on every surface — the browser cannot reliably tell which Mac a visitor has.

The consequence is stated plainly, not hidden: the docs' requirements table says Apple silicon, and there is no Intel link anywhere. Revisit only if Intel users turn up and ask — adding an `x64` target later is a one-line change to `mac.target` plus a secondary link, the same shape the `.deb` already uses.

---

## 3. Channels

**Launch set: direct downloads, AUR, and a personal Homebrew tap.** Those are the ones that need no review queue and no signing dependency. Each additional channel is ongoing work — a manifest to update every release, and an updater flavor to suppress (§4.2) — so they are added deliberately, not opportunistically.

| Channel               | Platform | Status at launch | Why                                                                                                                   |
| --------------------- | -------- | ---------------- | --------------------------------------------------------------------------------------------------------------------- |
| GitHub releases       | all      | **live**         | The source of truth. The expected path on macOS and Windows, with its files served from R2 (§8).                      |
| Personal Homebrew tap | macOS    | **launch**       | `homebrew-cask` has a notability bar and expects a notarized app; a tap has neither gate.                             |
| AUR (`goatcad-bin`)   | Linux    | **launch**       | One PKGBUILD wrapping the release artifact, no review queue, strong audience fit.                                     |
| winget                | Windows  | deferred         | Its value arrives with the code-signing cert; unsigned is a rough first impression.                                   |
| homebrew-cask         | macOS    | deferred         | Migrate from the tap once notable — the notarized-app half of the bar is met (§7).                                    |
| Flathub               | Linux    | own workstream   | Most reach, most friction: appstream metadata, review, and the same system-library sandbox fight that ruled out snap. |
| Nix                   | Linux    | someday          | Usually contributed by users; accept a PR rather than drive it.                                                       |

Each channel's manifest points at that release's artifacts, so **a channel can only be updated after the GitHub release is published**, never before.

---

## 4. Updates

### 4.1 Direct installs: notify, then install on quit

`electron-updater` with the **`generic` provider**, in `src/main/updater.ts`. The feed is `publish.url` in `electron-builder.yml` — the release folder on R2 (§8) — where each `latest*.yml` sits beside the installers it names. No update server to run.

- Ten seconds after launch, then every four hours, the app fetches the feed. A newer version downloads in the background.
- When it is ready, one native dialog: **Restart now** or **Later**. Never a surprise restart.
- Later means it installs on quit; the next launch is the new version. Restart now quits through the normal path — unsaved work still gets its prompt, and canceling that cancels the restart — and installs on `will-quit` with a relaunch.
- **Settings ▸ About turns it off** (`checkForUpdates` in the config store). The setting is read at every check, so it is honored on the very first one.
- **Settings ▸ About's Check now** runs one check at once, whatever the setting, and writes the outcome beside the button. It asks again about a build already downloaded and put off with Later. On an install that does not update itself (§4.2, a dev run) it is disabled, with "Not available here" beside it.
- An unreachable feed is a one-line warning in the log and nothing else.

Supported for the `.dmg`/`.zip`, the NSIS `.exe`, and the `.AppImage`. **Not** for the `.deb` — electron-updater cannot update a dpkg-managed install; those users update through §4.2 or by installing a newer `.deb`.

macOS auto-update **requires a signed and notarized app**, which §7 provides — electron-updater's signature check passes. `GOATCAD_DEV_UPDATE=1` exercises the flow in an unpackaged run against `dev-app-update.yml`.

### 4.2 Package-manager installs: the manager updates it

`brew upgrade`, `yay -Syu`, `apt upgrade`. **The in-app updater is disabled for these installs** — `updaterAvailability` in `src/main/updater.ts` decides from the runtime: on Linux only an AppImage (electron-builder's launcher sets `APPIMAGE`) qualifies, so the `.deb` never self-updates. A Homebrew cask is a normal `/Applications` install and needs a build-time or cask-time marker; whenever a channel is added, its suppression path is part of that work, not a follow-up.

### 4.3 Privacy obligation

An update check is the app's **first automatic network request**, and `web/src/pages/privacy.astro` says so, with what the request carries and how to turn it off. Any change to what the updater sends or when it runs changes that page in the same PR. This is a hard gate, not a nicety.

---

## 5. The release flow

1. Bump `electron/package.json` version; tag `vX.Y.Z`. The tag must match the version — `release.yml`'s first job fails fast if not.
2. Gates run (version match, full i18n coverage), then the three-OS build matrix.
3. Each build job uploads its output to R2 (§8): installers into the release folder, **`latest*.yml` held back** under `pending/<tag>/`. A **draft** GitHub release links to them; no files are attached on GitHub.
4. A human writes the notes and **publishes**. Publishing is the act that means "these files are real".
5. `release: published` fires `web-release-bump.yml`. It promotes the held-back `latest*.yml` into place — from that moment every install's updater sees the new version — writes `web/src/data/release.json` from the files the build jobs uploaded, commits it, and starts `web-deploy.yml` by name — a commit made with the workflow's own token triggers no other workflow. A prerelease leaves both the update feed and `release.json` alone. See [WEB.md §4](./WEB.md).
6. Channel manifests (tap, AUR) are updated to the new version — after publish, never before.

Draft, not direct-publish: the builds are on R2 as soon as they are built, but nothing points at them — not the site, not the update feed — until a human publishes. That also makes a draft shareable: its links work for anyone they are sent to.

---

## 6. Site & docs consistency

- **`web/src/data/channels.ts` is the site's copy of §3** — one entry per channel with a `live` flag. Turning a channel on is a one-line change there, and it appears on both the landing page and the docs install page at once. Nothing renders a command for a channel that is not live.
- **`web/src/data/release.json` is the artifact list** (WEB.md §4), written by the bump job from the files the builds actually uploaded — never hand-edited, never predicted from electron-builder's filename template. Its URLs point at R2 (§8).
- The docs install page renders its matrix from those two files (`InstallMatrix.astro`), so it cannot drift from what the pipeline actually produced. Prose around it may name platforms; it must not hardcode versions, filenames, or commands.
- The landing page shows one button per platform plus a link to all downloads; live channel commands appear beneath it in the same order as §3.

**When a channel goes live, or an artifact is added or dropped, this file changes first.** Then `channels.ts`, then the pipeline. The docs and landing page follow automatically.

---

## 7. macOS signing & notarization

macOS builds are signed with a **Developer ID Application** certificate and notarized by Apple's notary service. Both halves are needed. Signing alone still produces "Apple cannot check it for malicious software" on a downloaded build — that message is about the missing notarization ticket, not the signature.

Windows is **not** signed yet; SmartScreen still warns. That needs a separate certificate and is what gates winget (§3). Linux artifacts are unsigned by design.

### 7.1 The credentials

Five repository secrets, all consumed only by the macOS leg of `release.yml`:

| Secret                   | What it is                                          |
| ------------------------ | --------------------------------------------------- |
| `APPLE_CSC_LINK`         | The Developer ID Application `.p12`, base64-encoded |
| `APPLE_CSC_KEY_PASSWORD` | The password set when exporting that `.p12`         |
| `APPLE_API_KEY`          | The App Store Connect API `.p8` key, base64-encoded |
| `APPLE_API_KEY_ID`       | That key's ID (10 characters)                       |
| `APPLE_API_ISSUER`       | The issuer ID for the team (a UUID)                 |

The Team ID is **LUC64GXNR8** (Goat Hill Electronics LLC) — needed only if the credentials are ever switched to the Apple ID form, since the API key carries its own team.

They are named `APPLE_*` rather than electron-builder's bare `CSC_LINK` because `CSC_LINK` is **not** macOS-specific — exported on the Windows leg it would hand electron-builder an Apple certificate to sign the NSIS installer with. A future Windows certificate gets `WIN_CSC_*` and the two never collide.

The App Store Connect API key is an authentication mechanism, not an App Store enrollment — it grants no publishing ability at the _Developer_ role, and the app is still distributed outside the App Store. It is preferred over an Apple ID and app-specific password because it belongs to the team rather than one person, is revocable on its own, and does not silently die when an Apple ID password rotates. electron-builder recommends the same.

**Credential precedence is a trap.** electron-builder checks `APPLE_ID` / `APPLE_APP_SPECIFIC_PASSWORD` _first_ and, if either is set, requires all three of that set and ignores the API key entirely. Never set both.

To produce the two base64 values (the `.p12` from Keychain Access, the `.p8` downloaded once from App Store Connect):

```bash
base64 -i /path/to/DeveloperID.p12 | pbcopy    # → APPLE_CSC_LINK
base64 -i /path/to/AuthKey_XXXXXXXXXX.p8 | pbcopy   # → APPLE_API_KEY
```

### 7.2 The build keychain, and why CI owns it

`.github/actions/mac-signing-credentials` imports the certificate into a keychain it creates itself and exports **`CSC_KEYCHAIN`**. It deliberately does not export `CSC_LINK`.

Handing electron-builder a `CSC_LINK` is the documented path, and it does create a keychain and import the `.p12` — but it then calls `security set-key-partition-list … -k <p12 password>`, passing the _certificate's_ password where the _keychain's_ password belongs (`app-builder-lib`'s `importCerts()`). The partition list is what tells macOS that `codesign` may use the private key without asking a human. When it does not take effect, `codesign` falls back to a SecurityAgent prompt, and on a headless runner nobody answers it: **the build hangs** — no error, no timeout — on the line

```
• signing  file=dist/mac-arm64/GoatCAD.app platform=darwin type=distribution identityName=Developer ID Application: …
```

Doing the import ourselves fixes that and buys three other things worth keeping:

- **`set-keychain-settings` with no `-t`/`-u`**, so the keychain never auto-locks. The default is a 300-second inactivity timeout, free to expire partway through signing a bundle with thousands of nested binaries — the same silent prompt by a different route.
- **A pre-flight `security find-identity -v -p codesigning`.** A certificate that imports but is unusable — a development cert rather than Developer ID, or a `.p12` exported without its private key — otherwise surfaces only after the ~10-minute build.
- **The search list is prepended, not replaced.** `security list-keychains -s` overwrites outright, and dropping the login keychain breaks unrelated tooling on the runner.

electron-builder honours `CSC_KEYCHAIN` when `CSC_LINK` is absent (`macPackager`'s `codeSigningInfo`), threading it through both identity discovery and the `codesign --keychain` call, so the rest of the pipeline is unchanged. Both workflows also carry `timeout-minutes: 30`: this failure mode hangs rather than fails, and the default six-hour ceiling on runners that bill at 10x is an expensive way to learn that. Thirty minutes is a deliberate ceiling, not an estimate — a mac leg that needs longer is a bug to fix rather than a budget to raise, even though §7.5 means every build now waits on two notary submissions.

### 7.3 Expiry and rotation

A Developer ID certificate lasts five years; rotating it means re-exporting the `.p12` and updating two secrets. Builds already signed keep validating past expiry because the signature carries a secure timestamp — `verify-mac-signing` checks for one.

### 7.4 Why there is a verification step

Every failure mode here is quiet. A missing certificate makes electron-builder log `skipped macOS application code signing`; missing notary credentials make it log `skipped macOS notarization`. **Both exit 0.** The resulting `.dmg` also opens fine on the machine that built it, because a locally produced file never carries a quarantine attribute — the rejection only appears once a user downloads it.

So a green build proves nothing on its own. `electron/bin/verify-mac-signing` is the gate, run in CI on every tag and worth running locally before one.

`.github/workflows/mac-signing-check.yml` runs that same gate on demand (`workflow_dispatch`), building macOS only and publishing nothing — the place to confirm credentials work without spending a version number on it, and the place to re-confirm after a certificate rotation. It shares the credential step with `release.yml` through `.github/actions/mac-signing-credentials`, because a check that had drifted from the real release path would prove nothing. It checks that the signature is valid and covers nested code, that the identity is Developer ID rather than a development certificate, that the hardened runtime is on, that a secure timestamp exists, that a notarization ticket is **stapled**, and that Gatekeeper accepts both the `.app` and the `.dmg`. `-c.mac.forceCodeSigning=true` on the CI build makes the signing half fail early with a clearer message; the config file deliberately does not set it, since that would break local builds for contributors with no certificate.

### 7.5 The disk image is signed and notarized separately

electron-builder signs the app, notarizes it, staples the ticket, and _then_ builds the `.dmg` and `.zip` from the stapled bundle — so the app inside both carries a ticket. **The disk image gets neither treatment by default**, and Gatekeeper assesses the image too. That is a distinct failure from anything in §7.2: the app can be perfectly signed and notarized while the `.dmg` a user downloads is refused.

Two settings close it, and the order is forced — the notary service rejects an unsigned submission:

- **`dmg.sign: true`** in `electron-builder.yml`. `dmg-builder` checks `sign === true` strictly, so an absent key means the image is silently left unsigned and `spctl --assess` reports `no usable signature`. It threads the packager's keychain into `codesign --keychain`, so it works under CI's build keychain (§7.2) as well as a local login keychain. **The build log cannot tell you either way** — `signDmg` shells out to `codesign` directly and prints nothing on success, so there is exactly one `• signing` line whether or not the image was signed. `codesign -dv <dmg>` is the only answer.
- **`afterAllArtifactBuild: build/notarize-dmg.js`**, which submits the signed image to the notary service and staples the returned ticket. Signing alone is not enough: a signed but un-notarized image assesses as `Unnotarized Developer ID`.

**Stapling rewrites the `.dmg`, which invalidates the `sha512` and `size` electron-builder already wrote into `latest-mac.yml`** — the metadata electron-updater trusts (§4.1). The hook repairs that entry after stapling, patching only those two lines so the rest of the file stays byte-identical. The `.blockmap` beside the image goes stale as well, but it is not published (`release.yml` uploads `*.dmg`, `*.zip`, and `latest-mac.yml` only) and macOS updates are served from the `.zip`.

The hook skips with a log line when notary credentials are absent, matching `mac.notarize`'s leniency so a contributor without an Apple account can still build locally — which is once more why `verify-mac-signing`, not a green build, is the gate.

---

## 8. Download hosting

**Downloads are served from Cloudflare R2, not GitHub.** A private repo's release asset URLs only work for someone signed in with access to it, so a GitHub link hands every outside visitor a 404. And GitHub never holds the files at all: the build jobs upload straight to R2, because workflow artifacts count against the account's GitHub storage and a release is ~600 MB. The GitHub release keeps the tag, the notes and links to the files.

- **Bucket** `goatcad`, standard storage class, public through the custom domain **`download.goatcad.com`**. Every release lives in **one folder, `releases/<random>/`**, defined once as `publish.url` in `electron-builder.yml` — it is also the updater's feed URL, so the app and the uploads cannot disagree, and `.github/scripts/r2-release.sh` reads it from there. Files sit under their electron-builder output names; those carry the version, so releases never collide, and each `latest*.yml` ends up beside the files it names, which is the layout electron-updater's `generic` provider expects (§4.1).
- **The folder name is fixed for good.** A bucket served through a custom domain cannot be listed, so `releases/latest-mac.yml` is a 404 while `releases/<random>/latest-mac.yml` works, and there is deliberately no per-request check. **Changing the name strands every installed copy's updater** (the URL is baked into `app-update.yml` at build time); if it ever has to move, copy the current release across before changing `publish.url`.
- **Uploading** happens in each `release.yml` build job, through `r2-release.sh`, which owns the layout for both workflows: installers into the folder (cached for a day), and `latest*.yml` plus a per-platform list of installer names under `pending/<tag>/`. On `release: published`, `web-release-bump.yml`'s `promote` job copies the feeds into place (`no-cache`), unless it is a prerelease — the feed is what tells every install what is newest — and `bump` builds `release.json` from the lists. `workflow_dispatch` with a tag re-runs publishing for a release already published.
- **Credentials** are a bucket-scoped R2 API token (Object Read & Write on `goatcad` only) in `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY`, plus the existing `CLOUDFLARE_ACCOUNT_ID` for the endpoint. Not `CLOUDFLARE_API_TOKEN`: R2 permission on that token is account-wide, and it is deliberately scoped to deploying the site (WEB.md §5).

R2 can stay the host after the repo goes public; it does not bill egress.

---

## 9. What ships, and how it is sealed

The source is public under GPL-3.0-or-later (BRAND.md §2), so nothing here hides code; these measures keep the download small and stop code being injected into an installed copy.

**1. Licenses ship with it.** `resources/THIRD_PARTY_NOTICES.txt` carries GoatCAD's license statement, the KiCad attribution and every bundled component's license text. Settings ▸ About lists the same notices, the major components first, each opening to its license text, and opens the file. `./bin/notices` regenerates both from the installed packages and the wasm builds' license files, and the default suite fails while it is stale, so a dependency upgrade regenerates it.

**2. Everything ships minified.** Main, the preload and the renderer all set `build.minify: 'esbuild'` in `electron.vite.config.ts` (electron-vite's default is `false`): smaller bundles, faster to parse. The Corresponding Source the GPL asks for is the repo at the release tag, not the bundle.

electron-vite's V8 bytecode for main (`build.bytecode`) is deliberately off. It covered only main; its loader makes V8 compile everything main ever loads eagerly (`--no-lazy`, process-wide); it ties a build to the Electron binary and CPU that compiled it; and it cannot cover the preload, whose V8 rejects the cache — v0.1.0 shipped that way and every window came up without `window.api`.

**3. Only the app ships.** `files` in `electron-builder.yml` excludes what electron-builder would otherwise pack from `electron/` — `bin/`, `scripts/`, the vitest configs, and `wasm/` (C++ glue, build scripts and patches; the built `.wasm` is in `out/`). Check with `asar list` after adding a top-level directory: the asar should hold `out/`, `node_modules/`, `resources/` and `package.json`, nothing else.

**4. Electron fuses** (`electronFuses` in `electron-builder.yml`), flipped in the binary at package time, before signing:

| Fuse                                    | Setting | Why it is safe for GoatCAD                                                                                                                                                                                                                                                                                                                                         |
| --------------------------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `runAsNode`                             | off     | Stops `ELECTRON_RUN_AS_NODE` turning the app into a Node runtime. Nothing in main forks or re-runs the executable in Node mode; terminal sessions strip the variable from shells anyway. Build-time compilation uses the dev dependency's Electron, not the fused app.                                                                                             |
| `enableNodeOptionsEnvironmentVariable`  | off     | Stops `NODE_OPTIONS=--require …` injecting code. It also disables `NODE_EXTRA_CA_CERTS`, which is harmless only because every outbound request goes through Electron's `session.fetch` (`src/main/outboundFetch.ts`) and the OS certificate store. A main-process call on Node's own `fetch` would lose that workaround for users behind TLS-intercepting proxies. |
| `enableNodeCliInspectArguments`         | off     | Stops attaching a debugger to the main process with `--inspect` or `SIGUSR1`.                                                                                                                                                                                                                                                                                      |
| `enableEmbeddedAsarIntegrityValidation` | on      | The app refuses an `app.asar` whose hash no longer matches the one electron-builder embedded, so the installed app cannot be patched in place. macOS and Windows; no effect on Linux.                                                                                                                                                                              |
| `onlyLoadAppFromAsar`                   | on      | Electron will not load code from an `app` folder next to the archive, closing the obvious way around the integrity check.                                                                                                                                                                                                                                          |

`grantFileProtocolExtraPrivileges` stays at its default because the renderer is loaded from `file://`, and `enableCookieEncryption` is left alone because the app keeps nothing in cookies.

**Verifying a build.** None of this shows up in tests, and a fuse or packaging problem appears only in a packaged app. `./bin/verify-packaged` launches the packaged binary headless with a fresh profile and fails unless the preload bridge is present, the Welcome tab mounts and the renderer logs no error — the check that would have caught v0.1.0. Before shipping a build that changes any of it, launch the packaged app and exercise each worker and native path: rebuild the library index, open a datasheet PDF, open a `.step` model, open a terminal tab, and connect the MCP server.
