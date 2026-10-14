/**
 * A land pattern from a package drawing: the IPC sizing standards' pad math
 * for the standard lead types, answering with a pad table the footprint write
 * takes as it is.
 *
 * Pure and
 * read-only; it never draws, and the footprint write never computes a pad, so
 * every pad the agent passes on is one it saw. Surface-mount leads take
 * IPC-7351B's fillet goals, transcribed, and its formulas:
 *
 *   Zmax = Lmin + 2·Jtoe  + √(Cl² + F² + P²)   outer pad edge to outer pad edge
 *   Gmin = Smax − 2·Jheel − √(Cs² + F² + P²)   inner edge to inner edge
 *   Xmax = Wmin + 2·Jside + √(Cw² + F² + P²)   pad width
 *
 * S, the lead-to-lead inner span, is L − 2T, with its tolerance taken as the
 * root sum of squares √(Cl² + 2·Ct²) and its maximum moved in by half the
 * difference that makes against the worst case.
 *
 * A grid array's land is IPC-7352's ratio of the ball; a through-hole lead's
 * hole and land are IPC-2222's and IPC-2221's allowances over the lead.
 */
import type { FootprintDensity } from './footprintStyle'
import type { PadSpec } from './footprintGenerate'

/** A dimension as a drawing prints it: nominal ± tolerance, or min and max. */
export type Tol = { nominal: number; tolerance?: number } | { min: number; max: number }

export type LeadType = 'gullwing' | 'flat' | 'no_lead' | 'j_lead' | 'chip' | 'through_hole' | 'grid'
type SurfaceLeadType = Exclude<LeadType, 'through_hole' | 'grid'>
export type BallType = 'collapsible' | 'non_collapsible'

export interface LandPatternInput {
  leadType: LeadType
  density: FootprintDensity
  /** body.x across the left and right sides; for a chip, its length. */
  body: { x: Tol; y: Tol }
  /** Lead tip to lead tip, for leads that reach past the body. */
  span?: { x?: Tol; y?: Tol }
  /** A chip's lead width defaults to its body width. A through-hole lead is a
   *  `diameter`, or a `width` and a `thickness`; it has no `length`. */
  lead?: { width?: Tol; length?: Tol; thickness?: Tol; diameter?: Tol }
  pitch?: number
  /** Pins on each side: `y` in each of the left and right columns, `x` in each
   *  of the top and bottom rows. A grid is `x` columns by `y` rows. */
  pins?: { x?: number; y?: number }
  exposedPad?: { x: number; y: number }
  /** Through-hole: lead center to lead center across two columns; one column without it. */
  rowSpacing?: number
  /** Through-hole, two columns: around the part, or across it as a header counts. */
  numbering?: 'ccw' | 'zigzag'
  ball?: { diameter: Tol; type?: BallType }
  /** Grid positions with no ball: `A1`, or a block as `E5:K11`. */
  skip?: string[]
}

interface Fillets {
  toe: number
  heel: number
  side: number
}

interface FilletTable {
  name: string
  round: number
  levels: Record<FootprintDensity, Fillets>
}

const table = (
  name: string,
  round: number,
  least: [number, number, number],
  nominal: [number, number, number],
  most: [number, number, number]
): FilletTable => {
  const level = ([toe, heel, side]: [number, number, number]): Fillets => ({ toe, heel, side })
  return {
    name,
    round,
    levels: { least: level(least), nominal: level(nominal), most: level(most) }
  }
}

// IPC-7351B, [toe, heel, side] at least / nominal / most density.
const GULLWING_WIDE = table(
  'IPC-7351B Table 3-2, gull-wing leads, pitch above 0.625 mm',
  0.05,
  [0.15, 0.25, 0.01],
  [0.35, 0.35, 0.03],
  [0.55, 0.45, 0.05]
)
const GULLWING_FINE = table(
  'IPC-7351B Table 3-3, gull-wing leads, pitch 0.625 mm or less',
  0.05,
  [0.15, 0.25, -0.04],
  [0.35, 0.35, -0.02],
  [0.55, 0.45, 0.01]
)
const J_LEAD = table(
  'IPC-7351B Table 3-4, J leads',
  0.05,
  [-0.1, 0.15, 0.01],
  [0, 0.35, 0.03],
  [0.1, 0.55, 0.05]
)
const NO_LEAD = table(
  'IPC-7351B Table 3-15, flat no-lead (QFN, DFN) with toe fillet',
  0.05,
  [0.2, 0, -0.04],
  [0.3, 0, -0.04],
  [0.4, 0, -0.04]
)
const FLAT_LEAD = table(
  'IPC-7352 Table 3-15, flat leads with toe fillet',
  0.05,
  [0.1, 0, 0],
  [0.2, 0, 0],
  [0.3, 0, 0.05]
)
const CHIP_SMALL = table(
  'IPC-7351B chip components smaller than 0603 (1608 metric)',
  0.02,
  [0.1, 0, -0.05],
  [0.2, 0, 0],
  [0.3, 0, 0.05]
)
const CHIP = table(
  'IPC-7351B chip components 0603 (1608 metric) and larger',
  0.05,
  [0.15, 0, -0.05],
  [0.35, 0, 0],
  [0.55, 0, 0.05]
)

