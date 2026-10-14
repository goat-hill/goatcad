/**
 * RS-274X aperture macros (%AM...%): stored as parsed primitive/assignment
 * statements and expanded to normalized shapes at flash time with the AD
 * command's actual parameter values.
 *
 * Macro bodies are tiny expression programs: `$n` variables, `+ - x /`
 * arithmetic ('x' is multiplication per the spec; legacy files use 'X'), and
 * `$n=expr` assignment statements between primitives.
 */

import type { GerberPoint, GerberShape } from './shapes'
import { tessellateArc } from './shapes'

interface MacroStatement {
  /** Primitive code (1, 4, 5, 6, 7, 20, 21) or -1 for a `$n=expr` assignment. */
  code: number
  /** Expression strings: primitive modifiers, or [varIndex, expr] for assignments. */
  exprs: string[]
  assignVar?: number
}

export interface GerberMacro {
  name: string
  statements: MacroStatement[]
}

/** A macro-expanded shape; `exposure` false means erase-within-this-flash. */
export interface MacroShape {
  shape: GerberShape
  exposure: boolean
}

// ---------------------------------------------------------------------------
// Expression evaluation
// ---------------------------------------------------------------------------

class ExprReader {
  private pos = 0
  constructor(
    private readonly src: string,
    private readonly vars: ReadonlyMap<number, number>
  ) {}

  private peek(): string {
    return this.src[this.pos] ?? ''
  }

  evaluate(): number {
    const value = this.parseExpr()
    if (this.pos < this.src.length) {
      throw new Error(`Unexpected '${this.src.slice(this.pos)}' in macro expression`)
    }
    return value
  }

  private parseExpr(): number {
    let value = this.parseTerm()
    for (;;) {
      const c = this.peek()
      if (c === '+') {
        this.pos++
        value += this.parseTerm()
      } else if (c === '-') {
        this.pos++
        value -= this.parseTerm()
      } else {
        return value
      }
    }
  }

  private parseTerm(): number {
    let value = this.parseFactor()
    for (;;) {
      const c = this.peek()
      if (c === 'x' || c === 'X') {
        this.pos++
        value *= this.parseFactor()
      } else if (c === '/') {
        this.pos++
        const divisor = this.parseFactor()
        value = divisor === 0 ? 0 : value / divisor
      } else {
        return value
      }
    }
  }

  private parseFactor(): number {
    const c = this.peek()
    if (c === '-') {
      this.pos++
      return -this.parseFactor()
    }
    if (c === '+') {
      this.pos++
      return this.parseFactor()
    }
    if (c === '(') {
      this.pos++
      const value = this.parseExpr()
      if (this.peek() !== ')') throw new Error('Unbalanced parenthesis in macro expression')
      this.pos++
      return value
    }
    if (c === '$') {
      this.pos++
      const start = this.pos
      while (/[0-9]/.test(this.peek())) this.pos++
      const index = parseInt(this.src.slice(start, this.pos), 10)
      // Undefined macro variables read as 0 per spec
      return this.vars.get(index) ?? 0
    }
    const start = this.pos
    while (/[0-9.]/.test(this.peek())) this.pos++
    if (this.pos === start) throw new Error(`Bad macro expression near '${this.src.slice(start)}'`)
    return parseFloat(this.src.slice(start, this.pos))
  }
}

const evalExpr = (expr: string, vars: ReadonlyMap<number, number>): number =>
  new ExprReader(expr, vars).evaluate()

// ---------------------------------------------------------------------------
// Macro body parsing
// ---------------------------------------------------------------------------

/**
 * Parse an %AM body: `name` then `*`-separated statements (already split by
 * the tokenizer). Comment primitives (0) are dropped here.
 */
