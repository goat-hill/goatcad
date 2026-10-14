// Parts follow KiCad's source, named below: Copyright The KiCad Developers, GPL-3.0-or-later.
/**
 * The condition language of `.kicad_dru` rules — `A.NetClass == 'Power' &&
 * B.Type == 'Via'` — compiled to a predicate over a pair of rule items.
 *
 * It behaves as KiCad's evaluator does (`libeval_compiler`,
 * `pcbexpr_evaluator.cpp`), quirks included, since a project's rules must mean
 * the same thing in both apps:
 * - `||` binds tighter than `&&`, and `!` tighter than a comparison;
 * - comparing an undefined property is false either way, `==` or `!=`;
 * - strings compare case-insensitively, as wildcards when the right-hand
 *   literal holds `*` or `?`; a layer compares as a case-sensitive pattern;
 * - a number carries its unit (`mm`, `mil`, `in`, `deg`); values are millimeters;
 * - only a space separates tokens, and the last of several `;`-separated
 *   statements is the result; an empty condition is true.
 * Anything it does not know yet — a property or function no board item here
 * exposes — compiles to "undefined", and the compile result lists it.
 */
import type { ConditionContext, RuleItem } from './constraints'
import { inDiffPair, isCoupledDiffPair, wildcard } from './diffPairs'

/** A value an expression computes. */
type Value =
  | { kind: 'number'; value: number }
  | { kind: 'string'; value: string; wildcard: boolean }
  | { kind: 'undefined' }
  | { kind: 'null' }
  /** A layer, compared as a pattern against the board's layer names. */
  | { kind: 'layer'; layers: readonly string[] }
  /** A net class, equal to any of its constituents' names. */
  | { kind: 'netclass'; constituents: readonly string[]; full: string }
  /** A net, equal to another by number and to a string by name. */
  | { kind: 'netname'; net: number; name: string }

const UNDEFINED: Value = { kind: 'undefined' }
const TRUE: Value = { kind: 'number', value: 1 }
const FALSE: Value = { kind: 'number', value: 0 }
const bool = (b: boolean): Value => (b ? TRUE : FALSE)

/** Units as KiCad's rule evaluator reads them, to millimeters (degrees and times as given). */
const UNITS: Record<string, number> = { mm: 1, mil: 0.0254, in: 25.4, deg: 1, ps: 1, fs: 0.001 }

/** What a condition needs from the board beyond the two items: layers, areas, courtyards. */
export interface RuleEnvironment {
  /** Every layer whose canonical or user name matches the pattern (case-sensitive wildcard). */
  layersMatching(pattern: string): ReadonlySet<string>
  netNames: ReadonlySet<string>
  /** `intersectsArea` / `insideArea`: the item touches a zone or rule area the selector names. */
  intersectsArea?(item: RuleItem, selector: string, context: ConditionContext): boolean
  /** `enclosedByArea`: the item lies wholly inside one. */
  enclosedByArea?(item: RuleItem, selector: string, context: ConditionContext): boolean
  /** `intersectsCourtyard` and its front/back forms. */
  intersectsCourtyard?(
    item: RuleItem,
    selector: string,
    side: 'any' | 'front' | 'back',
    context: ConditionContext
  ): boolean
  /** `memberOfFootprint`: the item's footprint matches the selector (a reference or library id). */
  memberOfFootprint?(item: RuleItem, selector: string): boolean
  /** `memberOfGroup` (and the older `memberOf`): a group holding the item, or one above it, is named so. */
  memberOfGroup?(item: RuleItem, name: string): boolean
  /** `fromTo`: the item lies on the path between the pads the two selectors name. */
  fromTo?(item: RuleItem, from: string, to: string): boolean
}

export interface CompiledCondition {
  test: (context: ConditionContext) => boolean
  /** Properties and functions the expression names that no item here exposes. */
  unsupported: string[]
}

export class ExpressionError extends Error {}

// ---- Lexer -------------------------------------------------------------------

type Token =
  | { type: 'number'; value: number; unit: string | null }
  | { type: 'string'; value: string }
  | { type: 'ident'; value: string }
  | { type: 'op'; value: string }

