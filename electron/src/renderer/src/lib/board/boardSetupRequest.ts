/**
 * Which section Board Setup should show when it next opens or is in front.
 *
 * Board Setup is its own tab (`goatcad://board-setup/`), with its own editor
 * mount, so a request from the board's canvas — the size list's "Edit sizes…"
 * opens Net Classes — cannot be a prop of the editor that makes it. It waits
 * here, keyed by board, for the setup tab's editor to read; `seq` makes the
 * same section asked for twice a new request.
 */
import { computed, reactive, type ComputedRef } from 'vue'
import type { SectionId } from './boardSetupSchema'

export interface BoardSetupSectionRequest {
  id: SectionId
  seq: number
}

const requests = reactive(new Map<string, BoardSetupSectionRequest>())
let seq = 0

/** Ask a board's Board Setup to show a section. */
export const requestBoardSetupSection = (boardPath: string, id: SectionId): void => {
  requests.set(boardPath, { id, seq: ++seq })
}

/** The latest section asked of a board's Board Setup, or null. */
export const boardSetupSectionRequest = (
  boardPath: () => string | null | undefined
): ComputedRef<BoardSetupSectionRequest | null> =>
  computed(() => {
    const path = boardPath()
    return (path && requests.get(path)) || null
  })
