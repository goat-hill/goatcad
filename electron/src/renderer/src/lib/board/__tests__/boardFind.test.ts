import { describe, expect, test } from 'vitest'
import { parseKicadBoard } from '../../kicad/board'
import { FIND_TEXT_DEFAULTS, findHits } from '../../canvasFind'
import { boardFindCandidates } from '../boardFind'

const board = parseKicadBoard(`(kicad_pcb (version 20241229) (generator "test")
  (layers (0 "F.Cu" signal) (31 "B.Cu" signal) (37 "F.SilkS" user))
  (net 0 "") (net 1 "GND") (net 2 "VBUS") (net 3 "/M.2/PCIe_{C1x1}.TX0+")
  (footprint "T:R" (layer "F.Cu") (at 110 120)
    (property "Reference" "R1" (at 0 0) (layer "F.SilkS"))
    (property "Value" "10k" (at 0 1) (layer "F.Fab"))
    (pad "1" smd rect (at 0 0) (size 1 1) (layers "F.Cu") (net 1 "GND")))
  (footprint "T:C" (layer "F.Cu") (at 100 130)
    (property "Reference" "C1" (at 0 0) (layer "F.SilkS"))
    (property "Value" "GND filter" (at 0 1) (layer "F.Fab")))
  (gr_text "Rev A" (at 90 90) (layer "F.SilkS"))
  (gr_text "hidden" (at 95 90) (layer "F.SilkS") hide)
)`)

const find = (query: string): Array<{ type: string; text: string }> =>
  findHits(boardFindCandidates(board), query, FIND_TEXT_DEFAULTS).map((hit) => ({
    type: hit.target.type,
    text: hit.text
  }))

describe('boardFindCandidates', () => {
  test('finds references and values, selecting the footprint', () => {
    const [hit] = findHits(boardFindCandidates(board), 'R1', FIND_TEXT_DEFAULTS)
    expect(hit.target).toEqual({ type: 'footprint', index: 0 })
    expect(find('10k')).toEqual([{ type: 'footprint', text: '10k' }])
  })

  test('finds board texts, but not a hidden one', () => {
    expect(find('Rev')).toEqual([{ type: 'gr_text', text: 'Rev A' }])
    expect(find('hidden')).toEqual([])
  })

  test('finds net names after every placed hit, and never the unnamed net', () => {
    expect(find('GND')).toEqual([
      { type: 'footprint', text: 'GND filter' },
      { type: 'net', text: 'GND' }
    ])
    const [net] = findHits(boardFindCandidates(board), 'VBUS', FIND_TEXT_DEFAULTS)
    expect(net.target).toEqual({ type: 'net', net: 2 })
    expect(boardFindCandidates(board).some((c) => c.target.type === 'net' && c.text === '')).toBe(
      false
    )
  })

  test('finds a text as it reads, its markup dropped', () => {
    expect(find('PCIeC1x1.TX0')).toEqual([{ type: 'net', text: '/M.2/PCIeC1x1.TX0+' }])
    expect(find('_{')).toEqual([])
  })
})
