/**
 * Turning and mirroring placed schematic items about a pivot: the geometry
 * behind `R`, `Shift+R`, `X` and `Y` on a selection. Sheet space is y-down
 * while KiCad's stored angles are counter-clockwise as displayed, which is
 * why a turn of a point and a turn of an angle read differently here.
 */
import { nm } from '../kicad/coordinates'
import type { KicadSchematicSymbol, Point } from '../kicad/schematic'

export type TransformOp = 'rotateCCW' | 'rotateCW' | 'mirrorHorizontal' | 'mirrorVertical'

const normalize = (angle: number): number => ((angle % 360) + 360) % 360

/** A point turned or flipped about `pivot`, in sheet space (y-down). */
export function transformPoint(point: Point, pivot: Point, op: TransformOp): Point {
  const dx = point.x - pivot.x
  const dy = point.y - pivot.y
  switch (op) {
    // Counter-clockwise on screen carries +x (right) to -y (up).
    case 'rotateCCW':
      return { x: nm(pivot.x + dy), y: nm(pivot.y - dx) }
    case 'rotateCW':
      return { x: nm(pivot.x - dy), y: nm(pivot.y + dx) }
    case 'mirrorHorizontal':
      return { x: nm(pivot.x - dx), y: point.y }
    case 'mirrorVertical':
      return { x: point.x, y: nm(pivot.y - dy) }
  }
}

/** A displayed angle (a label's, a text's) after the same operation. */
export function transformAngle(angle: number, op: TransformOp): number {
  switch (op) {
    case 'rotateCCW':
      return normalize(angle + 90)
    case 'rotateCW':
      return normalize(angle - 90)
    // A left-right flip turns reading-right into reading-left and leaves
    // up and down alone; a top-bottom flip does the reverse.
    case 'mirrorHorizontal':
      return normalize(180 - angle)
    case 'mirrorVertical':
      return normalize(-angle)
  }
}

export interface SymbolOrientation {
  angle: number
  mirror?: 'x' | 'y'
}

/**
 * A placed symbol's stored orientation after the operation. A symbol is
 * drawn as rotate-then-mirror of its library body (`placedPoint`), M·R(θ).
 * A flip on top folds into the stored flag: two like flips cancel, two
 * unlike flips are a half turn, and the angle is untouched. A turn on top
 * of a mirror conjugates through it — R(φ)·M = M·R(−φ) — so a mirrored
 * symbol's stored angle runs the other way. `mirror x` is KiCad's
 * top-bottom flip, `mirror y` its left-right one, and `mirror x` at 180 is
 * spelled `mirror y` at 0, the form KiCad's own orientation table keeps.
 */
export function transformOrientation(
  current: SymbolOrientation,
  op: TransformOp
): SymbolOrientation {
  const canonical = (angle: number, mirror?: 'x' | 'y'): SymbolOrientation => {
    if (mirror === 'x' && angle === 180) return { angle: 0, mirror: 'y' }
    return mirror ? { angle, mirror } : { angle }
  }
  if (op === 'rotateCCW' || op === 'rotateCW') {
    const step = (op === 'rotateCCW') !== !!current.mirror ? 90 : -90
    return canonical(normalize(current.angle + step), current.mirror)
  }
  const flip: 'x' | 'y' = op === 'mirrorVertical' ? 'x' : 'y'
  if (!current.mirror) return canonical(current.angle, flip)
  if (current.mirror === flip) return canonical(current.angle)
  return canonical(normalize(current.angle + 180))
}

/** The symbol as it would be placed after the operation about `pivot`. */
export function transformedSymbol(
  symbol: KicadSchematicSymbol,
  pivot: Point,
  op: TransformOp
): KicadSchematicSymbol {
  const origin = transformPoint(symbol.position, pivot, op)
  const orientation = transformOrientation(
    { angle: symbol.position.angle, mirror: symbol.mirror },
    op
  )
  return {
    ...symbol,
    position: { x: origin.x, y: origin.y, angle: orientation.angle },
    mirror: orientation.mirror
  }
}

/**
 * Where a selection turns about: a lone symbol's own origin, otherwise the
 * middle of everything selected, snapped to the grid so on-grid points stay
 * on grid through a quarter turn.
 */
export function transformPivot(points: Point[], grid: number, lone?: Point): Point {
  if (lone) return lone
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const point of points) {
    minX = Math.min(minX, point.x)
    minY = Math.min(minY, point.y)
    maxX = Math.max(maxX, point.x)
    maxY = Math.max(maxY, point.y)
  }
  if (!Number.isFinite(minX)) return { x: nm(0), y: nm(0) }
  const snap = (value: number): number => Math.round(value / grid) * grid
  return { x: nm(snap((minX + maxX) / 2)), y: nm(snap((minY + maxY) / 2)) }
}
