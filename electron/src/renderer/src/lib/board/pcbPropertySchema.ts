// Builds the property-table schema (PropertyGroup[]) for the PCB editor from the
// current selection, and maps `edit(groupType, key, value)` to a flat patch the
// PcbEditor dispatcher applies via the board AST helpers. Pure: reads typed
// KicadBoard views. Mirrors footprintPropertySchema.ts.
//
// One group per selected primitive type (footprint / segment / tarc / via /
// zone / gr_*). With nothing selected, the root `board` group (thickness/paper)
// shows. PCB coordinates are raw KiCad Y-down (the board editor shows them
// unflipped, unlike the footprint editor), so distance fields do NOT negate.

import type {
  KicadBoard,
  KicadBoardFootprint,
  KicadBoardZone,
  KicadTrackArc,
  KicadTrackSegment,
  KicadTuningPattern,
  KicadVia
} from '../kicad/board'
import type {
  KicadFpArc,
  KicadFpCircle,
  KicadFpLine,
  KicadFpPoly,
  KicadFpCurve,
  KicadFpRect,
  KicadFpTextBox,
  KicadPad
} from '../kicad/footprint'
import { readTeardropParams } from './teardrop/params'
import {
  collapseValue,
  inSection,
  placeholderGroups,
  type EditorDescriptor,
  type PropertyEditValue,
  type PropertyField,
  type PropertyGroup,
  type SelectOption,
  type WarningSource
} from '../propertyTable'
import { mmToNm, nmToMm, type Nm } from '../kicad/coordinates'
import { formatSize } from './routeSizes'
import { arcPieceLength } from './netLength'
import { KICAD_LAYER_COLORS } from '../kicad/layers'
import { markupToPlainText } from '../kicad/textMarkup'
import { tk, type MessageKey } from '../messageKey'
import { footprintPointOnBoard, footprintTextOf, type FootprintTextItem } from './footprintChildren'
import { isSymbolOwned } from './footprintExchange'
import {
  footprintAttributeFields,
  footprintOverrideFields,
  keepoutFields,
  padFields,
  teardropFields,
  pointFields,
  shapeFields,
  tableFields,
  textBoxFields,
  textFields,
  type GraphicKind
} from '../footprint/footprintPropertySchema'

export type Translate = (key: string, params?: Record<string, unknown>) => string

export interface SelectionItem {
  type: string
  index: number
  /** A pad's index in the footprint `index` names (`BoardItemRef.pad`). */
  pad?: number
  /** A footprint field's or text's index in it (`BoardItemRef.child`). */
  child?: number
}

/** Contextual options the host passes in (the board's layer + net lists). */
export interface BoardContext {
  layers: SelectOption[]
  nets: SelectOption[]
  /**
   * The bounds the rules hold a net's width and via to, mm: what a track's or
   * via's size row warns outside (router-behavior.md S9). Absent, it warns of none.
   */
  rulesFor?: {
    trackWidth: (net: number, layer: string) => RuledSize
    via: (net: number, layers: readonly string[]) => RuledSize
  }
  /** A net class's PCB color, CSS, for its tag where a warning names it. */
  classColor?: (name: string) => string | undefined
  /**
   * A net's length, mm, as KiCad's track readout gives it: routed (tracks, arcs
   * and via heights) and the pads' pad-to-die. Absent, a track shows only its own.
   */
  netLength?: (net: number) => { routed: number; padToDie: number }
}

/** The layers and nets a board's rows choose from, each layer in the color the canvas gives it. */
export const boardOptions = (
  board: KicadBoard | null,
  layerColors: Readonly<Record<string, string>>
): Pick<BoardContext, 'layers' | 'nets'> => ({
  layers: (board?.layers ?? [])
    .filter((l) => KICAD_LAYER_COLORS[l.name] !== undefined)
    .map((l) => ({ value: l.name, label: l.name, color: layerColors[l.name] })),
  nets: (board?.nets ?? []).map((n) => ({
    value: `${n.number}`,
    label: markupToPlainText(n.name) || `(net ${n.number})`
  }))
})

const opt = (value: string, label: string): SelectOption => ({ value, label })
// Labels stay short — these render as segmented toggles (all options visible).
const SIDES = [opt('F.Cu', 'Front'), opt('B.Cu', 'Back')]
const VIA_TYPES = [opt('through', 'Through'), opt('blind', 'Blind'), opt('micro', 'Micro')]

const dist = (): EditorDescriptor => ({ kind: 'distance', step: 0.1, model: 'nm' })
const ang = (): EditorDescriptor => ({ kind: 'angle' })
const select = (opts: SelectOption[]): EditorDescriptor => ({ kind: 'select', options: opts })
/** A select shown as an all-options-visible toggle — for short 2–3 option sets. */
const segmented = (opts: SelectOption[]): EditorDescriptor => ({ kind: 'segmented', options: opts })

