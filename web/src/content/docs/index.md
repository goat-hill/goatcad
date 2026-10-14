---
title: Introduction
description: GoatCAD edits KiCad schematics, boards and libraries in place. Installation, setup and compatibility.
order: 1
---

GoatCAD is a schematic, PCB, symbol and footprint editor in one application. It works on
KiCad files in place, on your own disk.

- **[Installation](/docs/installation)**: builds for macOS, Windows, and Linux.
- **[Getting started](/docs/getting-started)**: open a project and find your way around.
- **[KiCad compatibility](/docs/kicad-compatibility)**: which KiCad versions it reads and writes.
- **[Connecting an agent](/docs/agents)**: Claude Code or Codex, working on the open design.
- **[Part search](/docs/part-search)**: DigiKey and Mouser API keys.
- **[Git](/docs/git)**: commits, pushes and visual diffs.

## The file model

A project is a folder of KiCad files:

```
my-board/
├── my-board.kicad_pro   # project settings
├── my-board.kicad_prl   # local view state: visible layers, active layer
├── my-board.kicad_sch   # schematic (a hierarchy adds more sheets)
├── my-board.kicad_pcb   # board
├── sym-lib-table        # project symbol libraries
├── fp-lib-table         # project footprint libraries
├── my-parts.kicad_sym   # a symbol library
└── my-parts.pretty/     # a footprint library, one .kicad_mod per footprint
```

GoatCAD reads and writes those files directly and adds none of its own. The same folder
opens in KiCad, and git sees ordinary text diffs.
