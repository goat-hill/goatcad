/**
 * Which window answers an agent's design request when more than one is open
 * (split-view-workstream.md §7).
 *
 * The focused window is the default — it is the one the user is looking at. It
 * is the wrong answer in exactly one arrangement, and that arrangement is the
 * point of a second monitor: the agent's terminal in one window and the design
 * in another. The terminal's window has the focus and does not hold the file,
 * so it would write the file on disk underneath the editor that does. A window
 * that HOLDS the document turns the same request into an undoable edit on a
 * visible tab, so it wins.
 *
 * Pure and Electron-free: the bridge supplies what each window has open.
 */

export interface DesignWindowState {
  id: number
  focused: boolean
  projectPath: string | null
  /** Open tab paths, as the window last reported them (`session:update`). */
  tabPaths: string[]
}

const DESIGN_EXTENSIONS = ['.kicad_sch', '.kicad_pcb', '.kicad_sym', '.kicad_mod']

const normalize = (path: string): string => path.replace(/[\\/]+/g, '/').toLowerCase()

const isDesignTab = (path: string): boolean =>
  DESIGN_EXTENSIONS.some((extension) => path.toLowerCase().endsWith(extension))

/** The document a request names, under whichever field its operation uses. */
const namedFile = (request: Record<string, unknown>): string | null => {
  for (const field of ['sheet', 'board', 'footprint', 'library']) {
    const value = request[field]
    if (typeof value === 'string' && value.trim()) return value
  }
  return null
}

/** An agent names a file by path, by a project-relative path, or by bare name. */
const holds = (state: DesignWindowState, named: string): boolean => {
  const wanted = normalize(named)
  return state.tabPaths.some((path) => {
    const open = normalize(path)
    return open === wanted || open.endsWith(`/${wanted}`)
  })
}

/**
 * The id of the window to ask, or null to keep the default (the focused window,
 * else any). Only ever redirects to a window that unambiguously holds the
 * document while the default does not.
 */
export const pickDesignWindow = (
  request: Record<string, unknown>,
  windows: readonly DesignWindowState[]
): number | null => {
  const preferred = windows.find((state) => state.focused) ?? windows[0]
  if (!preferred || windows.length < 2) return null
  const others = windows.filter((state) => state.id !== preferred.id)

  const named = namedFile(request)
  if (named) {
    if (holds(preferred, named)) return null
    const holders = others.filter((state) => holds(state, named))
    return holders.length === 1 ? holders[0].id : null
  }

  // "The design in front", asked of a window with no design in it: the one
  // other window on the same workspace that has one is what was meant.
  if (preferred.tabPaths.some(isDesignTab)) return null
  const beside = others.filter(
    (state) =>
      state.projectPath !== null &&
      state.projectPath === preferred.projectPath &&
      state.tabPaths.some(isDesignTab)
  )
  return beside.length === 1 ? beside[0].id : null
}
