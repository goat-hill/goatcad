// Parts follow KiCad's source, named below: Copyright The KiCad Developers, GPL-3.0-or-later.
/**
 * Generic S-Expression tokenizer and parser for KiCad file formats.
 *
 * Produces a tree of SExprNode objects from parenthesized text like:
 *   (footprint "LED_0805" (version 20240101) (pad "1" smd rect ...))
 *
 * Key design principles:
 *  - Handles any valid S-expression, not just known KiCad tokens
 *  - Preserves source positions (byte offsets) for editor annotations
 *  - Round-trip: serialize(parse(text)) produces semantically equivalent output
 *  - Tolerant: unknown tokens are kept in the tree, never discarded
 *
 * Nodes store positions as plain [start, end) offsets into the source string,
 * not {line, col} objects: real boards reach tens of millions of nodes, and a
 * position object per node end costs gigabytes. Use positionAt() to derive
 * line/col for an error message or annotation when one is actually shown.
 * Atom values are extracted with substring slices for the same reason —
 * never accumulated character by character.
 */

import { formatNmAtom, mmAtomToNm, NM_INT32_MAX, type Nm } from './coordinates'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Human-readable source location, derived on demand via positionAt() */
export interface SourcePosition {
  line: number
  col: number
  offset: number
}

/**
 * A node in the S-Expression tree.
 *
 * Leaf nodes have `type: 'atom'` and a string `value`.
 * Branch nodes have `type: 'list'` and an array of `children`.
 *
 * The first child of a list node is typically the "token" or "keyword",
 * e.g. in `(pad "1" smd rect)`, the token is `pad`.
 *
 * `start`/`end` are character offsets into the source text ([start, end)).
 * Nodes built in memory (never parsed) carry the offset they were anchored
 * to; offsets are only meaningful for annotation, never for serialization.
 */
export type SExprNode = SExprAtom | SExprList

export interface SExprAtom {
  type: 'atom'
  value: string
  /** Whether the atom was quoted in the source (e.g., `"LED_0805"`) */
  quoted: boolean
  start: number
  end: number
}

export interface SExprList {
  type: 'list'
  children: SExprNode[]
  start: number
  end: number
}

/** Derive line/col (1-based) for a source offset, e.g. for error messages. */
export function positionAt(source: string, offset: number): SourcePosition {
  const max = Math.min(Math.max(offset, 0), source.length)
  let line = 1
  let lineStart = 0
  for (let i = 0; i < max; i++) {
    if (source.charCodeAt(i) === CH_LF) {
      line++
      lineStart = i + 1
    }
  }
  return { line, col: max - lineStart + 1, offset: max }
}

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

export class SExprParseError extends Error {
  constructor(
    message: string,
    public readonly position: SourcePosition
  ) {
    super(`${message} at line ${position.line}, col ${position.col}`)
    this.name = 'SExprParseError'
  }
}

const CH_TAB = 9
const CH_LF = 10
const CH_CR = 13
const CH_SPACE = 32
const CH_QUOTE = 34 // "
const CH_HASH = 35 // #
const CH_OPEN = 40 // (
const CH_CLOSE = 41 // )
const CH_SEMI = 59 // ;
const CH_BACKSLASH = 92 // \

/**
 * Decode a quoted-string body containing at least one backslash escape.
 * `\n`, `\t`, `\\`, `\"` are decoded; unknown escapes are kept verbatim.
 * Returns the decoded value and the offset of the terminating quote (or
 * source end when unterminated).
 */
/**
 * A parsed atom of 13 characters or more is, to V8, a view into the whole
 * source (a sliced string), so every uuid keeps the document's text alive. A
 * thread that holds the tree but has no other use for the text — the board
 * worker — detaches them: each such atom becomes a string of its own.
 */
let detachAtoms = false

/** Make atoms independent of the text they were parsed from, on this thread. */
export function setDetachedAtoms(detached: boolean): void {
  detachAtoms = detached
}

/** The classic flatten: a rope of the atom, sliced back, holds only itself. */
const own = (value: string): string =>
  detachAtoms && value.length >= 13 ? (' ' + value).slice(1) : value

function decodeQuotedBody(source: string, from: number): { value: string; quoteAt: number } {
  const n = source.length
  let value = ''
  let segStart = from
  let p = from
  while (p < n) {
    const c = source.charCodeAt(p)
    if (c === CH_BACKSLASH) {
      value += source.slice(segStart, p)
      p++
      if (p < n) {
        const escaped = source[p]
        switch (escaped) {
          case 'n':
            value += '\n'
            break
          case 't':
            value += '\t'
            break
          case '\\':
            value += '\\'
            break
          case '"':
            value += '"'
            break
          default:
            // Preserve unknown escapes verbatim
            value += '\\' + escaped
        }
        p++
      }
      segStart = p
      continue
    }
    if (c === CH_QUOTE) break
    p++
  }
  value += source.slice(segStart, p)
  return { value: own(value), quoteAt: p }
}

/**
 * Parse an S-expression string into a tree of SExprNode.
 *
 * A KiCad file is typically a single top-level list, e.g.:
 *   (footprint "name" (...) (...))
 *
 * This parser returns the root node. If the input contains a single
 * top-level list, that list node is returned directly. If there are
 * multiple top-level elements, they're wrapped in a synthetic list.
 */
export function parseSExpr(source: string): SExprNode {
  const state = new ParseState(source)
  parseStep(state, Infinity)
  return finishParse(state)
}

/** Thrown by parseSExprAsync when the caller's shouldAbort() returns true. */
export class ParseAbortedError extends Error {
  constructor() {
    super('Parse aborted')
    this.name = 'ParseAbortedError'
  }
}

export interface ParseAsyncOptions {
  /** Called between chunks with completion in [0, 1] */
  onProgress?: (fraction: number) => void
  /** Checked between chunks; true aborts with ParseAbortedError */
  shouldAbort?: () => boolean
  /** Source characters parsed per chunk between yields (default ~2 MB ≈ 25 ms) */
  chunkChars?: number
}

/**
 * Chunked parse for large documents: identical output to parseSExpr, but
 * yields to the event loop between chunks so the UI keeps painting and can
 * show real progress. An 85 MB board parses in ~40 slices of ~25 ms.
 */
