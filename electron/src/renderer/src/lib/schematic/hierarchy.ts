/**
 * KiCad hierarchical-sheet resolution. A project is a tree of sheet instances
 * rooted at one .kicad_sch: every `(sheet ...)` node names a child file
 * (Sheetfile) and carries a UUID that, chained from the root, forms the
 * hierarchical path used to key per-instance symbol references. The tree lives
 * entirely in the schematic files — the .kicad_pro only names the root (by
 * basename). The same child file can be instantiated more than once (repeated
 * sheets), so the unit of identity here is the sheet *instance* (a path), not
 * the file.
 *
 * The resolver is filesystem-agnostic: callers inject a HierarchyFs so the walk
 * is unit-testable without Electron. `browserHierarchyFs` binds it to window.api.
 */
import { basenameOf, dirnameOf, resolveRelativePath, samePath } from '../kicad/paths'
import {
  getSheetProperty,
  parseKicadSchematic,
  type KicadSchematic,
  type KicadSheet
} from '../kicad/schematic'
import { comparePages, rootPageOf, sheetPageOf } from './sheetPages'

export interface HierarchyFs {
  /** Read a file's text, or null when it does not exist / can't be read. */
  readFile(path: string): Promise<string | null>
  /** Absolute paths of every *.kicad_sch directly in the given directory. */
  listSchematics(dir: string): Promise<string[]>
}

/** One instantiation of a sheet somewhere in the hierarchy. */
export interface SheetInstance {
  /** Hierarchical path keying symbol references: `/<root-uuid>/<sheet-uuid>/...`. */
  sheetPath: string
  /** Human path built from sheet names: `/`, `/USB`, `/Power/Reg`. */
  namePath: string
  /** Leaf sheet name (Sheetname), or the root file's stem for the root. */
  sheetName: string
  /** Absolute path of the .kicad_sch backing this instance. */
  filePath: string
  /** 0 for the root sheet, increasing with nesting. */
  depth: number
  /** The page this instance is numbered with, when the file gives one. */
  page?: string
}

export interface SchematicHierarchy {
  rootFilePath: string
  /**
   * Pre-order, root first, each sheet's children in KiCad's hierarchy-navigator
   * order: by page, ties by position (`childrenInOrder`).
   */
  instances: SheetInstance[]
  /** Distinct file paths involved, in first-seen order. */
  files: string[]
}

// ---- path helpers (separator-preserving, cross-platform) ------------------
// The generic ones live in paths.ts, shared with the reference registry; only
// the .kicad_sch-specific stem helper is local here.

const stemOf = (path: string): string => basenameOf(path).replace(/\.kicad_sch$/i, '')

// ---- walking --------------------------------------------------------------

interface LoadResult {
  schematic: KicadSchematic
  content: string
}

/** Cache reads/parses so a sheet reused N times is only parsed once. */
class SheetCache {
  private readonly cache = new Map<string, LoadResult | null>()
  constructor(private readonly fs: HierarchyFs) {}

  async load(filePath: string): Promise<LoadResult | null> {
    const key = filePath.replace(/[\\/]+/g, '/').toLowerCase()
    const cached = this.cache.get(key)
    if (cached !== undefined) return cached
    const content = await this.fs.readFile(filePath)
    let result: LoadResult | null = null
    if (content && content.trim()) {
      try {
        result = { schematic: parseKicadSchematic(content), content }
      } catch {
        result = null
      }
    }
    this.cache.set(key, result)
    return result
  }
}

/** Discover the project root for an arbitrary open schematic file. */
const findRootFile = async (
  fs: HierarchyFs,
  filePath: string,
  cache: SheetCache
): Promise<string> => {
  const dir = dirnameOf(filePath)
  if (!dir) return filePath

  const siblings = await fs.listSchematics(dir)
  if (siblings.length <= 1) return filePath

  // Any file referenced as a child by some sibling can't be the root.
  const referenced = new Set<string>()
  for (const sibling of siblings) {
    const loaded = await cache.load(sibling)
    if (!loaded) continue
    const base = dirnameOf(sibling)
    for (const sheet of loaded.schematic.sheets) {
      const sheetFile = getSheetProperty(sheet, 'Sheetfile')
      if (sheetFile)
        referenced.add(
          resolveRelativePath(base, sheetFile)
            .replace(/[\\/]+/g, '/')
            .toLowerCase()
        )
    }
  }
  const isReferenced = (path: string): boolean =>
    referenced.has(path.replace(/[\\/]+/g, '/').toLowerCase())

  // If the open file itself is a top-level sheet, keep it as its own root
  // rather than jumping to an unrelated project in the same folder.
  if (!isReferenced(filePath)) return filePath

  const roots = siblings.filter((sibling) => !isReferenced(sibling))
  if (!roots.length) return filePath

  // Prefer the root whose tree actually contains the open file; on ties fall
  // back to a project-file basename match, then the first root.
  for (const root of roots) {
    const tree = await walkFrom(fs, root, cache)
    if (tree.files.some((file) => samePath(file, filePath))) return root
  }
  return roots[0]
}

/**
 * A sheet's children as KiCad's hierarchy navigator lists them: collected by
 * position (`SCH_SCREEN::GetSheets` — x, then y, then uuid), then sorted by
 * the page each is numbered with under this instance
 * (`SCH_SHEET_PATH::ComparePageNum`), a tie keeping the position order.
 */
export const childrenInOrder = (
  sheets: readonly KicadSheet[],
  parentPath: string
): Array<{ sheet: KicadSheet; page: string | undefined }> =>
  [...sheets]
    .sort(
      (a, b) =>
        a.position.x - b.position.x ||
        a.position.y - b.position.y ||
        ((a.uuid ?? '') < (b.uuid ?? '') ? -1 : (a.uuid ?? '') > (b.uuid ?? '') ? 1 : 0)
    )
    .map((sheet) => ({ sheet, page: sheetPageOf(sheet, parentPath) }))
    .sort((a, b) => comparePages(a.page, b.page))

