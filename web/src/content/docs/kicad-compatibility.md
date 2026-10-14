---
title: KiCad compatibility
description: GoatCAD reads KiCad 6 through 10 files and saves KiCad 10. What that means for older projects.
order: 4
---

GoatCAD reads and writes KiCad's own files: schematics, boards, symbol and footprint
libraries, library tables and project files. There is no import step and no private copy
of the design.

## Versions

| Written by          | In GoatCAD                            |
| ------------------- | ------------------------------------- |
| KiCad 10            | Opens and saves as is                 |
| KiCad 6, 7, 8, 9    | Opens; saving upgrades to KiCad 10    |
| Before KiCad 6      | Read-only. Save it in KiCad 6+ first. |
| Newer than KiCad 10 | Read-only                             |

Opening a file never changes it on disk. A file from an older KiCad shows a banner
saying it will be migrated to the KiCad 10 format when you save. For a schematic with
sheets, that first save upgrades every sheet and the `.kicad_pro` together, so the
project stays on one version.

After that save, KiCad 9 and earlier can no longer open the file. If you share a design
with someone on an older KiCad, commit or back it up before saving it in GoatCAD.

## Working alongside KiCad

Both tools can stay installed and open the same KiCad 10 project. GoatCAD adds no files of
its own; see [the file model](/docs#the-file-model).

If a file does not open cleanly, include the KiCad version that wrote it when you report
the problem.