const field = (
  key: string,
  labelKey: string,
  editor: EditorDescriptor,
  value: PropertyField['value']
): PropertyField => ({ key, labelKey, editor, value })
const ro = (f: PropertyField): PropertyField => ({ ...f, readonly: true })

/** The bounds the rules hold an item's size to, mm, and the rule that set them. */
export interface RuledSize {
  min: number
  max?: number
  source: string
}

/**
 * A size row warned where some selected item's size is outside its rules'
 * bounds, as DRC would flag it: a size between them is legal, however far from
 * the preferred one. KiCad's panel offers no reset; the size is a plain field.
 */
/**
 * A resolution's name as the panel shows it: KiCad's `netclass 'USB'` as the
 * class's tag, `rule 'name'` as the rule's name, anything else as it reads.
 */
export const warningSourceOf = (
  source: string,
  classColor?: (name: string) => string | undefined
): WarningSource => {
  const cls = /^netclass '(.*)'$/.exec(source)
  if (cls) {
    // A composite (`A,B`) wears its first class's color, as its tag does elsewhere.
    const color = classColor?.(cls[1].split(',')[0])
    return { kind: 'netClass', name: cls[1], ...(color ? { color } : {}) }
  }
  const rule = /^rule '(.*)'$/.exec(source)
  return rule ? { kind: 'rule', name: rule[1] } : { kind: 'text', text: source }
}

const ruledSize = (
  t: Translate,
  ctx: BoardContext,
  f: PropertyField,
  sizes: readonly Nm[],
  rules: ReadonlyArray<RuledSize | undefined>
): PropertyField => {
  const mm = sizes.map(nmToMm)
  const below = mm.findIndex((size, i) => rules[i] !== undefined && size < rules[i]!.min - 1e-6)
  const above = mm.findIndex(
    (size, i) => rules[i]?.max !== undefined && size > rules[i]!.max! + 1e-6
  )
  if (below >= 0)
    return {
      ...f,
      warning: t('pcbEditor.properties.belowRule', { size: formatSize(rules[below]!.min) }),
      warningSource: warningSourceOf(rules[below]!.source, ctx.classColor)
    }
  if (above >= 0)
    return {
      ...f,
      warning: t('pcbEditor.properties.aboveRule', { size: formatSize(rules[above]!.max!) }),
      warningSource: warningSourceOf(rules[above]!.source, ctx.classColor)
    }
  return f
}

const layerField = (ctx: BoardContext, members: Array<{ layer?: string }>): PropertyField =>
  field(
    'layer',
    'layer',
    select(ctx.layers),
    collapseValue(members, (m) => m.layer ?? '')
  )
const netField = (ctx: BoardContext, members: Array<{ net: number }>): PropertyField =>
  field(
    'net',
    'net',
    { ...select(ctx.nets), searchable: true },
    collapseValue(members, (m) => m.net)
  )
// ---------------------------------------------------------------------------
// Groups
// ---------------------------------------------------------------------------

const boardGroup = (t: Translate, b: KicadBoard): PropertyGroup => ({
  type: 'board',
  title: t('shared.primitives.board'),
  count: 1,
  fields: [
    field('thickness', 'thickness', dist(), b.thickness ?? mmToNm(1.6)),
    field('paper', 'paper', { kind: 'text' }, b.paper ?? '')
  ]
})

/** A field's text, editable only while no symbol owns any of these footprints. */
const ownName = (fps: KicadBoardFootprint[], row: PropertyField): PropertyField =>
  fps.some(isSymbolOwned) ? ro(row) : row

