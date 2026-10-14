import type { FindCandidate } from '../canvasFind'
import type { KicadBoard } from '../kicad/board'
import { markupToPlainText } from '../kicad/textMarkup'

/**
 * What a board find hit selects: a footprint (its reference or value
 * matched), a board text, or every item on a net.
 */
export type BoardFindTarget =
  | { type: 'footprint'; index: number }
  | { type: 'gr_text'; index: number }
  | { type: 'net'; net: number }

/**
 * The texts the board finds, as KiCad's Find dialog reads a board: footprint
 * references and values (a hit selects the footprint), board texts, and net
 * names. Board space, nm, y down. A net has no one place, so its hits follow
 * the placed ones. Each is found as it reads — markup dropped, escapes
 * unescaped — so `PCIeC1x1` finds the net stored `PCIe_{C1x1}`; a board find
 * only selects, so nothing needs the stored form's offsets.
 */
export function boardFindCandidates(board: KicadBoard): FindCandidate<BoardFindTarget>[] {
  const found: FindCandidate<BoardFindTarget>[] = []
  board.footprints.forEach((fp, index) => {
    const position = { x: fp.position.x, y: fp.position.y }
    const target: BoardFindTarget = { type: 'footprint', index }
    if (fp.reference)
      found.push({
        key: `footprint:${index}:ref`,
        target,
        text: markupToPlainText(fp.reference),
        position
      })
    if (fp.value)
      found.push({
        key: `footprint:${index}:value`,
        target,
        text: markupToPlainText(fp.value),
        position
      })
  })
  board.grTexts.forEach((text, index) => {
    if (!text.position || text.hide || !text.text) return
    found.push({
      key: `gr_text:${index}`,
      target: { type: 'gr_text', index },
      text: markupToPlainText(text.text),
      position: { x: text.position.x, y: text.position.y }
    })
  })
  for (const net of board.nets) {
    if (net.number <= 0 || !net.name) continue
    found.push({
      key: `net:${net.number}`,
      target: { type: 'net', net: net.number },
      text: markupToPlainText(net.name)
    })
  }
  return found
}
