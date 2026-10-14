/**
 * Gerber file identification: which files are Gerber layers, and which board
 * layer each one is. Identification prefers the X2 TF.FileFunction attribute
 * (authoritative, emitted by every modern tool) and falls back to filename
 * conventions — KiCad's `-F_Cu.gbr` suffixes and the Protel/Altium extension
 * family (.gtl/.gbs/…) that fab houses still trade in.
 *
 * Identified layers reuse KiCad layer names (`F.Cu`, `B.Mask`, …) so the
 * shared LayersPanel colors and presets apply unchanged.
 */

const GERBER_EXTENSIONS = new Set([
  'gbr',
  'ger',
  'pho',
  // Protel/Altium extension family
  'gtl',
  'gbl',
  'gts',
  'gbs',
  'gto',
  'gbo',
  'gtp',
  'gbp',
  'gko',
  'gm1',
  'gml'
])

const PROTEL_INNER_RE = /^g(?:p?)(\d+)$/

const extensionOf = (name: string): string => {
  const dot = name.lastIndexOf('.')
  return dot < 0 ? '' : name.slice(dot + 1).toLowerCase()
}

/** True when the file is (very likely) a Gerber image file. */
export const isGerberFile = (name: string): boolean => {
  const ext = extensionOf(name)
  return GERBER_EXTENSIONS.has(ext) || PROTEL_INNER_RE.test(ext)
}

/** Layer identity resolved for one Gerber file. */
export interface GerberLayerIdentity {
  /** KiCad layer name when identified (drives color + preset grouping). */
  kicadLayer: string | null
  /** Sort key: lower renders first (bottom of the stack). */
  order: number
}

/**
 * Stack order, bottom to top, mirroring BoardScene: back layers → inner
 * copper → front layers → outline on top. Unknown layers slot in just under
 * Edge.Cuts.
 */
const LAYER_ORDER: Record<string, number> = {
  'B.Fab': 0,
  'B.CrtYd': 1,
  'B.Paste': 2,
  'B.SilkS': 3,
  'B.Mask': 4,
  'B.Cu': 5,
  // Inner copper occupies 10..40 (In1 deepest toward front)
  'F.Cu': 50,
  'F.Mask': 51,
  'F.SilkS': 52,
  'F.Paste': 53,
  'F.CrtYd': 54,
  'F.Fab': 55,
  'Dwgs.User': 60,
  'Cmts.User': 61,
  'Edge.Cuts': 90
}

const UNKNOWN_ORDER = 80

const identityFor = (kicadLayer: string | null): GerberLayerIdentity => {
  if (kicadLayer === null) return { kicadLayer: null, order: UNKNOWN_ORDER }
  const inner = /^In(\d+)\.Cu$/.exec(kicadLayer)
  if (inner) {
    // In1 sits under F.Cu, deeper numbers toward the back
    return { kicadLayer, order: 49 - parseInt(inner[1], 10) }
  }
  return { kicadLayer, order: LAYER_ORDER[kicadLayer] ?? UNKNOWN_ORDER }
}

/**
 * Resolve a layer identity from the X2 TF.FileFunction value, e.g.
 * "Copper,L1,Top", "Soldermask,Bot", "Profile,NP". Returns null identity when
 * the function is missing or unrecognized.
 */
