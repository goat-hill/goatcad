<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watchEffect } from 'vue'
import { useI18n } from 'vue-i18n'
import BrandWordmark from './shared/BrandWordmark.vue'
import ContextMenu from './shared/ContextMenu.vue'
import Icon from './shared/Icon.vue'
import type { MenuNode } from '../lib/menu'
import { buildCommandMenu, NEW_SUBMENU_IDS, type CommandContext } from '../lib/commands'
import { hotkeyLabel } from '../lib/hotkeys'
import { abbreviateHome } from '../lib/displayPath'
import { isProjectEntry } from '../lib/recents'
import type { RecentEntry } from '../../../preload/recentTypes'
import { nativeCommandEvent, toNativeTemplate } from '../lib/nativeMenu'
import {
  buildEditMenu,
  dispatchEditAction,
  isEditActionId,
  useEditActions,
  useNavActions
} from '../lib/editActions'
import { buildExportMenu, runExportAction, useExportActions } from '../lib/exportActions'
import type { HotkeyActionId } from '../lib/hotkeys'
import { useWindowFocused } from '../lib/windowFocus'

const { t } = useI18n()

const splitLabel = (id: 'split-tab' | 'split-direction' | 'focus-other-group'): string => {
  if (id === 'split-tab') return t('titleBar.menu.splitTab')
  if (id === 'split-direction') return t('titleBar.menu.splitDirection')
  return t('titleBar.menu.focusOtherGroup')
}

const windowFocused = useWindowFocused()

/**
 * macOS draws the menu in the system bar and the window controls as traffic
 * lights, both outside this component's reach — so on darwin the title bar
 * keeps only the wordmark and the title, and the menus are pushed to main
 * (`lib/nativeMenu.ts`). Windows and Linux draw both here, VS Code-style.
 */
const isMac = window.api.platform === 'darwin'

const editActions = useEditActions()
const navActions = useNavActions()
const exportActions = useExportActions()

/**
 * The menus, in bar order — one list for both surfaces. Windows and Linux draw
 * them here, macOS sends the same set to the system bar, and a second list for
 * the native side is exactly how a menu ends up existing on one platform only.
 *
 * Edit is ours rather than Electron's `editMenu` role: that role's Undo/Redo run
 * the DOM's editing undo, and registering Ctrl/Cmd+Z for it would swallow the
 * key before the editors' undo/redo command layer ever saw it. Main appends the
 * clipboard roles.
 */
const SECTION_IDS = computed(() => [
  'file',
  'edit',
  'view',
  // Go is the focused editor's (lib/editActions.ts): only an editor that spans
  // several documents — the schematic's sheets — has anywhere to go.
  ...(navActions.value.length ? ['go'] : []),
  'help'
])

/** View ▸ the split-view commands, each named by the hotkey it replays. */
const SPLIT_COMMANDS = [
  { id: 'split-tab', hotkey: 'app.splitTab' },
  { id: 'split-direction', hotkey: 'app.splitDirection' },
  { id: 'focus-other-group', hotkey: 'app.focusOtherGroup' }
] as const

const props = defineProps<{
  projectPath: string | null
  projectName: string
  activeTabName: string | null
  /** Most-recent-first, as the config store keeps them. */
  recents: RecentEntry[]
  /** The project has a root schematic: the netlist export and board update need one. */
  hasSchematic: boolean
  /** A board is in front (or its setup or manufacture tab): File lists its pages. */
  hasBoardPage: boolean
  /** A sheet is in front (or its design's setup or components tab): File lists its pages. */
  hasSchematicPage: boolean
}>()

const emit = defineEmits<{
  (e: 'open-folder'): void
  (e: 'open-project'): void
  (e: 'open-recent', entry: RecentEntry): void
  (e: 'open-file'): void
  (e: 'clear-recent'): void
  (e: 'new-project'): void
  (e: 'create-typed-file', kind: string): void
  (e: 'save'): void
  (e: 'save-as'): void
  (e: 'save-all'): void
  (e: 'export-netlist'): void
  /** A design's own page, the ones its Properties panel offers with nothing selected. */
  (e: 'open-design-page', page: DesignPage): void
  (e: 'update-pcb'): void
  (e: 'show-shortcuts'): void
  (e: 'show-welcome'): void
  (e: 'show-about'): void
  (e: 'show-feedback'): void
}>()