const footprintGroup = (t: Translate, fps: KicadBoardFootprint[]): PropertyGroup => ({
  type: 'footprint',
  title: t('shared.primitives.footprint'),
  count: fps.length,
  fields: [
    ro(
      field(
        'libId',
        'footprint',
        { kind: 'text' },
        collapseValue(fps, (f) => f.libId)
      )
    ),
    ro(
      field(
        'pads',
        'pads',
        { kind: 'text' },
        collapseValue(fps, (f) => `${f.footprint.pads.length}`)
      )
    ),
    field(
      'posX',
      'posX',
      dist(),
      collapseValue(fps, (f) => f.position.x)
    ),
    field(
      'posY',
      'posY',
      dist(),
      collapseValue(fps, (f) => f.position.y)
    ),
    field(
      'rotation',
      'rotation',
      ang(),
      collapseValue(fps, (f) => f.position.angle ?? 0)
    ),
    field(
      'side',
      'side',
      segmented(SIDES),
      collapseValue(fps, (f) => f.layer)
    ),
    field(
      'locked',
      'locked',
      { kind: 'checkbox' },
      collapseValue(fps, (f) => f.footprint.locked)
    ),
    // The schematic owns a placed part's Reference and Value; a footprint no
    // symbol owns names itself.
    ...inSection('fields', [
      ownName(
        fps,
        field(
          'reference',
          'reference',
          { kind: 'text' },
          collapseValue(fps, (f) => f.reference ?? '')
        )
      ),
      ownName(
        fps,
        field(
          'value',
          'value',
          { kind: 'text' },
          collapseValue(fps, (f) => f.value ?? '')
        )
      ),
      ro(
        field(
          'description',
          'description',
          { kind: 'text' },
          collapseValue(fps, (f) => f.footprint.description ?? '')
        )
      ),
      ro(
        field(
          'keywords',
          'keywords',
          { kind: 'text' },
          collapseValue(fps, (f) => f.footprint.tags ?? '')
        )
      )
    ]),
    ...footprintAttributeFields(fps.map((f) => f.footprint)),
    ...footprintOverrideFields(
      t,
      fps.map((f) => f.footprint)
    )
  ]
})

/**
 * A track's or arc's length and its net's, read-only, as KiCad's track readout
 * gives them: its own Length, the net's Routed length, and where a pad sets a
 * die length, the Pad to die length and the Full length they make together.
 */
const lengthFields = <T extends { net: number }>(
  ctx: BoardContext,
  items: T[],
  ownLabel: 'trackLength' | 'arcLength',
  lengthOf: (item: T) => number
): PropertyField[] => {
  const netLength = ctx.netLength
  const lengths = new Map<number, { routed: number; padToDie: number } | null>()
  const of = (net: number): { routed: number; padToDie: number } | null => {
    if (!netLength || net <= 0) return null
    if (!lengths.has(net)) lengths.set(net, netLength(net))
    return lengths.get(net)!
  }
  const mmRow = (
    key: string,
    read: (l: { routed: number; padToDie: number }) => number
  ): PropertyField =>
    ro(
      field(
        key,
        key,
        { kind: 'distance', step: 0.1 },
        collapseValue(items, (i) => {
          const l = of(i.net)
          return l ? read(l) : null
        })
      )
    )
  const dies = netLength && items.some((i) => (of(i.net)?.padToDie ?? 0) > 0)
  return inSection('length', [
    ro(field('length', ownLabel, dist(), collapseValue(items, lengthOf))),
    ...(netLength ? [mmRow('routedLength', (l) => l.routed)] : []),
    ...(dies
      ? [mmRow('padToDie', (l) => l.padToDie), mmRow('fullLength', (l) => l.routed + l.padToDie)]
      : [])
  ])
}

const segmentGroup = (t: Translate, ctx: BoardContext, ss: KicadTrackSegment[]): PropertyGroup => ({
  type: 'segment',
  title: t('shared.primitives.track'),
  count: ss.length,
  fields: [
    field(
      'startX',
      'startX',
      dist(),
      collapseValue(ss, (s) => s.start.x)
    ),
    field(
      'startY',
      'startY',
      dist(),
      collapseValue(ss, (s) => s.start.y)
    ),
    field(
      'endX',
      'endX',
      dist(),
      collapseValue(ss, (s) => s.end.x)
    ),
    field(
      'endY',
      'endY',
      dist(),
      collapseValue(ss, (s) => s.end.y)
    ),
    ruledSize(
      t,
      ctx,
      field(
        'width',
        'width',
        dist(),
        collapseValue(ss, (s) => s.width)
      ),
      ss.map((s) => s.width),
      ss.map((s) => ctx.rulesFor?.trackWidth(s.net, s.layer))
    ),
    layerField(ctx, ss),
    netField(ctx, ss),
    ...lengthFields(ctx, ss, 'trackLength', (s) =>
      Math.hypot(s.end.x - s.start.x, s.end.y - s.start.y)
    )
  ]
})

const trackArcGroup = (t: Translate, ctx: BoardContext, as: KicadTrackArc[]): PropertyGroup => ({
  type: 'tarc',
  title: t('shared.primitives.trackArc'),
  count: as.length,
  fields: [
    field(
      'startX',
      'startX',
      dist(),
      collapseValue(as, (a) => a.start.x)
    ),
    field(
      'startY',
      'startY',
      dist(),
      collapseValue(as, (a) => a.start.y)
    ),
    field(
      'midX',
      'midX',
      dist(),
      collapseValue(as, (a) => a.mid.x)
    ),
    field(
      'midY',
      'midY',
      dist(),
      collapseValue(as, (a) => a.mid.y)
    ),
    field(
      'endX',
      'endX',
      dist(),
      collapseValue(as, (a) => a.end.x)
    ),
    field(
      'endY',
      'endY',
      dist(),
      collapseValue(as, (a) => a.end.y)
    ),
    ruledSize(
      t,
      ctx,
      field(
        'width',
        'width',
        dist(),
        collapseValue(as, (a) => a.width)
      ),
      as.map((a) => a.width),
      as.map((a) => ctx.rulesFor?.trackWidth(a.net, a.layer))
    ),
    layerField(ctx, as),
    netField(ctx, as),
    ...lengthFields(ctx, as, 'arcLength', (a) => arcPieceLength(a.start, a.mid, a.end))
  ]
})