export function parseMacroBody(name: string, statements: string[]): GerberMacro {
  const parsed: MacroStatement[] = []
  for (const raw of statements) {
    const stmt = raw.trim()
    if (stmt === '' || stmt.startsWith('0 ') || stmt === '0') continue
    const assign = /^\$(\d+)\s*=\s*(.+)$/.exec(stmt)
    if (assign) {
      parsed.push({ code: -1, exprs: [assign[2]], assignVar: parseInt(assign[1], 10) })
      continue
    }
    const parts = stmt.split(',').map((p) => p.trim())
    const code = parseInt(parts[0], 10)
    if (Number.isNaN(code)) throw new Error(`Bad macro statement '${stmt}' in ${name}`)
    parsed.push({ code, exprs: parts.slice(1) })
  }
  return { name, statements: parsed }
}

// ---------------------------------------------------------------------------
// Expansion to shapes
// ---------------------------------------------------------------------------

const rotate = (x: number, y: number, angleDeg: number): GerberPoint => {
  const a = (angleDeg * Math.PI) / 180
  const cos = Math.cos(a)
  const sin = Math.sin(a)
  return { x: x * cos - y * sin, y: x * sin + y * cos }
}

/** Thermal: annulus with two perpendicular gaps → four petal polygons. */
function thermalPetals(
  cx: number,
  cy: number,
  outerR: number,
  innerR: number,
  gap: number,
  rotationDeg: number,
  scale: number
): GerberShape[] {
  const petals: GerberShape[] = []
  const halfGap = gap / 2
  // Angle each gap edge subtends at inner/outer radius
  const outerStart = Math.asin(Math.min(1, halfGap / outerR))
  const innerStart = innerR > halfGap ? Math.asin(Math.min(1, halfGap / innerR)) : Math.PI / 4
  for (let q = 0; q < 4; q++) {
    const base = (q * Math.PI) / 2
    const oa0 = base + outerStart
    const oa1 = base + Math.PI / 2 - outerStart
    const ia0 = base + innerStart
    const ia1 = base + Math.PI / 2 - innerStart
    if (oa1 <= oa0) continue
    const outerPts = tessellateArc(0, 0, outerR, oa0, oa1 - oa0)
    const innerPts = ia1 > ia0 ? tessellateArc(0, 0, innerR, ia1, -(ia1 - ia0)) : []
    const outline = [...outerPts, ...innerPts].map((p) => {
      const r = rotate(p.x, p.y, rotationDeg)
      return { x: (cx + r.x) * scale, y: (cy + r.y) * scale }
    })
    petals.push({ kind: 'poly', outline, holes: [] })
  }
  return petals
}

/**
 * Expand a macro with the AD parameter values. `scale` converts the file's
 * units to millimeters (macro coordinates are in file units).
 *
 * Primitive rotation rotates the whole primitive about the macro origin —
 * including its center point — per the spec.
 */