const activeMenu = ref<string | null>(null)
const menuPosition = ref({ x: 0, y: 0 })

/**
 * The File menu has no clicked row, so a create lands in the project root and
 * the container creates (Symbol, Footprint) have no target library — they render
 * grayed, which is exactly §4.2's `⊘`.
 */
const commandContext = computed<CommandContext>(() => ({ projectPath: props.projectPath }))

/** Id prefix for a recents row; the rest is its index in `props.recents`. */
const RECENT_ID_PREFIX = 'recent:'

const stemOf = (path: string): string => (path.split(/[/\\]/).pop() ?? path).replace(/\.[^.]+$/, '')

const recentRow = (entry: RecentEntry, index: number): MenuNode => {
  const id = `${RECENT_ID_PREFIX}${index}`
  // Rendering keys off `kind` — folder-or-project versus file — while *grouping*
  // keys off whether there is a project context (`recents.ts`); a folder with no
  // project renders like a project row but sits with the files.
  //
  // Either way it is the **path**: a name alone cannot tell two copies of one
  // design apart, and having two on a machine — a checkout and a release, or the
  // variants KiCad's own demos ship — is ordinary rather than exotic.
  if (entry.kind === 'project') {
    return { id, label: abbreviateHome(entry.path, window.api.homeDir) }
  }
  // A file is named by its filename; the project it was used in trails it, so
  // "which psu?" is answerable without printing the whole path on every row.
  const name = entry.path.split(/[/\\]/).pop() ?? entry.path
  return {
    id,
    label: entry.projectPath
      ? [{ text: name }, { text: `  ${stemOf(entry.projectPath)}`, code: true }]
      : name
  }
}

/**
 * File ▸ Open Recent, from the same config-store list the Welcome page shows.
 *
 * Projects lead, because opening one is what the app wants to encourage: it is
 * the context every other feature needs. Files and project-less folders follow,
 * for picking a design back up where it was left (docs/projects.md §4).
 */
const recentItems = computed<MenuNode[]>(() => {
  if (props.recents.length === 0) {
    return [{ id: 'no-recent', label: t('titleBar.menu.noRecent'), disabled: true }]
  }
  const rows = props.recents.map(recentRow)
  const projects = rows.filter((_, i) => isProjectEntry(props.recents[i]))
  const files = rows.filter((_, i) => !isProjectEntry(props.recents[i]))
  return [
    // Each group announces itself only when it has rows — an empty heading is a
    // promise of content that isn't there.
    ...(projects.length > 0
      ? [{ header: t('titleBar.menu.recentProjects') } as MenuNode, ...projects]
      : []),
    ...(projects.length > 0 && files.length > 0 ? [{ divider: true as const }] : []),
    ...(files.length > 0 ? [{ header: t('titleBar.menu.recentFiles') } as MenuNode, ...files] : []),
    { divider: true },
    { id: 'clear-recent', label: t('titleBar.menu.clearRecent') }
  ]
})

/** File ▸ the design's pages, which open in tabs of their own. */
type DesignPage = 'board-setup' | 'manufacture' | 'schematic-setup' | 'components'
const DESIGN_PAGES: readonly DesignPage[] = [
  'schematic-setup',
  'components',
  'board-setup',
  'manufacture'
]
const isDesignPage = (id: string): id is DesignPage =>
  (DESIGN_PAGES as readonly string[]).includes(id)

/**
 * The design pages of the document in front, or none: they are that file's, so
 * the menu follows the tab rather than graying rows a board never has.
 */
