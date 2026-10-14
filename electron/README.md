# GoatCAD (desktop app)

The GoatCAD Electron app — schematic, board layout, and footprint editors for KiCad designs.

This directory is a self-contained npm project: install and run everything from here, not from the
repo root. For the repo as a whole, see [../README.md](../README.md); for architecture and workspace
rules, see [../docs/ARCHITECTURE.md](../docs/ARCHITECTURE.md) and
[../docs/RULES.md](../docs/RULES.md).

## Recommended IDE Setup

- [VSCode](https://code.visualstudio.com/) + [ESLint](https://marketplace.visualstudio.com/items?itemName=dbaeumer.vscode-eslint) + [Prettier](https://marketplace.visualstudio.com/items?itemName=esbenp.prettier-vscode) + [Volar](https://marketplace.visualstudio.com/items?itemName=Vue.volar)

## Project Setup

`npm` is not on `PATH` in the default shell — the `bin/` scripts source nvm first, so prefer them
over calling `npm` directly.

```bash
$ npm install          # one-time (needs nvm sourced: `source ~/.nvm/nvm.sh`)
$ ./bin/dev            # run the app in development (sources nvm for you)
```

### Linux sandbox setup (Ubuntu 24.04+)

Recent Ubuntu restricts unprivileged user namespaces via AppArmor, so `npm run dev` fails with a
chrome-sandbox error in every fresh checkout/worktree. Pick **one** of these one-time fixes and the
per-worktree `chown`/`chmod` dance is no longer needed.

**Option A — AppArmor profile (recommended).** Allows user namespaces for any Electron dev binary
under `~/code`, so every worktree and fresh `npm install` just works, without loosening the
system-wide default:

```bash
sudo tee /etc/apparmor.d/electron-dev >/dev/null <<'EOF'
abi <abi/4.0>,
include <tunables/global>

profile electron-dev /home/*/code/**/node_modules/electron/dist/electron flags=(unconfined) {
  userns,

  include if exists <local/electron-dev>
}
EOF
sudo apparmor_parser -r /etc/apparmor.d/electron-dev
```

**Option B — sysctl.** Disables the userns restriction globally (broader than A: it re-opens
unprivileged user namespaces to all programs, which is the pre-24.04 behavior):

```bash
echo 'kernel.apparmor_restrict_unprivileged_userns = 0' | sudo tee /etc/sysctl.d/60-apparmor-userns.conf
sudo sysctl --system
```

**Option C — no sudo, dev only.** `ELECTRON_DISABLE_SANDBOX=1 npm run dev` skips the sandbox
entirely. Fine for local dev; packaged builds are unaffected.

Verify with a plain `npm run dev` from any worktree. The old fallback (making the setuid helper
root-owned) still works but must be redone after every `npm install` in every worktree:

```bash
sudo chown root:root node_modules/electron/dist/chrome-sandbox
sudo chmod 4755 node_modules/electron/dist/chrome-sandbox
```

### Checks

| Script                   | Does                                          |
| :----------------------- | :-------------------------------------------- |
| `./bin/dev`              | run the app in development (blocks the shell) |
| `./bin/pre-cm-checks`    | format + lint + typecheck + test (pre-commit) |
| `./bin/pre-merge-checks` | bundle only (pre-merge)                       |
| `./bin/typecheck`        | tsc (main/preload) + vue-tsc (renderer)       |
| `./bin/test`             | vitest                                        |
| `./bin/lint`             | eslint                                        |
| `./bin/format`           | prettier --write                              |
| `./bin/build`            | typecheck + bundle to `out/` (no installer)   |

`./bin/test-i18n` checks translation _completeness_ separately. It is not part of `./bin/test` — an
untranslated key falls back to English, so it never blocks a feature, but it does block a release.

### Resetting local state

`./bin/reset` deletes GoatCAD's config and cache directory so the next launch behaves like a fresh
install — no recents, no restored session, no library table, no cached footprints. Use `--dry-run`
to preview and `--yes` to skip the prompt. **Quit the app first.**

```bash
$ ./bin/reset --dry-run
```

## Packaging

`./bin/build` only bundles JavaScript into `out/`. To produce a real installable app, use
`./bin/package`, which writes artifacts to `dist/`:

```bash
$ ./bin/package                  # default target for your current platform
$ ./bin/package --linux deb      # or name any electron-builder target
$ ./bin/package --linux AppImage
$ ./bin/package --mac
$ ./bin/package --win
```

Electron-builder can generally only build for the platform you are on: macOS artifacts require
macOS, and Windows installers require Windows (or wine). There is no true cross-compile story here.

### Installing, per platform

**Linux (deb) — recommended for testing.** This is the default for `./bin/package` on Linux and the
only Linux target that registers file associations (see below).

```bash
$ ./bin/package
$ sudo apt install ./dist/goatcad_*_amd64.deb    # installs to /opt/GoatCAD, command: goatcad
$ sudo apt remove goatcad                        # to uninstall
```

**Linux (AppImage).** Portable, no install step. A bare AppImage registers nothing with the OS, but
desktop-integration tools (AppImageLauncher, `appimaged`) extract its bundled `.desktop` file and
icon into `~/.local/share/applications`, after which double-click works — see the caveat below.

```bash
$ ./bin/package --linux AppImage
$ chmod +x dist/goatcad-*.AppImage && ./dist/goatcad-1.0.0.AppImage
```

**Linux (snap).** snapd installs the snap's desktop file under
`/var/lib/snapd/desktop/applications`, so it registers as a handler automatically. Building one
requires `snapcraft` on the build machine. Note `./bin/package --linux` with no target builds
AppImage, snap, _and_ deb, so it will fail without snapcraft — name the target explicitly.

**macOS.** Produces `dist/goatcad-1.0.0.dmg`; open it and drag GoatCAD to Applications. A local build
is signed only if you happen to have a Developer ID certificate in your keychain, and is never
notarized — electron-builder logs `skipped macOS notarization` and carries on. That is fine for local
testing, because a file you built yourself has no quarantine attribute and opens regardless.

It also means a local build tells you nothing about whether a _release_ would open. Release signing
and notarization happen in CI (`docs/RELEASES.md` §7); to check a build the way a user's Mac
would, run `./bin/verify-mac-signing` after packaging.

**Windows.** Produces an NSIS installer, `dist/goatcad-1.0.0-setup.exe`. It is unsigned, so SmartScreen
will warn ("More info" > "Run anyway"). Associations are registered by the installer, so they work
for an installed build, not a loose `--dir` build.

## Releases

Release builds are tag-triggered and cut from this package's `version`. Nothing above packages an
app for release — `./bin/package` builds locally, the tag builds all three platforms in CI.

**To cut one, use the `release` skill** ([../.claude/skills/release/SKILL.md](../.claude/skills/release/SKILL.md)):
it runs the gates, settles the version with you, bumps `package.json`, and pushes the tag. Don't tag
by hand — the tag must match `version` exactly or `release.yml` fails in seconds, and the gates it
runs (i18n coverage especially) are release-only, so a green CI run does not mean a green release.

For what the tag then does — artifacts, `latest*.yml` update metadata, channels, and the human
publish step that repoints the site's download buttons — see
[../docs/RELEASES.md](../docs/RELEASES.md).

## File associations

GoatCAD registers as a handler for `.kicad_pro`, `.kicad_sch`, `.kicad_pcb`, `.kicad_mod`, and
`.kicad_sym`, using the same mime type names KiCad itself uses (`application/x-kicad-schematic`
etc.). It therefore registers _alongside_ KiCad rather than replacing it — with both installed you
choose which one opens a file.

Associations come from the **installed package**, so they do nothing in `npm run dev`.

Opening a file uses its containing folder as the project; a `.kicad_pro` opens its folder with no
tab. If the file's project is already open in a window, it opens as a tab there instead of spawning
a new window.

### How this works on Linux (and why the deb is recommended)

Two independent layers have to line up:

1. **What the file _is_** — `/usr/share/mime/packages/*.xml` maps a glob (`*.kicad_sch`) to a type
   (`application/x-kicad-schematic`), compiled by `update-mime-database`. System-wide, needs root.
2. **Who can _open_ that type** — any `.desktop` file with a `MimeType=` line, indexed into
   `mimeinfo.cache` by `update-desktop-database`. Can be per-user.

Every Linux target we build ships layer 2: the deb installs `goatcad.desktop`, snapd publishes the
snap's desktop file automatically, and an AppImage carries one that integration tools install into
`~/.local/share/applications`.

Only the **deb** ships layer 1 (`/usr/share/mime/packages/goatcad.xml`) — a snap can't write there
under confinement, and an AppImage installs nothing. In practice that rarely bites, because we reuse
KiCad's official type names: any machine with KiCad installed already has layer 1, so an integrated
AppImage or a snap will associate fine. On a machine _without_ KiCad, those files sniff as
`text/plain`, our `MimeType=` never matches, and only the deb works. The deb is the only
self-sufficient target, which is why `./bin/package` defaults to it.

### Multiple apps claiming the same type

Two handlers is not a conflict — `mimeinfo.cache` lists every desktop file that declares a type, so
KiCad and GoatCAD both show up under "Open With". The winner is chosen separately, by the first
`[Default Applications]` entry found across `~/.config/mimeapps.list` (user-level, wins), then
`/etc/xdg/`, then `/usr/share/applications/`. Installing GoatCAD therefore does not silently take
`.kicad_sch` away from KiCad — you opt in with `xdg-mime default`, or via "Open With > Set as
default" in Files, which writes the same user-level entry.

### Verifying it works

**Linux.** After installing the deb:

```bash
$ xdg-mime query filetype path/to/board.kicad_sch     # -> application/x-kicad-schematic
$ xdg-mime query default application/x-kicad-schematic
$ xdg-mime default goatcad.desktop application/x-kicad-schematic   # make GoatCAD the default
$ xdg-open path/to/board.kicad_sch
```

The deb installs `/usr/share/applications/goatcad.desktop` and
`/usr/share/mime/packages/goatcad.xml`. If a file still opens elsewhere, the databases may be stale:
`sudo update-mime-database /usr/share/mime && sudo update-desktop-database`. Note that with KiCad
installed the mime types already exist — you are only changing which handler is default.

**macOS.** Right-click a `.kicad_sch` > Get Info > Open with > GoatCAD > Change All. If macOS does not
list it, the Launch Services database may need a nudge — the app must have been run once from
`/Applications`.

**Windows.** Right-click > Open with > Choose another app > GoatCAD > Always.

## Troubleshooting

- **Packaging stalls or fails downloading Electron.** `electron-builder.yml` sets
  `electronDownload.mirror: https://npmmirror.com/mirrors/electron/` (inherited from the project
  template). If that mirror is slow or unreachable from your network, drop the setting to use the
  default GitHub source.
- **`app-builder-lib` cannot find `fpm`.** The deb target needs `fpm`; electron-builder downloads it
  on first use, so the first `./bin/package` run is slower than later ones.
