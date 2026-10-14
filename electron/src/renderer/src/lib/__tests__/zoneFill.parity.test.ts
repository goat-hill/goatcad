/**
 * The zone filler against KiCad's own fills, on real boards. KiCad refills
 * each board (`kicad-cli pcb drc --refill-zones --save-board`: a fill saved in
 * a file may predate its rules), then every copper zone of that board is
 * refilled by our filler exactly as the editor refills it (the board's rules,
 * `zoneFillOptions`) and compared with KiCad's fill, layer by layer: the area
 * where the two differ, divided by the length of the fill's boundary, is how
 * far our edge strays from KiCad's on average. A zone matches when that is
 * within `TOLERANCE_MM` — KiCad draws arcs as chords within its max error, so
 * a few micrometres are noise. Filling from KiCad's board, each zone meets the
 * other zones' fills as KiCad left them, so one zone's error does not spread.
 *
 * Not in the default suite and never on CI; needs KiCad (`kicadParity.ts`).
 * `PARITY_CACHE=<dir>` keeps KiCad's refilled boards; `PARITY_REPORT=<file>`
 * keeps every zone's figures and where its fill differs; `PARITY_DUMP=<dir>`
 * writes both fills of each zone that differs, as JSON (mm, y down), to draw.
 */
import { beforeAll, describe, expect, test } from 'vitest'
import { createHash } from 'crypto'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'fs'
import { tmpdir } from 'os'
import { basename, dirname, join } from 'path'
import { parseKicadBoard, type KicadBoardZone } from '../kicad/board'
import { nmToMm } from '../kicad/coordinates'
import { BoardSpatialIndex } from '../board/spatialIndex'
import { computeZoneFillSteps, zoneFillOptions } from '../board/zoneFill'
import { budgetFor, PARITY_TEST_TIMEOUT_MS } from './parityBudget'
import { boardRules } from '../board/rules/boardRules'
import { difference, loadClipper, union, type ClipPt, type ClipRegion } from '../geometry/clip'
import { customRulesOf, parityBoards, settingsFor } from './parityBoards'
import {
  KicadGaveUp,
  requireKicadCli,
  kicadCliVersion,
  rememberGiveUp,
  runKicad
} from './kicadParity'

/** Mean boundary deviation a zone may show and still match, mm. */
const TOLERANCE_MM = 0.01

const corpus = parityBoards()
const cli = requireKicadCli()

/** The board as KiCad refills it, cached under `PARITY_CACHE` by the board, its project and rules. */
const kicadRefilled = async (boardFile: string): Promise<string> => {
  const stem = basename(boardFile, '.kicad_pcb')
  const companions = ['.kicad_pro', '.kicad_dru']
    .map((extension) => join(dirname(boardFile), `${stem}${extension}`))
    .filter((file) => existsSync(file))
  const hash = createHash('sha1')
    .update(kicadCliVersion(cli))
    .update('refill')
    .update(boardFile)
    .update(readFileSync(boardFile))
  for (const file of companions) hash.update(file).update(readFileSync(file))
  const key = hash.digest('hex')
  const cache = process.env.PARITY_CACHE
  const cached = cache ? join(cache, `${key}.kicad_pcb`) : null
  if (cached && existsSync(cached)) return readFileSync(cached, 'utf8')
  return rememberGiveUp(key, () => refill(boardFile, companions, cached))
}

/** KiCad's refill of a board, kept at `cached` when there is a cache. */
const refill = async (
  boardFile: string,
  companions: string[],
  cached: string | null
): Promise<string> => {
  // KiCad saves over its input, so it refills a copy, beside its project.
  const work = mkdtempSync(join(tmpdir(), 'goatcad-fill-parity-'))
  try {
    for (const file of [boardFile, ...companions]) copyFileSync(file, join(work, basename(file)))
    const copy = join(work, basename(boardFile))
    await runKicad(cli, [
      'pcb',
      'drc',
      '--refill-zones',
      '--save-board',
      '-o',
      join(work, 'drc.json'),
      copy
    ])
    const text = readFileSync(copy, 'utf8')
    if (cached) {
      mkdirSync(dirname(cached), { recursive: true })
      writeFileSync(cached, text)
    }
    return text
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
}

const ringArea = (ring: readonly ClipPt[]): number => {
  let sum = 0
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++)
    sum += (ring[j].x + ring[i].x) * (ring[j].y - ring[i].y)
  return Math.abs(sum) / 2
}
const regionArea = (regions: readonly ClipRegion[]): number =>
  regions.reduce(
    (total, r) => total + ringArea(r.outer) - r.holes.reduce((h, ring) => h + ringArea(ring), 0),
    0
  )
const ringLength = (ring: readonly ClipPt[]): number => {
  let sum = 0
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++)
    sum += Math.hypot(ring[i].x - ring[j].x, ring[i].y - ring[j].y)
  return sum
}
const perimeter = (regions: readonly ClipRegion[]): number =>
  regions.reduce(
    (total, r) => total + [r.outer, ...r.holes].reduce((s, ring) => s + ringLength(ring), 0),
    0
  )

