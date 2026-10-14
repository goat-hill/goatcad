/**
 * Which nets are the halves of a differential pair, as KiCad names them
 * (`DRC_ENGINE::MatchDpSuffix`): read back from the end of the name past any
 * digits and underscores, a `+` or `P` is the positive half and `-` or `N`
 * the negative; the complement swaps that character. `USB_D+`/`USB_D-`,
 * `CLK_P1`/`CLK_N1`, `TX_P_0`/`TX_N_0`.
 */
import type { ConditionContext } from './constraints'

export interface DiffPairName {
  base: string
  polarity: 1 | -1
  complement: string
}

export function matchDiffPair(netName: string | undefined): DiffPairName | null {
  if (!netName) return null
  let i = netName.length - 1
  while (i >= 0 && (/[0-9]/.test(netName[i]) || netName[i] === '_')) i--
  if (i < 0) return null
  const c = netName[i]
  const suffix = netName.slice(i + 1)
  const base = netName.slice(0, i)
  if (c === '+' || c === 'P') {
    return { base, polarity: 1, complement: `${base}${c === '+' ? '-' : 'N'}${suffix}` }
  }
  if (c === '-' || c === 'N') {
    return { base, polarity: -1, complement: `${base}${c === '-' ? '+' : 'P'}${suffix}` }
  }
  return null
}

/**
 * `inDiffPair(pattern)`: the net has a pair suffix, its complement is a net of
 * the board, and the base name matches the pattern (a case-sensitive
 * wildcard) — or, when the base ends in `_`, the part before it does.
 */
export function inDiffPair(
  netName: string | undefined,
  pattern: string,
  netNames: ReadonlySet<string>
): boolean {
  const pair = matchDiffPair(netName)
  if (!pair || !netNames.has(pair.complement)) return false
  if (wildcard(pattern, pair.base)) return true
  return pair.base.endsWith('_') && wildcard(pattern, pair.base.slice(0, -1))
}

/**
 * `AB.isCoupledDiffPair()`: A's net is a pair half and B's net is its
 * complement — or, for the length and gap constraints, A's complement exists.
 */
export function isCoupledDiffPair(
  { a, b, type }: ConditionContext,
  netNames: ReadonlySet<string>
): boolean {
  const pair = matchDiffPair(a.netName)
  if (!pair) return false
  if (b?.netName === pair.complement) return true
  const pairTypes = type === 'diff_pair_gap' || type === 'length' || type === 'skew'
  return pairTypes && netNames.has(pair.complement)
}

/** A case-sensitive shell wildcard: `*` any run, `?` one character. */
export function wildcard(pattern: string, text: string): boolean {
  let p = 0
  let t = 0
  let star = -1
  let mark = 0
  while (t < text.length) {
    if (p < pattern.length && (pattern[p] === '?' || pattern[p] === text[t])) {
      p++
      t++
    } else if (p < pattern.length && pattern[p] === '*') {
      star = p++
      mark = t
    } else if (star >= 0) {
      p = star + 1
      t = ++mark
    } else {
      return false
    }
  }
  while (p < pattern.length && pattern[p] === '*') p++
  return p === pattern.length
}
