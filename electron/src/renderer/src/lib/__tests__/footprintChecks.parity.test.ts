/**
 * Footprint checks against KiCad's own, on KiCad's own library. Not in the
 * default suite and never on CI: it needs KiCad installed (`kicadParity.ts`)
 * and takes minutes. Run it with `./bin/test-parity`.
 *
 * KiCad's footprint checker is not scriptable, so this asks its board DRC,
 * which runs the same `FOOTPRINT::Check*` on every footprint: each library
 * becomes a board, one footprint per cell and one net per pad number (so
 * `shorting_items` means what `CheckShortingPads` means), with the limits the
 * footprint checker uses (`PROJECT`). Findings are compared
 * per footprint and per KiCad violation key, not by count: the two sides split
 * findings differently.
 *
 * `PARITY_FOOTPRINT_LIBS=Connector_JAE,Battery` narrows the run;
 * `PARITY_REPORT=<file>` keeps the full comparison.
 */
import { describe, expect, test } from 'vitest'
import { execFile } from 'child_process'
import { randomUUID } from 'crypto'
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { promisify } from 'util'
import { parseKicadFootprint } from '../kicad/footprint'
import { FOOTPRINT_KICAD_KEYS, footprintChecks } from '../footprint/footprintChecks'
import { requireKicadCli, kicadFootprintDir } from './kicadParity'

const run = promisify(execFile)
const cli = requireKicadCli()
const library = kicadFootprintDir(cli)
if (!library) {
  throw new Error('KiCad footprint library not found: set KICAD10_FOOTPRINT_DIR to it.')
}

/** The violations KiCad's footprint checker raises; the rest of DRC is the board's business. */
const COMPARED = new Set(Object.values(FOOTPRINT_KICAD_KEYS))

const HEAD = `(kicad_pcb
\t(version 20260206)
\t(generator "goatcad-parity")
\t(generator_version "10.0")
\t(general (thickness 1.6) (legacy_teardrops no))
\t(paper "A0")
\t(layers
\t\t(0 "F.Cu" signal) (4 "In1.Cu" signal) (6 "In2.Cu" signal) (2 "B.Cu" signal)
\t\t(9 "F.Adhes" user "F.Adhesive") (11 "B.Adhes" user "B.Adhesive")
\t\t(13 "F.Paste" user) (15 "B.Paste" user) (5 "F.SilkS" user "F.Silkscreen")
\t\t(7 "B.SilkS" user "B.Silkscreen") (1 "F.Mask" user) (3 "B.Mask" user)
\t\t(17 "Dwgs.User" user "User.Drawings") (19 "Cmts.User" user "User.Comments")
\t\t(21 "Eco1.User" user "User.Eco1") (23 "Eco2.User" user "User.Eco2") (25 "Edge.Cuts" user)
\t\t(27 "Margin" user) (31 "F.CrtYd" user "F.Courtyard") (29 "B.CrtYd" user "B.Courtyard")
\t\t(35 "F.Fab" user) (33 "B.Fab" user))
\t(setup (pad_to_mask_clearance 0))
`

/**
 * The footprint checker's limits, not a board's: copper and holes may not
 * touch. A limit of zero turns its check off, shorts included, so both are 1 nm.
 */
const PROJECT = JSON.stringify({
  board: {
    design_settings: {
      rules: {
        min_clearance: 0,
        min_hole_clearance: 0,
        min_hole_to_hole: 0.000001,
        min_through_hole_diameter: 0,
        min_silk_clearance: 0
      }
    }
  },
  net_settings: { classes: [{ name: 'Default', clearance: 0.000001 }] }
})

/**
 * Where the comparison is known to differ, and why; each was checked against
 * KiCad's own geometry through its `pcbnew` Python module. The first two are
 * KiCad's geometry erring (kicad-parity.md, deviations); the rest
 * are what the footprint checker reports and board DRC, the stand-in here, does not.
 * An entry that stops differing fails the run, so the list cannot go stale.
 */
const KNOWN: Record<string, { key: string; why: string }> = {
  'Audio_Module.pretty/Reverb_BTDR-1H.kicad_mod': {
    key: 'silk_over_copper',
    why: 'KiCad: an arc inside a round opening, touching no edge, does not collide'
  },
  'LED_THT.pretty/LED_Oval_W5.2mm_H3.8mm.kicad_mod': {
    key: 'silk_over_copper',
    why: 'KiCad: an arc overlapping a sharp rect by under its width reads as clear'
  },
  'RF_Antenna.pretty/Astrocast_AST50127-00.kicad_mod': {
    key: 'silk_over_copper',
    why: 'board DRC does not hold silk to mask-layer drawings; CheckClippedSilk does'
  },
  'Package_DFN_QFN.pretty/Texas_RGY_R-PVQFN-N16_EP2.05x2.55mm_ThermalVias.kicad_mod': {
    key: 'shorting_items',
    why: 'board DRC passes vias inside a pad of another number; CheckShortingPads does not'
  }
}