/** Stored or computed polygons (nm, y down) as one normalized region set (mm, y up). */
const regionsOf = (polys: ReadonlyArray<ReadonlyArray<{ x: number; y: number }>>): ClipRegion[] =>
  polys.length === 0
    ? []
    : union(
        polys.map((points) => ({
          outer: points.map((p) => ({ x: nmToMm(p.x as never), y: -nmToMm(p.y as never) })),
          holes: []
        })),
        []
      )

interface ZoneResult {
  zone: string
  layer: string
  area: number
  /** Area where the fills differ, mm². */
  differs: number
  /** Mean boundary deviation, mm. */
  deviation: number
  /** The largest pieces where the fills differ: KiCad coordinates (mm, y down), area, whose copper. */
  pieces: Array<{
    x: number
    y: number
    w: number
    h: number
    area: number
    only: 'ours' | 'kicad'
  }>
}

/** Where the difference lies: its biggest pieces, each by its bounding box. */
const piecesOf = (regions: ClipRegion[], only: 'ours' | 'kicad'): ZoneResult['pieces'] =>
  regions.map((r) => {
    const xs = r.outer.map((p) => p.x)
    const ys = r.outer.map((p) => -p.y)
    const [minX, maxX, minY, maxY] = [
      Math.min(...xs),
      Math.max(...xs),
      Math.min(...ys),
      Math.max(...ys)
    ]
    return {
      x: +((minX + maxX) / 2).toFixed(3),
      y: +((minY + maxY) / 2).toFixed(3),
      w: +(maxX - minX).toFixed(3),
      h: +(maxY - minY).toFixed(3),
      area: +regionArea([r]).toFixed(4),
      only
    }
  })

const zoneName = (zone: KicadBoardZone): string =>
  `${zone.name ? `'${zone.name}' ` : ''}${zone.netName || 'no net'} ${zone.uuid ?? ''}`.trim()

describe('zone fills against KiCad', () => {
  beforeAll(async () => {
    await loadClipper()
  })

  for (const boardFile of corpus) {
    test(basename(boardFile), { timeout: PARITY_TEST_TIMEOUT_MS }, async (ctx) => {
      let text: string
      try {
        text = await kicadRefilled(boardFile)
      } catch (error) {
        if (error instanceof KicadGaveUp) return ctx.skip(error.message)
        throw error
      }
      // The budget starts once kicad-cli has refilled the board: it bounds our side.
      const budget = budgetFor('fill', boardFile)
      const board = parseKicadBoard(text)
      const index = BoardSpatialIndex.build(board)
      const rules = boardRules(board, settingsFor(boardFile), customRulesOf(boardFile))
      const results: ZoneResult[] = []
      for (const zone of board.zones) {
        if (zone.isKeepout || zone.points.length < 3 || zone.filledPolys.length === 0) continue
        const ours = budget.drain(
          computeZoneFillSteps(board, index, zone, zoneFillOptions(rules, zone)),
          () => `filling zone ${zone.name || zone.netName || zone.uuid}`
        )
        const layers = new Set([
          ...zone.filledPolys.map((p) => p.layer ?? zone.layers[0]),
          ...ours.map((f) => f.layer)
        ])
        for (const layer of layers) {
          const theirs = regionsOf(
            zone.filledPolys
              .filter((p) => (p.layer ?? zone.layers[0]) === layer)
              .map((p) => p.points)
          )
          const mine = regionsOf(ours.filter((f) => f.layer === layer).flatMap((f) => f.polys))
          const oursOnly = difference(mine, theirs)
          const dump = process.env.PARITY_DUMP
          const kicadOnly = difference(theirs, mine)
          const differs = regionArea(oursOnly) + regionArea(kicadOnly)
          const edge = Math.max(perimeter(theirs), perimeter(mine), 1e-9)
          results.push({
            zone: zoneName(zone),
            layer,
            area: regionArea(theirs),
            differs,
            deviation: differs / edge,
            pieces: [...piecesOf(oursOnly, 'ours'), ...piecesOf(kicadOnly, 'kicad')]
              .sort((a, b) => b.area - a.area)
              .slice(0, 12)
          })
          if (dump && differs / edge > TOLERANCE_MM) {
            const yDown = (regions: ClipRegion[]): number[][][][] =>
              regions.map((r) => [r.outer, ...r.holes].map((ring) => ring.map((p) => [p.x, -p.y])))
            mkdirSync(dump, { recursive: true })
            writeFileSync(
              join(
                dump,
                `${basename(boardFile, '.kicad_pcb')}-${zone.uuid?.slice(0, 8)}-${layer}.json`
              ),
              JSON.stringify({ ours: yDown(mine), kicad: yDown(theirs) })
            )
          }
        }
      }
      if (process.env.PARITY_REPORT)
        writeFileSync(
          process.env.PARITY_REPORT,
          JSON.stringify({ board: boardFile, results }) + '\n',
          { flag: 'a' }
        )
      const off = results
        .filter((r) => r.deviation > TOLERANCE_MM)
        .sort((a, b) => b.deviation - a.deviation)
        .map(
          (r) =>
            `${r.zone} on ${r.layer}: ${(r.deviation * 1000).toFixed(1)} µm off on average, ${r.differs.toFixed(3)} of ${r.area.toFixed(3)} mm²`
        )
      expect(off).toEqual([])
    })
  }
})