function lex(source: string): Token[] {
  const tokens: Token[] = []
  let i = 0
  const isDigit = (c: string): boolean => c >= '0' && c <= '9'
  const isAlpha = (c: string): boolean => /[A-Za-z_]/.test(c)
  const isAlnum = (c: string): boolean => /[A-Za-z0-9_]/.test(c)
  while (i < source.length) {
    const c = source[i]
    if (c === ' ') {
      i++
      continue
    }
    if (isDigit(c) || (c === '.' && isDigit(source[i + 1] ?? ''))) {
      let text = ''
      let separator = false
      while (i < source.length) {
        const d = source[i]
        if (isDigit(d)) text += d
        // A comma right after a digit is a decimal separator, as KiCad reads it.
        else if ((d === '.' || d === ',') && !separator) {
          separator = true
          text += '.'
        } else break
        i++
      }
      let unit: string | null = null
      for (const name of Object.keys(UNITS)) {
        if (source.startsWith(name, i) && !isAlnum(source[i + name.length] ?? '')) {
          unit = name
          i += name.length
          break
        }
      }
      tokens.push({ type: 'number', value: Number(text), unit })
      continue
    }
    if (c === "'") {
      let text = ''
      i++
      while (i < source.length && source[i] !== "'") {
        if (source[i] === '\\' && source[i + 1] === "'") {
          text += "'"
          i += 2
          continue
        }
        text += source[i++]
      }
      // An unterminated string runs to the end of the condition, as KiCad reads it.
      if (source[i] === "'") i++
      tokens.push({ type: 'string', value: text })
      continue
    }
    if (isAlpha(c)) {
      let text = ''
      while (i < source.length && isAlnum(source[i])) text += source[i++]
      tokens.push({ type: 'ident', value: text })
      continue
    }
    const two = source.slice(i, i + 2)
    if (['==', '!=', '<=', '>=', '&&', '||'].includes(two)) {
      tokens.push({ type: 'op', value: two })
      i += 2
      continue
    }
    if ('<>+-*/!().,;'.includes(c)) {
      tokens.push({ type: 'op', value: c })
      i++
      continue
    }
    throw new ExpressionError(`Unrecognized character '${c}'`)
  }
  return tokens
}

// ---- Parser: tokens to an evaluator ---------------------------------------------

type Scope = ConditionContext & { env: RuleEnvironment }
type Node = (scope: Scope) => Value

/** Binding powers, loosest first, as KiCad's grammar declares them. */
const BINARY: Record<string, number> = {
  '&&': 2,
  '||': 3,
  '<': 4,
  '>': 4,
  '<=': 4,
  '>=': 4,
  '==': 4,
  '!=': 4,
  '+': 6,
  '-': 6,
  '*': 7,
  '/': 7
}
const UNARY_NOT = 5

class Parser {
  private pos = 0
  readonly unsupported = new Set<string>()
  constructor(private readonly tokens: Token[]) {}

  private peek(): Token | undefined {
    return this.tokens[this.pos]
  }
  private next(): Token {
    const token = this.tokens[this.pos++]
    if (!token) throw new ExpressionError('Unexpected end of expression')
    return token
  }
  private expectOp(op: string): void {
    const token = this.next()
    if (token.type !== 'op' || token.value !== op) throw new ExpressionError(`Expected '${op}'`)
  }

  /** Statements separated by `;`; the last is the result. */
  program(): Node {
    let last: Node = () => TRUE
    while (this.pos < this.tokens.length) {
      const peeked = this.peek()
      if (peeked?.type === 'op' && peeked.value === ';') {
        this.pos++
        continue
      }
      last = this.expression(0)
      const after = this.peek()
      if (after && !(after.type === 'op' && after.value === ';'))
        throw new ExpressionError(`Unexpected '${tokenText(after)}'`)
    }
    return last
  }

  expression(minPower: number): Node {
    let left = this.prefix()
    for (;;) {
      const token = this.peek()
      if (!token || token.type !== 'op') break
      const power = BINARY[token.value]
      if (power === undefined || power <= minPower) break
      this.pos++
      const right = this.expression(power)
      left = binary(token.value, left, right)
    }
    return left
  }

