/**
 * The pin table: every pin of the edited symbol as ROWS, plus the CSV both
 * directions and the placement rule an import needs.
 *
 * **Why a table at all**, when this editor puts everything else on a canvas
 * selection: the two things a selection structurally cannot do are *scanning a
 * column* ("is pin 31 named, are 1–48 all there") and *bulk entry*. Those are
 * exactly the 48-pin bar the editor is sized to — the expensive part of
 * authoring a real part is entering and verifying pins, not drawing them — so
 * the grid arrives on that argument and no other.
 *
 * **What the table owns is deliberately narrow**, and it is the fields split
 * applied to pins:
 *
 * > The table owns what a pin **is** — number, name, electrical type.
 * > Canvas selection owns where it **sits** and how it **draws** — x, y, angle,
 * > length, graphic style, text sizes, alternates.
 *
 * KiCad's own Pin Table carries Orientation / X Position / Y Position columns;
 * we drop all three on that rule rather than on taste, which is also what keeps
 * the grid inside a right bar instead of forcing a modal. The one column that
 * is neither identity nor styling — **Unit** — is carried anyway, because on a
 * multi-gate part "which gate is pin 7 on" is a column-scan question with no
 * other home, and it is shown only when the symbol has gates at all (the same
 * conditional-chrome rule the unit selector and `commonToAllUnits` follow).
 *
 * Pure: no Vue, no AST writes. The rows carry a `SymbolPartAddress` and the
 * host maps an edit onto `updatePin`, so this file never learns the command
 * layer.
 */
import { nm, NM_PER_MIL, type Nm } from '../kicad/coordinates'
import type { KicadLibSymbol } from '../kicad/schematic'
import type { SymbolPartAddress } from '../symbol/symbolEdit'
import { ELECTRICAL_TYPES } from '../symbol/symbolPropertySchema'

/** One pin, as the grid shows it. */
export interface PinTableRow {
  /** How the host resolves this row back to its AST node. */
  address: SymbolPartAddress
  number: string
  name: string
  electricalType: string
  /** 0 is KiCad's "common to all units" sub-symbol. */
  unit: number
}

/**
 * Rows for the variants that are actually on screen — style 0 (common) plus the
 * style being viewed, which is `resolveSymbolGeometry`'s own rule.
 *
 * Listing every style instead would put pins in the grid that the canvas does
 * not draw and the hit-test does not return, which is an
 * invisible-but-editable pin.
 *
 * **Document order, never sorted by number.** Sorting would move a row out from
 * under the cursor the moment its number is typed, and it would disagree with
 * the order the canvas and the undo history use.
 */
export function buildPinTableRows(
  definition: KicadLibSymbol | null,
  bodyStyle: number
): PinTableRow[] {
  if (!definition) return []
  const rows: PinTableRow[] = []
  for (const variant of definition.variants) {
    if (variant.style !== 0 && variant.style !== bodyStyle) continue
    variant.pins.forEach((pin, index) => {
      rows.push({
        address: { kind: 'pin', unit: variant.unit, style: variant.style, index },
        number: pin.number,
        name: pin.name,
        electricalType: pin.electricalType,
        unit: variant.unit
      })
    })
  }
  return rows
}

/**
 * Which rows carry a pin number that another row also uses.
 *
 * The one error hand entry and a pasted datasheet actually produce, and the one
 * nothing else in the editor can report: a duplicate pin number **draws
 * perfectly** and fails much later, in ERC or in the netlist. So it is marked on
 * the cell, where the row that is wrong is the row you are looking at.
 *
 * Numbers compare as TRIMMED STRINGS, never parsed. `A1` and `MP` are real pin
 * numbers (BGA balls, mounting pads), and treating an unparseable number as
 * absent would under-report the very thing this exists to catch. Two blanks
 * count as a duplicate of each other, because they are.
 */
