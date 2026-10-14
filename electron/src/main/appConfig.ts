import * as fs from 'fs'
import { join } from 'path'
import type {
  SelectionFilterConfig,
  SelectionFilterEditor,
  SelectionFilterState
} from '../preload/selectionFilterTypes'
import type { Board3DPresentation, Board3DViewState } from '../preload/board3dTypes'
import type { PcbViewState, TrackClearanceDisplay } from '../preload/pcbViewTypes'
import type { PcbRouterCorner, PcbRouterSettings, PcbRouterState } from '../preload/pcbRouterTypes'
import type { SymbolViewState } from '../preload/symbolViewTypes'
import type { LibraryRecents } from '../preload/libraryRecentTypes'
import type { PartUpdateChoices, PartUpdatePreferences } from '../preload/partUpdateTypes'
import type { SchematicViewState } from '../preload/schematicViewTypes'
import type { DesignHealthViewState } from '../preload/designHealthViewTypes'
import type { AgentKind } from '../preload/terminalTypes'
import type { GpuPowerPreference } from '../preload/gpuTypes'
import type { FootprintNonActiveDisplay, FootprintViewState } from '../preload/footprintViewTypes'
import type {
  PanelLayoutEditor,
  PanelLayoutState,
  PanelSectionState
} from '../preload/panelLayoutTypes'
import type { GridEditorKind, GridPreferencesConfig, GridSettingsState } from '../preload/gridTypes'
import type { RecentEntry } from '../preload/recentTypes'
import type { SavedEditorLayout } from '../preload/editorLayoutTypes'
import type { CameraState2D, TabCameras } from '../preload/cameraTypes'
import type { SavedLayerPreset } from '../preload/layerPresetTypes'
import type {
  BoardSetupPresets,
  SavedSetupProfile,
  SavedStackupPreset
} from '../preload/boardSetupPresetTypes'
import type {
  AutoMode,
  BoardAutomationConfig,
  BoardAutomationState,
  ZoneFillMode
} from '../preload/boardAutomationTypes'

/**
 * Global application configuration.
 *
 * Everything the app persists between runs — settings, recent projects, and the
 * window session — lives in a single `config.json` under the Electron userData
 * directory. Renderers never touch this file (or `localStorage`) directly; the
 * main process owns it and exposes it over the `config:*` IPC channels.
 *
 * The electron-dependent part is only the directory: `ConfigStore` takes it as a
 * constructor argument so the store and the normalizer can be unit-tested.
 */

/**
 * Identity. Changing these moves the userData directory, so keep them in sync
 * with `productName`/`appId` in electron-builder.yml and `APP_NAMES` in bin/reset.
 */
export const APP_NAME = 'GoatCAD'
export const APP_ID = 'com.goatcad.app'

export const CONFIG_FILE = 'config.json'
export const CONFIG_VERSION = 1
/** Capped per kind, so a busy day of file opens cannot push the projects out. */
export const MAX_RECENT_PROJECTS = 10
export const MAX_RECENT_FILES = 15

export interface TabState {
  name: string
  path: string
  /**
   * Where this tab's 2D viewports were left — zoom and pan, per subject.
   * Rationale in `src/preload/cameraTypes.d.ts`.
   */
  cameras?: TabCameras
}

export interface WindowBounds {
  x: number
  y: number
  width: number
  height: number
}

/** One window's restorable state. */
export interface WindowSession {
  projectPath: string | null
  tabs: TabState[]
  activeTabPath: string | null
  bounds?: WindowBounds
  maximized?: boolean
  /**
   * The `.kicad_pro` the user had active. Restored only if still present in the
   * workspace — detection re-runs on open, and this just preserves an explicit
   * pick that detection could not have made on its own (several candidates).
   */
  activeProjectPath?: string | null
  /** The editor split, when the window had one; absent means a single group. */
  editorLayout?: SavedEditorLayout
  /** Windows of one workspace share this number, so a restart restores them as one
   *  (`workspaces.ts`); absent for a workspace's only window. */
  workspace?: number
  /**
   * @deprecated Moved to `AppConfig.panelLayout`, which is global rather than
   * per-window — a panel size is a preference, not window state. Still PARSED
   * so an existing config can be promoted once (`adoptLegacySessionPanelSizes`);
   * nothing writes these any more.
   */
  sidebarWidth?: number
  /** @deprecated See `sidebarWidth`. */
  explorerHeight?: number
}

export type { RecentEntry }

/**
 * What a freshly created window should open with. Built by the main process when
 * the window is created and pulled by its renderer over `window:get-init`.
 */
export interface WindowInit {
  projectPath: string | null
  tabs: TabState[]
  activeTabPath: string | null
  /** Restored renderer-side selection — see WindowSession. */
  activeProjectPath?: string | null
  editorLayout?: SavedEditorLayout
  showWelcome: boolean
}

export const DEFAULT_LOCALE = 'en'

export const THEMES = ['dark', 'light'] as const
export type AppTheme = (typeof THEMES)[number]

export const isAppTheme = (value: unknown): value is AppTheme =>
  typeof value === 'string' && (THEMES as readonly string[]).includes(value)

/**
 * UI languages the app ships. Duplicated by necessity: the main process cannot
 * import the renderer's `i18n.ts`, but it owns the persisted `locale` and has
 * to reject junk from a hand-edited config or a compromised renderer.
 * `src/renderer/src/locales/__tests__` asserts this stays equal to the locales
 * actually registered with vue-i18n, so the two cannot drift silently.
 */
export const SUPPORTED_LOCALES = ['en', 'de', 'zh-CN', 'ja', 'fr', 'es'] as const

export type SupportedLocale = (typeof SUPPORTED_LOCALES)[number]

export const isSupportedLocale = (value: unknown): value is SupportedLocale =>
  typeof value === 'string' && (SUPPORTED_LOCALES as readonly string[]).includes(value)

/**
 * How the standard KiCad libraries are provided (see libraries-workstream.md §1).
 * `auto` (default) adopts a detected local KiCad install on every launch — no
 * manual step, and installing KiCad later is picked up automatically. `downloaded`
 * is the explicit override for machines without KiCad (a version-pinned copy). The
 * mode is the source of truth; the standard rows in the library tables are a cache
 * re-resolved from it at launch, so an install that moves or is uninstalled never
 * leaves stale rows behind.
 */
export type StandardLibraryProvider = 'auto' | 'downloaded'

const isStandardLibraryProvider = (value: unknown): value is StandardLibraryProvider =>
  value === 'auto' || value === 'downloaded'

const isAgentKind = (value: unknown): value is AgentKind => value === 'claude' || value === 'codex'

const isGpuPowerPreference = (value: unknown): value is GpuPowerPreference =>
  value === 'default' || value === 'low-power' || value === 'high-performance'

