import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import { join } from 'path'
import { PartsCredentialStore, redactSecrets, type SecretCipher } from '../partsCredentials'
import { toPartsError } from '../parts'
import { PartsRequestError } from '../partsProviders'

/** Stands in for Electron's safeStorage. Reversible on purpose — the test is
 *  about the store's contract, not about the cipher's strength. */
const fakeCipher = (available = true): SecretCipher => ({
  isEncryptionAvailable: () => available,
  encryptString: (plain) => Buffer.from(`enc:${plain}`, 'utf8'),
  decryptString: (cipher) => {
    const text = cipher.toString('utf8')
    if (!text.startsWith('enc:')) throw new Error('not our ciphertext')
    return text.slice(4)
  }
})

let dir: string

beforeEach(() => {
  dir = fs.mkdtempSync(join(os.tmpdir(), 'goatcad-parts-'))
})

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

describe('PartsCredentialStore', () => {
  it('round-trips credentials through the cipher', () => {
    const store = new PartsCredentialStore(dir, fakeCipher())
    store.set('mouser', { apiKey: 'abcd-efgh-ijkl' }, '…ij-ijkl')
    expect(store.get('mouser')).toEqual({ apiKey: 'abcd-efgh-ijkl' })
  })

  it('never writes the plaintext secret to disk', () => {
    const store = new PartsCredentialStore(dir, fakeCipher())
    store.set('digikey', { clientId: 'id-123', clientSecret: 'SUPERSECRET' }, 'id-123…')

    const onDisk = fs.readFileSync(store.path, 'utf8')
    expect(onDisk).not.toContain('SUPERSECRET')
    // The hint is stored in the clear on purpose — it is not a credential.
    expect(onDisk).toContain('id-123…')
  })

  it('exposes a status that carries no secret', () => {
    const store = new PartsCredentialStore(dir, fakeCipher())
    store.set('digikey', { clientId: 'id-123', clientSecret: 'SUPERSECRET' }, 'id-123…')

    const status = store.status('digikey')
    expect(status).toMatchObject({ configured: true, hint: 'id-123…', encryptionAvailable: true })
    expect(JSON.stringify(status)).not.toContain('SUPERSECRET')
  })

  it('persists across a restart', () => {
    new PartsCredentialStore(dir, fakeCipher()).set('mouser', { apiKey: 'k-12345678' }, '…345678')
    const reopened = new PartsCredentialStore(dir, fakeCipher())
    expect(reopened.get('mouser')).toEqual({ apiKey: 'k-12345678' })
  })

  it('reports "not configured" when the keyring can no longer decrypt', () => {
    new PartsCredentialStore(dir, fakeCipher()).set('mouser', { apiKey: 'k-1' }, null)

    // A restored profile or a new OS user: the bytes are there, the key is not.
    const brokenCipher: SecretCipher = {
      isEncryptionAvailable: () => true,
      encryptString: (plain) => Buffer.from(plain),
      decryptString: () => {
        throw new Error('decrypt failed')
      }
    }
    const store = new PartsCredentialStore(dir, brokenCipher)
    // Never throws into a search; the card just asks for the key again.
    expect(store.get('mouser')).toBeNull()
  })

  it('reports the live keyring capability, not the one at write time', () => {
    new PartsCredentialStore(dir, fakeCipher(true)).set('mouser', { apiKey: 'k-1' }, null)
    // The question the card answers is "is my key protected *right now*".
    expect(
      new PartsCredentialStore(dir, fakeCipher(false)).status('mouser').encryptionAvailable
    ).toBe(false)
  })

  it('removes a provider without touching the other', () => {
    const store = new PartsCredentialStore(dir, fakeCipher())
    store.set('mouser', { apiKey: 'm' }, null)
    store.set('digikey', { clientId: 'd', clientSecret: 's' }, null)
    store.remove('mouser')

    expect(store.status('mouser').configured).toBe(false)
    expect(store.status('digikey').configured).toBe(true)
  })

  it('starts empty on a damaged file rather than failing to construct', () => {
    fs.writeFileSync(join(dir, 'parts-credentials.json'), '{ not json', 'utf8')
    expect(new PartsCredentialStore(dir, fakeCipher()).status('mouser').configured).toBe(false)
  })
})

describe('redactSecrets', () => {
  it('removes a key echoed in an error body', () => {
    expect(redactSecrets('rejected key abcd-efgh-1234', ['abcd-efgh-1234'])).toBe(
      'rejected key ***'
    )
  })

  it('removes a key carried in a URL query parameter', () => {
    // Mouser authenticates with a query parameter, so a bare transport error
    // quoting the URL would otherwise leak the key verbatim.
    expect(
      redactSecrets(
        'failed: https://api.mouser.com/api/v1/search/keyword?apiKey=abcd-1234-efgh',
        []
      )
    ).toBe('failed: https://api.mouser.com/api/v1/search/keyword?apiKey=***')
  })

  it('leaves a short value alone, which would otherwise redact the whole message', () => {
    expect(redactSecrets('the key is bad', ['bad'])).toBe('the key is bad')
  })
})

describe('toPartsError', () => {
  it('keeps the typed kind so the renderer can translate it', () => {
    const error = toPartsError(new PartsRequestError('forbidden', 'HTTP 403'), [])
    expect(error).toEqual({ kind: 'forbidden', detail: 'HTTP 403' })
  })

  it('scrubs the secret out of a detail before it can cross the bridge', () => {
    const error = toPartsError(new PartsRequestError('provider-error', 'bad key sekret-12345678'), [
      'sekret-12345678'
    ])
    expect(error.detail).toBe('bad key ***')
  })

  it('treats an unrecognized throw as a network failure, still scrubbed', () => {
    const error = toPartsError(new Error('connect ECONNREFUSED sekret-12345678'), [
      'sekret-12345678'
    ])
    expect(error).toMatchObject({ kind: 'network' })
    expect(error.detail).not.toContain('sekret')
  })
})