export async function parseSExprAsync(
  source: string,
  options: ParseAsyncOptions = {}
): Promise<SExprNode> {
  const chunk = options.chunkChars ?? 2_000_000
  const state = new ParseState(source)
  while (!parseStep(state, state.pos + chunk)) {
    options.onProgress?.(state.pos / source.length)
    await new Promise((resolve) => setTimeout(resolve, 0))
    if (options.shouldAbort?.()) throw new ParseAbortedError()
  }
  options.onProgress?.(1)
  return finishParse(state)
}

class ParseState {
  readonly source: string
  pos = 0
  readonly topNodes: SExprNode[] = []
  readonly stack: SExprList[] = []
  /** Set when a stray top-level ')' terminates the parse early */
  stopped = false

  constructor(source: string) {
    this.source = source
  }
}

function finishParse(state: ParseState): SExprNode {
  const { topNodes, stack, pos } = state

  // Unterminated lists close at end of input
  for (const open of stack) open.end = pos

  if (topNodes.length === 0) {
    throw new SExprParseError('Empty input', { line: 1, col: 1, offset: 0 })
  }

  if (topNodes.length === 1) {
    return topNodes[0]
  }

  // Multiple top-level nodes: wrap in a synthetic list
  return {
    type: 'list',
    children: topNodes,
    start: topNodes[0].start,
    end: topNodes[topNodes.length - 1].end
  }
}

/**
 * Parse until `deadlinePos` (source offset) or end of input. Returns true
 * when the document is fully consumed. Resumable: all state lives in `state`.
 */
function parseStep(state: ParseState, deadlinePos: number): boolean {
  const source = state.source
  const n = source.length
  const { topNodes, stack } = state
  let pos = state.pos

  const attach = (node: SExprNode): void => {
    if (stack.length > 0) stack[stack.length - 1].children.push(node)
    else topNodes.push(node)
  }

  outer: while (pos < n && pos < deadlinePos) {
    const c = source.charCodeAt(pos)

    // Whitespace
    if (c === CH_SPACE || c === CH_TAB || c === CH_LF || c === CH_CR) {
      pos++
      continue
    }

    // Line comments starting with '#' or ';' (only at token boundaries;
    // these characters inside an atom belong to the atom)
    if (c === CH_HASH || c === CH_SEMI) {
      const nl = source.indexOf('\n', pos)
      pos = nl === -1 ? n : nl
      continue
    }

    if (c === CH_OPEN) {
      // Stereotyped heavy subtrees ((pts ...), canonical (fp_line ...)) are
      // scanned textually into packed nodes — no per-token objects. Any
      // mismatch falls through to the generic list handling.
      const packed = tryScanPackedNode(source, pos)
      if (packed) {
        attach(packed[0])
        pos = packed[1]
        continue
      }
      const list: SExprList = { type: 'list', children: [], start: pos, end: pos }
      attach(list)
      stack.push(list)
      pos++
      continue
    }

    if (c === CH_CLOSE) {
      pos++
      const list = stack.pop()
      if (list) {
        list.end = pos
      } else {
        // Stray top-level ')' — stop, ignoring the rest (tolerant parse)
        pos--
        state.stopped = true
        break outer
      }
      continue
    }

    if (c === CH_QUOTE) {
      const start = pos
      pos++
      // Fast path: scan for the closing quote; fall back to the decoding
      // walk only when the string actually contains a backslash.
      let scan = pos
      let cc = 0
      while (scan < n && (cc = source.charCodeAt(scan)) !== CH_QUOTE && cc !== CH_BACKSLASH) {
        scan++
      }
      let value: string
      if (scan < n && cc === CH_QUOTE) {
        value = own(source.slice(pos, scan))
        pos = scan + 1
      } else if (scan >= n) {
        // Unterminated string — take what we have
        value = own(source.slice(pos, n))
        pos = n
      } else {
        const decoded = decodeQuotedBody(source, pos)
        value = decoded.value
        pos = decoded.quoteAt < n ? decoded.quoteAt + 1 : n
      }
      attach({ type: 'atom', value, quoted: true, start, end: pos })
      continue
    }

    // Bare atom
    const start = pos
    pos++
    while (pos < n) {
      const a = source.charCodeAt(pos)
      if (
        a === CH_OPEN ||
        a === CH_CLOSE ||
        a === CH_QUOTE ||
        a === CH_SPACE ||
        a === CH_TAB ||
        a === CH_LF ||
        a === CH_CR
      ) {
        break
      }
      pos++
    }
    attach({ type: 'atom', value: own(source.slice(start, pos)), quoted: false, start, end: pos })
  }

  state.pos = pos
  return state.stopped || pos >= n
}

// ---------------------------------------------------------------------------
// Packed nodes — compact storage for stereotyped heavy subtrees
// ---------------------------------------------------------------------------
//
// Dense boards are dominated by two grammar shapes: footprint outline strokes
//   (fp_line (start N N) (end N N) (stroke (width N) (type W)) (layer "S") (uuid "S"))
// and coordinate runs
//   (pts (xy N N) (xy N N) ...)
// On an 85 MB board these two account for ~88% of all AST nodes (326k
// fp_lines alone are 7.8M nodes). The parser recognizes them textually and
// stores a compact record instead of a generic subtree — a Float64Array and a
// few strings instead of dozens of node objects.
//
// Compatibility contract: packed nodes implement SExprList. Reading
// `children` materializes the equivalent generic subtree in place (cached),
// after which the node behaves — and serializes — exactly like a parsed
// generic node, so every existing consumer and mutator works unchanged.
// `getToken` and the serializer/estimator have fast paths that avoid
// materialization on the hot read-only paths.
//
// Packing only engages when every numeric atom round-trips exactly
// (String(parseFloat(s)) === s) and strings need no escaping, so packed
// serialization is byte-identical to generic serialization; any surprise in
// the source falls back to the generic parser.

function buildAtom(value: string, quoted: boolean, at: number): SExprAtom {
  return { type: 'atom', value, quoted, start: at, end: at }
}

function buildXYList(x: Nm, y: Nm, at: number): SExprList {
  return {
    type: 'list',
    children: [
      buildAtom('xy', false, at),
      buildAtom(formatNmAtom(x), false, at),
      buildAtom(formatNmAtom(y), false, at)
    ],
    start: at,
    end: at
  }
}