export interface AppConfig {
  version: number
  /** Show the Welcome tab in windows that open with no tabs. */
  showWelcomeOnStartup: boolean
  /** Whether the footprint-library setup dialog has been dismissed. */
  onboardingCompleted: boolean
  /** Whether the app checks download.goatcad.com for a newer version (main/updater.ts). */
  checkForUpdates: boolean
  /** UI language. One of SUPPORTED_LOCALES. Renderer-writable via config:update. */
  locale: SupportedLocale
  /** Color theme for application chrome and editor canvases. */
  theme: AppTheme
  /** Which GPU the WebGL canvases ask for (`lib/gpuPreference.ts`). */
  gpuPowerPreference: GpuPowerPreference
  /** Linux: Vulkan for compositing and WebGL instead of OpenGL; read once at launch (main/index.ts). */
  useVulkan: boolean
  /** Which agent CLI the activity bar's agent button launches. */
  agent: AgentKind
  /** Where the standard KiCad libraries come from; drives launch re-resolution. */
  standardLibraryProvider: StandardLibraryProvider
  /**
   * Explicit override for `${KICAD*_3DMODEL_DIR}` when that env var is unset and
   * the resolved standard library install has no `3dmodels` dir of its own.
   * Normally left unset — see `kicadLibraries.ts` for the automatic path.
   */
  kicad3dModelDir?: string
  /**
   * Whether a detected KiCad's own global library tables have been imported
   * (`kicadGlobalTables.ts`). The import is a one-time seed rather than a live
   * mirror, so this is what stops it re-adding rows the user removed here.
   */
  kicadGlobalTablesSeeded?: boolean
  /** Projects and files, most-recent-first — see `RecentEntry`. */
  recents: RecentEntry[]
  /** Windows that were open the last time the app closed. */
  session: WindowSession[]
  /**
   * Per-editor selection filter — which item kinds a click may land on.
   * Shape and rationale in `src/preload/selectionFilterTypes.d.ts`.
   */
  selectionFilter: SelectionFilterConfig
  /**
   * What the 3D board view draws — layer and component switches.
   * Shape and rationale in `src/preload/board3dTypes.d.ts`.
   */
  board3dView: Board3DViewState
  /** How the 3D board view presents it: projection, light, background; same file. */
  board3dPresentation: Board3DPresentation
  /**
   * How the 2D board view draws copper — zone fills and sketch modes.
   * Shape and rationale in `src/preload/pcbViewTypes.d.ts`.
   */
  pcbView: PcbViewState
  /**
   * How the board's router meets other copper — the collision mode and blocking.
   * Shape and rationale in `src/preload/pcbRouterTypes.d.ts`.
   */
  pcbRouter: PcbRouterState
  /**
   * Whether the symbol editor draws hidden pins and fields.
   * Shape and rationale in `src/preload/symbolViewTypes.d.ts`.
   */
  symbolView: SymbolViewState
  /**
   * What the schematic editor's canvas shows — the net hover highlight.
   * Shape and rationale in `src/preload/schematicViewTypes.d.ts`.
   */
  schematicView: SchematicViewState
  /**
   * Whether every editor marks its findings on the canvas.
   * Shape and rationale in `src/preload/designHealthViewTypes.d.ts`.
   */
  designHealthView: DesignHealthViewState
  /**
   * What the footprint editor draws — layers, active layer, inactive mode.
   * Shape and rationale in `src/preload/footprintViewTypes.d.ts`.
   */
  footprintView: FootprintViewState
  /**
   * Layer visibility presets the user saved, newest last.
   * Shape and rationale in `src/preload/layerPresetTypes.d.ts`.
   */
  layerPresets: SavedLayerPreset[]
  /**
   * Board Setup's constraint configurations and stackups the user saved.
   * Shape and rationale in `src/preload/boardSetupPresetTypes.d.ts`.
   */
  boardSetupPresets: BoardSetupPresets
  /**
   * Every draggable panel edge and collapsed section in the IDE chrome.
   * Shape and rationale in `src/preload/panelLayoutTypes.d.ts`.
   */
  panelLayout: PanelLayoutState
  /**
   * How each board's zone fill and checks run on their own, by file path.
   * Shape and rationale in `src/preload/boardAutomationTypes.d.ts`.
   */
  boardAutomation: BoardAutomationConfig
  /**
   * Each editor's grid — spacing, unit, visibility, snap.
   * Shape and rationale in `src/preload/gridTypes.d.ts`.
   */
  gridPreferences: GridPreferencesConfig
  /**
   * The library chooser's recent picks.
   * Shape and rationale in `src/preload/libraryRecentTypes.d.ts`.
   */
  libraryRecents: LibraryRecents
  /**
   * The Update / Change sheet's ticks, as last left.
   * Shape and rationale in `src/preload/partUpdateTypes.d.ts`.
   */
  partUpdatePreferences: PartUpdatePreferences
}

export const defaultConfig = (): AppConfig => ({
  version: CONFIG_VERSION,
  showWelcomeOnStartup: true,
  onboardingCompleted: false,
  checkForUpdates: true,
  locale: DEFAULT_LOCALE,
  // Duplicated: DEFAULT_APP_THEME (renderer lib/theme.ts), DEFAULT_GPU_POWER_PREFERENCE
  // (renderer lib/gpuPreference.ts).
  theme: 'dark',
  gpuPowerPreference: 'default',
  useVulkan: false,
  agent: 'claude',
  standardLibraryProvider: 'auto',
  recents: [],
  session: [],
  selectionFilter: {},
  board3dView: defaultBoard3DView(),
  board3dPresentation: defaultBoard3DPresentation(),
  pcbView: defaultPcbView(),
  pcbRouter: defaultPcbRouter(),
  symbolView: defaultSymbolView(),
  schematicView: defaultSchematicView(),
  designHealthView: defaultDesignHealthView(),
  footprintView: defaultFootprintView(),
  layerPresets: [],
  boardSetupPresets: { profiles: [], stackups: [] },
  panelLayout: {},
  boardAutomation: {},
  gridPreferences: {},
  libraryRecents: { symbol: [], power: [], footprint: [] },
  partUpdatePreferences: {}
})

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const asString = (value: unknown): string | null => (typeof value === 'string' ? value : null)

const asBoolean = (value: unknown, fallback: boolean): boolean =>
  typeof value === 'boolean' ? value : fallback

/** A persisted panel dimension: finite, positive, and not absurd. A corrupt or
 *  stale value here would render a panel unusable, so it is dropped instead. */
const asPanelSize = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) && value > 0 && value <= 2000
    ? Math.round(value)
    : undefined

const asFiniteNumber = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null

/** A camera worth restoring: finite, and at a zoom that can show anything. */
const normalizeCamera = (value: unknown): CameraState2D | null => {
  if (!isRecord(value)) return null
  const x = asFiniteNumber(value.x)
  const y = asFiniteNumber(value.y)
  const zoom = asFiniteNumber(value.zoom)
  if (x === null || y === null || zoom === null || zoom <= 0) return null
  return { x, y, zoom }
}

