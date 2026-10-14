import { spawn, type IPty } from 'node-pty'
import { readFileSync, readdirSync, existsSync } from 'node:fs'

function cleanCmdline(cmdline: string): string {
  const parts = cmdline.trim().split(/\s+/)
  if (parts.length === 0 || !parts[0]) return ''

  let exe = parts[0]
  const slashIdx = exe.lastIndexOf('/')
  if (slashIdx !== -1) {
    exe = exe.slice(slashIdx + 1)
  }

  const commonInterpreters = [
    'node',
    'python',
    'python3',
    'bash',
    'sh',
    'sudo',
    'npm',
    'npx',
    'yarn',
    'pnpm',
    'bun'
  ]
  if (commonInterpreters.includes(exe.toLowerCase()) && parts.length > 1) {
    if (['npm', 'npx', 'yarn', 'pnpm', 'bun'].includes(exe.toLowerCase())) {
      return parts.slice(0, 3).join(' ')
    }
    let script = ''
    for (let i = 1; i < parts.length; i++) {
      if (!parts[i].startsWith('-')) {
        script = parts[i]
        const sSlash = script.lastIndexOf('/')
        if (sSlash !== -1) {
          script = script.slice(sSlash + 1)
        }
        break
      }
    }
    if (script) {
      return `${exe} ${script}`
    }
  }

  return parts.slice(0, 2).join(' ')
}

function getActiveProcessName(shellPid: number): string | null {
  try {
    const statPath = `/proc/${shellPid}/stat`
    if (!existsSync(statPath)) return null
    const statContent = readFileSync(statPath, 'utf8')
    const lastParen = statContent.lastIndexOf(')')
    if (lastParen === -1) return null
    const after = statContent
      .slice(lastParen + 1)
      .trim()
      .split(/\s+/)

    const pgrp = parseInt(after[2], 10)
    const tpgid = parseInt(after[5], 10)

    if (tpgid && tpgid > 0 && tpgid !== pgrp) {
      const cmdlinePath = `/proc/${tpgid}/cmdline`
      if (existsSync(cmdlinePath)) {
        const cmdline = readFileSync(cmdlinePath, 'utf8').replace(/\0/g, ' ').trim()
        if (cmdline) {
          return cleanCmdline(cmdline)
        }
      }

      const processStatPath = `/proc/${tpgid}/stat`
      if (existsSync(processStatPath)) {
        const pStat = readFileSync(processStatPath, 'utf8')
        const start = pStat.indexOf('(')
        const end = pStat.lastIndexOf(')')
        if (start !== -1 && end !== -1) {
          return pStat.slice(start + 1, end)
        }
      }
    }
  } catch {
    // ignore
  }

  try {
    const pids = readdirSync('/proc')
      .filter((name) => /^\d+$/.test(name))
      .map(Number)

    const parentToChildren = new Map<number, number[]>()
    const pidToName = new Map<number, string>()

    for (const pid of pids) {
      try {
        const statContent = readFileSync(`/proc/${pid}/stat`, 'utf8')
        const lastParen = statContent.lastIndexOf(')')
        const firstParen = statContent.indexOf('(')
        if (lastParen === -1 || firstParen === -1) continue
        const name = statContent.slice(firstParen + 1, lastParen)
        const after = statContent
          .slice(lastParen + 1)
          .trim()
          .split(/\s+/)
        const ppid = parseInt(after[1], 10)

        pidToName.set(pid, name)
        if (!parentToChildren.has(ppid)) {
          parentToChildren.set(ppid, [])
        }
        parentToChildren.get(ppid)!.push(pid)
      } catch {
        // process exited
      }
    }

    const descendants: { pid: number; name: string }[] = []
    function traverse(pid: number): void {
      const children = parentToChildren.get(pid) || []
      for (const child of children) {
        const name = pidToName.get(child) || 'unknown'
        descendants.push({ pid: child, name })
        traverse(child)
      }
    }
    traverse(shellPid)

    const activeDescendants = descendants.filter(
      (d) => !['bash', 'zsh', 'sh', 'fish'].includes(d.name.toLowerCase())
    )

    if (activeDescendants.length > 0) {
      const targetPid = activeDescendants[activeDescendants.length - 1].pid
      const cmdlinePath = `/proc/${targetPid}/cmdline`
      if (existsSync(cmdlinePath)) {
        const cmdline = readFileSync(cmdlinePath, 'utf8').replace(/\0/g, ' ').trim()
        if (cmdline) return cleanCmdline(cmdline)
      }
      return activeDescendants[activeDescendants.length - 1].name
    }
  } catch {
    // ignore
  }

  return null
}

