/**
 * Distributor API credentials at rest.
 *
 * Three rules, each with a concrete reason:
 *
 * **Its own file, never `config.json`.** The config store is broadcast *whole* to
 * every renderer on every `config:changed` (ARCHITECTURE §3.0), so a secret
 * stored there would be handed to the renderer on a theme change. Non-secret
 * parts preferences still belong in config; only secrets live here.
 *
 * **Encrypted through the OS keyring**, via Electron's `safeStorage`. Injected as
 * a `SecretCipher` rather than imported, so this module is testable and so the
 * "no keyring" path is an explicit branch rather than a surprise.
 *
 * **Never readable by the renderer.** There is no getter on the bridge. The
 * renderer sends secrets one way and reads back only `PartsCredentialStatus`,
 * whose `hint` is a deliberately non-secret fragment (a DigiKey Client ID is an
 * identifier, not a credential). `redactSecrets` exists because the other way a
 * key escapes is a log line or an error message quoting the request.
 */
import * as fs from 'fs'
import { join } from 'path'
import type { PartsCredentialStatus, PartsProviderId } from '../preload/partsTypes'

export const CREDENTIALS_FILE = 'parts-credentials.json'

/** The `safeStorage` surface this needs — injected so tests need no Electron. */
export interface SecretCipher {
  isEncryptionAvailable(): boolean
  encryptString(plain: string): Buffer
  decryptString(cipher: Buffer): string
}

/** One provider's fields, e.g. `{ clientId, clientSecret }` — provider-shaped,
 *  because a Mouser key and a DigiKey pair are not the same kind of thing. */
export type ProviderCredentials = Record<string, string>

interface StoredEntry {
  /** base64 of the ciphertext; the plaintext is a JSON object of the fields. */
  data: string
  /** Whether a real keyring backed the encryption when this was written. */
  encrypted: boolean
  savedAt: number
  lastVerifiedAt: number | null
  /** Non-secret display fragment, stored in the clear on purpose. */
  hint: string | null
}

type StoredFile = Partial<Record<PartsProviderId, StoredEntry>>

const isProviderId = (value: string): value is PartsProviderId =>
  value === 'digikey' || value === 'mouser'

export class PartsCredentialStore {
  private entries: StoredFile = {}

  constructor(
    private readonly dir: string,
    private readonly cipher: SecretCipher,
    /**
     * Development-only keys, from `.env` — see partsDevCredentials.ts.
     * Empty in any packaged build, and empty by default here so a caller that
     * knows nothing about them behaves exactly as before.
     */
    private readonly devCredentials: Partial<Record<PartsProviderId, ProviderCredentials>> = {}
  ) {
    this.entries = this.read()
  }

  get path(): string {
    return join(this.dir, CREDENTIALS_FILE)
  }

