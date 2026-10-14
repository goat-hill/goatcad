import { nmToMm, type Nm } from '../../../kicad/coordinates'
import { isCopperLayer } from '../../../kicad/layers'
import { effectiveClassName } from '../../../kicad/project'
import type { CheckMeasure } from '../../../schematic/checks'
import type { RuleItem, RuleSeverity } from '../../rules/constraints'
import type { Box } from '../../../geometry/polygon'
import {
  boardTexts,
  layerDisplayName,
  shownText,
  titleBlockFields,
  unresolved,
  type BoardText
} from '../../boardTexts'
import type { DrcContext } from '../context'
import { fmt, positional, type Subject } from '../shared'

/** Where KiCad reads a text as meant for the front, where for the back. */
const FRONT = new Set(['F.Cu', 'F.SilkS', 'F.Mask', 'F.Fab'])
const BACK = new Set(['B.Cu', 'B.SilkS', 'B.Mask', 'B.Fab'])

/** What KiCad's DRC_WARNING and DRC_ERROR markers look like, unless escaped. */
const MARKERS = {
  'drc-warning': /(^|[^\\])\$\{DRC_WARNING\s*([^}]*)\}/g,
  'drc-error': /(^|[^\\])\$\{DRC_ERROR\s*([^}]*)\}/g
} as const

const KIND_NAMES: Record<BoardText['kind'], string> = {
  field: 'field',
  text: 'text',
  textbox: 'text box',
  cell: 'table cell',
  dimension: 'dimension',
  table: 'table'
}

/**
 * The text rules: height and pen against the rules (`text_height`,
 * `text_thickness`), which way a text reads for its side, text on the board
 * edge, variables left unresolved and the markers that raise a finding of
 * their own. Board-scoped: they read no copper, and cost a pass over the texts.
 */
