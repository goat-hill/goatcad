import { describe, test, expect, afterEach } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import { join } from 'path'
import {
  ConfigStore,
  addRecent,
  defaultBoard3DPresentation,
  defaultBoard3DView,
  defaultConfig,
  normalizeBoard3DPresentation,
  normalizeBoard3DView,
  normalizeConfig,
  normalizeSelectionFilter,
  normalizeBoardAutomation,
  normalizePanelLayout,
  normalizeGridPreferences,
  sanitizeSessions,
  windowInitFor,
  MAX_RECENT_PROJECTS,
  MAX_RECENT_FILES,
  type RecentEntry,
  type WindowSession,
  normalizeSession,
  defaultSymbolView,
  normalizeSymbolView,
  normalizePcbRouter,
  defaultPcbRouter,
  defaultSchematicView,
  normalizeSchematicView,
  normalizeDesignHealthView,
  writableConfigPatch,
  normalizePartUpdatePreferences
} from '../appConfig'

const tmpDirs: string[] = []

const makeTmpDir = (): string => {
  const dir = fs.mkdtempSync(join(os.tmpdir(), 'goatcad-config-'))
  tmpDirs.push(dir)
  return dir
}

afterEach(() => {
  while (tmpDirs.length) {
    const dir = tmpDirs.pop()
    if (dir) fs.rmSync(dir, { recursive: true, force: true })
  }
})

const session = (overrides: Partial<WindowSession> = {}): WindowSession => ({
  projectPath: '/proj',
  tabs: [{ name: 'a.kicad_sch', path: '/proj/a.kicad_sch' }],
  activeTabPath: '/proj/a.kicad_sch',
  ...overrides
})

