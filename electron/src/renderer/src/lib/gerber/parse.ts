/**
 * RS-274X / Gerber X2 reader.
 *
 * Scope (deliberate): modern Gerber only — what every ECAD tool and fab CAM
 * system has emitted since ~2000. Standard apertures (C/R/O/P with holes),
 * aperture macros, regions (G36/G37) including arc segments, LPD/LPC
 * polarity, single- and multi-quadrant arcs, step & repeat, and the X2
 * attributes we care about (TF.FileFunction / TF.FilePolarity). Legacy
 * RS-274D (no %FS/%MO, external aperture wheels) is rejected with a clear
 * error rather than half-parsed; deprecated image transforms (MI/OF/SF/AS/IR,
 * IPNEG) are skipped with a warning when they would change the image.
 *
 * Output is a flat, ordered display list of normalized mm shapes (shapes.ts).
 * Order matters: `clear` items erase what came before them on the layer.
 */

import type { GerberBounds, GerberItem, GerberPoint, GerberPolarity, GerberShape } from './shapes'
import {
  emptyBounds,
  expandBoundsByShape,
  circleOutline,
  obroundOutline,
  rectOutline,
  tessellateArc
} from './shapes'
import type { GerberMacro } from './macro'
import { expandMacro, parseMacroBody } from './macro'

export interface GerberImage {
  items: GerberItem[]
  /** Units the file was written in (everything is normalized to mm). */
  units: 'mm' | 'in'
  /** Raw TF.FileFunction attribute value (e.g. "Copper,L1,Top"), if present. */
  fileFunction: string | null
  /** TF.FilePolarity: negative means the image represents absence of material. */
  filePolarity: 'positive' | 'negative' | null
  apertureCount: number
  /** True when any item has clear polarity (needs erase-capable rendering). */
  hasClear: boolean
  bounds: GerberBounds
  warnings: string[]
}

export class GerberParseError extends Error {}

// ---------------------------------------------------------------------------
// Aperture model
// ---------------------------------------------------------------------------

interface StandardAperture {
  template: 'C' | 'R' | 'O' | 'P'
  /** Modifiers in mm. */
  params: number[]
}

interface MacroAperture {
  macro: GerberMacro
  /** Raw modifiers in file units (macros scale internally). */
  params: number[]
}

interface Aperture {
  dCode: number
  standard?: StandardAperture
  macroRef?: MacroAperture
  /** Stroke half-width for draws: circle radius (only C draws are compliant). */
  drawHalfWidth: number
}

// ---------------------------------------------------------------------------
// Parser state
// ---------------------------------------------------------------------------

interface CoordinateFormat {
  intDigits: number
  decDigits: number
  zeroMode: 'L' | 'T'
}

interface Contour {
  points: GerberPoint[]
}

const FULL_CIRCLE = Math.PI * 2