const viaGroup = (t: Translate, ctx: BoardContext, vs: KicadVia[]): PropertyGroup => ({
  type: 'via',
  title: t('shared.primitives.via'),
  count: vs.length,
  fields: [
    field(
      'posX',
      'posX',
      dist(),
      collapseValue(vs, (v) => v.position.x)
    ),
    field(
      'posY',
      'posY',
      dist(),
      collapseValue(vs, (v) => v.position.y)
    ),
    ruledSize(
      t,
      ctx,
      field(
        'size',
        'width',
        dist(),
        collapseValue(vs, (v) => v.size)
      ),
      vs.map((v) => v.size),
      vs.map((v) => ctx.rulesFor?.via(v.net, v.layers))
    ),
    field(
      'drill',
      'drill',
      dist(),
      collapseValue(vs, (v) => v.drill)
    ),
    field(
      'type',
      'type',
      segmented(VIA_TYPES),
      collapseValue(vs, (v) => v.type ?? 'through')
    ),
    // KiCad's Layer Top / Layer Bottom: the copper pair a blind or micro via spans.
    field(
      'layerTop',
      'layerTop',
      select(ctx.layers.filter((l) => l.value.endsWith('.Cu'))),
      collapseValue(vs, (v) => v.layers[0] ?? '')
    ),
    field(
      'layerBottom',
      'layerBottom',
      select(ctx.layers.filter((l) => l.value.endsWith('.Cu'))),
      collapseValue(vs, (v) => v.layers[v.layers.length - 1] ?? '')
    ),
    netField(ctx, vs),
    ...teardropFields(
      vs.map((v) => readTeardropParams(v._raw)),
      false
    )
  ]
})

const PAD_CONNECTIONS = [
  opt('thermal', 'Thermal'),
  opt('solid', 'Solid'),
  opt('thru_hole_only', 'PTH only'),
  opt('none', 'None')
]
// island_removal_mode: 0/absent = remove all, 1 = keep all, 2 = remove those
// under the minimum island area.
const ISLAND_MODES = [opt('0', 'Remove'), opt('1', 'Keep'), opt('2', 'Below area')]
const ZONE_FILL_MODES = [opt('solid', 'Solid'), opt('hatch', 'Hatched')]

/**
 * A zone's copper layers as the layer cell holds them: each one named, in the
 * board's order and comma-joined, a wildcard spelled out — so `*.Cu` and every
 * copper layer listed read as the same value, and the cell ticks them all.
 */
const zoneLayersValue = (zone: KicadBoardZone, copper: readonly string[]): string => {
  const named = new Set(
    zone.layers.flatMap((l) => (l === '*.Cu' ? copper : l === 'F&B.Cu' ? ['F.Cu', 'B.Cu'] : [l]))
  )
  return copper.filter((l) => named.has(l)).join(',')
}