describe('normalizeConfig', () => {
  test('returns defaults for non-objects', () => {
    expect(normalizeConfig(null)).toEqual(defaultConfig())
    expect(normalizeConfig('nonsense')).toEqual(defaultConfig())
    expect(normalizeConfig([])).toEqual(defaultConfig())
  })

  test('keeps valid fields and defaults the rest', () => {
    const config = normalizeConfig({ showWelcomeOnStartup: false })
    expect(config.showWelcomeOnStartup).toBe(false)
    expect(config.onboardingCompleted).toBe(false)
    expect(config.recents).toEqual([])
  })

  test('validates standardLibraryProvider, defaulting to auto', () => {
    expect(normalizeConfig({}).standardLibraryProvider).toBe('auto')
    expect(normalizeConfig({ standardLibraryProvider: 'downloaded' }).standardLibraryProvider).toBe(
      'downloaded'
    )
    // Legacy/unknown values migrate to auto (e.g. the old 'system'/'none').
    expect(normalizeConfig({ standardLibraryProvider: 'system' }).standardLibraryProvider).toBe(
      'auto'
    )
    expect(normalizeConfig({ standardLibraryProvider: 'bogus' }).standardLibraryProvider).toBe(
      'auto'
    )
  })

  test('validates the persisted app theme', () => {
    expect(normalizeConfig({}).theme).toBe('dark')
    expect(normalizeConfig({ theme: 'light' }).theme).toBe('light')
    expect(normalizeConfig({ theme: 'neon' }).theme).toBe('dark')
  })

  test('validates the persisted GPU power preference', () => {
    expect(normalizeConfig({}).gpuPowerPreference).toBe('default')
    expect(normalizeConfig({ gpuPowerPreference: 'low-power' }).gpuPowerPreference).toBe(
      'low-power'
    )
    expect(normalizeConfig({ gpuPowerPreference: 'turbo' }).gpuPowerPreference).toBe('default')
  })

  test('Vulkan is off unless the config says true', () => {
    expect(normalizeConfig({}).useVulkan).toBe(false)
    expect(normalizeConfig({ useVulkan: true }).useVulkan).toBe(true)
    expect(normalizeConfig({ useVulkan: 'yes' }).useVulkan).toBe(false)
  })

  test('drops malformed recents and tabs rather than failing', () => {
    const config = normalizeConfig({
      recents: [{ kind: 'project', path: '/a', workspaceRoot: '/a', projectPath: null }, {}, 42],
      session: [{ tabs: [{ path: '/a/b.kicad_sch' }, { name: 'orphan' }], activeTabPath: null }]
    })
    expect(config.recents).toEqual([
      { kind: 'project', path: '/a', workspaceRoot: '/a', projectPath: null }
    ])
    expect(config.session[0].tabs).toEqual([{ name: '/a/b.kicad_sch', path: '/a/b.kicad_sch' }])
  })

  test('caps recents per kind', () => {
    const many = Array.from({ length: 50 }, (_, i) => ({
      kind: 'project',
      path: `/p${i}`,
      workspaceRoot: `/p${i}`,
      projectPath: null
    }))
    expect(normalizeConfig({ recents: many }).recents).toHaveLength(MAX_RECENT_PROJECTS)
  })

  test('drops recents that are tab addresses rather than files', () => {
    const config = normalizeConfig({
      recents: [
        {
          kind: 'file',
          path: 'readonly-lib://%2Fusr%2Fshare%2Fkicad%2Ffootprints%2FA.pretty%2FB.kicad_mod',
          workspaceRoot: '/a',
          projectPath: null
        },
        { kind: 'file', path: 'component://footprint/A/B', workspaceRoot: '/a', projectPath: null },
        { kind: 'file', path: '/a/x.kicad_sch', workspaceRoot: '/a', projectPath: null }
      ]
    })
    expect(config.recents.map((entry) => entry.path)).toEqual(['/a/x.kicad_sch'])
  })

  test('migrates the pre-P0.8 recentProjects shape to project entries', () => {
    const config = normalizeConfig({ recentProjects: [{ name: 'psu', path: '/pcb/psu' }] })
    // Those were all folder opens, so the project is unknown until the next open
    // re-detects it — the same state a fresh install is in.
    expect(config.recents).toEqual([
      { kind: 'project', path: '/pcb/psu', workspaceRoot: '/pcb/psu', projectPath: null }
    ])
  })

  test('prefers the new key when a config carries both', () => {
    const config = normalizeConfig({
      recents: [{ kind: 'file', path: '/a/x.kicad_sch', workspaceRoot: '/a', projectPath: null }],
      recentProjects: [{ name: 'old', path: '/old' }]
    })
    expect(config.recents.map((r) => r.path)).toEqual(['/a/x.kicad_sch'])
  })

  test('keeps a tab\u2019s cameras, dropping the ones that cannot frame anything', () => {
    const config = normalizeConfig({
      session: [
        {
          tabs: [
            {
              name: 'a',
              path: '/a',
              cameras: {
                '': { x: 1, y: 2, zoom: 3 },
                '::u2': { x: 0, y: 0, zoom: 0 },
                '::u3': { x: 'near', y: 2, zoom: 3 }
              }
            },
            { name: 'b', path: '/b', cameras: 'nope' }
          ]
        }
      ]
    })
    expect(config.session[0].tabs[0].cameras).toEqual({ '': { x: 1, y: 2, zoom: 3 } })
    expect(config.session[0].tabs[1].cameras).toBeUndefined()
  })

  test('clears an active tab that is not among the tabs', () => {
    const config = normalizeConfig({
      session: [{ tabs: [{ name: 'a', path: '/a' }], activeTabPath: '/gone' }]
    })
    expect(config.session[0].activeTabPath).toBeNull()
  })

  test('drops bounds with non-finite or zero dimensions', () => {
    const config = normalizeConfig({
      session: [
        { tabs: [], bounds: { x: 0, y: 0, width: 0, height: 100 } },
        { tabs: [], bounds: { x: 1, y: 2, width: 800, height: 600 } }
      ]
    })
    expect(config.session[0].bounds).toBeUndefined()
    expect(config.session[1].bounds).toEqual({ x: 1, y: 2, width: 800, height: 600 })
  })
})

