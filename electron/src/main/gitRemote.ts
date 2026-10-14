/**
 * Push and pull (`git:push`, `git:pull`) — fail fast, never prompt.
 *
 * There is no credential UI: whatever the user's git already has (an SSH
 * agent, a credential helper, a stored token) works, and anything that would
 * prompt fails with a message instead of hanging the child on a password
 * nobody can type. Pull is fast-forward only: a merge conflict inside a
 * `.kicad_sch` is not something to leave someone in by surprise, so diverged
 * history stops and says so.
 */
import type { GitRemoteFailure, GitRemoteResult } from '../preload/gitTypes'
import { runGit, type GitRunResult } from './gitStatus'

/** Network round trips: slower than local commands, but still bounded. */
const REMOTE_TIMEOUT_MS = 120_000

/**
 * The environment for a remote op. `GIT_TERMINAL_PROMPT=0` stops HTTPS
 * prompting; ssh reads its passphrase from the controlling tty, which a GUI
 * launched from a terminal still has, so BatchMode stops that too — unless the
 * user has chosen their own ssh command, which wins.
 */
async function remoteEnv(cwd: string): Promise<NodeJS.ProcessEnv> {
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_TERMINAL_PROMPT: '0' }
  if (!env.GIT_SSH_COMMAND && !env.GIT_SSH) {
    const configured = await runGit(['config', '--get', 'core.sshCommand'], cwd)
    if (!configured.ok || !configured.stdout.trim()) {
      env.GIT_SSH_COMMAND = 'ssh -o BatchMode=yes'
    }
  }
  return env
}

/** Map git's stderr to a failure the UI can explain. Pure; exported for tests. */
export function classifyRemoteError(message: string): GitRemoteFailure {
  const m = message.toLowerCase()
  if (
    /no configured push destination|no such remote|does not appear to be a git repository/.test(m)
  ) {
    return 'no-remote'
  }
  if (/no upstream|no tracking information|has no upstream branch/.test(m)) return 'no-upstream'
  if (
    /authentication failed|permission denied|could not read username|terminal prompts disabled|host key verification failed|403/.test(
      m
    )
  ) {
    return 'auth'
  }
  if (/not possible to fast-forward|diverging branches|divergent branches/.test(m))
    return 'diverged'
  if (/\[rejected\]|non-fast-forward|fetch first|failed to push some refs/.test(m))
    return 'rejected'
  if (
    /could not resolve host|connection timed out|connection refused|unable to access|network is unreachable/.test(
      m
    )
  ) {
    return 'network'
  }
  return 'other'
}

function remoteResult(run: GitRunResult): GitRemoteResult {
  if (run.ok) return { success: true }
  if (run.failure === 'no-git') return { success: false, failure: 'other', error: run.message }
  return { success: false, failure: classifyRemoteError(run.message), error: run.message }
}

/**
 * The remote a first push should publish to: `origin` when it exists, else the
 * only remote. Pure; exported for tests.
 */
export function pickPushRemote(remotes: string[]): string | null {
  if (remotes.includes('origin')) return 'origin'
  return remotes.length === 1 ? remotes[0] : null
}

async function hasUpstream(cwd: string): Promise<boolean> {
  const run = await runGit(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'], cwd)
  return run.ok
}

/**
 * Push the current branch. A branch with no upstream is published to the
 * obvious remote and tracked from then on (`push -u`), which is what someone
 * pressing Push on a new branch means.
 */
export async function pushBranch(projectPath: string): Promise<GitRemoteResult> {
  const env = await remoteEnv(projectPath)
  const options = { timeoutMs: REMOTE_TIMEOUT_MS, env }
  if (await hasUpstream(projectPath))
    return remoteResult(await runGit(['push'], projectPath, options))
  const remotes = await runGit(['remote'], projectPath)
  const names = remotes.ok
    ? remotes.stdout
        .split('\n')
        .map((r) => r.trim())
        .filter(Boolean)
    : []
  const remote = pickPushRemote(names)
  if (!remote) {
    return {
      success: false,
      failure: 'no-remote',
      error: names.length === 0 ? 'No remote configured' : 'Several remotes and none is origin'
    }
  }
  return remoteResult(await runGit(['push', '-u', remote, 'HEAD'], projectPath, options))
}

/** Fetch and fast-forward the current branch; diverged history fails as `diverged`. */
export async function pullBranch(projectPath: string): Promise<GitRemoteResult> {
  if (!(await hasUpstream(projectPath))) {
    const remotes = await runGit(['remote'], projectPath)
    const none = remotes.ok && !remotes.stdout.trim()
    return {
      success: false,
      failure: none ? 'no-remote' : 'no-upstream',
      error: none ? 'No remote configured' : 'The branch has no upstream'
    }
  }
  const env = await remoteEnv(projectPath)
  return remoteResult(
    await runGit(['pull', '--ff-only', '--no-rebase'], projectPath, {
      timeoutMs: REMOTE_TIMEOUT_MS,
      env
    })
  )
}
