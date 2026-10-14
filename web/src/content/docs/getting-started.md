---
title: Getting started
description: Open or create a project in GoatCAD, and find the schematic, PCB, symbol and footprint editors.
order: 3
---

## Open a project

The welcome page offers:

- **New project…**: pick a folder and create a schematic and board in it. If the folder
  already holds `.kicad_sch` or `.kicad_pcb` files, the new project can adopt them instead
  of starting blank.
- **Open project…**: open an existing `.kicad_pro`.
- **Open folder…**: open a folder, with or without a project in it.
- **Open file…**: open a single file.
- **Open sample project…**: download an example design from GitHub to look around in.

A KiCad project opens in place. See [KiCad compatibility](/docs/kicad-compatibility)
for what happens to files from older KiCad versions.

## The editors

Each file opens in its own tab, and the editor follows the file type.

| File         | Editor    | Also in the tab                                       |
| ------------ | --------- | ----------------------------------------------------- |
| `.kicad_sch` | Schematic | Components table, Schematic Setup                     |
| `.kicad_pcb` | PCB       | Layout, 3D preview and Board setup views; fab outputs |
| `.kicad_sym` | Symbol    | One symbol per tab                                    |
| `.kicad_mod` | Footprint | Footprint and 3D preview views                        |

With nothing selected on a board, the properties panel's **Fabrication outputs** button
opens Gerbers, drill files, BOM and pick-and-place export.

## Schematic and board

The schematic and the board stay separate files. Selecting a part in one selects it in
the other, and in the Components table, across split panes and windows.

Schematic changes reach the board when you ask: **Tools ▸ Update PCB from Schematic…**
(F8) lists what will change before applying it.
