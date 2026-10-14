import { describe, it, expect } from 'vitest'
import { i18n } from '../../i18n'
import { PROVIDER_IDS, PROVIDER_INFO } from '../../../../main/partsProviders'

/**
 * Ties main's provider registry to the renderer copy that renders it.
 *
 * The two halves are deliberately split — the registry owns the credential
 * fields and the registration URL, `parts.yaml` owns the translatable prose —
 * which means adding a provider in one place and forgetting the other produces a
 * card with a blank body and no onboarding at all. Nothing else catches that:
 * a missing key renders as the key path, and a missing *list* renders as
 * nothing, which is exactly the "no idea what to do next" failure.
 *
 * The steps also go through `tm()` rather than `t()` because they are a list
 * message, so this exercises that resolution for real rather than trusting it.
 */
describe('provider registry ↔ locale copy', () => {
  it('resolves every provider a non-empty list of setup steps', () => {
    for (const id of PROVIDER_IDS) {
      const raw: unknown = i18n.global.tm(`parts.providers.${id}.steps`)
      expect(Array.isArray(raw), `parts.providers.${id}.steps is not a list`).toBe(true)
      const steps = raw as Parameters<typeof i18n.global.rt>[0][]
      expect(steps.length, `parts.providers.${id}.steps is empty`).toBeGreaterThan(0)
      for (const step of steps) {
        expect(i18n.global.rt(step).length).toBeGreaterThan(0)
      }
    }
  })

  it('gives every credential field a label, since the input renders it', () => {
    for (const id of PROVIDER_IDS) {
      for (const field of PROVIDER_INFO[id].fields) {
        const key = `parts.fields.${field.labelKey}`
        expect(i18n.global.t(key), `missing ${key}`).not.toBe(key)
      }
    }
  })

  it('names a translatable error message for every failure kind main can send', () => {
    // The kinds are a union, so this list is the one place they are enumerated
    // at runtime; a new kind with no message would render as its own key path.
    const kinds = [
      'no-credentials',
      'invalid-credentials',
      'forbidden',
      'rate-limited',
      'quota-exhausted',
      'network',
      'timeout',
      'provider-error',
      'bad-response',
      'storage-unavailable'
    ]
    for (const kind of kinds) {
      const key = `parts.errors.${kind}`
      expect(i18n.global.t(key), `missing ${key}`).not.toBe(key)
    }
  })
})
