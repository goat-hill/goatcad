/**
 * Project-tier library registration, shared by the Libraries navigator and the
 * Project view's per-group `New / Add` affordances. "New" is create-then-
 * register; "Add" is register-an-existing — the *same* registration path, so we
 * never grow two (docs/projects.md §7.5).
 *
 * Project tier only: the URI is written `${KIPRJMOD}`-relative wherever the
 * target sits inside the project folder, so the entry still resolves on a
 * collaborator's clone. Global-tier registration stays on the Libraries
 * navigator (it is a machine-wide choice, not a project one).
 */
import {
  TABLE_FILENAME,
  addLibraryToTable,
  pathIsInside,
  projectLibUri,
  tableNicknames,
  uniqueNickname,
  type LibraryTableKind
} from './kicad/libraryTableWrite'
import { blankFileContent, uniqueFileName } from './project/scaffold'

/** The `.kicad_sym` file / `.pretty` directory each library kind is spelled as. */
export const LIBRARY_EXTENSION: Record<LibraryTableKind, string> = {
  symbol: '.kicad_sym',
  footprint: '.pretty'
}

/** Last path segment, tolerating either separator. */
const baseName = (path: string): string => path.split(/[/\\]/).pop() || 'library'

/** The nickname a library path defaults to — its stem, since `lib_id` is `Nickname:Name`. */
const nicknameFor = (libraryPath: string): string =>
  baseName(libraryPath).replace(/\.(kicad_sym|pretty)$/i, '')

/**
 * Register an existing `.kicad_sym` file or `.pretty` directory into the
 * project's own table (created if absent). Returns the nickname assigned — the
 * target's stem, uniquified, since the nickname is the part's identity
 * (`lib_id` is `Nickname:Name`).
 */
export async function registerProjectLibrary(
  kind: LibraryTableKind,
  projectPath: string,
  libraryPath: string
): Promise<string> {
  const fileName = TABLE_FILENAME[kind]
  const { content, dir } = await window.api.readProjectLibTable(projectPath, fileName)
  const projectDir = dir ?? projectPath
  const nickname = uniqueNickname(nicknameFor(libraryPath), content ? tableNicknames(content) : [])
  const next = addLibraryToTable(content, kind, nickname, projectLibUri(libraryPath, projectDir))
  const res = await window.api.writeProjectLibTable(projectPath, fileName, next)
  if (!res.success) throw new Error(res.error)
  return nickname
}

/**
 * Create an empty library named `name` in the project directory, then register
 * it. A symbol library is one `.kicad_sym` file; a footprint library is a
 * `.pretty` directory. The name is taken up front (unlike New Schematic/PCB's
 * create-then-rename) because the nickname is fixed at registration and
 * nickname-rename is out for alpha (§9). Returns the created path.
 */
export async function createProjectLibrary(
  kind: LibraryTableKind,
  projectPath: string,
  projectDir: string,
  name: string
): Promise<string> {
  if (kind === 'symbol') {
    const path = `${projectDir}/${name}.kicad_sym`
    const res = await window.api.createFile(
      path,
      blankFileContent('symbol-library', `${name}.kicad_sym`)
    )
    if (!res.success) throw new Error(res.error)
    await registerProjectLibrary(kind, projectPath, path)
    return path
  }
  const path = `${projectDir}/${name}.pretty`
  const res = await window.api.createDirectory(path)
  if (!res.success) throw new Error(res.error)
  await registerProjectLibrary(kind, projectPath, path)
  return path
}

/**
 * Copy the library into the project, or point at where it already lives.
 *
 * Copy is the default because a referenced library is only as durable as the
 * folder it was downloaded into: reorganize `~/Downloads` and the project's
 * parts vanish, and a collaborator never had that path at all. Reference stays
 * available for the genuinely shared library (a team's network `.pretty`), the
 * case KiCad optimizes for by only ever referencing (§4.5 decision 2).
 */
export type AddLibraryMode = 'copy' | 'reference'

/**
 * What an Add would do, resolved before anything is written — the model behind
 * the choice dialog. Pure, so the destination naming and the "no choice to
 * make" rule are unit-testable without a filesystem.
 */
export interface AddLibraryPlan {
  kind: LibraryTableKind
  /** Absolute path the user picked. */
  source: string
  /** Its file or directory name, for the dialog title. */
  sourceName: string
  /** Absolute path a copy would land at, uniquified against the project folder. */
  copyTarget: string
  /**
   * True when the source already sits inside the project folder. Copying it
   * would duplicate a file the project already carries, so the choice is not
   * offered and the reference is recorded `${KIPRJMOD}`-relative regardless.
   */
  alreadyInProject: boolean
}

export function planAddLibrary(
  kind: LibraryTableKind,
  source: string,
  projectDir: string,
  projectSiblings: string[]
): AddLibraryPlan {
  const sourceName = baseName(source)
  const extension = LIBRARY_EXTENSION[kind]
  const stem = sourceName.toLowerCase().endsWith(extension)
    ? sourceName.slice(0, -extension.length)
    : sourceName
  return {
    kind,
    source,
    sourceName,
    copyTarget: `${projectDir}/${uniqueFileName(stem, extension, projectSiblings)}`,
    alreadyInProject: pathIsInside(source, projectDir)
  }
}

/** The URI the table will carry — what the dialog shows, verbatim. */
export function plannedUri(plan: AddLibraryPlan, mode: AddLibraryMode, projectDir: string): string {
  return projectLibUri(mode === 'copy' ? plan.copyTarget : plan.source, projectDir)
}

/**
 * Run an add: copy first (so a failed copy registers nothing), then register
 * through the one path above.
 */
export async function addLibraryToProject(
  plan: AddLibraryPlan,
  mode: AddLibraryMode,
  projectPath: string
): Promise<string> {
  if (mode === 'reference' || plan.alreadyInProject) {
    return registerProjectLibrary(plan.kind, projectPath, plan.source)
  }
  const res = await window.api.copyPath(plan.source, plan.copyTarget)
  if (!res.success) throw new Error(res.error)
  return registerProjectLibrary(plan.kind, projectPath, plan.copyTarget)
}
