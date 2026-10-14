/**
 * Laying out a generated schematic symbol — GoatCAD's half of `create_symbol`.
 *
 * The boundary: this
 * is one helper, not the owner of geometry — the agent edits directly where it
 * can, and inside this helper GoatCAD does the geometry so that a pin table
 * comes back drawn to the measured convention in one call.
 *
 * So this takes a fully-specified pin table — every pin already carrying a
 * functional `group`, because only a reader of the datasheet knows that `SDA`
 * and `SCL` are one bus — and answers with coordinates. It never infers what a
 * pin means, and a pin that arrives without a group is refused rather than
 * guessed at. There is no built-in bus-name table racing the caller's opinion:
 * a rule that is sometimes applied is worse than either rule applied always.
 * The one geometric say the caller has is a group's `side`.
 *
 * Text is sized by one model (`symbolTextBoxes`), judged by one rule
 * (`textViolations`, `TEXT_CLEARANCE`), and the body grows until the rule
 * holds — the tests judge the result with the same two functions.
 *
 * **Why the input has to be this rich.** A side rule keyed only on electrical
 * type and pin name reproduces the standard library's own layout on 12% of
 * small symbols. That is not a case for moving geometry to the model — it is a
 * case for giving the geometry better input, which is what `group` is.
 *
 * Pure: no Vue, no Electron, no `fs`. Unit-tested the way `schematicTools.ts`
 * is, and its tests assert the drafting invariants directly.
 */
import { nm, NM_PER_MIL, NM_PER_MM, type Nm } from '../kicad/coordinates'
import { DEFAULT_FONT_SIZE_NM } from '../kicad/schematic'
import { measureTextWidth } from '../kicad/newstroke'
import { PIN_TYPES, type PinType } from '../../../../shared/itemRecords'

export { PIN_TYPES }

export type SymbolGroupRole = 'power' | 'ground' | 'signal'
export type SymbolSide = 'left' | 'right' | 'top' | 'bottom'

export type SymbolPinType = PinType

export interface SymbolGroupSpec {
  id: string
  role: SymbolGroupRole
  /** Where the caller wants the group, overriding the role's side and the
   *  balancer both. For the case the rule gets wrong — a regulator's VIN is a
   *  rail by type and belongs on the left by convention. */
  side?: SymbolSide
}

export interface SymbolPinSpec {
  /** Pad number/name exactly as the datasheet prints it. */
  number: string
  /** Signal name, which for a stacked pad is the NET's name. */
  name: string
  type: SymbolPinType
  /** Required. The cohesion key — opaque, compared only for equality. */
  group: string
  /** Pad this shares a net, and therefore a coordinate, with. */
  stackWith?: string
  /** Leave off the symbol entirely. The footprint still carries the pad. */
  omit?: boolean
}

export interface LaidOutPin {
  number: string
  name: string
  /** May differ from the spec: every pad after the first in a stack becomes
   *  `passive`, which is what stops ERC seeing several drivers on one net. */
  type: SymbolPinType
  x: Nm
  y: Nm
  angle: number
  length: Nm
  side: SymbolSide
  group: string
  /** True for every pad after the first in a stack. The standard library hides
   *  them, and it is right to: two visible pins at one coordinate read as a
   *  drawing mistake and give a reader no way to tell which is which. */
  hidden?: true
}

export interface SymbolLayout {
  body: { minX: Nm; minY: Nm; maxX: Nm; maxY: Nm }
  /**
   * Where the two visible fields go, both left-justified on one line above the
   * symbol: Reference at the body's left edge, Value clear of the rightmost top
   * pin.
   *
   * Above the body, because Reference sits there on 92% of 2–64 pin symbols and
   * nothing in IEEE 315 or IEC 60617 says otherwise — those govern the graphics
   * and the designator letter classes, not where the text is drawn.
   *
   * **Off the pin columns**, because that is where the wires go. Centered at
   * x = 0 — the first version — put both fields directly in the path a wire
   * takes upward out of a top pin, so the label sat on the connection point. The
   * bottom is left entirely clear for the same reason.
   */
  fields: {
    reference: { x: Nm; y: Nm; justify: 'left' }
    value: { x: Nm; y: Nm; justify: 'left' }
  }
  pins: LaidOutPin[]
  /** Reported because they are decisions a reader cannot recover from the
   *  drawing — the pads are simply not there. */
  omitted: string[]
  stacks: { primary: string; stacked: string[] }[]
  pinLength: Nm
  /** Not refusals — things worth saying out loud, so a lopsided symbol is
   *  reported rather than quietly handed over. */
  warnings: string[]
}