export class PackedPtsNode implements SExprList {
  readonly type = 'list' as const
  /** Fast token for getToken — avoids materializing via `children` */
  readonly packedToken = 'pts'
  start: number
  end: number
  /**
   * Interleaved x,y as integer NANOMETERS while packed; null once
   * materialized. Int32Array holds KiCad's full ±2147 mm coordinate range
   * exactly, at half the memory of the doubles it replaced.
   */
  private coords: Int32Array | null
  private mat: SExprNode[] | null = null

  constructor(coords: Int32Array, start: number, end: number) {
    this.coords = coords
    this.start = start
    this.end = end
  }

  get children(): SExprNode[] {
    if (!this.mat) {
      const coords = this.coords!
      const out: SExprNode[] = [buildAtom('pts', false, this.start)]
      for (let i = 0; i < coords.length; i += 2) {
        out.push(buildXYList(coords[i] as Nm, coords[i + 1] as Nm, this.start))
      }
      this.mat = out
      this.coords = null
    }
    return this.mat
  }

  set children(value: SExprNode[]) {
    this.mat = value
    this.coords = null
  }

  /** Packed nm coords while un-materialized; null after (read children instead). */
  packedCoords(): Int32Array | null {
    return this.mat ? null : this.coords
  }

  /**
   * Serialize without materializing; null when materialized or when the list
   * is small enough that the generic inline heuristics could apply (the
   * caller then falls through to the generic serializer over `children`).
   */
  serializePacked(indent: number): string | null {
    const coords = this.packedCoords()
    if (!coords || coords.length <= 4) return null
    // ≥3 xy children: children.length > 3, so the generic serializer always
    // takes the multi-line branch with 'pts' alone on the first line
    // Mirrors the generic serializer's `pts` fill exactly — the two are held
    // together by the packed-vs-materialized invariant test.
    const pad = INDENT.repeat(indent + 1)
    const lines: string[] = ['(pts']
    let line = pad
    for (let i = 0; i < coords.length; i += 2) {
      const xy =
        '(xy ' + formatNmAtom(coords[i] as Nm) + ' ' + formatNmAtom(coords[i + 1] as Nm) + ')'
      if (line !== pad && line.length >= PTS_COLUMN_LIMIT) {
        lines.push(line)
        line = pad
      }
      line += line === pad ? xy : ' ' + xy
    }
    if (line !== pad) lines.push(line)
    lines.push(INDENT.repeat(indent) + ')')
    return lines.join('\n')
  }
}

/** Coordinates and width are integer nanometers (`Nm`). */
export interface PackedFpLineRecord {
  x1: Nm
  y1: Nm
  x2: Nm
  y2: Nm
  width: Nm
  strokeType: string
  layer: string
  uuid: string
}

export class PackedFpLineNode implements SExprList {
  readonly type = 'list' as const
  readonly packedToken = 'fp_line'
  start: number
  end: number
  private rec: PackedFpLineRecord | null
  private mat: SExprNode[] | null = null

  constructor(rec: PackedFpLineRecord, start: number, end: number) {
    this.rec = rec
    this.start = start
    this.end = end
  }

  get children(): SExprNode[] {
    if (!this.mat) {
      const r = this.rec!
      const at = this.start
      const list = (token: string, ...rest: SExprNode[]): SExprList => ({
        type: 'list',
        children: [buildAtom(token, false, at), ...rest],
        start: at,
        end: at
      })
      this.mat = [
        buildAtom('fp_line', false, at),
        list(
          'start',
          buildAtom(formatNmAtom(r.x1), false, at),
          buildAtom(formatNmAtom(r.y1), false, at)
        ),
        list(
          'end',
          buildAtom(formatNmAtom(r.x2), false, at),
          buildAtom(formatNmAtom(r.y2), false, at)
        ),
        list(
          'stroke',
          list('width', buildAtom(formatNmAtom(r.width), false, at)),
          list('type', buildAtom(r.strokeType, false, at))
        ),
        list('layer', buildAtom(r.layer, true, at)),
        list('uuid', buildAtom(r.uuid, true, at))
      ]
      this.rec = null
    }
    return this.mat
  }

  set children(value: SExprNode[]) {
    this.mat = value
    this.rec = null
  }

  /** The packed record while un-materialized; null after. */
  packedRecord(): PackedFpLineRecord | null {
    return this.mat ? null : this.rec
  }

  serializePacked(indent: number): string | null {
    const r = this.packedRecord()
    if (!r) return null
    // Generic shape: every child is a list, so always multi-line with
    // 'fp_line' alone on the first line. (start ..)/(end ..)/(layer ..)/
    // (uuid ..) are all-atom inline lists; (stroke ..) holds sub-lists and so
    // breaks, which is the rule change this had to follow.
    const ci = '\n' + INDENT.repeat(indent + 1)
    const cci = '\n' + INDENT.repeat(indent + 2)
    const close = '\n' + INDENT.repeat(indent) + ')'
    return (
      '(fp_line' +
      ci +
      '(start ' +
      formatNmAtom(r.x1) +
      ' ' +
      formatNmAtom(r.y1) +
      ')' +
      ci +
      '(end ' +
      formatNmAtom(r.x2) +
      ' ' +
      formatNmAtom(r.y2) +
      ')' +
      ci +
      '(stroke' +
      cci +
      '(width ' +
      formatNmAtom(r.width) +
      ')' +
      cci +
      '(type ' +
      r.strokeType +
      ')' +
      ci +
      ')' +
      ci +
      '(layer "' +
      r.layer +
      '")' +
      ci +
      '(uuid "' +
      r.uuid +
      '")' +
      close
    )
  }
}

/** Coordinates and width are integer nanometers (`Nm`); `net` is an id, not a length. */
export interface PackedSegmentRecord {
  x1: Nm
  y1: Nm
  x2: Nm
  y2: Nm
  width: Nm
  layer: string
  net: number
  uuid: string
}

export class PackedSegmentNode implements SExprList {
  readonly type = 'list' as const
  readonly packedToken = 'segment'
  start: number
  end: number
  private rec: PackedSegmentRecord | null
  private mat: SExprNode[] | null = null

  constructor(rec: PackedSegmentRecord, start: number, end: number) {
    this.rec = rec
    this.start = start
    this.end = end
  }