const zoneGroup = (t: Translate, ctx: BoardContext, zs: KicadBoardZone[]): PropertyGroup => {
  // Zones live on copper, on any number of its layers at once.
  const copperOptions = ctx.layers.filter((l) => l.value.endsWith('.Cu'))
  const copper = copperOptions.map((l) => l.value)
  const fields: PropertyField[] = [
    field(
      'zoneName',
      'name',
      { kind: 'text' },
      collapseValue(zs, (z) => z.name ?? '')
    ),
    field(
      'net',
      'net',
      { ...select(ctx.nets), searchable: true },
      collapseValue(zs, (z) => z.net ?? 0)
    ),
    field(
      'layer',
      'layer',
      { kind: 'multiselect', options: copperOptions },
      collapseValue(zs, (z) => zoneLayersValue(z, copper))
    ),
    field(
      'priority',
      'priority',
      { kind: 'number' },
      collapseValue(zs, (z) => z.priority ?? 0)
    ),
    field(
      'minThickness',
      'minThickness',
      dist(),
      collapseValue(zs, (z) => z.minThickness ?? mmToNm(0.25))
    ),
    ...inSection('thermal', [
      field(
        'padConnection',
        'padConnection',
        select(PAD_CONNECTIONS),
        collapseValue(zs, (z) => z.padConnection ?? 'thermal')
      ),
      field(
        'padClearance',
        'padClearance',
        dist(),
        collapseValue(zs, (z) => z.padClearance ?? mmToNm(0.5))
      ),
      field(
        'thermalGap',
        'thermalGap',
        dist(),
        collapseValue(zs, (z) => z.thermalGap ?? mmToNm(0.5))
      ),
      field(
        'thermalBridge',
        'thermalBridge',
        dist(),
        collapseValue(zs, (z) => z.thermalBridgeWidth ?? mmToNm(0.5))
      )
    ]),
    ...inSection('islands', [
      field(
        'removeIslands',
        'removeIslands',
        segmented(ISLAND_MODES),
        collapseValue(zs, (z) => `${z.islandRemovalMode ?? 0}`)
      ),
      ...(zs.every((z) => z.islandRemovalMode === 2)
        ? [
            field(
              'minIslandArea',
              'minIslandArea',
              { kind: 'number', unit: 'mm²', step: 1, min: 0 },
              collapseValue(zs, (z) => z.minIslandArea ?? 10)
            )
          ]
        : [])
    ]),
    inSection('keepout', [
      field(
        'keepout',
        'keepout',
        { kind: 'checkbox' },
        collapseValue(zs, (z) => z.isKeepout)
      )
    ])[0]
  ]
  // How the copper pours — solid, or KiCad's hatch pattern — and, once every
  // selected zone is hatched, the hatch itself. A rule area pours nothing.
  if (!zs.every((z) => z.isKeepout)) {
    fields.push(
      inSection('fill', [
        field(
          'fillMode',
          'fillMode',
          segmented(ZONE_FILL_MODES),
          collapseValue(zs, (z) => (z.hatchFill ? 'hatch' : 'solid'))
        )
      ])[0]
    )
    const hatches = zs.map((z) => z.hatchFill)
    if (hatches.every((h) => h !== undefined)) {
      fields.push(
        ...inSection('fill', [
          field(
            'hatchThickness',
            'hatchThickness',
            dist(),
            collapseValue(hatches, (h) => mmToNm(h!.thickness))
          ),
          field(
            'hatchGap',
            'hatchGap',
            dist(),
            collapseValue(hatches, (h) => mmToNm(h!.gap))
          ),
          field(
            'hatchOrientation',
            'hatchOrientation',
            ang(),
            collapseValue(hatches, (h) => h!.orientation)
          )
        ])
      )
    }
  }
  // The five keepout blocks, shown once every selected zone is a rule area.
  if (zs.every((z) => z.isKeepout)) fields.push(...keepoutFields(zs))
  return {
    type: 'zone',
    title: t('shared.primitives.zone'),
    count: zs.length,
    fields
  }
}

/** Each board graphic's group title, the primitive's shared name. */
const GR_TITLES: Record<string, MessageKey> = {
  gr_line: tk('shared.primitives.line'),
  gr_arc: tk('shared.primitives.arc'),
  gr_circle: tk('shared.primitives.circle'),
  gr_rect: tk('shared.primitives.rectangle'),
  gr_poly: tk('shared.primitives.polygon')
}

// Board graphics reuse the footprint graphic types and their rows.
type GrGraphic = KicadFpLine | KicadFpArc | KicadFpCircle | KicadFpRect | KicadFpPoly | KicadFpCurve
const GR_KINDS: Record<string, GraphicKind> = {
  gr_line: 'line',
  gr_arc: 'arc',
  gr_circle: 'circle',
  gr_rect: 'rect',
  gr_poly: 'poly',
  gr_curve: 'curve'
}
const grGraphicGroup = (
  t: Translate,
  ctx: BoardContext,
  type: string,
  gs: GrGraphic[]
): PropertyGroup => {
  const fields = shapeFields(GR_KINDS[type], ctx, gs, false)
  // A drawing on copper conducts, and KiCad gives it a net.
  if (gs.every((g) => g.layer?.endsWith('.Cu'))) {
    fields.splice(
      1,
      0,
      netField(
        ctx,
        gs.map((g) => ({ net: g.net ?? 0 }))
      )
    )
  }
  return { type, title: t(GR_TITLES[type] ?? type), count: gs.length, fields }
}

/** A text box: the footprint's rows (text, border, margins). */
const textBoxGroup = (t: Translate, ctx: BoardContext, bs: KicadFpTextBox[]): PropertyGroup => ({
  type: 'gr_text_box',
  title: t('shared.primitives.textBox'),
  count: bs.length,
  fields: textBoxFields(ctx, bs)
})

// ---------------------------------------------------------------------------
// Build
// ---------------------------------------------------------------------------

