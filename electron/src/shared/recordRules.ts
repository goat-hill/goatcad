/**
 * What each key of an item record must hold, on every document, and the one
 * check that holds a record to it. Main runs `checkRecord` on every
 * `items.create` and `items.update` (and each batch's entries) before the
 * request crosses the bridge; a door runs it again with the item's kind once
 * the id has resolved, since an update names an id, not a kind.
 *
 * A key whose meaning is the same everywhere has one rule (`COMMON`). Where
 * KiCad's meaning differs by document the rule is the document's (a sheet's
 * angle turns by quarter turns, a board's fill is on or off), and where it
 * differs by kind, the kind's (a pad's size is its width and height).
 *
 * Pure: nothing here imports from outside `shared/`.
 */
import {
  ATTRIBUTE_FLAGS,
  BOARD_SIDES,
  CHAMFER_CORNERS,
  DIRECTIVE_SHAPES,
  HATCH_STYLES,
  ISLAND_MODES,
  JUSTIFY,
  KEEPOUT_RULE_VALUES,
  KEEPOUT_RULES,
  LABEL_KINDS,
  LABEL_SHAPES,
  MOUNTING_TYPES,
  PAD_SHAPES,
  PAD_TYPES,
  PCB_FILL_TYPES,
  PIN_SHAPES,
  PIN_TYPES,
  POWER_KINDS,
  RECORDS,
  SCHEMATIC_FILL_TYPES,
  SHEET_MIRRORS,
  SHEET_SIDES,
  STROKE_TYPES,
  TUNING_SIDES,
  VERTICAL_JUSTIFY,
  VIA_TYPES,
  ZONE_CONNECT,
  ZONE_FILL_MODES,
  ZONE_PAD_CONNECTIONS,
  type RecordDocument,
  type RecordMode
} from './itemRecords'

/** What a key's value must be: the check, and the phrase that says it ("<kind>.<key> must be <expects>."). */
export interface Rule {
  check: (value: unknown) => boolean
  expects: string
  /** The failure kind when it is finer than `invalid-record`. */
  error?: string
  /** An object whose keys are each optional and each checked by their own rule. */
  fields?: Record<string, Rule>
}

// --- Primitives -----------------------------------------------------------------------

type Check = (value: unknown) => boolean

export const isNumber: Check = (v) => typeof v === 'number' && Number.isFinite(v)
export const isPositive: Check = (v) => isNumber(v) && (v as number) > 0
/** A length that may be 0. */
export const isLength: Check = (v) => isNumber(v) && (v as number) >= 0
export const isString: Check = (v) => typeof v === 'string'
export const isText: Check = (v) => typeof v === 'string' && v.length > 0
export const isName: Check = (v) => typeof v === 'string' && v.trim().length > 0
export const isBoolean: Check = (v) => typeof v === 'boolean'
export const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)
/** An object holding no key but `keys`: a stray one is refused, never ignored. */
const isClosed = (v: unknown, keys: readonly string[]): v is Record<string, unknown> =>
  isObject(v) && Object.keys(v).every((key) => keys.includes(key))
export const isPoint = (v: unknown): v is { x: number; y: number } =>
  isClosed(v, ['x', 'y']) && isNumber(v.x) && isNumber(v.y)
const isXYZ: Check = (v) =>
  isClosed(v, ['x', 'y', 'z']) && isNumber(v.x) && isNumber(v.y) && isNumber(v.z)
/** A positive {width, height} and nothing else. */
const isPositiveSize = (v: unknown): boolean =>
  isClosed(v, ['width', 'height']) && isPositive(v.width) && isPositive(v.height)
const isWholeCount: Check = (v) => Number.isInteger(v) && (v as number) >= 0
export const oneOf =
  (values: readonly string[]): Check =>
  (v) =>
    typeof v === 'string' && values.includes(v)
const pointCount =
  (min: number, max = Infinity): Check =>
  (v) =>
    Array.isArray(v) && v.length >= min && v.length <= max && v.every(isPoint)

/** `#rrggbb` or `#rrggbbaa`, either case: a color as a record writes it. */
export const HEX_COLOR = /^#([0-9a-f]{6})([0-9a-f]{2})?$/i
export const isHexColor = (v: unknown): v is string => typeof v === 'string' && HEX_COLOR.test(v)

const rule = (check: Check, expects: string, extra?: Pick<Rule, 'error' | 'fields'>): Rule => ({
  check,
  expects,
  ...extra
})
const choice = (values: readonly string[]): Rule =>
  rule(oneOf(values), `one of ${values.join(', ')}`)