export const duplicateAddresses = (rows: PinTableRow[]): Set<string> => {
  const counts = new Map<string, number>()
  for (const row of rows) {
    const key = row.number.trim()
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  const keys = new Set<string>()
  for (const row of rows) {
    if ((counts.get(row.number.trim()) ?? 0) > 1) keys.add(addressCsvKey(row.address))
  }
  return keys
}

/** A row identity for template keys and Sets — not parsed back. */
export const addressCsvKey = (a: SymbolPartAddress): string => `${a.unit}.${a.style}.${a.index}`

// ---------------------------------------------------------------------------
// Sorting
// ---------------------------------------------------------------------------

/** The three columns that are a pin's identity are the three you can sort by. */
export type PinTableSortKey = 'number' | 'name' | 'electricalType'
export interface PinTableSort {
  key: PinTableSortKey
  direction: 'asc' | 'desc'
}

/** What the grid opens on: the order the datasheet lists, and the part is built. */
export const DEFAULT_PIN_SORT: PinTableSort = { key: 'number', direction: 'asc' }

/** Digits and non-digits as alternating chunks — `A10` → `['A', '10']`. */
const chunk = (value: string): string[] => value.match(/\d+|\D+/g) ?? []

/**
 * Natural order for the strings that name a pin.
 *
 * Plain lexicographic ordering puts `10` between `1` and `2`, which on a 48-pin
 * part makes the column unreadable for the one job it has. Chunked comparison
 * fixes both axes at once: pin numbers (`1 < 2 < 10`) and the bus names next to
 * them (`D0 < D1 < D10`), which have exactly the same problem.
 *
 * A numeric chunk sorts before a text one, so a part mixing plain numbers with
 * BGA balls reads `1 … 48, A1, A2, B1` rather than interleaving them.
 */
export const compareNatural = (a: string, b: string): number => {
  const left = chunk(a.trim())
  const right = chunk(b.trim())
  for (let i = 0; i < Math.min(left.length, right.length); i++) {
    const x = left[i]
    const y = right[i]
    const xNum = /^\d/.test(x)
    const yNum = /^\d/.test(y)
    if (xNum && yNum) {
      // Compared as numbers, so `007` and `7` are equal here and the
      // tie-break below decides — never as strings, which is the bug this
      // whole function exists to fix.
      const diff = Number(x) - Number(y)
      if (diff !== 0) return diff
    } else if (xNum !== yNum) return xNum ? -1 : 1
    else {
      const diff = x.localeCompare(y, undefined, { sensitivity: 'base' })
      if (diff !== 0) return diff
    }
  }
  return left.length - right.length
}

/**
 * Sort the grid.
 *
 * **Every sort falls back to pin number, then to document order.** Sorting by
 * Type is really *grouping* by type, and a group whose members are in arbitrary
 * order is barely more use than no grouping at all; the final index tie-break is
 * what makes the result deterministic rather than merely stable.
 *
 * The type column sorts by the **displayed label**, not by the KiCad token, so
 * the order matches what is on screen in whatever language it is on screen in.
 * `labelOf` defaults to identity for callers that have no translator.
 */
export function sortPinTableRows(
  rows: PinTableRow[],
  sort: PinTableSort,
  labelOf: (electricalType: string) => string = (value) => value
): PinTableRow[] {
  const value = (row: PinTableRow): string =>
    sort.key === 'electricalType' ? labelOf(row.electricalType) : row[sort.key]
  const sign = sort.direction === 'asc' ? 1 : -1
  return rows
    .map((row, index) => ({ row, index }))
    .sort((a, b) => {
      const primary = compareNatural(value(a.row), value(b.row))
      if (primary !== 0) return primary * sign
      // The tie-breaks do NOT flip with the direction: a descending Type sort
      // should reverse the groups, not scramble the pins inside each one.
      if (sort.key !== 'number') {
        const byNumber = compareNatural(a.row.number, b.row.number)
        if (byNumber !== 0) return byNumber
      }
      return a.index - b.index
    })
    .map((entry) => entry.row)
}

// ---------------------------------------------------------------------------
// CSV
// ---------------------------------------------------------------------------

/**
 * Column headers, in export order. Read case-insensitively on import, and an
 * absent header row falls back to this order — a datasheet table pasted with
 * its header stripped is the common case, not the exception.
 */
export const PIN_CSV_COLUMNS = ['Number', 'Name', 'Type', 'Unit'] as const

const needsQuote = (value: string): boolean => /[",\n\r]/.test(value)
const quote = (value: string): string =>
  needsQuote(value) ? `"${value.replace(/"/g, '""')}"` : value

/**
 * RFC 4180 CSV, with `\r\n` line endings for the same reason: this file is
 * opened in a spreadsheet more often than by a program, and Excel is the
 * pickiest reader in the loop.
 *
 * The Unit column is written only when the symbol has gates, matching what the
 * grid shows — an export that carries a column the UI never displayed invites a
 * round-trip through a value the author never saw.
 */
export function formatPinCsv(rows: PinTableRow[], includeUnit: boolean): string {
  const columns = includeUnit ? PIN_CSV_COLUMNS : PIN_CSV_COLUMNS.slice(0, 3)
  const lines = [columns.join(',')]
  for (const row of rows) {
    const cells = [row.number, row.name, row.electricalType]
    if (includeUnit) cells.push(String(row.unit))
    lines.push(cells.map(quote).join(','))
  }
  return lines.join('\r\n') + '\r\n'
}

/** Split one delimited line, honouring `"` quoting and `""` escapes. */
const splitLine = (line: string, delimiter: string): string[] => {
  const cells: string[] = []
  let cell = ''
  let quoted = false
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (quoted) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cell += '"'
          i++
        } else quoted = false
      } else cell += ch
    } else if (ch === '"') quoted = true
    else if (ch === delimiter) {
      cells.push(cell)
      cell = ''
    } else cell += ch
  }
  cells.push(cell)
  return cells.map((c) => c.trim())
}

