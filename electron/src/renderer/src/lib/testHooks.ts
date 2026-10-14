/*
 * Test-hook bridge: a tiny automation surface for the screenshot/record
 * harnesses (and any Playwright driver). It is attached to `window.__goatcad`
 * ONLY when the preload reports the harness flag (GOATCAD_TEST_HOOKS=1), so it
 * is inert — and absent — in a normal user session.
 *
 * Why it exists: canvas editors (PCB/schematic/footprint) render in WebGL, so
 * their elements are not DOM nodes and can't be reached with `page.locator()`.
 * This bridge lets the active editor hand the runner exactly what it needs:
 * project a board point to a screen pixel, and enumerate/locate elements by
 * reference. First slice is PCB footprints; other editors register the same
 * shape as they gain support.
 */

/** A locatable element, with its position in both board and screen space. */
export interface TestElement {
  type: string
  index: number
  ref?: string
  value?: string
  uuid?: string
  layer?: string
  /** Board (KiCad) coordinates of the element's anchor. */
  world: { x: number; y: number }
  /** Client-pixel AABB (the space page.mouse uses), or null if off-screen/unbounded. */
  screenRect: { x: number; y: number; width: number; height: number } | null
  /** Client-pixel center — the point to click. */
  screenCenter: { x: number; y: number } | null
}

/** Query to locate a single element; first matching field wins. */
export interface TestElementQuery {
  uuid?: string
  ref?: string
  type?: string
  index?: number
}

/**
 * What an editor registers so the bridge can serve it. The active editor
 * registers on mount and clears on unmount, so the bridge always reflects the
 * visible view.
 */
export interface TestProvider {
  /** Editor kind, e.g. 'pcb'. */
  kind: string
  /** Project a board (KiCad) point to client pixels. */
  worldToScreen(x: number, y: number): { x: number; y: number } | null
  /** All elements, optionally filtered by type (e.g. 'footprint'). */
  listElements(type?: string): TestElement[]
  /** First element matching the query, or null. */
  getElement(query: TestElementQuery): TestElement | null
}

let active: TestProvider | null = null

/** Editors call this on mount; the returned disposer clears it on unmount. */
export function registerTestProvider(provider: TestProvider): () => void {
  active = provider
  return () => {
    if (active === provider) active = null
  }
}

interface TestBridge {
  /** True once an editor has registered — poll this before querying. */
  ready(): boolean
  kind(): string | null
  worldToScreen(x: number, y: number): { x: number; y: number } | null
  listElements(type?: string): TestElement[]
  getElement(query: TestElementQuery): TestElement | null
}

declare global {
  interface Window {
    __goatcad?: TestBridge
  }
}

/**
 * Attach the bridge to `window.__goatcad`, but only under the harness flag.
 * Called once at renderer startup; a no-op in a normal session.
 */
export function installTestHooks(): void {
  if (!window.api?.testHooks) return
  window.__goatcad = {
    ready: () => active !== null,
    kind: () => active?.kind ?? null,
    worldToScreen: (x, y) => active?.worldToScreen(x, y) ?? null,
    listElements: (type) => active?.listElements(type) ?? [],
    getElement: (query) => active?.getElement(query) ?? null
  }
}
