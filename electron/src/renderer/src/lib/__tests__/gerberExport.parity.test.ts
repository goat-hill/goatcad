/**
 * The fab export against KiCad's own, on real boards: each board's Gerbers
 * and drill file as `kicad-cli pcb export gerbers` / `pcb export drill` write
 * them, beside ours from the same file (fabrication-export-workstream.md).
 *
 * Gerbers are compared by the area they cover, layer by layer: both files are
 * read back through our parser into regions (`gerberRegions`) and each side's
 * excess is cut into pieces. Curves are chords on both sides, so a piece only
 * counts when it is more than a sliver along an edge — thicker than
 * `SLIVER_MM` on average (twice its area over its perimeter) and larger than
 * `MIN_PIECE_MM2`. A pad left out, a mask opening the wrong size or a slot
 * drawn round all clear both. Holes are compared one by one, after both files
 * are read by our Excellon reader: place, size, slot ends and plating.
 *
 * KiCad plots with its command-line defaults plus `--subtract-soldermask`,
 * which our writer does by default. Ours plots as the Manufacture tab does —
 * the project's text variables passed in — but for silk clipped to the
 * outline, which KiCad has no switch for.
 *
 * Not in the default suite and never on CI; needs KiCad (`kicadParity.ts`).
 * `PARITY_CACHE=<dir>` keeps KiCad's output; `PARITY_REPORT=<file>` keeps
 * every layer's figures and where it differs; `PARITY_DUMP=<dir>` writes both
 * sides of each layer that differs, as Gerber files, to open side by side.
 */
import { beforeAll, describe, expect, test } from 'vitest'
import { createHash } from 'crypto'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'fs'
import { tmpdir } from 'os'
import { basename, dirname, join } from 'path'
import { parseKicadBoard } from '../kicad/board'
import { MIN_FORMAT_VERSION } from '../kicad/migrate'
import { difference, loadClipper, type ClipPt, type ClipRegion } from '../geometry/clip'
import { parseGerber } from '../gerber/parse'
import { gerberRegions } from '../gerber/regions'
import { layerFromFileFunction } from '../gerber/files'
import { writeGerberLayer } from '../gerber/write'
import { collectDrillHits, writeExcellon, type DrillHit } from '../gerber/drill'
import { parseExcellon } from '../gerber/excellon'
import { parityBoards, settingsFor } from './parityBoards'
import {
  KicadGaveUp,
  requireKicadCli,
  kicadCliVersion,
  rememberGiveUp,
  runKicad
} from './kicadParity'

/** A piece of difference thinner than this on average is chord noise, mm. */
const SLIVER_MM = 0.01
/** A piece smaller than this is noise whatever its shape, mm². */
const MIN_PIECE_MM2 = 0.0005
/** How far two holes' positions and sizes may differ and still be one hole, mm. */
const HOLE_TOLERANCE_MM = 0.002

/**
 * Known differences: board file name → layer (or `drill`) → why. A listed
 * layer is still compared and reported, and fails only if it stops differing.
 */
const FACE_MISSING = (face: string): string =>
  `text in ${face}, which this machine lacks: kicad-cli substitutes a face, we plot the outlines saved with the text`
const RESHAPED =
  'TrueType text kicad-cli re-shapes from its own installed face, a hair off the outlines saved with it; knockout boxes follow'
