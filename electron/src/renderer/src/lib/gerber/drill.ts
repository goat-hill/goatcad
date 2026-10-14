/**
 * Excellon drill writer — the drill half of the fab package (fabrication-export
 * §5b, gerber-viewer Phase 2/3). Collects every hole in a `KicadBoard` (plated
 * pads + vias, non-plated mounting holes) and emits a KiCad-style Excellon file,
 * plus a synthetic "Drills" Gerber so the composite preview can show real holes
 * before there is an Excellon *reader* in-app.
 *
 * Coordinates match the Gerber writer exactly (mm, y-up) so a via flash and its
 * drill hit coincide when both layers are composited.
 *
 * An oval drill is a slot, written as KiCad's default Excellon writes one: a
 * `G85` routed hit between the slot's two end centers with a tool the slot's
 * width (`kicad-cli pcb export drill`, `--excellon-oval-format alternate`).
 */

import type { KicadBoard } from '../kicad/board'
import { footprintTransform, tfPoint, worldPoint, type Pt } from '../schematic/placement'
import { nm, nmToMm } from '../kicad/coordinates'

export interface DrillHit {
  x: number
  y: number
  /** Finished hole diameter in mm; a slot's width. */
  diameter: number
  /** Plated-through (pad thru-hole / via) vs. a bare mechanical hole. */
  plated: boolean
  /** A slot's two end centers; absent for a round hole. `x`, `y` is its middle. */
  slot?: { from: Pt; to: Pt }
  /** A via's hole rather than a pad's. */
  via?: boolean
}

export interface DrillOptions {
  /** Which holes the file holds: both platings merged (the default), or one. */
  file?: 'mixed' | 'pth' | 'npth'
  /** The board's copper layer count, for the file's X2 `TF.FileFunction` span. */
  copperLayers?: number
}

/** Collect every drilled hole in the board, in Gerber world coordinates. */
export function collectDrillHits(board: KicadBoard): DrillHit[] {
  const hits: DrillHit[] = []
  for (const bfp of board.footprints) {
    const tf = footprintTransform(bfp)
    for (const pad of bfp.footprint.pads) {
      if (pad.type !== 'thru_hole' && pad.type !== 'np_thru_hole') continue
      if (!pad.drill || pad.drill.diameter <= 0) continue
      const c = tfPoint(tf, pad.position.x, pad.position.y)
      const plated = pad.type === 'thru_hole'
      const oval = pad.drill.oval
      if (!oval || oval.width === oval.height) {
        hits.push({ x: c.x, y: c.y, diameter: nmToMm(nm(pad.drill.diameter)), plated })
        continue
      }
      // The slot runs along the pad's longer drill axis; a pad's angle is absolute.
      const width = nmToMm(nm(Math.min(oval.width, oval.height)))
      const half = (nmToMm(nm(Math.max(oval.width, oval.height))) - width) / 2
      const a = ((pad.position.angle ?? 0) * Math.PI) / 180
      // Pad-local x is (cos, sin) in the world, pad-local y (KiCad's down) is (sin, -cos).
      const [ux, uy] =
        oval.width > oval.height ? [Math.cos(a), Math.sin(a)] : [Math.sin(a), -Math.cos(a)]
      hits.push({
        x: c.x,
        y: c.y,
        diameter: width,
        plated,
        slot: {
          from: { x: c.x - ux * half, y: c.y - uy * half },
          to: { x: c.x + ux * half, y: c.y + uy * half }
        }
      })
    }
  }
  for (const via of board.vias) {
    if (via.drill <= 0) continue
    const p = worldPoint(via.position)
    hits.push({ x: p.x, y: p.y, diameter: nmToMm(via.drill), plated: true, via: true })
  }
  return hits
}

/** Round a hole diameter to a tool key (µm) so near-equal holes share a tool. */
const toolKey = (d: number): number => Math.round(d * 1000)

interface Tool {
  index: number
  diameter: number
  plated: boolean
  via: boolean
  hits: DrillHit[]
}

/**
 * One tool per diameter, plating and role, as KiCad keys them: a plated and a
 * non-plated hole of one size never share a tool, so a merged file still says
 * which is which.
 */
function groupTools(hits: DrillHit[]): Tool[] {
  const byKey = new Map<string, Tool>()
  for (const hit of hits) {
    const diameter = toolKey(hit.diameter)
    const via = !!hit.via
    const key = `${diameter}/${hit.plated}/${via}`
    const tool = byKey.get(key)
    if (tool) tool.hits.push(hit)
    else
      byKey.set(key, { index: 0, diameter: diameter / 1000, plated: hit.plated, via, hits: [hit] })
  }
  return [...byKey.values()]
    .sort(
      (a, b) =>
        a.diameter - b.diameter ||
        Number(a.plated) - Number(b.plated) ||
        Number(b.via) - Number(a.via)
    )
    .map((tool, i) => ({ ...tool, index: i + 1 }))
}