  get children(): SExprNode[] {
    if (!this.mat) {
      const r = this.rec!
      const at = this.start
      const list = (token: string, ...rest: SExprNode[]): SExprList => ({
        type: 'list',
        children: [buildAtom(token, false, at), ...rest],
        start: at,
        end: at
      })
      this.mat = [
        buildAtom('segment', false, at),
        list(
          'start',
          buildAtom(formatNmAtom(r.x1), false, at),
          buildAtom(formatNmAtom(r.y1), false, at)
        ),
        list(
          'end',
          buildAtom(formatNmAtom(r.x2), false, at),
          buildAtom(formatNmAtom(r.y2), false, at)
        ),
        list('width', buildAtom(formatNmAtom(r.width), false, at)),
        list('layer', buildAtom(r.layer, true, at)),
        list('net', buildAtom(String(r.net), false, at)),
        list('uuid', buildAtom(r.uuid, true, at))
      ]
      this.rec = null
    }
    return this.mat
  }

  set children(value: SExprNode[]) {
    this.mat = value
    this.rec = null
  }

  /** The packed record while un-materialized; null after. */
  packedRecord(): PackedSegmentRecord | null {
    return this.mat ? null : this.rec
  }

  serializePacked(indent: number): string | null {
    const r = this.packedRecord()
    if (!r) return null
    // Generic shape: every child is an all-atom inline list, so always
    // multi-line with 'segment' alone on the first line
    const ci = '\n' + INDENT.repeat(indent + 1)
    const close = '\n' + INDENT.repeat(indent) + ')'
    return (
      '(segment' +
      ci +
      '(start ' +
      formatNmAtom(r.x1) +
      ' ' +
      formatNmAtom(r.y1) +
      ')' +
      ci +
      '(end ' +
      formatNmAtom(r.x2) +
      ' ' +
      formatNmAtom(r.y2) +
      ')' +
      ci +
      '(width ' +
      formatNmAtom(r.width) +
      ')' +
      ci +
      '(layer "' +
      r.layer +
      '")' +
      ci +
      '(net ' +
      String(r.net) +
      ')' +
      ci +
      '(uuid "' +
      r.uuid +
      '")' +
      close
    )
  }
}

// --- textual scanners for the packed shapes --------------------------------

function isWs(c: number): boolean {
  return c === CH_SPACE || c === CH_TAB || c === CH_LF || c === CH_CR
}

function skipWs(source: string, i: number): number {
  while (i < source.length && isWs(source.charCodeAt(i))) i++
  return i
}

function isAtomEnd(c: number): boolean {
  return (
    c === CH_OPEN ||
    c === CH_CLOSE ||
    c === CH_QUOTE ||
    c === CH_SPACE ||
    c === CH_TAB ||
    c === CH_LF ||
    c === CH_CR
  )
}

/** Read a bare atom at i; returns [value, next] or null at a delimiter. */
function scanBareAtom(source: string, i: number): [string, number] | null {
  const n = source.length
  let p = i
  while (p < n && !isAtomEnd(source.charCodeAt(p))) p++
  if (p === i) return null
  return [own(source.slice(i, p)), p]
}

/**
 * Read a numeric atom whose text round-trips exactly through
 * parseFloat/String — the property that makes packed serialization
 * byte-identical. Returns [value, next] or null.
 */
function scanExactNumber(source: string, i: number): [number, number] | null {
  const atom = scanBareAtom(source, i)
  if (!atom) return null
  const num = parseFloat(atom[0])
  if (Number.isNaN(num) || String(num) !== atom[0]) return null
  return [num, atom[1]]
}

/**
 * Read a millimeter atom as integer nanometers, packing only when it sits
 * exactly on the 1 nm grid inside KiCad's int32 range AND its canonical form
 * (`formatNmAtom`) reproduces the source text — the invariant that keeps
 * packed serialization byte-identical. Anything else returns null and the
 * generic parser preserves the original text untouched.
 */
function scanExactNmNumber(source: string, i: number): [Nm, number] | null {
  const atom = scanBareAtom(source, i)
  if (!atom) return null
  const nm = mmAtomToNm(atom[0])
  if (Number.isNaN(nm) || Math.abs(nm) > NM_INT32_MAX) return null
  if (formatNmAtom(nm) !== atom[0]) return null
  return [nm, atom[1]]
}

/** Read a quoted string with no escapes/quotes in the body. */
function scanPlainQuoted(source: string, i: number): [string, number] | null {
  if (source.charCodeAt(i) !== CH_QUOTE) return null
  const n = source.length
  let p = i + 1
  while (p < n) {
    const c = source.charCodeAt(p)
    if (c === CH_QUOTE) return [own(source.slice(i + 1, p)), p + 1]
    if (c === CH_BACKSLASH) return null
    p++
  }
  return null
}

/** Expect `(token ` at i (i on the '('); returns index after the token. */
function scanListOpen(source: string, i: number, token: string): number | null {
  if (source.charCodeAt(i) !== CH_OPEN) return null
  if (!source.startsWith(token, i + 1)) return null
  const after = i + 1 + token.length
  if (!isWs(source.charCodeAt(after))) return null
  return skipWs(source, after)
}

/** Expect ')' possibly preceded by whitespace; returns index after it. */
function scanListClose(source: string, i: number): number | null {
  const p = skipWs(source, i)
  if (source.charCodeAt(p) !== CH_CLOSE) return null
  return p + 1
}

/**
 * Try to scan `(pts (xy N N) ...)` starting at `openPos` (on the '(').
 * Returns the packed node and the index after the closing paren, or null to
 * fall back to the generic parser.
 */
function tryScanPackedPts(source: string, openPos: number): [PackedPtsNode, number] | null {
  let p = scanListOpen(source, openPos, 'pts')
  if (p === null) return null

  const coords: number[] = []
  for (;;) {
    const c = source.charCodeAt(p)
    if (c === CH_CLOSE) {
      if (coords.length === 0) return null // '(pts)' — let the generic path own it
      return [new PackedPtsNode(Int32Array.from(coords), openPos, p + 1), p + 1]
    }
    let q = scanListOpen(source, p, 'xy')
    if (q === null) return null
    const x = scanExactNmNumber(source, q)
    if (!x) return null
    q = skipWs(source, x[1])
    const y = scanExactNmNumber(source, q)
    if (!y) return null
    const close = scanListClose(source, y[1])
    if (close === null) return null
    coords.push(x[0], y[0])
    p = skipWs(source, close)
  }
}

