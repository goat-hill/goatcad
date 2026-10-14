import { execFile } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'

/**
 * What a terminal tab is running right now.
 *
 * A terminal names itself after the foreground process of its pty — `claude`,
 * `npm run dev` — and falls back to the shell when nothing but the shell is
 * running. No two platforms answer that question the same way, so each gets its
 * own probe behind `readForeground`, and each splits into a pure parser (tested
 * below in `__tests__`) plus the thinnest read that feeds it:
 *
 *   Linux   `/proc/<pid>/stat`'s `tpgid` names the foreground process group
 *           outright — no subprocess, so a poll costs two small file reads.
 *   macOS   one `ps` listing answers for every session at once; `+` in the STAT
 *           column is the marker for "in the foreground process group".
 *   Windows has no equivalent, and ConPTY's console title is the closest signal
 *           there is. It hangs off the pty object rather than the OS, so
 *           `terminalSessions.ts` supplies it and never calls in here.
 */

/** Shells are the resting state of a terminal, never its "running" process. */
const SHELLS = new Set(['bash', 'zsh', 'sh', 'fish', 'dash', 'ksh', 'tcsh', 'csh'])

/** Wrappers whose own name says nothing; the script or subcommand after them does. */
const RUNNERS = new Set(['npm', 'npx', 'yarn', 'pnpm', 'bun'])
const INTERPRETERS = new Set(['node', 'deno', 'python', 'python3', 'ruby', 'perl'])

const basename = (file: string): string => file.slice(file.lastIndexOf('/') + 1)

/**
 * A command line shortened to what fits a tab: `npm run dev`, `node build.js`,
 * `claude`. Long absolute paths and flag soup are what this exists to drop —
 * the tab has room for a couple of words and the tooltip carries the rest.
 */
export const cleanCommandLine = (cmdline: string): string => {
  const parts = cmdline.trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0) return ''
  const exe = basename(parts[0])

  // `sudo` names the privilege, not the work; the command it wraps is the answer.
  if (exe === 'sudo') {
    const rest = parts.slice(1).findIndex((part) => !part.startsWith('-'))
    return rest === -1 ? exe : cleanCommandLine(parts.slice(1 + rest).join(' '))
  }

  if (RUNNERS.has(exe)) return parts.slice(0, 3).map(basename).join(' ')

  if (INTERPRETERS.has(exe) && parts.length > 1) {
    // Not simply "the first non-flag argument": a flag can take one, and
    // `node -r esm build.js` would then be named after `esm`. A script carries a
    // path separator or an extension, which a flag's value generally does not.
    const script = parts
      .slice(1)
      .find((part) => !part.startsWith('-') && /[/\\]|\.[a-z0-9]+$/i.test(part))
    if (script) return `${exe} ${basename(script)}`
  }

  return exe
}

export interface ProcStat {
  name: string
  ppid: number
  pgrp: number
  /** Foreground process group of the controlling terminal, or -1 when there is none. */
  tpgid: number
}

/**
 * `/proc/<pid>/stat`. The command name is parenthesized and may itself contain
 * spaces and parentheses, so every field is counted from the *last* `)` rather
 * than by splitting the whole line.
 */
export const parseProcStat = (text: string): ProcStat | null => {
  const open = text.indexOf('(')
  const close = text.lastIndexOf(')')
  if (open === -1 || close === -1 || close < open) return null
  const fields = text
    .slice(close + 1)
    .trim()
    .split(/\s+/)
  // Fields after the name are 3..n; ppid, pgrp and tpgid are the 2nd, 3rd and 6th.
  if (fields.length < 6) return null
  const ppid = Number.parseInt(fields[1], 10)
  const pgrp = Number.parseInt(fields[2], 10)
  const tpgid = Number.parseInt(fields[5], 10)
  if (!Number.isFinite(ppid) || !Number.isFinite(pgrp) || !Number.isFinite(tpgid)) return null
  return { name: text.slice(open + 1, close), ppid, pgrp, tpgid }
}

