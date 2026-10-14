/**
 * Which window of an agent's workspace answers its design request
 * (`workspaces.ts`).
 *
 * Never the focused one: focus is where the person is looking, and an agent
 * working in another workspace, or in the background, must not follow it. Inside
 * the workspace the window holding the named document answers, so an edit lands
 * as an undoable step on its tab. A document named by its full path that another
 * workspace holds is refused rather than opened a second time.
 *
 * Pure and Electron-free: the bridge supplies what each window has open.
 */
import { isWithin, samePath } from './workspaces'

export interface DesignWindowState {
  id: number
  /** Its `win_…` id, as agents name it. */
  key: string
  /** The workspace the window belongs to. */
  workspace: string
  /** That workspace's folder. */
  root: string | null
  /** Open tab paths, as the window last reported them (`session:update`). */
  tabPaths: string[]
}

export type DesignTarget =
  { window: number } | { refused: string; detail: string; candidates: string[] }

/** The verbs that put a tab in a window, so take `window` when there are several. */
const TAB_KINDS = ['open-file', 'create-file']

const DESIGN_EXTENSIONS = ['.kicad_sch', '.kicad_pcb', '.kicad_sym', '.kicad_mod']

const normalize = (path: string): string => path.replace(/[\\/]+/g, '/').toLowerCase()

const isDesignTab = (path: string): boolean =>
  DESIGN_EXTENSIONS.some((extension) => path.toLowerCase().endsWith(extension))

const isAbsolute = (path: string): boolean => /^([a-z]:)?[\\/]/i.test(path)

/** The document a request names, under whichever field its operation uses. */
export const namedFile = (request: Record<string, unknown>): string | null => {
  for (const field of ['sheet', 'board', 'footprint', 'library', 'file']) {
    const value = request[field]
    if (typeof value === 'string' && value.trim()) return value.trim()
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
 * The window to ask, or a refusal, for a request from a connection attached to
 * `workspace`. Null when the workspace has no live window.
 */
export const pickDesignWindow = (
  request: Record<string, unknown>,
  workspace: string,
  windows: readonly DesignWindowState[]
): DesignTarget | null => {
  const own = windows.filter((state) => state.workspace === workspace)
  const first = own[0]
  if (!first) return null

  const named = namedFile(request)
  // A bare or relative name means this workspace's file; only a full path can be another's.
  if (named && isAbsolute(named)) {
    const ownRoot = first.root
    const elsewhere = windows.find(
      (state) =>
        state.workspace !== workspace &&
        (state.tabPaths.some((path) => samePath(path, named)) ||
          (state.root !== null &&
            isWithin(named, state.root) &&
            !(ownRoot !== null && isWithin(named, ownRoot))))
    )
    if (elsewhere)
      return {
        refused: 'file-in-workspace',
        detail: `${named} is in workspace ${elsewhere.workspace}, not this one.`,
        candidates: [elsewhere.workspace]
      }
  }
  const holder = named ? own.find((state) => holds(state, named)) : undefined
  const asked = typeof request.window === 'string' ? request.window : null
  if (asked !== null) {
    const chosen = own.find((state) => state.key === asked)
    if (!chosen)
      return {
        refused: 'window-not-found',
        detail: `This workspace has no window ${asked}.`,
        candidates: own.map((state) => state.key)
      }
    if (holder && holder !== chosen)
      return {
        refused: 'file-in-window',
        detail: `${named} is open in window ${holder.key}.`,
        candidates: [holder.key]
      }
    return { window: chosen.id }
  }
  if (TAB_KINDS.includes(String(request.kind)) && own.length > 1 && !holder)
    return {
      refused: 'window-required',
      detail: `This workspace has ${own.length} windows.`,
      candidates: own.map((state) => state.key)
    }

  if (named) return { window: (holder ?? first).id }

  // "The project's design", asked of a workspace whose first window has none:
  // the one other window of it that does was meant.
  if (first.tabPaths.some(isDesignTab)) return { window: first.id }
  const beside = own.filter((state) => state.tabPaths.some(isDesignTab))
  return { window: (beside.length === 1 ? beside[0] : first).id }
}
