import { describe, expect, it } from 'vitest'
import {
  chooseRows,
  commandTitle,
  symbolFit,
  withRecent,
  type ChooserItem,
  type ChooserOptions,
  type ChooserRow
} from '../libraryChooser'

const item = (id: string, extra: Partial<ChooserItem> = {}): ChooserItem => {
  const [library, name] = id.split(':')
  return {
    id,
    name,
    library,
    description: '',
    keywords: '',
    scope: 'system',
    count: 0,
    ...extra
  }
}

const options = (extra: Partial<ChooserOptions> = {}): ChooserOptions => ({
  query: '',
  inDesign: new Set(),
  recent: [],
  ...extra
})

const rowsOf = (groups: ReturnType<typeof chooseRows>): ChooserRow[] =>
  groups.flatMap((group) => group.rows())
const ids = (groups: ReturnType<typeof chooseRows>): string[] =>
  rowsOf(groups).map((r) => r.item.id)

describe('chooseRows', () => {
  const items = [
    item('Device:R'),
    item('Device:C'),
    item('Device:R_Small'),
    item('Device:LED'),
    item('Connector:Conn_01x04')
  ]
  const keys = (groups: ReturnType<typeof chooseRows>): Array<[string, number]> =>
    groups.map((group) => [group.key, group.count])

  it('pins the design and recent picks above one group per library, alphabetical', () => {
    const result = chooseRows(
      items,
      options({ inDesign: new Set(['Device:LED']), recent: ['Device:R_Small', 'Device:C'] })
    )
    expect(keys(result)).toEqual([
      ['section:design', 1],
      ['section:recent', 2],
      ['library:Connector', 1],
      ['library:Device', 4]
    ])
    // Recent keeps pick order; a library keeps name order.
    expect(result[1].rows().map((r) => r.item.id)).toEqual(['Device:R_Small', 'Device:C'])
    expect(result[3].rows().map((r) => r.item.name)).toEqual(['C', 'LED', 'R', 'R_Small'])
  })

  it('puts an exact name before a prefix before a match anywhere, and its library first', () => {
    const result = chooseRows(
      [item('Alpha:Resonator_X'), ...items, item('Zeta:Board', { description: 'r' })],
      options({ query: 'r' })
    )
    expect(result[0].key).toBe('library:Device')
    expect(ids(result).slice(0, 2)).toEqual(['Device:R', 'Device:R_Small'])
  })

  it('searches description and keywords, every word', () => {
    const result = chooseRows(
      [item('Device:D', { description: 'Diode', keywords: 'rectifier' }), item('Device:R')],
      options({ query: 'diode rect' })
    )
    expect(ids(result)).toEqual(['Device:D'])
  })

  it('pins what fits the symbol above the libraries, which still list everything', () => {
    const fps = [
      item('Package_SO:SOIC-8', { count: 8 }),
      item('Package_SO:SOIC-14', { count: 14 }),
      item('Package_DFN:DFN-8', { count: 8 })
    ]
    const fit = symbolFit((i) => i.name.startsWith('SOIC'), 8)
    const result = chooseRows(fps, options({ fit }))
    expect(result.map((group) => [group.key, group.count])).toEqual([
      ['section:fits', 1],
      ['library:Package_DFN', 1],
      ['library:Package_SO', 2]
    ])
    expect(result[0].rows()[0]).toMatchObject({ item: { id: 'Package_SO:SOIC-8' }, fits: true })
    // SOIC-8 before SOIC-14: numeric order.
    expect(result[2].rows().map((r) => r.fits)).toEqual([true, false])
  })
})

describe('symbolFit', () => {
  it('fits everything when there is nothing to fit', () => {
    expect(symbolFit(null, 0)).toBeUndefined()
  })

  it('takes the pin count alone when the symbol has no filters', () => {
    const fit = symbolFit(null, 2)!
    expect(fit(item('R:R_0402', { count: 2 }))).toBe(true)
    expect(fit(item('R:SOT-23', { count: 3 }))).toBe(false)
  })
})

describe('withRecent', () => {
  it('moves a repeat pick to the front and bounds the list', () => {
    expect(withRecent(['a', 'b', 'c'], 'b', 3)).toEqual(['b', 'a', 'c'])
    expect(withRecent(['a', 'b', 'c'], 'd', 3)).toEqual(['d', 'a', 'b'])
  })
})

describe('commandTitle', () => {
  it('drops the ellipsis a command carries before its dialog', () => {
    expect(commandTitle('Choose footprint…')).toBe('Choose footprint')
    expect(commandTitle('Place footprint')).toBe('Place footprint')
  })
})