const BARCODE = 'a barcode (QR / DataMatrix), which the writer does not plot'
const UNTRIAGED = (what: string): string => `${what} — cause not yet found`
const KNOWN: Record<string, Record<string, string>> = {
  'tinytapeout-demo.kicad_pcb': { 'F.SilkS': RESHAPED, 'B.SilkS': RESHAPED },
  'api_kitchen_sink.kicad_pcb': { 'F.Cu': BARCODE, 'F.SilkS': BARCODE },
  'issue24525.kicad_pcb': { 'Edge.Cuts': `${BARCODE}; ${UNTRIAGED('a table outline differs')}` },
  'issue14549.kicad_pcb': {
    'F.SilkS': FACE_MISSING('Calibri'),
    'B.SilkS': FACE_MISSING('Calibri'),
    'B.Mask': FACE_MISSING('Calibri')
  },
  'issue22475.kicad_pcb': {
    'B.SilkS': FACE_MISSING('Franklin Gothic Medium'),
    'In1.Cu': UNTRIAGED('kicad-cli plots less of a stored zone fill than the file holds'),
    'In2.Cu': UNTRIAGED('kicad-cli plots less of a stored zone fill than the file holds')
  },
  'embedded_table_rotated_legacy_v10.kicad_pcb': {
    'B.Cu': UNTRIAGED('a table read from a legacy rotated layout lands elsewhere')
  },
  'incorrect_text_mirroring_drc.kicad_pcb': {
    'F.Cu': UNTRIAGED('bold text in text boxes sits a few hundredths off'),
    'B.Cu': UNTRIAGED('bold text in text boxes sits a few hundredths off'),
    'F.SilkS': UNTRIAGED('bold text in text boxes sits a few hundredths off'),
    'B.SilkS': UNTRIAGED('bold text in text boxes sits a few hundredths off')
  },
  'issue24192.kicad_pcb': {
    'F.Cu':
      'a leader dimension with empty text: KiCad runs the leader on to where the text would sit'
  },
  'padstacks_complex.kicad_pcb': {
    'F.Mask': UNTRIAGED(
      'custom-mode padstack pads open the mask without the board margin in kicad-cli'
    ),
    'B.Mask': UNTRIAGED(
      'custom-mode padstack pads open the mask without the board margin in kicad-cli'
    )
  },
  '8851_HW-U1-VCU118_REV2-0_071417.kicad_pcb': {
    'F.SilkS': UNTRIAGED('this Allegro import plots silk text kicad-cli does not'),
    'B.SilkS': UNTRIAGED('this Allegro import plots silk text kicad-cli does not'),
    'In6.Cu': UNTRIAGED('one ring kicad-cli leaves off')
  },
  'zone_filler.kicad_pcb': {
    'F.Mask': UNTRIAGED('two slivers where healed openings meet'),
    'B.Mask': UNTRIAGED('two slivers where healed openings meet')
  }
}

const PLOTTED = ['F.Mask', 'B.Mask', 'F.Paste', 'B.Paste', 'F.SilkS', 'B.SilkS', 'Edge.Cuts']

const corpus = parityBoards()
const cli = requireKicadCli()

interface KicadOutput {
  /** Gerber text by KiCad layer name. */
  gerbers: Record<string, string>
  /** Every drill file: the through holes, and one per blind or buried via span. */
  drills: string[]
}

/** KiCad's Gerbers and drill file for a board, cached under `PARITY_CACHE`. */
const kicadExport = async (boardFile: string, layers: string[]): Promise<KicadOutput> => {
  const stem = basename(boardFile, '.kicad_pcb')
  const companions = ['.kicad_pro']
    .map((extension) => join(dirname(boardFile), `${stem}${extension}`))
    .filter((file) => existsSync(file))
  const hash = createHash('sha1')
    .update(kicadCliVersion(cli))
    .update('gerbers-and-drills')
    .update(layers.join(','))
    .update(boardFile)
    .update(readFileSync(boardFile))
  for (const file of companions) hash.update(file).update(readFileSync(file))
  const key = hash.digest('hex')
  const cache = process.env.PARITY_CACHE
  const cached = cache ? join(cache, `${key}.gerbers.json`) : null
  if (cached && existsSync(cached)) return JSON.parse(readFileSync(cached, 'utf8'))
  return rememberGiveUp(key, async () => {
    const work = mkdtempSync(join(tmpdir(), 'goatcad-gerber-parity-'))
    try {
      for (const file of [boardFile, ...companions]) copyFileSync(file, join(work, basename(file)))
      const copy = join(work, basename(boardFile))
      const out = join(work, 'out')
      mkdirSync(out)
      await runKicad(cli, [
        'pcb',
        'export',
        'gerbers',
        '--subtract-soldermask',
        '--no-protel-ext',
        '-l',
        layers.join(','),
        '-o',
        out,
        copy
      ])
      await runKicad(cli, ['pcb', 'export', 'drill', '-o', out, copy])
      const output: KicadOutput = { gerbers: {}, drills: [] }
      for (const name of readdirSync(out)) {
        const text = readFileSync(join(out, name), 'utf8')
        if (name.endsWith('.drl')) output.drills.push(text)
        if (!name.endsWith('.gbr')) continue
        const fileFunction = /%TF\.FileFunction,([^*]*)\*%/.exec(text)?.[1] ?? null
        const layer = layerFromFileFunction(fileFunction).kicadLayer
        if (layer) output.gerbers[layer] = text
      }
      if (cached) {
        mkdirSync(dirname(cached), { recursive: true })
        writeFileSync(cached, JSON.stringify(output))
      }
      return output
    } finally {
      rmSync(work, { recursive: true, force: true })
    }
  })
}