export type SymbolPlan =
  { ok: true; layout: SymbolLayout } | { ok: false; error: string; detail?: string }

// Every spacing below is authored in **mil**, which is the unit these are
// actually specified in — a schematic grid is 100 mil, a pin is 100 or 200,
// text is 50. Writing them as millimetres means writing 2.54 and 5.08 and
// 1.27, which are exact but read as arbitrary and invite someone to round one.
// (`nm(100 * NM_PER_MIL)` is the house form.)

/** The pin pitch, and every spacing in here. */
const PITCH = nm(100 * NM_PER_MIL)
/** Clear space between the outermost pin row and the body edge. */
const MARGIN = nm(100 * NM_PER_MIL)
/** Measured: 100 mil on 60–83% of pins in symbols of 64 pins or fewer; the
 *  longer 200 mil is what big parts use, where names need the room. */
const SHORT_PIN = nm(100 * NM_PER_MIL)
const LONG_PIN = nm(200 * NM_PER_MIL)
const BIG_SYMBOL_PINS = 64

/** Gap between the body and the field line above it. */
const FIELD_GAP = nm(50 * NM_PER_MIL)

/**
 * Where a pin's name starts: KiCad draws it inside the body, this far past the
 * body edge (`pin_names offset`, the 0.508 mm `symbolEdit.ts` writes). Part of
 * every reach and clearance below, because a name that starts half a
 * millimetre in ends half a millimetre further along.
 */
const PIN_NAME_OFFSET = nm(20 * NM_PER_MIL)
/** Half the text height: a name's box extends this far either side of its pin. */
const TEXT_HALF = DEFAULT_FONT_SIZE_NM / 2
/**
 * The one clearance: no two pieces of text in the same region come closer than
 * this, on either axis, and no name comes closer than this to the body edge it
 * runs toward. 50 mil — half a pitch — is what the standard library's
 * hand-drawn symbols visibly keep between facing names. Before this constant
 * existed each sizing rule computed the exact touching size and left the
 * rounding to make a gap, which sometimes made one of 0.006 mm.
 */
export const TEXT_CLEARANCE = nm(50 * NM_PER_MIL)
/** Where a pin's number sits off its line. */
const NUMBER_GAP = nm(8 * NM_PER_MIL)
/**
 * A rail's name runs down into the body and pushes every side row below it,
 * so past this length it is refused (`rail-name-too-long`) rather than drawn
 * as a tall empty box: about 8 mm, six or seven characters at 50 mil.
 */
const RAIL_NAME_LIMIT = nm(315 * NM_PER_MIL)
/** Growth steps before the loop gives up and says so. */
const MAX_GROWTH = 64

/**
 * Where a group's pins go.
 *
 * Measured on the class this generates (2–20 pin symbols): grounds sit on the
 * bottom 94% of the time, rails on top 83%, inputs left 77%, outputs right 85%.
 * Power is placed by the group's declared **role** and never by pin type,
 * because KiCad has no ground type — `VDD` and `GND` are both `power_in`, and
 * that type alone shows no directional preference at all.
 */
