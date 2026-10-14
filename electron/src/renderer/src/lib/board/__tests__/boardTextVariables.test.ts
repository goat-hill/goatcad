import { describe, expect, test } from 'vitest'
import { parseKicadBoard } from '../../kicad/board'
import { shownTextOf } from '../boardTexts'

const board = (titleBlock: string): ReturnType<typeof parseKicadBoard> =>
  parseKicadBoard(`(kicad_pcb (version 20241229) (generator "test")
  (general (thickness 1.6))
  ${titleBlock}
  (layers (0 "F.Cu" signal) (31 "B.Cu" signal))
  (property "REVISION" "69")
)`)

const shown = (
  b: ReturnType<typeof parseKicadBoard>,
  variables: Record<string, string> = {}
): string => shownTextOf(b, 'TEST ${REVISION}', 'F.Cu', undefined, { variables })

describe('board text variables', () => {
  test('the title block answers its own fields first, a blank one included', () => {
    expect(shown(board('(title_block (rev "B"))'), { REVISION: '7' })).toBe('TEST B')
    expect(shown(board(''), { REVISION: '7' })).toBe('TEST ')
  })
})