const PACKED_STROKE_TYPES = new Set(['solid', 'default', 'dash', 'dot', 'dash_dot', 'dash_dot_dot'])

/**
 * Try to scan the canonical KiCad 7+ fp_line shape starting at `openPos`.
 * Any deviation (extra atoms like `locked`, missing uuid, legacy width form,
 * unusual strings) returns null and the generic parser takes over.
 */
function tryScanPackedFpLine(source: string, openPos: number): [PackedFpLineNode, number] | null {
  let p = scanListOpen(source, openPos, 'fp_line')
  if (p === null) return null

  const xyPair = (token: string, at: number): [Nm, Nm, number] | null => {
    let q = scanListOpen(source, at, token)
    if (q === null) return null
    const a = scanExactNmNumber(source, q)
    if (!a) return null
    q = skipWs(source, a[1])
    const b = scanExactNmNumber(source, q)
    if (!b) return null
    const close = scanListClose(source, b[1])
    if (close === null) return null
    return [a[0], b[0], close]
  }

  const start = xyPair('start', p)
  if (!start) return null
  p = skipWs(source, start[2])
  const end = xyPair('end', p)
  if (!end) return null

  // (stroke (width N) (type W))
  p = scanListOpen(source, skipWs(source, end[2]), 'stroke')
  if (p === null) return null
  let q = scanListOpen(source, p, 'width')
  if (q === null) return null
  const width = scanExactNmNumber(source, q)
  // Length cap keeps the generic (stroke ...) inline estimate under 60, so
  // the hardcoded one-line stroke in serializePacked stays byte-identical
  if (!width || formatNmAtom(width[0]).length > 12) return null
  let close = scanListClose(source, width[1])
  if (close === null) return null
  q = scanListOpen(source, skipWs(source, close), 'type')
  if (q === null) return null
  const strokeType = scanBareAtom(source, q)
  if (!strokeType || !PACKED_STROKE_TYPES.has(strokeType[0])) return null
  close = scanListClose(source, strokeType[1])
  if (close === null) return null
  close = scanListClose(source, close) // stroke's own ')'
  if (close === null) return null

  // (layer "...")
  q = scanListOpen(source, skipWs(source, close), 'layer')
  if (q === null) return null
  const layer = scanPlainQuoted(source, q)
  if (!layer || layer[0].length > 40) return null
  close = scanListClose(source, layer[1])
  if (close === null) return null

  // (uuid "...")
  q = scanListOpen(source, skipWs(source, close), 'uuid')
  if (q === null) return null
  const uuid = scanPlainQuoted(source, q)
  if (!uuid || uuid[0].length > 60) return null
  close = scanListClose(source, uuid[1])
  if (close === null) return null

  // fp_line's own ')'
  close = scanListClose(source, close)
  if (close === null) return null

  return [
    new PackedFpLineNode(
      {
        x1: start[0],
        y1: start[1],
        x2: end[0],
        y2: end[1],
        width: width[0],
        strokeType: strokeType[0],
        layer: layer[0],
        uuid: uuid[0]
      },
      openPos,
      close
    ),
    close
  ]
}

/**
 * Try to scan the canonical KiCad 7+ track segment shape:
 * (segment (start N N) (end N N) (width N) (layer "S") (net INT) (uuid "S"))
 */
function tryScanPackedSegment(source: string, openPos: number): [PackedSegmentNode, number] | null {
  const p = scanListOpen(source, openPos, 'segment')
  if (p === null) return null

  const pair = (token: string, at: number): [Nm, Nm, number] | null => {
    let q = scanListOpen(source, at, token)
    if (q === null) return null
    const a = scanExactNmNumber(source, q)
    if (!a) return null
    q = skipWs(source, a[1])
    const b = scanExactNmNumber(source, q)
    if (!b) return null
    const close = scanListClose(source, b[1])
    if (close === null) return null
    return [a[0], b[0], close]
  }
  const singleNm = (token: string, at: number): [Nm, number] | null => {
    const q = scanListOpen(source, at, token)
    if (q === null) return null
    const v = scanExactNmNumber(source, q)
    if (!v) return null
    const close = scanListClose(source, v[1])
    if (close === null) return null
    return [v[0], close]
  }
  // net ids are plain integers, not distances — the String() round-trip guard.
  const single = (token: string, at: number): [number, number] | null => {
    const q = scanListOpen(source, at, token)
    if (q === null) return null
    const v = scanExactNumber(source, q)
    if (!v) return null
    const close = scanListClose(source, v[1])
    if (close === null) return null
    return [v[0], close]
  }

  const start = pair('start', p)
  if (!start) return null
  const end = pair('end', skipWs(source, start[2]))
  if (!end) return null
  const width = singleNm('width', skipWs(source, end[2]))
  if (!width) return null

  let q = scanListOpen(source, skipWs(source, width[1]), 'layer')
  if (q === null) return null
  const layer = scanPlainQuoted(source, q)
  if (!layer || layer[0].length > 40) return null
  let close = scanListClose(source, layer[1])
  if (close === null) return null

  const net = single('net', skipWs(source, close))
  if (!net || !Number.isInteger(net[0])) return null

  q = scanListOpen(source, skipWs(source, net[1]), 'uuid')
  if (q === null) return null
  const uuid = scanPlainQuoted(source, q)
  if (!uuid || uuid[0].length > 60) return null
  close = scanListClose(source, uuid[1])
  if (close === null) return null

  close = scanListClose(source, close) // segment's own ')'
  if (close === null) return null

  return [
    new PackedSegmentNode(
      {
        x1: start[0],
        y1: start[1],
        x2: end[0],
        y2: end[1],
        width: width[0],
        layer: layer[0],
        net: net[0],
        uuid: uuid[0]
      },
      openPos,
      close
    ),
    close
  ]
}

/**
 * Packed fast path for the generic parser: called with the position of a '('.
 * Returns [node, nextPos] when the subtree matched a packed shape.
 */
function tryScanPackedNode(source: string, openPos: number): [SExprList, number] | null {
  const c1 = source.charCodeAt(openPos + 1)
  const c2 = source.charCodeAt(openPos + 2)
  if (c1 === 112 /* p */ && c2 === 116 /* t */) {
    return tryScanPackedPts(source, openPos)
  }
  if (c1 === 102 /* f */ && c2 === 112 /* p */) {
    return tryScanPackedFpLine(source, openPos)
  }
  if (c1 === 115 /* s */ && c2 === 101 /* e */) {
    return tryScanPackedSegment(source, openPos)
  }
  return null
}