const nullable = (base: Rule, meaning: string): Rule =>
  rule((v) => v === null || base.check(v), `${base.expects}, or null ${meaning}`)
const BOOLEAN = rule(isBoolean, 'true or false')
const STRING = rule(isString, 'a string')
const POINT = rule(isPoint, '{x, y} in millimeters')
const LENGTH = rule(isLength, 'millimeters, 0 or more')
const POSITIVE = rule(isPositive, 'a positive length in millimeters')
/** A pad's or via's teardrop settings: lengths in millimeters, ratios as fractions. */
const TEARDROP_KEYS: Record<string, Check> = {
  enabled: isBoolean,
  bestLengthRatio: (v) => isNumber(v) && (v as number) >= 0,
  maxLength: isLength,
  bestWidthRatio: (v) => isNumber(v) && (v as number) >= 0 && (v as number) <= 1,
  maxWidth: isLength,
  curvedEdges: isBoolean,
  filterRatio: (v) => isNumber(v) && (v as number) >= 0 && (v as number) <= 1,
  allowTwoSegments: isBoolean,
  preferZoneConnections: isBoolean
}
const TEARDROPS = rule(
  (v) => isObject(v) && Object.entries(v).every(([k, x]) => TEARDROP_KEYS[k]?.(x) === true),
  `an object of ${Object.keys(TEARDROP_KEYS).join(', ')} (ratios 0 to 1, lengths in millimeters)`
)
const DEGREES = rule(isNumber, 'degrees, counterclockwise')
const COLOR = rule(
  (v) => v === null || isHexColor(v),
  '"#rrggbb" or "#rrggbbaa", or null for the default'
)
const points = (min: number, max = Infinity): Rule =>
  rule(
    pointCount(min, max),
    min === max
      ? `exactly ${min} {x, y} in millimeters`
      : `${min === 2 ? 'two' : 'three'} or more {x, y} in millimeters`
  )
/** An object of optional keys, each by its own rule; `nonEmpty` when sending none means nothing. */
const fieldsOf = (fields: Record<string, Rule>, nonEmpty = false): Rule =>
  rule(
    (v) => isObject(v) && (!nonEmpty || Object.keys(v).length > 0),
    `{${Object.keys(fields).join(', ')}}${nonEmpty ? ', any of them' : ''}`,
    { fields }
  )

// --- One rule per key, where the key means the same on every document ------------------

const COMMON: Record<string, Rule> = {
  at: POINT,
  start: POINT,
  mid: POINT,
  end: POINT,
  center: POINT,
  points: points(2),
  angle: DEGREES,
  text: rule(isText, 'non-empty text'),
  value: STRING,
  name: rule(isName, 'a non-empty name'),
  hidden: BOOLEAN,
  locked: BOOLEAN,
  bold: BOOLEAN,
  italic: BOOLEAN,
  knockout: BOOLEAN,
  keepUpright: BOOLEAN,
  border: BOOLEAN,
  justify: choice(JUSTIFY),
  verticalJustify: choice(VERTICAL_JUSTIFY),
  strokeType: choice(STROKE_TYPES),
  strokeColor: COLOR,
  fillColor: COLOR,
  color: COLOR,
  radius: POSITIVE,
  description: STRING,
  keywords: rule(isString, 'space-separated words'),
  margins: fieldsOf({ left: LENGTH, top: LENGTH, right: LENGTH, bottom: LENGTH }, true),
  borderExternal: BOOLEAN,
  borderHeader: BOOLEAN,
  borderWidth: LENGTH,
  separatorRows: BOOLEAN,
  separatorCols: BOOLEAN,
  separatorWidth: LENGTH,
  dnp: BOOLEAN,
  inBom: BOOLEAN,
  onBoard: BOOLEAN
}

// --- Where KiCad's meaning differs by document -------------------------------------------

/** Sheet and symbol: KiCad's schematic graphics. */
const SCHEMATIC_STYLE: Record<string, Rule> = {
  width: rule(isLength, 'a stroke width in millimeters, 0 for the default'),
  fill: choice(SCHEMATIC_FILL_TYPES)
}

const GLYPH_HEIGHT = rule(
  (v) => isNumber(v) && (v as number) >= 0.5 && (v as number) <= 10,
  'a glyph height from 0.5 to 10 mm'
)

