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
  requestDesign
} from '../partsMcpBridge'

/** Answer the request the bridge just sent, as the renderer would. */
const replyTo = (win: FakeWindow, reply: Record<string, unknown>): void => {
  const last = win.sent[win.sent.length - 1]
  handlers.get('mcp:design-reply')?.({}, { id: last.envelope.id, ...reply })
}

beforeEach(() => {
  handlers.clear()
  focused = null
  all = []
  registerDesignBridge()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('the design bridge', () => {
  it('sends to the focused window and resolves with its payload', async () => {
    const win = makeWindow()
    focused = win
    all = [win]

    const pending = requestDesign({ kind: 'describe-schematic' })
    expect(win.sent[0].channel).toBe('mcp:design-request')
    expect(win.sent[0].envelope.request).toEqual({ kind: 'describe-schematic' })

    replyTo(win, { ok: true, payload: { symbols: [] } })
    await expect(pending).resolves.toEqual({ ok: true, payload: { symbols: [] } })
  })

  it('restores a minimized window before sending, without activating the app', async () => {
    // An edit the user cannot see is an edit they cannot undo, which would make
    // the whole safety argument for agent writes false.
    const win = makeWindow({ minimized: true })
    focused = win
    all = [win]

    const pending = requestDesign({ kind: 'describe-schematic' })
    expect(win.restored).toBe(1)
    expect(win.shown).toBe(0)
    replyTo(win, { ok: true, payload: {} })
    await pending
  })

  it('shows a hidden window without activating it, and leaves a visible one alone', async () => {
    // `show()` activates the app on macOS, which with an agent calling every
    // few seconds is a focus steal from the terminal the person is typing in.
    const hidden = makeWindow({ visible: false })
    focused = hidden
    all = [hidden]
    const first = requestDesign({ kind: 'describe-schematic' })
    expect(hidden.shownInactive).toBe(1)
    expect(hidden.shown).toBe(0)
    replyTo(hidden, { ok: true, payload: {} })
    await first

    const visible = makeWindow()
    focused = visible
    all = [visible]
    const second = requestDesign({ kind: 'describe-schematic' })
    expect(visible.shown + visible.shownInactive + visible.restored).toBe(0)
    replyTo(visible, { ok: true, payload: {} })
    await second
  })

  it('falls back to a background window when none is focused', async () => {
    const win = makeWindow()
    focused = null
    all = [win]
    const pending = requestDesign({ kind: 'describe-schematic' })
    expect(win.sent).toHaveLength(1)
    replyTo(win, { ok: true, payload: {} })
    await pending
  })

  it('skips a destroyed window rather than sending into it', async () => {
    const dead = makeWindow({ destroyed: true })
    const live = makeWindow()
    focused = dead
    all = [dead, live]
    const pending = requestDesign({ kind: 'describe-schematic' })
    expect(dead.sent).toHaveLength(0)
    expect(live.sent).toHaveLength(1)
    replyTo(live, { ok: true, payload: {} })
    await pending
  })

  it('answers no-window when there is nothing to ask', async () => {
    await expect(requestDesign({ kind: 'describe-schematic' })).resolves.toMatchObject({
      ok: false,
      error: 'no-window'
    })
  })

  it('correlates concurrent requests by id rather than by order', async () => {
    const win = makeWindow()
    focused = win
    all = [win]

    const first = requestDesign({ kind: 'describe-schematic' })
    const second = requestDesign({ kind: 'place-symbol', libId: 'Device:R', at: { x: 0, y: 0 } })
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
    focused = win
    all = [win]
    const pending = requestDesign({ kind: 'place-symbol', libId: 'Nope:Nope', at: { x: 0, y: 0 } })
    replyTo(win, { ok: false, error: 'unknown-symbol', detail: 'Nope:Nope' })
    await expect(pending).resolves.toEqual({
      ok: false,
      error: 'unknown-symbol',
      detail: 'Nope:Nope'
    })
  })

  it('ignores a reply for an id it is not holding', async () => {
    const win = makeWindow()
    focused = win
    all = [win]
    const pending = requestDesign({ kind: 'describe-schematic' })
    handlers.get('mcp:design-reply')!({}, { id: 'design-not-mine', ok: true, payload: 'wrong' })
    replyTo(win, { ok: true, payload: 'right' })
    await expect(pending).resolves.toEqual({ ok: true, payload: 'right' })
  })

  it('times out rather than hanging a tool call forever', async () => {
    vi.useFakeTimers()
    const win = makeWindow()
    focused = win
    all = [win]
    const pending = requestDesign({ kind: 'describe-schematic' })
    vi.advanceTimersByTime(DESIGN_TIMEOUT_MS + 1)
    await expect(pending).resolves.toMatchObject({ ok: false, error: 'timeout' })
  })

  it('does not settle twice when a late reply follows a timeout', async () => {
    vi.useFakeTimers()
    const win = makeWindow()
    focused = win
    all = [win]
    const pending = requestDesign({ kind: 'describe-schematic' })
    vi.advanceTimersByTime(DESIGN_TIMEOUT_MS + 1)
    replyTo(win, { ok: true, payload: 'too late' })
    await expect(pending).resolves.toMatchObject({ ok: false, error: 'timeout' })
  })

  it('fails everything in flight when the app closes', async () => {
    const win = makeWindow()
    focused = win
    all = [win]
    const pending = requestDesign({ kind: 'describe-schematic' })
    abortDesignRequests()
    await expect(pending).resolves.toMatchObject({ ok: false, error: 'app-closing' })
  })

  it('keeps one viewport per connection, routed to the window that holds it', async () => {
    const a = makeWindow()
    const b = makeWindow()
    all = [a, b]
    focused = a
    const sentLast = (win: FakeWindow): unknown => win.sent.at(-1)?.envelope.request

    const opening = requestDesign({
      kind: 'open-viewport',
      board: 'x.kicad_pcb',
      label: 'Placing',
      connection: 'conn-a'
    })
    const asked = sentLast(a) as { id: string }
    expect(asked).not.toHaveProperty('connection')
    expect(asked.id).toMatch(/^viewport-\d+$/)
    replyTo(a, { ok: true, payload: { viewport: asked.id } })
    await opening

    // Closing it from another window's focus still reaches the window holding it.
    focused = b
    const closing = requestDesign({ kind: 'close-viewport', viewport: asked.id })
    expect(b.sent).toHaveLength(0)
    expect(sentLast(a)).toEqual({ kind: 'close-viewport', viewport: asked.id })
    replyTo(a, { ok: true, payload: { closed: asked.id } })
    await closing

    // The same connection opening in the focused window moves its one there, same id.
    const moving = requestDesign({
      kind: 'open-viewport',
      sheet: 'y.kicad_sch',
      label: 'Wiring',
      connection: 'conn-a'
    })
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
    const other = requestDesign({
      kind: 'open-viewport',
      board: 'x.kicad_pcb',
      label: 'Routing',
      connection: 'conn-b'
    })
    expect((sentLast(b) as { id: string }).id).not.toBe(asked.id)
    replyTo(b, { ok: true, payload: { viewport: (sentLast(b) as { id: string }).id } })
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
    expect(b.sent).toHaveLength(3)
  })
})