// ---------------------------------------------------------------------------
// Serializer
// ---------------------------------------------------------------------------

/**
 * KiCad's own formatting, matched exactly so a round trip is byte-identical.
 *
 * Three rules, all measured against files KiCad 9/10 wrote rather than guessed:
 * a TAB per level; any list holding a sub-list breaks, one child per line; and a
 * closing paren sits on its own line at the opening line's indent. `(pts …)` is
 * the one exception — see `PTS_COLUMN_LIMIT`.
 *
 * This is not cosmetic. Until it matched, opening a KiCad file and saving it
 * rewrote every line, which broke the "a save that only moved one symbol must
 * diff to only that change" invariant (RULES.md §7) for every file we did not
 * write ourselves, and made the first `git diff` after any edit useless.
 */
const INDENT = '\t'

/**
 * `(pts …)` packs `(xy …)` onto one line — KiCad's `xySpecialCaseColumnLimit`
 * (`common/io/kicad/kicad_io_utils.cpp`, `Prettify`).
 *
 * The test is on the column BEFORE the item is appended, not after, so a line
 * routinely overshoots by most of one point — which is why no "wrap at N"
 * model fits the real files: measured output holds lines of 119 characters
 * while breaking others at 102. A tab counts as one column, as it does there
 * (`column = listDepth * indentSize + 1`, `indentSize` 1).
 */
const PTS_COLUMN_LIMIT = 99

/**
 * A run of consecutive ATOMS inside a list wraps past this column, continuing
 * one level deeper — KiCad's `consecutiveTokenWrapThreshold`, same file. It is
 * what breaks a long `(members "…" "…" …)` in a bus alias, or an image's token
 * blob, without breaking short all-atom lists at all.
 */
const TOKEN_WRAP_COLUMN = 72

/**
 * Serialize an SExprNode tree back to string form.
 *
 * Produces clean, indented output that is semantically equivalent
 * to the original source (though whitespace may differ).
 *
 * Implementation note: this builds the result with plain string
 * concatenation and per-level joins on purpose. V8 represents concatenated
 * strings as ropes, so this is measurably faster than streaming fragments
 * into an accumulator array (~1s vs ~1.9s on an 85 MB board).
 */
export function serializeSExpr(node: SExprNode, indent: number = 0, compact = false): string {
  if (node.type === 'atom') {
    return serializeAtom(node)
  }

  // Packed nodes serialize from their record (byte-identical by contract);
  // null means materialized or small — fall through to the generic path.
  if (
    node instanceof PackedPtsNode ||
    node instanceof PackedFpLineNode ||
    node instanceof PackedSegmentNode
  ) {
    const packed = node.serializePacked(indent)
    if (packed !== null) return packed
  }

  const children = node.children
  if (children.length === 0) {
    return '()'
  }

  const indentStr = INDENT.repeat(indent)
  const childIndent = INDENT.repeat(indent + 1)

  // A port of KiCad's `Prettify`, not an approximation of its output. The rule
  // set is small and none of it is per-token:
  //   • only a '(' starts a new line — an ATOM always continues the current one,
  //     which is why `(loss_tangent 0.02) addsublayer` keeps its trailing atom;
  //   • a run of atoms wraps past TOKEN_WRAP_COLUMN, one level deeper;
  //   • consecutive `(xy …)` stay on one line while the column is under
  //     PTS_COLUMN_LIMIT — tested BEFORE appending, so a line overshoots;
  //   • the closing paren gets its own line if the last child was a list, or if
  //     the atom run wrapped.
  let out = '('
  let column = indent + 1
  let previousWasList = false
  let wrapped = false

  for (let i = 0; i < children.length; i++) {
    const child = children[i]
    const isList = child.type === 'list'
    if (i > 0) {
      const packsWithPrevious =
        isList && previousWasList && isXyList(child) && column < PTS_COLUMN_LIMIT
      if (isList && !packsWithPrevious) {
        out += '\n' + childIndent
        column = indent + 1
      } else if (column < TOKEN_WRAP_COLUMN || packsWithPrevious) {
        out += ' '
        column += 1
      } else {
        out += '\n' + childIndent
        column = indent + 1
        wrapped = true
      }
    }
    const text =
      compact && isList && COMPACT_TOKENS.has(getToken(child) ?? '')
        ? serializeOneLine(child)
        : serializeSExpr(child, indent + 1, compact)
    out += text
    const lastBreak = text.lastIndexOf('\n')
    column = lastBreak < 0 ? column + text.length : text.length - lastBreak - 1
    previousWasList = isList
  }

  return previousWasList || wrapped ? out + '\n' + indentStr + ')' : out + ')'
}

/**
 * The lists `Prettify`'s COMPACT_TEXT_PROPERTIES mode keeps on one line — what
 * eeschema's clipboard text is formatted with (`kicad_io_utils.cpp`, `isShortForm`).
 * `serializeSExpr(node, 0, true)` writes that mode; files never use it.
 */
const COMPACT_TOKENS: ReadonlySet<string> = new Set([
  'font',
  'stroke',
  'fill',
  'teardrop',
  'offset',
  'rotate',
  'scale'
])

function serializeOneLine(node: SExprNode): string {
  if (node.type === 'atom') return serializeAtom(node)
  return `(${node.children.map(serializeOneLine).join(' ')})`
}

/** A `(xy …)` point — the one list KiCad packs several of onto a line. */
// getToken, not children: reading a packed sibling's children would materialize it.
const isXyList = (node: SExprNode): boolean => getToken(node) === 'xy'

// ---------------------------------------------------------------------------
// Incremental serialization
// ---------------------------------------------------------------------------

/**
 * Nodes whose serialized form may have changed since they were last cached.
 * Every AST-mutating helper must call markNodeDirty on the affected element's
 * top-level node (the direct child of the document root that contains the
 * mutation) — serializeSExprCached trusts this to reuse cached text, and the
 * structural-undo capture journal trusts it to snapshot pre-mutation state.
 * The mark MUST therefore happen before any field of the node is written.
 */
const dirtyNodes = new WeakSet<SExprNode>()

