/**
 * Excellon drill reader — the read half of drill.ts. Turns a `.drl` file into
 * the same `DrillHit`s the writer takes, so a hole set read back from any
 * tool can be compared with ours or drawn beside its Gerbers.
 *
 * Scope: what ECAD tools emit — a header (`M48` … `%`) with units, zero mode
 * and tools; a body of tool selects and hits; slots both as `G85` and in route
 * mode (`G00` move, `M15` plunge, `G01` cuts, `M16` retract). Decimal
 * coordinates are read as written; integer ones by the header's zero mode and
 * the digit format KiCad states in its `;FORMAT={i:d/…}` comment, else the
 * usual 3.3 metric / 2.4 inch. Plating comes from the X2 attribute comments
 * (`TA.AperFunction` per tool, else `TF.FileFunction`); with neither, a hole
 * is taken as plated. A tool marked `ViaDrill` makes via holes. Coordinates stay as the file has them (mm, y-up for
 * KiCad's and ours).
 */

import type { DrillHit } from './drill'
import type { Pt } from '../schematic/placement'

export interface ExcellonImage {
  hits: DrillHit[]
  units: 'mm' | 'in'
  /** Raw TF.FileFunction attribute value (e.g. "Plated,1,2,PTH"), if present. */
  fileFunction: string | null
  warnings: string[]
}

const INCH = 25.4

interface Tool {
  diameter: number
  plated: boolean
  via: boolean
}

export function parseExcellon(content: string): ExcellonImage {
  const warnings: string[] = []
  const warn = (message: string): void => {
    if (!warnings.includes(message)) warnings.push(message)
  }

  let units: 'mm' | 'in' = 'mm'
  // Which zeros the integers keep: 'leading' (trailing suppressed) or 'trailing'.
  let kept: 'leading' | 'trailing' = 'trailing'
  let digits: { int: number; dec: number } | null = null
  let fileFunction: string | null = null
  let filePlated = true
  let pendingPlated: boolean | null = null
  let pendingVia = false
  const tools = new Map<number, Tool>()
  let tool: Tool | null = null
  let x = 0
  let y = 0
  let routing: 'off' | 'up' | 'down' = 'off'
  let cutFrom: Pt | null = null
  const hits: DrillHit[] = []

  const scale = (): number => (units === 'in' ? INCH : 1)

  const number = (raw: string): number => {
    if (raw.includes('.')) return parseFloat(raw) * scale()
    const sign = raw.startsWith('-') ? -1 : 1
    const body = raw.replace(/^[+-]/, '')
    const { int, dec } = digits ?? (units === 'in' ? { int: 2, dec: 4 } : { int: 3, dec: 3 })
    const padded = kept === 'leading' ? body.padEnd(int + dec, '0') : body
    return (sign * parseInt(padded, 10) * scale()) / Math.pow(10, dec)
  }

  /** Read the X/Y words of `text` into the modal position; true if any was there. */
  const move = (text: string): boolean => {
    const mx = /X([+-]?[\d.]+)/.exec(text)
    const my = /Y([+-]?[\d.]+)/.exec(text)
    if (mx) x = number(mx[1])
    if (my) y = number(my[1])
    return !!(mx || my)
  }

  const slot = (from: Pt, to: Pt): void => {
    if (!tool) return warn('A slot before any tool was selected is skipped')
    hits.push({
      x: (from.x + to.x) / 2,
      y: (from.y + to.y) / 2,
      diameter: tool.diameter,
      plated: tool.plated,
      slot: { from, to },
      ...(tool.via ? { via: true } : {})
    })
  }

  const defineTool = (line: string): boolean => {
    const match = /^T(\d+)((?:[A-Z][+-]?[\d.]+)*)$/.exec(line)
    if (!match) return false
    const size = /C([\d.]+)/.exec(match[2])
    if (!size) return false
    tools.set(parseInt(match[1], 10), {
      diameter: parseFloat(size[1]) * scale(),
      plated: pendingPlated ?? filePlated,
      via: pendingVia
    })
    pendingPlated = null
    pendingVia = false
    return true
  }

  let inHeader = false
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line) continue
    if (line.startsWith(';')) {
      const attribute = /^;\s*#@!\s*(T[FA])\.(\w+),(.*)$/.exec(line)
      if (attribute?.[2] === 'FileFunction') {
        fileFunction = attribute[3].trim()
        filePlated = !/^NonPlated/i.test(fileFunction)
      } else if (attribute?.[2] === 'AperFunction') {
        pendingPlated = !/^NonPlated/i.test(attribute[3].trim())
        pendingVia = /ViaDrill/i.test(attribute[3])
      }
      const format = /FORMAT=\{(\d):(\d)/.exec(line)
      if (format) digits = { int: parseInt(format[1], 10), dec: parseInt(format[2], 10) }
      continue
    }
    if (line === 'M48') {
      inHeader = true
      continue
    }
    if (inHeader && (line === '%' || line === 'M95')) {
      inHeader = false
      continue
    }
    const unitWord = /^(METRIC|INCH)(?:,(LZ|TZ))?/.exec(line)
    if (unitWord) {
      units = unitWord[1] === 'INCH' ? 'in' : 'mm'
      if (unitWord[2]) kept = unitWord[2] === 'LZ' ? 'leading' : 'trailing'
      continue
    }
    if (defineTool(line)) continue
    if (inHeader) continue

    const select = /^T(\d+)$/.exec(line)
    if (select) {
      const index = parseInt(select[1], 10)
      tool = tools.get(index) ?? null
      if (!tool && index !== 0) warn(`Tool T${index} is selected but never defined`)
      continue
    }
    if (line === 'M30' || line === 'M00') break
    if (line === 'M15') {
      if (routing === 'up') {
        routing = 'down'
        cutFrom = { x, y }
      }
      continue
    }
    if (line === 'M16' || line === 'M17') {
      if (routing !== 'off') routing = 'up'
      cutFrom = null
      continue
    }
    if (line === 'G05' || line === 'G81') {
      routing = 'off'
      cutFrom = null
      continue
    }
    const g85 = line.indexOf('G85')
    if (g85 >= 0) {
      move(line.slice(0, g85))
      const from = { x, y }
      move(line.slice(g85 + 3))
      slot(from, { x, y })
      continue
    }
    const code = /^G0?([0-3])(?!\d)/.exec(line)
    if (code) {
      routing = routing === 'down' ? 'down' : 'up'
      move(line)
      if (code[1] === '0') {
        if (routing === 'down') warn('A rapid move with the router down is read as lifted')
        routing = 'up'
        cutFrom = null
        continue
      }
      if (code[1] !== '1') warn('Routed arcs are read as straight cuts')
      if (routing === 'down' && cutFrom) {
        slot(cutFrom, { x, y })
        cutFrom = { x, y }
      }
      continue
    }
    if (/^[XY]/.test(line)) {
      move(line)
      if (routing === 'down' && cutFrom) {
        slot(cutFrom, { x, y })
        cutFrom = { x, y }
      } else if (routing === 'off') {
        if (!tool) warn('A hit before any tool was selected is skipped')
        else
          hits.push({
            x,
            y,
            diameter: tool.diameter,
            plated: tool.plated,
            ...(tool.via ? { via: true } : {})
          })
      }
      continue
    }
    if (/^(G90|G91|M71|M72|FMAT|ICI|VER|DETECT|ATC|R\d)/.test(line)) {
      if (line === 'G91') warn('Incremental coordinates are not supported; read as absolute')
      continue
    }
  }

  return { hits, units, fileFunction, warnings }
}
