/**
 * Holds incremental board checks to the whole run (`drc/incremental.ts`):
 * seeded edits, made as a session makes them — the AST mutated, the board
 * remapped, the index rebuilt from the last — each checked round the edit and
 * checked whole, and the two compared. Shared by the default suite (the sample
 * project) and the parity suite (KiCad's corpus).
 */
import {
  addSegmentToBoardAST,
  addViaToBoardAST,
  moveBoardFootprintInAST,
  parseKicadBoard,
  remapKicadBoard,
  removeBoardNodeFromAST,
  setZoneFilledPolysInAST,
  type KicadBoard
} from '../../kicad/board'
import type { SExprList, SExprNode } from '../../kicad/sexpr'
import type { BoardDesignSettings } from '../../kicad/project'
import { mmToNm, nm, type Nm } from '../../kicad/coordinates'
import { isCopperLayer } from '../../kicad/layers'
import type { CheckResult } from '../../schematic/checks'
import { BoardSpatialIndex } from '../spatialIndex'
import { computeConnectivity } from '../boardConnectivity'
import { boardCheckRun } from '../boardChecks'
import type { BoardCheckRun } from '../drc/incremental'

/** A small seeded generator (mulberry32), so a failing edit can be replayed. */
const random = (seed: number): (() => number) => {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Drains a stepped run; `budget`, from a parity suite, bounds it (`parityBudget.ts`). */
export interface StepBudget {
  check(where: () => string): void
  drain<T>(steps: Generator<unknown, T>, where: () => string): T
}

const UNBOUNDED: StepBudget = {
  check: () => {},
  drain: (steps) => {
    let step = steps.next()
    while (!step.done) step = steps.next()
    return step.value
  }
}

/** A finding as the comparison reads it: all it says. */
const keyOf = (r: CheckResult): string =>
  [
    r.code,
    r.severity,
    r.items.join(','),
    r.message,
    r.position?.x,
    r.position?.y,
    !!r.excluded
  ].join('|')

/** An edit: what it did, and the top-level AST nodes it changed, as a command reports them. */
interface Edit {
  label: string
  raws: Set<SExprNode>
}

const root = (board: KicadBoard): SExprList => board._raw as SExprList
const lastChild = (board: KicadBoard): SExprNode =>
  root(board).children[root(board).children.length - 1]

/** One seeded edit, or null where the board offers nothing for it. */
function edit(board: KicadBoard, rand: () => number): Edit | null {
  const pick = <T>(list: readonly T[]): T | undefined =>
    list.length ? list[Math.floor(rand() * list.length)] : undefined
  const shift = (): Nm => mmToNm((rand() - 0.5) * 4)
  const kind = Math.floor(rand() * 7)
  switch (kind) {
    case 0: {
      const bfp = pick(board.footprints)
      if (!bfp) return null
      moveBoardFootprintInAST(bfp, nm(bfp.position.x + shift()), nm(bfp.position.y + shift()))
      return { label: `move ${bfp.reference || 'footprint'}`, raws: new Set([bfp._raw]) }
    }
    case 1: {
      const seg = pick(board.segments)
      if (!seg) return null
      removeBoardNodeFromAST(board, seg._raw)
      return { label: `delete track ${seg.uuid ?? ''}`, raws: new Set([seg._raw]) }
    }
    case 2: {
      // A track from a pad's center, on one of its copper layers, with its net.
      const bfp = pick(board.footprints.filter((f) => f.footprint.pads.length))
      const pad = bfp && pick(bfp.footprint.pads)
      if (!bfp || !pad) return null
      const layer = pad.layers.find(isCopperLayer) ?? (pad.layers.includes('*.Cu') ? 'F.Cu' : null)
      if (!layer) return null
      const angle = ((bfp.position.angle ?? 0) * Math.PI) / 180
      const cx =
        bfp.position.x + pad.position.x * Math.cos(angle) + pad.position.y * Math.sin(angle)
      const cy =
        bfp.position.y - pad.position.x * Math.sin(angle) + pad.position.y * Math.cos(angle)
      const start = { x: nm(Math.round(cx)), y: nm(Math.round(cy)) }
      const end = { x: nm(start.x + shift()), y: nm(start.y + shift()) }
      addSegmentToBoardAST(board, {
        start,
        end,
        width: mmToNm(0.2),
        layer,
        net: pad.net?.number ?? 0
      })
      return {
        label: `add track at ${bfp.reference}.${pad.number}`,
        raws: new Set([lastChild(board)])
      }
    }
    case 3: {
      const via = pick(board.vias)
      if (!via) return null
      removeBoardNodeFromAST(board, via._raw)
      addViaToBoardAST(board, {
        position: { x: nm(via.position.x + shift()), y: nm(via.position.y + shift()) },
        size: via.size,
        drill: via.drill,
        layers: [...via.layers],
        net: via.net
      })
      return { label: `move via ${via.uuid ?? ''}`, raws: new Set([via._raw, lastChild(board)]) }
    }
    case 4: {
      // A refill that changed a zone: one island gone, as a refill round an edit drops one.
      const zone = pick(board.zones.filter((z) => !z.isKeepout && z.filledPolys.length > 0))
      if (!zone) return null
      const drop = Math.floor(rand() * zone.filledPolys.length)
      setZoneFilledPolysInAST(
        zone,
        zone.filledPolys
          .filter((_, i) => i !== drop)
          .map((p) => ({ layer: p.layer ?? zone.layers[0], points: p.points }))
      )
      return {
        label: `refill ${zone.uuid ?? 'zone'} less island ${drop}`,
        raws: new Set([zone._raw])
      }
    }
    case 5: {
      const bfp = pick(board.footprints)
      if (!bfp) return null
      removeBoardNodeFromAST(board, bfp._raw)
      return { label: `delete ${bfp.reference || 'footprint'}`, raws: new Set([bfp._raw]) }
    }
    default: {
      const via = pick(board.vias)
      if (!via) return null
      removeBoardNodeFromAST(board, via._raw)
      return { label: `delete via ${via.uuid ?? ''}`, raws: new Set([via._raw]) }
    }
  }
}

export interface EditMismatch {
  step: number
  edit: string
  /** Findings the incremental run lacks. */
  missing: string[]
  /** Findings only the incremental run has. */
  extra: string[]
}

/**
 * Edit a board `count` times from `seed`, checking round the edits after every
 * `perCheck` of them — several commands folded into one edit, as the editor
 * folds a move and its refill — against a whole run of the edited board.
 */
export function incrementalMismatches(
  text: string,
  settings: BoardDesignSettings,
  customRules: string | undefined,
  seed: number,
  count: number,
  perCheck = 1,
  budget: StepBudget = UNBOUNDED
): EditMismatch[] {
  const rand = random(seed)
  let board = parseKicadBoard(text)
  let index = BoardSpatialIndex.build(board)
  const inputOf = (b: KicadBoard, i: BoardSpatialIndex): Parameters<typeof boardCheckRun>[0] => ({
    board: b,
    index: i,
    connectivity: computeConnectivity(b, i),
    settings,
    customRules
  })
  let where = 'checking the board before any edit'
  const drain = <T>(steps: Generator<void, T>): T => budget.drain(steps, () => where)
  let run: BoardCheckRun = drain(boardCheckRun(inputOf(board, index)))
  const out: EditMismatch[] = []
  for (let step = 0; step < count; step++) {
    const before = board
    const beforeIndex = index
    const raws = new Set<SExprNode>()
    const labels: string[] = []
    for (let k = 0; k < perCheck; k++) {
      const prev = board
      const one = edit(board, rand)
      if (!one) continue
      labels.push(one.label)
      for (const raw of one.raws) raws.add(raw)
      board = remapKicadBoard(prev)
      index = BoardSpatialIndex.buildFrom(index, prev, board, one.raws)
    }
    if (labels.length === 0) continue
    const change = { label: labels.join(', '), raws }
    where = `at edit ${step + 1} of ${count} (${change.label})`
    budget.check(() => where)
    const input = inputOf(board, index)
    const incremental = drain(
      boardCheckRun(input, {
        run,
        edit: { fromBoard: before, fromIndex: beforeIndex, raws: change.raws }
      })
    )
    const whole = drain(boardCheckRun(input))
    const got = new Set(incremental.results.map(keyOf))
    const want = new Set(whole.results.map(keyOf))
    const missing = [...want].filter((k) => !got.has(k))
    const extra = [...got].filter((k) => !want.has(k))
    if (missing.length || extra.length) out.push({ step, edit: change.label, missing, extra })
    run = incremental
  }
  return out
}
