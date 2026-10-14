/**
 * The rename pipeline — plan → preview → apply → verify
 * (docs/projects.md §8.2). A rename is modelled as an edit to
 * a set of files: the renamed file plus every file whose reference resolved to
 * it. The registry (references.ts) supplies the "which references" half; this
 * module sequences the filesystem work so a mid-batch failure rolls back to the
 * pre-rename state rather than leaving a half-forwarded project.
 *
 * Pure over an injected `RenameIo`, so the whole pipeline is unit-testable
 * against an in-memory filesystem. The dirty-buffer rule of §5.3 (never write
 * disk-side behind an open unsaved editor) lives one layer up in App.vue, which
 * owns editor state; it passes such files as `skipDiskFiles` and rewrites their
 * buffers itself. Everything here is disk-authoritative.
 */
import { basenameOf, dirnameOf, rebaseReference, samePath, separatorOf } from '../kicad/paths'
import {
  applyReferenceRewrites,
  enumerateReferences,
  type FoundReference,
  type ReferenceKindId,
  type ReferenceRewrite
} from '../kicad/references'

export interface RenameIo {
  readFile(path: string): Promise<string | null>
  writeFile(path: string, content: string): Promise<{ success: boolean; error?: string }>
  rename(from: string, to: string): Promise<{ success: boolean; error?: string }>
}

/** One reference, in some other file, to rewrite so it follows the rename. */
export interface PlannedEdit {
  sourceFile: string
  kind: ReferenceKindId
  oldValue: string
  newValue: string
  span: { start: number; end: number }
  quoted: boolean
}

export interface RenamePlan {
  /** Absolute path being renamed. */
  targetPath: string
  /** New basename (not a path). */
  newName: string
  /** Absolute path after the rename. */
  newPath: string
  /** Rewrites in files *other than* the renamed one. Empty ⇒ a plain rename. */
  edits: PlannedEdit[]
}

/** Absolute path a same-directory rename produces. */
export const renamedPath = (targetPath: string, newName: string): string => {
  const parent = dirnameOf(targetPath)
  return `${parent}${separatorOf(targetPath)}${newName}`
}

/**
 * Walk the candidate files, resolve every reference, and keep the ones pointing
 * at the target — each becomes a concrete edit (old value, new value, span).
 * The candidate set is the caller's concern (the active project's files); the
 * scan is bounded by it and each file is read and parsed once.
 */
export const planRename = async (
  targetPath: string,
  newName: string,
  candidateFiles: readonly string[],
  io: Pick<RenameIo, 'readFile'>
): Promise<RenamePlan> => {
  const edits: PlannedEdit[] = []
  for (const file of candidateFiles) {
    // The renamed file's own name change is the rename itself, not a reference.
    if (samePath(file, targetPath)) continue
    const text = await io.readFile(file)
    if (text === null) continue
    for (const ref of enumerateReferences(file, text)) {
      if (ref.resolved && samePath(ref.resolved, targetPath)) {
        edits.push({
          sourceFile: file,
          kind: ref.kind,
          oldValue: ref.rawValue,
          newValue: rebaseReference(ref.rawValue, newName),
          span: ref.span,
          quoted: ref.quoted
        })
      }
    }
  }
  return { targetPath, newName, newPath: renamedPath(targetPath, newName), edits }
}

/** Per-file rollup for the preview: which files change, and how many references. */
export interface PreviewFile {
  sourceFile: string
  fileName: string
  count: number
}

export const previewFiles = (plan: RenamePlan): PreviewFile[] => {
  const counts = new Map<string, number>()
  for (const edit of plan.edits) {
    counts.set(edit.sourceFile, (counts.get(edit.sourceFile) ?? 0) + 1)
  }
  return [...counts.entries()].map(([sourceFile, count]) => ({
    sourceFile,
    fileName: basenameOf(sourceFile),
    count
  }))
}

/**
 * New text for one file's *buffer* after a rename. An open unsaved buffer's
 * content differs from the disk the plan was computed against, so its
 * references must be re-found against the live text — the plan's spans don't
 * apply. Returns the input unchanged when nothing in it points at the target.
 */
export const rewriteBufferText = (
  sourceFile: string,
  text: string,
  targetPath: string,
  newName: string
): string => {
  const rewrites: ReferenceRewrite[] = enumerateReferences(sourceFile, text)
    .filter((ref) => ref.resolved && samePath(ref.resolved, targetPath))
    .map((ref) => ({
      span: ref.span,
      quoted: ref.quoted,
      newValue: rebaseReference(ref.rawValue, newName)
    }))
  return rewrites.length ? applyReferenceRewrites(text, rewrites) : text
}

