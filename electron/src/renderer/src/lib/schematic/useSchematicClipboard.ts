/**
 * Copy, cut, paste, duplicate and repeat for the schematic editor — the
 * editor-side half of `schematicClipboard.ts`, which does the pure work.
 *
 * A paste, a duplicate and a repeated symbol FLOAT, as in KiCad: the items go
 * onto the sheet where they were copied from, the canvas hangs them from the
 * cursor (the viewport's floating move), and a click lands them. That is two
 * writes but one undo step: the first is taken back before the second, which
 * writes the items where they landed. Escape takes the first back and leaves
 * nothing.
 */

import { computed, nextTick, shallowRef, type ComputedRef, type Ref } from 'vue'
import type { KicadSchematic, Point } from '../kicad/schematic'
import { nm, type Nm } from '../kicad/coordinates'
import { tk, type MessageKey } from '../messageKey'
import { setClipboard, clipboardContents } from '../documentClipboard'
import type { SchematicItemRef } from '../engine/SchematicScene'
import type { SheetSession } from './sheetSession'
import type { AnnotateSource } from './annotate'
import type { PlacementStep } from './schematicMove'
import {
  anchorPoints,
  copySchematicSelection,
  insertPaste,
  itemRefsForUuids,
  nearestAnchor,
  nodeUuid,
  parseClipboard,
  pasteUuids,
  placePaste,
  preparePaste,
  serializeClipboard,
  sheetNamesOf,
  topLeftAnchor,
  type PreparedPaste,
  type SchematicClipboardContent
} from './schematicClipboard'
import {
  REPEATABLE_PLACEMENTS,
  SCHEMATIC_REPEAT_STEP,
  repeatContent,
  repeatFloats
} from './schematicRepeat'
import { getToken } from '../kicad/sexpr'

export interface FloatingViewport {
  /** Hang `items` from the cursor by `anchor` until a click lands them. */
  startFloat(items: SchematicItemRef[], anchor: Point): void
  /** The snapped cursor, when the pointer is over the canvas. */
  getCursor(): { point: Point } | null
}

export interface SchematicClipboardDeps {
  session: SheetSession
  schematic: () => KicadSchematic | null
  selectedItems: Ref<SchematicItemRef[]>
  readOnly: () => boolean
  viewport: () => FloatingViewport | null
  sheetPath: () => string
  instancePaths: () => string[]
  project: () => string
  sources: () => AnnotateSource[]
  grid: () => Nm
  /** Translate an undo label. */
  label: (key: MessageKey, count: number) => string
  /** The view's history counter, bumped after every step taken here. */
  historyChanged: () => void
  /** The editor's own delete, which cut reuses. */
  deleteSelected: () => void
  /** The system clipboard; absent in tests. */
  clipboard?: { read(): Promise<string>; write(text: string): void }
}

interface Floating {
  label: string
  prepared: PreparedPaste
  selectionBefore: SchematicItemRef[]
  /** A repeat's copy becomes the next repeat's source once it lands. */
  repeat: boolean
}

export interface SchematicClipboard {
  copy(): boolean
  cut(): void
  paste(): Promise<void>
  duplicate(): void
  repeat(): void
  canRepeat: ComputedRef<boolean>
  /** A paste hangs from the cursor. */
  floating: ComputedRef<boolean>
  /** The viewport's click: write the floating items where they landed. */
  land(delta: Point, steps: PlacementStep[]): void
  /** The viewport's Escape or right click: take the floating items back. */
  cancel(): void
  /** Called around every editor command, so a placement becomes the repeat source. */
  beforeCommand(label: string): (() => void) | null
}