export const sideForGroup = (
  role: SymbolGroupRole,
  pins: SymbolPinSpec[],
  side?: SymbolSide
): SymbolSide => {
  if (side) return side
  if (role === 'power') return 'top'
  if (role === 'ground') return 'bottom'
  // A signal group goes left when it is mostly inputs, and right otherwise.
  // `bidirectional` splits 39/60 in the library, which is not a preference to
  // approximate but the absence of a rule — so it goes right, every time. An
  // I²C group consistently on the right is worth more than a coin flip.
  // A supply the caller filed as a signal — a regulator's VIN — flows in, and
  // counts as one.
  const inputs = pins.filter((pin) => pin.type === 'input' || pin.type === 'power_in').length
  return inputs * 2 > pins.length ? 'left' : 'right'
}

const ANGLE: Record<SymbolSide, number> = { left: 0, right: 180, top: 270, bottom: 90 }

/**
 * Above this many signal slots, sides are **balanced** rather than assigned by
 * preference alone.
 *
 * Below it the deterministic rule is better: an I²C pair always on the right is
 * worth more than a symbol that shuffles because a group was added. Above it,
 * preference produces the failure this exists to stop — every `bidirectional`
 * group lands right, and a 41-pin module came out a 10 × 97 mm sliver where the
 * standard library draws the same part as a 25 × 51 box.
 */
const BALANCE_ABOVE = 12

/** Past this many pins on one side, say so. Groups are never split, so a caller
 *  who hands over one huge bank still gets a tall symbol — and the fix is
 *  theirs, not geometry's. */
const LOPSIDED_SIDE = 20

/**
 * Slot offsets for `count` pins along one side.
 *
 * Centered, but **snapped so every pin lands on the 100 mil grid** — the naive
 * centring of an even count puts pins on half-pitch offsets, off the grid a
 * wire has to meet. The bias is toward the top/left, which is what the
 * library's own SCD40 does with its two right-hand pins (one pitch and zero).
 */
export const slotOffsets = (count: number): number[] => {
  if (count <= 0) return []
  const first = Math.ceil((count - 1) / 2) * PITCH
  return Array.from({ length: count }, (_, index) => first - index * PITCH)
}

/**
 * The width a name or number is actually drawn at, from the stroke font the
 * renderer and KiCad both use. An estimate per character was the first
 * version, and it was the reason facing names touched: `I` and `W` are not the
 * same width, and a guess that is safe on average is wrong on the names that
 * matter.
 */
export const textWidth = (text: string): number =>
  measureTextWidth(text.replace(/^~/, ''), {
    width: DEFAULT_FONT_SIZE_NM,
    height: DEFAULT_FONT_SIZE_NM,
    thickness: DEFAULT_FONT_SIZE_NM / 8
  })
const nameWidth = textWidth

/** Round up to the fine grid so the body outline lands on it. */
const roundUp = (value: number, step: number): number => Math.ceil(value / step) * step

/** One piece of drawn text, as the rectangle it occupies in symbol space (nm, y up). */
export interface SymbolTextBox {
  label: string
  kind: 'name' | 'number' | 'field'
  /** The axis the text runs along. */
  orient: 'h' | 'v'
  /** Names are inside the body; numbers and fields outside it. Text only
   *  collides with text in its own region — the body edge separates the two. */
  region: 'inside' | 'outside'
  minX: number
  minY: number
  maxX: number
  maxY: number
}

/**
 * Every piece of text a layout draws, boxed the way KiCad draws it: a name
 * inside the body along its pin, starting `PIN_NAME_OFFSET` past the edge; a
 * number beside the pin outside the body, centered on its length; the two
 * fields on their line. The ONE model of where text is — the layout sizes the
 * body by it and the tests judge the result by it, so the two cannot disagree.
 */
