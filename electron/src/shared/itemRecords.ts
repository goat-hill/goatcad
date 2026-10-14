/**
 * What an agent's item record holds on each of the four documents: the item
 * kinds, the keys each kind takes on create and on update, and the KiCad
 * vocabularies their values come from. Main describes and validates records
 * from these tables (`main/ops/items/record.ts`); the renderer's doors write
 * them (`lib/*\/*Items.ts`). `recordRules.ts` holds what each key's value must be.
 *
 * Pure data: nothing here imports from outside `shared/`.
 */

/** The documents an item record lives in. */
export type RecordDocument = 'sheet' | 'symbol' | 'footprint' | 'board'

// --- KiCad vocabularies ---------------------------------------------------------

/** KiCad's stroke line styles (`LINE_STYLE`, as the file spells them). */
export const STROKE_TYPES = ['default', 'solid', 'dash', 'dot', 'dash_dot', 'dash_dot_dot'] as const

/** A schematic or symbol graphic's fill (`FILL_T`, as the file spells it). */
export const SCHEMATIC_FILL_TYPES = [
  'none',
  'outline',
  'background',
  'color',
  'hatch',
  'reverse_hatch',
  'cross_hatch'
] as const

/** A board or footprint shape's fill as the record spells it besides true and false. */
export const PCB_FILL_TYPES = ['none', 'solid'] as const

export const JUSTIFY = ['left', 'center', 'right'] as const
export const VERTICAL_JUSTIFY = ['top', 'center', 'bottom'] as const

/** KiCad's pin electrical types (`ELECTRICAL_PINTYPE`). */
export const PIN_TYPES = [
  'input',
  'output',
  'bidirectional',
  'tri_state',
  'passive',
  'free',
  'unspecified',
  'power_in',
  'power_out',
  'open_collector',
  'open_emitter',
  'no_connect'
] as const
export type PinType = (typeof PIN_TYPES)[number]

/** KiCad's pin graphic styles (`GRAPHIC_PINSHAPE`). */
export const PIN_SHAPES = [
  'line',
  'inverted',
  'clock',
  'inverted_clock',
  'input_low',
  'clock_low',
  'output_low',
  'edge_clock_high',
  'non_logic'
] as const

/** A symbol's power kind, as Symbol Properties offers it. */
export const POWER_KINDS = ['none', 'global', 'local'] as const

/** A global or hierarchical label's, or a sheet pin's, signal shape (`LABEL_FLAG_SHAPE`). */
export const LABEL_SHAPES = ['input', 'output', 'bidirectional', 'tri_state', 'passive'] as const
/** A directive label's flag. */
export const DIRECTIVE_SHAPES = ['round', 'dot', 'diamond', 'rectangle'] as const
export const LABEL_KINDS = ['local', 'global', 'hierarchical'] as const
/** The edge of its sheet a sheet pin sits on. */
export const SHEET_SIDES = ['left', 'right', 'top', 'bottom'] as const
/** A sheet symbol's mirror axis. */
export const SHEET_MIRRORS = ['x', 'y', 'none'] as const

export const PAD_TYPES = ['smd', 'thru_hole', 'np_thru_hole', 'connect'] as const
export const PAD_SHAPES = ['rect', 'roundrect', 'circle', 'oval', 'trapezoid'] as const
export const CHAMFER_CORNERS = ['top_left', 'top_right', 'bottom_left', 'bottom_right'] as const
/** A pad's or footprint's zone connection, in the order the file numbers them. */
export const ZONE_CONNECT = ['none', 'thermal', 'solid', 'thermal_tht'] as const
export const MOUNTING_TYPES = ['smd', 'through_hole', 'unspecified'] as const
/** The `(attr …)` flags beside a footprint's mounting type: record key, file token. */
export const ATTRIBUTE_FLAGS = [
  ['boardOnly', 'board_only'],
  ['excludeFromPositionFiles', 'exclude_from_pos_files'],
  ['excludeFromBom', 'exclude_from_bom'],
  ['allowMissingCourtyard', 'allow_missing_courtyard'],
  ['dnp', 'dnp']
] as const

