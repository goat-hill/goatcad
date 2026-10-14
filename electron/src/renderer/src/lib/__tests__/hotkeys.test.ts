import { describe, expect, test } from 'vitest'
import {
  HOTKEYS,
  hotkeyAccelerator,
  hotkeyEventInit,
  hotkeyLabel,
  hotkeyLabels,
  matchesHotkey,
  toolTitle,
  type HotkeyActionId
} from '../hotkeys'

/** Minimal KeyboardEvent stand-in (tests run in the node environment). */
const key = (
  k: string,
  mods: Partial<Pick<KeyboardEvent, 'ctrlKey' | 'metaKey' | 'shiftKey' | 'altKey'>> = {}
): KeyboardEvent =>
  ({
    key: k,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    altKey: false,
    ...mods
  }) as KeyboardEvent

describe('matchesHotkey', () => {
  test('plain letter matches case-insensitively', () => {
    expect(matchesHotkey(key('x'), 'pcb.tool.route')).toBe(true)
    expect(matchesHotkey(key('X', { shiftKey: true }), 'pcb.tool.route')).toBe(false)
    expect(matchesHotkey(key('v'), 'pcb.tool.route')).toBe(false)
  })

  test('plain letter does not fire under Ctrl/Cmd/Alt', () => {
    expect(matchesHotkey(key('w', { ctrlKey: true }), 'schematic.tool.wire')).toBe(false)
    expect(matchesHotkey(key('w', { metaKey: true }), 'schematic.tool.wire')).toBe(false)
    expect(matchesHotkey(key('w', { altKey: true }), 'schematic.tool.wire')).toBe(false)
  })

  test('ctrlOrCmd accepts either modifier', () => {
    expect(matchesHotkey(key('z', { ctrlKey: true }), 'editor.undo')).toBe(true)
    expect(matchesHotkey(key('z', { metaKey: true }), 'editor.undo')).toBe(true)
    expect(matchesHotkey(key('z'), 'editor.undo')).toBe(false)
  })

  test('shift discriminates undo from redo', () => {
    const shiftZ = key('Z', { ctrlKey: true, shiftKey: true })
    expect(matchesHotkey(shiftZ, 'editor.undo')).toBe(false)
    expect(matchesHotkey(shiftZ, 'editor.redo')).toBe(true)
    expect(matchesHotkey(key('y', { ctrlKey: true }), 'editor.redo')).toBe(true)
  })

  test('literal ctrl bindings reject Cmd (macOS app switcher owns Cmd+Tab)', () => {
    expect(matchesHotkey(key('Tab', { ctrlKey: true }), 'app.cycleTabNext')).toBe(true)
    expect(matchesHotkey(key('Tab', { metaKey: true }), 'app.cycleTabNext')).toBe(false)
    expect(matchesHotkey(key('Tab', { ctrlKey: true, shiftKey: true }), 'app.cycleTabNext')).toBe(
      false
    )
    expect(matchesHotkey(key('Tab', { ctrlKey: true, shiftKey: true }), 'app.cycleTabPrev')).toBe(
      true
    )
  })

  test('secondary bindings match too', () => {
    expect(matchesHotkey(key('PageDown', { ctrlKey: true }), 'app.cycleTabNext')).toBe(true)
    expect(matchesHotkey(key('Backspace'), 'editor.delete')).toBe(true)
  })

  test('punctuation ignores Shift (layouts that type it shifted)', () => {
    expect(matchesHotkey(key('/', { shiftKey: true }), 'editor.focusSearch')).toBe(true)
    expect(matchesHotkey(key('/'), 'editor.focusSearch')).toBe(true)
  })

  test('fit view is Home, or Ctrl/Cmd+0 where Home is out of reach', () => {
    expect(matchesHotkey(key('Home'), 'editor.fitView')).toBe(true)
    expect(matchesHotkey(key('Home', { ctrlKey: true }), 'editor.fitView')).toBe(false)
    expect(matchesHotkey(key('0', { ctrlKey: true }), 'editor.fitView')).toBe(true)
    expect(matchesHotkey(key('0', { metaKey: true }), 'editor.fitView')).toBe(true)
    expect(matchesHotkey(key('0'), 'editor.fitView')).toBe(false)
  })
})