describe('addRecent', () => {
  const project = (path: string, projectPath: string | null = null): RecentEntry => ({
    kind: 'project',
    path,
    workspaceRoot: path,
    projectPath
  })
  const file = (path: string, root: string, projectPath: string | null = null): RecentEntry => ({
    kind: 'file',
    path,
    workspaceRoot: root,
    projectPath
  })

  test('ignores a tab address with no file behind it', () => {
    const recents = [project('/a')]
    expect(addRecent(recents, file('component://footprint/A/B', '/a'))).toEqual(recents)
    expect(addRecent(recents, file('readonly-lib://%2Fx%2Fy.kicad_mod', '/a'))).toEqual(recents)
  })

  test('moves an existing entry to the front without duplicating', () => {
    const recents = [project('/a'), project('/b')]
    expect(addRecent(recents, project('/b'))).toEqual([project('/b'), project('/a')])
  })

  test('does not collide a file with a project at the same path', () => {
    const recents = [project('/a')]
    const result = addRecent(recents, file('/a', '/a'))
    expect(result).toHaveLength(2)
  })

  test('caps each kind independently, so files cannot evict projects', () => {
    const projects = Array.from({ length: MAX_RECENT_PROJECTS }, (_, i) => project(`/p${i}`))
    let result = [...projects]
    for (let i = 0; i < MAX_RECENT_FILES + 5; i++) {
      result = addRecent(result, file(`/p0/f${i}.kicad_sch`, '/p0'))
    }
    expect(result.filter((r) => r.kind === 'project')).toHaveLength(MAX_RECENT_PROJECTS)
    expect(result.filter((r) => r.kind === 'file')).toHaveLength(MAX_RECENT_FILES)
  })

  test('evicts the oldest project once the project cap is reached', () => {
    const many = Array.from({ length: MAX_RECENT_PROJECTS }, (_, i) => project(`/p${i}`))
    const result = addRecent(many, project('/new'))
    expect(result).toHaveLength(MAX_RECENT_PROJECTS)
    expect(result[0].path).toBe('/new')
    expect(result.some((r) => r.path === `/p${MAX_RECENT_PROJECTS - 1}`)).toBe(false)
  })

  test('opening a file bumps its project up the list', () => {
    const recents = [project('/b', '/b/b.kicad_pro'), project('/a', '/a/a.kicad_pro')]
    const result = addRecent(recents, file('/a/sheet.kicad_sch', '/a', '/a/a.kicad_pro'))
    expect(result[0].path).toBe('/a/sheet.kicad_sch')
    // The project it belongs to overtakes the one opened more recently.
    expect(result[1].path).toBe('/a')
    expect(result[2].path).toBe('/b')
  })

  test('a file in an unrecorded project invents no project entry', () => {
    const result = addRecent([], file('/x/sheet.kicad_sch', '/x', '/x/x.kicad_pro'))
    expect(result).toEqual([file('/x/sheet.kicad_sch', '/x', '/x/x.kicad_pro')])
  })

  test('a file with no project bumps nothing', () => {
    const recents = [project('/a', '/a/a.kicad_pro')]
    const result = addRecent(recents, file('/loose/x.kicad_sch', '/loose'))
    expect(result.map((r) => r.path)).toEqual(['/loose/x.kicad_sch', '/a'])
  })
})

describe('windowInitFor', () => {
  const a = { name: 'a.kicad_sch', path: '/proj/a.kicad_sch' }
  const b = { name: 'b.kicad_pcb', path: '/proj/b.kicad_pcb' }

  test('opens the session as it stands: project, tabs, active tab, project pick', () => {
    const init = windowInitFor(
      {
        projectPath: '/proj',
        tabs: [a, b],
        activeTabPath: b.path,
        activeProjectPath: '/proj/proj.kicad_pro'
      },
      true
    )
    expect(init).toEqual({
      projectPath: '/proj',
      tabs: [a, b],
      activeTabPath: b.path,
      activeProjectPath: '/proj/proj.kicad_pro',
      showWelcome: false
    })
  })

  test('an active tab that is no longer open falls back to the first', () => {
    expect(windowInitFor({ tabs: [a, b], activeTabPath: '/gone' }, true).activeTabPath).toBe(a.path)
    expect(windowInitFor({ tabs: [] }, true).activeTabPath).toBeNull()
  })

  test('Welcome only when there is nothing to show and the user wants it', () => {
    expect(windowInitFor({}, true).showWelcome).toBe(true)
    expect(windowInitFor({}, false).showWelcome).toBe(false)
    expect(windowInitFor({ projectPath: '/proj', tabs: [a] }, true).showWelcome).toBe(false)
  })
})

describe('sanitizeSessions', () => {
  const exists = (path: string): boolean => path === '/proj' || path === '/proj/a.kicad_sch'

  test('drops tabs whose file is gone', () => {
    const result = sanitizeSessions(
      [
        session({
          tabs: [
            { name: 'a.kicad_sch', path: '/proj/a.kicad_sch' },
            { name: 'gone.kicad_sch', path: '/proj/gone.kicad_sch' }
          ]
        })
      ],
      exists
    )
    expect(result[0].tabs.map((t) => t.path)).toEqual(['/proj/a.kicad_sch'])
  })

  test('keeps virtual tabs that have no file backing', () => {
    const result = sanitizeSessions(
      [
        session({
          projectPath: null,
          tabs: [{ name: 'Welcome', path: 'goatcad://welcome' }],
          activeTabPath: 'goatcad://welcome'
        })
      ],
      exists
    )
    expect(result[0].tabs).toEqual([{ name: 'Welcome', path: 'goatcad://welcome' }])
  })

  test('clears a project folder that no longer exists', () => {
    const result = sanitizeSessions(
      [
        session({
          projectPath: '/deleted',
          tabs: [{ name: 'Welcome', path: 'goatcad://welcome' }],
          activeTabPath: 'goatcad://welcome'
        })
      ],
      exists
    )
    expect(result[0].projectPath).toBeNull()
  })

  test('drops windows left with nothing to restore', () => {
    const result = sanitizeSessions(
      [session({ projectPath: '/deleted', tabs: [{ name: 'g', path: '/gone' }] })],
      exists
    )
    expect(result).toEqual([])
  })

  test('falls back to the first tab when the active tab is dropped', () => {
    const result = sanitizeSessions([session({ activeTabPath: '/proj/gone.kicad_sch' })], exists)
    expect(result[0].activeTabPath).toBe('/proj/a.kicad_sch')
  })
})

