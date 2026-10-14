---
title: Installation
description: Builds of GoatCAD for macOS, Windows, and Linux.
order: 2
installMatrix: true
---

## Requirements

| Platform | Minimum                  |
| -------- | ------------------------ |
| macOS    | macOS 12, Apple silicon  |
| Windows  | Windows 10 (1809), x64   |
| Linux    | x64, glibc 2.28 or newer |

The Windows installer is per-user and needs no administrator rights.

## Linux: Debian and Ubuntu

The `.deb` is the best option on Debian, Ubuntu, Mint, and anything else apt-based. It
installs like any other package, registers the menu entry and the KiCad file
associations, and comes off with `apt remove goatcad`.

```bash
sudo apt install ./goatcad_*_amd64.deb
```

Download the `.deb` first — apt takes a local path.

## Linux: other distributions

The `.AppImage` is one self-contained file that runs anywhere. Nothing is installed and
nothing is left behind, which also means no menu entry and no file associations unless
you add them.

```bash
chmod +x GoatCAD-*.AppImage && ./GoatCAD-*.AppImage
```

[Gear Lever](https://mijorus.it/projects/gearlever/) or `AppImageLauncher` will register
it with your desktop if you want those.

## Updates

The `.dmg`, `.exe` and `.AppImage` installs check for a newer version on launch and every
few hours, download it in the background, and ask before restarting into it; otherwise it
installs on the next quit. Settings ▸ About turns the check off.

The `.deb` does not self-update. Install a newer `.deb` the same way.
