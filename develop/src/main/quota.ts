import { app } from 'electron'
import { execFile } from 'node:child_process'
import { readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

// The endpoint behind Claude Code's interactive /usage screen. Undocumented but
// widely used by community statusline tools; degrade gracefully if it changes.
const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage'

// The endpoint rate-limits eager clients, and dev hot-reloads remount the
// renderer constantly — so real fetches are spaced out and everything else is
// served from cache (persisted, so main-process restarts don't refetch either).
const MIN_FETCH_MS = 60_000

let cached: QuotaStatus | null = null
let inflight: Promise<QuotaStatus> | null = null

const cachePath = (): string => join(app.getPath('userData'), 'quota-cache.json')

async function loadCache(): Promise<QuotaStatus | null> {
  try {
    const parsed: unknown = JSON.parse(await readFile(cachePath(), 'utf8'))
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      Array.isArray((parsed as QuotaStatus).windows) &&
      typeof (parsed as QuotaStatus).fetchedAt === 'number'
    ) {
      return parsed as QuotaStatus
    }
  } catch {
    // no cache yet
  }
  return null
}

interface UsageLimit {
  kind?: string
  percent?: number
  severity?: string
  resets_at?: string
  scope?: { model?: { display_name?: string } }
}

/**
 * Where Claude Code keeps its OAuth credentials differs by platform: macOS uses
 * the login Keychain (service "Claude Code-credentials"), while Linux/WSL uses a
 * plaintext ~/.claude/.credentials.json. Read whichever applies and return the
 * raw JSON blob; both hold the same `{ claudeAiOauth: { accessToken } }` shape.
 */
async function readCredentialsJson(): Promise<string> {
  if (process.platform === 'darwin') {
    // `-w` prints just the password (the JSON blob). No file exists on macOS.
    const { stdout } = await execFileAsync('security', [
      'find-generic-password',
      '-s',
      'Claude Code-credentials',
      '-w'
    ])
    return stdout.trim()
  }
  return readFile(join(homedir(), '.claude', '.credentials.json'), 'utf8')
}

/**
 * One real fetch, using the OAuth token Claude Code stores (Keychain on macOS,
 * ~/.claude/.credentials.json elsewhere). We only ever read the token —
 * refreshing it is Claude Code's job; while it is expired we just report an
 * error until the user's next claude session rotates it.
 */
async function fetchQuota(): Promise<QuotaStatus> {
  try {
    const creds: unknown = JSON.parse(await readCredentialsJson())
    const token =
      typeof creds === 'object' && creds !== null
        ? (creds as { claudeAiOauth?: { accessToken?: string } }).claudeAiOauth?.accessToken
        : undefined
    if (!token) throw new Error('no Claude OAuth credentials')

    const response = await fetch(USAGE_URL, {
      headers: {
        Authorization: `Bearer ${token}`,
        'anthropic-beta': 'oauth-2025-04-20',
        'User-Agent': 'goatherd/0.1.0 (claude-code-workstream-manager)'
      }
    })
    if (!response.ok) throw new Error(`usage endpoint: HTTP ${response.status}`)
    const body = (await response.json()) as { limits?: UsageLimit[] }

    const windows: QuotaWindow[] = (body.limits ?? [])
      .filter((limit) => typeof limit.percent === 'number')
      .map((limit) => ({
        kind: limit.kind ?? 'unknown',
        percent: limit.percent ?? 0,
        severity: limit.severity ?? 'normal',
        resetsAt: limit.resets_at ?? '',
        model: limit.scope?.model?.display_name
      }))
    return { windows, fetchedAt: Date.now() }
  } catch (err) {
    return { windows: [], fetchedAt: Date.now(), error: String(err) }
  }
}

/**
 * Cached quota access. Real fetches happen at most every MIN_FETCH_MS (failures
 * count, so a broken endpoint isn't hammered); `force` skips the age check but
 * still coalesces concurrent calls. A failed fetch keeps the last good windows
 * alongside the error.
 */
export async function getQuota(force = false): Promise<QuotaStatus> {
  if (inflight) return inflight
  if (!cached) cached = await loadCache()
  const age = cached ? Date.now() - cached.fetchedAt : Infinity
  if (cached && !force && age < MIN_FETCH_MS) return cached

  inflight = fetchQuota().then(async (status) => {
    inflight = null
    if (status.error && cached?.windows.length) {
      cached = { windows: cached.windows, fetchedAt: status.fetchedAt, error: status.error }
    } else {
      cached = status
      if (!status.error) {
        await writeFile(cachePath(), JSON.stringify(status)).catch(() => {})
      }
    }
    return cached
  })
  return inflight
}