/** IPC-7352 Table 3-11: a ball's land as a ratio over its nominal diameter. */
const BALL_LAND: Record<FootprintDensity, Record<BallType, number>> = {
  least: { collapsible: -0.25, non_collapsible: 0.05 },
  nominal: { collapsible: -0.2, non_collapsible: 0.1 },
  most: { collapsible: -0.15, non_collapsible: 0.15 }
}
const BALL_LAND_ROUND = 0.01
/** JEDEC row letters: no I, O, Q, S, X or Z. */
const GRID_ROW_LETTERS = 'ABCDEFGHJKLMNPRTUVWY'

/** IPC's producibility level for each density: A is the roomiest. */
const IPC_LEVEL: Record<FootprintDensity, 'A' | 'B' | 'C'> = { most: 'A', nominal: 'B', least: 'C' }
/** IPC-2222: the finished hole over the maximum lead (its diagonal, when rectangular). */
const HOLE_CLEARANCE: Record<FootprintDensity, number> = { most: 0.25, nominal: 0.2, least: 0.15 }
/** IPC-2221: land = hole + 2 × the minimum annular ring + the fabrication allowance. */
const ANNULAR_RING_MIN = 0.05
const FABRICATION_ALLOWANCE: Record<FootprintDensity, number> = {
  most: 0.6,
  nominal: 0.5,
  least: 0.4
}
const HOLE_ROUND = 0.05
/** KLC F7.5: the ring a through-hole pad keeps. */
export const ANNULAR_RING_KLC = 0.15

/** Fabrication and placement tolerance, IPC-7351B's defaults. */
export const FAB_TOLERANCE = 0.05
export const PLACEMENT_TOLERANCE = 0.025
/** An exposed pad keeps this from the signal pads. */
export const EXPOSED_PAD_CLEARANCE = 0.2
/** Neighboring pads keep at least this between them. */
export const PAD_GAP_MIN = 0.2
/** The body length below which a chip is "smaller than 0603". */
const CHIP_SMALL_BELOW = 1.5

interface Range {
  min: number
  max: number
  /** The tolerance the formulas use: the worst case, or a root sum of squares. */
  tol: number
  /** `max` moved in by half of what the root sum saves over the worst case. */
  maxRms: number
}

export const range = (value: Tol): Range => {
  const [min, max] =
    'min' in value
      ? [value.min, value.max]
      : [value.nominal - (value.tolerance ?? 0), value.nominal + (value.tolerance ?? 0)]
  return { min, max, tol: max - min, maxRms: max }
}

const nominalOf = (value: Tol): number =>
  'min' in value ? (value.min + value.max) / 2 : value.nominal

/** S = L − 2T, with its tolerance as the root sum of squares. */
const innerSpan = (outer: Range, length: Range): Range => {
  const min = outer.min - 2 * length.max
  const max = outer.max - 2 * length.min
  const worst = max - min
  const tol = Math.sqrt(outer.tol ** 2 + 2 * length.tol ** 2)
  return { min, max, tol, maxRms: max - (worst - tol) / 2 }
}

const rss = (tol: number): number =>
  Math.sqrt(tol ** 2 + FAB_TOLERANCE ** 2 + PLACEMENT_TOLERANCE ** 2)

/** Round to the table's base, away from floating-point noise. */
const roundTo = (value: number, base: number): number => {
  const steps = Math.round(Number((value / base).toFixed(6)))
  return Number((steps * base).toFixed(6))
}

/** Round up to the base: a hole rounded down would not clear its lead. */
const roundUp = (value: number, base: number): number => {
  const steps = Math.ceil(Number((value / base).toFixed(6)))
  return Number((steps * base).toFixed(6))
}