describe('ConfigStore', () => {
  test('starts from defaults when no file exists', () => {
    const store = new ConfigStore(makeTmpDir())
    expect(store.get()).toEqual(defaultConfig())
  })

  test('falls back to defaults on a corrupt file', () => {
    const dir = makeTmpDir()
    fs.writeFileSync(join(dir, 'config.json'), '{not json', 'utf8')
    expect(new ConfigStore(dir).get()).toEqual(defaultConfig())
  })

  test('round-trips through disk', () => {
    const dir = makeTmpDir()
    const store = new ConfigStore(dir)
    store.update({ showWelcomeOnStartup: false, session: [session()] })
    store.flush()

    const reloaded = new ConfigStore(dir)
    expect(reloaded.get().showWelcomeOnStartup).toBe(false)
    expect(reloaded.get().session).toEqual([session()])
  })

  test('flush leaves no temp file behind', () => {
    const dir = makeTmpDir()
    const store = new ConfigStore(dir)
    store.update({ onboardingCompleted: true })
    store.flush()
    expect(fs.readdirSync(dir)).toEqual(['config.json'])
  })

  test('creates the directory on first write', () => {
    const dir = join(makeTmpDir(), 'nested', 'deeper')
    const store = new ConfigStore(dir)
    store.update({ onboardingCompleted: true })
    store.flush()
    expect(fs.existsSync(join(dir, 'config.json'))).toBe(true)
  })
})

describe('normalizeSession — restored project pick', () => {
  const base = { projectPath: '/hw', tabs: [], activeTabPath: null }

  test('keeps a remembered project pick', () => {
    const s = normalizeSession({ ...base, activeProjectPath: '/hw/psu.kicad_pro' })
    expect(s).toMatchObject({ activeProjectPath: '/hw/psu.kicad_pro' })
  })

  /**
   * Panel sizes moved to `AppConfig.panelLayout`, which is global — a panel
   * size is a preference, not window state. They are still promoted out of an
   * existing session once (see below), but never written back.
   */
  test('no longer carries the legacy panel sizes', () => {
    const s = normalizeSession({ ...base, sidebarWidth: 320, explorerHeight: 180 })
    expect(s?.sidebarWidth).toBeUndefined()
    expect(s?.explorerHeight).toBeUndefined()
  })

  test('omits the project pick when absent', () => {
    expect(normalizeSession(base)?.activeProjectPath).toBeUndefined()
  })
})

describe('normalizeBoardAutomation', () => {
  test('keeps known modes by board path and drops the rest', () => {
    expect(
      normalizeBoardAutomation({
        '/w/a.kicad_pcb': { zoneFill: 'off', drc: 'fast' },
        '/w/b.kicad_pcb': { drc: 'full' },
        '/w/c.kicad_pcb': { zoneFill: 'greedy' },
        '/w/d.kicad_pcb': 'greedy'
      })
    ).toEqual({ '/w/a.kicad_pcb': { zoneFill: 'off' }, '/w/b.kicad_pcb': { drc: 'full' } })
    expect(normalizeBoardAutomation(null)).toEqual({})
  })

  test('keeps the most recent boards past its bound', () => {
    const many = Object.fromEntries(
      Array.from({ length: 250 }, (_, i) => [`/w/${i}.kicad_pcb`, { drc: 'off' }])
    )
    const kept = Object.keys(normalizeBoardAutomation(many))
    expect(kept).toHaveLength(200)
    expect(kept[0]).toBe('/w/50.kicad_pcb')
  })
})