const normalizeCameras = (value: unknown): TabCameras | undefined => {
  if (!isRecord(value)) return undefined
  const cameras: TabCameras = {}
  for (const [key, camera] of Object.entries(value)) {
    const normalized = normalizeCamera(camera)
    if (normalized) cameras[key] = normalized
  }
  return Object.keys(cameras).length > 0 ? cameras : undefined
}

const normalizeTab = (value: unknown): TabState | null => {
  if (!isRecord(value)) return null
  const path = asString(value.path)
  if (!path) return null
  const cameras = normalizeCameras(value.cameras)
  return { name: asString(value.name) ?? path, path, ...(cameras ? { cameras } : {}) }
}

const normalizeBounds = (value: unknown): WindowBounds | undefined => {
  if (!isRecord(value)) return undefined
  const x = asFiniteNumber(value.x)
  const y = asFiniteNumber(value.y)
  const width = asFiniteNumber(value.width)
  const height = asFiniteNumber(value.height)
  if (x === null || y === null || width === null || height === null) return undefined
  if (width <= 0 || height <= 0) return undefined
  return { x, y, width, height }
}

/** A split worth restoring: two or more groups of known tabs. Anything else is
 *  a single group, which is what an absent layout already means. */
const normalizeEditorLayout = (
  value: unknown,
  tabs: readonly TabState[]
): SavedEditorLayout | undefined => {
  if (!isRecord(value) || !Array.isArray(value.groups)) return undefined
  const open = new Set(tabs.map((tab) => tab.path))
  const groups = value.groups
    .filter(isRecord)
    .map((group) => {
      const paths = Array.isArray(group.tabs)
        ? group.tabs.filter((path): path is string => typeof path === 'string' && open.has(path))
        : []
      const active = asString(group.activeTabPath)
      return {
        tabs: paths,
        activeTabPath: active !== null && paths.includes(active) ? active : null
      }
    })
    .filter((group) => group.tabs.length > 0)
  if (groups.length < 2) return undefined
  const focused = asFiniteNumber(value.focusedGroup)
  const ratio = asFiniteNumber(value.ratio)
  return {
    groups,
    focusedGroup: focused !== null && focused >= 0 && focused < groups.length ? focused : 0,
    direction: value.direction === 'column' ? 'column' : 'row',
    // Clamped again by the renderer, which owns the usable range.
    ratio: ratio !== null && ratio > 0 && ratio < 1 ? ratio : 0.5
  }
}

export const normalizeSession = (value: unknown): WindowSession | null => {
  if (!isRecord(value)) return null
  const tabs = Array.isArray(value.tabs)
    ? value.tabs.map(normalizeTab).filter((tab): tab is TabState => tab !== null)
    : []
  const projectPath = asString(value.projectPath)
  const activeTabPath = asString(value.activeTabPath)
  const bounds = normalizeBounds(value.bounds)
  const activeProjectPath = asString(value.activeProjectPath)
  const editorLayout = normalizeEditorLayout(value.editorLayout, tabs)
  const workspace =
    typeof value.workspace === 'number' && Number.isInteger(value.workspace) && value.workspace >= 0
      ? value.workspace
      : undefined
  return {
    projectPath,
    tabs,
    // An active tab that isn't in the list would leave the window blank.
    activeTabPath: tabs.some((tab) => tab.path === activeTabPath) ? activeTabPath : null,
    ...(bounds ? { bounds } : {}),
    ...(asBoolean(value.maximized, false) ? { maximized: true } : {}),
    ...(activeProjectPath ? { activeProjectPath } : {}),
    ...(editorLayout ? { editorLayout } : {}),
    ...(workspace !== undefined ? { workspace } : {})
    // The two legacy panel sizes are deliberately NOT carried through: they are
    // promoted into `panelLayout` once, by `adoptLegacySessionPanelSizes`
    // reading the raw session, and re-emitting them here would keep a second
    // copy alive forever.
  }
}

/** The editors that may appear as keys; anything else in the file is dropped. */
const SELECTION_FILTER_EDITORS: readonly SelectionFilterEditor[] = [
  'pcb',
  'schematic',
  'symbol',
  'footprint'
]

const isSelectionFilterEditor = (value: string): value is SelectionFilterEditor =>
  (SELECTION_FILTER_EDITORS as readonly string[]).includes(value)

/**
 * Coerce one editor's filter. An unreadable entry falls back to "nothing
 * excluded" rather than being dropped, because the dangerous direction here is
 * one-way: a corrupt file must never leave a user unable to select anything,
 * with no clue why.
 */
const normalizeSelectionFilterState = (value: unknown): SelectionFilterState => {
  if (!isRecord(value)) return { excludedKinds: [], allowLocked: true }
  const excludedKinds = Array.isArray(value.excludedKinds)
    ? [...new Set(value.excludedKinds.filter((kind): kind is string => typeof kind === 'string'))]
    : []
  return { excludedKinds, allowLocked: asBoolean(value.allowLocked, true) }
}

/**
 * One-time promotion of the two panel sizes that used to live on each window.
 *
 * `sidebarWidth` and `explorerHeight` were per-window session state before
 * `panelLayout` existed. Reading them here means nobody's sidebar jumps back to
 * the default on the release that moves them, and it costs one pass over a list
 * that is at most a handful of windows long. The first window to save its
 * layout writes the values into `panelLayout` for good; the session copies are
 * then dead and `normalizeSession` stops writing them.
 *
 * The FIRST window carrying a value wins, since the sizes are now global and
 * several windows may disagree — an arbitrary but stable pick, and the
 * alternative (a vote, or the largest) would be arbitrary too and harder to
 * explain.
 */
const adoptLegacySessionPanelSizes = (
  layout: PanelLayoutState,
  rawSession: unknown
): PanelLayoutState => {
  if (!Array.isArray(rawSession)) return layout
  const next = { ...layout }
  for (const window of rawSession) {
    if (!isRecord(window)) continue
    if (next.sidebarWidth === undefined) {
      const width = asPanelSize(window.sidebarWidth)
      if (width) next.sidebarWidth = width
    }
    if (next.explorerHeight === undefined) {
      const height = asPanelSize(window.explorerHeight)
      if (height) next.explorerHeight = height
    }
  }
  return next
}

const GRID_EDITORS: GridEditorKind[] = ['symbol', 'footprint', 'pcb', 'schematic']

/**
 * A grid entry is kept only if it is COMPLETE and sane.
 *
 * Half a grid is worse than none: the renderer merges a stored value over its
 * defaults, so a partial record with a spacing but no unit would reinterpret
 * that number in whatever unit the default happens to use — a 0.25 mm routing
 * grid silently becoming 0.25 mil. Dropping the entry falls back to the
 * editor's own default, which is always a usable grid.
 */
