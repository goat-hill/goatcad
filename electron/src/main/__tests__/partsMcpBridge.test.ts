import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

/** One fake window, standing in for the renderer that answers design requests. */
interface FakeWindow {
  id: number
  destroyed: boolean
  minimized: boolean
  visible: boolean
  shown: number
  shownInactive: number
  restored: number
  sent: Array<{ channel: string; envelope: { id: string; request: unknown } }>
  isDestroyed(): boolean
  isMinimized(): boolean
  isVisible(): boolean
  show(): void
  showInactive(): void
  restore(): void
  webContents: { send(channel: string, envelope: { id: string; request: unknown }): void }
}

let windowCount = 0

const makeWindow = (overrides: Partial<FakeWindow> = {}): FakeWindow => {
  const win: FakeWindow = {
    id: ++windowCount,
    destroyed: false,
    minimized: false,
    visible: true,
    shown: 0,
    shownInactive: 0,
    restored: 0,
    sent: [],
    isDestroyed: () => win.destroyed,
    isMinimized: () => win.minimized,
    isVisible: () => win.visible,
    show: () => {
      win.shown += 1
    },
    showInactive: () => {
      win.shownInactive += 1
    },
    restore: () => {
      win.restored += 1
    },
    webContents: {
      send: (channel, envelope) => {
        win.sent.push({ channel, envelope })
      }
    },
    ...overrides
  }
  return win
}

let focused: FakeWindow | null = null
let all: FakeWindow[] = []
const handlers = new Map<string, (event: unknown, payload: unknown) => void>()

vi.mock('electron', () => ({
  BrowserWindow: {
    getFocusedWindow: () => focused,
    getAllWindows: () => all,
    fromId: (id: number) => all.find((win) => win.id === id) ?? null
  },
  ipcMain: {
    on: (channel: string, handler: (event: unknown, payload: unknown) => void) => {
      handlers.set(channel, handler)
    }
  }
}))

import {
  abortDesignRequests,
  DESIGN_TIMEOUT_MS,
  endAgentConnection,
  registerDesignBridge,
  requestDesign,
  setDesignWindowSource
} from '../partsMcpBridge'
import { workspaces } from '../workspaces'
import type { Caller } from '../ops/context'

/** Answer the request the bridge just sent, as the renderer would. */
const replyTo = (win: FakeWindow, reply: Record<string, unknown>): void => {
  const last = win.sent[win.sent.length - 1]
  handlers.get('mcp:design-reply')?.({}, { id: last.envelope.id, ...reply })
}

let connections = 0

/** One workspace over these windows, and a caller naming it. */
const inWorkspace = (
  windows: FakeWindow[],
  options: { hidden?: boolean; root?: string } = {}
): Caller & { workspace: string } => {
  const [first, ...rest] = windows
  const workspace = workspaces.create({
    root: options.root ?? null,
    project: null,
    window: first.id,
    hidden: options.hidden
  })
  for (const win of rest) workspaces.join(workspace.id, win.id)
  return { connection: `conn-${++connections}`, workspace: workspace.id }
}