describe('normalizePanelLayout', () => {
  test('keeps sane sizes and rounds a fractional one', () => {
    expect(
      normalizePanelLayout({
        sidebarWidth: 320.7,
        explorerHeight: 180,
        railWidth: 420,
        sections: { 'symbol.pins': { height: 260, collapsed: true } }
      })
    ).toEqual({
      sidebarWidth: 321,
      explorerHeight: 180,
      railWidth: 420,
      sections: { 'symbol.pins': { height: 260, collapsed: true } }
    })
  })

  /** A dropped key falls back to the component's own default, always usable. */
  test('drops sizes that would render a pane unusable', () => {
    for (const bad of [0, -50, NaN, Infinity, 99999, '260', null]) {
      const layout = normalizePanelLayout({
        sidebarWidth: bad,
        explorerHeight: bad,
        railWidth: bad,
        sections: { 'symbol.pins': { height: bad } }
      })
      expect(layout.sidebarWidth).toBeUndefined()
      expect(layout.explorerHeight).toBeUndefined()
      expect(layout.railWidth).toBeUndefined()
      expect(layout.sections).toBeUndefined()
    }
  })

  test("takes the rail width from an older per-editor config, the board editor's first", () => {
    const layout = normalizePanelLayout({
      editorPanelWidth: { gerber: 500, schematic: 350, pcb: 400 }
    })
    expect(layout).toEqual({ railWidth: 400 })
    expect(normalizePanelLayout({ editorPanelWidth: { symbol: 330 } }).railWidth).toBe(330)
    expect(normalizePanelLayout({ railWidth: 280, editorPanelWidth: { pcb: 400 } }).railWidth).toBe(
      280
    )
  })

  /** A panel removed in one release may come back in the next. */
  test('keeps a section id it does not recognise', () => {
    const layout = normalizePanelLayout({ sections: { 'future.panel': { collapsed: true } } })
    expect(layout.sections).toEqual({ 'future.panel': { collapsed: true } })
  })

  test('keeps a collapsed-only section, which has no height of its own', () => {
    const layout = normalizePanelLayout({ sections: { 'pcb.layers': { collapsed: false } } })
    expect(layout.sections).toEqual({ 'pcb.layers': { collapsed: false } })
  })

  test('keeps a pinned flag and drops one that is not a boolean', () => {
    const layout = normalizePanelLayout({
      sections: { 'pcb.grid': { pinned: true, height: 140 }, 'pcb.filter': { pinned: 'yes' } }
    })
    expect(layout.sections).toEqual({ 'pcb.grid': { pinned: true, height: 140 } })
  })

  test('is empty for junk', () => {
    expect(normalizePanelLayout(null)).toEqual({})
    expect(normalizePanelLayout('nope')).toEqual({})
  })
})

describe('panel sizes are promoted out of an old session', () => {
  const write = (dir: string, config: unknown): void =>
    fs.writeFileSync(join(dir, 'config.json'), JSON.stringify(config), 'utf8')

  test('adopts the sizes a pre-panelLayout config left on its windows', () => {
    const dir = makeTmpDir()
    write(dir, {
      session: [
        {
          projectPath: '/hw',
          tabs: [],
          activeTabPath: null,
          sidebarWidth: 320,
          explorerHeight: 180
        }
      ]
    })
    const config = new ConfigStore(dir).get()
    expect(config.panelLayout.sidebarWidth).toBe(320)
    expect(config.panelLayout.explorerHeight).toBe(180)
    // And the session copy is gone, so there is only one home for it now.
    expect(config.session[0]?.sidebarWidth).toBeUndefined()
  })

  /** The sizes are global now, so several disagreeing windows need one rule. */
  test('the first window carrying a value wins', () => {
    const dir = makeTmpDir()
    write(dir, {
      session: [
        { projectPath: '/a', tabs: [], activeTabPath: null, sidebarWidth: 320 },
        { projectPath: '/b', tabs: [], activeTabPath: null, sidebarWidth: 400 }
      ]
    })
    expect(new ConfigStore(dir).get().panelLayout.sidebarWidth).toBe(320)
  })

  test('a stored panelLayout wins over the legacy session copy', () => {
    const dir = makeTmpDir()
    write(dir, {
      panelLayout: { sidebarWidth: 280 },
      session: [{ projectPath: '/a', tabs: [], activeTabPath: null, sidebarWidth: 320 }]
    })
    expect(new ConfigStore(dir).get().panelLayout.sidebarWidth).toBe(280)
  })
})

