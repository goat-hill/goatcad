/**
 * BOM CSV serialization (fabrication-export-workstream.md).
 *
 * Pure: columns + rows in, the exact CSV text (and its field matrix) out. The
 * Manufacture BOM preview renders the matrix with per-column color; the eventual
 * exporter writes `serializeBomCsv`. Field escaping is RFC-4180 — load-bearing
 * here because a grouped designator like `C1, C2, C3` contains commas and must
 * be quoted, or every downstream parser splits it into three columns.
 */

export interface BomColumn {
  /** Key into a row object. */
  key: string
  /** Header cell text. */
  label: string
}

export type BomRow = Record<string, string>

const NEEDS_QUOTING = /[",\r\n]/

/** Quote per RFC 4180 when the field contains a comma, quote, CR, or LF. */
export function escapeCsvField(value: string): string {
  return NEEDS_QUOTING.test(value) ? `"${value.replace(/"/g, '""')}"` : value
}

/** Header row + data rows as a matrix of raw (unescaped) field strings. */
export function bomCsvMatrix(columns: BomColumn[], rows: BomRow[]): string[][] {
  return [columns.map((c) => c.label), ...rows.map((r) => columns.map((c) => r[c.key] ?? ''))]
}

/** RFC-4180 CSV text (CRLF line endings) of a header-first matrix — the bytes the exporter writes. */
export function serializeCsv(matrix: readonly (readonly string[])[]): string {
  return matrix.map((line) => line.map(escapeCsvField).join(',')).join('\r\n')
}

export function serializeBomCsv(columns: BomColumn[], rows: BomRow[]): string {
  return serializeCsv(bomCsvMatrix(columns, rows))
}