/** KiCad 10's via types; a through via writes no marker. */
export const VIA_TYPES = ['through', 'blind', 'buried', 'micro'] as const
export const BOARD_SIDES = ['front', 'back'] as const

/** How a copper zone meets the pads it pours over. */
export const ZONE_PAD_CONNECTIONS = ['solid', 'thermal', 'thru_hole_only', 'none'] as const
/** A zone's island removal, in the order the file numbers it. */
export const ISLAND_MODES = ['remove', 'keep', 'below_area'] as const
/** What a rule area keeps out, in the order the file writes them. */
export const KEEPOUT_RULES = ['tracks', 'vias', 'pads', 'copperpour', 'footprints'] as const
export const KEEPOUT_RULE_VALUES = ['allowed', 'not_allowed'] as const
export const HATCH_STYLES = ['none', 'edge', 'full'] as const
export const ZONE_FILL_MODES = ['solid', 'hatch'] as const

// --- Key groups -------------------------------------------------------------------

/** Named groups of keys, so a description names a group once instead of its keys. */
export const KEY_GROUPS = {
  stroke: ['width', 'strokeType', 'strokeColor'],
  fill: ['fill', 'fillColor'],
  'text style': ['size', 'bold', 'italic', 'justify', 'verticalJustify', 'color'],
  'text format': ['bold', 'italic', 'justify', 'verticalJustify', 'mirror', 'knockout'],
  'table lines': [
    'borderExternal',
    'borderHeader',
    'borderWidth',
    'separatorRows',
    'separatorCols',
    'separatorWidth'
  ],
  pour: [
    'minThickness',
    'padConnection',
    'padClearance',
    'thermalGap',
    'thermalBridgeWidth',
    'islands',
    'minIslandArea'
  ],
  'hatched pour': ['fillMode', 'hatchThickness', 'hatchGap', 'hatchOrientation']
} as const

const STROKE = KEY_GROUPS.stroke
const FILL = KEY_GROUPS.fill
const TABLE_LINES = KEY_GROUPS['table lines']
const POUR = KEY_GROUPS.pour
const HATCHED_POUR = KEY_GROUPS['hatched pour']
const SHEET_TEXT_STYLE = KEY_GROUPS['text style']
/** A symbol text's style also names its pen width. */
const TEXT_STYLE = ['size', 'thickness', ...SHEET_TEXT_STYLE.slice(1)] as const
const TEXT_FORMAT = KEY_GROUPS['text format']
const PCB_STROKE = ['strokeType', 'strokeColor'] as const
const PLACED_IN = ['unit', 'style'] as const

// --- Sheet ------------------------------------------------------------------------

export const SHEET_ITEM_KINDS = [
  'symbol',
  'field',
  'label',
  'wire',
  'junction',
  'no_connect',
  'text',
  'rect',
  'sheet',
  'sheet_pin',
  'polyline',
  'circle',
  'arc',
  'bezier',
  'text_box',
  'rule_area',
  'image',
  'table',
  'bus',
  'bus_entry',
  'directive_label'
] as const
export type SheetItemKind = (typeof SHEET_ITEM_KINDS)[number]