const mm = (value: number): number => Number(value.toFixed(6))

export interface AxisResult {
  Z: number
  G: number
  X: number
  /** One pad's length along the axis and its center's distance from the origin. */
  padLength: number
  center: number
  notes: string[]
}

export interface HoleResult {
  /** The largest the lead gets: its diameter, or its diagonal. */
  leadMax: number
  clearance: number
  /** The finished hole, rounded up. */
  diameter: number
  /** The land before any cut: hole + 2 × ring + allowance. */
  land: number
  allowance: number
}

export interface BallResult {
  diameter: number
  type: BallType
  ratio: number
  land: number
  populated: number
}

export type LandPatternResult =
  | {
      ok: true
      pads: PadSpec[]
      body: { rect: { x: number; y: number; width: number; height: number } }
      notes: {
        density: FootprintDensity
        table: string
        fillets?: Fillets
        x?: AxisResult
        y?: AxisResult
        hole?: HoleResult
        ball?: BallResult
        adjustments: string[]
      }
    }
  | { ok: false; error: 'bad-package'; detail: string }

const refuse = (detail: string): LandPatternResult => ({ ok: false, error: 'bad-package', detail })

const pickTable = (input: LandPatternInput, leadType: SurfaceLeadType): FilletTable => {
  switch (leadType) {
    case 'gullwing':
      return (input.pitch ?? 0) > 0.625 ? GULLWING_WIDE : GULLWING_FINE
    case 'j_lead':
      return J_LEAD
    case 'no_lead':
      return NO_LEAD
    case 'flat':
      return FLAT_LEAD
    case 'chip':
      return nominalOf(input.body.x) < CHIP_SMALL_BELOW ? CHIP_SMALL : CHIP
  }
}

/** One pair of opposite sides, along the axis `outer` spans. */
const axis = (
  outer: Range,
  length: Range,
  width: Range,
  fillets: Fillets,
  base: number,
  pitch: number | undefined,
  exposedHalf: number | undefined
): AxisResult => {
  const notes: string[] = []
  const inner = innerSpan(outer, length)
  const Z = roundTo(outer.min + 2 * fillets.toe + rss(outer.tol), base)
  let G = roundTo(inner.maxRms - 2 * fillets.heel - rss(inner.tol), base)
  let X = roundTo(width.min + 2 * fillets.side + rss(width.tol), base)
  if (exposedHalf !== undefined && G / 2 < exposedHalf + EXPOSED_PAD_CLEARANCE) {
    G = mm(2 * (exposedHalf + EXPOSED_PAD_CLEARANCE))
    notes.push(
      `Inner pad edges pulled back to ${mm(G / 2)} mm to keep ${EXPOSED_PAD_CLEARANCE} mm from the exposed pad.`
    )
  }
  if (pitch !== undefined && X > pitch - PAD_GAP_MIN) {
    notes.push(
      `Pad width ${X} mm cut to ${mm(pitch - PAD_GAP_MIN)} mm to keep ${PAD_GAP_MIN} mm between pads at ${pitch} mm pitch.`
    )
    X = mm(pitch - PAD_GAP_MIN)
  }
  return {
    Z,
    G,
    X,
    padLength: mm((Z - G) / 2),
    center: mm((Z + G) / 4),
    notes
  }
}

type BodyRect = { rect: { x: number; y: number; width: number; height: number } }

/** The nominal body, centered on a point. */
const bodyAround = (input: LandPatternInput, center: { x: number; y: number }): BodyRect => {
  const w = nominalOf(input.body.x)
  const h = nominalOf(input.body.y)
  return {
    rect: { x: mm(center.x - w / 2), y: mm(center.y - h / 2), width: mm(w), height: mm(h) }
  }
}

/**
 * Through-hole pins in one column or two, pin 1 at the origin as KiCad anchors
 * a through-hole part. Positions are the drawing's; only the hole and the land
 * are computed.
 */
