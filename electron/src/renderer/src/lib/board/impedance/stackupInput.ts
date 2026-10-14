/**
 * The stackup as the impedance solver reads it: copper and dielectric front to
 * back, each dielectric sublayer its own row. A board's own `(stackup …)` is
 * read as KiCad's parser reads it (a dielectric's first sublayer defaults to
 * FR-4's 4.5 and 0.02, an added one to 1.0 and 0); a board without one gets
 * KiCad's default build (`BOARD_STACKUP::BuildDefaultStackupList`, through
 * `BOARD::GetStackupOrDefault`), which is what KiCad's tuning-profile page
 * solves against. Thicknesses are whole nanometers in millimeters, as KiCad's
 * internal units are, so the solver's arithmetic matches KiCad's.
 */
import type { KicadBoard, KicadStackupLayer } from '../../kicad/board'
import { mmAtomToNm } from '../../kicad/coordinates'
import { COPPER_LAYERS, isCopperLayer } from '../../kicad/layers'
import { getToken, type SExprNode } from '../../kicad/sexpr'

export interface SolverStackupLayer {
  kind: 'copper' | 'dielectric'
  /** A copper layer's KiCad name (F.Cu, In1.Cu); a dielectric's own ("dielectric 1"). */
  name: string
  thicknessMm: number
  /** A dielectric's; copper carries 1 and 0, which nothing reads. */
  epsilonR: number
  lossTangent: number
}

export type SolverStackup = readonly SolverStackupLayer[]

/** KiCad's defaults: 35 µm copper, 10 µm mask, FR-4 at 4.5 and 0.02, a 1.6 mm board. */
const COPPER_NM = 35000
const MASK_NM = 10000
const BOARD_NM = 1600000
const FR4 = { epsilonR: 4.5, lossTangent: 0.02 }

const nmToMm = (nm: number): number => nm / 1e6

export function solverStackupOf(board: KicadBoard): SolverStackup {
  return board.stackup ? fromStackup(board.stackup.layers) : defaultStackup(board)
}

function fromStackup(layers: readonly KicadStackupLayer[]): SolverStackup {
  return layers.flatMap((layer): SolverStackupLayer[] => {
    if (isCopperLayer(layer.name))
      return [
        {
          kind: 'copper',
          name: layer.name,
          thicknessMm: nmToMm(layer.thickness ?? COPPER_NM),
          epsilonR: 1,
          lossTangent: 0
        }
      ]
    if (!layer.name.startsWith('dielectric')) return []
    return sublayersOf(layer._raw).map((sub) => ({ kind: 'dielectric', name: layer.name, ...sub }))
  })
}

/** A dielectric's sublayers: its own values, then each run after an `addsublayer`. */
function sublayersOf(raw: SExprNode): Array<Omit<SolverStackupLayer, 'kind' | 'name'>> {
  if (raw.type !== 'list') return []
  const subs: Array<{ thicknessNm: number; epsilonR: number; lossTangent: number }> = [
    { thicknessNm: 0, ...FR4 }
  ]
  for (const child of raw.children.slice(2)) {
    if (child.type === 'atom') {
      if (child.value === 'addsublayer')
        subs.push({ thicknessNm: 0, epsilonR: 1.0, lossTangent: 0.0 })
      continue
    }
    const value = child.children[1]
    if (!value || value.type !== 'atom') continue
    const sub = subs[subs.length - 1]
    const token = getToken(child)
    if (token === 'thickness') sub.thicknessNm = mmAtomToNm(value.value)
    else if (token === 'epsilon_r') sub.epsilonR = parseFloat(value.value)
    else if (token === 'loss_tangent') sub.lossTangent = parseFloat(value.value)
  }
  return subs.map((s) => ({
    thicknessMm: nmToMm(s.thicknessNm),
    epsilonR: s.epsilonR,
    lossTangent: s.lossTangent
  }))
}

/**
 * KiCad's default build for a board with no stackup: its copper at 35 µm and
 * the rest of the board's thickness, less 10 µm per enabled mask, shared
 * evenly (in whole nanometers) among FR-4 dielectrics.
 */
function defaultStackup(board: KicadBoard): SolverStackup {
  const names = new Set(board.layers.map((l) => l.name))
  const copper = COPPER_LAYERS.filter((name) => names.has(name))
  const masks = ['F.Mask', 'B.Mask'].filter((name) => names.has(name)).length
  const total = board.thickness ?? BOARD_NM
  const dielectric = Math.trunc(
    (total - COPPER_NM * copper.length - MASK_NM * masks) / Math.max(1, copper.length - 1)
  )
  return copper.flatMap((name, i): SolverStackupLayer[] => [
    { kind: 'copper', name, thicknessMm: nmToMm(COPPER_NM), epsilonR: 1, lossTangent: 0 },
    ...(i < copper.length - 1
      ? [
          {
            kind: 'dielectric' as const,
            name: `dielectric ${i + 1}`,
            thicknessMm: nmToMm(dielectric),
            ...FR4
          }
        ]
      : [])
  ])
}