const normalizeGridSettings = (value: unknown): GridSettingsState | null => {
  if (!isRecord(value)) return null
  const spacing = asFiniteNumber(value.spacing)
  if (spacing === null || spacing <= 0) return null
  if (value.unit !== 'mm' && value.unit !== 'mil' && value.unit !== 'in') return null
  return {
    spacing,
    unit: value.unit,
    visible: asBoolean(value.visible, true),
    snap: asBoolean(value.snap, true)
  }
}

export const normalizeGridPreferences = (value: unknown): GridPreferencesConfig => {
  if (!isRecord(value)) return {}
  const result: GridPreferencesConfig = {}
  for (const kind of GRID_EDITORS) {
    const grid = normalizeGridSettings(value[kind])
    if (grid) result[kind] = grid
  }
  return result
}

/** Editors that kept their own right-bar width, in the order the one shared width is taken from. */
/** Boards remembered; past it the oldest are forgotten and fall back to the defaults. */
const BOARD_AUTOMATION_MAX = 200
const AUTO_MODES: readonly AutoMode[] = ['greedy', 'full', 'off']
const isAutoMode = (value: unknown): value is AutoMode => AUTO_MODES.includes(value as AutoMode)
const isZoneFillMode = (value: unknown): value is ZoneFillMode =>
  value === 'full' || value === 'off'

export const normalizeBoardAutomation = (value: unknown): BoardAutomationConfig => {
  if (!isRecord(value)) return {}
  const entries: Array<[string, BoardAutomationState]> = []
  for (const [path, raw] of Object.entries(value)) {
    if (!path || !isRecord(raw)) continue
    const state: BoardAutomationState = {}
    if (isZoneFillMode(raw.zoneFill)) state.zoneFill = raw.zoneFill
    if (isAutoMode(raw.drc)) state.drc = raw.drc
    if (Object.keys(state).length > 0) entries.push([path, state])
  }
  return Object.fromEntries(entries.slice(-BOARD_AUTOMATION_MAX))
}

const PANEL_LAYOUT_EDITORS: PanelLayoutEditor[] = ['pcb', 'schematic', 'symbol', 'footprint']

/**
 * Panel sizes, dropped rather than clamped when they are not sane.
 *
 * A dropped key falls back to the component's own default, which is always a
 * usable size; a clamped one would silently pin a hand-edited or corrupted
 * value to a bound the user never chose. `asPanelSize` already refuses anything
 * outside (0, 2000] — the same guard the sidebar's sizes have always had.
 *
 * Unknown section ids are KEPT. They are a plain string map, a panel removed in
 * one release may come back in the next, and pruning them would mean this
 * function has to know every id in the app.
 */
export const normalizePanelLayout = (value: unknown): PanelLayoutState => {
  if (!isRecord(value)) return {}
  const result: PanelLayoutState = {}
  const sidebarWidth = asPanelSize(value.sidebarWidth)
  if (sidebarWidth) result.sidebarWidth = sidebarWidth
  const explorerHeight = asPanelSize(value.explorerHeight)
  if (explorerHeight) result.explorerHeight = explorerHeight

  const legacy = isRecord(value.editorPanelWidth) ? value.editorPanelWidth : {}
  const railWidth =
    asPanelSize(value.railWidth) ??
    PANEL_LAYOUT_EDITORS.map((editor) => asPanelSize(legacy[editor])).find(Boolean)
  if (railWidth) result.railWidth = railWidth

  if (isRecord(value.sections)) {
    const sections: Record<string, PanelSectionState> = {}
    for (const [id, raw] of Object.entries(value.sections)) {
      if (!isRecord(raw)) continue
      const section: PanelSectionState = {}
      const height = asPanelSize(raw.height)
      if (height) section.height = height
      if (typeof raw.collapsed === 'boolean') section.collapsed = raw.collapsed
      if (typeof raw.pinned === 'boolean') section.pinned = raw.pinned
      if (Object.keys(section).length) sections[id] = section
    }
    if (Object.keys(sections).length) result.sections = sections
  }
  return result
}

/**
 * KiCad's 3D viewer defaults, minus the comment/drawing layers and DNP parts —
 * see the renderer's `defaultBoard3DViewState`, which must agree with this.
 */
export const defaultBoard3DView = (): Board3DViewState => ({
  boardBody: true,
  copper: true,
  solderMask: true,
  solderPaste: true,
  silkscreen: true,
  drawings: false,
  holes: true,
  models: true,
  modelsThroughHole: true,
  modelsSmd: true,
  modelsUnspecified: true,
  modelsDnp: false,
  modelsNotInPosFiles: false,
  axes: false,
  gauge: false
})

export const defaultPcbRouter = (): PcbRouterState => ({ mode: 'walkaround' })

export const defaultPcbView = (): PcbViewState => ({
  zoneFills: true,
  sketchTracks: false,
  sketchVias: false,
  sketchPads: false,
  ratsnest: true,
  boardArea: true,
  fpReferences: true,
  fpValues: true,
  fpText: true,
  padClearance: true,
  trackClearance: 'routing'
})

/** Both on: the editor shows the whole symbol until someone says otherwise. */
export const defaultSymbolView = (): SymbolViewState => ({
  showHiddenPins: true,
  showHiddenFields: true
})

export const defaultDesignHealthView = (): DesignHealthViewState => ({
  showMarkers: false,
  errorsOnly: false
})

export const normalizeDesignHealthView = (value: unknown): DesignHealthViewState => {
  const base = defaultDesignHealthView()
  if (!isRecord(value)) return base
  return {
    showMarkers: asBoolean(value.showMarkers, base.showMarkers),
    errorsOnly: asBoolean(value.errorsOnly, base.errorsOnly)
  }
}

export const defaultSchematicView = (): SchematicViewState => ({
  netHighlight: true,
  showHiddenPins: false,
  showHiddenFields: false
})

/**
 * Every layer a footprint can carry, in the order the editor's panel lists
 * them. Duplicated by necessity in `renderer/src/lib/footprintView.ts` — the
 * main process cannot import the renderer, and it owns the persisted value;
 * `footprintView.test.ts` asserts the two stay equal.
 */
export const FOOTPRINT_LAYERS = [
  'F.Cu',
  'B.Cu',
  'F.SilkS',
  'B.SilkS',
  'F.Mask',
  'B.Mask',
  'F.Paste',
  'B.Paste',
  'F.CrtYd',
  'B.CrtYd',
  'F.Fab',
  'B.Fab'
] as const

const FOOTPRINT_NON_ACTIVE_DISPLAYS: readonly FootprintNonActiveDisplay[] = ['show', 'dim', 'hide']

/**
 * Enough for any working habit; bounded because a hand-edited or runaway config
 * would otherwise fill a dropdown nobody can use.
 */
export const MAX_LAYER_PRESETS = 50

/** Long enough to be descriptive, short enough to read in a narrow panel. */
export const MAX_LAYER_PRESET_NAME = 60

/**
 * Presets are identified by name, so a duplicate is a save that was meant to
 * replace one; the LAST wins, matching what saving over a name does.
 */