const throughHole = (input: LandPatternInput): LandPatternResult => {
  const lead = input.lead
  const leadMax = lead?.diameter
    ? range(lead.diameter).max
    : lead?.width && lead.thickness
      ? Math.hypot(range(lead.width).max, range(lead.thickness).max)
      : null
  if (leadMax === null) {
    return refuse(
      'A through-hole lead is lead.diameter when round, or lead.width and lead.thickness when rectangular (a square pin passes both).'
    )
  }
  const pitch = input.pitch
  if (!pitch || pitch <= 0) return refuse('pitch is required and must be positive.')
  const count = input.pins?.y ?? 0
  if (count < 1 || input.pins?.x) {
    return refuse(
      'A through-hole part counts pins.y, the pins in each column, and takes no pins.x.'
    )
  }
  const rowSpacing = input.rowSpacing
  if (rowSpacing !== undefined && rowSpacing <= 0) return refuse('rowSpacing must be positive.')

  const clearance = HOLE_CLEARANCE[input.density]
  const allowance = FABRICATION_ALLOWANCE[input.density]
  const hole = roundUp(leadMax + clearance, HOLE_ROUND)
  const land = roundUp(hole + 2 * ANNULAR_RING_MIN + allowance, HOLE_ROUND)

  const adjustments: string[] = []
  const fit = (room: number | undefined, between: string): number | null => {
    if (room === undefined || land <= room - PAD_GAP_MIN) return land
    const cut = mm(room - PAD_GAP_MIN)
    if (cut <= hole) return null
    const ring = mm((cut - hole) / 2)
    adjustments.push(
      `Land ${land} mm cut to ${cut} mm ${between} to keep ${PAD_GAP_MIN} mm between pads` +
        (ring < ANNULAR_RING_KLC
          ? `; the ${ring} mm ring that leaves is under KLC's ${ANNULAR_RING_KLC} mm, so check it against the fab's minimum.`
          : '.')
    )
    return cut
  }
  const h = fit(pitch, `along the ${pitch} mm pitch`)
  const w = fit(rowSpacing, `across the ${rowSpacing} mm row spacing`)
  if (h === null || w === null) {
    return refuse(
      `A ${hole} mm hole for a ${mm(leadMax)} mm lead leaves no pad at this pitch or row spacing; check the lead size and the spacing against the drawing.`
    )
  }

  const pads: PadSpec[] = []
  const run = (
    first: number,
    at: { x: number; y: number },
    pins: number,
    dy: number,
    numberStep: number
  ): void => {
    if (pins < 1) return
    pads.push({
      number: String(first),
      type: 'thru_hole',
      shape: first === 1 ? 'roundrect' : w === h ? 'circle' : 'oval',
      at: { x: mm(at.x), y: mm(at.y) },
      size: { width: w, height: h },
      drill: { diameter: hole },
      ...(pins > 1
        ? { array: { count: pins, dx: 0, dy, ...(numberStep > 1 ? { numberStep } : {}) } }
        : {})
    })
  }
  const zigzag = rowSpacing !== undefined && input.numbering === 'zigzag'
  const step = zigzag ? 2 : 1
  const bottom = (count - 1) * pitch
  // Pin 1 alone, since its shape marks it; the rest of its column below it.
  run(1, { x: 0, y: 0 }, 1, 0, 1)
  run(1 + step, { x: 0, y: pitch }, count - 1, pitch, step)
  if (rowSpacing !== undefined) {
    if (zigzag) run(2, { x: rowSpacing, y: 0 }, count, pitch, 2)
    else run(count + 1, { x: rowSpacing, y: bottom }, count, -pitch, 1)
  }

  return {
    ok: true,
    pads,
    body: bodyAround(input, { x: (rowSpacing ?? 0) / 2, y: bottom / 2 }),
    notes: {
      density: input.density,
      table: `IPC-2222 hole over the maximum lead and IPC-2221 land over the hole, level ${IPC_LEVEL[input.density]}`,
      hole: { leadMax: mm(leadMax), clearance, diameter: hole, land, allowance },
      adjustments
    }
  }
}

/** A grid row's JEDEC name: A to Y, then AA, AB and on. */
const gridRowName = (row: number): string => {
  const letters = GRID_ROW_LETTERS.length
  return row < letters
    ? GRID_ROW_LETTERS[row]
    : GRID_ROW_LETTERS[Math.floor(row / letters) - 1] + GRID_ROW_LETTERS[row % letters]
}

