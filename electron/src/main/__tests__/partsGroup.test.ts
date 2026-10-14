import { describe, it, expect } from 'vitest'
import {
  groupParts,
  groupKey,
  normalizeManufacturer,
  normalizeMpn,
  worstLifecycle
} from '../partsGroup'
import type { PartRecord, PartsProviderId } from '../../preload/partsTypes'

const record = (
  over: Partial<PartRecord> & { provider: PartsProviderId; mpn: string }
): PartRecord => ({
  providerPartId: `${over.provider}-${over.mpn}`,
  manufacturer: 'STMicroelectronics',
  description: '',
  datasheetUrl: null,
  photoUrl: null,
  productUrl: null,
  lifecycle: 'unknown',
  rohs: null,
  parameters: [],
  offers: [],
  cad: { mode: 'none' },
  fetchedAt: 0,
  ...over
})

describe('normalizeMpn', () => {
  it('folds case and whitespace, which are always noise', () => {
    expect(normalizeMpn('  stm32f103c8t6 ')).toBe('STM32F103C8T6')
    expect(normalizeMpn('STM32 F103')).toBe('STM32F103')
  })

  it('keeps hyphens, which can be meaningful', () => {
    // LM358-N and LM358N are genuinely different orderable parts; folding the
    // hyphen away would merge two components into one row.
    expect(normalizeMpn('LM358-N')).not.toBe(normalizeMpn('LM358N'))
  })
})

describe('normalizeManufacturer', () => {
  it('ignores corporate suffixes and punctuation', () => {
    expect(normalizeManufacturer('Texas Instruments Inc.')).toBe(
      normalizeManufacturer('Texas Instruments')
    )
    expect(normalizeManufacturer('STMicroelectronics')).toBe(
      normalizeManufacturer('ST Microelectronics')
    )
  })

  it('still separates genuinely different makers', () => {
    expect(normalizeManufacturer('Texas Instruments')).not.toBe(normalizeManufacturer('Onsemi'))
  })
})

describe('groupKey', () => {
  it('includes the manufacturer, because generic part numbers collide', () => {
    // Any number of vendors sell an "LM358"; merging them would present two
    // different components as one row.
    const ti = record({ provider: 'digikey', mpn: 'LM358', manufacturer: 'Texas Instruments' })
    const onsemi = record({ provider: 'mouser', mpn: 'LM358', manufacturer: 'Onsemi' })
    expect(groupKey(ti)).not.toBe(groupKey(onsemi))
  })
})

describe('groupParts', () => {
  it('puts one row per part with a source per distributor', () => {
    const groups = groupParts([
      record({ provider: 'digikey', mpn: 'STM32F103C8T6' }),
      record({ provider: 'mouser', mpn: 'stm32f103c8t6 ', manufacturer: 'STMicroelectronics Inc.' })
    ])
    expect(groups).toHaveLength(1)
    expect(groups[0].sources.map((s) => s.provider)).toEqual(['digikey', 'mouser'])
  })

  it('never blends a distributor record — each stays whole in its own source', () => {
    const digikey = record({ provider: 'digikey', mpn: 'X', offers: [] })
    const mouser = record({ provider: 'mouser', mpn: 'X', offers: [] })
    const [group] = groupParts([digikey, mouser])
    expect(group.sources[0].record).toBe(digikey)
    expect(group.sources[1].record).toBe(mouser)
  })

  it('keeps different parts apart', () => {
    const groups = groupParts([
      record({ provider: 'digikey', mpn: 'LM358', manufacturer: 'Texas Instruments' }),
      record({ provider: 'digikey', mpn: 'LM358', manufacturer: 'Onsemi' }),
      record({ provider: 'digikey', mpn: 'LM324', manufacturer: 'Texas Instruments' })
    ])
    expect(groups).toHaveLength(3)
  })

  it('ignores one provider listing the same part twice', () => {
    // A pagination artifact, not a second seller.
    const groups = groupParts([
      record({ provider: 'digikey', mpn: 'X', providerPartId: 'a' }),
      record({ provider: 'digikey', mpn: 'X', providerPartId: 'b' })
    ])
    expect(groups[0].sources).toHaveLength(1)
  })

  it("keeps every distributor's datasheet link, in source order", () => {
    // One manufacturer's page refuses a plain request where another
    // distributor's own copy does not, so the fetch needs all of them.
    const groups = groupParts([
      record({ provider: 'digikey', mpn: 'X', datasheetUrl: 'https://mfr.example/x.pdf' }),
      record({ provider: 'mouser', mpn: 'X', datasheetUrl: 'https://mouser.example/x.pdf' })
    ])
    expect(groups[0].datasheetUrls).toEqual([
      { provider: 'digikey', url: 'https://mfr.example/x.pdf' },
      { provider: 'mouser', url: 'https://mouser.example/x.pdf' }
    ])
    expect(groups[0].datasheetUrl).toBe('https://mfr.example/x.pdf')
  })

  it('lists no link for a distributor that published none', () => {
    const groups = groupParts([
      record({ provider: 'digikey', mpn: 'X' }),
      record({ provider: 'mouser', mpn: 'X', datasheetUrl: 'https://mouser.example/x.pdf' })
    ])
    expect(groups[0].datasheetUrls).toEqual([
      { provider: 'mouser', url: 'https://mouser.example/x.pdf' }
    ])
  })

  it('fills a shared field from whichever provider knew it', () => {
    const groups = groupParts([
      record({ provider: 'digikey', mpn: 'X', description: '', datasheetUrl: null }),
      record({
        provider: 'mouser',
        mpn: 'X',
        description: 'ARM MCU',
        datasheetUrl: 'https://example.com/d.pdf'
      })
    ])
    expect(groups[0].description).toBe('ARM MCU')
    expect(groups[0].datasheetUrl).toBe('https://example.com/d.pdf')
  })

  it('takes the most cautionary lifecycle any distributor reported', () => {
    // A buyer needs to see "obsolete" even when the other catalog still says
    // active — the pessimistic answer is the safe one here.
    const groups = groupParts([
      record({ provider: 'digikey', mpn: 'X', lifecycle: 'active' }),
      record({ provider: 'mouser', mpn: 'X', lifecycle: 'obsolete' })
    ])
    expect(groups[0].lifecycle).toBe('obsolete')
  })

  it('preserves result order, so the first provider searched leads', () => {
    const groups = groupParts([
      record({ provider: 'digikey', mpn: 'B' }),
      record({ provider: 'digikey', mpn: 'A' })
    ])
    expect(groups.map((g) => g.mpn)).toEqual(['B', 'A'])
  })

  it('drops a record with no part number, since there is nothing to group on', () => {
    expect(groupParts([record({ provider: 'digikey', mpn: '  ' })])).toEqual([])
  })
})

describe('worstLifecycle', () => {
  it('ranks obsolete over nrnd over active', () => {
    expect(worstLifecycle(['active', 'nrnd'])).toBe('nrnd')
    expect(worstLifecycle(['nrnd', 'obsolete'])).toBe('obsolete')
  })

  it('lets a real answer beat unknown — not knowing is not evidence', () => {
    expect(worstLifecycle(['unknown', 'active'])).toBe('active')
    expect(worstLifecycle(['unknown', 'unknown'])).toBe('unknown')
  })
})