/** What `items.update` writes on each sheet kind, keyed as `items_get` answers it. */
export const SHEET_UPDATE_KEYS: Record<SheetItemKind, readonly string[]> = {
  symbol: ['at', 'angle', 'mirror', 'dnp', 'inBom', 'onBoard', 'value', 'fields'],
  field: ['value', 'at', 'angle', 'hidden'],
  label: ['text', 'at', 'angle', 'shape', 'size', 'bold', 'italic', 'color'],
  text: ['text', 'at', 'angle', ...SHEET_TEXT_STYLE],
  sheet_pin: ['name', 'shape', 'side', 'at'],
  wire: ['at', ...STROKE],
  junction: ['at'],
  no_connect: ['at'],
  rect: ['at', 'box', ...STROKE, ...FILL],
  sheet: ['at', 'size'],
  polyline: ['at', 'points', ...STROKE],
  circle: ['at', 'center', 'radius', ...STROKE, ...FILL],
  arc: ['at', 'start', 'mid', 'end', ...STROKE, ...FILL],
  bezier: ['at', 'points', ...STROKE, ...FILL],
  text_box: ['text', 'at', 'box', ...SHEET_TEXT_STYLE, ...STROKE, ...FILL],
  rule_area: ['at', 'points', ...STROKE, ...FILL],
  image: ['at', 'scale'],
  table: ['at', 'cells', ...TABLE_LINES],
  bus: ['at', ...STROKE],
  bus_entry: ['at', 'end', ...STROKE],
  directive_label: ['at', 'shape', 'length', 'netClass', 'fields']
}

/** What `items.create` takes on each sheet kind. A bus is drawn by `schematic.wire`, as a wire is. */
export const SHEET_CREATE_KEYS = {
  label: ['text', 'labelKind', 'shape', 'pin', 'at', 'angle', 'size', 'bold', 'italic', 'color'],
  text: ['text', 'at', 'angle', ...SHEET_TEXT_STYLE],
  no_connect: ['pin', 'at'],
  junction: ['at'],
  rect: ['box', ...STROKE, ...FILL],
  sheet_pin: ['ofSheet', 'name', 'shape', 'side', 'at'],
  polyline: ['points', ...STROKE],
  circle: ['center', 'radius', ...STROKE, ...FILL],
  arc: ['start', 'mid', 'end', ...STROKE, ...FILL],
  bezier: ['points', ...STROKE, ...FILL],
  text_box: ['text', 'box', ...SHEET_TEXT_STYLE, ...STROKE, ...FILL],
  rule_area: ['points', ...STROKE, ...FILL],
  image: ['path', 'at', 'scale'],
  table: ['at', 'columnWidths', 'rowHeights', 'cells'],
  bus_entry: ['at', 'end', ...STROKE],
  directive_label: ['pin', 'at', 'shape', 'netClass', 'length']
} as const satisfies Partial<Record<SheetItemKind, readonly string[]>>
export type SheetCreateKind = keyof typeof SHEET_CREATE_KEYS
export const SHEET_CREATE_KINDS = Object.keys(SHEET_CREATE_KEYS) as SheetCreateKind[]

// --- Symbol -----------------------------------------------------------------------

export const SYMBOL_ITEM_KINDS = [
  'pin',
  'polyline',
  'rect',
  'circle',
  'arc',
  'bezier',
  'text',
  'text_box',
  'field',
  'symbol'
] as const
export type SymbolItemKind = (typeof SYMBOL_ITEM_KINDS)[number]

/** Every kind but the definition itself, whose record is Symbol Properties. */
export const SYMBOL_CREATE_KINDS = SYMBOL_ITEM_KINDS.filter(
  (kind): kind is Exclude<SymbolItemKind, 'symbol'> => kind !== 'symbol'
)
export type SymbolCreateKind = (typeof SYMBOL_CREATE_KINDS)[number]

const SYMBOL_STROKE = [...STROKE, ...FILL] as const