/**
 * Tab or comma, decided by the FIRST line rather than by the whole document.
 *
 * A datasheet pin table copied out of a PDF or a browser arrives tab-separated
 * and full of commas inside names (`A0, A1 select`); counting commas over the
 * whole file would pick the wrong one on exactly that input. Ties go to comma,
 * since that is what we export.
 */
const detectDelimiter = (firstLine: string): string =>
  (firstLine.match(/\t/g)?.length ?? 0) > (firstLine.match(/,/g)?.length ?? 0) ? '\t' : ','

const TYPE_ALIASES = new Map<string, string>([
  // KiCad's own token set is the target; these are what a human writes instead.
  ['power', 'power_in'],
  ['power in', 'power_in'],
  ['power input', 'power_in'],
  ['power out', 'power_out'],
  ['power output', 'power_out'],
  ['bidi', 'bidirectional'],
  ['inout', 'bidirectional'],
  ['io', 'bidirectional'],
  ['i/o', 'bidirectional'],
  ['tristate', 'tri_state'],
  ['tri state', 'tri_state'],
  ['open collector', 'open_collector'],
  ['opencollector', 'open_collector'],
  ['open emitter', 'open_emitter'],
  ['openemitter', 'open_emitter'],
  ['no connect', 'no_connect'],
  ['nc', 'no_connect'],
  ['unspec', 'unspecified']
])

/**
 * Map a written type onto KiCad's token, or null.
 *
 * Deliberately forgiving about SHAPE (case, spaces vs underscores, a handful of
 * spellings a person actually types) and strict about VALUE: an unrecognised
 * type is reported rather than silently defaulted to `passive`, because a pin
 * with the wrong electrical type draws perfectly and fails in ERC, which is the
 * class of error this whole surface exists to surface early.
 */
export const normalizeElectricalType = (raw: string): string | null => {
  const key = raw.trim().toLowerCase()
  if (!key) return 'passive'
  const underscored = key.replace(/[\s-]+/g, '_')
  if (ELECTRICAL_TYPES.includes(underscored)) return underscored
  return TYPE_ALIASES.get(key.replace(/[\s-]+/g, ' ')) ?? null
}

/** A pin as the CSV describes it — identity only; geometry comes from layout. */
export interface ImportedPin {
  number: string
  name: string
  electricalType: string
  unit: number
}

export interface PinCsvParse {
  pins: ImportedPin[]
  /** Human-readable, line-numbered, and NOT fatal on their own — the caller
   *  shows them next to the count and lets the author decide. */
  errors: string[]
}

const HEADER_WORDS = new Set([
  'number',
  'pin',
  'pin number',
  'name',
  'pin name',
  'type',
  'electrical type',
  'electrical',
  'unit',
  'gate'
])

/**
 * Parse a pasted or loaded pin table.
 *
 * **Refuses per row rather than per file.** A 48-line paste with one bad type
 * should import 47 pins and say which line it dropped; failing the whole thing
 * makes the author diff two tables by eye to find the typo.
 */
