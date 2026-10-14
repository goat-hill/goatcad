/**
 * The KiCad version of every design file as it is read (RULES.md §7,
 * format-migration-workstream.md). An older file is migrated in memory on
 * load — editors, sessions and agents only ever see KiCad 10's — and written
 * as such on its first save; a newer one, or one from before KiCad 6, is
 * opened read-only. Nothing here writes to disk.
 *
 * A schematic from before 20221110 keeps its hierarchy's instance data in the
 * root, so its sheets migrate together (`moveLegacyInstances`): the first one
 * read resolves the hierarchy from disk and migrates every sheet, and they are
 * saved together (`saveGroupOf`), with the project file.
 */
import { shallowReactive } from 'vue'
import {
  formatOfToken,
  kicadReleaseOf,
  versionStatus,
  migrateToCurrent,
  moveLegacyInstances,
  type FormatStatus,
  type KicadFormat
} from './kicad/migrate'
import { findChild, getAtomValues, parseSExpr, serializeSExpr, type SExprList } from './kicad/sexpr'
import { basenameOf, dirnameOf, resolveRelativePath, samePath } from './kicad/paths'
import { browserHierarchyFs, resolveHierarchy, type HierarchyFs } from './schematic/hierarchy'
import { migrateProjectFile, type ProjectHierarchy } from './kicad/project'
import type { SchematicHierarchy } from './schematic/hierarchy'

export interface FileFormatState {
  format: KicadFormat
  /** The `(version …)` the file was read at. */
  version: number
  status: FormatStatus
  /** The KiCad release that wrote it; null past the newest we know. */
  release: number | null
}

const EXTENSIONS: Record<string, KicadFormat> = {
  '.kicad_sch': 'kicad_sch',
  '.kicad_pcb': 'kicad_pcb',
  '.kicad_sym': 'kicad_symbol_lib',
  '.kicad_mod': 'footprint'
}

const formatOfPath = (path: string): KicadFormat | null => {
  const lower = path.toLowerCase()
  const ext = Object.keys(EXTENSIONS).find((candidate) => lower.endsWith(candidate))
  return ext ? EXTENSIONS[ext] : null
}

