/**
 * Fab file names and the Gerber job file: how the Gerber and drill writers'
 * output is named under a `GerberNaming` (`lib/fabExport.ts` writes the set).
 */

import type { GerberNaming } from '../exportProfiles'
import type { GeneratedGerberLayer } from './write'
import { drillPreviewGerber } from './drill'

// ---------------------------------------------------------------------------
// File naming
// ---------------------------------------------------------------------------

/** Protel/Altium extension family (JLCPCB and most bare-board houses). */
const PROTEL_EXT: Record<string, string> = {
  'F.Cu': 'GTL',
  'B.Cu': 'GBL',
  'F.SilkS': 'GTO',
  'B.SilkS': 'GBO',
  'F.Mask': 'GTS',
  'B.Mask': 'GBS',
  'F.Paste': 'GTP',
  'B.Paste': 'GBP',
  'Edge.Cuts': 'GM1'
}

/** KiCad-style X2 filename suffix (before `.gbr`). */
const X2_SUFFIX: Record<string, string> = {
  'F.Cu': 'F_Cu',
  'B.Cu': 'B_Cu',
  'F.SilkS': 'F_Silkscreen',
  'B.SilkS': 'B_Silkscreen',
  'F.Mask': 'F_Mask',
  'B.Mask': 'B_Mask',
  'F.Paste': 'F_Paste',
  'B.Paste': 'B_Paste',
  'F.Fab': 'F_Fab',
  'B.Fab': 'B_Fab',
  'Edge.Cuts': 'Edge_Cuts'
}

/** Filename for one gerber layer under the given naming convention. */
export function gerberFileName(layer: string, base: string, naming: GerberNaming): string {
  const inner = /^In(\d+)\.Cu$/.exec(layer)
  if (naming === 'protel') {
    if (inner) return `${base}.G${inner[1]}`
    const ext = PROTEL_EXT[layer]
    if (ext) return `${base}.${ext}`
    // Fall back to X2 naming for layers protel has no slot for (fab/user).
    return `${base}-${X2_SUFFIX[layer] ?? layer.replace(/\./g, '_')}.gbr`
  }
  if (inner) return `${base}-In${inner[1]}_Cu.gbr`
  return `${base}-${X2_SUFFIX[layer] ?? layer.replace(/\./g, '_')}.gbr`
}

/** Drill filename. `suffix` distinguishes PTH/NPTH when the files are split. */
export function drillFileName(base: string, suffix?: 'PTH' | 'NPTH'): string {
  return suffix ? `${base}-${suffix}.drl` : `${base}.drl`
}

// ---------------------------------------------------------------------------
// .gbrjob (job file) — a minimal, valid summary tying the gerber set together
// ---------------------------------------------------------------------------

export function buildJobFile(
  base: string,
  gerbers: GeneratedGerberLayer[],
  naming: GerberNaming
): string {
  const job = {
    Header: {
      GenerationSoftware: { Vendor: 'GoatCAD', Application: 'GoatCAD', Version: '0.0.0' }
    },
    GeneralSpecs: {
      ProjectId: { Name: base, GUID: '', Revision: '' },
      Size: {},
      LayerNumber: gerbers.filter((g) => g.kicadLayer.endsWith('.Cu')).length
    },
    FilesAttributes: gerbers.map((g) => ({
      Path: gerberFileName(g.kicadLayer, base, naming),
      FileFunction: g.fileFunction ?? '',
      FilePolarity: 'Positive'
    }))
  }
  return JSON.stringify(job, null, 2)
}

export { drillPreviewGerber }