  private prefix(): Node {
    const token = this.next()
    if (token.type === 'op') {
      if (token.value === '(') {
        const inner = this.expression(0)
        this.expectOp(')')
        return inner
      }
      if (token.value === '!') {
        const operand = this.expression(UNARY_NOT)
        return (scope) => bool(truthy(operand(scope)) === false)
      }
      if (token.value === '-') {
        const operand = this.expression(BINARY['*'])
        return (scope) => ({ kind: 'number', value: -numberOf(operand(scope)) })
      }
      if (token.value === '+') return this.expression(BINARY['*'])
      throw new ExpressionError(`Unexpected '${token.value}'`)
    }
    if (token.type === 'number') {
      let unit = token.unit
      // A unit may stand apart from its number (`90 deg`): it is its own token to KiCad.
      const after = this.peek()
      if (!unit && after?.type === 'ident' && after.value in UNITS) {
        unit = after.value
        this.pos++
      }
      const value = unit ? token.value * UNITS[unit] : token.value
      return () => ({ kind: 'number', value })
    }
    if (token.type === 'string') {
      const value: Value = {
        kind: 'string',
        value: token.value,
        wildcard: /[*?]/.test(token.value)
      }
      return () => value
    }
    return this.identifier(token.value)
  }

  private identifier(name: string): Node {
    if (name === 'null') return () => ({ kind: 'null' })
    if (name === 'L')
      return (scope) => ({ kind: 'layer', layers: scope.layer ? [scope.layer] : [] })
    if (name !== 'A' && name !== 'B' && name !== 'AB')
      throw new ExpressionError(`Unknown name '${name}'`)
    const pick = (scope: Scope): RuleItem | null => (name === 'B' ? scope.b : scope.a)
    this.expectOp('.')
    const member = this.next()
    if (member.type !== 'ident') throw new ExpressionError('Expected a property or function')
    const next = this.peek()
    if (next?.type === 'op' && next.value === '(') {
      this.pos++
      const args: string[] = []
      while (!(this.peek()?.type === 'op' && (this.peek() as { value: string }).value === ')')) {
        const arg = this.next()
        if (arg.type === 'string' || arg.type === 'ident') args.push(String(arg.value))
        else if (arg.type === 'number') args.push(String(arg.value))
        else if (arg.value !== ',') throw new ExpressionError('Function arguments are strings')
      }
      this.expectOp(')')
      return this.call(member.value, args, pick)
    }
    return this.property(member.value, pick)
  }

  private property(name: string, pick: (scope: Scope) => RuleItem | null): Node {
    const key = name.replace(/_/g, ' ').toLowerCase()
    const read = PROPERTIES[key]
    if (!read && !ITEM_PROPERTIES.has(key)) this.unsupported.add(name)
    return (scope) => {
      const item = pick(scope)
      if (!item) return UNDEFINED
      if (read) return read(item, scope)
      const raw = item.property?.(key) ?? item.ownerProperty?.(key)
      return raw === undefined ? UNDEFINED : fromRaw(raw)
    }
  }