describe('git hotkeys', () => {
  test('Ctrl/Cmd+Alt letters drive the remote and staging actions', () => {
    expect(matchesHotkey(key('p', { ctrlKey: true, altKey: true }), 'git.push')).toBe(true)
    expect(matchesHotkey(key('p', { ctrlKey: true }), 'git.push')).toBe(false)
    expect(matchesHotkey(key('u', { metaKey: true, altKey: true }), 'git.pull')).toBe(true)
    expect(matchesHotkey(key('a', { ctrlKey: true, altKey: true }), 'git.stageAll')).toBe(true)
  })

  test('AltGr is typing, never a shortcut', () => {
    const altGr = {
      ...key('p', { ctrlKey: true, altKey: true }),
      getModifierState: (k: string) => k === 'AltGraph'
    } as KeyboardEvent
    expect(matchesHotkey(altGr, 'git.push')).toBe(false)
  })

  test('commit is Ctrl/Cmd+Enter', () => {
    expect(matchesHotkey(key('Enter', { ctrlKey: true }), 'git.commit')).toBe(true)
    expect(matchesHotkey(key('Enter', { metaKey: true }), 'git.commit')).toBe(true)
    expect(matchesHotkey(key('Enter', { ctrlKey: true, shiftKey: true }), 'git.commit')).toBe(false)
  })
})

describe('hotkeyLabel', () => {
  // Node ≥21 exposes `navigator`, so the module's platform detection is live
  // even in the test environment — derive the expected style the same way.
  const mac =
    typeof navigator !== 'undefined' && (navigator.platform ?? '').toUpperCase().includes('MAC')

  test('formats primary bindings', () => {
    expect(hotkeyLabel('pcb.tool.route')).toBe('X')
    expect(hotkeyLabel('schematic.tool.globalLabel')).toBe(mac ? '⌘L' : 'Ctrl+L')
    expect(hotkeyLabel('editor.redo')).toBe(mac ? '⇧⌘Z' : 'Ctrl+Shift+Z')
    expect(hotkeyLabel('editor.cancel')).toBe('Esc')
    expect(hotkeyLabel('editor.fitView')).toBe('Home')
  })

  test('lists every binding, primary first', () => {
    expect(hotkeyLabels('editor.fitView')).toEqual(['Home', mac ? '⌘0' : 'Ctrl+0'])
  })
})

describe('toolTitle', () => {
  const mac =
    typeof navigator !== 'undefined' && (navigator.platform ?? '').toUpperCase().includes('MAC')

  test('names the tool and its primary hotkey', () => {
    expect(toolTitle('Zoom to fit', 'editor.fitView')).toBe('Zoom to fit (Home)')
    expect(toolTitle('Annotate')).toBe('Annotate')
  })

  test('lists every binding when asked', () => {
    expect(toolTitle('Zoom to fit', 'editor.fitView', true)).toBe(
      `Zoom to fit (Home, ${mac ? '⌘0' : 'Ctrl+0'})`
    )
  })
})

describe('registry consistency', () => {
  test('no two actions active in the same editor share a binding', () => {
    // 'app' and 'editor' actions are live in every editor; per-editor scopes
    // only in their own. A binding may appear once per concrete context.
    // A terminal tab is its own context: `app` chrome still applies over it, but
    // no editor does, so `editor` actions are not live there.
    const CONTEXTS: Record<string, string[]> = {
      app: ['schematic', 'pcb', 'footprint', 'symbol', 'terminal', 'git'],
      editor: ['schematic', 'pcb', 'footprint', 'symbol'],
      schematic: ['schematic'],
      pcb: ['pcb'],
      footprint: ['footprint'],
      symbol: ['symbol'],
      terminal: ['terminal'],
      // The commit message box: app keys still reach it, no editor's do.
      git: ['git']
    }
    // Context-dependent by design: mid-wire `/` toggles posture, idle it
    // focuses the insert search. Escape likewise means "abandon the thing in
    // front of me" — a modal when one is open (DESIGN.md §3), the editor's
    // draft otherwise; the modal is literally on top of the editor, so the two
    // never read as competing for the key.
    const ALLOWED_OVERLAPS = new Set([
      'schematic.wirePosture+editor.focusSearch',
      // Same idiom on the board: mid-route `/` flips the elbow posture,
      // idle it focuses search (PcbEditor orders the checks).
      'pcb.routePosture+editor.focusSearch',
      // Backspace mid-route walks the trace back one click; with no trace
      // live it falls through to delete (PcbEditor orders the checks).
      'pcb.unrouteLast+editor.delete',
      // F mid-route finishes the trace; with no trace live it flips the selection.
      'pcb.finishRoute+pcb.flip',
      'app.dismiss+editor.cancel',
      // Enter confirms the modal on top; with none open it finishes the wire or track.
      'app.confirm+schematic.finishWire',
      'app.confirm+pcb.finish'
    ])
    const allowed = (a: string, b: string): boolean =>
      ALLOWED_OVERLAPS.has(`${a}+${b}`) || ALLOWED_OVERLAPS.has(`${b}+${a}`)
    const seen = new Map<string, HotkeyActionId>()
    for (const [action, def] of Object.entries(HOTKEYS)) {
      for (const binding of def.bindings) {
        for (const context of CONTEXTS[def.scope]) {
          const signature = [
            context,
            binding.key,
            !!binding.ctrlOrCmd,
            !!binding.ctrl,
            !!binding.cmd,
            !!binding.shift,
            !!binding.alt
          ].join('|')
          const other = seen.get(signature)
          expect(
            other === undefined || other === action || allowed(action, other),
            `${action} collides with ${other}`
          ).toBe(true)
          seen.set(signature, action as HotkeyActionId)
        }
      }
    }
  })
})