describe('normalizeGridPreferences', () => {
  const grid = { spacing: 0.25, unit: 'mm', visible: true, snap: true }

  test('keeps a complete grid per editor kind', () => {
    expect(normalizeGridPreferences({ pcb: grid })).toEqual({ pcb: grid })
    const inches = { ...grid, spacing: 0.05, unit: 'in' }
    expect(normalizeGridPreferences({ schematic: inches })).toEqual({ schematic: inches })
  })

  /**
   * Half a grid is worse than none: the renderer merges a stored value over its
   * defaults, so a spacing with no unit would be reinterpreted in whatever unit
   * the default uses — a 0.25 mm routing grid silently becoming 0.25 mil.
   */
  test('drops an entry missing its unit or spacing', () => {
    expect(normalizeGridPreferences({ pcb: { spacing: 0.25 } })).toEqual({})
    expect(normalizeGridPreferences({ pcb: { unit: 'mm' } })).toEqual({})
    expect(normalizeGridPreferences({ pcb: { ...grid, unit: 'inch' } })).toEqual({})
    expect(normalizeGridPreferences({ pcb: { ...grid, spacing: 0 } })).toEqual({})
  })

  test('fills the two booleans, which have safe defaults', () => {
    expect(normalizeGridPreferences({ pcb: { spacing: 1, unit: 'mm' } })).toEqual({
      pcb: { spacing: 1, unit: 'mm', visible: true, snap: true }
    })
  })

  test('ignores an editor kind it does not know', () => {
    expect(normalizeGridPreferences({ gerber: grid, pcb: grid })).toEqual({ pcb: grid })
  })
})

describe('normalizeSelectionFilter', () => {
  test('starts empty, so every editor falls back to selecting everything', () => {
    expect(normalizeSelectionFilter(undefined)).toEqual({})
    expect(normalizeSelectionFilter('nonsense')).toEqual({})
    expect(defaultConfig().selectionFilter).toEqual({})
  })

  test('keeps a well-formed entry', () => {
    expect(
      normalizeSelectionFilter({ pcb: { excludedKinds: ['via', 'zone'], allowLocked: false } })
    ).toEqual({ pcb: { excludedKinds: ['via', 'zone'], allowLocked: false } })
  })

  test('drops editors it does not know', () => {
    const result = normalizeSelectionFilter({
      pcb: { excludedKinds: ['via'], allowLocked: true },
      gerber: { excludedKinds: ['anything'], allowLocked: true }
    })
    expect(Object.keys(result)).toEqual(['pcb'])
  })

  // The dangerous direction is one-way: a corrupt file must never leave someone
  // unable to select anything with no clue why. So a bad entry falls back to
  // "nothing excluded" rather than being trusted or dropped silently.
  test('a corrupt entry falls back to excluding nothing', () => {
    expect(normalizeSelectionFilter({ pcb: 'broken' })).toEqual({
      pcb: { excludedKinds: [], allowLocked: true }
    })
    expect(normalizeSelectionFilter({ pcb: { excludedKinds: 'via' } })).toEqual({
      pcb: { excludedKinds: [], allowLocked: true }
    })
  })

  test('discards non-string kinds and de-duplicates the rest', () => {
    expect(
      normalizeSelectionFilter({
        pcb: { excludedKinds: ['via', 'via', 7, null], allowLocked: 'x' }
      })
    ).toEqual({ pcb: { excludedKinds: ['via'], allowLocked: true } })
  })

  test('round-trips through normalizeConfig', () => {
    const config = normalizeConfig({
      selectionFilter: { schematic: { excludedKinds: ['wire'], allowLocked: true } }
    })
    expect(config.selectionFilter.schematic?.excludedKinds).toEqual(['wire'])
  })
})

describe('normalizeBoard3DView', () => {
  test('a fresh config shows the finished board', () => {
    expect(defaultConfig().board3dView).toEqual(defaultBoard3DView())
    expect(normalizeBoard3DView(undefined)).toEqual(defaultBoard3DView())
    expect(normalizeBoard3DView('nonsense')).toEqual(defaultBoard3DView())
  })

  test('keeps the switches it recognizes', () => {
    const view = normalizeBoard3DView({ silkscreen: false, drawings: true })
    expect(view.silkscreen).toBe(false)
    expect(view.drawings).toBe(true)
  })

  // Per-switch fallback, not all-or-nothing: a config written by an older
  // release has no key for a switch added since, and must not lose the rest of
  // its settings — or blank the board — because of it.
  test('fills a missing or non-boolean switch from the default', () => {
    const view = normalizeBoard3DView({ copper: 'yes', boardBody: false })
    expect(view.copper).toBe(true)
    expect(view.boardBody).toBe(false)
    expect(view.models).toBe(true)
  })

  test('ignores keys that are not switches', () => {
    expect(normalizeBoard3DView({ nonsense: true })).toEqual(defaultBoard3DView())
  })

  test('round-trips through normalizeConfig', () => {
    expect(normalizeConfig({ board3dView: { axes: true } }).board3dView.axes).toBe(true)
  })
})

