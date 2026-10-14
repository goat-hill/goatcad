/**
 * The standard Gerber plot set for a board — which layers a fab package
 * includes, in package order, with the shared KiCad layer colors so the
 * Manufacture preview and the eventual composite render agree
 * (fabrication-export-workstream.md).
 *
 * Pure data + one selector: `defaultExportLayers(copperLayers)`. The real
 * exporter will consume the same set (which layers, what color) rather than
 * re-deriving it, so it lives here, tested, not inline in the view.
 */
import { KICAD_LAYER_COLORS } from './kicad/layers'

export type ExportLayerCategory = 'copper' | 'technical' | 'board'

export interface ExportLayer {
  /** KiCad layer name — drives color and the exporter's FileFunction. */
  name: string
  category: ExportLayerCategory
  /** Shared KiCad layer color (KICAD_LAYER_COLORS). */
  color: string
  /** Whether a standard fab package plots this layer by default. */
  defaultOn: boolean
}

const color = (name: string): string => KICAD_LAYER_COLORS[name] ?? '#c5d3cd'

/** Inner copper names for a board with `copperLayers` layers, front→back. */
const innerCopper = (copperLayers: number): string[] =>
  Array.from({ length: Math.max(0, copperLayers - 2) }, (_, i) => `In${i + 1}.Cu`)

/**
 * The plot set for a `copperLayers`-layer board, ordered the way a fab package
 * lists them: copper front→back, then paste, silkscreen, mask, and the board
 * outline. Paste is on by default (assembly stencils need it); fabrication and
 * courtyard layers are off (assembly drawings are M2+, not part of the bare
 * package).
 */
export function defaultExportLayers(copperLayers: number): ExportLayer[] {
  const copper: ExportLayer[] = ['F.Cu', ...innerCopper(copperLayers), 'B.Cu'].map((name) => ({
    name,
    category: 'copper',
    color: color(name),
    defaultOn: true
  }))

  const technical: ExportLayer[] = [
    'F.Paste',
    'B.Paste',
    'F.SilkS',
    'B.SilkS',
    'F.Mask',
    'B.Mask'
  ].map((name) => ({ name, category: 'technical', color: color(name), defaultOn: true }))

  const fab: ExportLayer[] = ['F.Fab', 'B.Fab'].map((name) => ({
    name,
    category: 'technical',
    color: color(name),
    defaultOn: false
  }))

  const board: ExportLayer[] = [
    { name: 'Edge.Cuts', category: 'board', color: color('Edge.Cuts'), defaultOn: true }
  ]

  return [...copper, ...technical, ...fab, ...board]
}
