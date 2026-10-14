import { tk, type MessageKey } from '../messageKey'
import type { GitOpError } from './gitOps'

/**
 * The explanation for a remote failure, or null when git's own words are the
 * best we have (`other`, or a local op's error). Pure; exported for tests.
 */
export function gitRemoteErrorKey(err: GitOpError): MessageKey | null {
  switch (err.failure) {
    case 'no-remote':
      return tk('git.error.noRemote')
    case 'no-upstream':
      return tk('git.error.noUpstream')
    case 'auth':
      return tk('git.error.auth')
    case 'diverged':
      return tk('git.error.diverged')
    case 'rejected':
      return tk('git.error.rejected')
    case 'network':
      return tk('git.error.network')
    default:
      return null
  }
}