/** Every position a `skip` list names, as `row,column` keys, or the name that fits no position. */
const skippedPositions = (
  skip: string[],
  rowNames: string[],
  columns: number
): { ok: true; keys: Set<string> } | { ok: false; name: string } => {
  const keys = new Set<string>()
  const position = (name: string): { row: number; column: number } | null => {
    const [, letters = '', digits = ''] = /^([A-Za-z]+)(\d+)$/.exec(name.trim()) ?? []
    const row = rowNames.indexOf(letters.toUpperCase())
    const column = Number(digits) - 1
    return row >= 0 && column >= 0 && column < columns ? { row, column } : null
  }
  for (const entry of skip) {
    const [from, to = from] = entry.split(':')
    const a = position(from)
    const b = position(to)
    if (!a || !b) return { ok: false, name: entry }
    for (let row = Math.min(a.row, b.row); row <= Math.max(a.row, b.row); row++) {
      for (
        let column = Math.min(a.column, b.column);
        column <= Math.max(a.column, b.column);
        column++
      ) {
        keys.add(`${row},${column}`)
      }
    }
  }
  return { ok: true, keys }
}

/**
 * A ball or land grid centered on the body, JEDEC-named: A1 at the top left,
 * rows lettered down, columns numbered across. Each unbroken run of a row is
 * one array.
 */
const gridArray = (input: LandPatternInput): LandPatternResult => {
  if (!input.ball) return refuse('ball.diameter is required for a grid.')
  const pitch = input.pitch
  if (!pitch || pitch <= 0) return refuse('pitch is required and must be positive.')
  const columns = input.pins?.x ?? 0
  const rows = input.pins?.y ?? 0
  if (columns < 1 || rows < 1) return refuse('A grid needs pins.x columns and pins.y rows.')
  const letters = GRID_ROW_LETTERS.length
  if (rows > letters * (letters + 1))
    return refuse(`A grid names at most ${letters * (letters + 1)} rows.`)

  const type = input.ball.type ?? 'collapsible'
  const diameter = nominalOf(input.ball.diameter)
  const ratio = BALL_LAND[input.density][type]
  const land = roundTo(diameter * (1 + ratio), BALL_LAND_ROUND)
  if (!(land > 0) || land >= pitch) {
    return refuse(
      `A ${land} mm land does not fit a ${pitch} mm pitch; check ball.diameter and pitch.`
    )
  }

  const rowNames = Array.from({ length: rows }, (_, row) => gridRowName(row))
  const skipped = skippedPositions(input.skip ?? [], rowNames, columns)
  if (!skipped.ok) {
    return refuse(
      `skip names "${skipped.name}", which is not a position on a ${rowNames[rows - 1]}${columns} grid; a position is a row letter and a column (A1), a block two of them (E5:K11).`
    )
  }

  const pads: PadSpec[] = []
  let populated = 0
  const x = (column: number): number => mm((column - (columns - 1) / 2) * pitch)
  for (let row = 0; row < rows; row++) {
    let column = 0
    while (column < columns) {
      if (skipped.keys.has(`${row},${column}`)) {
        column++
        continue
      }
      let end = column
      while (end + 1 < columns && !skipped.keys.has(`${row},${end + 1}`)) end++
      const count = end - column + 1
      populated += count
      pads.push({
        number: `${rowNames[row]}${column + 1}`,
        type: 'smd',
        shape: 'circle',
        at: { x: x(column), y: mm((row - (rows - 1) / 2) * pitch) },
        size: { width: land, height: land },
        ...(count > 1 ? { array: { count, dx: pitch, dy: 0 } } : {})
      })
      column = end + 1
    }
  }
  if (!populated) return refuse('skip leaves no ball on the grid.')

  return {
    ok: true,
    pads,
    body: bodyAround(input, { x: 0, y: 0 }),
    notes: {
      density: input.density,
      table: `IPC-7352 Table 3-11, grid array lands, ${type === 'collapsible' ? 'collapsible ball' : 'non-collapsible ball or land'}`,
      ball: { diameter: mm(diameter), type, ratio, land, populated },
      adjustments: []
    }
  }
}

/**
 * The pad table for a package. Surface-mount leads are JEDEC-numbered: pin 1
 * at the top of the left side, counter-clockwise, the exposed pad last.
 */