/** What a symbol item's record takes, on create and on update alike. */
export const SYMBOL_UPDATE_KEYS: Record<SymbolItemKind, readonly string[]> = {
  pin: [
    'number',
    'name',
    'type',
    'shape',
    'at',
    'angle',
    'length',
    'hidden',
    'nameSize',
    'numberSize',
    'alternates',
    ...PLACED_IN
  ],
  polyline: ['points', ...SYMBOL_STROKE, ...PLACED_IN],
  bezier: ['points', ...SYMBOL_STROKE, ...PLACED_IN],
  rect: ['start', 'end', ...SYMBOL_STROKE, ...PLACED_IN],
  circle: ['center', 'radius', ...SYMBOL_STROKE, ...PLACED_IN],
  arc: ['start', 'mid', 'end', ...SYMBOL_STROKE, ...PLACED_IN],
  text: ['text', 'at', 'angle', ...TEXT_STYLE, ...PLACED_IN],
  text_box: [
    'text',
    'start',
    'end',
    'angle',
    ...TEXT_STYLE,
    'margins',
    ...SYMBOL_STROKE,
    ...PLACED_IN
  ],
  field: [
    'key',
    'value',
    'at',
    'angle',
    'hidden',
    'showName',
    'doNotAutoplace',
    'private',
    ...TEXT_STYLE
  ],
  symbol: [
    'name',
    'power',
    'inBom',
    'onBoard',
    'inPositionFiles',
    'excludeFromSim',
    'duplicatePinNumbersAreJumpers',
    'showPinNames',
    'showPinNumbers',
    'pinNameOffset',
    'description',
    'keywords',
    'datasheet',
    'footprintFilters',
    'units',
    'unitNames',
    'unitsInterchangeable'
  ]
}

/** Keys a symbol record reads but no write takes. */
export const SYMBOL_READ_ONLY_KEYS: Partial<Record<SymbolItemKind, readonly string[]>> = {
  symbol: ['extends', 'styles']
}

// --- Footprint ----------------------------------------------------------------------

export const FOOTPRINT_ITEM_KINDS = [
  'pad',
  'line',
  'arc',
  'circle',
  'rect',
  'poly',
  'text',
  'property',
  'model',
  'zone',
  'footprint',
  'bezier',
  'text_box',
  'point',
  'table'
] as const
export type FootprintItemKind = (typeof FOOTPRINT_ITEM_KINDS)[number]

/** Not the footprint itself, which is always there, nor a table, which is the editor's. */
export const FOOTPRINT_CREATE_KINDS = FOOTPRINT_ITEM_KINDS.filter(
  (kind): kind is Exclude<FootprintItemKind, 'footprint' | 'table'> =>
    kind !== 'footprint' && kind !== 'table'
)
export type FootprintCreateKind = (typeof FOOTPRINT_CREATE_KINDS)[number]

const PCB_TEXT = ['size', 'thickness', ...TEXT_FORMAT] as const
const PCB_ZONE = [
  'points',
  'layers',
  'name',
  'priority',
  'keepout',
  'rules',
  ...POUR,
  'hatchStyle',
  'hatchPitch'
] as const

export const FOOTPRINT_UPDATE_KEYS: Record<FootprintItemKind, readonly string[]> = {
  footprint: ['name', 'description', 'keywords', 'locked', 'attributes', 'overrides'],
  pad: [
    'number',
    'type',
    'shape',
    'at',
    'angle',
    'size',
    'drill',
    'layers',
    'roundrectRatio',
    'chamfer',
    'rectDelta',
    'thermal',
    'clearance',
    'solderMaskMargin',
    'solderPasteMargin',
    'pasteRatio'
  ],
  line: ['layer', 'width', 'start', 'end', ...PCB_STROKE],
  arc: ['layer', 'width', 'start', 'mid', 'end', ...PCB_STROKE],
  circle: ['layer', 'width', 'center', 'end', 'fill', ...PCB_STROKE],
  rect: ['layer', 'width', 'start', 'end', 'radius', 'fill', ...PCB_STROKE],
  poly: ['layer', 'width', 'points', 'fill', ...PCB_STROKE],
  bezier: ['layer', 'width', 'points', ...PCB_STROKE],
  text: [
    'text',
    'at',
    'angle',
    'layer',
    'size',
    'thickness',
    'hidden',
    ...TEXT_FORMAT,
    'keepUpright'
  ],
  property: [
    'value',
    'at',
    'angle',
    'layer',
    'size',
    'thickness',
    'hidden',
    ...TEXT_FORMAT,
    'keepUpright'
  ],
  text_box: [
    'text',
    'start',
    'end',
    'layer',
    ...PCB_TEXT,
    'border',
    'width',
    'strokeType',
    'margins'
  ],
  table: ['layer', ...TABLE_LINES],
  point: ['at', 'size', 'layer'],
  model: ['path', 'offset', 'scale', 'rotate'],
  zone: [...PCB_ZONE]
}