const designPageItems = computed<MenuNode[]>(() => {
  const items: MenuNode[] = []
  // The step between the two documents, on either: the schematic's last, the board's first.
  const updatePcb: MenuNode = {
    id: 'update-pcb',
    label: t('titleBar.menu.updatePcb'),
    shortcut: hotkeyLabel('app.updatePcb'),
    ...needsSchematic.value
  }
  if (props.hasSchematicPage) {
    items.push(
      { id: 'schematic-setup', label: t('titleBar.menu.schematicSetup') },
      { id: 'components', label: t('titleBar.menu.components') },
      updatePcb
    )
  }
  if (props.hasBoardPage) {
    items.push(
      updatePcb,
      { id: 'board-setup', label: t('titleBar.menu.boardSetup') },
      { id: 'manufacture', label: t('titleBar.menu.manufacture') }
    )
  }
  return items.length ? [...items, { divider: true }] : []
})

/** Grays a design command, with why, while the window has no schematic to run it on. */
const needsSchematic = computed(() =>
  props.hasSchematic ? {} : { disabled: true, disabledReason: t('titleBar.menu.needsSchematic') }
)

/**
 * The title-bar menus, declared as data and rendered by the shared menu
 * component (lib/menu.ts). Selection is dispatched by id in `onMenuSelect`.
 */
const menus = computed<Record<string, MenuNode[]>>(() => ({
  file: [
    // Project-level entries first: they need no open project, and `New ▸` below
    // creates *into* one.
    { id: 'new-project', label: t('titleBar.menu.newProject') },
    {
      id: 'new',
      label: t('titleBar.menu.new'),
      // A view over the command registry (lib/commands.ts), so this menu and the
      // explorer's `New ▸` cannot disagree about what exists. Disabled rows stay
      // visible here — the File menu is where a command is *discovered*, and a
      // grayed row with a why-not tooltip teaches more than an absent one
      // (docs/projects.md §7.2).
      children: buildCommandMenu(NEW_SUBMENU_IDS, commandContext.value, t, { hotkeyLabel })
    },
    {
      id: 'new-window',
      label: t('titleBar.menu.newWindow'),
      shortcut: hotkeyLabel('app.newWindow')
    },
    { divider: true },
    {
      id: 'open-project',
      label: t('titleBar.menu.openProject'),
      shortcut: hotkeyLabel('app.openProject')
    },
    {
      id: 'open-folder',
      label: t('titleBar.menu.openFolder'),
      shortcut: hotkeyLabel('app.openFolder')
    },
    // The degraded path — a single file, no project — so it sits below the two
    // that establish context rather than beside them (projects.md §4).
    { id: 'open-file', label: t('titleBar.menu.openFile') },
    {
      id: 'open-recent',
      label: t('titleBar.menu.openRecent'),
      children: recentItems.value
    },
    { divider: true },
    { id: 'save', label: t('titleBar.menu.save'), shortcut: hotkeyLabel('editor.save') },
    { id: 'save-as', label: t('titleBar.menu.saveAs') },
    { id: 'save-all', label: t('titleBar.menu.saveAll') },
    { divider: true },
    // The front document's own pages, the buttons its Properties panel shows
    // with nothing selected, in the order the work goes: set up, then make.
    ...designPageItems.value,
    {
      id: 'export',
      label: t('titleBar.menu.export'),
      children: [
        {
          id: 'export-netlist',
          label: t('titleBar.menu.exportNetlist'),
          ...needsSchematic.value
        },
        // What the front editor can write from what it shows (lib/exportActions.ts).
        ...buildExportMenu(exportActions.value)
      ]
    },
    { divider: true },
    { id: 'exit', label: t('titleBar.menu.exit'), shortcut: 'Alt+F4' }
  ],
  /**
   * The active editor publishes what it can do right now (lib/editActions.ts) —
   * copy, paste, duplicate, the transforms — and those rows carry real enabled
   * state. Undo/Redo are the fallback for an editor that publishes nothing, so
   * Edit is never empty.
   */
  edit: editActions.value.length
    ? buildEditMenu(editActions.value)
    : [
        { id: 'undo', label: t('common.undoLabel'), shortcut: hotkeyLabel('editor.undo') },
        { id: 'redo', label: t('common.redoLabel'), shortcut: hotkeyLabel('editor.redo') }
      ],
  view: [
    ...SPLIT_COMMANDS.map(({ id, hotkey }) => ({
      id,
      label: splitLabel(id),
      shortcut: hotkeyLabel(hotkey)
    })),
    { divider: true },
    { id: 'dev-tools', label: t('titleBar.menu.toggleDevTools'), shortcut: 'F12' }
  ],
  go: buildEditMenu(navActions.value),
  help: [
    { id: 'welcome', label: t('titleBar.menu.welcome') },
    { id: 'shortcuts', label: t('titleBar.menu.keyboardShortcutsReference') },
    { divider: true },
    { id: 'feedback', label: t('titleBar.menu.shareFeedback') },
    { id: 'about', label: t('titleBar.menu.aboutGoatCAD') }
  ]
}))