/** The root token and version from a file's head, without parsing the rest. */
const HEADER = /^\s*\(\s*([a-z_]+)[^(]*\(\s*version\s+(\d+)\s*\)/

/** A file's format state from its head; null for text that is not one. */
export function sniffFormat(text: string): FileFormatState | null {
  const match = HEADER.exec(text.slice(0, 4096))
  const format = match ? formatOfToken(match[1]) : null
  if (!match || !format) return null
  const version = Number(match[2])
  return {
    format,
    version,
    status: versionStatus(format, version),
    release: kicadReleaseOf(format, version)
  }
}

/** Before this a schematic's root holds its hierarchy's instance data. */
const LEGACY_INSTANCES_BEFORE = 20221110

/** A legacy hierarchy, migrated together. */
interface LegacyGroup {
  files: string[]
  migrated: Map<string, string>
  projectFile: string
  project: ProjectHierarchy
}

const stemOf = (path: string): string => basenameOf(path).replace(/\.kicad_sch$/i, '')

const projectFileOf = (rootFile: string): string => rootFile.replace(/\.kicad_sch$/i, '.kicad_pro')

/** The hierarchy as the project file records it; the root's uuid from its parsed text. */
const projectHierarchyOf = (hierarchy: SchematicHierarchy, root: SExprList): ProjectHierarchy => ({
  rootFile: basenameOf(hierarchy.rootFilePath),
  rootUuid: getAtomValues(findChild(root, 'uuid') ?? root)[0] ?? '',
  rootName: stemOf(hierarchy.rootFilePath),
  sheets: hierarchy.instances
    .filter((instance) => instance.depth > 0)
    .map((instance) => [instance.sheetPath.split('/').pop() ?? '', instance.sheetName])
})

export interface FormatUpgrader {
  /** The text an editor gets for a file just read from disk. */
  upgrade(path: string, text: string): Promise<string>
  /** What the file was when read; undefined for one never read through here. */
  stateOf(path: string): FileFormatState | undefined
  /** Opened read-only: newer than we write, or older than we open. */
  isReadOnly(path: string): boolean
  /** Read at an older version, not yet saved at the current one. */
  isPendingUpgrade(path: string): boolean
  /**
   * The files a save of this one must write with it — every sheet of a legacy
   * hierarchy — with the project file and what it becomes, or null.
   */
  saveGroupOf(
    path: string
  ): { files: string[]; projectFile: string; project: ProjectHierarchy } | null
  /** Migrated text for a group member no tab holds. */
  migratedText(path: string): string | undefined
  /** The file is now on disk at the current version. */
  noteSaved(path: string): void
  /**
   * The project file of this schematic's hierarchy as KiCad 10's first save
   * leaves it, or null when there is none or nothing changes. Never creates one.
   */
  projectUpgrade(path: string): Promise<{ file: string; text: string } | null>
}

export function createFormatUpgrader(fs: HierarchyFs): FormatUpgrader {
  const states = shallowReactive(new Map<string, FileFormatState>())
  const groups = new Map<string, Promise<LegacyGroup | null>>()
  const key = (path: string): string => path.replace(/[\\/]+/g, '/')

  const migrateOne = (text: string): string => {
    const root = parseSExpr(text)
    if (root.type !== 'list' || !migrateToCurrent(root)) return text
    return `${serializeSExpr(root)}\n`
  }

  const legacyGroup = async (rootFile: string): Promise<LegacyGroup | null> => {
    const hierarchy = await resolveHierarchy(fs, rootFile)
    const roots = new Map<string, SExprList>()
    for (const file of hierarchy.files) {
      const text = await fs.readFile(file)
      const parsed = text === null ? null : parseSExpr(text)
      if (parsed?.type !== 'list') continue
      roots.set(key(file), parsed)
      // Every member is saved with the group, opened or not.
      const state = sniffFormat(text!)
      if (state && !states.has(key(file))) states.set(key(file), state)
    }
    const root = roots.get(key(hierarchy.rootFilePath))
    if (!root) return null
    const pathOf = new Map([...roots].map(([path, ast]) => [ast, path]))
    const name = stemOf(hierarchy.rootFilePath)
    moveLegacyInstances(root, name, (sheetFile, parent) =>
      roots.get(key(resolveRelativePath(dirnameOf(pathOf.get(parent) ?? ''), sheetFile)))
    )
    const migrated = new Map<string, string>()
    for (const [path, ast] of roots) {
      migrateToCurrent(ast)
      migrated.set(path, `${serializeSExpr(ast)}\n`)
    }
    return {
      files: hierarchy.files,
      migrated,
      projectFile: projectFileOf(hierarchy.rootFilePath),
      project: projectHierarchyOf(hierarchy, root)
    }
  }

  // Whether a folder holds any schematic old enough to root a legacy group: a
  // header sniff, once per folder, so a modern hierarchy's sheets are not each
  // resolved (every sheet parsed) to learn there is no group.
  const legacyDirs = new Map<string, Promise<boolean>>()
  const holdsLegacySchematic = (dir: string): Promise<boolean> => {
    let pending = legacyDirs.get(key(dir))
    if (!pending) {
      pending = (async () => {
        for (const file of await fs.listSchematics(dir)) {
          const text = await fs.readFile(file)
          const state = text === null ? null : sniffFormat(text)
          if (state?.status === 'older' && state.version < LEGACY_INSTANCES_BEFORE) return true
        }
        return false
      })()
      legacyDirs.set(key(dir), pending)
    }
    return pending
  }

  const groupFor = async (path: string): Promise<LegacyGroup | null> => {
    for (const pending of groups.values()) {
      const group = await pending
      if (group?.files.some((file) => samePath(file, path))) return group
    }
    if (!(await holdsLegacySchematic(dirnameOf(path)))) return null
    const hierarchy = await resolveHierarchy(fs, path)
    const rootText = await fs.readFile(hierarchy.rootFilePath)
    const rootState = rootText === null ? null : sniffFormat(rootText)
    if (!rootState || rootState.status !== 'older' || rootState.version >= LEGACY_INSTANCES_BEFORE)
      return null
    const rootKey = key(hierarchy.rootFilePath)
    if (!groups.has(rootKey)) groups.set(rootKey, legacyGroup(hierarchy.rootFilePath))
    return groups.get(rootKey)!
  }

  const settledGroups = new Map<string, LegacyGroup>()

  return {
    async upgrade(path, text) {
      if (!formatOfPath(path)) return text
      const state = sniffFormat(text)
      if (!state) return text
      states.set(key(path), state)
      if (state.status !== 'older') return text
      if (state.format === 'kicad_sch') {
        const group = await groupFor(path)
        if (group) {
          for (const file of group.files) settledGroups.set(key(file), group)
          return group.migrated.get(key(path)) ?? migrateOne(text)
        }
      }
      return migrateOne(text)
    },
    stateOf: (path) => states.get(key(path)),
    isReadOnly(path) {
      const status = states.get(key(path))?.status
      return status === 'newer' || status === 'unsupported'
    },
    isPendingUpgrade: (path) => states.get(key(path))?.status === 'older',
    saveGroupOf(path) {
      const group = settledGroups.get(key(path))
      if (!group || !group.files.some((file) => states.get(key(file))?.status !== 'current'))
        return null
      return { files: group.files, projectFile: group.projectFile, project: group.project }
    },
    migratedText: (path) => settledGroups.get(key(path))?.migrated.get(key(path)),
    async projectUpgrade(path) {
      const group = settledGroups.get(key(path))
      let file = group?.projectFile
      let project = group?.project
      if (!file || !project) {
        const hierarchy = await resolveHierarchy(fs, path)
        const rootText = await fs.readFile(hierarchy.rootFilePath)
        const root = rootText === null ? null : parseSExpr(rootText)
        if (root?.type !== 'list') return null
        file = projectFileOf(hierarchy.rootFilePath)
        project = projectHierarchyOf(hierarchy, root)
      }
      const text = await fs.readFile(file)
      if (text === null) return null
      const migrated = migrateProjectFile(text, project)
      return migrated === null || migrated === text ? null : { file, text: migrated }
    },
    noteSaved(path) {
      const state = states.get(key(path))
      if (state && state.status === 'older') {
        states.set(key(path), { ...state, status: 'current' })
      }
    }
  }
}

/** The app's one upgrader, over the disk as it is. */
export const formatUpgrader = createFormatUpgrader(browserHierarchyFs)
