import { describe, expect, it } from 'vitest'
import { parseKicadBoard } from '../../../kicad/board'
import { DEFAULT_BOARD_PALETTE, boardPalette, resolveStackupColor } from '../boardPalette'

const withStackup = (maskColor: string, silkColor: string): string => `
(kicad_pcb (version 20221018) (generator pcbnew)
  (general (thickness 1.6))
  (layers (0 "F.Cu" signal) (31 "B.Cu" signal))
  (setup
    (stackup
      (layer "F.SilkS" (type "Top Silk Screen") (color "${silkColor}"))
      (layer "F.Mask" (type "Top Solder Mask") (thickness 0.01) (color "${maskColor}"))
      (layer "F.Cu" (type "copper") (thickness 0.035))))
  (net 0 ""))
`

describe('resolveStackupColor', () => {
  const named = { green: '#00ff00' }

  it('maps a KiCad finish name, case-insensitively', () => {
    expect(resolveStackupColor('Green', named)).toBe('#00ff00')
    expect(resolveStackupColor('green', named)).toBe('#00ff00')
  })

  it('passes a literal hex through, dropping any alpha', () => {
    expect(resolveStackupColor('#123456', named)).toBe('#123456')
    expect(resolveStackupColor('#12345680', named)).toBe('#123456')
  })

  it('returns null for absent or unknown values, so the caller can default', () => {
    expect(resolveStackupColor(undefined, named)).toBeNull()
    expect(resolveStackupColor('Chartreuse', named)).toBeNull()
    expect(resolveStackupColor('#12', named)).toBeNull()
  })
})

describe('boardPalette', () => {
  it('is the default set for a board with no stackup', () => {
    const board = parseKicadBoard(
      '(kicad_pcb (version 20221018) (layers (0 "F.Cu" signal)) (net 0 ""))'
    )
    expect(boardPalette(board)).toEqual(DEFAULT_BOARD_PALETTE)
    expect(boardPalette(null)).toEqual(DEFAULT_BOARD_PALETTE)
  })

  it('adopts the stackup mask and silk colors', () => {
    const palette = boardPalette(parseKicadBoard(withStackup('Black', 'White')))
    expect(palette.mask).toBe('#151515')
    expect(palette.silk).toBe('#e6e8e4')
  })

  it('derives masked copper from the mask, so traces stay visible on black', () => {
    const black = boardPalette(parseKicadBoard(withStackup('Black', 'White')))
    expect(black.maskedCopper).not.toBe(black.mask)
    // Pulled toward copper: strictly lighter than the mask it sits under.
    const luma = (hex: string): number =>
      parseInt(hex.slice(1, 3), 16) + parseInt(hex.slice(3, 5), 16) + parseInt(hex.slice(5, 7), 16)
    expect(luma(black.maskedCopper)).toBeGreaterThan(luma(black.mask))
  })

  it('accepts a custom hex mask', () => {
    expect(boardPalette(parseKicadBoard(withStackup('#2b0a4f', 'White'))).mask).toBe('#2b0a4f')
  })
})

describe('boardPalette per side and overrides', () => {
  const sides = (front: string, back: string): string => `
(kicad_pcb (version 20221018) (generator pcbnew)
  (general (thickness 1.6))
  (layers (0 "F.Cu" signal) (31 "B.Cu" signal))
  (setup
    (stackup
      (layer "F.SilkS" (type "Top Silk Screen")${front})
      (layer "F.Mask" (type "Top Solder Mask") (thickness 0.01) (color "Black"))
      (layer "F.Cu" (type "copper") (thickness 0.035))
      (layer "B.Cu" (type "copper") (thickness 0.035))
      (layer "B.SilkS" (type "Bottom Silk Screen")${back})))
  (net 0 ""))
`

  it('reads each side its own silk ink', () => {
    const palette = boardPalette(parseKicadBoard(sides(' (color "Black")', ' (color "White")')))
    expect(palette.silk).toBe('#141414')
    expect(palette.backSilk).toBe('#e6e8e4')
  })

  it('draws a side with no ink in the default white, as KiCad does', () => {
    const palette = boardPalette(parseKicadBoard(sides('', ' (color "Black")')))
    expect(palette.silk).toBe('#e6e8e4')
    expect(palette.backSilk).toBe('#141414')
  })

  it('draws an override over the stackup, on both sides', () => {
    const board = parseKicadBoard(sides(' (color "White")', ' (color "White")'))
    const palette = boardPalette(board, { mask: 'Green', silk: '#ffcc00' })
    expect(palette.mask).toBe('#177a41')
    expect(palette.silk).toBe('#ffcc00')
    expect(palette.backSilk).toBe('#ffcc00')
    expect(palette.maskedCopper).not.toBe(boardPalette(board).maskedCopper)
  })
})