/**
 * Files that reference the target, for a delete confirmation (§4.4). Deleting
 * routes to the OS trash, so there is no rewrite — the point is informed
 * consent: the caller warns that these files will be left with a dangling
 * reference.
 */
export const planDelete = async (
  targetPath: string,
  candidateFiles: readonly string[],
  io: Pick<RenameIo, 'readFile'>
): Promise<{ referrers: PreviewFile[] }> => {
  const counts = new Map<string, number>()
  for (const file of candidateFiles) {
    if (samePath(file, targetPath)) continue
    const text = await io.readFile(file)
    if (text === null) continue
    for (const ref of enumerateReferences(file, text)) {
      if (ref.resolved && samePath(ref.resolved, targetPath)) {
        counts.set(file, (counts.get(file) ?? 0) + 1)
      }
    }
  }
  return {
    referrers: [...counts.entries()].map(([sourceFile, count]) => ({
      sourceFile,
      fileName: basenameOf(sourceFile),
      count
    }))
  }
}

export interface ApplyResult {
  ok: boolean
  error?: string
  /** Files written to disk, with their new content, so callers can sync open buffers. */
  written: Map<string, string>
}

const normKey = (path: string): string => path.replace(/[\\/]+/g, '/').toLowerCase()

/**
 * Apply the plan in the fixed order §5.2 prescribes:
 *   1. compute every new file content in memory (abort clean on any failure),
 *   2. rename the file itself (abort before touching references if it fails),
 *   3. write the referencing files, rolling back writes + the rename on failure.
 * Files in `skipDiskFiles` are left to the caller (open, unsaved — §5.3).
 */
export const applyRename = async (
  plan: RenamePlan,
  io: RenameIo,
  options: { skipDiskFiles?: readonly string[] } = {}
): Promise<ApplyResult> => {
  const skip = new Set((options.skipDiskFiles ?? []).map(normKey))

  const editsByFile = new Map<string, ReferenceRewrite[]>()
  for (const edit of plan.edits) {
    if (skip.has(normKey(edit.sourceFile))) continue
    const list = editsByFile.get(edit.sourceFile) ?? []
    list.push({ span: edit.span, quoted: edit.quoted, newValue: edit.newValue })
    editsByFile.set(edit.sourceFile, list)
  }

  // 1. In-memory contents + pre-images. A parse/rewrite miss aborts with nothing written.
  const preImages = new Map<string, string>()
  const newContents = new Map<string, string>()
  for (const [file, rewrites] of editsByFile) {
    const text = await io.readFile(file)
    if (text === null) {
      return { ok: false, error: `Could not read ${basenameOf(file)}`, written: new Map() }
    }
    preImages.set(file, text)
    newContents.set(file, applyReferenceRewrites(text, rewrites))
  }

  // 2. Rename the file itself.
  const renameRes = await io.rename(plan.targetPath, plan.newPath)
  if (!renameRes.success) {
    return { ok: false, error: renameRes.error ?? 'Rename failed', written: new Map() }
  }

  // 3. Write referencing files; on failure restore pre-images and reverse the rename.
  const written = new Map<string, string>()
  for (const [file, content] of newContents) {
    const res = await io.writeFile(file, content)
    if (!res.success) {
      for (const done of written.keys()) {
        const pre = preImages.get(done)
        if (pre !== undefined) await io.writeFile(done, pre)
      }
      await io.rename(plan.newPath, plan.targetPath)
      return {
        ok: false,
        error: res.error ?? `Could not write ${basenameOf(file)}`,
        written: new Map()
      }
    }
    written.set(file, content)
  }

  return { ok: true, written }
}

/**
 * Assert no reference still resolves to the old target path. Run over the
 * files the caller deems disk-authoritative (excluding buffers handled in
 * memory). Turns "we think we got them all" into a checkable postcondition.
 */
export const verifyRename = async (
  plan: RenamePlan,
  candidateFiles: readonly string[],
  io: Pick<RenameIo, 'readFile'>
): Promise<{ dangling: FoundReference[] }> => {
  const dangling: FoundReference[] = []
  for (const file of candidateFiles) {
    const path = samePath(file, plan.targetPath) ? plan.newPath : file
    const text = await io.readFile(path)
    if (text === null) continue
    for (const ref of enumerateReferences(path, text)) {
      if (ref.resolved && samePath(ref.resolved, plan.targetPath)) dangling.push(ref)
    }
  }
  return { dangling }
}
