import { describe, it, expect } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadOrCreateToken, newToken, tokenPath, writeToken } from '../mcpToken'
import type { SecretCipher } from '../partsCredentials'

/** A keyring stand-in: reversible, and visibly not the plaintext. */
const keyring = (available = true): SecretCipher => ({
  isEncryptionAvailable: () => available,
  encryptString: (plain) => Buffer.from(`enc:${plain}`),
  decryptString: (cipher) => {
    const text = cipher.toString()
    if (!text.startsWith('enc:')) throw new Error('not ours')
    return text.slice(4)
  }
})

/** A different keyring: reads only what it wrote itself, refuses the rest —
 *  what a changed signing identity looks like from the app's side. */
const refusing: SecretCipher = {
  isEncryptionAvailable: () => true,
  encryptString: (plain) => Buffer.from(`other:${plain}`),
  decryptString: (cipher) => {
    const text = cipher.toString()
    if (!text.startsWith('other:')) throw new Error('refused')
    return text.slice(6)
  }
}

const withDir = (fn: (dir: string) => void): void => {
  const dir = mkdtempSync(join(tmpdir(), 'goatcad-mcp-token-'))
  try {
    fn(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

const stored = (dir: string): { data: string; encrypted: boolean } =>
  JSON.parse(readFileSync(tokenPath(dir), 'utf8'))

describe('the token store', () => {
  it('mints once and reuses after', () => {
    withDir((dir) => {
      const first = loadOrCreateToken(dir, keyring())
      expect(first.reset).toBe(false)
      expect(first.token.length).toBeGreaterThanOrEqual(32)
      expect(loadOrCreateToken(dir, keyring())).toEqual({ token: first.token, reset: false })
    })
  })

  it('stores ciphertext, never the token, when a keyring is there', () => {
    withDir((dir) => {
      const { token } = loadOrCreateToken(dir, keyring())
      const file = stored(dir)
      expect(file.encrypted).toBe(true)
      expect(file.data).not.toContain(token)
      expect(Buffer.from(file.data, 'base64').toString()).toBe(`enc:${token}`)
    })
  })

  it('falls back to plaintext, owner-only, when there is no keyring', () => {
    withDir((dir) => {
      const { token } = loadOrCreateToken(dir, keyring(false))
      expect(stored(dir)).toEqual({ data: token, encrypted: false })
      if (process.platform !== 'win32') expect(statSync(tokenPath(dir)).mode & 0o777).toBe(0o600)
    })
  })

  it('encrypts a plaintext token in place once a keyring appears, keeping its value', () => {
    // Manual registrations point at the value; a keyring showing up must not
    // silently invalidate them.
    withDir((dir) => {
      const { token } = loadOrCreateToken(dir, keyring(false))
      expect(loadOrCreateToken(dir, keyring())).toEqual({ token, reset: false })
      expect(stored(dir).encrypted).toBe(true)
    })
  })

  it('replaces a token the keyring will not decrypt, and says so', () => {
    withDir((dir) => {
      const { token } = loadOrCreateToken(dir, keyring())
      const loaded = loadOrCreateToken(dir, refusing)
      expect(loaded.reset).toBe(true)
      expect(loaded.token).not.toBe(token)
      // Re-stored under the keyring that is actually here now.
      expect(loadOrCreateToken(dir, refusing)).toEqual({ token: loaded.token, reset: false })
    })
  })

  it('replaces a damaged file rather than trusting it', () => {
    withDir((dir) => {
      writeFileSync(tokenPath(dir), 'short')
      const loaded = loadOrCreateToken(dir, keyring())
      expect(loaded.reset).toBe(true)
      expect(loaded.token.length).toBeGreaterThanOrEqual(32)
      writeFileSync(tokenPath(dir), JSON.stringify({ data: 'x', encrypted: false }))
      expect(loadOrCreateToken(dir, keyring()).reset).toBe(true)
    })
  })

  it('writeToken stores what it is given, so a replacement is what the server runs with', () => {
    withDir((dir) => {
      const minted = newToken()
      expect(writeToken(dir, keyring(), minted)).toBe(minted)
      expect(loadOrCreateToken(dir, keyring())).toEqual({ token: minted, reset: false })
    })
  })
})