/**
 * While armed (between beginNodeCapture/endNodeCapture), the first
 * markNodeDirty for each node deep-clones it — a snapshot of its state just
 * before the command mutates it. Structural undo restores these clones.
 */
let captureJournal: Map<SExprNode, SExprNode> | null = null

export function beginNodeCapture(): void {
  captureJournal = new Map()
}

/** Returns node → pre-mutation deep clone for every node marked dirty. */
export function endNodeCapture(): Map<SExprNode, SExprNode> {
  const journal = captureJournal ?? new Map<SExprNode, SExprNode>()
  captureJournal = null
  return journal
}

/**
 * Run `edit` on nodes that are not the document's — a detached copy a command
 * edits and then writes back whole — with the capture paused, so its marks are
 * not taken for the command's own. A captured node must be one of the
 * document's: the scene patches only those, and rebuilds whole for any other.
 */
export function outsideNodeCapture<T>(edit: () => T): T {
  const journal = captureJournal
  captureJournal = null
  try {
    return edit()
  } finally {
    captureJournal = journal
  }
}

export function markNodeDirty(node: SExprNode): void {
  if (captureJournal && !captureJournal.has(node)) {
    captureJournal.set(node, cloneNodeDeep(node))
  }
  dirtyNodes.add(node)
}

/**
 * Deep-clone a node. Packed nodes clone as packed (no materialization) —
 * cloning a zone with 100k fill points copies one Float64Array, not 400k
 * objects. Atom `value` strings are shared (immutable).
 */
export function cloneNodeDeep(node: SExprNode): SExprNode {
  if (node.type === 'atom') {
    return {
      type: 'atom',
      value: node.value,
      quoted: node.quoted,
      start: node.start,
      end: node.end
    }
  }
  if (node instanceof PackedPtsNode) {
    const coords = node.packedCoords()
    if (coords) return new PackedPtsNode(coords.slice(), node.start, node.end)
  } else if (node instanceof PackedFpLineNode) {
    const rec = node.packedRecord()
    if (rec) return new PackedFpLineNode({ ...rec }, node.start, node.end)
  } else if (node instanceof PackedSegmentNode) {
    const rec = node.packedRecord()
    if (rec) return new PackedSegmentNode({ ...rec }, node.start, node.end)
  }
  return {
    type: 'list',
    children: node.children.map(cloneNodeDeep),
    start: node.start,
    end: node.end
  }
}

/**
 * Serialize a document root, caching the serialized text of each top-level
 * child. A command on a large board touches a handful of the ~25k top-level
 * nodes; re-serializing only those (plus the final join) turns a ~1.3s
 * serialize into ~0.1s. Byte-identical to serializeSExpr(root).
 *
 * The caller owns the cache (WeakMap keyed by child node) and must pass the
 * same one for the same root. Mutated children are discovered via
 * markNodeDirty; added children miss the cache; removed children simply
 * aren't visited.
 *
 * Once joined, each cached text is replaced by a slice of the result, which V8
 * keeps as a view into it rather than a copy: the cache then costs a few bytes
 * a child instead of a second copy of the document, and the previous result
 * it pointed into can be collected.
 */
export function serializeSExprCached(
  root: SExprNode,
  cache: WeakMap<SExprNode, string>,
  trailingNewline = false
): string {
  if (root.type !== 'list' || root.children.length === 0) {
    const text = serializeSExpr(root)
    return trailingNewline ? text + '\n' : text
  }

  const children = root.children
  const firstChild = children[0]
  const tokenName = firstChild.type === 'atom' ? firstChild.value : null

  const lines: string[] = []
  const firstPart = tokenName !== null ? serializeAtom(firstChild as SExprAtom) : null
  let inlineEnd = 1
  if (firstPart !== null) {
    while (inlineEnd < children.length && children[inlineEnd].type === 'atom') {
      inlineEnd++
    }
  }
  if (firstPart !== null && inlineEnd > 1) {
    const inlineAttrs = children.slice(1, inlineEnd).map((c) => serializeSExpr(c, 1))
    lines.push('(' + [firstPart, ...inlineAttrs].join(' '))
  } else if (firstPart !== null) {
    lines.push('(' + firstPart)
  } else {
    lines.push('(')
  }

  // Where each child's text starts in the joined result.
  const starts = new Int32Array(children.length)
  let pos = lines[0].length
  for (let i = inlineEnd; i < children.length; i++) {
    const child = children[i]
    let text = dirtyNodes.delete(child) ? undefined : cache.get(child)
    if (text === undefined) text = serializeSExpr(child, 1)
    pos += 1 + INDENT.length
    starts[i] = pos
    pos += text.length
    lines.push(INDENT + text)
  }

  lines.push(')')
  // Joined in, not appended after: `text + '\n'` is a rope that a later read
  // flattens into another full copy.
  if (trailingNewline) lines.push('')
  const out = lines.join('\n')
  for (let i = inlineEnd; i < children.length; i++) {
    const line = lines[i - inlineEnd + 1]
    cache.set(children[i], out.slice(starts[i], starts[i] + line.length - INDENT.length))
  }
  return out
}

/**
 * Cooperatively pre-fill a serialize cache with every clean top-level child,
 * yielding progress between chunks. Serializing a large document is
 * join-cheap once children are cached, but the first serialize after a parse
 * pays the whole tree at once — inside the first edit's command, as a
 * user-visible stall. Driving this at idle after a load moves that cost off
 * the interaction. Dirty nodes are skipped (their flag must survive for the
 * real serialize), as are cache hits, so running it concurrently with edits
 * is safe — a mid-warm command simply serializes whatever is still cold.
 */
export function* warmSerializeCache(
  root: SExprNode,
  cache: WeakMap<SExprNode, string>
): Generator<number, void> {
  if (root.type !== 'list' || root.children.length === 0) return
  const children = root.children
  for (let i = 1; i < children.length; i++) {
    const child = children[i]
    if (child.type !== 'list') continue
    if (!cache.has(child) && !dirtyNodes.has(child)) {
      cache.set(child, serializeSExpr(child, 1))
    }
    if ((i & 127) === 0) yield i / children.length
  }
}

function serializeAtom(node: SExprAtom): string {
  if (node.quoted) {
    const escaped = node.value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')
    return `"${escaped}"`
  }
  return node.value
}