export const normalizeLayerPresets = (value: unknown): SavedLayerPreset[] => {
  if (!Array.isArray(value)) return []
  const byName = new Map<string, SavedLayerPreset>()
  for (const entry of value) {
    if (!isRecord(entry) || !isRecord(entry.visibility)) continue
    const name = asString(entry.name)?.trim().slice(0, MAX_LAYER_PRESET_NAME)
    if (!name) continue
    const visibility: Record<string, boolean> = {}
    for (const [layer, on] of Object.entries(entry.visibility)) {
      if (typeof on === 'boolean') visibility[layer] = on
    }
    if (Object.keys(visibility).length === 0) continue
    byName.set(name, { name, visibility })
  }
  return [...byName.values()].slice(-MAX_LAYER_PRESETS)
}

/**
 * By name, the last of a duplicate winning, as layer presets are; an entry
 * without its `user:` id is dropped, and each value is kept only when it is a
 * finite number, a boolean or (a build's names) text.
 */
export const normalizeBoardSetupPresets = (value: unknown): BoardSetupPresets => {
  const source = isRecord(value) ? value : {}
  const named = <T extends { id: string; name: string }>(
    list: unknown,
    read: (entry: Record<string, unknown>) => Omit<T, 'id' | 'name'> | null
  ): T[] => {
    const byName = new Map<string, T>()
    for (const entry of Array.isArray(list) ? list : []) {
      if (!isRecord(entry)) continue
      const id = asString(entry.id)
      const name = asString(entry.name)?.trim().slice(0, MAX_LAYER_PRESET_NAME)
      if (!id?.startsWith('user:') || !name) continue
      const parsed = read(entry)
      if (parsed) byName.set(name, { ...parsed, id, name } as T)
    }
    return [...byName.values()].slice(-MAX_LAYER_PRESETS)
  }
  const values = <V>(record: unknown, keep: (v: unknown) => v is V): Record<string, V> =>
    Object.fromEntries(
      Object.entries(isRecord(record) ? record : {}).filter(([, v]) => keep(v))
    ) as Record<string, V>
  const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
  const profiles = named<SavedSetupProfile>(source.profiles, (entry) => {
    const rules = values(
      entry.rules,
      (v): v is number | boolean => finite(v) || typeof v === 'boolean'
    )
    return Object.keys(rules).length ? { rules, defaults: values(entry.defaults, finite) } : null
  })
  const stackups = named<SavedStackupPreset>(source.stackups, (entry) => {
    const spec = values(entry.spec, (v): v is number | string => finite(v) || typeof v === 'string')
    return Object.keys(spec).length ? { spec } : null
  })
  return { profiles, stackups }
}

/** Everything drawn, silkscreen active: a footprint is small enough to show whole. */
export const defaultFootprintView = (): FootprintViewState => ({
  layerVisibility: Object.fromEntries(FOOTPRINT_LAYERS.map((layer) => [layer, true])),
  activeLayer: 'F.SilkS',
  nonActiveDisplay: 'show',
  sketchPads: false,
  sketchGraphics: false,
  sketchText: false
})

/**
 * The part of a renderer's `config:update` patch that is actually writable.
 *
 * Only SETTINGS cross this way: recents and the window session have their own
 * channels so the main process stays the owner of their invariants. Every
 * accepted key is normalized here rather than trusted, so a malformed patch
 * cannot persist.
 *
 * A key missing from this list is silently dropped and the broadcast that
 * follows carries the OLD value — which a renderer store adopts, so the control
 * the user just changed snaps back. Anything persisted through `config:*` has
 * to be added here as well as to `AppConfig`.
 */
export const writableConfigPatch = (patch: unknown): Partial<AppConfig> => {
  const next: Partial<AppConfig> = {}
  if (!isRecord(patch)) return next
  if (typeof patch.showWelcomeOnStartup === 'boolean') {
    next.showWelcomeOnStartup = patch.showWelcomeOnStartup
  }
  if (typeof patch.onboardingCompleted === 'boolean') {
    next.onboardingCompleted = patch.onboardingCompleted
  }
  if (typeof patch.checkForUpdates === 'boolean') next.checkForUpdates = patch.checkForUpdates
  // Unknown locales are dropped, not stored: the renderer would only fall back
  // to English anyway, and a bad value would persist across restarts.
  if (isSupportedLocale(patch.locale)) next.locale = patch.locale
  if (isAppTheme(patch.theme)) next.theme = patch.theme
  if (isGpuPowerPreference(patch.gpuPowerPreference)) {
    next.gpuPowerPreference = patch.gpuPowerPreference
  }
  if (typeof patch.useVulkan === 'boolean') next.useVulkan = patch.useVulkan
  if (isAgentKind(patch.agent)) next.agent = patch.agent
  // Sent whole rather than per-editor: the renderer holds the entire map and
  // normalizing here keeps a malformed patch from persisting.
  if (patch.selectionFilter !== undefined) {
    next.selectionFilter = normalizeSelectionFilter(patch.selectionFilter)
  }
  if (patch.board3dView !== undefined) next.board3dView = normalizeBoard3DView(patch.board3dView)
  if (patch.board3dPresentation !== undefined) {
    next.board3dPresentation = normalizeBoard3DPresentation(patch.board3dPresentation)
  }
  if (patch.panelLayout !== undefined) next.panelLayout = normalizePanelLayout(patch.panelLayout)
  if (patch.boardAutomation !== undefined) {
    next.boardAutomation = normalizeBoardAutomation(patch.boardAutomation)
  }
  if (patch.gridPreferences !== undefined) {
    next.gridPreferences = normalizeGridPreferences(patch.gridPreferences)
  }
  if (patch.pcbView !== undefined) next.pcbView = normalizePcbView(patch.pcbView)
  if (patch.pcbRouter !== undefined) next.pcbRouter = normalizePcbRouter(patch.pcbRouter)
  if (patch.symbolView !== undefined) next.symbolView = normalizeSymbolView(patch.symbolView)
  if (patch.schematicView !== undefined) {
    next.schematicView = normalizeSchematicView(patch.schematicView)
  }
  if (patch.footprintView !== undefined) {
    next.footprintView = normalizeFootprintView(patch.footprintView)
  }
  if (patch.designHealthView !== undefined) {
    next.designHealthView = normalizeDesignHealthView(patch.designHealthView)
  }
  if (patch.layerPresets !== undefined) {
    next.layerPresets = normalizeLayerPresets(patch.layerPresets)
  }
  if (patch.boardSetupPresets !== undefined) {
    next.boardSetupPresets = normalizeBoardSetupPresets(patch.boardSetupPresets)
  }
  if (patch.libraryRecents !== undefined) {
    next.libraryRecents = normalizeLibraryRecents(patch.libraryRecents)
  }
  if (patch.partUpdatePreferences !== undefined) {
    next.partUpdatePreferences = normalizePartUpdatePreferences(patch.partUpdatePreferences)
  }
  return next
}