/**
 * A tuning pattern (router-behavior.md T4), as KiCad's properties list it:
 * what it tunes to and how its meanders are drawn. A change re-tunes it.
 * Lengths are millimeters, as the file holds them.
 */
const tuningPatternGroup = (
  t: Translate,
  _ctx: BoardContext,
  ps: KicadTuningPattern[]
): PropertyGroup => {
  const mm = (step: number, optional = false): EditorDescriptor => ({
    kind: 'distance',
    step,
    model: 'mm',
    ...(optional ? { optional: true, placeholder: t('pcbEditor.tune.noTarget') } : {})
  })
  const row = (
    key: string,
    label: string,
    editor: EditorDescriptor,
    value: PropertyField['value']
  ): PropertyField => ({ key, label, editor, value })
  const target = (p: KicadTuningPattern): number =>
    p.mode === 'diff_pair_skew' ? p.targetSkew.opt : p.targetLength.opt
  return {
    type: 'tuning_pattern',
    title: t('shared.primitives.tuningPattern'),
    count: ps.length,
    fields: [
      ro(
        row(
          'mode',
          t('pcbEditor.tune.mode'),
          select([
            opt('single', t('pcbEditor.tune.modes.single')),
            opt('diff_pair', t('pcbEditor.tune.modes.diff_pair')),
            opt('diff_pair_skew', t('pcbEditor.tune.modes.diff_pair_skew'))
          ]),
          collapseValue(ps, (p) => p.mode)
        )
      ),
      ro(
        row(
          'length',
          t('pcbEditor.tune.length'),
          mm(0.01),
          collapseValue(ps, (p) => p.lastTuningLength)
        )
      ),
      ro(
        row(
          'status',
          t('pcbEditor.tune.status'),
          select([
            opt('tuned', t('pcbEditor.tune.statuses.tuned')),
            opt('too_short', t('pcbEditor.tune.statuses.too_short')),
            opt('too_long', t('pcbEditor.tune.statuses.too_long'))
          ]),
          collapseValue(ps, (p) => p.lastStatus)
        )
      ),
      row(
        'target',
        t('pcbEditor.tune.target'),
        mm(0.1, true),
        collapseValue(ps, (p) => (Number.isFinite(target(p)) ? target(p) : null))
      ),
      row(
        'overrideCustomRules',
        t('pcbEditor.tune.overrideRules'),
        { kind: 'checkbox' },
        collapseValue(ps, (p) => p.overrideCustomRules)
      ),
      row(
        'minAmplitude',
        t('pcbEditor.tune.minAmplitude'),
        mm(0.05),
        collapseValue(ps, (p) => p.minAmplitude)
      ),
      row(
        'maxAmplitude',
        t('pcbEditor.tune.maxAmplitude'),
        mm(0.05),
        collapseValue(ps, (p) => p.maxAmplitude)
      ),
      row(
        'spacing',
        t('pcbEditor.tune.spacing'),
        mm(0.05),
        collapseValue(ps, (p) => p.minSpacing)
      ),
      row(
        'initialSide',
        t('pcbEditor.tune.initialSide'),
        segmented([
          opt('left', t('pcbEditor.tune.sides.left')),
          opt('right', t('pcbEditor.tune.sides.right')),
          opt('default', t('pcbEditor.tune.sides.default'))
        ]),
        collapseValue(ps, (p) => p.initialSide)
      ),
      row(
        'singleSided',
        t('pcbEditor.tune.singleSided'),
        { kind: 'checkbox' },
        collapseValue(ps, (p) => p.singleSided)
      ),
      row(
        'rounded',
        t('pcbEditor.tune.rounded'),
        { kind: 'checkbox' },
        collapseValue(ps, (p) => p.rounded)
      ),
      row(
        'cornerRadiusPercent',
        t('pcbEditor.tune.cornerRadius'),
        { kind: 'number', unit: '%', step: 5, min: 0, max: 100 },
        collapseValue(ps, (p) => p.cornerRadiusPercent)
      )
    ]
  }
}

/**
 * Every item type the PCB editor selects, and the collection it indexes — in
 * the order the panel shows their groups. The editor resolves a selection
 * through this map, and `GROUP_BUILDERS` is typed against it, so a type made
 * selectable without a property group does not compile.
 */
export const BOARD_ITEM_COLLECTIONS = {
  footprint: 'footprints',
  segment: 'segments',
  tarc: 'trackArcs',
  via: 'vias',
  zone: 'zones',
  gr_line: 'grLines',
  gr_arc: 'grArcs',
  gr_circle: 'grCircles',
  gr_rect: 'grRects',
  gr_poly: 'grPolys',
  gr_curve: 'grCurves',
  gr_text: 'grTexts',
  gr_text_box: 'grTextBoxes',
  table: 'tables',
  point: 'points',
  tuning_pattern: 'tuningPatterns'
} as const satisfies Record<string, keyof KicadBoard>