// Re-sent on every change, not just at mount: the labels move with the locale
// and the create items enable and disable with the window's project.
watchEffect(() => {
  if (!isMac) return
  window.api.setNativeMenu(
    toNativeTemplate(
      SECTION_IDS.value.map((id) => ({
        id,
        label: t(`titleBar.menu.${id}`),
        items: menus.value[id] ?? []
      }))
    )
  )
})

onMounted(() => {
  if (!isMac) return
  // A native accelerator never reaches the page, so commands that have one are
  // replayed as the keydown they stand for and land in the handlers that
  // already own them; the rest dispatch exactly as an in-window click does.
  const stop = window.api.onMenuCommand((id) => {
    const event = nativeCommandEvent(id)
    if (event) window.dispatchEvent(event)
    else onMenuSelect(id)
  })
  onUnmounted(stop)
})

const activeMenuItems = computed<MenuNode[]>(() =>
  activeMenu.value ? (menus.value[activeMenu.value] ?? []) : []
)

/** The title that opened the menu: pressing it again is its to shut (ContextMenu `anchor`). */
const menuAnchor = ref<HTMLElement | null>(null)

const toggleMenu = (menuName: string, event: MouseEvent): void => {
  if (activeMenu.value === menuName) {
    activeMenu.value = null
    return
  }
  const title = event.currentTarget as HTMLElement
  const rect = title.getBoundingClientRect()
  menuPosition.value = { x: rect.left, y: rect.bottom + 2 }
  menuAnchor.value = title
  activeMenu.value = menuName
}

/** Hovering another title-bar menu while one is open switches to it. */
const onMenuHover = (menuName: string, event: MouseEvent): void => {
  if (activeMenu.value && activeMenu.value !== menuName) toggleMenu(menuName, event)
}

const closeMenu = (): void => {
  activeMenu.value = null
}

const handleMinimize = (): void => {
  window.api.minimizeWindow()
}

const handleMaximize = (): void => {
  window.api.maximizeWindow()
}

const handleClose = (): void => {
  window.api.closeWindow()
}

const onMenuSelect = (id: string): void => {
  if (id.startsWith('new:')) {
    emit('create-typed-file', id.slice('new:'.length))
    return
  }
  // An edit command is named by its hotkey and runs by replaying it, so the
  // menu lands in the editor's own handler rather than a parallel code path.
  if (isEditActionId(editActions.value, id) || isEditActionId(navActions.value, id)) {
    dispatchEditAction(id as HotkeyActionId)
    return
  }
  if (runExportAction(exportActions.value, id)) return
  if (id.startsWith(RECENT_ID_PREFIX)) {
    const entry = props.recents[Number(id.slice(RECENT_ID_PREFIX.length))]
    if (entry) emit('open-recent', entry)
    return
  }
  // Replayed as the key, like the edit actions: App's handler for it is the one
  // implementation, menu or keyboard.
  const split = SPLIT_COMMANDS.find((command) => command.id === id)
  if (split) {
    dispatchEditAction(split.hotkey)
    return
  }
  if (isDesignPage(id)) {
    emit('open-design-page', id)
    return
  }
  switch (id) {
    case 'new-window':
      window.api.newWindow()
      break
    case 'open-folder':
      emit('open-folder')
      break
    case 'open-project':
      emit('open-project')
      break
    case 'open-file':
      emit('open-file')
      break
    case 'clear-recent':
      emit('clear-recent')
      break
    case 'new-project':
      emit('new-project')
      break
    case 'save':
      emit('save')
      break
    case 'save-as':
      emit('save-as')
      break
    case 'save-all':
      emit('save-all')
      break
    case 'export-netlist':
      emit('export-netlist')
      break
    case 'update-pcb':
      emit('update-pcb')
      break
    case 'exit':
      handleClose()
      break
    // Straight to main: F12 is handled there (`before-input-event`), which a
    // synthetic keydown never reaches, and it is dev-only besides — the menu
    // item is the one way into devtools in a packaged build.
    case 'dev-tools':
      window.api.toggleDevTools()
      break
    case 'welcome':
      emit('show-welcome')
      break
    case 'shortcuts':
      emit('show-shortcuts')
      break
    case 'feedback':
      emit('show-feedback')
      break
    case 'about':
      emit('show-about')
      break
    default:
      break
  }
}

