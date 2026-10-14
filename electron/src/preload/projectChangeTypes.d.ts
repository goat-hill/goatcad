/**
 * The project change bus's event vocabulary
 * (docs/projects.md §9). Shared by main and the renderer,
 * so it lives here with the other cross-process types.
 *
 * The grain is a **committed file**, never a document edit: a symbol dragged
 * across a schematic notifies nobody, because nothing outside the editor can act
 * on a half-finished document and broadcasting per-edit would be a firehose. A
 * save, create, rename, delete or library registration is what the index, the
 * hierarchy, git and the choosers all derive from.
 */

/** The design file types a change can concern; anything else is `other`. */
export type ProjectFileType =
  'schematic' | 'board' | 'symbol-library' | 'footprint' | 'project' | 'other'

export type ProjectChange =
  | {
      kind: 'file-created' | 'file-deleted' | 'file-changed'
      path: string
      fileType: ProjectFileType
    }
  | { kind: 'file-renamed'; from: string; to: string; fileType: ProjectFileType }
  | {
      kind: 'library-registered' | 'library-unregistered'
      scope: 'global' | 'project'
      nickname: string
    }

/**
 * One coalesced batch, tagged with the workspace it happened in. Two windows can
 * hold the same project open and main is their only common point, so the root is
 * what lets a receiving window decide whether the batch concerns it at all.
 */
export interface ProjectChangeBatch {
  /** Workspace root the changes happened under; null for a workspace-less window. */
  root: string | null
  changes: ProjectChange[]
}