const SHEET: Record<string, Rule> = {
  ...SCHEMATIC_STYLE,
  angle: rule((v) => isNumber(v) && (v as number) % 90 === 0, 'a multiple of 90 degrees'),
  // An empty label or text is a shipped write; a sheet does not refuse it.
  text: STRING,
  mirror: choice(SHEET_MIRRORS),
  size: GLYPH_HEIGHT,
  shape: choice(LABEL_SHAPES),
  side: choice(SHEET_SIDES),
  fields: rule(
    (v) => isObject(v) && Object.values(v).every(isString),
    'field values by name, e.g. {"Value": "10k"}'
  ),
  labelKind: choice(LABEL_KINDS),
  pin: rule(isName, 'a pin id, e.g. "U3.10"'),
  ofSheet: rule(isName, 'a sheet id'),
  box: rule(
    (v) =>
      isObject(v) &&
      Object.keys(v).length === 4 &&
      ['x', 'y', 'width', 'height'].every((key) => isNumber(v[key])),
    '{x, y, width, height} in millimeters'
  ),
  path: rule(isName, 'a picture file path, absolute or relative to the sheet'),
  scale: rule(isPositive, 'a positive number, 1 for the picture as its resolution sizes it'),
  columnWidths: rule(
    (v) => Array.isArray(v) && v.length > 0 && v.every(isPositive),
    'one positive width in millimeters per column'
  ),
  rowHeights: rule(
    (v) => Array.isArray(v) && v.length > 0 && v.every(isPositive),
    'one positive height in millimeters per row'
  ),
  cells: rule(
    (v) => Array.isArray(v) && v.every((row) => Array.isArray(row) && row.every(isString)),
    'rows of cell texts, e.g. [["Net", "Class"], ["VBUS", "Power"]]'
  ),
  netClass: rule(isString, 'a net class name'),
  length: POSITIVE
}

const SYMBOL: Record<string, Rule> = {
  ...SCHEMATIC_STYLE,
  number: rule(isText, 'a non-empty string'),
  name: rule(isString, 'a string ("" for none)'),
  type: choice(PIN_TYPES),
  shape: choice(PIN_SHAPES),
  length: LENGTH,
  nameSize: POSITIVE,
  numberSize: POSITIVE,
  size: POSITIVE,
  // A schematic text draws at the default pen width until it names one.
  thickness: nullable(POSITIVE, 'for auto'),
  alternates: rule(
    (v) =>
      Array.isArray(v) &&
      v.every(
        (entry) =>
          isObject(entry) &&
          Object.keys(entry).every((key) => ['name', 'type', 'shape'].includes(key)) &&
          isName(entry.name) &&
          (entry.type === undefined || oneOf(PIN_TYPES)(entry.type)) &&
          (entry.shape === undefined || oneOf(PIN_SHAPES)(entry.shape))
      ) &&
      new Set(v.map((entry) => (entry as { name: string }).name.trim())).size === v.length,
    '[{name, type?, shape?}] with distinct names ([] for none)'
  ),
  key: rule(isName, 'a field name'),
  showName: BOOLEAN,
  doNotAutoplace: BOOLEAN,
  private: BOOLEAN,
  unit: rule(isWholeCount, 'a unit number, 0 for all units'),
  style: rule(isWholeCount, 'a body style number, 0 for all styles'),
  power: choice(POWER_KINDS),
  inPositionFiles: BOOLEAN,
  excludeFromSim: BOOLEAN,
  duplicatePinNumbersAreJumpers: BOOLEAN,
  showPinNames: BOOLEAN,
  showPinNumbers: BOOLEAN,
  pinNameOffset: LENGTH,
  datasheet: STRING,
  footprintFilters: rule(
    (v) => Array.isArray(v) && v.every((entry) => isString(entry) && !/\s/.test(entry)),
    'an array of patterns without spaces, e.g. ["SOIC*"]'
  ),
  units: rule((v) => Number.isInteger(v) && (v as number) >= 1, 'a unit count, 1 or more'),
  unitNames: rule(
    (v) => Array.isArray(v) && v.every(isString),
    'one string per unit ("" for its letter)'
  ),
  unitsInterchangeable: BOOLEAN
}

const isCopperLayer = (v: unknown): boolean => typeof v === 'string' && /(^\*|\.)Cu$/.test(v)

/** A text's size on a board or footprint: one glyph height, or a width and height. */
const PCB_TEXT_SIZE = rule(
  (v) => isPositive(v) || isPositiveSize(v),
  'millimeters, or {width, height}'
)

/** Whether a board or footprint shape's `fill` turns it on. */
export const isPcbFillOn = (v: unknown): boolean => v === true || v === 'solid'