describe('hotkeyAccelerator', () => {
  test('spells the primary binding the way Electron menus expect', () => {
    expect(hotkeyAccelerator('editor.save')).toBe('CmdOrCtrl+S')
    expect(hotkeyAccelerator('app.newWindow')).toBe('CmdOrCtrl+Shift+N')
  })

  test('keeps a literal-Ctrl binding literal — CmdOrCtrl would claim Cmd too', () => {
    expect(hotkeyAccelerator('app.cycleTabNext')).toBe('Control+Tab')
  })

  test('every action produces an accelerator with a key part', () => {
    for (const action of Object.keys(HOTKEYS) as HotkeyActionId[]) {
      expect(hotkeyAccelerator(action).split('+').at(-1)).toBeTruthy()
    }
  })
})

describe('hotkeyEventInit', () => {
  test('round-trips through matchesHotkey, so a replayed menu command matches', () => {
    for (const action of Object.keys(HOTKEYS) as HotkeyActionId[]) {
      const init = hotkeyEventInit(action)
      expect(matchesHotkey({ ...init, key: init.key } as KeyboardEvent, action), action).toBe(true)
    }
  })
})

describe('keymap coherence (DESIGN.md §Keyboard)', () => {
  // Pairs that share a key on purpose: one acts only in a state where the
  // other cannot (a modal is open, a route or wire is in progress).
  const CONTEXTUAL = new Set([
    'app.dismiss|editor.cancel',
    'app.confirm|schematic.finishWire',
    'app.confirm|pcb.finish',
    'editor.delete|pcb.unrouteLast',
    'pcb.finishRoute|pcb.flip',
    'editor.focusSearch|schematic.wirePosture',
    'editor.focusSearch|pcb.routePosture'
  ])
  // Which scopes are live at once: the window's, the shared editor keys, and one editor.
  const live = (a: string, b: string): boolean => {
    if (a === b || a === 'app' || b === 'app') return true
    const editors = ['schematic', 'pcb', 'footprint', 'symbol']
    return (a === 'editor' && editors.includes(b)) || (b === 'editor' && editors.includes(a))
  }
  const chords = (action: HotkeyActionId, mac: boolean): string[] =>
    HOTKEYS[action].bindings.map((b) => {
      const ctrl = b.ctrl || (!mac && b.ctrlOrCmd)
      const meta = b.cmd || (mac && b.ctrlOrCmd)
      return [ctrl && 'ctrl', meta && 'meta', b.alt && 'alt', b.shift && 'shift', b.key]
        .filter(Boolean)
        .join('+')
    })

  test.each([false, true])('no two live actions share a chord (mac: %s)', (mac) => {
    const ids = Object.keys(HOTKEYS) as HotkeyActionId[]
    const clashes: string[] = []
    ids.forEach((a, i) => {
      for (const b of ids.slice(i + 1)) {
        if (!live(HOTKEYS[a].scope, HOTKEYS[b].scope)) continue
        if (CONTEXTUAL.has(`${a}|${b}`) || CONTEXTUAL.has(`${b}|${a}`)) continue
        const shared = chords(a, mac).filter((c) => chords(b, mac).includes(c))
        if (shared.length) clashes.push(`${a} / ${b}: ${shared.join(', ')}`)
      }
    })
    expect(clashes).toEqual([])
  })

  test('a draw tool takes the same Ctrl/Cmd+Shift letter in every editor', () => {
    const letters = new Map<string, string>()
    for (const id of Object.keys(HOTKEYS) as HotkeyActionId[]) {
      const tool = /^(?:schematic|pcb|footprint|symbol)\.tool\.(\w+)$/.exec(id)?.[1]
      if (!tool) continue
      for (const b of HOTKEYS[id].bindings) {
        if (!(b.ctrlOrCmd && b.shift && !b.alt)) continue
        const seen = letters.get(tool)
        expect(seen ?? b.key, `${id} draws ${tool}`).toBe(b.key)
        letters.set(tool, b.key)
      }
    }
    expect(letters.get('line')).toBe('l')
  })
})