/** Build the instance tree from a known root file. */
const walkFrom = async (
  fs: HierarchyFs,
  rootFilePath: string,
  cache = new SheetCache(fs)
): Promise<SchematicHierarchy> => {
  const instances: SheetInstance[] = []
  const files: string[] = []
  const seenFile = new Set<string>()

  const rootLoaded = await cache.load(rootFilePath)
  const rootUuid = rootLoaded?.schematic.uuid ?? ''
  const rootPath = `/${rootUuid}`
  // The root sheet has no parent Sheetname; its human name is the title-block
  // title, falling back to the file stem.
  const rootName = rootLoaded?.schematic.title || stemOf(rootFilePath)

  const visit = async (
    filePath: string,
    sheetPath: string,
    namePath: string,
    sheetName: string,
    depth: number,
    page: string | undefined,
    ancestorFiles: readonly string[]
  ): Promise<void> => {
    const loaded = await cache.load(filePath)
    const fileKey = filePath.replace(/[\\/]+/g, '/').toLowerCase()
    if (!seenFile.has(fileKey)) {
      seenFile.add(fileKey)
      files.push(filePath)
    }
    instances.push({ sheetPath, namePath, sheetName, filePath, depth, page })
    if (!loaded) return

    const base = dirnameOf(filePath)
    for (const { sheet, page: childPage } of childrenInOrder(loaded.schematic.sheets, sheetPath)) {
      const sheetFile = getSheetProperty(sheet, 'Sheetfile')
      if (!sheet.uuid || !sheetFile) continue
      const childPath = resolveRelativePath(base, sheetFile)
      // Stop real file cycles (A→B→A); repeated sheets across branches are fine.
      if (ancestorFiles.some((ancestor) => samePath(ancestor, childPath))) continue
      const childName = getSheetProperty(sheet, 'Sheetname') ?? stemOf(childPath)
      const childNamePath = namePath === '/' ? `/${childName}` : `${namePath}/${childName}`
      await visit(
        childPath,
        `${sheetPath}/${sheet.uuid}`,
        childNamePath,
        childName,
        depth + 1,
        childPage,
        [...ancestorFiles, filePath]
      )
    }
  }

  const rootPage = rootLoaded ? rootPageOf(rootLoaded.schematic) : undefined
  await visit(rootFilePath, rootPath, '/', rootName, 0, rootPage, [])
  return { rootFilePath, instances, files }
}

/**
 * Resolve the full hierarchy for whichever project the given file belongs to.
 * Editing the parent or any child yields the same comprehensive tree.
 */
export const resolveHierarchy = async (
  fs: HierarchyFs,
  filePath: string
): Promise<SchematicHierarchy> => {
  const cache = new SheetCache(fs)
  const rootFilePath = await findRootFile(fs, filePath, cache)
  return walkFrom(fs, rootFilePath, cache)
}

/**
 * Resolve every root hierarchy among a set of schematic files. A project can
 * hold several independent boards, so there can be several roots: any file
 * referenced as a child by another is not one; each remaining file seeds a
 * tree. Trees are returned sorted by root display name.
 */
export const resolveForest = async (
  fs: HierarchyFs,
  files: string[]
): Promise<SchematicHierarchy[]> => {
  const cache = new SheetCache(fs)
  const referenced = new Set<string>()
  for (const file of files) {
    const loaded = await cache.load(file)
    if (!loaded) continue
    const base = dirnameOf(file)
    for (const sheet of loaded.schematic.sheets) {
      const sheetFile = getSheetProperty(sheet, 'Sheetfile')
      if (sheetFile) {
        referenced.add(
          resolveRelativePath(base, sheetFile)
            .replace(/[\\/]+/g, '/')
            .toLowerCase()
        )
      }
    }
  }
  const roots = files.filter((file) => !referenced.has(file.replace(/[\\/]+/g, '/').toLowerCase()))
  // A pure reference cycle (A→B→A) leaves nothing unreferenced; fall back to
  // treating every file as a root so no schematic disappears.
  const rootList = roots.length ? roots : files
  const trees: SchematicHierarchy[] = []
  for (const root of rootList) trees.push(await walkFrom(fs, root, cache))
  trees.sort((a, b) =>
    (a.instances[0]?.sheetName ?? '').localeCompare(b.instances[0]?.sheetName ?? '')
  )
  return trees
}

/**
 * What a sheet's text says about the tree — its sheets' names, files and
 * pages — as one string, read without parsing. Two texts with the same key
 * resolve to the same tree, so a view re-resolves only when it moves: a page
 * renumbered, a sheet added, renamed or removed.
 */
export const sheetStructureKey = (text: string): string =>
  (text.match(/\((?:page|property\s+"Sheet(?:name|file)")\s+"(?:[^"\\]|\\.)*"/g) ?? []).join('\n')

// ---- Electron-backed filesystem -------------------------------------------

export const browserHierarchyFs: HierarchyFs = {
  async readFile(path) {
    const result = await window.api.readFile(path)
    return result.success && result.content !== undefined ? result.content : null
  },
  async listSchematics(dir) {
    const entries = await window.api.readDirectory(dir)
    return entries
      .filter(
        (entry): entry is { name: string; path: string; isDirectory: boolean } =>
          typeof entry === 'object' &&
          entry !== null &&
          typeof (entry as { path?: unknown }).path === 'string' &&
          !(entry as { isDirectory?: unknown }).isDirectory
      )
      .filter((entry) => entry.name.toLowerCase().endsWith('.kicad_sch'))
      .map((entry) => entry.path)
  }
}