/** Board and footprint: KiCad's PCB graphics, texts and zones. */
const PCB: Record<string, Rule> = {
  width: LENGTH,
  // KiCad's PCB shapes are filled or not, read as the editor names it; true and false still write.
  fill: rule(
    (v) => isBoolean(v) || oneOf(PCB_FILL_TYPES)(v),
    `"${PCB_FILL_TYPES.join('" or "')}" (true and false alike)`
  ),
  points: points(3),
  layer: rule(isName, 'a layer name'),
  size: PCB_TEXT_SIZE,
  thickness: POSITIVE,
  mirror: BOOLEAN,
  priority: rule(
    (v) => Number.isInteger(v) && (v as number) >= 0,
    'a whole number, 0 or more; higher pours first'
  ),
  keepout: rule(isBoolean, 'true (a rule area) or false (a copper zone)', {
    error: 'keepout-shape'
  }),
  rules: rule(
    (v) =>
      isObject(v) &&
      Object.entries(v).every(
        ([key, value]) => oneOf(KEEPOUT_RULES)(key) && oneOf(KEEPOUT_RULE_VALUES)(value)
      ),
    `{${KEEPOUT_RULES.join(', ')}}, each "allowed" or "not_allowed"`
  ),
  minThickness: LENGTH,
  padConnection: choice(ZONE_PAD_CONNECTIONS),
  padClearance: LENGTH,
  thermalGap: LENGTH,
  thermalBridgeWidth: LENGTH,
  islands: choice(ISLAND_MODES),
  minIslandArea: rule(isLength, 'square millimeters, 0 or more'),
  hatchStyle: choice(HATCH_STYLES),
  hatchPitch: POSITIVE
}

/** An override: a value, or null to inherit the footprint's or the board's. */
const inheriting = (base: Rule): Rule => nullable(base, 'to inherit')
const PASTE_RATIO = rule(
  (v) => isNumber(v) && (v as number) >= -1 && (v as number) <= 1,
  'a fraction such as -0.2'
)

const FOOTPRINT: Record<string, Rule> = {
  ...PCB,
  number: STRING,
  type: choice(PAD_TYPES),
  shape: choice(PAD_SHAPES),
  drill: rule(
    (v) =>
      isClosed(v, ['diameter', 'oval', 'offset']) &&
      isPositive(v.diameter) &&
      (v.oval === undefined || isPositiveSize(v.oval)) &&
      (v.offset === undefined || isPoint(v.offset)),
    '{diameter, oval?: {width, height}, offset?: {x, y}}'
  ),
  layers: rule(
    (v) => Array.isArray(v) && v.length > 0 && v.every(isName),
    'a non-empty list of layer names'
  ),
  roundrectRatio: rule(
    (v) => isNumber(v) && (v as number) >= 0 && (v as number) <= 0.5,
    'a ratio from 0 to 0.5'
  ),
  chamfer: rule(
    (v) =>
      isClosed(v, ['ratio', 'corners']) &&
      isNumber(v.ratio) &&
      (v.ratio as number) >= 0 &&
      (v.ratio as number) <= 0.5 &&
      Array.isArray(v.corners) &&
      v.corners.every(oneOf(CHAMFER_CORNERS)),
    `{ratio (0 to 0.5), corners: [${CHAMFER_CORNERS.join(' | ')}]}`
  ),
  rectDelta: rule(isPoint, '{x, y} in millimeters, how much wider one end is'),
  thermal: rule(
    (v) =>
      isClosed(v, ['bridgeWidth', 'gap', 'zoneConnect']) &&
      (v.bridgeWidth === undefined || isPositive(v.bridgeWidth)) &&
      (v.gap === undefined || isPositive(v.gap)) &&
      (v.zoneConnect === undefined || oneOf(ZONE_CONNECT)(v.zoneConnect)),
    `{bridgeWidth?, gap?, zoneConnect?: ${ZONE_CONNECT.join(' | ')}}`
  ),
  clearance: inheriting(LENGTH),
  solderMaskMargin: inheriting(rule(isNumber, 'millimeters')),
  solderPasteMargin: inheriting(rule(isNumber, 'millimeters')),
  pasteRatio: inheriting(PASTE_RATIO),
  key: rule(isName, 'a property name'),
  path: rule(isText, 'a model path'),
  offset: rule(isXYZ, '{x, y, z} in millimeters'),
  scale: rule(isXYZ, '{x, y, z}'),
  rotate: rule(isXYZ, '{x, y, z} in degrees'),
  attributes: fieldsOf({
    type: choice(MOUNTING_TYPES),
    ...Object.fromEntries(ATTRIBUTE_FLAGS.map(([key]) => [key, BOOLEAN]))
  }),
  overrides: fieldsOf({
    clearance: inheriting(LENGTH),
    solderMaskMargin: inheriting(rule(isNumber, 'millimeters')),
    solderPasteMargin: inheriting(rule(isNumber, 'millimeters')),
    solderPasteRatio: inheriting(PASTE_RATIO),
    zoneConnect: inheriting(choice(ZONE_CONNECT)),
    allowSolderMaskBridges: BOOLEAN
  })
}