beforeEach(() => {
  // The app's one registry: each test starts with nothing open.
  for (const open of workspaces.all())
    for (const window of [...open.windows]) workspaces.leave(window)
  handlers.clear()
  focused = null
  all = []
  setDesignWindowSource(() => [])
  registerDesignBridge()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('the design bridge', () => {
  it('sends to the window of the attached workspace and resolves with its payload', async () => {
    const win = makeWindow()
    all = [win]
    const caller = inWorkspace([win])

    const pending = requestDesign({ kind: 'describe-schematic' }, caller)
    expect(win.sent[0].channel).toBe('mcp:design-request')
    expect(win.sent[0].envelope.request).toEqual({ kind: 'describe-schematic' })

    replyTo(win, { ok: true, payload: { symbols: [] } })
    await expect(pending).resolves.toEqual({ ok: true, payload: { symbols: [] } })
  })

  it('restores a minimized window before sending, without activating the app', async () => {
    // An edit the user cannot see is an edit they cannot undo, which would make
    // the whole safety argument for agent writes false.
    const win = makeWindow({ minimized: true })
    all = [win]

    const pending = requestDesign({ kind: 'describe-schematic' }, inWorkspace([win]))
    expect(win.restored).toBe(1)
    expect(win.shown).toBe(0)
    replyTo(win, { ok: true, payload: {} })
    await pending
  })

  it('shows a hidden window without activating it, and leaves a visible one alone', async () => {
    // `show()` activates the app on macOS, which with an agent calling every
    // few seconds is a focus steal from the terminal the person is typing in.
    const hidden = makeWindow({ visible: false })
    all = [hidden]
    const first = requestDesign({ kind: 'describe-schematic' }, inWorkspace([hidden]))
    expect(hidden.shownInactive).toBe(1)
    expect(hidden.shown).toBe(0)
    replyTo(hidden, { ok: true, payload: {} })
    await first

    const visible = makeWindow()
    all = [visible]
    const second = requestDesign({ kind: 'describe-schematic' }, inWorkspace([visible]))
    expect(visible.shown + visible.shownInactive + visible.restored).toBe(0)
    replyTo(visible, { ok: true, payload: {} })
    await second
  })

  it('never follows focus into another workspace', async () => {
    const theirs = makeWindow()
    const mine = makeWindow()
    all = [theirs, mine]
    inWorkspace([theirs])
    focused = theirs
    const pending = requestDesign({ kind: 'describe-schematic' }, inWorkspace([mine]))
    expect(theirs.sent).toHaveLength(0)
    expect(mine.sent).toHaveLength(1)
    replyTo(mine, { ok: true, payload: {} })
    await pending
  })

  it('keeps a workspace with no window unseen', async () => {
    const unseen = makeWindow({ visible: false })
    all = [unseen]
    const pending = requestDesign(
      { kind: 'describe-schematic' },
      inWorkspace([unseen], { hidden: true })
    )
    expect(unseen.shown + unseen.shownInactive + unseen.restored).toBe(0)
    expect(unseen.sent).toHaveLength(1)
    replyTo(unseen, { ok: true, payload: {} })
    await pending
  })

  it('refuses a file another workspace holds, naming it', async () => {
    const theirs = makeWindow()
    const mine = makeWindow()
    all = [theirs, mine]
    const other = inWorkspace([theirs], { root: '/q' })
    const caller = inWorkspace([mine], { root: '/p' })
    setDesignWindowSource(() => [
      { id: theirs.id, key: 'win_a', workspace: other.workspace, root: '/q', tabPaths: [] },
      { id: mine.id, key: 'win_b', workspace: caller.workspace, root: '/p', tabPaths: [] }
    ])
    await expect(
      requestDesign({ kind: 'describe-schematic', sheet: '/q/main.kicad_sch' }, caller)
    ).resolves.toMatchObject({
      ok: false,
      error: 'file-in-workspace',
      candidates: [other.workspace]
    })
    expect(theirs.sent).toHaveLength(0)
  })

  it('names the workspace it acts in on each call when the client has no connection', async () => {
    const win = makeWindow()
    all = [win]
    const { workspace } = inWorkspace([win])
    const pending = requestDesign({ kind: 'describe-schematic' }, { workspace })
    expect(win.sent).toHaveLength(1)
    replyTo(win, { ok: true, payload: {} })
    await pending
  })

  it('skips a destroyed window rather than sending into it', async () => {
    const dead = makeWindow({ destroyed: true })
    const live = makeWindow()
    all = [dead, live]
    const pending = requestDesign({ kind: 'describe-schematic' }, inWorkspace([dead, live]))
    expect(dead.sent).toHaveLength(0)
    expect(live.sent).toHaveLength(1)
    replyTo(live, { ok: true, payload: {} })
    await pending
  })

  it('acts in the only workspace open when a call names none', async () => {
    const win = makeWindow()
    all = [win]
    inWorkspace([win])
    const pending = requestDesign({ kind: 'describe-schematic' }, { connection: 'any' })
    expect(win.sent).toHaveLength(1)
    replyTo(win, { ok: true, payload: {} })
    await pending
  })

  it('refuses a call naming none when several are open, listing them', async () => {
    const a = makeWindow()
    const b = makeWindow()
    all = [a, b]
    const first = inWorkspace([a])
    const second = inWorkspace([b])
    const answer = await requestDesign({ kind: 'describe-schematic' }, { connection: 'any' })
    expect(answer).toMatchObject({
      ok: false,
      error: 'workspace-required',
      candidates: [first.workspace, second.workspace]
    })
    expect(a.sent.length + b.sent.length).toBe(0)
    await expect(
      requestDesign({ kind: 'describe-schematic' }, { workspace: 'ws_gone' })
    ).resolves.toMatchObject({ ok: false, error: 'workspace-not-found' })
  })

  it('answers no-window when the workspace has no live window', async () => {
    const win = makeWindow({ destroyed: true })
    all = [win]
    await expect(
      requestDesign({ kind: 'describe-schematic' }, inWorkspace([win]))
    ).resolves.toMatchObject({ ok: false, error: 'no-window' })
  })

  it('correlates concurrent requests by id rather than by order', async () => {
    const win = makeWindow()
    all = [win]
    const caller = inWorkspace([win])

    const first = requestDesign({ kind: 'describe-schematic' }, caller)
    const second = requestDesign(
      { kind: 'place-symbol', libId: 'Device:R', at: { x: 0, y: 0 } },
      caller
    )
    expect(win.sent).toHaveLength(2)
    expect(win.sent[0].envelope.id).not.toBe(win.sent[1].envelope.id)

    // Reply out of order; each promise must still get its own answer.
    const reply = handlers.get('mcp:design-reply')!
    reply({}, { id: win.sent[1].envelope.id, ok: true, payload: 'second' })
    reply({}, { id: win.sent[0].envelope.id, ok: true, payload: 'first' })

    await expect(first).resolves.toEqual({ ok: true, payload: 'first' })
    await expect(second).resolves.toEqual({ ok: true, payload: 'second' })
  })

  it('passes a refusal through as a typed error', async () => {
    const win = makeWindow()
    all = [win]
    const caller = inWorkspace([win])
    const pending = requestDesign(
      { kind: 'place-symbol', libId: 'Nope:Nope', at: { x: 0, y: 0 } },
      caller
    )
    replyTo(win, { ok: false, error: 'unknown-symbol', detail: 'Nope:Nope' })
    await expect(pending).resolves.toEqual({
      ok: false,
      error: 'unknown-symbol',
      detail: 'Nope:Nope'
    })
  })

  it('ignores a reply for an id it is not holding', async () => {
    const win = makeWindow()
    all = [win]
    const caller = inWorkspace([win])
    const pending = requestDesign({ kind: 'describe-schematic' }, caller)
    handlers.get('mcp:design-reply')!({}, { id: 'design-not-mine', ok: true, payload: 'wrong' })
    replyTo(win, { ok: true, payload: 'right' })
    await expect(pending).resolves.toEqual({ ok: true, payload: 'right' })
  })

  it('times out rather than hanging a tool call forever', async () => {
    vi.useFakeTimers()
    const win = makeWindow()
    all = [win]
    const caller = inWorkspace([win])
    const pending = requestDesign({ kind: 'describe-schematic' }, caller)
    vi.advanceTimersByTime(DESIGN_TIMEOUT_MS + 1)
    await expect(pending).resolves.toMatchObject({ ok: false, error: 'timeout' })
  })

  it('does not settle twice when a late reply follows a timeout', async () => {
    vi.useFakeTimers()
    const win = makeWindow()
    all = [win]
    const caller = inWorkspace([win])
    const pending = requestDesign({ kind: 'describe-schematic' }, caller)
    vi.advanceTimersByTime(DESIGN_TIMEOUT_MS + 1)
    replyTo(win, { ok: true, payload: 'too late' })
    await expect(pending).resolves.toMatchObject({ ok: false, error: 'timeout' })
  })

  it('fails everything in flight when the app closes', async () => {
    const win = makeWindow()
    all = [win]
    const caller = inWorkspace([win])
    const pending = requestDesign({ kind: 'describe-schematic' }, caller)
    abortDesignRequests()
    await expect(pending).resolves.toMatchObject({ ok: false, error: 'app-closing' })
  })

  it('keeps one viewport per connection, routed to the window that holds it', async () => {
    const a = makeWindow()
    const b = makeWindow()
    all = [a, b]
    const { workspace } = inWorkspace([a, b])
    setDesignWindowSource(() => [
      { id: a.id, key: 'win_a', workspace, root: null, tabPaths: ['/p/x.kicad_pcb'] },
      { id: b.id, key: 'win_b', workspace, root: null, tabPaths: ['/p/y.kicad_sch'] }
    ])
    const sentLast = (win: FakeWindow): unknown => win.sent.at(-1)?.envelope.request

    const opening = requestDesign(
      {
        kind: 'open-viewport',
        board: 'x.kicad_pcb',
        label: 'Placing',
        connection: 'conn-a'
      },
      { connection: 'conn-a' }
    )
    const asked = sentLast(a) as { id: string }
    expect(asked).not.toHaveProperty('connection')
    expect(asked.id).toMatch(/^viewport-\d+$/)
    replyTo(a, { ok: true, payload: { viewport: asked.id } })
    await opening

    // Closing it reaches the window holding it.
    const closing = requestDesign(
      { kind: 'close-viewport', viewport: asked.id },
      { connection: 'conn-a' }
    )
    expect(b.sent).toHaveLength(0)
    expect(sentLast(a)).toEqual({ kind: 'close-viewport', viewport: asked.id })
    replyTo(a, { ok: true, payload: { closed: asked.id } })
    await closing

    // The same connection opening on a document of the other window moves its one there, same id.
    const moving = requestDesign(
      {
        kind: 'open-viewport',
        sheet: 'y.kicad_sch',
        label: 'Wiring',
        connection: 'conn-a'
      },
      { connection: 'conn-a' }
    )
    expect(sentLast(a)).toEqual({
      kind: 'close-viewport',
      viewport: asked.id,
      reason: 'viewport_open moved it to another window.'
    })
    replyTo(a, { ok: true, payload: { closed: asked.id } })
    await new Promise((done) => setTimeout(done, 0))
    expect(sentLast(b)).toEqual({
      kind: 'open-viewport',
      sheet: 'y.kicad_sch',
      label: 'Wiring',
      id: asked.id
    })
    replyTo(b, { ok: true, payload: { viewport: asked.id } })
    await moving

    // Another connection gets its own id.
    const other = requestDesign(
      {
        kind: 'open-viewport',
        board: 'x.kicad_pcb',
        label: 'Routing',
        connection: 'conn-b'
      },
      { connection: 'conn-b' }
    )
    expect((sentLast(a) as { id: string }).id).not.toBe(asked.id)
    replyTo(a, { ok: true, payload: { viewport: (sentLast(a) as { id: string }).id } })
    await other

    // The connection ending closes its viewport where it is.
    endAgentConnection('conn-a')
    expect(sentLast(b)).toEqual({
      kind: 'close-viewport',
      viewport: asked.id,
      reason: 'Its client disconnected.'
    })
    replyTo(b, { ok: true, payload: {} })
    endAgentConnection('conn-a')
    expect(b.sent).toHaveLength(2)
  })
})