const windowTitle = computed(() => {
  if (props.projectPath) {
    return t('titleBar.windowTitle.workspace', {
      tabPrefix: props.activeTabName ? `${props.activeTabName} — ` : '',
      project: props.projectName
    })
  }
  if (props.activeTabName) {
    return t('titleBar.windowTitle.tabOnly', { tab: props.activeTabName })
  }
  return t('titleBar.windowTitle.default')
})

// The window is frameless, so the OS never draws this title — but Mission
// Control, the taskbar and window switchers all read it. It is the in-app
// title plus, on Windows and Linux, the app's name, as their document windows
// name themselves ("file — Kate", "file - Word"); macOS leaves the name to the
// menu bar and the app icon. The in-app bar omits it: its logo already says it.
const osWindowTitle = computed(() =>
  isMac || (!props.activeTabName && !props.projectPath)
    ? windowTitle.value
    : t('titleBar.windowTitle.withApp', { title: windowTitle.value })
)
watchEffect(() => {
  document.title = osWindowTitle.value
})
</script>

<template>
  <header
    class="titlebar"
    :class="{ mac: isMac, inactive: !windowFocused, 'menu-open': !!activeMenu }"
  >
    <div class="titlebar-left">
      <!-- Branding is the Windows/Linux title bar's job: it is the only identity
           surface those platforms give the app. macOS already names it in the
           menu bar and the Dock, so the bar there carries the document title
           alone, as Mac windows are expected to. -->
      <div v-if="!isMac" class="titlebar-logo">
        <BrandWordmark />
      </div>

      <nav v-if="!isMac" class="titlebar-menu">
        <div
          v-for="name in SECTION_IDS"
          :key="name"
          class="menu-item"
          :class="{ open: activeMenu === name }"
          @click.stop="toggleMenu(name, $event)"
          @mouseenter="onMenuHover(name, $event)"
        >
          {{ t(`titleBar.menu.${name}`) }}
        </div>
      </nav>

      <ContextMenu
        v-if="activeMenu"
        :items="activeMenuItems"
        :x="menuPosition.x"
        :y="menuPosition.y"
        :anchor="menuAnchor"
        chrome
        @select="onMenuSelect"
        @close="closeMenu"
      />
    </div>

    <!-- Window Display Title -->
    <div class="titlebar-title">{{ windowTitle }}</div>

    <!-- Window control buttons (macOS has native traffic lights instead) -->
    <div v-if="!isMac" class="titlebar-controls">
      <button class="control-btn" :title="t('titleBar.controls.minimize')" @click="handleMinimize">
        <Icon name="window-minimize" />
      </button>
      <button class="control-btn" :title="t('titleBar.controls.maximize')" @click="handleMaximize">
        <Icon name="window-maximize" />
      </button>
      <button class="control-btn close" :title="t('titleBar.controls.close')" @click="handleClose">
        <Icon name="close-tight" />
      </button>
    </div>
  </header>
</template>
