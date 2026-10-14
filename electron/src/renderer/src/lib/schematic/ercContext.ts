/**
 * What ERC needs to know of the project beyond its sheets: its net classes and
 * which libraries it can reach. Each is optional; a rule whose facts are
 * missing, or not known yet (a library not read so far), stays quiet rather
 * than guess.
 */
export type LibraryState = 'ok' | 'missing' | 'disabled' | 'unreadable'

export interface ErcContext {
  /** The project's net class names. */
  netclasses?: readonly string[]
  /** The project's text variables (Schematic Setup › Text Variables). */
  textVariables?: Readonly<Record<string, string>>
  /** A symbol library nickname's state in the project's tables. */
  symbolLibrary?: (nickname: string) => LibraryState | undefined
  /** Whether a symbol library holds a lib id; without it, the definitions `allChecks` is given decide. */
  hasSymbol?: (libId: string) => boolean | undefined
  /** A footprint library nickname's state in the project's tables. */
  footprintLibrary?: (nickname: string) => LibraryState | undefined
  /** Whether a footprint library holds a footprint. */
  hasFootprint?: (nickname: string, name: string) => boolean | undefined
}