export function texts(ctx: DrcContext): void {
  const { board, ruleSet, one, footprintSubject } = ctx
  const all = boardTexts(board)
  const enabled = new Set(board.layers.map((l) => l.name))
  const subjectOf = (t: BoardText): Subject => {
    const owner = t.fp !== undefined ? footprintSubject(board.footprints[t.fp]) : null
    const kind = KIND_NAMES[t.kind]
    const quoted = t.text ? ` '${t.text.length > 24 ? `${t.text.slice(0, 24)}…` : t.text}'` : ''
    const name = owner
      ? t.field
        ? `${t.field} of ${owner.name}`
        : `${kind}${quoted} of ${owner.name}`
      : `${kind}${quoted} on ${t.layer}`
    return {
      item: ctx.drawingId(t.uuid, t.fp, t.field) ?? positional(t.kind, t.position),
      name,
      targets: owner ? owner.targets : t.uuid ? [t.uuid] : [],
      ...(owner && t.uuid ? { ids: [t.uuid] } : {})
    }
  }
  const box = (t: BoardText): Box => ({
    minX: t.position.x,
    minY: t.position.y,
    maxX: t.position.x,
    maxY: t.position.y
  })
  const ruleItemOf = (t: BoardText): RuleItem => {
    const bfp = t.fp !== undefined ? board.footprints[t.fp] : undefined
    return {
      kind: t.kind === 'field' ? 'text' : t.kind,
      label: KIND_NAMES[t.kind],
      layers: [t.layer],
      nonCopper: !isCopperLayer(t.layer),
      ...(bfp ? { footprint: bfp.reference, footprintLayer: bfp.layer } : {})
    }
  }
  /** A size held to its rule: the finding's message, or null within it. */
  const sizeFinding = (
    type: 'text_height' | 'text_thickness',
    t: BoardText,
    actual: Nm,
    what: string
  ): { message: string; severity?: RuleSeverity; measure: CheckMeasure } | null => {
    const resolved = ruleSet.resolver.evaluate(type, ruleItemOf(t), null, t.layer)
    if (resolved.isNull || resolved.severity === 'ignore') return null
    const { min, max } = resolved.value
    // In whole nanometers, as KiCad compares them.
    const nm = (mm: number): number => Math.round(mm * 1e6)
    const message =
      min !== undefined && actual < nm(min)
        ? `The ${what} of ${subjectOf(t).name} is ${fmt(nmToMm(actual))}; ${resolved.name} needs at least ${fmt(min)}.`
        : max !== undefined && actual > nm(max)
          ? `The ${what} of ${subjectOf(t).name} is ${fmt(nmToMm(actual))}; ${resolved.name} allows at most ${fmt(max)}.`
          : null
    if (!message) return null
    const low = min !== undefined && actual < nm(min)
    return {
      message,
      severity: resolved.severity,
      measure: {
        actual: nmToMm(actual),
        limit: (low ? min : max)!,
        bound: low ? 'min' : 'max',
        unit: 'mm',
        rule: resolved.name
      }
    }
  }

  const scope = {
    variables: ruleSet.textVariables,
    netClassOf: (net: number) => effectiveClassName(ruleSet.netClassOf(net))
  }
  for (const t of all) {
    const subject = subjectOf(t)
    const at = t.position
    const boxes = [box(t)]
    if (t.layer === 'Edge.Cuts' && t.kind !== 'cell')
      one(
        'text-on-edge-cuts',
        'error',
        `${subject.name} is on Edge.Cuts, where it would cut the board outline.`,
        subject,
        at,
        boxes
      )
    if (t.kind === 'table') continue

    // A marker raises its own finding and stands for the unresolved reference it is.
    let marked = false
    for (const [code, pattern] of Object.entries(MARKERS)) {
      for (const match of t.text.matchAll(pattern)) {
        marked = true
        one(
          code,
          code === 'drc-error' ? 'error' : 'warning',
          match[2].trim() ||
            `${subject.name} raises a design-rule ${code === 'drc-error' ? 'error' : 'warning'}.`,
          subject,
          at,
          boxes
        )
      }
    }
    if (!marked && unresolved(shownText(board, t, scope)))
      one(
        'unresolved-variable',
        'error',
        `${subject.name} uses a text variable nothing defines: it reads "${shownText(board, t, scope)}".`,
        subject,
        at,
        boxes
      )

    if (!t.visible) continue
    // A TrueType face has no pen of its own; its strokes are not held to the thickness rule.
    if (!t.outlineFont) {
      const pen = sizeFinding('text_thickness', t, t.pen, 'stroke width')
      if (pen)
        one('text-thickness', 'warning', pen.message, subject, at, boxes, pen.severity, {
          measure: pen.measure
        })
    }
    const height = sizeFinding('text_height', t, t.height, 'height')
    if (height)
      one('text-height', 'warning', height.message, subject, at, boxes, height.severity, {
        measure: height.measure
      })

    if (!enabled.has(t.layer)) continue
    if (t.mirrored && FRONT.has(t.layer))
      one(
        'mirrored-text-on-front',
        'warning',
        `${subject.name} is mirrored on ${layerDisplayName(board, t.layer)}, a front layer, so it reads backwards.`,
        subject,
        at,
        boxes
      )
    if (!t.mirrored && BACK.has(t.layer))
      one(
        'nonmirrored-text-on-back',
        'warning',
        `${subject.name} is not mirrored on ${layerDisplayName(board, t.layer)}, a back layer, so it reads backwards from below.`,
        subject,
        at,
        boxes
      )
  }

  // The drawing sheet shows the title block: a variable left in one of its
  // fields is unresolved too, one finding per field as KiCad reports each text.
  for (const { field, shown } of titleBlockFields(board, scope))
    if (unresolved(shown))
      ctx.emit(
        {
          code: 'unresolved-variable',
          severity: 'error',
          message: `The title block's ${field} uses a text variable nothing defines: it reads "${shown}".`,
          items: [],
          targets: [],
          subject: 'Title block',
          detail: field
        },
        []
      )
}