/** Ticks by key and field names only, bounded; a malformed kind or verb is dropped. */
export const normalizePartUpdatePreferences = (value: unknown): PartUpdatePreferences => {
  const result: PartUpdatePreferences = {}
  if (!isRecord(value)) return result
  for (const kind of ['symbol', 'footprint'] as const) {
    const verbs = value[kind]
    if (!isRecord(verbs)) continue
    const kept: Partial<Record<'update' | 'change', PartUpdateChoices>> = {}
    for (const verb of ['update', 'change'] as const) {
      const choices = verbs[verb]
      if (!isRecord(choices)) continue
      const options: Record<string, boolean> = {}
      if (isRecord(choices.options)) {
        for (const [key, tick] of Object.entries(choices.options).slice(0, 64)) {
          if (typeof tick === 'boolean' && key.length < 64) options[key] = tick
        }
      }
      const fieldsOn = Array.isArray(choices.fieldsOn)
        ? choices.fieldsOn
            .filter((name): name is string => typeof name === 'string' && name.length < 256)
            .slice(0, 64)
        : []
      kept[verb] = { options, fieldsOn }
    }
    result[kind] = kept
  }
  return result
}

const MAX_LIBRARY_RECENTS = 12

/** Lib ids only, deduplicated and bounded; a malformed kind starts empty. */
export const normalizeLibraryRecents = (value: unknown): LibraryRecents => {
  const list = (raw: unknown): string[] =>
    Array.isArray(raw)
      ? [
          ...new Set(
            raw.filter(
              (id): id is string => typeof id === 'string' && id.length > 0 && id.length < 512
            )
          )
        ].slice(0, MAX_LIBRARY_RECENTS)
      : []
  const record = isRecord(value) ? value : {}
  return {
    symbol: list(record.symbol),
    power: list(record.power),
    footprint: list(record.footprint)
  }
}

/** Per-switch fallback: a partial or hand-edited object keeps its valid keys. */
export const normalizeSymbolView = (value: unknown): SymbolViewState => {
  const base = defaultSymbolView()
  if (!isRecord(value)) return base
  const result = {} as SymbolViewState
  for (const key of Object.keys(base) as Array<keyof SymbolViewState>) {
    result[key] = asBoolean(value[key], base[key])
  }
  return result
}

/** Per-switch fallback: a partial or hand-edited object keeps its valid keys. */
export const normalizeSchematicView = (value: unknown): SchematicViewState => {
  const base = defaultSchematicView()
  if (!isRecord(value)) return base
  return {
    netHighlight: asBoolean(value.netHighlight, base.netHighlight),
    showHiddenPins: asBoolean(value.showHiddenPins, base.showHiddenPins),
    showHiddenFields: asBoolean(value.showHiddenFields, base.showHiddenFields)
  }
}

/**
 * Unknown layer names are dropped rather than kept: the visibility map is keyed
 * by a fixed layer set, and a stale key would outlive every version of it.
 */
export const normalizeFootprintView = (value: unknown): FootprintViewState => {
  const base = defaultFootprintView()
  if (!isRecord(value)) return base
  const visibility = isRecord(value.layerVisibility) ? value.layerVisibility : {}
  const layerVisibility: Record<string, boolean> = {}
  for (const layer of FOOTPRINT_LAYERS) {
    layerVisibility[layer] = asBoolean(visibility[layer], base.layerVisibility[layer])
  }
  const activeLayer = asString(value.activeLayer)
  return {
    layerVisibility,
    activeLayer:
      activeLayer && layerVisibility[activeLayer] !== undefined ? activeLayer : base.activeLayer,
    nonActiveDisplay: FOOTPRINT_NON_ACTIVE_DISPLAYS.includes(
      value.nonActiveDisplay as FootprintNonActiveDisplay
    )
      ? (value.nonActiveDisplay as FootprintNonActiveDisplay)
      : base.nonActiveDisplay,
    sketchPads: asBoolean(value.sketchPads, base.sketchPads),
    sketchGraphics: asBoolean(value.sketchGraphics, base.sketchGraphics),
    sketchText: asBoolean(value.sketchText, base.sketchText)
  }
}

const PCB_ROUTER_MODES: ReadonlyArray<PcbRouterState['mode']> = ['shove', 'walkaround', 'highlight']
const PCB_ROUTER_CORNERS: ReadonlyArray<PcbRouterCorner> = ['45', 'arc45', '90', 'arc90']

/**
 * An unknown mode takes the default. The retired `ignore` mode, and the older
 * `blockViolations: false` with Highlight, are Highlight with violations
 * allowed, KiCad's model of the same thing.
 */
export const normalizePcbRouter = (value: unknown): PcbRouterState => {
  const base = defaultPcbRouter()
  if (!isRecord(value)) return base
  const allowed =
    value.mode === 'ignore' || (value.mode === 'highlight' && value.blockViolations === false)
  const mode = allowed
    ? 'highlight'
    : PCB_ROUTER_MODES.includes(value.mode as PcbRouterState['mode'])
      ? (value.mode as PcbRouterState['mode'])
      : base.mode
  const corner = PCB_ROUTER_CORNERS.includes(value.corner as PcbRouterCorner)
    ? (value.corner as PcbRouterCorner)
    : undefined
  const settings: Partial<PcbRouterSettings> = {}
  if (isRecord(value.settings))
    for (const key of PCB_ROUTER_SETTING_KEYS)
      if (typeof value.settings[key] === 'boolean') settings[key] = value.settings[key]
  if (allowed) settings.allowViolations = true
  return {
    mode,
    ...(corner ? { corner } : {}),
    ...(Object.keys(settings).length > 0 ? { settings } : {})
  }
}

// Duplicated constant: ROUTER_SETTING_DEFAULTS' keys in renderer/src/lib/pcbRouter.ts.
const PCB_ROUTER_SETTING_KEYS: ReadonlyArray<keyof PcbRouterSettings> = [
  'shoveVias',
  'jumpOverObstacles',
  'removeLoops',
  'smartPads',
  'smoothDragged',
  'optimizeDragged',
  'autoPosture',
  'startDiagonal',
  'fixAllSegments',
  'allowViolations',
  'freeAngle'
]

// Duplicated constant: TRACK_CLEARANCE_DISPLAYS in renderer/src/lib/pcbView.ts.
const TRACK_CLEARANCE_DISPLAYS: readonly TrackClearanceDisplay[] = [
  'never',
  'routing',
  'routingAndDragging',
  'always'
]