export const symbolTextBoxes = (
  layout: Pick<SymbolLayout, 'body' | 'pins' | 'fields'>,
  reference: string,
  value = ''
): SymbolTextBox[] => {
  const boxes: SymbolTextBox[] = []
  const box = (
    label: string,
    kind: SymbolTextBox['kind'],
    orient: SymbolTextBox['orient'],
    x0: number,
    y0: number,
    x1: number,
    y1: number
  ): void => {
    boxes.push({
      label,
      kind,
      orient,
      region: kind === 'name' ? 'inside' : 'outside',
      minX: Math.min(x0, x1),
      minY: Math.min(y0, y1),
      maxX: Math.max(x0, x1),
      maxY: Math.max(y0, y1)
    })
  }
  for (const pin of layout.pins) {
    if (pin.hidden) continue
    const { x, y, length } = pin
    const nameW = textWidth(pin.name)
    const numW = textWidth(pin.number)
    const name = `name ${pin.name}`
    const number = `number ${pin.number}`
    switch (pin.angle) {
      case 0: {
        // Left side: the pin points +x into the body.
        const inner = x + length
        box(
          name,
          'name',
          'h',
          inner + PIN_NAME_OFFSET,
          y - TEXT_HALF,
          inner + PIN_NAME_OFFSET + nameW,
          y + TEXT_HALF
        )
        box(
          number,
          'number',
          'h',
          x + length / 2 - numW / 2,
          y + NUMBER_GAP,
          x + length / 2 + numW / 2,
          y + NUMBER_GAP + DEFAULT_FONT_SIZE_NM
        )
        break
      }
      case 180: {
        const inner = x - length
        box(
          name,
          'name',
          'h',
          inner - PIN_NAME_OFFSET - nameW,
          y - TEXT_HALF,
          inner - PIN_NAME_OFFSET,
          y + TEXT_HALF
        )
        box(
          number,
          'number',
          'h',
          x - length / 2 - numW / 2,
          y + NUMBER_GAP,
          x - length / 2 + numW / 2,
          y + NUMBER_GAP + DEFAULT_FONT_SIZE_NM
        )
        break
      }
      case 270: {
        // Top side: the pin points -y into the body; its number sits to its left.
        const inner = y - length
        box(
          name,
          'name',
          'v',
          x - TEXT_HALF,
          inner - PIN_NAME_OFFSET - nameW,
          x + TEXT_HALF,
          inner - PIN_NAME_OFFSET
        )
        box(
          number,
          'number',
          'v',
          x - NUMBER_GAP - DEFAULT_FONT_SIZE_NM,
          y - length / 2 - numW / 2,
          x - NUMBER_GAP,
          y - length / 2 + numW / 2
        )
        break
      }
      case 90: {
        const inner = y + length
        box(
          name,
          'name',
          'v',
          x - TEXT_HALF,
          inner + PIN_NAME_OFFSET,
          x + TEXT_HALF,
          inner + PIN_NAME_OFFSET + nameW
        )
        box(
          number,
          'number',
          'v',
          x - NUMBER_GAP - DEFAULT_FONT_SIZE_NM,
          y + length / 2 - numW / 2,
          x - NUMBER_GAP,
          y + length / 2 + numW / 2
        )
        break
      }
    }
  }
  const field = (label: string, at: { x: number; y: number }, text: string): void => {
    if (!text) return
    box(
      `field ${label}`,
      'field',
      'h',
      at.x,
      at.y - TEXT_HALF,
      at.x + textWidth(text),
      at.y + TEXT_HALF
    )
  }
  field('Reference', layout.fields.reference, reference)
  field('Value', layout.fields.value, value)
  return boxes
}

/** Two pieces of text closer than the clearance, or a name against the far
 *  edge, and the axis whose growth separates them. */
export interface TextViolation {
  a: string
  b: string
  /** `x`/`y`: grow the body along that axis; `lift`: raise the field line. */
  axis: 'x' | 'y' | 'lift'
}

const EPSILON = 1

/**
 * What is too close, judged with `TEXT_CLEARANCE`. A pair violates when its
 * gap is under the clearance on BOTH axes — two names in adjacent rows are a
 * pitch apart vertically and may run to any length. The axis answers "what
 * separates them": two side names grow the width, anything involving a rail's
 * vertical name grows the height (the rows move away from the rail — the
 * policy that keeps the body no wider than its side names need), and a
 * number against a field lifts the field line rather than resizing the body.
 */