const ringArea = (ring: readonly ClipPt[]): number => {
  let sum = 0
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++)
    sum += (ring[j].x + ring[i].x) * (ring[j].y - ring[i].y)
  return Math.abs(sum) / 2
}
const ringLength = (ring: readonly ClipPt[]): number => {
  let sum = 0
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++)
    sum += Math.hypot(ring[i].x - ring[j].x, ring[i].y - ring[j].y)
  return sum
}
const regionArea = (r: ClipRegion): number =>
  ringArea(r.outer) - r.holes.reduce((h, ring) => h + ringArea(ring), 0)
const regionLength = (r: ClipRegion): number =>
  [r.outer, ...r.holes].reduce((s, ring) => s + ringLength(ring), 0)

interface Piece {
  /** KiCad coordinates (mm, y down) of the piece's bounding-box center, and its size. */
  x: number
  y: number
  w: number
  h: number
  area: number
  only: 'ours' | 'kicad'
}

/** The pieces of `regions` that are more than chord noise. */
const piecesOf = (regions: ClipRegion[], only: Piece['only']): Piece[] =>
  regions.flatMap((r) => {
    const area = regionArea(r)
    if (area < MIN_PIECE_MM2 || (2 * area) / regionLength(r) < SLIVER_MM) return []
    // A loop, not Math.min(...): a fill's outline can outrun the argument limit.
    let [minX, maxX, minY, maxY] = [Infinity, -Infinity, Infinity, -Infinity]
    for (const p of r.outer) {
      minX = Math.min(minX, p.x)
      maxX = Math.max(maxX, p.x)
      minY = Math.min(minY, -p.y)
      maxY = Math.max(maxY, -p.y)
    }
    return [
      {
        x: +((minX + maxX) / 2).toFixed(3),
        y: +((minY + maxY) / 2).toFixed(3),
        w: +(maxX - minX).toFixed(3),
        h: +(maxY - minY).toFixed(3),
        area: +area.toFixed(4),
        only
      }
    ]
  })

const describeHole = (h: DrillHit): string => {
  const at = (x: number, y: number): string => `(${x.toFixed(3)}, ${(-y).toFixed(3)})`
  const what = h.slot
    ? `slot ${at(h.slot.from.x, h.slot.from.y)}–${at(h.slot.to.x, h.slot.to.y)}`
    : `hole ${at(h.x, h.y)}`
  return `${h.plated ? 'plated' : 'non-plated'}${h.via ? ' via' : ''} ${h.diameter.toFixed(3)} mm ${what}`
}

const near = (a: ClipPt, b: ClipPt): boolean =>
  Math.hypot(a.x - b.x, a.y - b.y) <= HOLE_TOLERANCE_MM

const sameHole = (a: DrillHit, b: DrillHit): boolean => {
  if (Math.abs(a.diameter - b.diameter) > HOLE_TOLERANCE_MM) return false
  if (a.plated !== b.plated || !!a.via !== !!b.via) return false
  if (!a.slot || !b.slot) return !a.slot && !b.slot && near(a, b)
  return (
    (near(a.slot.from, b.slot.from) && near(a.slot.to, b.slot.to)) ||
    (near(a.slot.from, b.slot.to) && near(a.slot.to, b.slot.from))
  )
}

/** Holes on one side with no match on the other, each described. */
const unmatchedHoles = (ours: DrillHit[], theirs: DrillHit[]): string[] => {
  const left = [...theirs]
  const extra: string[] = []
  for (const hole of ours) {
    const i = left.findIndex((other) => sameHole(hole, other))
    if (i >= 0) left.splice(i, 1)
    else extra.push(`ours only: ${describeHole(hole)}`)
  }
  return [...extra, ...left.map((hole) => `KiCad only: ${describeHole(hole)}`)]
}

interface LayerResult {
  layer: string
  area: number
  pieces: Piece[]
}