  private read(): StoredFile {
    try {
      const raw: unknown = JSON.parse(fs.readFileSync(this.path, 'utf8'))
      if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return {}
      const result: StoredFile = {}
      for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
        if (!isProviderId(key)) continue
        if (typeof value !== 'object' || value === null) continue
        const entry = value as Record<string, unknown>
        if (typeof entry.data !== 'string') continue
        result[key] = {
          data: entry.data,
          encrypted: entry.encrypted === true,
          savedAt: typeof entry.savedAt === 'number' ? entry.savedAt : 0,
          lastVerifiedAt: typeof entry.lastVerifiedAt === 'number' ? entry.lastVerifiedAt : null,
          hint: typeof entry.hint === 'string' ? entry.hint : null
        }
      }
      return result
    } catch (err: unknown) {
      // Missing on first run is the normal case. Anything else means a damaged
      // file: start empty rather than fail, so a bad file costs a re-entry of a
      // key instead of a launch.
      if (!(typeof err === 'object' && err !== null && 'code' in err && err.code === 'ENOENT')) {
        console.error('Failed to read parts credentials; starting empty.')
      }
      return {}
    }
  }

  private write(): void {
    const tmpPath = `${this.path}.tmp`
    try {
      fs.mkdirSync(this.dir, { recursive: true })
      fs.writeFileSync(tmpPath, JSON.stringify(this.entries, null, 2), 'utf8')
      // Best-effort owner-only. Windows ignores the mode and relies on the
      // per-user profile ACL, which is why this is not the security boundary —
      // `safeStorage` is.
      try {
        fs.chmodSync(tmpPath, 0o600)
      } catch {
        /* not fatal — the ciphertext is what protects this, not the mode */
      }
      fs.renameSync(tmpPath, this.path)
    } catch (err) {
      console.error('Failed to write parts credentials:', err instanceof Error ? err.message : err)
    }
  }

  set(provider: PartsProviderId, credentials: ProviderCredentials, hint: string | null): void {
    const encrypted = this.cipher.isEncryptionAvailable()
    this.entries[provider] = {
      data: this.cipher.encryptString(JSON.stringify(credentials)).toString('base64'),
      encrypted,
      savedAt: Date.now(),
      lastVerifiedAt: null,
      hint
    }
    this.write()
  }

  get(provider: PartsProviderId): ProviderCredentials | null {
    const entry = this.entries[provider]
    // A stored key that decrypts always wins; the dev file is the fallback for
    // the process that cannot open a keyring, not an override of a real one.
    if (!entry) return this.devCredentials[provider] ?? null
    try {
      const parsed: unknown = JSON.parse(
        this.cipher.decryptString(Buffer.from(entry.data, 'base64'))
      )
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null
      const result: ProviderCredentials = {}
      for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
        if (typeof value === 'string') result[key] = value
      }
      return result
    } catch {
      // Decryption fails when the keyring changed under us (a restored profile,
      // a new OS user) — or when there is no keyring to reach at all, which is
      // the harness's situation. The stored bytes are unusable either way, so
      // fall back to the dev file if one supplied this provider, and otherwise
      // report "not configured" and let the card ask for the key again. Never
      // throw into a search, and never log the ciphertext.
      return this.devCredentials[provider] ?? null
    }
  }

  remove(provider: PartsProviderId): void {
    delete this.entries[provider]
    this.write()
  }

  markVerified(provider: PartsProviderId): void {
    const entry = this.entries[provider]
    if (!entry) return
    entry.lastVerifiedAt = Date.now()
    this.write()
  }

  status(provider: PartsProviderId): PartsCredentialStatus {
    const entry = this.entries[provider]
    // `get` is what the rest of the app asks, so "configured" has to mean the
    // same thing here — otherwise a dev run shows a setup card over a surface
    // that would search perfectly well.
    const usable = this.get(provider) !== null
    return {
      provider,
      configured: usable,
      hint: entry?.hint ?? null,
      lastVerifiedAt: entry?.lastVerifiedAt ?? null,
      // Report the *live* capability, not what was true when this was written:
      // the question the card is answering is "is my key protected right now".
      encryptionAvailable: this.cipher.isEncryptionAvailable()
    }
  }
}

/**
 * Strip credential values out of text bound for a log or an error detail.
 *
 * A provider error body can echo the request, and a stack trace can carry a URL
 * with an `apiKey` query parameter (Mouser's auth is a query parameter, so this
 * is not hypothetical). Applied at the one place errors are turned into
 * `PartsError.detail`, so no path from a failed request to the renderer carries
 * a key.
 */
export const redactSecrets = (text: string, secrets: readonly string[]): string => {
  let result = text
  for (const secret of secrets) {
    // A short "secret" would match everywhere and redact the whole message.
    if (secret.length < 8) continue
    result = result.split(secret).join('***')
  }
  return result.replace(/([?&](?:apiKey|api_key|access_token|client_secret)=)[^&\s]+/gi, '$1***')
}