export const textViolations = (
  boxes: SymbolTextBox[],
  body: SymbolLayout['body']
): TextViolation[] => {
  const out: TextViolation[] = []
  for (const box of boxes) {
    if (box.kind !== 'name') continue
    // A name starts within the offset of one edge; the far end must stay clear
    // of the other. Which edge is "far" falls out of the geometry: the box is
    // near both only when it has crossed the body.
    const clear = TEXT_CLEARANCE - EPSILON
    if (box.orient === 'h' && box.minX < body.minX + clear && box.maxX > body.maxX - clear) {
      out.push({ a: box.label, b: 'the body edge', axis: 'x' })
    }
    if (box.orient === 'v' && box.minY < body.minY + clear && box.maxY > body.maxY - clear) {
      out.push({ a: box.label, b: 'the body edge', axis: 'y' })
    }
  }
  const gap = (a0: number, a1: number, b0: number, b1: number): number =>
    Math.max(0, b0 - a1, a0 - b1)
  for (let i = 0; i < boxes.length; i++) {
    for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i]
      const b = boxes[j]
      if (a.region !== b.region) continue
      const fields = Number(a.kind === 'field') + Number(b.kind === 'field')
      // A field beside a pin number keeps the library's own convention —
      // Reference sits 50 mil above the body on 3,772 of 4,700 symbols, with
      // a top pin's number right there beside it — so that one pair is judged
      // on overlap alone, and the field line lifts only when they actually
      // cross. Everything else keeps the clearance.
      const required = fields === 1 ? 0 : TEXT_CLEARANCE
      if (gap(a.minX, a.maxX, b.minX, b.maxX) >= required - EPSILON) continue
      if (gap(a.minY, a.maxY, b.minY, b.maxY) >= required - EPSILON) continue
      const axis: TextViolation['axis'] =
        fields === 1 ? 'lift' : a.orient === 'h' && b.orient === 'h' ? 'x' : 'y'
      out.push({ a: a.label, b: b.label, axis })
    }
  }
  return out
}

interface Stack {
  primary: SymbolPinSpec
  members: SymbolPinSpec[]
}

/**
 * Validate a spec and lay it out.
 *
 * Refuses rather than repairs. Every failure here is a partial or contradictory
 * pin table, and a symbol built from one looks finished — which is worse than
 * no symbol, because nobody goes back to check it.
 */