describe('normalizeBoard3DPresentation', () => {
  test('a fresh config is the lens, the studio light and the theme ground', () => {
    expect(defaultConfig().board3dPresentation).toEqual(defaultBoard3DPresentation())
    expect(normalizeBoard3DPresentation('nonsense')).toEqual(defaultBoard3DPresentation())
  })

  test('keeps the settings it recognizes and defaults the rest', () => {
    expect(
      normalizeBoard3DPresentation({ projection: 'orthographic', lighting: 'neon', background: 7 })
    ).toEqual({ projection: 'orthographic', lighting: 'studio', exposure: 1, background: 'theme' })
    expect(normalizeBoard3DPresentation({ exposure: 9 }).exposure).toBe(4)
    expect(normalizeBoard3DPresentation({ exposure: 'bright' }).exposure).toBe(1)
    expect(
      normalizeConfig({ board3dPresentation: { background: 'transparent' } }).board3dPresentation
        .background
    ).toBe('transparent')
  })
})

describe('writableConfigPatch', () => {
  // The allowlist a renderer's `config:update` passes through. A key left out
  // of it is dropped silently and the broadcast that follows carries the old
  // value, so the control the user just changed snaps back — which is what this
  // is here to stop happening to the next persisted view preference.
  test('passes every persisted view preference through', () => {
    const patch = writableConfigPatch({
      selectionFilter: { symbol: { excludedKinds: ['pin'], allowLocked: true } },
      board3dView: { axes: true },
      board3dPresentation: { lighting: 'flat' },
      pcbView: { zoneFills: false },
      pcbRouter: { mode: 'walkaround' },
      symbolView: { showHiddenPins: false },
      schematicView: { netHighlight: false }
    })
    expect(patch.selectionFilter?.symbol?.excludedKinds).toEqual(['pin'])
    expect(patch.board3dView?.axes).toBe(true)
    expect(patch.board3dPresentation?.lighting).toBe('flat')
    expect(patch.pcbView?.zoneFills).toBe(false)
    expect(patch.pcbRouter).toEqual({ mode: 'walkaround' })
    expect(patch.symbolView?.showHiddenPins).toBe(false)
    // Normalized on the way in, so the switches the patch left out are filled.
    expect(patch.symbolView?.showHiddenFields).toBe(true)
    expect(patch.schematicView?.netHighlight).toBe(false)
  })

  test('keeps settings writable and everything else out', () => {
    const patch = writableConfigPatch({
      theme: 'dark',
      gpuPowerPreference: 'high-performance',
      useVulkan: true,
      locale: 'en',
      showWelcomeOnStartup: false,
      recents: [{ path: '/x', kind: 'project' }],
      session: [{ bounds: {} }],
      version: 99
    })
    expect(patch).toEqual({
      theme: 'dark',
      gpuPowerPreference: 'high-performance',
      useVulkan: true,
      locale: 'en',
      showWelcomeOnStartup: false
    })
  })

  test('a patch that is not an object writes nothing', () => {
    expect(writableConfigPatch(null)).toEqual({})
    expect(writableConfigPatch('symbolView')).toEqual({})
  })
})

describe('normalizeSymbolView', () => {
  test('fills a missing or non-boolean switch from the default', () => {
    const view = normalizeSymbolView({ showHiddenPins: 'no' })
    expect(view.showHiddenPins).toBe(true)
    expect(view.showHiddenFields).toBe(true)
  })

  test('keeps a switch the user turned off', () => {
    expect(normalizeSymbolView({ showHiddenFields: false })).toEqual({
      showHiddenPins: true,
      showHiddenFields: false
    })
  })

  test('round-trips through normalizeConfig', () => {
    expect(normalizeConfig({ symbolView: { showHiddenPins: false } }).symbolView).toEqual({
      showHiddenPins: false,
      showHiddenFields: true
    })
    expect(normalizeConfig({}).symbolView).toEqual(defaultSymbolView())
  })
})