const BOARD: Record<string, Rule> = {
  ...PCB,
  side: choice(BOARD_SIDES),
  reference: rule(isName, 'non-empty text'),
  net: rule(isString, 'a net name, "" for none'),
  size: POSITIVE,
  drill: POSITIVE,
  type: choice(VIA_TYPES),
  layers: rule(
    (v) => (Array.isArray(v) && v.length > 0 && v.every(isName)) || (typeof v === 'string' && !!v),
    'a list of copper layer names, e.g. ["F.Cu", "B.Cu"]'
  ),
  fillMode: choice(ZONE_FILL_MODES),
  hatchThickness: POSITIVE,
  hatchGap: POSITIVE,
  hatchOrientation: DEGREES
}

const DOCUMENT: Record<RecordDocument, Record<string, Rule>> = {
  sheet: SHEET,
  symbol: SYMBOL,
  footprint: FOOTPRINT,
  board: BOARD
}

// --- Where a kind reads a key its own way ------------------------------------------------

const BEZIER = { points: points(4, 4) }
const ZONE_NAME = { name: rule(isString, 'a string ("" for none)') }
/** A footprint's or board's square-corner rectangle. */
const PCB_RECT = { radius: nullable(LENGTH, 'for square corners') }
const PCB_TEXT = { size: PCB_TEXT_SIZE }

const KIND: Record<RecordDocument, Record<string, Record<string, Rule>>> = {
  sheet: {
    sheet: {
      size: rule(isPositiveSize, '{width, height} in millimeters')
    },
    bezier: BEZIER,
    rule_area: { points: points(3) },
    directive_label: { shape: choice(DIRECTIVE_SHAPES) }
  },
  symbol: {
    pin: {
      angle: rule(
        (v) => isNumber(v) && [0, 90, 180, 270].includes(v as number),
        'one of 0, 90, 180, 270'
      )
    },
    bezier: BEZIER,
    symbol: {
      name: rule((v) => isName(v) && !/[:/]/.test(v as string), 'a name without ":" or "/"')
    }
  },
  footprint: {
    pad: {
      size: rule(isPositiveSize, '{width, height}, both positive')
    },
    point: { size: POSITIVE },
    bezier: BEZIER,
    rect: PCB_RECT,
    text: PCB_TEXT,
    property: PCB_TEXT,
    text_box: PCB_TEXT,
    zone: {
      ...ZONE_NAME,
      layers: rule(
        (v) => Array.isArray(v) && v.length > 0 && v.every(isCopperLayer),
        'a non-empty list of copper layers, e.g. ["F.Cu"] or ["*.Cu"]'
      )
    }
  },
  board: {
    footprint: { value: rule(isName, 'non-empty text') },
    track: { width: POSITIVE },
    via: {
      layers: rule(
        (v) => Array.isArray(v) && v.length === 2 && v.every(isName),
        'its two copper layers, e.g. ["F.Cu", "B.Cu"]'
      ),
      teardrops: nullable(TEARDROPS, 'for none')
    },
    bezier: BEZIER,
    rect: PCB_RECT,
    text: PCB_TEXT,
    text_box: PCB_TEXT,
    zone: ZONE_NAME,
    tuning_pattern: {
      target: nullable(
        rule(isNumber, "millimeters, a length, or a skew pattern's skew"),
        "for the net's rule"
      ),
      overrideCustomRules: BOOLEAN,
      minAmplitude: LENGTH,
      maxAmplitude: LENGTH,
      spacing: POSITIVE,
      initialSide: choice(TUNING_SIDES),
      singleSided: BOOLEAN,
      rounded: BOOLEAN,
      cornerRadiusPercent: rule(
        (v) => isNumber(v) && (v as number) >= 0 && (v as number) <= 100,
        'a percentage, 0 to 100'
      ),
      origin: POINT
    }
  }
}