export function parseGerber(content: string): GerberImage {
  const warnings: string[] = []
  const warned = new Set<string>()
  const warn = (message: string): void => {
    if (warned.has(message)) return
    warned.add(message)
    warnings.push(message)
  }

  // --- file state ---
  let format: CoordinateFormat | null = null
  let units: 'mm' | 'in' | null = null
  let scale = 1
  const macros = new Map<string, GerberMacro>()
  const apertures = new Map<number, Aperture>()
  let fileFunction: string | null = null
  let filePolarity: 'positive' | 'negative' | null = null

  // --- graphics state ---
  let x = 0
  let y = 0
  let currentAperture: Aperture | null = null
  let interpolation: 'linear' | 'cw' | 'ccw' = 'linear'
  let quadrantMode: 'single' | 'multi' | null = null
  let polarity: GerberPolarity = 'dark'
  let inRegion = false
  let contours: Contour[] = []
  let ended = false

  // --- step & repeat ---
  let srStart = 0
  let srRepeat: { nx: number; ny: number; dx: number; dy: number } | null = null

  const items: GerberItem[] = []

  const emit = (shape: GerberShape, itemPolarity: GerberPolarity = polarity): void => {
    items.push({ polarity: itemPolarity, shape })
  }

  // -------------------------------------------------------------------------
  // Coordinate & number helpers
  // -------------------------------------------------------------------------

  const parseCoordinate = (raw: string): number => {
    if (!format) {
      throw new GerberParseError(
        'No %FS coordinate format before coordinates — this looks like legacy RS-274D ' +
          '(pre-2000 Gerber with external aperture definitions), which GoatCAD does not support. ' +
          'Re-export the file as RS-274X / Gerber X2.'
      )
    }
    let sign = 1
    let digits = raw
    if (digits.startsWith('-')) {
      sign = -1
      digits = digits.slice(1)
    } else if (digits.startsWith('+')) {
      digits = digits.slice(1)
    }
    const width = format.intDigits + format.decDigits
    if (format.zeroMode === 'T' && digits.length < width) {
      digits = digits.padEnd(width, '0')
    }
    return (sign * parseInt(digits, 10)) / Math.pow(10, format.decDigits)
  }

  const requireUnits = (): void => {
    if (units !== null) return
    throw new GerberParseError(
      'No %MO units command before drawing commands — this looks like legacy RS-274D, ' +
        'which GoatCAD does not support. Re-export as RS-274X / Gerber X2.'
    )
  }

  // -------------------------------------------------------------------------
  // Flash decomposition
  // -------------------------------------------------------------------------

  const emitHoled = (outline: GerberPoint[], holeDiam: number, cx: number, cy: number): void => {
    emit({
      kind: 'poly',
      outline,
      holes: [circleOutline(cx, cy, holeDiam / 2)]
    })
  }

  const flash = (fx: number, fy: number): void => {
    const ap = currentAperture
    if (!ap) {
      warn('Flash (D03) with no aperture selected, skipped')
      return
    }
    if (ap.standard) {
      const p = ap.standard.params
      switch (ap.standard.template) {
        case 'C': {
          const r = p[0] / 2
          const hole = p[1] ?? 0
          if (hole > 0 && hole < p[0]) {
            // Concentric hole → exact annulus. The hole is transparent (prior
            // image shows through), so it must be shape subtraction, never an
            // erase — the ring SDF gives that for free.
            emit({
              kind: 'ring',
              cx: fx,
              cy: fy,
              radius: (r + hole / 2) / 2,
              halfStroke: (r - hole / 2) / 2
            })
          } else {
            emit({ kind: 'circle', cx: fx, cy: fy, r })
          }
          break
        }
        case 'R': {
          const [w, h, hole = 0] = p
          if (hole > 0) {
            emitHoled(rectOutline(fx, fy, w / 2, h / 2, 0), hole, fx, fy)
          } else {
            emit({ kind: 'rect', cx: fx, cy: fy, halfW: w / 2, halfH: h / 2, rotation: 0 })
          }
          break
        }
        case 'O': {
          const [w, h, hole = 0] = p
          if (hole > 0) {
            emitHoled(obroundOutline(fx, fy, w, h), hole, fx, fy)
          } else {
            const r = Math.min(w, h) / 2
            const dx = Math.max(0, w / 2 - r)
            const dy = Math.max(0, h / 2 - r)
            emit({
              kind: 'capsule',
              x0: fx - dx,
              y0: fy - dy,
              x1: fx + dx,
              y1: fy + dy,
              halfWidth: r
            })
          }
          break
        }
        case 'P': {
          const [outerDiam, nRaw, rotDeg = 0, hole = 0] = p
          const n = Math.max(3, Math.round(nRaw))
          const outline: GerberPoint[] = []
          for (let i = 0; i < n; i++) {
            const a = (rotDeg * Math.PI) / 180 + (2 * Math.PI * i) / n
            outline.push({
              x: fx + (outerDiam / 2) * Math.cos(a),
              y: fy + (outerDiam / 2) * Math.sin(a)
            })
          }
          if (hole > 0) emitHoled(outline, hole, fx, fy)
          else emit({ kind: 'poly', outline, holes: [] })
          break
        }
      }
      return
    }
    if (ap.macroRef) {
      const expanded = expandMacro(ap.macroRef.macro, ap.macroRef.params, scale, warn)
      for (const { shape, exposure } of expanded) {
        if (!exposure) {
          // Approximation: exposure-off should only erase within this flash,
          // but we erase the layer under it. Correct for the overwhelmingly
          // common case (nothing painted under a pad yet); flagged so a
          // surprising render can be traced.
          warn(
            `Macro ${ap.macroRef.macro.name}: clear-exposure primitive approximated as layer erase`
          )
        }
        const translated = translateShape(shape, fx, fy)
        emit(translated, exposure ? polarity : polarity === 'dark' ? 'clear' : 'dark')
      }
      return
    }
    warn(`Aperture D${ap.dCode} has no definition, flash skipped`)
  }

  // -------------------------------------------------------------------------
  // Draw / arc operations
  // -------------------------------------------------------------------------

  const draw = (x0: number, y0: number, x1: number, y1: number): void => {
    const ap = currentAperture
    if (!ap) {
      warn('Draw (D01) with no aperture selected, skipped')
      return
    }
    if (ap.standard && ap.standard.template !== 'C') {
      warn(`Draw with non-circular aperture D${ap.dCode} approximated with round caps`)
    }
    emit({ kind: 'capsule', x0, y0, x1, y1, halfWidth: ap.drawHalfWidth })
  }

  /** Resolve an arc's center/sweep from endpoints + I/J offsets. */
  const resolveArc = (
    x0: number,
    y0: number,
    x1: number,
    y1: number,
    i: number,
    j: number,
    cw: boolean
  ): { cx: number; cy: number; radius: number; startAngle: number; sweep: number } | null => {
    if (quadrantMode === null) {
      warn('Arc before G74/G75 quadrant mode; assuming multi-quadrant (G75)')
      quadrantMode = 'multi'
    }
    const sweepOf = (start: number, end: number): number => {
      let sweep = end - start
      if (cw) {
        while (sweep >= 0) sweep -= FULL_CIRCLE
        while (sweep < -FULL_CIRCLE) sweep += FULL_CIRCLE
      } else {
        while (sweep <= 0) sweep += FULL_CIRCLE
        while (sweep > FULL_CIRCLE) sweep -= FULL_CIRCLE
      }
      return sweep
    }
    if (quadrantMode === 'multi') {
      const cx = x0 + i
      const cy = y0 + j
      const radius = Math.hypot(x0 - cx, y0 - cy)
      if (radius < 1e-9) return null
      const startAngle = Math.atan2(y0 - cy, x0 - cx)
      // Coincident endpoints in G75 mean a full circle
      const sweep =
        Math.hypot(x1 - x0, y1 - y0) < 1e-9
          ? cw
            ? -FULL_CIRCLE
            : FULL_CIRCLE
          : sweepOf(startAngle, Math.atan2(y1 - cy, x1 - cx))
      return { cx, cy, radius, startAngle, sweep }
    }
    // Single quadrant (G74): I/J are unsigned; pick the sign combination that
    // yields a valid ≤90° arc in the commanded direction with matching radii.
    let best: { cx: number; cy: number; radius: number; startAngle: number; sweep: number } | null =
      null
    let bestError = Infinity
    for (const si of [1, -1]) {
      for (const sj of [1, -1]) {
        const cx = x0 + si * Math.abs(i)
        const cy = y0 + sj * Math.abs(j)
        const r0 = Math.hypot(x0 - cx, y0 - cy)
        const r1 = Math.hypot(x1 - cx, y1 - cy)
        if (r0 < 1e-9) continue
        const startAngle = Math.atan2(y0 - cy, x0 - cx)
        const sweep = sweepOf(startAngle, Math.atan2(y1 - cy, x1 - cx))
        if (Math.abs(sweep) > Math.PI / 2 + 1e-6) continue
        const error = Math.abs(r0 - r1)
        if (error < bestError) {
          bestError = error
          best = { cx, cy, radius: (r0 + r1) / 2, startAngle, sweep }
        }
      }
    }
    if (!best) warn('Unresolvable single-quadrant (G74) arc, skipped')
    return best
  }

  const arc = (x1: number, y1: number, i: number, j: number): void => {
    const ap = currentAperture
    if (!ap) {
      warn('Arc (D01) with no aperture selected, skipped')
      return
    }
    const resolved = resolveArc(x, y, x1, y1, i, j, interpolation === 'cw')
    if (!resolved) return
    emit({
      kind: 'arc',
      cx: resolved.cx,
      cy: resolved.cy,
      radius: resolved.radius,
      halfWidth: ap.drawHalfWidth,
      startAngle: resolved.startAngle,
      sweep: resolved.sweep
    })
  }

  // -------------------------------------------------------------------------
  // Regions
  // -------------------------------------------------------------------------

  const currentContour = (): Contour => {
    if (contours.length === 0) contours.push({ points: [{ x, y }] })
    return contours[contours.length - 1]
  }

  const closeRegion = (): void => {
    for (const contour of contours) {
      // Drop the closing duplicate point if present
      const pts = contour.points
      while (
        pts.length > 1 &&
        Math.abs(pts[0].x - pts[pts.length - 1].x) < 1e-9 &&
        Math.abs(pts[0].y - pts[pts.length - 1].y) < 1e-9
      ) {
        pts.pop()
      }
      if (pts.length >= 3) emit({ kind: 'poly', outline: pts, holes: [] })
    }
    contours = []
  }

  // -------------------------------------------------------------------------
  // Step & repeat
  // -------------------------------------------------------------------------

  const closeStepRepeat = (): void => {
    if (!srRepeat) return
    const { nx, ny, dx, dy } = srRepeat
    const block = items.slice(srStart)
    for (let ix = 0; ix < nx; ix++) {
      for (let iy = 0; iy < ny; iy++) {
        if (ix === 0 && iy === 0) continue
        for (const item of block) {
          items.push({
            polarity: item.polarity,
            shape: translateShape(item.shape, ix * dx, iy * dy)
          })
        }
      }
    }
    srRepeat = null
  }

  // -------------------------------------------------------------------------
  // Extended (%) command handling
  // -------------------------------------------------------------------------

  const handleExtended = (words: string[]): void => {
    if (words.length === 0) return
    // A macro consumes the whole block (name word + primitive statements);
    // any other block is one-or-more independent single-word commands
    // (older writers bundled e.g. %MOMM*LPD*%).
    if (words[0].startsWith('AM')) {
      const macro = parseMacroBody(words[0].slice(2), words.slice(1))
      macros.set(macro.name, macro)
      return
    }
    for (const word of words) handleExtendedWord(word)
  }

  const handleExtendedWord = (first: string): void => {
    const code = first.slice(0, 2)
    switch (code) {
      case 'FS': {
        const m = /^FS(L|T)(A|I)X(\d)(\d)Y(\d)(\d)$/.exec(first)
        if (!m) {
          throw new GerberParseError(`Unsupported coordinate format '${first}'`)
        }
        if (m[2] === 'I') {
          throw new GerberParseError('Incremental coordinates (FS..I) are not supported')
        }
        format = {
          zeroMode: m[1] as 'L' | 'T',
          intDigits: parseInt(m[3], 10),
          decDigits: parseInt(m[4], 10)
        }
        if (m[3] !== m[5] || m[4] !== m[6]) {
          warn('Different X and Y coordinate formats; using X format for both')
        }
        break
      }
      case 'MO':
        if (first === 'MOMM') {
          units = 'mm'
          scale = 1
        } else if (first === 'MOIN') {
          units = 'in'
          scale = 25.4
        } else {
          throw new GerberParseError(`Unsupported units '${first}'`)
        }
        break
      case 'AD': {
        requireUnits()
        const m = /^ADD(\d+)([^,]+)(?:,(.*))?$/.exec(first)
        if (!m) {
          warn(`Malformed aperture definition '${first}', skipped`)
          break
        }
        const dCode = parseInt(m[1], 10)
        const name = m[2]
        const rawParams = m[3] ? m[3].split('X').map((v) => parseFloat(v)) : []
        if (name === 'C' || name === 'R' || name === 'O' || name === 'P') {
          // Polygon rotation (param 3) is degrees, not a length — don't scale it
          const params = rawParams.map((v, idx) =>
            name === 'P' && (idx === 1 || idx === 2) ? v : v * scale
          )
          apertures.set(dCode, {
            dCode,
            standard: { template: name, params },
            drawHalfWidth:
              name === 'C' ? params[0] / 2 : Math.min(params[0] ?? 0, params[1] ?? 0) / 2
          })
        } else {
          const macro = macros.get(name)
          if (!macro) {
            warn(`Aperture D${dCode} references unknown macro '${name}'`)
            apertures.set(dCode, { dCode, drawHalfWidth: 0 })
          } else {
            apertures.set(dCode, {
              dCode,
              macroRef: { macro, params: rawParams },
              drawHalfWidth: 0
            })
          }
        }
        break
      }
      case 'LP':
        if (first === 'LPD') polarity = 'dark'
        else if (first === 'LPC') polarity = 'clear'
        else warn(`Unknown polarity '${first}'`)
        break
      case 'LM':
        if (first !== 'LMN') warn(`Object mirroring '${first}' not supported, ignored`)
        break
      case 'LR': {
        const angle = parseFloat(first.slice(2))
        if (angle !== 0) warn(`Object rotation '${first}' not supported, ignored`)
        break
      }
      case 'LS': {
        const factor = parseFloat(first.slice(2))
        if (factor !== 1) warn(`Object scaling '${first}' not supported, ignored`)
        break
      }
      case 'SR': {
        closeStepRepeat()
        const m = /^SR(?:X(\d+)Y(\d+)I([\d.-]+)J([\d.-]+))?$/.exec(first)
        if (!m) {
          warn(`Malformed step-repeat '${first}', ignored`)
          break
        }
        if (m[1]) {
          const nx = parseInt(m[1], 10)
          const ny = parseInt(m[2], 10)
          if (nx > 1 || ny > 1) {
            srRepeat = {
              nx,
              ny,
              dx: parseFloat(m[3]) * scale,
              dy: parseFloat(m[4]) * scale
            }
            srStart = items.length
          }
        }
        break
      }
      case 'TF': {
        const parts = first.slice(2).split(',')
        if (parts[0] === '.FileFunction') fileFunction = parts.slice(1).join(',')
        else if (parts[0] === '.FilePolarity') {
          filePolarity = parts[1] === 'Negative' ? 'negative' : 'positive'
          if (filePolarity === 'negative') {
            warn('Negative file polarity: rendering shows written objects, not material')
          }
        }
        break
      }
      case 'TA':
      case 'TO':
      case 'TD':
        // Aperture/object attributes: harmless metadata for a viewer (net
        // names etc. become useful later; ignoring them never changes geometry)
        break
      case 'IP':
        if (first === 'IPNEG') warn('Negative image polarity (IPNEG) not supported, ignored')
        break
      case 'AS':
      case 'IR':
      case 'MI':
      case 'OF':
      case 'SF':
      case 'IJ':
      case 'IO':
        warn(`Deprecated image transform '${first}' not supported, ignored`)
        break
      case 'AB':
        warn('Aperture blocks (%AB) are not supported; block contents were skipped')
        break
      case 'IN':
      case 'LN':
        break // Image/layer names: cosmetic
      default:
        warn(`Unknown extended command '${first}', ignored`)
    }
  }

  // -------------------------------------------------------------------------
  // Word (function code) handling
  // -------------------------------------------------------------------------

  const coordRe = /([XYIJ])([+-]?\d+)/g

  const handleWord = (word: string): void => {
    let rest = word

    // Comments (also X2's "legacy attribute" form G04 #@! TF...)
    if (/^G0*4($|[^0-9])/.test(rest)) {
      const body = rest.replace(/^G0*4\s*/, '')
      if (body.startsWith('#@!')) handleExtended([body.slice(3).trim()])
      return
    }

    // Strip leading G-codes (there may be several: "G54D10", "G01X..")
    let guard = 0
    while (/^G\d/.test(rest) && guard++ < 8) {
      const m = /^G0*(\d+)/.exec(rest)
      if (!m) break
      const g = parseInt(m[1], 10)
      rest = rest.slice(m[0].length)
      switch (g) {
        case 1:
          interpolation = 'linear'
          break
        case 2:
          interpolation = 'cw'
          break
        case 3:
          interpolation = 'ccw'
          break
        case 36:
          requireUnits()
          inRegion = true
          contours = []
          break
        case 37:
          closeRegion()
          inRegion = false
          break
        case 70:
          units = 'in'
          scale = 25.4
          break
        case 71:
          units = 'mm'
          scale = 1
          break
        case 74:
          quadrantMode = 'single'
          break
        case 75:
          quadrantMode = 'multi'
          break
        case 54:
        case 55:
        case 90:
          break // Deprecated no-ops (aperture-select prefix, absolute mode)
        case 91:
          throw new GerberParseError('Incremental coordinates (G91) are not supported')
        default:
          warn(`Unknown G-code G${g}, ignored`)
      }
    }
    if (rest === '') return

    // M-codes
    if (/^M0*[02]$/.test(rest)) {
      ended = true
      return
    }
    if (/^M0*1$/.test(rest)) return

    // Aperture select: D10 and up
    const dSelect = /^D0*(\d+)$/.exec(rest)
    if (dSelect && parseInt(dSelect[1], 10) >= 10) {
      const dCode = parseInt(dSelect[1], 10)
      currentAperture = apertures.get(dCode) ?? null
      if (!currentAperture) warn(`Undefined aperture D${dCode} selected`)
      return
    }

    // Coordinate word with an operation code
    coordRe.lastIndex = 0
    let nx = x
    let ny = y
    let i = 0
    let j = 0
    let m: RegExpExecArray | null
    let consumed = 0
    while ((m = coordRe.exec(rest)) !== null) {
      requireUnits()
      const value = parseCoordinate(m[2]) * scale
      if (m[1] === 'X') nx = value
      else if (m[1] === 'Y') ny = value
      else if (m[1] === 'I') i = value
      else j = value
      consumed += m[0].length
    }
    const opMatch = /D0*([123])$/.exec(rest)
    const op = opMatch ? parseInt(opMatch[1], 10) : null
    if (op !== null && opMatch) consumed += opMatch[0].length
    if (consumed !== rest.length) {
      warn(`Unrecognized word '${word}', ignored`)
      return
    }
    if (op === null && consumed === 0) return

    // Bare coordinates with no D-code: deprecated "modal operation" — spec
    // says repeat the previous operation; universally that means D01.
    const operation = op ?? 1
    if (op === null) warn('Coordinate word without operation code; assuming D01 (deprecated)')

    switch (operation) {
      case 1:
        if (inRegion) {
          const contour = currentContour()
          if (interpolation === 'linear') {
            contour.points.push({ x: nx, y: ny })
          } else {
            const resolved = resolveArc(x, y, nx, ny, i, j, interpolation === 'cw')
            if (resolved) {
              const pts = tessellateArc(
                resolved.cx,
                resolved.cy,
                resolved.radius,
                resolved.startAngle,
                resolved.sweep
              )
              // First tessellated point duplicates the current position
              contour.points.push(...pts.slice(1))
            }
          }
        } else if (interpolation === 'linear') {
          draw(x, y, nx, ny)
        } else {
          arc(nx, ny, i, j)
        }
        break
      case 2:
        if (inRegion) contours.push({ points: [{ x: nx, y: ny }] })
        break
      case 3:
        if (inRegion) warn('Flash (D03) inside a region, ignored')
        else flash(nx, ny)
        break
    }
    x = nx
    y = ny
  }

  // -------------------------------------------------------------------------
  // Tokenize: %...% extended blocks, *-terminated words elsewhere
  // -------------------------------------------------------------------------

  let pos = 0
  const len = content.length
  while (pos < len && !ended) {
    const c = content[pos]
    if (c === '%') {
      const end = content.indexOf('%', pos + 1)
      if (end < 0) throw new GerberParseError('Unterminated extended (%) command')
      const inner = content.slice(pos + 1, end)
      const words = inner
        .split('*')
        .map((w) => w.replace(/[\r\n]/g, '').trim())
        .filter((w) => w !== '')
      handleExtended(words)
      pos = end + 1
    } else if (c === '*' || c === '\n' || c === '\r' || c === ' ' || c === '\t') {
      pos++
    } else {
      const end = content.indexOf('*', pos)
      if (end < 0) {
        warn('Trailing content without closing * ignored')
        break
      }
      let word = content.slice(pos, end).replace(/[\r\n]/g, '')
      // Whitespace is insignificant outside comments; inside G04 the text
      // must survive so the "#@!" X2-in-comment form can be detected.
      if (/^\s*G0*4($|[^0-9])/.test(word)) word = word.trim()
      else word = word.replace(/\s/g, '')
      handleWord(word)
      pos = end + 1
    }
  }

  if (!ended) warn('Missing M02 end-of-file marker')
  if (inRegion) {
    warn('Unterminated region (G36 without G37)')
    closeRegion()
  }
  closeStepRepeat()

  if (format === null && units === null && items.length === 0) {
    throw new GerberParseError(
      'Not a Gerber file: no %FS/%MO header and no drawing commands were found.'
    )
  }

  const bounds = emptyBounds()
  let hasClear = false
  for (const item of items) {
    if (item.polarity === 'clear') hasClear = true
    else expandBoundsByShape(bounds, item.shape)
  }

  return {
    items,
    units: units ?? 'mm',
    fileFunction,
    filePolarity,
    apertureCount: apertures.size,
    hasClear,
    bounds,
    warnings
  }
}

// ---------------------------------------------------------------------------

function translateShape(shape: GerberShape, dx: number, dy: number): GerberShape {
  switch (shape.kind) {
    case 'capsule':
      return {
        ...shape,
        x0: shape.x0 + dx,
        y0: shape.y0 + dy,
        x1: shape.x1 + dx,
        y1: shape.y1 + dy
      }
    case 'rect':
    case 'circle':
    case 'ring':
    case 'arc':
      return { ...shape, cx: shape.cx + dx, cy: shape.cy + dy }
    case 'poly':
      return {
        kind: 'poly',
        outline: shape.outline.map((p) => ({ x: p.x + dx, y: p.y + dy })),
        holes: shape.holes.map((h) => h.map((p) => ({ x: p.x + dx, y: p.y + dy })))
      }
  }
}
