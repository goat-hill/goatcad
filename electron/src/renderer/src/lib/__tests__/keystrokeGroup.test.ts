import { afterEach, describe, expect, test, vi } from 'vitest'
import { keystrokeGroup, setPointerCanvasGroup } from '../editorWorkspace'

// The suite runs in node: the three things the rule reads off `document` are
// stood up by hand.
const stubDocument = ({
  focused = true,
  active = { tagName: 'BODY', isContentEditable: false },
  modal = false
} = {}): void => {
  vi.stubGlobal('document', {
    hasFocus: () => focused,
    activeElement: active,
    querySelector: () => (modal ? {} : null)
  })
}

afterEach(() => {
  setPointerCanvasGroup(null)
  vi.unstubAllGlobals()
})

describe('keystrokeGroup', () => {
  test('a key goes to the group whose canvas is under the pointer', () => {
    stubDocument()
    setPointerCanvasGroup('group-2')
    expect(keystrokeGroup()).toBe('group-2')
  })

  test('off every canvas, to the focused group', () => {
    stubDocument()
    expect(keystrokeGroup()).toBeNull()
  })

  test('never from a field being typed in, an open dialog or another window', () => {
    setPointerCanvasGroup('group-2')
    stubDocument({ active: { tagName: 'INPUT', isContentEditable: false } })
    expect(keystrokeGroup()).toBeNull()
    stubDocument({ active: { tagName: 'DIV', isContentEditable: true } })
    expect(keystrokeGroup()).toBeNull()
    stubDocument({ modal: true })
    expect(keystrokeGroup()).toBeNull()
    stubDocument({ focused: false })
    expect(keystrokeGroup()).toBeNull()
  })
})