export function parsePinCsv(text: string): PinCsvParse {
  const lines = text
    .split(/\r\n|\r|\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
  if (!lines.length) return { pins: [], errors: [] }

  const delimiter = detectDelimiter(lines[0])
  const rows = lines.map((line) => splitLine(line, delimiter))

  // A header is recognised by CONTENT, not by position: the first row is a
  // header only when every one of its non-empty cells is a known column word.
  // "1, VDD, power_in" is data even though it sits first.
  const first = rows[0].filter((c) => c.length > 0)
  const hasHeader = first.length > 0 && first.every((cell) => HEADER_WORDS.has(cell.toLowerCase()))

  // Column order comes from the header when there is one, so a spreadsheet the
  // author rearranged still imports; otherwise it is the export order.
  let order: number[] = [0, 1, 2, 3]
  if (hasHeader) {
    const index = (...names: string[]): number =>
      rows[0].findIndex((cell) => names.includes(cell.toLowerCase()))
    order = [
      index('number', 'pin', 'pin number'),
      index('name', 'pin name'),
      index('type', 'electrical type', 'electrical'),
      index('unit', 'gate')
    ]
  }

  const pins: ImportedPin[] = []
  const errors: string[] = []
  const cellAt = (row: string[], slot: number): string => {
    const column = order[slot]
    return column >= 0 ? (row[column] ?? '') : ''
  }

  rows.forEach((row, rowIndex) => {
    if (hasHeader && rowIndex === 0) return
    // Line numbers are the ones a spreadsheet shows, so an error can be acted on.
    const line = rowIndex + 1
    const number = cellAt(row, 0)
    if (!number) {
      errors.push(`${line}: no pin number`)
      return
    }
    const rawType = cellAt(row, 2)
    const electricalType = normalizeElectricalType(rawType)
    if (electricalType === null) {
      errors.push(`${line}: unknown electrical type "${rawType}"`)
      return
    }
    const rawUnit = cellAt(row, 3)
    const unit = rawUnit === '' ? 1 : Number(rawUnit)
    if (!Number.isInteger(unit) || unit < 0) {
      errors.push(`${line}: unit "${rawUnit}" is not a whole number`)
      return
    }
    pins.push({ number, name: cellAt(row, 1), electricalType, unit })
  })

  return { pins, errors }
}

// ---------------------------------------------------------------------------
// Where imported pins go
// ---------------------------------------------------------------------------

/** The schematic grid, and the pitch every stacked pin steps by. */
const PITCH = nm(100 * NM_PER_MIL)
/** Where the column starts on a symbol that has no pins to line up with. */
const DEFAULT_X = nm(-300 * NM_PER_MIL)
/** KiCad's left-facing pin: the body runs right from the connection point. */
const LEFT_ANGLE = 0

export interface PlacedImportPin extends ImportedPin {
  x: Nm
  y: Nm
  angle: number
}

/**
 * Stack imported pins in one column, guaranteed not to land on an existing pin.
 *
 * **Deliberately dumb.** This repo already owns a real placement engine
 * (`symbolLayout.ts` `planSymbol`), which puts power on top, grounds on the
 * bottom and balances the signal sides — but it requires every pin to carry a
 * functional `group`, and refuses rather than guesses, because only a reader of
 * the datasheet knows that `SDA` and `SCL` are one bus. A CSV typed by hand carries
 * no groups, so inferring sides here would be a rule that is only sometimes
 * applied.
 *
 * So the contract is the honest one: **land every pin somewhere visible, on the
 * grid, overlapping nothing**, and leave arrangement to the author's hands or
 * to `planSymbol` through the MCP path. Two visible pins at one coordinate read
 * as a drawing mistake and give a reader no way to tell which is which, which
 * is the one outcome an import must not produce.
 *
 * The column continues BELOW the lowest existing pin rather than starting at the
 * origin, so importing into a symbol that already has pins appends instead of
 * burying the work already there.
 */
export function layoutImportedPins(
  imported: ImportedPin[],
  existing: { x: Nm; y: Nm }[]
): PlacedImportPin[] {
  const occupied = new Set(existing.map((p) => `${p.x},${p.y}`))
  // Line up with the existing left column when there is one; a fresh symbol
  // gets a fixed offset that leaves room for a body at the origin.
  const x = existing.length ? nm(Math.min(...existing.map((p) => p.x))) : DEFAULT_X
  // One pitch below the lowest pin, so the new block reads as a continuation.
  const startY = existing.length ? nm(Math.min(...existing.map((p) => p.y)) - PITCH) : nm(0)

  const placed: PlacedImportPin[] = []
  let y = startY
  for (const pin of imported) {
    // Guaranteed to terminate: `occupied` is finite and y strictly decreases.
    while (occupied.has(`${x},${y}`)) y = nm(y - PITCH)
    occupied.add(`${x},${y}`)
    placed.push({ ...pin, x, y, angle: LEFT_ANGLE })
    y = nm(y - PITCH)
  }
  return placed
}