/** Per-switch fallback: a partial or hand-edited object keeps its valid keys. */
export const normalizePcbView = (value: unknown): PcbViewState => {
  const base = defaultPcbView()
  if (!isRecord(value)) return base
  const trackClearance = value.trackClearance
  return {
    zoneFills: asBoolean(value.zoneFills, base.zoneFills),
    sketchTracks: asBoolean(value.sketchTracks, base.sketchTracks),
    sketchVias: asBoolean(value.sketchVias, base.sketchVias),
    sketchPads: asBoolean(value.sketchPads, base.sketchPads),
    ratsnest: asBoolean(value.ratsnest, base.ratsnest),
    boardArea: asBoolean(value.boardArea, base.boardArea),
    fpReferences: asBoolean(value.fpReferences, base.fpReferences),
    fpValues: asBoolean(value.fpValues, base.fpValues),
    fpText: asBoolean(value.fpText, base.fpText),
    padClearance: asBoolean(value.padClearance, base.padClearance),
    trackClearance: TRACK_CLEARANCE_DISPLAYS.includes(trackClearance as TrackClearanceDisplay)
      ? (trackClearance as TrackClearanceDisplay)
      : base.trackClearance
  }
}

/** Per-switch fallback: a partial or hand-edited object keeps its valid keys. */
export const normalizeBoard3DView = (value: unknown): Board3DViewState => {
  const base = defaultBoard3DView()
  if (!isRecord(value)) return base
  const result = {} as Board3DViewState
  for (const key of Object.keys(base) as Array<keyof Board3DViewState>) {
    result[key] = asBoolean(value[key], base[key])
  }
  return result
}

/** See the renderer's `defaultBoard3DPresentation`, which must agree with this. */
export const defaultBoard3DPresentation = (): Board3DPresentation => ({
  projection: 'perspective',
  lighting: 'studio',
  exposure: 1,
  background: 'theme'
})

/** The renderer's `BOARD3D_EXPOSURE_RANGE` (`lib/board3dView.ts`) holds the same. */
const BOARD3D_EXPOSURE_RANGE = { min: 0.2, max: 4 } as const

/** The choices; the renderer's `BOARD3D_PRESENTATION_CHOICES` (`lib/board3dView.ts`) lists the same. */
const BOARD3D_PRESENTATION_CHOICES: {
  [K in Exclude<keyof Board3DPresentation, 'exposure'>]: ReadonlyArray<Board3DPresentation[K]>
} = {
  projection: ['perspective', 'orthographic'],
  lighting: ['studio', 'soft', 'flat', 'dramatic'],
  background: ['theme', 'transparent', 'white', 'black']
}

/** Per-setting fallback: an unknown value keeps the rest. */
export const normalizeBoard3DPresentation = (value: unknown): Board3DPresentation => {
  const base = defaultBoard3DPresentation()
  if (!isRecord(value)) return base
  const pick = <K extends keyof typeof BOARD3D_PRESENTATION_CHOICES>(
    key: K
  ): Board3DPresentation[K] =>
    (BOARD3D_PRESENTATION_CHOICES[key] as readonly unknown[]).includes(value[key])
      ? (value[key] as Board3DPresentation[K])
      : base[key]
  const exposure = value.exposure
  return {
    projection: pick('projection'),
    lighting: pick('lighting'),
    exposure:
      typeof exposure === 'number' && Number.isFinite(exposure)
        ? Math.min(BOARD3D_EXPOSURE_RANGE.max, Math.max(BOARD3D_EXPOSURE_RANGE.min, exposure))
        : base.exposure,
    background: pick('background')
  }
}

export const normalizeSelectionFilter = (value: unknown): SelectionFilterConfig => {
  if (!isRecord(value)) return {}
  const result: SelectionFilterConfig = {}
  for (const [editor, state] of Object.entries(value)) {
    if (isSelectionFilterEditor(editor)) result[editor] = normalizeSelectionFilterState(state)
  }
  return result
}

/**
 * A tab address with no file behind it (`component://…`, `readonly-lib://…`,
 * `goatcad://welcome`) — the same test `sanitizeSessions` uses. Recents only
 * ever hold real paths: a virtual one can't be reopened as a workspace, and its
 * last segment is an encoded path, not a name.
 */
const isVirtualPath = (path: string): boolean => path.includes('://')

/**
 * Also the migration for the pre-P0.8 `{ name, path }` shape: those were all
 * folder opens, so they become project-kind entries whose project is unknown.
 * The next open re-detects it, which is the same thing a fresh install does.
 */
const normalizeRecent = (value: unknown): RecentEntry | null => {
  if (!isRecord(value)) return null
  const path = asString(value.path)
  if (!path || isVirtualPath(path)) return null
  const kind = value.kind === 'file' ? 'file' : 'project'
  return {
    kind,
    path,
    workspaceRoot: asString(value.workspaceRoot) ?? path,
    projectPath: asString(value.projectPath) ?? null
  }
}

/**
 * Coerce arbitrary JSON into a valid config, falling back to defaults per field.
 * A corrupt or partial file must never crash startup.
 */
export const normalizeConfig = (raw: unknown): AppConfig => {
  const base = defaultConfig()
  if (!isRecord(raw)) return base

  // `recentProjects` is the pre-P0.8 key, when the list held only folders. Read
  // either; only `recents` is written, so a config migrates on its first save.
  const rawRecents = Array.isArray(raw.recents)
    ? raw.recents
    : Array.isArray(raw.recentProjects)
      ? raw.recentProjects
      : null
  const recents = rawRecents
    ? capRecents(
        rawRecents.map(normalizeRecent).filter((item): item is RecentEntry => item !== null)
      )
    : base.recents

  const session = Array.isArray(raw.session)
    ? raw.session.map(normalizeSession).filter((item): item is WindowSession => item !== null)
    : base.session

  const kicad3dModelDir = asString(raw.kicad3dModelDir)

  return {
    version: asFiniteNumber(raw.version) ?? CONFIG_VERSION,
    showWelcomeOnStartup: asBoolean(raw.showWelcomeOnStartup, base.showWelcomeOnStartup),
    onboardingCompleted: asBoolean(raw.onboardingCompleted, base.onboardingCompleted),
    checkForUpdates: asBoolean(raw.checkForUpdates, base.checkForUpdates),
    // An unknown locale (hand-edited config, or one removed since it was
    // written) falls back rather than reaching the renderer.
    locale: isSupportedLocale(raw.locale) ? raw.locale : base.locale,
    theme: isAppTheme(raw.theme) ? raw.theme : base.theme,
    gpuPowerPreference: isGpuPowerPreference(raw.gpuPowerPreference)
      ? raw.gpuPowerPreference
      : base.gpuPowerPreference,
    useVulkan: asBoolean(raw.useVulkan, base.useVulkan),
    agent: isAgentKind(raw.agent) ? raw.agent : base.agent,
    standardLibraryProvider: isStandardLibraryProvider(raw.standardLibraryProvider)
      ? raw.standardLibraryProvider
      : base.standardLibraryProvider,
    ...(kicad3dModelDir ? { kicad3dModelDir } : {}),
    ...(asBoolean(raw.kicadGlobalTablesSeeded, false) ? { kicadGlobalTablesSeeded: true } : {}),
    recents,
    session,
    selectionFilter: normalizeSelectionFilter(raw.selectionFilter),
    // The RAW session, not the normalized one: `normalizeSession` deliberately
    // drops the legacy sizes, so promoting from its output would always find
    // nothing.
    panelLayout: adoptLegacySessionPanelSizes(normalizePanelLayout(raw.panelLayout), raw.session),
    boardAutomation: normalizeBoardAutomation(raw.boardAutomation),
    gridPreferences: normalizeGridPreferences(raw.gridPreferences),
    board3dView: normalizeBoard3DView(raw.board3dView),
    board3dPresentation: normalizeBoard3DPresentation(raw.board3dPresentation),
    pcbView: normalizePcbView(raw.pcbView),
    pcbRouter: normalizePcbRouter(raw.pcbRouter),
    symbolView: normalizeSymbolView(raw.symbolView),
    schematicView: normalizeSchematicView(raw.schematicView),
    designHealthView: normalizeDesignHealthView(raw.designHealthView),
    footprintView: normalizeFootprintView(raw.footprintView),
    layerPresets: normalizeLayerPresets(raw.layerPresets),
    boardSetupPresets: normalizeBoardSetupPresets(raw.boardSetupPresets),
    libraryRecents: normalizeLibraryRecents(raw.libraryRecents),
    partUpdatePreferences: normalizePartUpdatePreferences(raw.partUpdatePreferences)
  }
}