export interface PtySpec {
  file: string
  args: string[]
  cwd: string
  env?: Record<string, string>
}

interface PtyEntry {
  pty: IPty
  buffer: string
  offset: number
  exited: boolean
  /** One-shot output probe; see watchOutput. */
  watcher?: (output: string) => boolean
}

// Tail of output kept per pty so a terminal pane mounted late (or re-mounted) can replay history.
const BUFFER_CAP = 512 * 1024

export class PtyManager {
  private entries = new Map<string, PtyEntry>()
  private nextId = 1

  constructor(private emit: (channel: string, ...args: unknown[]) => void) {}

  start(spec: PtySpec): string {
    const id = `pty-${this.nextId++}`
    const env: Record<string, string> = {}
    for (const [key, value] of Object.entries(process.env)) {
      if (value !== undefined) env[key] = value
    }
    Object.assign(env, spec.env)

    const pty = spawn(spec.file, spec.args, {
      name: 'xterm-256color',
      cols: 80,
      rows: 24,
      cwd: spec.cwd,
      env
    })
    const entry: PtyEntry = { pty, buffer: '', offset: 0, exited: false }
    this.entries.set(id, entry)

    pty.onData((data) => {
      entry.offset += data.length
      entry.buffer = (entry.buffer + data).slice(-BUFFER_CAP)
      // Probe the accumulated tail, not the chunk: a line can split across chunks.
      if (entry.watcher?.(entry.buffer)) entry.watcher = undefined
      this.emit('pty:data', id, data, entry.offset)
    })
    pty.onExit(({ exitCode }) => {
      entry.exited = true
      this.emit('pty:exit', id, exitCode)
    })
    return id
  }

  write(id: string, data: string): void {
    const entry = this.entries.get(id)
    if (entry && !entry.exited) entry.pty.write(data)
  }

  resize(id: string, cols: number, rows: number): void {
    const entry = this.entries.get(id)
    if (entry && !entry.exited && cols > 0 && rows > 0) entry.pty.resize(cols, rows)
  }

  /** Kill the process (if still running) and forget it. */
  dispose(id: string): void {
    const entry = this.entries.get(id)
    if (!entry) return
    if (!entry.exited) entry.pty.kill()
    this.entries.delete(id)
  }

  /**
   * Watch a session's output until `probe` returns true, then stop watching — for
   * reacting to something a process announces (see the web tab's dev-server URL).
   * Dropping the session drops the watcher with it.
   */
  watchOutput(id: string, probe: (output: string) => boolean): void {
    const entry = this.entries.get(id)
    if (entry) entry.watcher = probe
  }

  /** Scrollback tail plus the total-output offset it ends at, for replay-then-stream dedupe. */
  snapshot(id: string): { data: string; offset: number } {
    const entry = this.entries.get(id)
    return entry ? { data: entry.buffer, offset: entry.offset } : { data: '', offset: 0 }
  }

  getProcess(id: string): string | null {
    const entry = this.entries.get(id)
    if (!entry || entry.exited) return null
    return getActiveProcessName(entry.pty.pid)
  }

  disposeAll(): void {
    for (const entry of this.entries.values()) {
      if (!entry.exited) entry.pty.kill()
    }
    this.entries.clear()
  }
}