export function layerFromFileFunction(fileFunction: string | null): GerberLayerIdentity {
  if (!fileFunction) return identityFor(null)
  const parts = fileFunction.split(',').map((p) => p.trim())
  const kind = parts[0].toLowerCase()
  const side = parts.find((p) => /^(top|bot|bottom)$/i.test(p))?.toLowerCase()
  const front = side !== 'bot' && side !== 'bottom'
  switch (kind) {
    case 'copper': {
      const layerNum = parts.map((p) => /^L(\d+)$/i.exec(p)).find((m) => m !== null)
      if (side === 'top') return identityFor('F.Cu')
      if (side === 'bot' || side === 'bottom') return identityFor('B.Cu')
      if (layerNum) {
        const n = parseInt(layerNum[1], 10)
        return identityFor(n === 1 ? 'F.Cu' : `In${n - 1}.Cu`)
      }
      return identityFor(null)
    }
    case 'soldermask':
      return identityFor(front ? 'F.Mask' : 'B.Mask')
    case 'legend':
      return identityFor(front ? 'F.SilkS' : 'B.SilkS')
    case 'paste':
      return identityFor(front ? 'F.Paste' : 'B.Paste')
    case 'profile':
      return identityFor('Edge.Cuts')
    case 'assemblydrawing':
      return identityFor(front ? 'F.Fab' : 'B.Fab')
    case 'courtyard':
      return identityFor(front ? 'F.CrtYd' : 'B.CrtYd')
    case 'drawing':
    case 'other':
      return identityFor('Dwgs.User')
    default:
      return identityFor(null)
  }
}

/** KiCad plot-output suffixes (modern long and legacy short spellings). */
const KICAD_SUFFIXES: Array<[RegExp, string]> = [
  [/-F[._]Cu$/i, 'F.Cu'],
  [/-B[._]Cu$/i, 'B.Cu'],
  [/-In(\d+)[._]Cu$/i, 'In$1.Cu'],
  [/-F[._](Mask)$/i, 'F.Mask'],
  [/-B[._](Mask)$/i, 'B.Mask'],
  [/-F[._](Silkscreen|SilkS)$/i, 'F.SilkS'],
  [/-B[._](Silkscreen|SilkS)$/i, 'B.SilkS'],
  [/-F[._](Paste)$/i, 'F.Paste'],
  [/-B[._](Paste)$/i, 'B.Paste'],
  [/-F[._](Fab)$/i, 'F.Fab'],
  [/-B[._](Fab)$/i, 'B.Fab'],
  [/-F[._](Courtyard|CrtYd)$/i, 'F.CrtYd'],
  [/-B[._](Courtyard|CrtYd)$/i, 'B.CrtYd'],
  [/-(Edge[._]Cuts)$/i, 'Edge.Cuts'],
  [/-(User[._]Drawings|Dwgs[._]User)$/i, 'Dwgs.User'],
  [/-(User[._]Comments|Cmts[._]User)$/i, 'Cmts.User']
]

const PROTEL_MAP: Record<string, string> = {
  gtl: 'F.Cu',
  gbl: 'B.Cu',
  gts: 'F.Mask',
  gbs: 'B.Mask',
  gto: 'F.SilkS',
  gbo: 'B.SilkS',
  gtp: 'F.Paste',
  gbp: 'B.Paste',
  // Keepout / mechanical-1: the de-facto board outline layers
  gko: 'Edge.Cuts',
  gm1: 'Edge.Cuts',
  gml: 'Edge.Cuts'
}

/** Resolve a layer identity from the filename alone. */
export function layerFromFilename(name: string): GerberLayerIdentity {
  const ext = extensionOf(name)
  const mapped = PROTEL_MAP[ext]
  if (mapped) return identityFor(mapped)
  const innerMatch = PROTEL_INNER_RE.exec(ext)
  if (innerMatch) return identityFor(`In${parseInt(innerMatch[1], 10)}.Cu`)
  const stem = ext === '' ? name : name.slice(0, name.length - ext.length - 1)
  for (const [re, layer] of KICAD_SUFFIXES) {
    const m = re.exec(stem)
    if (m) return identityFor(layer.replace('$1', m[1] ?? ''))
  }
  return identityFor(null)
}

/** X2 attribute first, filename convention second. */
export function identifyGerberLayer(
  name: string,
  fileFunction: string | null
): GerberLayerIdentity {
  const fromAttr = layerFromFileFunction(fileFunction)
  if (fromAttr.kicadLayer !== null) return fromAttr
  return layerFromFilename(name)
}