// ---------------------------------------------------------------------------
// Utility functions for walking the AST
// ---------------------------------------------------------------------------

/** Get the token name of a list node (its first atom child) */
export function getToken(node: SExprNode): string | null {
  // Packed nodes expose their token directly — reading `children` here would
  // materialize every packed sibling during findChild/findChildren scans
  const packed = (node as { packedToken?: string }).packedToken
  if (packed !== undefined) return packed
  if (node.type !== 'list' || node.children.length === 0) return null
  const first = node.children[0]
  return first.type === 'atom' ? first.value : null
}

/** Find the first child list with a given token name */
export function findChild(node: SExprList, token: string): SExprList | null {
  for (const child of node.children) {
    if (child.type === 'list' && getToken(child) === token) {
      return child
    }
  }
  return null
}

/** Find all child lists with a given token name */
export function findChildren(node: SExprList, token: string): SExprList[] {
  const results: SExprList[] = []
  for (const child of node.children) {
    if (child.type === 'list' && getToken(child) === token) {
      results.push(child)
    }
  }
  return results
}

/** Get atom values from a list node (skipping the token name at index 0) */
export function getAtomValues(node: SExprList): string[] {
  return node.children
    .filter((c): c is SExprAtom => c.type === 'atom')
    .slice(1) // skip token name
    .map((a) => a.value)
}

/** Get the first atom value after the token name */
export function getFirstAtomValue(node: SExprList): string | undefined {
  for (let i = 1; i < node.children.length; i++) {
    const child = node.children[i]
    if (child.type === 'atom') return child.value
  }
  return undefined
}

/** Parse a float from the first atom after the token, or return a default */
export function getNumericValue(node: SExprList, defaultVal: number = 0): number {
  const val = getFirstAtomValue(node)
  if (val === undefined) return defaultVal
  const num = parseFloat(val)
  return isNaN(num) ? defaultVal : num
}

/**
 * Extract an (xy X Y) or (at X Y [angle]) coordinate from a child list.
 * Returns [x, y] or [x, y, angle].
 */
export function getXY(
  node: SExprList,
  token: string = 'at'
): { x: number; y: number; angle?: number } | null {
  const child = findChild(node, token)
  if (!child) return null
  const atoms = getAtomValues(child)
  if (atoms.length < 2) return null
  const result: { x: number; y: number; angle?: number } = {
    x: parseFloat(atoms[0]),
    y: parseFloat(atoms[1])
  }
  // `(at x y unlocked)`, a text's pre-20231014 keep-upright flag, has no angle.
  const angle = atoms.length >= 3 ? parseFloat(atoms[2]) : NaN
  if (Number.isFinite(angle)) result.angle = angle
  return result
}

/**
 * `getXY` reading the coordinates as integer nanometers — the distance twin.
 * The trailing angle (when present) stays plain degrees; only x/y are lengths.
 */
export function getXYNm(
  node: SExprList,
  token: string = 'at'
): { x: Nm; y: Nm; angle?: number } | null {
  const child = findChild(node, token)
  if (!child) return null
  const atoms = getAtomValues(child)
  if (atoms.length < 2) return null
  const result: { x: Nm; y: Nm; angle?: number } = {
    x: mmAtomToNm(atoms[0]),
    y: mmAtomToNm(atoms[1])
  }
  // `(at x y unlocked)`, a text's pre-20231014 keep-upright flag, has no angle.
  const angle = atoms.length >= 3 ? parseFloat(atoms[2]) : NaN
  if (Number.isFinite(angle)) result.angle = angle
  return result
}

/**
 * Extract a (size W H) pair.
 */
export function getSize(node: SExprList): { w: number; h: number } | null {
  const child = findChild(node, 'size')
  if (!child) return null
  const atoms = getAtomValues(child)
  if (atoms.length < 2) return null
  return { w: parseFloat(atoms[0]), h: parseFloat(atoms[1]) }
}

/** `getSize` reading integer nanometers — the distance twin. */
export function getSizeNm(node: SExprList): { w: Nm; h: Nm } | null {
  const child = findChild(node, 'size')
  if (!child) return null
  const atoms = getAtomValues(child)
  if (atoms.length < 2) return null
  return { w: mmAtomToNm(atoms[0]), h: mmAtomToNm(atoms[1]) }
}

/**
 * `getNumericValue` for a millimeter atom, as integer nanometers — the
 * distance twin. `getNumericValue` itself stays for angles, ratios and counts.
 */
export function getNmValue(node: SExprList, defaultVal: Nm = 0 as Nm): Nm {
  const val = getFirstAtomValue(node)
  if (val === undefined) return defaultVal
  const num = mmAtomToNm(val)
  return Number.isNaN(num) ? defaultVal : num
}

// ---------------------------------------------------------------------------
// Builders. New atoms inherit the parent node's source position (positions are
// only used for error reporting).
// ---------------------------------------------------------------------------

export function makeAtom(value: string, quoted: boolean, at: number): SExprAtom {
  return { type: 'atom', value, quoted, start: at, end: at }
}

export function makeList(children: SExprNode[], at: number): SExprList {
  return { type: 'list', children, start: at, end: at }
}

export function findOrCreateChild(parent: SExprList, token: string): SExprList {
  let child = findChild(parent, token)
  if (!child) {
    const at = parent.start
    child = {
      type: 'list',
      children: [makeAtom(token, false, at)],
      start: at,
      end: at
    }
    parent.children.push(child)
  }
  return child
}

export function updateAtom(node: SExprNode, value: string, quoted: boolean): void {
  if (node.type === 'atom') {
    node.value = value
    node.quoted = quoted
  }
}

/**
 * Set the single value of a (token value) node: append the atom when
 * missing, otherwise update in place. Existing atoms keep their original
 * quoting style for round-trip stability; `quoted` applies to new atoms.
 */
export function setNodeValue(node: SExprList, value: string, quoted = false): void {
  if (node.children.length < 2) {
    node.children.push(makeAtom(value, quoted, node.start))
  } else {
    const existing = node.children[1]
    updateAtom(existing, value, existing.type === 'atom' ? existing.quoted : quoted)
  }
}

/** Set the (token value) child of `root`, creating it if missing. */
export function setScalarChild(
  root: SExprList,
  token: string,
  value: string,
  quoted = false
): void {
  setNodeValue(findOrCreateChild(root, token), value, quoted)
}