export function planSymbol(
  groups: SymbolGroupSpec[],
  pins: SymbolPinSpec[],
  options?: { reference?: string }
): SymbolPlan {
  if (!pins.length) return { ok: false, error: 'no-pins' }

  const seen = new Set<string>()
  for (const pin of pins) {
    if (!pin.number.trim()) return { ok: false, error: 'blank-pin-number' }
    const key = pin.number.trim()
    if (seen.has(key)) return { ok: false, error: 'duplicate-pin-number', detail: key }
    seen.add(key)
  }

  const byId = new Map(groups.map((group) => [group.id, group]))
  for (const pin of pins) {
    if (pin.omit) continue
    if (!pin.group || !byId.has(pin.group)) {
      return {
        ok: false,
        error: 'unknown-group',
        detail: `${pin.number} → ${pin.group || '(none)'}`
      }
    }
  }

  const omitted = pins.filter((pin) => pin.omit).map((pin) => pin.number.trim())
  const drawn = pins.filter((pin) => !pin.omit)
  if (!drawn.length) return { ok: false, error: 'everything-omitted' }

  // A table with no rails and no grounds is almost always a partial extraction,
  // and the resulting symbol looks complete.
  const roles = new Set(drawn.map((pin) => byId.get(pin.group)!.role))
  if (!roles.has('power') && !roles.has('ground')) {
    return { ok: false, error: 'no-power-pins' }
  }

  // --- stacks: resolve each chain to the pad it ultimately sits on -----------
  const byNumber = new Map(drawn.map((pin) => [pin.number.trim(), pin]))
  const primaryOf = new Map<string, string>()
  for (const pin of drawn) {
    const target = pin.stackWith?.trim()
    if (!target) continue
    if (!byNumber.has(target)) {
      return { ok: false, error: 'stack-target-missing', detail: `${pin.number} → ${target}` }
    }
    if (target === pin.number.trim()) {
      return { ok: false, error: 'stack-self', detail: pin.number }
    }
    let cursor = target
    const walked = new Set([pin.number.trim()])
    for (let hops = 0; ; hops++) {
      if (walked.has(cursor)) return { ok: false, error: 'stack-cycle', detail: pin.number }
      walked.add(cursor)
      const next = byNumber.get(cursor)?.stackWith?.trim()
      if (!next) break
      if (hops > 32) return { ok: false, error: 'stack-cycle', detail: pin.number }
      cursor = next
    }
    primaryOf.set(pin.number.trim(), cursor)
  }

  const stacks = new Map<string, Stack>()
  for (const pin of drawn) {
    const key = primaryOf.get(pin.number.trim()) ?? pin.number.trim()
    const existing = stacks.get(key)
    if (existing) existing.members.push(pin)
    else stacks.set(key, { primary: byNumber.get(key)!, members: [] })
  }
  // A stacked pad must sit with its primary, so it inherits its primary's group.
  for (const stack of stacks.values()) {
    for (const member of stack.members) {
      if (member.group !== stack.primary.group) member.group = stack.primary.group
    }
  }

  // --- sides: one decision per group, in the caller's order ------------------
  const order = groups.map((group) => group.id)
  const slotsBySide: Record<SymbolSide, Stack[]> = { left: [], right: [], top: [], bottom: [] }
  const signal: { id: string; members: Stack[]; prefers: SymbolSide }[] = []

  for (const id of order) {
    const members = [...stacks.values()].filter((stack) => stack.primary.group === id)
    if (!members.length) continue
    const group = byId.get(id)!
    const side = sideForGroup(
      group.role,
      members.map((stack) => stack.primary),
      group.side
    )
    // A side the caller chose is not the balancer's to move.
    if (side === 'top' || side === 'bottom' || group.side) {
      slotsBySide[side].push(...members)
      continue
    }
    signal.push({ id, members, prefers: side })
  }

  // A group is contiguous and never split across sides — the rule a per-pin
  // policy cannot express, and the one that keeps a two-wire bus together.
  const signalSlots = signal.reduce((total, group) => total + group.members.length, 0)
  if (signalSlots <= BALANCE_ABOVE) {
    // Small symbol: the deterministic preference, so the same part always comes
    // out the same way.
    for (const group of signal) slotsBySide[group.prefers].push(...group.members)
  } else {
    // Large symbol: largest group first into the emptier side, so the columns
    // finish close in length. Ties go to the group's own preference.
    const counts: Record<'left' | 'right', number> = { left: 0, right: 0 }
    for (const group of [...signal].sort((a, b) => b.members.length - a.members.length)) {
      const side: 'left' | 'right' =
        counts.left === counts.right
          ? (group.prefers as 'left' | 'right')
          : counts.left < counts.right
            ? 'left'
            : 'right'
      slotsBySide[side].push(...group.members)
      counts[side] += group.members.length
    }
  }

  // Balancing chose which side each group is on; it must not also decide the
  // order down that side. Restore the caller's group order — which is the
  // datasheet's, and the only sequence anyone reading the symbol expects.
  const groupRank = new Map(order.map((id, index) => [id, index]))
  for (const side of ['left', 'right'] as const) {
    slotsBySide[side].sort(
      (a, b) => (groupRank.get(a.primary.group) ?? 0) - (groupRank.get(b.primary.group) ?? 0)
    )
  }

  const warnings: string[] = []
  const busiest = Math.max(slotsBySide.left.length, slotsBySide.right.length)
  if (busiest > LOPSIDED_SIDE && signal.length) {
    const biggest = signal.reduce((a, b) => (b.members.length > a.members.length ? b : a))
    warnings.push(
      `${busiest} pins on one side makes a very tall symbol. Groups are never split, so this cannot be balanced here — the largest is "${biggest.id}" with ${biggest.members.length} pins. Divide it into functional sub-groups (a bus, a bank, a peripheral) and they can be spread across both sides.`
    )
  }

  // --- geometry -------------------------------------------------------------
  // A rail's name runs vertically into the body, and every side row whose name
  // reaches its column has to start below it — so a long rail name costs the
  // whole symbol's height. Past this length it is a side pin by any drafter's
  // convention, and the caller is told so rather than handed a tall empty box.
  for (const side of ['top', 'bottom'] as const) {
    for (const stack of slotsBySide[side]) {
      const width = nameWidth(stack.primary.name)
      if (width > RAIL_NAME_LIMIT) {
        return {
          ok: false,
          error: 'rail-name-too-long',
          detail: `${stack.primary.name} is ${(width / NM_PER_MM).toFixed(1)} mm of text on the ${side}`
        }
      }
    }
  }

  // A pin carries its number, so it is at least as long as the number is wide:
  // `B11` on a 100 mil pin spills into the body and over the name.
  const widestNumber = [...stacks.values()].reduce(
    (widest, stack) => Math.max(widest, textWidth(stack.primary.number.trim())),
    0
  )
  const pinLength =
    drawn.length > BIG_SYMBOL_PINS || widestNumber > SHORT_PIN ? LONG_PIN : SHORT_PIN
  const vertical = Math.max(slotsBySide.left.length, slotsBySide.right.length)
  const horizontal = Math.max(slotsBySide.top.length, slotsBySide.bottom.length)

  const widestName = (side: SymbolSide): number =>
    slotsBySide[side].reduce((widest, stack) => Math.max(widest, nameWidth(stack.primary.name)), 0)

  // A first estimate of the body, from the facing names on each axis and the
  // pin columns. It is only a starting point: the loop below sizes the body by
  // what is actually drawn, so an estimate that is short costs an iteration
  // and nothing else. Rounded to the PITCH, not the finer 1.27 grid: a side pin
  // sits at halfW + length, so a half-width off the 2.54 lattice puts every pin
  // on that side off it too — and a pin off the grid is one a wire cannot meet.
  const namesWidth = widestName('left') + widestName('right') + 2 * PIN_NAME_OFFSET + TEXT_CLEARANCE
  const columnWidth = horizontal ? Math.abs(slotOffsets(horizontal)[0]) * 2 + MARGIN * 2 : 0
  let halfW = Math.max(PITCH, roundUp(Math.max(namesWidth, columnWidth) / 2, PITCH))
  const maxRowOffset = vertical ? Math.abs(slotOffsets(vertical)[0]) : 0
  const namesHeight =
    widestName('top') + widestName('bottom') + 2 * PIN_NAME_OFFSET + TEXT_CLEARANCE
  let halfH = Math.max(PITCH, roundUp(Math.max(maxRowOffset + MARGIN, namesHeight / 2), PITCH))
  // How far the field line is lifted above its usual 50 mil, when a top pin's
  // number would otherwise sit against Reference or Value.
  let fieldLift = 0

  const placePins = (halfW: number, halfH: number): LaidOutPin[] => {
    const laid: LaidOutPin[] = []
    for (const side of ['left', 'right', 'top', 'bottom'] as const) {
      const column = slotsBySide[side]
      // Offsets run high to low: top-down on a side, but right-to-left along a
      // row, so a row takes them reversed to read in the caller's order.
      const offsets =
        side === 'top' || side === 'bottom'
          ? slotOffsets(column.length).reverse()
          : slotOffsets(column.length)
      column.forEach((stack, index) => {
        const offset = offsets[index]
        const at =
          side === 'left'
            ? { x: -halfW - pinLength, y: offset }
            : side === 'right'
              ? { x: halfW + pinLength, y: offset }
              : side === 'top'
                ? { x: offset, y: halfH + pinLength }
                : { x: offset, y: -halfH - pinLength }
        // The primary keeps its declared type; everything stacked on it becomes
        // passive, so ERC sees one driver on the net rather than several.
        for (const [rank, pin] of [stack.primary, ...stack.members].entries()) {
          laid.push({
            number: pin.number.trim(),
            name: pin.name,
            type: rank === 0 ? pin.type : 'passive',
            ...(rank === 0 ? {} : { hidden: true as const }),
            x: nm(at.x),
            y: nm(at.y),
            angle: ANGLE[side],
            length: pinLength,
            side,
            group: pin.group
          })
        }
      })
    }
    return laid
  }

  // One line, 50 mil above the body — the library's own mode (3,772 of the 4,700
  // symbols that put Reference above the body put it exactly there) — lifted
  // only when a top pin's number would touch it.
  //
  // It does NOT also clear the pin length. An earlier version did, from when
  // both fields were centered at x = 0 and had to get out of a top pin's way
  // vertically; offset sideways off the pin columns, that extra 100 mil only
  // floated the labels away from the symbol they name.
  //
  // Value goes one pitch to the right of the rightmost top pin — far enough to
  // clear that pin and its number, near enough to still read as this symbol's
  // label. Measuring from the body's right edge instead put it a long way out
  // on a wide part, which is the "not incredibly so" this avoids. With no top
  // pins there is nothing to clear, so it anchors at the body's center, where
  // Reference (at the left edge) cannot reach it.
  const fieldsFor = (halfW: number, halfH: number, laid: LaidOutPin[]): SymbolLayout['fields'] => {
    const fieldLine = halfH + FIELD_GAP + fieldLift
    const topPinXs = laid.filter((pin) => pin.side === 'top').map((pin) => pin.x)
    const valueX = topPinXs.length ? Math.max(...topPinXs) + PITCH : 0
    return {
      reference: { x: nm(-halfW), y: nm(fieldLine), justify: 'left' },
      value: { x: nm(valueX), y: nm(fieldLine), justify: 'left' }
    }
  }
  const bodyOf = (halfW: number, halfH: number): SymbolLayout['body'] => ({
    minX: nm(-halfW),
    minY: nm(-halfH),
    maxX: nm(halfW),
    maxY: nm(halfH)
  })

  // Place, check, grow. Every piece of text becomes a box through ONE function
  // (`symbolTextBoxes`, the same one the tests judge with), the closest pair
  // under `TEXT_CLEARANCE` names the axis that separates them, the body grows
  // one pitch along it, and the pins are placed again. Growth is monotone, so
  // this ends; the cap is for a table no size can satisfy, which is reported
  // rather than looped on. This replaced three pairwise sizing rules, each of
  // which computed the exact touching size and left the rounding to make a gap.
  const referenceText = `${options?.reference ?? 'U'}?`
  let laid = placePins(halfW, halfH)
  let fields = fieldsFor(halfW, halfH, laid)
  for (let grown = 0; ; grown++) {
    const body = bodyOf(halfW, halfH)
    const found = textViolations(symbolTextBoxes({ body, pins: laid, fields }, referenceText), body)
    if (!found.length) break
    if (grown >= MAX_GROWTH) {
      warnings.push(
        `The body could not be sized to keep "${found[0].a}" clear of "${found[0].b}". Shorten a name or move its group to another side.`
      )
      break
    }
    if (found[0].axis === 'lift') fieldLift += PITCH
    else if (found[0].axis === 'x') halfW += PITCH
    else halfH += PITCH
    laid = placePins(halfW, halfH)
    fields = fieldsFor(halfW, halfH, laid)
  }

  return {
    ok: true,
    layout: {
      body: bodyOf(halfW, halfH),
      fields,
      pins: laid,
      omitted,
      stacks: [...stacks.values()]
        .filter((stack) => stack.members.length > 0)
        .map((stack) => ({
          primary: stack.primary.number.trim(),
          stacked: stack.members.map((member) => member.number.trim())
        })),
      pinLength,
      warnings
    }
  }
}