export function expandMacro(
  macro: GerberMacro,
  params: number[],
  scale: number,
  warn: (message: string) => void
): MacroShape[] {
  const vars = new Map<number, number>()
  params.forEach((value, i) => vars.set(i + 1, value))

  const shapes: MacroShape[] = []
  for (const stmt of macro.statements) {
    if (stmt.code === -1 && stmt.assignVar !== undefined) {
      vars.set(stmt.assignVar, evalExpr(stmt.exprs[0], vars))
      continue
    }
    const m = stmt.exprs.map((e) => evalExpr(e, vars))
    switch (stmt.code) {
      case 1: {
        // Circle: exposure, diameter, cx, cy, [rotation]
        const [exposure, diam, cx, cy] = m
        const c = rotate(cx, cy, m[4] ?? 0)
        shapes.push({
          exposure: exposure > 0.5,
          shape: { kind: 'circle', cx: c.x * scale, cy: c.y * scale, r: (diam / 2) * scale }
        })
        break
      }
      case 2:
      case 20: {
        // Vector line (flat ends): exposure, width, x1, y1, x2, y2, rotation
        const [exposure, width, x1, y1, x2, y2, rot = 0] = m
        const a = rotate(x1, y1, rot)
        const b = rotate(x2, y2, rot)
        const len = Math.hypot(b.x - a.x, b.y - a.y)
        shapes.push({
          exposure: exposure > 0.5,
          shape: {
            kind: 'rect',
            cx: ((a.x + b.x) / 2) * scale,
            cy: ((a.y + b.y) / 2) * scale,
            halfW: (len / 2) * scale,
            halfH: (width / 2) * scale,
            rotation: Math.atan2(b.y - a.y, b.x - a.x)
          }
        })
        break
      }
      case 21: {
        // Center line: exposure, width, height, cx, cy, rotation
        const [exposure, width, height, cx, cy, rot = 0] = m
        const c = rotate(cx, cy, rot)
        shapes.push({
          exposure: exposure > 0.5,
          shape: {
            kind: 'rect',
            cx: c.x * scale,
            cy: c.y * scale,
            halfW: (width / 2) * scale,
            halfH: (height / 2) * scale,
            rotation: (rot * Math.PI) / 180
          }
        })
        break
      }
      case 4: {
        // Outline: exposure, #vertices, x0, y0, ..., xn, yn, rotation
        const exposure = m[0]
        const n = Math.round(m[1])
        const rot = m[2 + (n + 1) * 2] ?? 0
        const outline: GerberPoint[] = []
        for (let i = 0; i <= n; i++) {
          const p = rotate(m[2 + i * 2], m[3 + i * 2], rot)
          outline.push({ x: p.x * scale, y: p.y * scale })
        }
        shapes.push({ exposure: exposure > 0.5, shape: { kind: 'poly', outline, holes: [] } })
        break
      }
      case 5: {
        // Polygon: exposure, #vertices, cx, cy, diameter, rotation
        const [exposure, nRaw, cx, cy, diam, rot = 0] = m
        const n = Math.max(3, Math.round(nRaw))
        const outline: GerberPoint[] = []
        for (let i = 0; i < n; i++) {
          const a = (2 * Math.PI * i) / n
          const p = rotate(cx + (diam / 2) * Math.cos(a), cy + (diam / 2) * Math.sin(a), rot)
          outline.push({ x: p.x * scale, y: p.y * scale })
        }
        shapes.push({ exposure: exposure > 0.5, shape: { kind: 'poly', outline, holes: [] } })
        break
      }
      case 6: {
        // Moiré (deprecated 2021, still emitted): cx, cy, outerDiam, ringThickness,
        // gap, maxRings, crosshairThickness, crosshairLength, rotation
        const [cx, cy, outerDiam, ringTh, gap, maxRings, crossTh, crossLen, rot = 0] = m
        const c = rotate(cx, cy, rot)
        let outer = outerDiam / 2
        for (let i = 0; i < maxRings && outer > 0; i++) {
          const inner = Math.max(0, outer - ringTh)
          shapes.push({
            exposure: true,
            shape:
              inner > 0
                ? {
                    kind: 'ring',
                    cx: c.x * scale,
                    cy: c.y * scale,
                    radius: ((outer + inner) / 2) * scale,
                    halfStroke: ((outer - inner) / 2) * scale
                  }
                : { kind: 'circle', cx: c.x * scale, cy: c.y * scale, r: outer * scale }
          })
          outer = inner - gap
        }
        if (crossTh > 0 && crossLen > 0) {
          for (const angle of [0, 90]) {
            shapes.push({
              exposure: true,
              shape: {
                kind: 'rect',
                cx: c.x * scale,
                cy: c.y * scale,
                halfW: (crossLen / 2) * scale,
                halfH: (crossTh / 2) * scale,
                rotation: ((angle + rot) * Math.PI) / 180
              }
            })
          }
        }
        break
      }
      case 7: {
        // Thermal: cx, cy, outerDiam, innerDiam, gapThickness, rotation
        const [cx, cy, outerDiam, innerDiam, gap, rot = 0] = m
        for (const petal of thermalPetals(cx, cy, outerDiam / 2, innerDiam / 2, gap, rot, scale)) {
          shapes.push({ exposure: true, shape: petal })
        }
        break
      }
      default:
        warn(`Macro ${macro.name}: unsupported primitive code ${stmt.code}, skipped`)
    }
  }
  return shapes
}

// Test seam: the evaluator is where macro bugs live, so expose it directly.
export { evalExpr }