describe('fab export against KiCad', () => {
  beforeAll(async () => {
    await loadClipper()
  })

  for (const boardFile of corpus) {
    test(basename(boardFile), { timeout: 600_000 }, async (ctx) => {
      const text = readFileSync(boardFile, 'utf8')
      let board: ReturnType<typeof parseKicadBoard>
      try {
        board = parseKicadBoard(text)
      } catch (error) {
        // The corpus holds a few files the parser does not take as boards.
        return ctx.skip(`the parser rejects it: ${(error as Error).message}`)
      }
      // A development build before KiCad 6 wrote footprints as `(module …)`, which
      // the app does not open.
      if ((board.version ?? 0) < MIN_FORMAT_VERSION.kicad_pcb && /^\s*\(module /m.test(text))
        return ctx.skip('its footprints are pre-KiCad 6 (module …), which the app does not open')
      const present = new Set(board.layers.map((l) => l.name))
      const layers = [
        ...board.layers.filter((l) => l.name.endsWith('.Cu')).map((l) => l.name),
        ...PLOTTED.filter((name) => present.has(name))
      ]
      let kicad: KicadOutput
      try {
        kicad = await kicadExport(boardFile, layers)
      } catch (error) {
        if (error instanceof KicadGaveUp) return ctx.skip(error.message)
        throw error
      }

      const textVariables = settingsFor(boardFile).textVariables
      const results: LayerResult[] = []
      const missing: string[] = []
      for (const layer of layers) {
        const ours = writeGerberLayer(board, layer, {
          clipSilkToOutline: false,
          textVariables
        }).content
        const theirs = kicad.gerbers[layer]
        if (theirs === undefined) {
          missing.push(layer)
          continue
        }
        const mine = gerberRegions(parseGerber(ours))
        const kicadRegions = gerberRegions(parseGerber(theirs))
        const pieces = [
          ...piecesOf(difference(mine, kicadRegions), 'ours'),
          ...piecesOf(difference(kicadRegions, mine), 'kicad')
        ].sort((a, b) => b.area - a.area)
        results.push({
          layer,
          area: kicadRegions.reduce((s, r) => s + regionArea(r), 0),
          pieces
        })
        const dump = process.env.PARITY_DUMP
        if (dump && pieces.length > 0) {
          const dir = join(dump, basename(boardFile, '.kicad_pcb'))
          mkdirSync(dir, { recursive: true })
          const name = layer.replace(/\./g, '_')
          writeFileSync(join(dir, `${name}-ours.gbr`), ours)
          writeFileSync(join(dir, `${name}-kicad.gbr`), theirs)
        }
      }

      const holes = unmatchedHoles(
        parseExcellon(
          writeExcellon(collectDrillHits(board), {
            copperLayers: board.layers.filter((l) => l.name.endsWith('.Cu')).length
          })
        ).hits,
        kicad.drills.flatMap((drill) => parseExcellon(drill).hits)
      )

      if (process.env.PARITY_REPORT)
        writeFileSync(
          process.env.PARITY_REPORT,
          JSON.stringify({
            board: boardFile,
            layers: results.map((r) => ({ ...r, pieces: r.pieces.slice(0, 12) })),
            holes
          }) + '\n',
          { flag: 'a' }
        )

      const known = KNOWN[basename(boardFile)] ?? {}
      const summary = (r: LayerResult): string => {
        const differs = r.pieces.reduce((s, p) => s + p.area, 0)
        const worst = r.pieces
          .slice(0, 3)
          .map((p) => `${p.only} only ${p.area} mm² at (${p.x}, ${p.y})`)
          .join('; ')
        return `${r.layer}: ${r.pieces.length} pieces, ${differs.toFixed(4)} of ${r.area.toFixed(3)} mm² — ${worst}`
      }
      const off = [
        ...results.filter((r) => r.pieces.length > 0 && !known[r.layer]).map(summary),
        ...results
          .filter((r) => r.pieces.length === 0 && known[r.layer])
          .map((r) => `${r.layer} matches now; take it off the known list`),
        ...missing.map((layer) => `${layer}: KiCad wrote no Gerber for it`),
        ...(holes.length > 0 && !known.drill
          ? [`drill: ${holes.length} unmatched — ${holes.slice(0, 5).join('; ')}`]
          : []),
        ...(holes.length === 0 && known.drill
          ? ['drill matches now; take it off the known list']
          : [])
      ]
      expect(off).toEqual([])
    })
  }
})