export type BoardItemType = keyof typeof BOARD_ITEM_COLLECTIONS

type ItemOf<K extends BoardItemType> =
  KicadBoard[(typeof BOARD_ITEM_COLLECTIONS)[K]] extends Array<infer T> ? T : never

const grGraphic =
  (type: string) =>
  (t: Translate, ctx: BoardContext, gs: GrGraphic[]): PropertyGroup =>
    grGraphicGroup(t, ctx, type, gs)

const GROUP_BUILDERS: {
  [K in BoardItemType]: (t: Translate, ctx: BoardContext, items: ItemOf<K>[]) => PropertyGroup
} = {
  footprint: (t, _ctx, items) => footprintGroup(t, items),
  segment: segmentGroup,
  tarc: trackArcGroup,
  via: viaGroup,
  zone: zoneGroup,
  gr_line: grGraphic('gr_line'),
  gr_arc: grGraphic('gr_arc'),
  gr_circle: grGraphic('gr_circle'),
  gr_rect: grGraphic('gr_rect'),
  gr_poly: grGraphic('gr_poly'),
  gr_curve: grGraphic('gr_curve'),
  gr_text: (t, ctx, items) => ({
    type: 'gr_text',
    title: t('shared.primitives.text'),
    count: items.length,
    fields: textFields(ctx, items, (x) => x.text, {
      negateY: false,
      visible: false,
      keepUpright: false
    })
  }),
  gr_text_box: textBoxGroup,
  table: (t, ctx, items) => ({
    type: 'table',
    title: t('shared.primitives.table'),
    count: items.length,
    fields: tableFields(ctx, items)
  }),
  point: (t, ctx, items) => ({
    type: 'point',
    title: t('shared.primitives.point'),
    count: items.length,
    fields: pointFields(ctx, items, false)
  }),
  tuning_pattern: tuningPatternGroup
}

const GROUPED_TYPES: ReadonlySet<string> = new Set([
  ...Object.keys(GROUP_BUILDERS),
  'pad',
  'fp_field',
  'fp_text'
])

/**
 * The items KiCad's BOARD_ITEM gives a Locked row: every one but a point, which
 * the format gives no lock, and a footprint, whose group has its own row.
 */
const LOCKABLE: ReadonlySet<BoardItemType> = new Set(
  (Object.keys(BOARD_ITEM_COLLECTIONS) as BoardItemType[]).filter(
    (type) => type !== 'point' && type !== 'footprint' && type !== 'tuning_pattern'
  )
)

/** Locked among the basic rows, above the group's first subheading, as KiCad lists it. */
const withLocked = (
  fields: PropertyField[],
  items: Array<{ locked: boolean }>
): PropertyField[] => {
  const row = field(
    'locked',
    'locked',
    { kind: 'checkbox' },
    collapseValue(items, (i) => i.locked)
  )
  const at = fields.findIndex((f) => f.section)
  return at < 0 ? [...fields, row] : [...fields.slice(0, at), row, ...fields.slice(at)]
}

export const isBoardItemType = (type: string): type is BoardItemType =>
  Object.hasOwn(BOARD_ITEM_COLLECTIONS, type)

/** The collection a selected item type indexes, or undefined for a type the editor does not select. */
export function boardCollection(board: KicadBoard, type: string): unknown[] | undefined {
  return isBoardItemType(type) ? board[BOARD_ITEM_COLLECTIONS[type]] : undefined
}

/**
 * Build the property groups for the current selection. Only the selected item
 * types get a group; the root `board` group shows only when nothing is
 * selected. A selected type with no group still gets an empty one
 * (`placeholderGroups`), so the panel never shows the board for it.
 */
export function buildBoardGroups(
  board: KicadBoard | null,
  selectedItems: SelectionItem[],
  t: Translate,
  ctx: BoardContext
): PropertyGroup[] {
  if (!board) return []
  if (selectedItems.length === 0) return [boardGroup(t, board)]
  const groups: PropertyGroup[] = []
  for (const type of Object.keys(GROUP_BUILDERS) as BoardItemType[]) {
    const coll = board[BOARD_ITEM_COLLECTIONS[type]] as unknown[]
    const items = selectedItems
      .filter((i) => i.type === type)
      .map((i) => coll[i.index])
      .filter((n) => !!n)
    if (!items.length) continue
    const build = GROUP_BUILDERS[type] as (
      t: Translate,
      ctx: BoardContext,
      items: unknown[]
    ) => PropertyGroup
    const group = build(t, ctx, items)
    if (LOCKABLE.has(type))
      group.fields = withLocked(group.fields, items as Array<{ locked: boolean }>)
    groups.push(group)
  }
  // After the footprint group, before the rest: pads, fields and texts are part of footprints.
  const owned: PropertyGroup[] = []
  const pads = selectedPads(board, selectedItems)
  if (pads.length) owned.push(padGroup(t, ctx, pads))
  const texts = selectedItems.flatMap((ref) => footprintTextOf(board, ref) ?? [])
  const fields = texts.filter((x) => x.kind === 'field')
  const fpTexts = texts.filter((x) => x.kind === 'text')
  if (fields.length) owned.push(footprintTextGroup(t, ctx, 'fp_field', fields))
  if (fpTexts.length) owned.push(footprintTextGroup(t, ctx, 'fp_text', fpTexts))
  groups.splice(groups[0]?.type === 'footprint' ? 1 : 0, 0, ...owned)
  return [...groups, ...placeholderGroups(selectedItems, GROUPED_TYPES, t)]
}

