/**
 * Distributor keys for a development run, read from a local file.
 *
 * **Why this exists.** The screenshot/record harness launches the app through
 * Playwright, and in that process `safeStorage.isEncryptionAvailable()` is false
 * — Electron cannot resolve a Linux keyring backend there, so the real stored
 * credentials cannot be decrypted and every search comes back
 * `no-credentials`. That made every credential-dependent surface unverifiable
 * from a harness, which is the one place UI claims are supposed to be checked.
 *
 * **The safety boundary is the packaged flag, not the file.** These credentials
 * are read only when the app is unpackaged, which no shipped build ever is. A
 * release therefore behaves as if this module did not exist, whatever is sitting
 * on disk.
 *
 * The file is `.env` beside `package.json`, gitignored, `KEY=value` per
 * line. It holds the developer's own keys — the same ones they typed into
 * Settings — so this widens no access they did not already have; it only makes
 * them reachable from a process that cannot open the keyring.
 */
import * as fs from 'fs'
import { join } from 'path'
import type { PartsProviderId } from '../preload/partsTypes'
import type { ProviderCredentials } from './partsCredentials'

export const DEV_ENV_FILE = '.env'

/** Which variable fills which provider field. Names are explicit rather than
 *  derived, so grepping for a key finds the field it lands in. */
const DEV_KEYS: Record<PartsProviderId, Record<string, string>> = {
  digikey: {
    clientId: 'GOATCAD_DEV_DIGIKEY_CLIENT_ID',
    clientSecret: 'GOATCAD_DEV_DIGIKEY_CLIENT_SECRET'
  },
  mouser: {
    apiKey: 'GOATCAD_DEV_MOUSER_API_KEY'
  }
}

/**
 * `KEY=value`, one per line. Deliberately not a dotenv dependency: this reads a
 * handful of names in a development-only path, and the format it needs is the
 * subset every such file already uses.
 *
 * `export ` prefixes are tolerated so the same file can be sourced by a shell,
 * and surrounding quotes are stripped because a secret pasted from a portal
 * often arrives wrapped in them.
 */
export const parseEnvFile = (text: string): Record<string, string> => {
  const result: Record<string, string> = {}
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim().replace(/^export\s+/, '')
    if (!line || line.startsWith('#')) continue
    const eq = line.indexOf('=')
    if (eq <= 0) continue
    const key = line.slice(0, eq).trim()
    let value = line.slice(eq + 1).trim()
    if (value.length >= 2 && /^(".*"|'.*')$/s.test(value)) value = value.slice(1, -1)
    if (key) result[key] = value
  }
  return result
}

/**
 * Credentials for one provider, or null when the file names none.
 *
 * A provider counts only when **every** field it declares is present: a DigiKey
 * client id with no secret is not a usable credential, and returning it would
 * turn a missing line in a file into an authentication failure against the API.
 */
export const devCredentialsFor = (
  provider: PartsProviderId,
  env: Record<string, string | undefined>
): ProviderCredentials | null => {
  const fields = DEV_KEYS[provider]
  const result: ProviderCredentials = {}
  for (const [field, name] of Object.entries(fields)) {
    const value = env[name]?.trim()
    if (!value) return null
    result[field] = value
  }
  return result
}

/**
 * Read the dev credential file, or an empty set when it is absent or the app is
 * packaged. Never throws: a malformed file must not stop the app from starting.
 *
 * `dirs` is a list because "the project directory" genuinely differs by how the
 * app was started: `npm run dev` and a packaged build resolve `getAppPath()` to
 * the project, while the screenshot harness launches `out/main/index.js`
 * directly and resolves it somewhere under `out/`. The first directory holding
 * the file wins, so callers pass the plausible ones rather than guessing one.
 */
export const loadDevCredentials = (
  dirs: string[],
  packaged: boolean,
  processEnv: Record<string, string | undefined> = process.env
): Partial<Record<PartsProviderId, ProviderCredentials>> => {
  if (packaged) return {}

  let fromFile: Record<string, string> = {}
  for (const dir of dirs) {
    try {
      fromFile = parseEnvFile(fs.readFileSync(join(dir, DEV_ENV_FILE), 'utf8'))
      break
    } catch {
      // No file here is the normal case; an unreadable one is not worth a
      // launch failure when the only thing lost is a development convenience.
    }
  }

  // The real environment wins, so a one-off run can override the file without
  // editing it.
  const env = { ...fromFile, ...processEnv }
  const result: Partial<Record<PartsProviderId, ProviderCredentials>> = {}
  for (const provider of Object.keys(DEV_KEYS) as PartsProviderId[]) {
    const credentials = devCredentialsFor(provider, env)
    if (credentials) result[provider] = credentials
  }
  return result
}
