/**
 * The MCP server's bearer token at rest.
 *
 * The token guards a loopback
 * socket — any local process, a browser page included, can reach the port, and
 * this is what stops them driving the app. It is stored the way the
 * distributor keys are (`partsCredentials.ts`): **encrypted through the OS
 * keyring via `safeStorage`** where one is available, and as plaintext,
 * owner-only, where none is (a Linux session without a secret service, the
 * screenshot harness). The cipher is injected, so this module is testable and
 * the no-keyring path is an explicit branch rather than a surprise.
 *
 * The file is the token's *only* copy. An agent tab is handed it in its
 * environment (`terminalSessions.ts`), never in a file, and Settings shows it
 * from memory.
 *
 * Electron-free; the caller passes `safeStorage`.
 */
import { randomBytes } from 'node:crypto'
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { SecretCipher } from './partsCredentials'

export const TOKEN_FILE = 'mcp-token'

export const newToken = (): string => randomBytes(32).toString('base64url')

export const tokenPath = (dir: string): string => join(dir, TOKEN_FILE)

interface StoredToken {
  /** base64 of the ciphertext, or the token itself when `encrypted` is false. */
  data: string
  /** Whether a real keyring backed the encryption when this was written. */
  encrypted: boolean
}

export interface TokenLoad {
  token: string
  /**
   * True when a token was stored but could not be read — the keyring refused,
   * or is gone, or the file was damaged — and a fresh one replaced it. Settings
   * says so, because every manual registration just stopped working and
   * nothing else would explain why.
   */
  reset: boolean
}

/** Shorter than this is damage, not a token (`newToken` makes 43 characters). */
const MIN_LENGTH = 32

const writeFile = (path: string, content: string): void => {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.tmp`
  writeFileSync(tmp, content, { encoding: 'utf8', mode: 0o600 })
  // Best-effort owner-only. Windows ignores the mode and relies on the
  // per-user profile ACL — with a keyring, the ciphertext is the boundary.
  try {
    chmodSync(tmp, 0o600)
  } catch {
    /* not fatal */
  }
  renameSync(tmp, path)
}

/** Store a token, encrypted when the keyring is there to do it. Returns it. */
export const writeToken = (dir: string, cipher: SecretCipher, token: string): string => {
  const encrypted = cipher.isEncryptionAvailable()
  const stored: StoredToken = {
    data: encrypted ? cipher.encryptString(token).toString('base64') : token,
    encrypted
  }
  writeFile(tokenPath(dir), JSON.stringify(stored, null, 2) + '\n')
  return token
}

/** What the file held, or null when it held nothing usable. */
const parse = (content: string): StoredToken | null => {
  try {
    const parsed: unknown = JSON.parse(content)
    if (
      parsed &&
      typeof parsed === 'object' &&
      typeof (parsed as StoredToken).data === 'string' &&
      typeof (parsed as StoredToken).encrypted === 'boolean'
    ) {
      return parsed as StoredToken
    }
  } catch {
    // Not this file's format: damage, or a build before the store existed.
  }
  return null
}

/**
 * Read the stored token, minting one when there is none.
 *
 * A plaintext token — written while no keyring was available — is re-stored
 * encrypted as soon as a keyring is, and its value is kept: the user's manual
 * registrations point at it. A token that cannot be decrypted is replaced, and
 * the caller is told (`reset`).
 */
export const loadOrCreateToken = (dir: string, cipher: SecretCipher): TokenLoad => {
  const path = tokenPath(dir)
  let content: string | null = null
  try {
    content = readFileSync(path, 'utf8')
  } catch {
    // Absent: first run, or never started. Mint below.
  }
  if (content === null) return { token: writeToken(dir, cipher, newToken()), reset: false }

  const stored = parse(content)
  if (!stored) return { token: writeToken(dir, cipher, newToken()), reset: true }

  if (!stored.encrypted) {
    if (stored.data.length < MIN_LENGTH)
      return { token: writeToken(dir, cipher, newToken()), reset: true }
    // Upgrade in place when we now can; keep the value either way.
    if (cipher.isEncryptionAvailable()) writeToken(dir, cipher, stored.data)
    return { token: stored.data, reset: false }
  }

  try {
    const token = cipher.decryptString(Buffer.from(stored.data, 'base64'))
    if (token.length >= MIN_LENGTH) return { token, reset: false }
  } catch {
    // The keyring refused, or this is not the keyring that wrote it.
  }
  return { token: writeToken(dir, cipher, newToken()), reset: true }
}
