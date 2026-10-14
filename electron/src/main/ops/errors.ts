/**
 * One error shape for every operation.
 *
 * Design: `docs/agent-api.md`. The rule that makes this
 * worth having: **`message` is a sentence for a person; `fix` is a sentence for
 * the model, and it names the next call.** An error that does not say what to do
 * next costs a turn to diagnose and usually gets retried verbatim.
 *
 * `code` is the eight-way taxonomy a *client* branches on. `kind` is the finer
 * vocabulary a domain already has — a distributor's `no-credentials`, the
 * window's `read-only` — kept because an agent that cannot tell "your key is
 * invalid" from "you are out of quota until midnight" retries the one it should
 * not. `data` carries what the answer must
 * still deliver on a failure; quota is the one that matters, for the same
 * reason.
 */

export type OpErrorCode =
  | 'unknown-op'
  | 'invalid-args'
  | 'no-document'
  | 'not-found'
  | 'refused'
  | 'conflict'
  | 'timeout'
  | 'internal'

export interface OpError {
  code: OpErrorCode
  /** A sentence for a person. */
  message: string
  /** A sentence for the model, naming the operation to call next. Required on
   *  `refused` and `not-found` by review, since those are the two an agent can
   *  actually recover from. */
  fix?: string
  /** Nearest valid values, when an echoed identifier did not resolve. */
  candidates?: string[]
  /** JSON pointer into the arguments, for `invalid-args`. */
  path?: string
  /** The domain's own failure kind, when it is finer than `code`. */
  kind?: string
  /** Anything the caller still needs despite the failure — remaining quota,
   *  what is open instead. */
  data?: Record<string, unknown>
}

/** A refusal. Its own type because the helpers below never produce anything
 *  else, and a caller that can only fail — a request builder, say — should say
 *  so in its signature rather than in a comment. */
export interface OpFailure {
  ok: false
  error: OpError
}

export type OpOutcome = { ok: true; value: unknown; warning?: string } | OpFailure

export const succeed = (value: unknown, warning?: string): OpOutcome =>
  warning === undefined ? { ok: true, value } : { ok: true, value, warning }

export const fail = (error: OpError): OpFailure => ({ ok: false, error })

/** A precondition the caller can satisfy: a read that has to happen first, a
 *  handshake, a key that is not installed. Always carries a `fix`. */
export const refused = (
  message: string,
  fix: string,
  extra?: Pick<OpError, 'kind' | 'data' | 'candidates'>
): OpFailure => fail({ code: 'refused', message, fix, ...extra })

/** An identifier that did not resolve. `candidates` is what turns this from a
 *  dead end into one more turn. */
export const notFound = (
  message: string,
  fix: string,
  extra?: Pick<OpError, 'kind' | 'data' | 'candidates'>
): OpFailure => fail({ code: 'not-found', message, fix, ...extra })

export const invalidArgs = (message: string, path: string, fix?: string): OpFailure =>
  fail({ code: 'invalid-args', message, path, ...(fix ? { fix } : {}) })

export const conflict = (
  message: string,
  fix: string,
  extra?: Pick<OpError, 'kind' | 'data'>
): OpFailure => fail({ code: 'conflict', message, fix, ...extra })

/** Our bug, reported as one. Never used for anything a caller can fix. */
export const internal = (message: string, kind?: string): OpFailure =>
  fail({ code: 'internal', message, ...(kind ? { kind } : {}) })

/**
 * The nearest names to a miss, for `unknown-op` and for any handler that can
 * enumerate what it does have.
 *
 * Ordinary Levenshtein over a list this short (about fifty operations) is
 * cheaper than the turn it saves, and a typo is by far the most common way an
 * agent names something that does not exist.
 */
export const nearest = (wanted: string, available: readonly string[], limit = 3): string[] => {
  const distance = (a: string, b: string): number => {
    const rows = Array.from({ length: b.length + 1 }, (_, i) => i)
    for (let i = 1; i <= a.length; i += 1) {
      let previous = rows[0]
      rows[0] = i
      for (let j = 1; j <= b.length; j += 1) {
        const swap = rows[j]
        rows[j] = Math.min(rows[j] + 1, rows[j - 1] + 1, previous + (a[i - 1] === b[j - 1] ? 0 : 1))
        previous = swap
      }
    }
    return rows[b.length]
  }
  const lower = wanted.toLowerCase()
  return (
    [...available]
      .map((name) => ({ name, score: distance(lower, name.toLowerCase()) }))
      // Half the name's length is the point past which a "suggestion" is noise.
      .filter((entry) => entry.score <= Math.max(3, Math.floor(entry.name.length / 2)))
      .sort((a, b) => a.score - b.score || a.name.localeCompare(b.name))
      .slice(0, limit)
      .map((entry) => entry.name)
  )
}