  private call(fn: string, args: string[], pick: (scope: Scope) => RuleItem | null): Node {
    const arg = args[0] ?? ''
    const on =
      (test: (item: RuleItem, scope: Scope) => boolean): Node =>
      (scope) => {
        const item = pick(scope)
        return item ? bool(test(item, scope)) : FALSE
      }
    const context = (scope: Scope): ConditionContext => ({
      a: scope.a,
      b: scope.b,
      layer: scope.layer,
      type: scope.type
    })
    switch (fn.toLowerCase()) {
      case 'existsonlayer':
        return on((item, scope) => {
          const layers = scope.env.layersMatching(arg)
          return item.layers.some((layer) => layers.has(layer))
        })
      case 'isplated':
        return on(
          (item) =>
            item.kind === 'via' ||
            (item.kind === 'pad' &&
              item.hasHole === true &&
              item.property?.('pad type') === 'Through-hole')
        )
      case 'hasnetclass':
        return on((item) =>
          (item.netClass ?? '').split(',').some((cls) => cls !== '' && wildcard(arg, cls))
        )
      case 'hasexactnetclass':
        return on((item) => item.netClass === arg)
      case 'indiffpair':
        return on((item, scope) => inDiffPair(item.netName, arg, scope.env.netNames))
      case 'iscoupleddiffpair':
        return (scope) => bool(isCoupledDiffPair(context(scope), scope.env.netNames))
      case 'ismicrovia':
        return on((item) => item.viaType === 'micro')
      case 'isblindvia':
        return on((item) => item.viaType === 'blind')
      case 'isburiedvia':
        return on((item) => item.viaType === 'buried')
      case 'isblindburiedvia':
        return on((item) => item.viaType === 'blind' || item.viaType === 'buried')
      case 'intersectsarea':
      case 'insidearea':
        return on((item, scope) => scope.env.intersectsArea?.(item, arg, context(scope)) ?? false)
      case 'enclosedbyarea':
        return on((item, scope) => scope.env.enclosedByArea?.(item, arg, context(scope)) ?? false)
      case 'intersectscourtyard':
      case 'insidecourtyard':
        return on(
          (item, scope) =>
            scope.env.intersectsCourtyard?.(item, arg, 'any', context(scope)) ?? false
        )
      case 'intersectsfrontcourtyard':
      case 'insidefrontcourtyard':
        return on(
          (item, scope) =>
            scope.env.intersectsCourtyard?.(item, arg, 'front', context(scope)) ?? false
        )
      case 'intersectsbackcourtyard':
      case 'insidebackcourtyard':
        return on(
          (item, scope) =>
            scope.env.intersectsCourtyard?.(item, arg, 'back', context(scope)) ?? false
        )
      case 'memberoffootprint':
        return on((item, scope) => scope.env.memberOfFootprint?.(item, arg) ?? false)
      case 'memberofgroup':
      case 'memberof':
        return on((item, scope) => arg !== '' && (scope.env.memberOfGroup?.(item, arg) ?? false))
      case 'memberofsheet':
        return on((item) => onSheet(item.sheetName, arg, false))
      case 'memberofsheetorchildren':
        return on((item) => onSheet(item.sheetName, arg, true))
      case 'hascomponentclass':
        return on((item) => item.componentClasses?.includes(arg) ?? false)
      case 'fromto':
        // KiCad builds the paths only for its length, skew and pair checks;
        // asked by any other, it finds none.
        return on(
          (item, scope) =>
            FROM_TO_TYPES.has(scope.type) && (scope.env.fromTo?.(item, arg, args[1] ?? '') ?? false)
        )
      case 'getfield':
        // Only a footprint answers, with the field's text; anything else reads empty.
        return (scope) => ({
          kind: 'string',
          value: pick(scope)?.fields?.get(arg) ?? '',
          wildcard: false
        })
      default:
        this.unsupported.add(`${fn}()`)
        return () => FALSE
    }
  }
}

/** The checks KiCad answers `fromTo` for: where it builds the from–to paths. */
const FROM_TO_TYPES: ReadonlySet<string> = new Set([
  'length',
  'skew',
  'via_count',
  'diff_pair_gap',
  'diff_pair_uncoupled'
])

/**
 * Whether a footprint placed from `sheet` (a path of sheet names, `/` the
 * root) is on the sheet `pattern` names, one trailing slash aside on each:
 * that sheet alone, or with `children` any sheet within it, each level matched
 * as a case-sensitive wildcard. The root names every footprint's sheet when
 * its children count, and only the root's otherwise.
 */
function onSheet(sheet: string | undefined, pattern: string, children: boolean): boolean {
  if (sheet === undefined) return false
  const trim = (path: string): string => (path.endsWith('/') ? path.slice(0, -1) : path)
  const [path, want] = [trim(sheet), trim(pattern)]
  if (want === '') return children || path === ''
  if (!children) return wildcard(want, path)
  const wanted = want.split('/')
  const parts = path.split('/')
  return wanted.length <= parts.length && wanted.every((part, i) => wildcard(part, parts[i]))
}

const tokenText = (token: Token): string =>
  token.type === 'number' ? `${token.value}${token.unit ?? ''}` : String(token.value)

// ---- Values and operators ------------------------------------------------------

const fromRaw = (raw: string | number | null): Value =>
  raw === null
    ? { kind: 'null' }
    : typeof raw === 'number'
      ? { kind: 'number', value: raw }
      : { kind: 'string', value: raw, wildcard: false }

const numberOf = (value: Value): number => (value.kind === 'number' ? value.value : 0)
const truthy = (value: Value): boolean => numberOf(value) !== 0

const stringOf = (value: Value): string | null => {
  switch (value.kind) {
    case 'string':
      return value.value
    case 'layer':
      return value.layers[0] ?? ''
    case 'netclass':
      return value.full
    case 'netname':
      return value.name
    default:
      return null
  }
}

/** Case-insensitive, and a wildcard when the right-hand literal is one. */
const stringsEqual = (left: string, right: Value): boolean => {
  if (right.kind !== 'string') return left.toLowerCase() === (stringOf(right) ?? '').toLowerCase()
  return right.wildcard
    ? wildcard(right.value.toLowerCase(), left.toLowerCase())
    : left.toLowerCase() === right.value.toLowerCase()
}