export const FOOTPRINT_CREATE_KEYS = Object.fromEntries(
  FOOTPRINT_CREATE_KINDS.map((kind) => [
    kind,
    kind === 'property' ? ['key', ...FOOTPRINT_UPDATE_KEYS.property] : FOOTPRINT_UPDATE_KEYS[kind]
  ])
) as Record<FootprintCreateKind, readonly string[]>

/** Keys a footprint record reads but no write takes. */
export const FOOTPRINT_READ_ONLY_KEYS: Partial<Record<FootprintItemKind, readonly string[]>> = {
  property: ['key'],
  text_box: ['angle', 'points'],
  table: ['columns', 'rows', 'columnWidths', 'rowHeights', 'cells'],
  zone: ['holes', 'filled', 'net']
}

// --- Board --------------------------------------------------------------------------

export const BOARD_ITEM_KINDS = [
  'footprint',
  'pad',
  'track',
  'via',
  'zone',
  'line',
  'arc',
  'circle',
  'rect',
  'poly',
  'bezier',
  'text',
  'text_box',
  'point',
  'table',
  'tuning_pattern'
] as const
export type BoardItemKind = (typeof BOARD_ITEM_KINDS)[number]

/**
 * What the board editor's tools draw. Footprints arrive by sync, pads with
 * their footprint; a table and a tuning pattern are the editor's own.
 */
export const BOARD_CREATE_KINDS = [
  'track',
  'via',
  'zone',
  'line',
  'arc',
  'circle',
  'rect',
  'poly',
  'bezier',
  'text',
  'text_box',
  'point'
] as const
export type BoardCreateKind = (typeof BOARD_CREATE_KINDS)[number]

const BOARD_TEXT_BOX = [
  'text',
  'layer',
  ...PCB_TEXT,
  'border',
  'width',
  'strokeType',
  'margins',
  'start',
  'end'
] as const
const BOARD_ZONE = ['net', ...PCB_ZONE, ...HATCHED_POUR] as const

/** A pad is its footprint's and takes no update; a tuning pattern is re-tuned whole by its settings and ends. */
export const BOARD_UPDATE_KEYS: Record<BoardItemKind, readonly string[]> = {
  footprint: ['at', 'angle', 'side', 'reference', 'value', 'locked'],
  pad: [],
  track: ['start', 'mid', 'end', 'width', 'layer', 'net', 'locked'],
  via: ['at', 'size', 'drill', 'net', 'type', 'layers', 'teardrops', 'locked'],
  zone: [...BOARD_ZONE, 'locked'],
  line: ['start', 'end', 'layer', 'width', 'net', ...PCB_STROKE, 'locked'],
  arc: ['start', 'mid', 'end', 'layer', 'width', 'net', ...PCB_STROKE, 'locked'],
  circle: ['center', 'radius', 'layer', 'width', 'fill', 'net', ...PCB_STROKE, 'locked'],
  rect: ['start', 'end', 'radius', 'layer', 'width', 'fill', 'net', ...PCB_STROKE, 'locked'],
  poly: ['points', 'layer', 'width', 'fill', 'net', ...PCB_STROKE, 'locked'],
  bezier: ['points', 'layer', 'width', 'net', ...PCB_STROKE, 'locked'],
  text: ['text', 'at', 'angle', 'layer', ...PCB_TEXT, 'hidden', 'locked'],
  text_box: [...BOARD_TEXT_BOX, 'locked'],
  point: ['at', 'size', 'layer'],
  table: ['layer', ...TABLE_LINES, 'locked'],
  tuning_pattern: [
    'target',
    'overrideCustomRules',
    'minAmplitude',
    'maxAmplitude',
    'spacing',
    'initialSide',
    'singleSided',
    'rounded',
    'cornerRadiusPercent',
    'origin',
    'end'
  ]
}