/** KiCad's DRC stops reporting a violation after this many (`ERROR_LIMIT`, drc_engine.cpp). */
const DRC_ERROR_LIMIT = 199
/** Footprints per board, well under what fills that limit. */
const BOARD_SIZE = 40

const extent = (text: string): { minX: number; minY: number; maxX: number; maxY: number } => {
  const values = [...text.matchAll(/\((?:start|end|mid|center|xy|at) (-?[\d.]+) (-?[\d.]+)/g)]
  const xs = values.map((m) => Number(m[1]))
  const ys = values.map((m) => Number(m[2]))
  return {
    minX: Math.min(0, ...xs),
    minY: Math.min(0, ...ys),
    maxX: Math.max(0, ...xs),
    maxY: Math.max(0, ...ys)
  }
}

/** A board of every footprint in `files`, each on its own net-numbered pads. */
const boardOf = (nickname: string, files: string[]): { text: string; refs: string[] } => {
  const blocks: string[] = []
  const refs: string[] = []
  let x = 0
  let y = 0
  let rowHeight = 0
  for (const file of files) {
    const source = readFileSync(file, 'utf8').trim()
    const box = extent(source)
    // Coordinates are centers; a pad or stroke reaches past them, so the margin is generous.
    const width = box.maxX - box.minX + 30
    const height = box.maxY - box.minY + 30
    if (x + width > 1100) {
      x = 0
      y += rowHeight
      rowHeight = 0
    }
    const at = `(at ${(x - box.minX + 15).toFixed(4)} ${(y - box.minY + 15).toFixed(4)})`
    x += width
    rowHeight = Math.max(rowHeight, height)
    const ref = `FP${refs.length}`
    refs.push(file)
    let unnumbered = 0
    const body = source
      .replace(/^\(footprint "([^"]*)"/, (_, name) => `(footprint "${nickname}:${name}"`)
      .replace(/\n\t\((?:version|generator|generator_version) [^\n]*\)/g, '')
      .replace(/(\(layer "[FB]\.Cu"\))/, `$1\n\t${at}`)
      .replace('"REF**"', `"${ref}"`)
      // Sibling footprints from one generator share uuids, and KiCad names a
      // violation's items by uuid, so a short in one reads as in the other.
      .replace(/\(uuid "[^"]*"\)/g, () => `(uuid "${randomUUID()}")`)
      // An edge-mount part's Edge.Cuts would become the board's outline, and DRC
      // then passes over what lies outside it; the footprint checker ignores the layer.
      .replace(/\(layer "Edge\.Cuts"\)/g, '(layer "Dwgs.User")')
      .replace(/\(pad "([^"]*)" (?:smd|thru_hole|np_thru_hole|connect) [a-z_]+/g, (pad, number) => {
        const net = number ? `${ref}-${number}` : `${ref}-u${++unnumbered}`
        return `${pad} (net "${net}")`
      })
    blocks.push(`\t${body.replace(/\n/g, '\n\t')}`)
  }
  return { text: `${HEAD}${blocks.join('\n')}\n)\n`, refs }
}

interface Violation {
  type: string
  items: Array<{ description: string }>
}