function equal(left: Value, right: Value, scope: Scope): boolean | null {
  if (left.kind === 'undefined' || right.kind === 'undefined') return null
  if (left.kind === 'null' || right.kind === 'null') return left.kind === right.kind
  switch (left.kind) {
    case 'layer': {
      if (right.kind !== 'string') return left.layers.some((l) => stringOf(right) === l)
      const matched = scope.env.layersMatching(right.value)
      return left.layers.some((layer) => matched.has(layer))
    }
    case 'netclass':
      if (right.kind === 'netclass') return left.full === right.full
      return (
        left.constituents.some((name) => stringsEqual(name, right)) ||
        stringsEqual(left.full, right)
      )
    case 'netname':
      if (right.kind === 'netname') return left.net === right.net
      return stringsEqual(left.name, right)
    case 'number':
      return right.kind === 'number' ? left.value === right.value : false
    case 'string':
      if (right.kind === 'number') return false
      return stringsEqual(left.value, right)
  }
}

function binary(op: string, left: Node, right: Node): Node {
  switch (op) {
    case '&&':
      return (scope) => bool(truthy(left(scope)) && truthy(right(scope)))
    case '||':
      return (scope) => bool(truthy(left(scope)) || truthy(right(scope)))
    case '==':
      return (scope) => bool(equal(left(scope), right(scope), scope) === true)
    case '!=':
      return (scope) => {
        const l = left(scope)
        const r = right(scope)
        if (l.kind === 'undefined' || r.kind === 'undefined') return FALSE
        // A layer's `!=` compares its canonical name, not a pattern.
        if (l.kind === 'layer') return bool(!stringsEqual(l.layers[0] ?? '', r))
        if (l.kind === 'netclass') return bool(equal(l, r, scope) === false)
        return bool(equal(l, r, scope) === false)
      }
    case '<':
      return (scope) => bool(numberOf(left(scope)) < numberOf(right(scope)))
    case '>':
      return (scope) => bool(numberOf(left(scope)) > numberOf(right(scope)))
    case '<=':
      return (scope) => bool(numberOf(left(scope)) <= numberOf(right(scope)))
    case '>=':
      return (scope) => bool(numberOf(left(scope)) >= numberOf(right(scope)))
    case '+':
      return (scope) => ({ kind: 'number', value: numberOf(left(scope)) + numberOf(right(scope)) })
    case '-':
      return (scope) => ({ kind: 'number', value: numberOf(left(scope)) - numberOf(right(scope)) })
    case '*':
      return (scope) => ({ kind: 'number', value: numberOf(left(scope)) * numberOf(right(scope)) })
    case '/':
      return (scope) => ({ kind: 'number', value: numberOf(left(scope)) / numberOf(right(scope)) })
  }
  throw new ExpressionError(`Unknown operator '${op}'`)
}

// ---- Properties -------------------------------------------------------------------

/** KiCad's name for an item's kind, as `A.Type` reads it. */
const TYPE_NAMES: Record<RuleItem['kind'], string> = {
  track: 'Track',
  arc: 'Track',
  via: 'Via',
  pad: 'Pad',
  zone: 'Zone',
  footprint: 'Footprint',
  graphic: 'Graphic',
  text: 'Text',
  textbox: 'Text Box',
  table: 'Table',
  cell: 'Table Cell',
  dimension: 'Dimension',
  leader: 'Leader',
  hole: 'Pad'
}

/**
 * The properties the board's items answer through `RuleItem.property`
 * (`boardRules.ts`), by KiCad's name lower-cased with spaces. An item that
 * has no such property answers undefined, as KiCad's does.
 */