/**
 * A footprint's field or text on the board: the text rows, at its board
 * position (it is kept in the footprint's frame, `footprintChildren.ts`). A
 * symbol-owned footprint's field text is the schematic's, so it reads here and
 * edits there; a footprint no symbol owns edits its own.
 */
const footprintTextGroup = (
  t: Translate,
  ctx: BoardContext,
  type: 'fp_field' | 'fp_text',
  items: FootprintTextItem[]
): PropertyGroup => {
  const placed = items.map(({ footprint, item }) => ({
    ...item,
    position: item.position && {
      ...item.position,
      ...footprintPointOnBoard(footprint, item.position)
    }
  }))
  const isField = type === 'fp_field'
  const rows = textFields(ctx, placed, (x) => ('key' in x ? x.value : x.text), {
    negateY: false,
    // Hidden is a field's switch; a v6 file's reference and value are fields all the same.
    visible: isField || items.some(({ item }) => 'type' in item && item.type !== 'user'),
    keepUpright: true
  }).map((row) =>
    isField && row.key === 'text' && items.some(({ footprint }) => isSymbolOwned(footprint))
      ? { ...row, readonly: true }
      : row
  )
  return {
    type,
    title: isField ? t('shared.primitives.field') : t('shared.primitives.text'),
    count: items.length,
    fields: isField
      ? [
          ro(
            field(
              'name',
              'name',
              { kind: 'text' },
              collapseValue(items, ({ item }) => ('key' in item ? item.key : ''))
            )
          ),
          ...rows
        ]
      : rows
  }
}

/** The pads a selection names, through their footprints. */
export const selectedPads = (board: KicadBoard, selectedItems: SelectionItem[]): KicadPad[] =>
  selectedItems.flatMap((item) =>
    item.type === 'pad' && item.pad !== undefined
      ? (board.footprints[item.index]?.footprint.pads[item.pad] ?? [])
      : []
  )

/**
 * A pad on the board: the footprint editor's pad rows but its position, under
 * its net and pin as the schematic gave them — read-only, since board sync
 * rewrites them from the schematic.
 */
const padGroup = (t: Translate, ctx: BoardContext, pads: KicadPad[]): PropertyGroup => ({
  type: 'pad',
  title: t('shared.primitives.pad'),
  count: pads.length,
  fields: [
    ro(
      field(
        'net',
        'net',
        { ...select(ctx.nets), searchable: true },
        collapseValue(pads, (p) => p.net?.number ?? 0)
      )
    ),
    ro(
      field(
        'pinType',
        'pinType',
        { kind: 'text' },
        collapseValue(pads, (p) => p.pinType ?? '')
      )
    ),
    ...padFields(t, pads, true)
  ]
})

// ---------------------------------------------------------------------------
// edit(key, value) → flat patch for the matching updateXInAST helper. Footprint
// and board edits are dispatched specially in PcbEditor (varied signatures).
// ---------------------------------------------------------------------------

const numberVal = (v: PropertyEditValue): number => (typeof v === 'number' ? v : 0)

export function boardPatch(key: string, value: PropertyEditValue): Record<string, unknown> {
  const coord: Record<string, [string, 'x' | 'y']> = {
    posX: ['position', 'x'],
    posY: ['position', 'y'],
    startX: ['start', 'x'],
    startY: ['start', 'y'],
    midX: ['mid', 'x'],
    midY: ['mid', 'y'],
    endX: ['end', 'x'],
    endY: ['end', 'y'],
    centerX: ['center', 'x'],
    centerY: ['center', 'y']
  }
  if (key in coord) {
    const [group, axis] = coord[key]
    return { [group]: { [axis]: numberVal(value) } }
  }
  if (key === 'net') return { net: numberVal(typeof value === 'string' ? Number(value) : value) }
  return { [key]: value }
}