/** A tool's X2 role, as KiCad's Excellon writer comments it. */
const aperFunction = (tool: Tool): string =>
  !tool.plated
    ? 'NonPlated,NPTH,ComponentDrill'
    : tool.via
      ? 'Plated,PTH,ViaDrill'
      : 'Plated,PTH,ComponentDrill'

/** The file's X2 function: its plating, then the copper span it drills. */
const fileFunction = (file: 'mixed' | 'pth' | 'npth', copperLayers: number): string =>
  file === 'mixed'
    ? `MixedPlating,1,${copperLayers}`
    : file === 'pth'
      ? `Plated,1,${copperLayers},PTH`
      : `NonPlated,1,${copperLayers},NPTH`

/**
 * A decimal coordinate always carries its point: Excellon reads a bare integer
 * by the file's zero-suppression rule, so `X55` is not 55 mm to a fab's CAM.
 */
const coord = (v: number): string => {
  const text = parseFloat(v.toFixed(4)).toString()
  return text.includes('.') ? text : `${text}.0`
}

/**
 * Write an Excellon (.drl) file for the given hits. Metric, absolute, decimal —
 * the format modern fabs and our own reader expect — with KiCad's X2 attribute
 * comments. Pass a filtered hit list (all / plated / non-plated) and the
 * matching `file` depending on whether PTH and NPTH are merged.
 */
export function writeExcellon(hits: DrillHit[], options: DrillOptions = {}): string {
  const tools = groupTools(hits)
  const lines: string[] = []
  lines.push('M48')
  lines.push(';DRILL file {GoatCAD}')
  lines.push(';FORMAT={-:-/ absolute / metric / decimal}')
  if (options.copperLayers)
    lines.push(
      `; #@! TF.FileFunction,${fileFunction(options.file ?? 'mixed', options.copperLayers)}`
    )
  lines.push('FMAT,2')
  lines.push('METRIC')
  for (const tool of tools) {
    lines.push(`; #@! TA.AperFunction,${aperFunction(tool)}`)
    lines.push(`T${tool.index}C${coord(tool.diameter)}`)
  }
  lines.push('%')
  lines.push('G90') // absolute
  lines.push('G05') // drill mode
  // Round holes tool by tool, then slots tool by tool, as KiCad orders them.
  for (const slots of [false, true]) {
    for (const tool of tools) {
      const hits = tool.hits.filter((hit) => !!hit.slot === slots)
      if (hits.length === 0) continue
      lines.push(`T${tool.index}`)
      for (const hit of hits) {
        if (!hit.slot) {
          lines.push(`X${coord(hit.x)}Y${coord(hit.y)}`)
          continue
        }
        const { from, to } = hit.slot
        lines.push(`X${coord(from.x)}Y${coord(from.y)}G85X${coord(to.x)}Y${coord(to.y)}`)
        // G85 leaves the machine routing; G05 puts it back in drill mode.
        lines.push('G05')
      }
    }
  }
  lines.push('T0')
  lines.push('M30')
  return lines.join('\n') + '\n'
}

/**
 * A tiny Gerber image of the drill hits (a C flash per hole, a draw per slot), for the
 * composite preview's synthetic "Drills" layer. This is preview-only — the real
 * deliverable is the Excellon file above.
 */
export function drillPreviewGerber(hits: DrillHit[]): string {
  const scale = 1e6
  const num = (mm: number): string => String(Math.round(mm * scale))
  const byDiam = new Map<number, DrillHit[]>()
  for (const hit of hits) {
    const key = toolKey(hit.diameter)
    const list = byDiam.get(key)
    if (list) list.push(hit)
    else byDiam.set(key, [hit])
  }
  const lines: string[] = []
  lines.push('%TF.FileFunction,Other,Drill*%')
  lines.push('%FSLAX46Y46*%')
  lines.push('%MOMM*%')
  lines.push('%LPD*%')
  lines.push('G01*')
  let dCode = 10
  const apertureFor = new Map<number, number>()
  for (const [key, _list] of [...byDiam.entries()].sort((a, b) => a[0] - b[0])) {
    void _list
    apertureFor.set(key, dCode)
    lines.push(`%ADD${dCode}C,${parseFloat((key / 1000).toFixed(6))}*%`)
    dCode++
  }
  for (const [key, list] of byDiam) {
    lines.push(`D${apertureFor.get(key)}*`)
    for (const hit of list) {
      if (!hit.slot) lines.push(`X${num(hit.x)}Y${num(hit.y)}D03*`)
      else {
        const { from, to } = hit.slot
        lines.push(`X${num(from.x)}Y${num(from.y)}D02*`, `X${num(to.x)}Y${num(to.y)}D01*`)
      }
    }
  }
  lines.push('M02*')
  return lines.join('\n') + '\n'
}

/** Split hits into plated / non-plated for separate PTH/NPTH files. */
export function partitionHits(hits: DrillHit[]): { plated: DrillHit[]; nonPlated: DrillHit[] } {
  return {
    plated: hits.filter((h) => h.plated),
    nonPlated: hits.filter((h) => !h.plated)
  }
}