export function useSchematicClipboard(deps: SchematicClipboardDeps): SchematicClipboard {
  const floatingState = shallowRef<Floating | null>(null)
  const repeatSource = shallowRef<SchematicClipboardContent | null>(null)

  const selectedRefs = (): SchematicItemRef[] =>
    deps.selectedItems.value.map((item) => ({ ...item }))

  const contentOfSelection = (): SchematicClipboardContent | null => {
    const doc = deps.schematic()
    if (!doc || !deps.selectedItems.value.length) return null
    const content = copySchematicSelection(doc, deps.selectedItems.value, deps.sheetPath())
    return content.items.length ? content : null
  }

  const copy = (): boolean => {
    const content = contentOfSelection()
    if (!content) return false
    const text = serializeClipboard(content)
    deps.clipboard?.write(text)
    setClipboard('schematic', [text])
    return true
  }

  const cut = (): void => {
    if (deps.readOnly() || floatingState.value) return
    if (copy()) deps.deleteSelected()
  }

  const target = (doc: KicadSchematic): Parameters<typeof preparePaste>[1] => ({
    sources: deps.sources(),
    instancePaths: deps.instancePaths(),
    project: deps.project(),
    libSymbols: doc.libSymbols,
    sheetNames: sheetNamesOf(doc)
  })

  const runStep = (
    label: string,
    prepared: PreparedPaste,
    selectionBefore: SchematicItemRef[],
    cleanup: boolean
  ): SchematicItemRef[] => {
    const uuids = pasteUuids(prepared)
    let placed: SchematicItemRef[] = []
    deps.session.runCommand(
      label,
      () => {
        const doc = deps.schematic()
        if (doc) insertPaste(doc, prepared)
      },
      {
        cleanup,
        selection: {
          before: selectionBefore,
          after: () => {
            const doc = deps.session.document()
            placed = doc ? (itemRefsForUuids(doc, uuids) as SchematicItemRef[]) : []
            return placed.map((item) => ({ ...item }))
          }
        }
      }
    )
    deps.historyChanged()
    deps.selectedItems.value = placed
    return placed
  }

  /** Write `prepared` shifted and turned as it landed, as one step. */
  const commit = (
    label: string,
    prepared: PreparedPaste,
    selectionBefore: SchematicItemRef[],
    steps: PlacementStep[],
    delta: Point,
    repeat: boolean
  ): void => {
    const placed = placePaste(prepared, steps, delta, {
      sheetPath: deps.sheetPath(),
      grid: deps.grid()
    })
    const refs = runStep(label, placed, selectionBefore, true)
    if (repeat) rememberRepeat(refs)
  }

  const float = async (
    label: string,
    prepared: PreparedPaste,
    anchorFor: (points: Point[]) => Point | null,
    repeat: boolean
  ): Promise<void> => {
    const selectionBefore = selectedRefs()
    const refs = runStep(label, prepared, selectionBefore, false)
    if (!refs.length) return
    floatingState.value = { label, prepared, selectionBefore, repeat }
    // The canvas redraws the sheet with the items on it before they can hang.
    await nextTick()
    const doc = deps.schematic()
    const anchor = doc ? anchorFor(anchorPoints(doc, refs)) : null
    const view = deps.viewport()
    if (floatingState.value?.prepared !== prepared) return
    // Nowhere to hang them from: they land where they were copied from.
    if (!anchor || !view) land({ x: nm(0), y: nm(0) }, [])
    else view.startFloat(refs, anchor)
  }

  /** Take the floating items back off the sheet, returning what floated. */
  const unfloat = (): Floating | null => {
    const state = floatingState.value
    if (!state) return null
    floatingState.value = null
    // Only ever the step that put them down: an agent's edit landing
    // mid-float is left standing, and the paste with it.
    const entry = deps.session.undo()
    if (entry && entry.label !== state.label) {
      deps.session.redo()
      deps.historyChanged()
      return null
    }
    deps.selectedItems.value = state.selectionBefore
    deps.historyChanged()
    return state
  }

  const land = (delta: Point, steps: PlacementStep[]): void => {
    const state = unfloat()
    if (!state) return
    commit(state.label, state.prepared, state.selectionBefore, steps, delta, state.repeat)
  }

  const cancel = (): void => {
    unfloat()
  }

  const pasteContent = (
    content: SchematicClipboardContent,
    label: string,
    anchorFor: (points: Point[]) => Point | null
  ): void => {
    const doc = deps.schematic()
    if (!doc || deps.readOnly() || floatingState.value) return
    void float(label, preparePaste(content, target(doc)), anchorFor, false)
  }

  const paste = async (): Promise<void> => {
    if (deps.readOnly() || floatingState.value) return
    let text: string
    try {
      text = (await deps.clipboard?.read()) ?? ''
    } catch {
      text = ''
    }
    let content = parseClipboard(text)
    if (!content) {
      const held = clipboardContents()
      content = held?.kind === 'schematic' ? parseClipboard(held.items.join('\n')) : null
    }
    if (!content) return
    pasteContent(
      content,
      deps.label(tk('commandLabels.paste'), content.items.length),
      topLeftAnchor
    )
  }

  /**
   * KiCad's Duplicate: the selection pasted from a clipboard of its own, hung
   * by its point nearest the cursor.
   */
  const duplicate = (): void => {
    const content = contentOfSelection()
    if (!content) return
    const cursor = deps.viewport()?.getCursor()?.point
    pasteContent(
      content,
      deps.label(tk('commandLabels.duplicate'), content.items.length),
      (points) => (cursor ? nearestAnchor(points, cursor) : topLeftAnchor(points))
    )
  }

  const rememberRepeat = (refs: SchematicItemRef[]): void => {
    const doc = deps.schematic()
    if (!doc || !refs.length) return
    repeatSource.value = copySchematicSelection(doc, refs, deps.sheetPath())
  }

  const canRepeat = computed(() => !!repeatSource.value)

  const repeat = (): void => {
    const source = repeatSource.value
    const doc = deps.schematic()
    if (!source || !doc || deps.readOnly() || floatingState.value) return
    const next = repeatContent(source)
    const prepared = preparePaste(next, target(doc))
    const label = deps.label(tk('commandLabels.repeat'), next.items.length)
    if (repeatFloats(next)) {
      void float(label, prepared, topLeftAnchor, true)
      return
    }
    commit(label, prepared, selectedRefs(), [], SCHEMATIC_REPEAT_STEP, true)
  }

  const itemUuids = (doc: KicadSchematic): Set<string> => {
    const uuids = new Set<string>()
    for (const child of doc._root.children) {
      const uuid = child.type === 'list' ? nodeUuid(child) : undefined
      if (uuid) uuids.add(uuid)
    }
    return uuids
  }

  const beforeCommand = (label: string): (() => void) | null => {
    const match = REPEATABLE_PLACEMENTS.find(([key]) => deps.label(key, 1) === label)
    const doc = deps.schematic()
    if (!match || !doc) return null
    const before = itemUuids(doc)
    const tokens = new Set(match[1])
    return () => {
      const after = deps.session.document()
      if (!after) return
      const added = after._root.children.flatMap((child) => {
        if (child.type !== 'list' || !tokens.has(getToken(child) ?? '')) return []
        const uuid = nodeUuid(child)
        return uuid && !before.has(uuid) ? [uuid] : []
      })
      const refs = itemRefsForUuids(after, added) as SchematicItemRef[]
      if (refs.length) rememberRepeat(refs)
    }
  }

  return {
    copy,
    cut,
    paste,
    duplicate,
    repeat,
    canRepeat,
    floating: computed(() => !!floatingState.value),
    land,
    cancel,
    beforeCommand
  }
}