/**
 * Trim each kind to its own cap while leaving the list in one most-recent-first
 * order. Capping the array as a whole would let a run of file opens evict every
 * project, which is exactly what the split is meant to prevent.
 */
const capRecents = (recents: readonly RecentEntry[]): RecentEntry[] => {
  let projects = 0
  let files = 0
  return recents.filter((item) => {
    if (item.kind === 'project') return ++projects <= MAX_RECENT_PROJECTS
    return ++files <= MAX_RECENT_FILES
  })
}

/**
 * Move `entry` to the front, de-duplicated within its kind and capped per kind.
 *
 * Opening a file also **bumps its project**: someone who works in one project
 * all week but reopens it once should still find it at the top, and the project
 * list is meant to read as "what I've been working on," not "what I double-
 * clicked." The bump only reorders an entry that already exists — a file opened
 * in a project we have never recorded does not invent one, since we would be
 * guessing at its workspace root.
 */
export const addRecent = (recents: readonly RecentEntry[], entry: RecentEntry): RecentEntry[] => {
  if (isVirtualPath(entry.path)) return [...recents]
  const rest = recents.filter((item) => !(item.kind === entry.kind && item.path === entry.path))
  if (entry.kind !== 'file' || !entry.projectPath) return capRecents([entry, ...rest])

  const project = rest.find(
    (item) => item.kind === 'project' && item.projectPath === entry.projectPath
  )
  if (!project) return capRecents([entry, ...rest])
  return capRecents([entry, project, ...rest.filter((item) => item !== project)])
}

/**
 * What a window opens with, from a session: its project, tabs and layout, the
 * active tab kept only if it is still one of them, and the Welcome tab when
 * there is nothing else to show (unless the user turned it off). A new window
 * reads it from the session it was created for; a reloaded one — a dev-mode
 * rebuild, View ▸ Reload — from the state it last reported, so a reload comes
 * back as it was rather than as it was created.
 */
export const windowInitFor = (
  session: Partial<WindowSession>,
  showWelcomeOnStartup: boolean
): WindowInit => {
  const tabs = session.tabs ?? []
  const activeTabPath =
    session.activeTabPath && tabs.some((tab) => tab.path === session.activeTabPath)
      ? session.activeTabPath
      : (tabs[0]?.path ?? null)
  return {
    projectPath: session.projectPath ?? null,
    tabs,
    activeTabPath,
    ...(session.activeProjectPath ? { activeProjectPath: session.activeProjectPath } : {}),
    ...(session.editorLayout ? { editorLayout: session.editorLayout } : {}),
    showWelcome: tabs.length === 0 && showWelcomeOnStartup
  }
}

/**
 * Drop anything that no longer exists on disk so a restored window can't come
 * back full of broken tabs. Virtual tabs (`goatcad://welcome`, `design-copy://`,
 * `readonly-lib://`, …) have no filesystem backing and are always kept.
 */
export const sanitizeSessions = (
  sessions: readonly WindowSession[],
  exists: (path: string) => boolean
): WindowSession[] => {
  const result: WindowSession[] = []
  for (const session of sessions) {
    const tabs = session.tabs.filter((tab) => tab.path.includes('://') || exists(tab.path))
    const projectPath =
      session.projectPath && exists(session.projectPath) ? session.projectPath : null
    // A window with neither a project nor tabs has nothing to restore.
    if (!projectPath && tabs.length === 0) continue
    const editorLayout = normalizeEditorLayout(session.editorLayout, tabs)
    result.push({
      ...session,
      // Undefined when the split did not survive, which clears the stale one.
      editorLayout,
      projectPath,
      tabs,
      activeTabPath: tabs.some((tab) => tab.path === session.activeTabPath)
        ? session.activeTabPath
        : (tabs[0]?.path ?? null)
    })
  }
  return result
}

/**
 * Reads `config.json` once on construction and keeps it in memory. Writes are
 * debounced and atomic (temp file + rename) so a crash mid-write can't truncate
 * the config; `flush()` forces a synchronous write before quit.
 */
export class ConfigStore {
  private config: AppConfig
  private writeTimer: NodeJS.Timeout | null = null

  constructor(
    private readonly dir: string,
    private readonly writeDelayMs = 250
  ) {
    this.config = this.read()
  }

  get path(): string {
    return join(this.dir, CONFIG_FILE)
  }

  private read(): AppConfig {
    try {
      return normalizeConfig(JSON.parse(fs.readFileSync(this.path, 'utf8')))
    } catch (err: unknown) {
      // ENOENT on first run is expected; anything else means a damaged file that
      // we intentionally fall back over rather than fail to launch on.
      if (!(isRecord(err) && err.code === 'ENOENT')) {
        console.error('Failed to read config, using defaults:', err)
      }
      return defaultConfig()
    }
  }

  get(): Readonly<AppConfig> {
    return this.config
  }

  update(patch: Partial<AppConfig>): Readonly<AppConfig> {
    this.config = { ...this.config, ...patch }
    this.scheduleWrite()
    return this.config
  }

  private scheduleWrite(): void {
    if (this.writeTimer) clearTimeout(this.writeTimer)
    this.writeTimer = setTimeout(() => this.flush(), this.writeDelayMs)
  }

  flush(): void {
    if (this.writeTimer) {
      clearTimeout(this.writeTimer)
      this.writeTimer = null
    }
    const tmpPath = `${this.path}.tmp`
    try {
      fs.mkdirSync(this.dir, { recursive: true })
      fs.writeFileSync(tmpPath, JSON.stringify(this.config, null, 2), 'utf8')
      fs.renameSync(tmpPath, this.path)
    } catch (err) {
      console.error('Failed to write config:', err)
    }
  }
}