export interface PsRow {
  pid: number
  ppid: number
  /** BSD state letters; a trailing `+` means the process is in the foreground group. */
  stat: string
  args: string
}

/** `ps -Ao pid=,ppid=,stat=,args=` — three numeric-ish columns, then the rest is the command. */
export const parsePsTable = (text: string): PsRow[] => {
  const rows: PsRow[] = []
  for (const line of text.split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/.exec(line)
    if (!match) continue
    rows.push({
      pid: Number.parseInt(match[1], 10),
      ppid: Number.parseInt(match[2], 10),
      stat: match[3],
      args: match[4]
    })
  }
  return rows
}

/**
 * The foreground command running under `shellPid`, or null when only the shell
 * is. Deepest-first, because a foreground `npm run dev` shows up as both the npm
 * process and the node it spawned, and the leaf is the one worth naming.
 */
export const foregroundInTree = (rows: readonly PsRow[], shellPid: number): string | null => {
  const children = new Map<number, PsRow[]>()
  for (const row of rows) {
    const siblings = children.get(row.ppid)
    if (siblings) siblings.push(row)
    else children.set(row.ppid, [row])
  }

  const candidates: { name: string; depth: number }[] = []
  const walk = (pid: number, depth: number): void => {
    for (const child of children.get(pid) ?? []) {
      const name = cleanCommandLine(child.args)
      if (child.stat.includes('+') && name && !SHELLS.has(name)) candidates.push({ name, depth })
      walk(child.pid, depth + 1)
    }
  }
  walk(shellPid, 0)

  return (
    candidates.reduce<{ name: string; depth: number } | null>(
      (best, next) => (!best || next.depth > best.depth ? next : best),
      null
    )?.name ?? null
  )
}

const readLinuxForeground = (pids: readonly number[]): Map<number, string | null> => {
  const result = new Map<number, string | null>()
  for (const pid of pids) {
    result.set(pid, null)
    try {
      const stat = parseProcStat(readFileSync(`/proc/${pid}/stat`, 'utf8'))
      // tpgid === pgrp means the shell itself holds the terminal: nothing is running.
      if (!stat || stat.tpgid <= 0 || stat.tpgid === stat.pgrp) continue
      const cmdlinePath = `/proc/${stat.tpgid}/cmdline`
      if (!existsSync(cmdlinePath)) continue
      // cmdline is NUL-separated, including a trailing NUL.
      const cmdline = readFileSync(cmdlinePath, 'utf8').replace(/\0/g, ' ').trim()
      const name = cleanCommandLine(cmdline)
      if (name && !SHELLS.has(name)) result.set(pid, name)
    } catch {
      // The process exited between the poll and the read; null is the right answer.
    }
  }
  return result
}

const PS_TIMEOUT_MS = 2000

const runPs = (): Promise<string> =>
  new Promise((resolve) => {
    execFile(
      'ps',
      ['-Ao', 'pid=,ppid=,stat=,args='],
      { timeout: PS_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024 },
      (error, stdout) => resolve(error ? '' : stdout)
    )
  })

/**
 * The foreground command of each pty shell, keyed by its pid. A missing or null
 * entry means "only the shell" — the caller titles that tab with the shell name.
 */
export const readForeground = async (
  pids: readonly number[],
  platform: NodeJS.Platform = process.platform
): Promise<Map<number, string | null>> => {
  if (pids.length === 0) return new Map()
  if (platform === 'linux') return readLinuxForeground(pids)
  if (platform === 'darwin') {
    const rows = parsePsTable(await runPs())
    return new Map(pids.map((pid) => [pid, foregroundInTree(rows, pid)]))
  }
  // Windows: terminalSessions.ts answers from ConPTY's title instead.
  return new Map(pids.map((pid) => [pid, null]))
}

/** Whether a reported name counts as "running something" rather than sitting at a prompt. */
export const isShellName = (name: string): boolean => SHELLS.has(basename(name))