/** Where a create reads a key its own way: a run or a via may start on a pad. */
const CREATE: Partial<Record<RecordDocument, Record<string, Record<string, Rule>>>> = {
  board: {
    track: {
      points: rule(
        (v) => Array.isArray(v) && v.length >= 2 && v.every((p) => isPoint(p) || isName(p)),
        'two or more {x, y} in millimeters or pad and via ids, e.g. ["U1.3", {"x": 10, "y": 20}]'
      )
    },
    via: {
      at: rule((v) => isPoint(v) || isName(v), '{x, y} in millimeters, or a pad or via id')
    }
  }
}

/** The rule a key's value is held to on a kind of a document. */
export const ruleFor = (
  document: RecordDocument,
  kind: string,
  key: string,
  mode: RecordMode
): Rule | undefined =>
  (mode === 'create' ? CREATE[document]?.[kind]?.[key] : undefined) ??
  KIND[document][kind]?.[key] ??
  DOCUMENT[document][key] ??
  COMMON[key]

// --- The check -------------------------------------------------------------------------

/** Why a record is refused: keys it may not carry, or the first value of the wrong shape. */
export type RecordFailure =
  | { error: 'not-applicable'; keys: string[]; detail: string }
  | { error: string; key: string; expects: string; detail: string }

const listed = (keys: readonly string[]): string => keys.join(', ')

/** The keys an update may name on a document whose item's kind is not known yet. */
const anyKindTakes = (document: RecordDocument): Set<string> => {
  const records = RECORDS[document]
  return new Set([
    ...Object.values(records.update).flat(),
    ...Object.values(records.readOnly).flatMap((keys) => keys ?? [])
  ])
}

/** A key's rule on whichever kind takes it: any one of them passing passes. */
const unionRule = (document: RecordDocument, key: string, mode: RecordMode): Rule | undefined => {
  const byRule = new Map<Rule, string[]>()
  for (const [kind, keys] of Object.entries(RECORDS[document][mode])) {
    if (!keys.includes(key)) continue
    const found = ruleFor(document, kind, key, mode)
    if (found) byRule.set(found, [...(byRule.get(found) ?? []), kind])
  }
  const rules = [...byRule.keys()]
  if (rules.length <= 1) return rules[0]
  return {
    check: (v) => rules.some((r) => r.check(v)),
    expects: [...byRule].map(([r, kinds]) => `${r.expects} (${listed(kinds)})`).join('; or ')
  }
}

const valueFailure = (
  subject: string,
  key: string,
  value: unknown,
  found: Rule
): RecordFailure | null => {
  if (!found.check(value))
    return {
      error: found.error ?? 'invalid-record',
      key,
      expects: found.expects,
      detail: `${subject}.${key} must be ${found.expects}.`
    }
  if (!found.fields || !isObject(value)) return null
  for (const [field, entry] of Object.entries(value)) {
    const inner = found.fields[field]
    if (!inner)
      return {
        error: 'not-applicable',
        keys: [`${key}.${field}`],
        detail: `${subject}.${key} has no ${field}; it takes ${listed(Object.keys(found.fields))}.`
      }
    const bad = valueFailure(subject, `${key}.${field}`, entry, inner)
    if (bad) return bad
  }
  return null
}

/**
 * A record held to what its kind takes on its document: the keys first, then
 * each value by its rule. `kind` is undefined for an update whose id has not
 * resolved yet, which is held to what any kind of the document takes. Keys
 * whose value is undefined are skipped, as a JSON record never sends them.
 */
export const checkRecord = (
  document: RecordDocument,
  kind: string | undefined,
  record: Record<string, unknown>,
  mode: RecordMode
): RecordFailure | null => {
  const given = Object.keys(record).filter((key) => record[key] !== undefined)
  const takes = kind === undefined ? null : (RECORDS[document][mode][kind] ?? [])
  const known = takes ? new Set(takes) : anyKindTakes(document)
  const unknown = given.filter((key) => !known.has(key))
  if (unknown.length)
    return {
      error: 'not-applicable',
      keys: unknown,
      detail: takes
        ? `A ${kind} does not take ${listed(unknown)}${takes.length ? `; it takes ${listed(takes)}` : ''}.`
        : `No ${document} item takes ${listed(unknown)}.`
    }
  for (const key of given) {
    const found =
      kind === undefined ? unionRule(document, key, mode) : ruleFor(document, kind, key, mode)
    if (!found) continue
    const bad = valueFailure(kind ?? 'record', key, record[key], found)
    if (bad) return bad
  }
  return null
}