export const BOARD_CREATE_KEYS: Record<BoardCreateKind, readonly string[]> = {
  track: ['points', 'layer', 'width', 'net'],
  via: ['at', 'net', 'size', 'drill', 'type', 'layers'],
  zone: [...BOARD_ZONE],
  line: ['start', 'end', 'layer', 'width', 'net', ...PCB_STROKE],
  arc: ['start', 'mid', 'end', 'layer', 'width', 'net', ...PCB_STROKE],
  circle: ['center', 'radius', 'layer', 'width', 'fill', 'net', ...PCB_STROKE],
  rect: ['start', 'end', 'radius', 'layer', 'width', 'fill', 'net', ...PCB_STROKE],
  poly: ['points', 'layer', 'width', 'fill', 'net', ...PCB_STROKE],
  bezier: ['points', 'layer', 'width', 'net', ...PCB_STROKE],
  text: ['text', 'at', 'angle', 'layer', ...PCB_TEXT],
  text_box: [...BOARD_TEXT_BOX],
  point: ['at', 'size', 'layer']
}

/** Keys a board record reads but no write takes. */
export const BOARD_READ_ONLY_KEYS: Partial<Record<BoardItemKind, readonly string[]>> = {
  text_box: ['angle', 'points'],
  table: ['columns', 'rows', 'columnWidths', 'rowHeights', 'cells'],
  tuning_pattern: ['net', 'layer', 'mode', 'length', 'status', 'tracks']
}

/** A tuning pattern's first side: KiCad's `initial_side`. */
export const TUNING_SIDES = ['left', 'right', 'default'] as const

// --- By document ----------------------------------------------------------------------

export type RecordMode = 'create' | 'update'

interface DocumentRecords {
  kinds: readonly string[]
  createKinds: readonly string[]
  update: Readonly<Record<string, readonly string[]>>
  create: Readonly<Record<string, readonly string[]>>
  readOnly: Readonly<Partial<Record<string, readonly string[]>>>
}

/** Each document's kinds and keys, for code that takes the document as an argument. */
export const RECORDS: Record<RecordDocument, DocumentRecords> = {
  sheet: {
    kinds: SHEET_ITEM_KINDS,
    createKinds: SHEET_CREATE_KINDS,
    update: SHEET_UPDATE_KEYS,
    create: SHEET_CREATE_KEYS,
    readOnly: {}
  },
  symbol: {
    kinds: SYMBOL_ITEM_KINDS,
    createKinds: SYMBOL_CREATE_KINDS,
    update: SYMBOL_UPDATE_KEYS,
    create: Object.fromEntries(SYMBOL_CREATE_KINDS.map((kind) => [kind, SYMBOL_UPDATE_KEYS[kind]])),
    readOnly: SYMBOL_READ_ONLY_KEYS
  },
  footprint: {
    kinds: FOOTPRINT_ITEM_KINDS,
    createKinds: FOOTPRINT_CREATE_KINDS,
    update: FOOTPRINT_UPDATE_KEYS,
    create: FOOTPRINT_CREATE_KEYS,
    readOnly: FOOTPRINT_READ_ONLY_KEYS
  },
  board: {
    kinds: BOARD_ITEM_KINDS,
    createKinds: BOARD_CREATE_KINDS,
    update: BOARD_UPDATE_KEYS,
    create: BOARD_CREATE_KEYS,
    readOnly: BOARD_READ_ONLY_KEYS
  }
}

/** The keys a kind takes in a mode; undefined when the document has no such kind to write. */
export const recordKeys = (
  document: RecordDocument,
  kind: string,
  mode: RecordMode
): readonly string[] | undefined => RECORDS[document][mode][kind]

/** The kinds of a document that take a key in a mode. */
export const kindsTaking = (document: RecordDocument, key: string, mode: RecordMode): string[] =>
  Object.entries(RECORDS[document][mode]).flatMap(([kind, keys]) =>
    keys.includes(key) ? [kind] : []
  )