export const ITEM_PROPERTIES: ReadonlySet<string> = new Set([
  'reference',
  'value',
  'pad type',
  'pad shape',
  'pad number',
  'pin type',
  'pin name',
  'orientation',
  'position x',
  'position y',
  'width',
  'diameter',
  'hole',
  'size x',
  'size y',
  'hole size x',
  'hole size y',
  'name',
  'priority',
  'locked',
  'fabrication property',
  'clearance override',
  'library link',
  'library description',
  'keywords',
  'not in schematic',
  'exclude from bill of materials',
  'exclude from position files',
  'do not populate',
  'exempt from courtyard requirement',
  'soldermask margin override',
  'solderpaste margin override',
  'solderpaste margin ratio override',
  'corner radius ratio',
  'thermal relief gap',
  'thermal relief spoke width',
  'thermal relief spoke angle',
  'minimum width',
  'keep out tracks',
  'keep out vias',
  'keep out pads',
  'keep out zone fills',
  'keep out copper pours',
  'keep out footprints',
  'start x',
  'start y',
  'end x',
  'end y',
  'line width',
  'text',
  'thickness',
  'bold',
  'italic',
  'knockout',
  'visible'
])

/** The properties the rules read from the item itself, by KiCad's name, lower-cased with spaces. */
const PROPERTIES: Record<string, (item: RuleItem, scope: Scope) => Value> = {
  type: (item) => ({
    kind: 'string',
    value: item.teardrop ? 'Track' : TYPE_NAMES[item.kind],
    wildcard: false
  }),
  // KiCad hides `Layer` on vias and pads: a via has none, a pad reads its footprint's.
  layer: (item) =>
    item.kind === 'via'
      ? UNDEFINED
      : item.kind === 'pad'
        ? item.footprintLayer
          ? { kind: 'layer', layers: [item.footprintLayer] }
          : UNDEFINED
        : { kind: 'layer', layers: item.layers.slice(0, 1) },
  netclass: (item) =>
    item.net === undefined
      ? UNDEFINED
      : {
          kind: 'netclass',
          constituents: (item.netClass ?? '').split(','),
          full: item.netClass ?? ''
        },
  'net class': (item) =>
    item.net === undefined
      ? UNDEFINED
      : { kind: 'string', value: item.netClass ?? '', wildcard: false },
  netname: (item) =>
    item.net === undefined
      ? UNDEFINED
      : { kind: 'netname', net: item.net, name: item.netName ?? '' },
  net: (item) => (item.net === undefined ? UNDEFINED : { kind: 'number', value: item.net }),
  'layer top': (item) =>
    item.viaType === undefined ? UNDEFINED : { kind: 'layer', layers: item.layers.slice(0, 1) },
  'layer bottom': (item) =>
    item.viaType === undefined ? UNDEFINED : { kind: 'layer', layers: item.layers.slice(-1) },
  // A footprint's component classes, joined as KiCad names the composite; its
  // pads and drawings read their footprint's.
  'component class': (item) =>
    item.componentClasses === undefined
      ? UNDEFINED
      : { kind: 'string', value: item.componentClasses.join(','), wildcard: false },
  // `A.ComponentClass`: equal to any one of the classes, as a net class is.
  componentclass: (item) =>
    item.componentClasses === undefined
      ? UNDEFINED
      : {
          kind: 'netclass',
          constituents: [...item.componentClasses],
          full: item.componentClasses.join(',')
        },
  'via type': (item) =>
    item.viaType === undefined
      ? UNDEFINED
      : {
          kind: 'string',
          value: item.viaType[0].toUpperCase() + item.viaType.slice(1),
          wildcard: false
        }
}

// ---- Compile --------------------------------------------------------------------

/**
 * Compile a condition. The predicate is asked for (A, B) as given; the
 * resolver tries the swapped pair itself.
 */
export function compileCondition(source: string, env: RuleEnvironment): CompiledCondition {
  if (/[\t\n\r]/.test(source)) throw new ExpressionError('Unrecognized character in condition')
  const parser = new Parser(lex(source))
  const root = parser.program()
  return {
    test: (context) => truthy(root({ ...context, env })),
    unsupported: [...parser.unsupported]
  }
}

/** A numeric value expression (`0.2mm`, `0.1mm + 2mil`), in millimeters. */
export function evaluateNumber(source: string): number {
  const tokens = lex(source)
  const numbers = tokens.filter((token) => token.type === 'number')
  if (numbers.length === 1 && numbers[0].type === 'number' && !numbers[0].unit)
    throw new ExpressionError(`Missing units for '${source}': must be mm, in, mil, deg, fs, or ps`)
  const parser = new Parser(tokens)
  const root = parser.program()
  const noItem = {} as RuleItem
  const value = root({
    a: noItem,
    b: null,
    layer: null,
    type: 'clearance',
    env: { layersMatching: () => new Set(), netNames: new Set() }
  })
  return numberOf(value)
}
