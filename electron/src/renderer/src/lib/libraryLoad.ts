/**
 * A library symbol or footprint by lib id, read and parsed from the file the
 * library index names — what the chooser previews, Place Footprint lands and
 * the agent's board door instantiates.
 */
import { parseKicadFootprint, type KicadFootprint } from './kicad/footprint'
import {
  addSchematicSymbolToAST,
  ensureLibSymbolsInAST,
  getLibSymbolProperty,
  libSymbolChain,
  libSymbolUnitCount,
  libSymbolUnitPins,
  parseKicadSchematic,
  serializeKicadSchematic,
  type KicadLibSymbol,
  type KicadSchematic
} from './kicad/schematic'
import { namespaceSymbolLibrary } from './kicad/symbolLibrary'
import { nm } from './kicad/coordinates'
import { findFootprint, findSymbol, indexLoaded, loadIndex } from './libraryIndex'
import type { PinRef } from './pinPadMatch'

const ensureIndex = async (): Promise<void> => {
  if (!indexLoaded()) await loadIndex().catch(() => {})
}

/** Parse a `.kicad_mod` file; null when unreadable or malformed. */
export async function readFootprintFile(file: string): Promise<KicadFootprint | null> {
  const result = await window.api.readFile(file)
  if (!result.success || typeof result.content !== 'string') return null
  try {
    return parseKicadFootprint(result.content)
  } catch {
    return null
  }
}

/** A library footprint by lib id; null when no library holds it. */
export async function loadLibraryFootprint(libId: string): Promise<KicadFootprint | null> {
  await ensureIndex()
  const record = findFootprint(libId)
  return record ? readFootprintFile(record.file) : null
}

/** A library symbol by lib id, with the chain it extends; null when no library holds it. */
export async function loadLibrarySymbol(libId: string): Promise<KicadLibSymbol[] | null> {
  await ensureIndex()
  const record = findSymbol(libId)
  if (!record) return null
  const result = await window.api.readSymbolLibrary(record.file)
  if (!result.success || !result.content) return null
  try {
    const parsed = namespaceSymbolLibrary(result.content, record.library)
    const definition = parsed.doc.libSymbols.get(`${record.library}:${record.name}`)
    return definition ? libSymbolChain(definition, (name) => parsed.doc.libSymbols.get(name)) : null
  } catch {
    return null
  }
}

/** Every pin of every unit, once per number. */
export function libSymbolPins(chain: KicadLibSymbol[]): PinRef[] {
  const pins = new Map<string, PinRef>()
  for (let unit = 1; unit <= libSymbolUnitCount(chain); unit++) {
    for (const pin of libSymbolUnitPins(chain, unit)) {
      if (!pins.has(pin.number)) pins.set(pin.number, { number: pin.number, name: pin.name })
    }
  }
  return [...pins.values()]
}

const PREVIEW_ROOT = '00000000-0000-0000-0000-000000000001'
const PREVIEW_SHEET = `(kicad_sch (version 20231120) (generator "goatcad") (uuid "${PREVIEW_ROOT}") (paper "A4") (lib_symbols) (sheet_instances (path "/" (page "1"))))`

/**
 * A symbol drawn alone: symbols render only as placed instances, so the
 * preview is a one-part sheet with the definition at the origin — the
 * chooser's preview, and the placement ghost, which passes the unit, turn,
 * flip, reference and fields the click will write so the ghost is what lands.
 */
/** The reference a lone preview of this symbol shows: its prefix, numbered 1 (`D1`). */
export function previewReference(chain: KicadLibSymbol[]): string {
  const prefix = (getLibSymbolProperty(chain[0], 'Reference') ?? 'U').replace(/[?\d]+$/, '') || 'U'
  return `${prefix}1`
}

export function symbolPreviewSheet(
  chain: KicadLibSymbol[],
  placed: {
    unit?: number
    angle?: number
    mirror?: 'x' | 'y'
    reference?: string
    fields?: Record<string, string>
  } = {}
): KicadSchematic {
  const [definition] = chain
  const doc = parseKicadSchematic(PREVIEW_SHEET)
  const unit = placed.unit ?? 1
  ensureLibSymbolsInAST(doc, chain)
  addSchematicSymbolToAST(
    doc,
    definition,
    { x: nm(0), y: nm(0), angle: placed.angle ?? 0, mirror: placed.mirror },
    placed.reference ?? previewReference(chain),
    libSymbolUnitPins(chain, unit),
    [{ project: 'lib', path: `/${PREVIEW_ROOT}` }],
    unit,
    1,
    placed.fields ?? {}
  )
  // Re-parse so the domain arrays the viewport reads are rebuilt.
  return parseKicadSchematic(serializeKicadSchematic(doc))
}

/** The fields a placed footprint carries, for a preview that shows it placed. */
export interface PreviewFields {
  reference?: string
  value?: string
}

/**
 * A library footprint as it would read once placed — its Reference and Value
 * text the part's (`D1`, `LED`) rather than the library's `REF**` and its own
 * name — for previews only. A copy: the library's parse and file are untouched.
 */
export function withPreviewFields(
  footprint: KicadFootprint,
  fields: PreviewFields
): KicadFootprint {
  const swap = (key: string, value: string): string =>
    key === 'Reference' || key === 'reference'
      ? (fields.reference ?? value)
      : key === 'Value' || key === 'value'
        ? (fields.value ?? value)
        : value
  return {
    ...footprint,
    properties: footprint.properties.map((property) => ({
      ...property,
      value: swap(property.key, property.value)
    })),
    fpTexts: footprint.fpTexts.map((text) => ({ ...text, text: swap(text.type, text.text) }))
  }
}