describe('normalizePcbRouter', () => {
  test('keeps a known mode and falls back from an unknown one to Walkaround, KiCad’s default', () => {
    expect(normalizePcbRouter({ mode: 'shove' })).toEqual({ mode: 'shove' })
    expect(normalizePcbRouter({ mode: 'autoroute' })).toEqual({ mode: 'walkaround' })
    expect(defaultPcbRouter()).toEqual({ mode: 'walkaround' })
  })

  test('reads the retired Ignore mode, and the older violations switch, as Highlight with violations allowed', () => {
    const allowed = { mode: 'highlight', settings: { allowViolations: true } }
    expect(normalizePcbRouter({ mode: 'ignore' })).toEqual(allowed)
    expect(
      normalizePcbRouter({ mode: 'ignore', settings: { allowViolations: false, freeAngle: true } })
    ).toEqual({ mode: 'highlight', settings: { allowViolations: true, freeAngle: true } })
    expect(normalizePcbRouter({ mode: 'highlight', blockViolations: false })).toEqual(allowed)
    expect(normalizePcbRouter({ mode: 'highlight', blockViolations: true })).toEqual({
      mode: 'highlight'
    })
    expect(normalizePcbRouter({ mode: 'shove', blockViolations: false })).toEqual({
      mode: 'shove'
    })
  })

  test('keeps a known corner mode and drops anything else', () => {
    expect(normalizePcbRouter({ mode: 'shove', corner: 'arc90' })).toEqual({
      mode: 'shove',
      corner: 'arc90'
    })
    expect(normalizePcbRouter({ mode: 'shove', corner: 'free' })).toEqual({ mode: 'shove' })
  })

  test('round-trips through normalizeConfig', () => {
    expect(normalizeConfig({ pcbRouter: { mode: 'walkaround' } }).pcbRouter).toEqual({
      mode: 'walkaround'
    })
    expect(normalizeConfig({}).pcbRouter).toEqual(defaultPcbRouter())
  })

  test("drops the route hint's retired use counts", () => {
    expect(
      normalizeConfig({ pcbRouter: { mode: 'shove', hintUses: { 'pcb.routeVia': 2 } } }).pcbRouter
    ).toEqual({ mode: 'shove' })
  })
})

describe('normalizeSchematicView', () => {
  test('fills a missing or non-boolean switch from the default', () => {
    expect(normalizeSchematicView({ netHighlight: 'no' })).toEqual(defaultSchematicView())
    expect(normalizeSchematicView(null)).toEqual(defaultSchematicView())
  })

  test('keeps a switch the user turned off, through normalizeConfig', () => {
    expect(normalizeSchematicView({ netHighlight: false })).toEqual({
      netHighlight: false,
      showHiddenPins: false,
      showHiddenFields: false
    })
    expect(normalizeConfig({ schematicView: { netHighlight: false } }).schematicView).toEqual({
      netHighlight: false,
      showHiddenPins: false,
      showHiddenFields: false
    })
    expect(normalizeConfig({}).schematicView).toEqual(defaultSchematicView())
  })

  test('leaves findings off the canvas until turned on, through normalizeConfig', () => {
    expect(normalizeConfig({}).designHealthView).toEqual({ showMarkers: false, errorsOnly: false })
    expect(normalizeDesignHealthView({ showMarkers: false, errorsOnly: true })).toEqual({
      showMarkers: false,
      errorsOnly: true
    })
    expect(normalizeDesignHealthView({ showMarkers: 'no', errorsOnly: 1 })).toEqual({
      showMarkers: false,
      errorsOnly: false
    })
  })

  test('hides hidden pins and fields until asked, as KiCad does', () => {
    expect(defaultSchematicView().showHiddenPins).toBe(false)
    expect(defaultSchematicView().showHiddenFields).toBe(false)
  })

  test('keeps the hidden-item switches the user turned on, each on its own', () => {
    expect(normalizeSchematicView({ showHiddenPins: true, showHiddenFields: 'yes' })).toEqual({
      netHighlight: true,
      showHiddenPins: true,
      showHiddenFields: false
    })
    const patch = writableConfigPatch({ schematicView: { showHiddenFields: true } })
    expect(patch.schematicView).toEqual({
      netHighlight: true,
      showHiddenPins: false,
      showHiddenFields: true
    })
  })
})

describe('normalizePartUpdatePreferences', () => {
  test('keeps ticks and field names per kind and verb, dropping what is malformed', () => {
    expect(
      normalizePartUpdatePreferences({
        symbol: {
          update: { options: { resetFieldText: false, bad: 'yes' }, fieldsOn: ['Value', 3] },
          change: 'nope'
        },
        footprint: [],
        board: { update: {} }
      })
    ).toEqual({ symbol: { update: { options: { resetFieldText: false }, fieldsOn: ['Value'] } } })
    expect(normalizePartUpdatePreferences(null)).toEqual({})
  })
})