/** Per footprint file, the compared KiCad keys each side raised. */
const compareBoard = async (
  dir: string,
  nickname: string,
  files: string[]
): Promise<Array<{ file: string; ours: string[]; kicad: string[] }>> => {
  const { text, refs } = boardOf(nickname, files)
  const work = mkdtempSync(join(tmpdir(), 'goatcad-parity-'))
  writeFileSync(join(work, 'parity.kicad_pcb'), text)
  writeFileSync(join(work, 'parity.kicad_pro'), PROJECT)
  const report = join(work, 'drc.json')
  await run(
    cli,
    [
      'pcb',
      'drc',
      '--format',
      'json',
      '--severity-all',
      '-o',
      report,
      join(work, 'parity.kicad_pcb')
    ],
    {
      maxBuffer: 64 * 1024 * 1024
    }
  )
  const kicad = refs.map(() => new Set<string>())
  const violations = (JSON.parse(readFileSync(report, 'utf8')) as { violations: Violation[] })
    .violations
  const counts = new Map<string, number>()
  for (const { type } of violations) counts.set(type, (counts.get(type) ?? 0) + 1)
  // A full limit silences the rest of that check (and a full `clearance` stops
  // the short test), so a comparison past it would lie.
  const full = [...counts].filter(
    ([type, count]) => (COMPARED.has(type) || type === 'clearance') && count >= DRC_ERROR_LIMIT
  )
  if (full.length)
    throw new Error(`${nickname}: DRC hit its limit on ${full.map(([type]) => type).join(', ')}`)
  for (const violation of violations) {
    if (!COMPARED.has(violation.type)) continue
    // A board has what a footprint does not: a copper drawing there is a netless
    // item that shorts every pad it touches, where the footprint checker minds
    // copper drawings only in a net tie; and two footprints can only meet by layout.
    if (violation.items.some((item) => item.description.includes('[<no net>]'))) continue
    // `CheckClippedSilk` reads drawings, not fields; a Reference here is renamed and resized.
    if (violation.items.some((item) => / field of /.test(item.description))) continue
    const owners = new Set(
      violation.items.flatMap(
        (item) => /\b(?:of |Footprint )FP(\d+)\b/.exec(item.description)?.[1] ?? []
      )
    )
    if (owners.size !== 1) continue
    for (const ref of owners) kicad[Number(ref)].add(violation.type)
  }
  return refs.map((file, index) => {
    const ours = new Set(
      footprintChecks(parseKicadFootprint(readFileSync(file, 'utf8'))).flatMap(
        (result) => FOOTPRINT_KICAD_KEYS[result.code] ?? []
      )
    )
    return {
      file: file.slice(dir.length + 1),
      ours: [...ours].sort(),
      kicad: [...kicad[index]].sort()
    }
  })
}

describe('footprint checks match KiCad', () => {
  test(
    "on KiCad's footprint library",
    async () => {
      const only = process.env.PARITY_FOOTPRINT_LIBS?.split(',').map((name) => name.trim())
      const boards = readdirSync(library!)
        .filter((name) => name.endsWith('.pretty'))
        .map((name) => name.slice(0, -'.pretty'.length))
        .filter((name) => !only || only.includes(name))
        .flatMap((nickname) => {
          const files = readdirSync(join(library!, `${nickname}.pretty`))
            .filter((name) => name.endsWith('.kicad_mod'))
            .map((name) => join(library!, `${nickname}.pretty`, name))
          return Array.from({ length: Math.ceil(files.length / BOARD_SIZE) }, (_, i) => ({
            nickname,
            files: files.slice(i * BOARD_SIZE, (i + 1) * BOARD_SIZE)
          }))
        })
      const results: Array<{ file: string; ours: string[]; kicad: string[] }> = []
      // A few boards at once: each kicad-cli is one process.
      await Promise.all(
        Array.from({ length: 6 }, async () => {
          for (let next = boards.shift(); next; next = boards.shift()) {
            results.push(...(await compareBoard(library!, next.nickname, next.files)))
          }
        })
      )
      const differences = results.filter((row) => row.ours.join() !== row.kicad.join())
      const byKey = new Map<string, { oursOnly: string[]; kicadOnly: string[] }>()
      const known = new Set<string>()
      for (const row of differences) {
        for (const key of new Set([...row.ours, ...row.kicad])) {
          if (row.ours.includes(key) === row.kicad.includes(key)) continue
          if (KNOWN[row.file]?.key === key) {
            known.add(row.file)
            continue
          }
          const entry = byKey.get(key) ?? { oursOnly: [], kicadOnly: [] }
          ;(row.ours.includes(key) ? entry.oursOnly : entry.kicadOnly).push(row.file)
          byKey.set(key, entry)
        }
      }
      const summary = Object.fromEntries(
        [...byKey].map(([key, entry]) => [
          key,
          {
            oursOnly: entry.oursOnly.length,
            kicadOnly: entry.kicadOnly.length,
            examples: [...entry.oursOnly.slice(0, 3), ...entry.kicadOnly.slice(0, 3)]
          }
        ])
      )
      if (process.env.PARITY_REPORT) {
        writeFileSync(
          process.env.PARITY_REPORT,
          JSON.stringify({ footprints: results.length, differences, summary }, null, 1)
        )
      }
      expect(summary).toEqual({})
      // A known difference that no longer differs is a list gone stale — on a full run.
      if (!only) expect(Object.keys(KNOWN).filter((file) => !known.has(file))).toEqual([])
    },
    60 * 60 * 1000
  )
})