export const landPattern = (input: LandPatternInput): LandPatternResult => {
  if (input.leadType === 'through_hole') return throughHole(input)
  if (input.leadType === 'grid') return gridArray(input)
  if (!input.lead?.length) return refuse('lead.length is required for this lead type.')
  const lead = { width: input.lead.width, length: input.lead.length }
  const chosen = pickTable(input, input.leadType)
  const fillets = chosen.levels[input.density]
  const body = { x: range(input.body.x), y: range(input.body.y) }
  const length = range(lead.length)
  const pad = (
    number: number,
    at: { x: number; y: number },
    size: { w: number; h: number },
    array?: PadSpec['array']
  ): PadSpec => ({
    number: String(number),
    type: 'smd',
    shape: 'roundrect',
    at: { x: mm(at.x), y: mm(at.y) },
    size: { width: mm(size.w), height: mm(size.h) },
    ...(array ? { array } : {})
  })
  const bodyRect = bodyAround(input, { x: 0, y: 0 })

  if (input.leadType === 'chip') {
    const width = range(lead.width ?? input.body.y)
    const x = axis(body.x, length, width, fillets, chosen.round, undefined, undefined)
    return {
      ok: true,
      pads: [
        pad(1, { x: -x.center, y: 0 }, { w: x.padLength, h: x.X }),
        pad(2, { x: x.center, y: 0 }, { w: x.padLength, h: x.X })
      ],
      body: bodyRect,
      notes: {
        density: input.density,
        table: chosen.name,
        fillets,
        x,
        adjustments: x.notes
      }
    }
  }

  if (!lead.width) return refuse('lead.width is required for this lead type.')
  const width = range(lead.width)
  const pitch = input.pitch
  if (!pitch || pitch <= 0) return refuse('pitch is required and must be positive.')
  const columns = input.pins?.y ?? 0
  const rows = input.pins?.x ?? 0
  if (columns + rows === 0) return refuse('pins needs x or y: how many pins on each side.')
  const reachesPast = input.leadType === 'gullwing' || input.leadType === 'j_lead'
  const outerOf = (side: 'x' | 'y'): Range | null => {
    const span = input.span?.[side]
    if (span) return range(span)
    return reachesPast ? null : body[side]
  }

  const pads: PadSpec[] = []
  const adjustments: string[] = []
  let number = 1
  const exposed = input.exposedPad
  let xAxis: AxisResult | undefined
  let yAxis: AxisResult | undefined

  if (columns) {
    const outer = outerOf('x')
    if (!outer)
      return refuse('span.x (lead tip to lead tip across the left and right sides) is required.')
    xAxis = axis(
      outer,
      length,
      width,
      fillets,
      chosen.round,
      pitch,
      exposed ? exposed.x / 2 : undefined
    )
    adjustments.push(...xAxis.notes)
  }
  if (rows) {
    const outer = outerOf('y')
    if (!outer)
      return refuse('span.y (lead tip to lead tip across the top and bottom sides) is required.')
    yAxis = axis(
      outer,
      length,
      width,
      fillets,
      chosen.round,
      pitch,
      exposed ? exposed.y / 2 : undefined
    )
    adjustments.push(...yAxis.notes)
  }
  const first = (count: number): number => -((count - 1) * pitch) / 2

  // Left side, top to bottom.
  if (xAxis) {
    pads.push(
      pad(
        number,
        { x: -xAxis.center, y: first(columns) },
        { w: xAxis.padLength, h: xAxis.X },
        columns > 1 ? { count: columns, dx: 0, dy: pitch } : undefined
      )
    )
    number += columns
  }
  // Bottom, left to right.
  if (yAxis) {
    pads.push(
      pad(
        number,
        { x: first(rows), y: yAxis.center },
        { w: yAxis.X, h: yAxis.padLength },
        rows > 1 ? { count: rows, dx: pitch, dy: 0 } : undefined
      )
    )
    number += rows
  }
  // Right side, bottom to top.
  if (xAxis) {
    pads.push(
      pad(
        number,
        { x: xAxis.center, y: -first(columns) },
        { w: xAxis.padLength, h: xAxis.X },
        columns > 1 ? { count: columns, dx: 0, dy: -pitch } : undefined
      )
    )
    number += columns
  }
  // Top, right to left.
  if (yAxis) {
    pads.push(
      pad(
        number,
        { x: -first(rows), y: -yAxis.center },
        { w: yAxis.X, h: yAxis.padLength },
        rows > 1 ? { count: rows, dx: -pitch, dy: 0 } : undefined
      )
    )
    number += rows
  }
  if (exposed) {
    pads.push({
      number: String(number),
      type: 'smd',
      shape: 'rect',
      at: { x: 0, y: 0 },
      size: { width: mm(exposed.x), height: mm(exposed.y) }
    })
  }

  return {
    ok: true,
    pads,
    body: bodyRect,
    notes: {
      density: input.density,
      table: chosen.name,
      fillets,
      ...(xAxis ? { x: xAxis } : {}),
      ...(yAxis ? { y: yAxis } : {}),
      adjustments
    }
  }
}
