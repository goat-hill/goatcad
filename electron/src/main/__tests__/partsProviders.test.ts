import { describe, it, expect } from 'vitest'
import { asCount, asPrice, asUrl, errorKindForStatus, PROVIDER_INFO } from '../partsProviders'
import { mouserLifecycle, mouserSearchOption, normalizeMouserPart } from '../partsMouser'
import {
  buildFilterOptions,
  buildSortOptions,
  cadFromMediaLinks,
  digikeyLifecycle,
  normalizeCategories,
  normalizeDigikeyProduct,
  normalizeFacets
} from '../partsDigikey'
import { emptyFilterState } from '../partsProviders'

describe('foreign-value readers', () => {
  it('reads a count out of grouped display text', () => {
    expect(asCount(1234)).toBe(1234)
    expect(asCount('10,000 In Stock')).toBe(10_000)
    expect(asCount('10 000')).toBe(10_000)
    expect(asCount('')).toBeNull()
    // "unknown stock" and "none in stock" are different answers.
    expect(asCount(undefined)).toBeNull()
    expect(asCount('0')).toBe(0)
  })

  it('reads a localized currency string, disambiguating the decimal mark', () => {
    expect(asPrice(0.34)).toBe(0.34)
    expect(asPrice('$0.34')).toBe(0.34)
    expect(asPrice('£12.00')).toBe(12)
    // Comma-decimal locales: the separator that appears *last* is the decimal.
    expect(asPrice('1,50 €')).toBe(1.5)
    expect(asPrice('1.234,56 €')).toBe(1234.56)
    expect(asPrice('1,234.56')).toBe(1234.56)
    expect(asPrice('N/A')).toBeNull()
  })

  it('rejects a non-URL placeholder', () => {
    expect(asUrl('https://example.com/d.pdf')).toBe('https://example.com/d.pdf')
    expect(asUrl('N/A')).toBeNull()
    expect(asUrl('/images/foo.png')).toBeNull()
    expect(asUrl('')).toBeNull()
  })

  it('separates a bad key from an unsubscribed product', () => {
    expect(errorKindForStatus(401)).toBe('invalid-credentials')
    expect(errorKindForStatus(403)).toBe('forbidden')
    expect(errorKindForStatus(429)).toBe('rate-limited')
    expect(errorKindForStatus(503)).toBe('provider-error')
  })
})

describe('provider registry', () => {
  it('describes each provider entirely as data, so a card needs no per-provider code', () => {
    for (const info of Object.values(PROVIDER_INFO)) {
      expect(info.registrationUrl).toMatch(/^https:\/\//)
      expect(info.fields.length).toBeGreaterThan(0)
      expect(info.quota.perDay).toBeGreaterThan(0)
    }
    // The shapes genuinely differ — one key vs. an id/secret pair.
    expect(PROVIDER_INFO.mouser.fields.map((f) => f.key)).toEqual(['apiKey'])
    expect(PROVIDER_INFO.digikey.fields.map((f) => f.key)).toEqual(['clientId', 'clientSecret'])
  })

  it('marks every secret field secret, so none is ever rendered back', () => {
    expect(PROVIDER_INFO.mouser.fields[0].secret).toBe(true)
    // A DigiKey Client ID is an identifier, not a credential — shown on purpose.
    expect(PROVIDER_INFO.digikey.fields[0].secret).toBe(false)
    expect(PROVIDER_INFO.digikey.fields[1].secret).toBe(true)
  })
})

describe('normalizeMouserPart', () => {
  // Field names per Mouser's own published Swagger (api.mouser.com/api/docs/V1).
  const part = {
    MouserPartNumber: '511-STM32F103C8T6',
    ManufacturerPartNumber: 'STM32F103C8T6',
    Manufacturer: 'STMicroelectronics',
    Description: 'ARM Microcontrollers - MCU',
    Availability: '1,024 In Stock',
    Min: '1',
    DataSheetUrl: 'https://example.com/stm32.pdf',
    ProductDetailUrl: 'https://www.mouser.com/x',
    ImagePath: 'https://example.com/x.jpg',
    ROHSStatus: 'RoHS Compliant',
    LifecycleStatus: 'Active',
    Category: 'ARM Microcontrollers - MCU',
    PriceBreaks: [
      { Quantity: 1, Price: '$3.34', Currency: 'USD' },
      { Quantity: 100, Price: '$2.80', Currency: 'USD' }
    ],
    ProductAttributes: [
      { AttributeName: 'Core', AttributeValue: 'ARM Cortex M3' },
      { AttributeName: 'Packaging', AttributeValue: 'Tray' }
    ]
  }

  it('maps a real-shaped part onto the normalized record', () => {
    const result = normalizeMouserPart(part, 1000)
    expect(result).toMatchObject({
      provider: 'mouser',
      mpn: 'STM32F103C8T6',
      manufacturer: 'STMicroelectronics',
      lifecycle: 'active',
      rohs: 'RoHS Compliant',
      datasheetUrl: 'https://example.com/stm32.pdf'
    })
    expect(result?.parameters).toEqual([
      { name: 'Core', value: 'ARM Cortex M3', parameterId: null },
      { name: 'Packaging', value: 'Tray', parameterId: null }
    ])
    expect(result?.offers[0]).toMatchObject({
      distributorPartNumber: '511-STM32F103C8T6',
      stock: 1024,
      moq: 1,
      currency: 'USD',
      packaging: 'Tray'
    })
    expect(result?.offers[0].priceBreaks).toEqual([
      { quantity: 1, unitPrice: 3.34 },
      { quantity: 100, unitPrice: 2.8 }
    ])
  })

  it('reads packaging from the Packaging attributes, never the category', () => {
    const reeled = {
      ...part,
      ProductAttributes: [
        { AttributeName: 'Packaging', AttributeValue: 'Reel' },
        { AttributeName: 'Packaging', AttributeValue: 'Cut Tape' }
      ]
    }
    expect(normalizeMouserPart(reeled, 1000)?.offers[0].packaging).toBe('Reel, Cut Tape')
    expect(
      normalizeMouserPart({ ...part, ProductAttributes: [] }, 1000)?.offers[0].packaging
    ).toBeNull()
  })

  it('reports no CAD, because Mouser exposes none through its API', () => {
    expect(normalizeMouserPart(part, 1000)?.cad).toEqual({ mode: 'none' })
  })

  it('survives a payload with every optional field missing', () => {
    const result = normalizeMouserPart({ ManufacturerPartNumber: 'R-1' }, 1000)
    expect(result).toMatchObject({ mpn: 'R-1', manufacturer: '', lifecycle: 'unknown' })
    expect(result?.offers[0].priceBreaks).toEqual([])
    expect(result?.offers[0].stock).toBeNull()
  })

  it('drops an entry with no part number at all — nothing to bind', () => {
    expect(normalizeMouserPart({ Description: 'mystery' }, 1000)).toBeNull()
    expect(normalizeMouserPart('not an object', 1000)).toBeNull()
  })

  it('sorts price breaks by quantity regardless of payload order', () => {
    const result = normalizeMouserPart(
      {
        ManufacturerPartNumber: 'X',
        PriceBreaks: [
          { Quantity: 100, Price: '1' },
          { Quantity: 1, Price: '2' }
        ]
      },
      1000
    )
    expect(result?.offers[0].priceBreaks.map((b) => b.quantity)).toEqual([1, 100])
  })

  it('never guesses an unrecognized lifecycle into active', () => {
    expect(mouserLifecycle('Active')).toBe('active')
    expect(mouserLifecycle('Obsolete')).toBe('obsolete')
    expect(mouserLifecycle('Not Recommended for New Designs')).toBe('nrnd')
    expect(mouserLifecycle('Something New')).toBe('unknown')
    expect(mouserLifecycle(undefined)).toBe('unknown')
  })
})

describe('normalizeDigikeyProduct', () => {
  // Top-level field names per DigiKey's own OpenAPI download.
  const product = {
    ManufacturerProductNumber: 'STM32F103C8T6',
    Manufacturer: { Id: 511, Name: 'STMicroelectronics' },
    Description: {
      ProductDescription: 'IC MCU 32BIT 64KB FLASH 48LQFP',
      DetailedDescription: 'longer'
    },
    DatasheetUrl: 'https://example.com/stm32.pdf',
    PhotoUrl: 'https://example.com/x.jpg',
    ProductUrl: 'https://www.digikey.com/x',
    QuantityAvailable: 5000,
    ProductStatus: { Id: 0, Status: 'Active' },
    Classifications: { RohsStatus: 'ROHS3 Compliant' },
    Parameters: [
      { ParameterId: 1989, ParameterText: 'Core Processor', ValueText: 'ARM Cortex-M3' }
    ],
    ProductVariations: [
      {
        DigiKeyProductNumber: '497-6063-ND',
        PackageType: { Id: 2, Name: 'Tray' },
        QuantityAvailableforPackageType: 4000,
        MinimumOrderQuantity: 1,
        StandardPricing: [
          { BreakQuantity: 1, UnitPrice: 3.5 },
          { BreakQuantity: 10, UnitPrice: 3.1 }
        ]
      },
      {
        DigiKeyProductNumber: '497-6063-1-ND',
        PackageType: { Name: 'Tape & Reel (TR)' },
        QuantityAvailableforPackageType: 1000,
        MinimumOrderQuantity: 250,
        StandardPricing: []
      }
    ]
  }

  it('maps a real-shaped product, one offer per packaging', () => {
    const result = normalizeDigikeyProduct(product, 'USD', 1000)
    expect(result).toMatchObject({
      provider: 'digikey',
      mpn: 'STM32F103C8T6',
      manufacturer: 'STMicroelectronics',
      description: 'IC MCU 32BIT 64KB FLASH 48LQFP',
      lifecycle: 'active',
      rohs: 'ROHS3 Compliant'
    })
    // Packagings are genuinely different offers (different stock, MOQ, price).
    expect(result?.offers).toHaveLength(2)
    expect(result?.offers[0]).toMatchObject({
      distributorPartNumber: '497-6063-ND',
      stock: 4000,
      moq: 1,
      packaging: 'Tray'
    })
    expect(result?.offers[1]).toMatchObject({ moq: 250, packaging: 'Tape & Reel (TR)' })
    expect(result?.parameters).toEqual([
      { name: 'Core Processor', value: 'ARM Cortex-M3', parameterId: 1989 }
    ])
  })

  // The id is what joins a category's facet columns to a row's cells, so losing
  // it must cost that one column's value and never the parameter itself.
  it('keeps a parameter that reports no id, with a null id', () => {
    const result = normalizeDigikeyProduct(
      {
        ManufacturerProductNumber: 'X',
        Parameters: [{ ParameterText: 'Package / Case', ValueText: '0402' }]
      },
      'USD',
      1000
    )
    expect(result?.parameters).toEqual([
      { name: 'Package / Case', value: '0402', parameterId: null }
    ])
  })

  it('accepts the alternative capitalization of QuantityAvailableForPackageType', () => {
    const result = normalizeDigikeyProduct(
      {
        ManufacturerProductNumber: 'X',
        ProductVariations: [{ DigiKeyProductNumber: 'X-ND', QuantityAvailableForPackageType: 7 }]
      },
      'USD',
      1000
    )
    expect(result?.offers[0].stock).toBe(7)
  })

  it('keeps the commercial half when no variations come back', () => {
    const result = normalizeDigikeyProduct(
      {
        ManufacturerProductNumber: 'X',
        DigiKeyProductNumber: 'X-ND',
        QuantityAvailable: 12,
        ProductVariations: []
      },
      'USD',
      1000
    )
    expect(result?.offers[0]).toMatchObject({ distributorPartNumber: 'X-ND', stock: 12 })
  })

  it('survives a payload with every optional field missing', () => {
    const result = normalizeDigikeyProduct({ ManufacturerProductNumber: 'R-1' }, 'USD', 1000)
    expect(result).toMatchObject({ mpn: 'R-1', manufacturer: '', lifecycle: 'unknown' })
    expect(result?.offers).toEqual([])
  })

  it('drops a product with no MPN', () => {
    expect(normalizeDigikeyProduct({ Manufacturer: { Name: 'x' } }, 'USD', 1000)).toBeNull()
  })

  it('reads the lifecycle wordings DigiKey actually uses', () => {
    expect(digikeyLifecycle({ Status: 'Active' })).toBe('active')
    expect(digikeyLifecycle({ Status: 'Obsolete' })).toBe('obsolete')
    expect(digikeyLifecycle({ Status: 'Not For New Designs' })).toBe('nrnd')
    expect(digikeyLifecycle({ Status: 'Last Time Buy' })).toBe('nrnd')
    expect(digikeyLifecycle({ Status: 'Preliminary' })).toBe('unknown')
  })
})

describe('cadFromMediaLinks', () => {
  // The load-bearing fact: DigiKey's EDA Models entry is a link to a SnapEDA
  // *page*, never a model file — so this can only ever produce a handoff.
  const payload = {
    MediaLinks: [
      { MediaType: 'Datasheets', Title: 'LM358', Url: 'https://ti.com/lit/gpn/lm358' },
      {
        MediaType: 'EDA Models',
        Title: 'LM358DR by SnapEDA',
        Url: 'https://www.snapeda.com/parts/LM358DR/TI/view-part/?ref=digikey'
      },
      { MediaType: 'Product Photos', Title: '8 SOIC', Url: 'https://example.com/p.jpg' }
    ]
  }

  it('finds the EDA model link and reports it as a hand-off, not a download', () => {
    expect(cadFromMediaLinks(payload)).toEqual({
      mode: 'handoff',
      url: 'https://www.snapeda.com/parts/LM358DR/TI/view-part/?ref=digikey',
      title: 'LM358DR by SnapEDA'
    })
  })

  it('reports none when the part has no model, rather than inventing a link', () => {
    expect(
      cadFromMediaLinks({ MediaLinks: [{ MediaType: 'Datasheets', Url: 'https://x/y.pdf' }] })
    ).toEqual({
      mode: 'none'
    })
    expect(cadFromMediaLinks(null)).toEqual({ mode: 'none' })
  })
})

describe('normalizeCategories', () => {
  // One call returns the whole tree, nested — which is what makes browse cost a
  // single request per session rather than one per level.
  const payload = [
    {
      CategoryId: 32,
      Name: 'Integrated Circuits (ICs)',
      ProductCount: 1_200_000,
      Children: [
        { CategoryId: 763, Name: 'Embedded - Microcontrollers', ProductCount: 90_000, Children: [] }
      ]
    },
    { CategoryId: 1, Name: 'Resistors', ProductCount: 900_000 }
  ]

  it('reads the nested tree with its product counts', () => {
    const tree = normalizeCategories(payload)
    expect(tree).toHaveLength(2)
    expect(tree[0]).toMatchObject({
      id: 32,
      name: 'Integrated Circuits (ICs)',
      productCount: 1_200_000
    })
    expect(tree[0].children[0]).toMatchObject({ id: 763, name: 'Embedded - Microcontrollers' })
  })

  it('treats a missing Children array as a leaf rather than failing', () => {
    expect(normalizeCategories(payload)[1].children).toEqual([])
  })

  it('drops a node with no id or no name instead of rendering a blank row', () => {
    expect(normalizeCategories([{ Name: 'nameless id' }, { CategoryId: 5 }])).toEqual([])
  })

  it('survives a payload that is not a list', () => {
    expect(normalizeCategories(null)).toEqual([])
    expect(normalizeCategories({ Categories: [] })).toEqual([])
  })

  it('defaults an absent count to zero rather than showing nothing', () => {
    expect(normalizeCategories([{ CategoryId: 9, Name: 'Sensors' }])[0].productCount).toBe(0)
  })
})

describe('mouserSearchOption', () => {
  // Mouser's entire filter vocabulary, per its published Swagger.
  it('maps the two switches Mouser implements', () => {
    expect(mouserSearchOption(undefined)).toBe('None')
    expect(mouserSearchOption({ ...emptyFilterState(), inStock: true })).toBe('InStock')
    expect(mouserSearchOption({ ...emptyFilterState(), rohs: true })).toBe('Rohs')
    expect(mouserSearchOption({ ...emptyFilterState(), inStock: true, rohs: true })).toBe(
      'RohsAndInStock'
    )
  })

  it('ignores DigiKey-only filters rather than inventing a value', () => {
    expect(mouserSearchOption({ ...emptyFilterState(), manufacturerIds: ['296'] })).toBe('None')
  })
})

describe('buildFilterOptions', () => {
  // Shapes verified against the live API — workstream §18.8.
  it('returns null when there is nothing to send', () => {
    expect(buildFilterOptions(undefined, undefined)).toBeNull()
    expect(buildFilterOptions(emptyFilterState(), undefined)).toBeNull()
  })

  it('emits CategoryFilter as an array of FilterId', () => {
    expect(buildFilterOptions(undefined, 60)).toEqual({ CategoryFilter: [{ Id: '60' }] })
  })

  it('maps the boolean switches onto the SearchOptions enum', () => {
    const built = buildFilterOptions(
      { ...emptyFilterState(), inStock: true, rohs: true, hasDatasheet: true, has3dModel: true },
      undefined
    )
    expect(built?.SearchOptions).toEqual(['InStock', 'RohsCompliant', 'HasDatasheet', 'Has3DModel'])
  })

  it('omits an empty section rather than sending an empty array', () => {
    // Some of these read an empty array as "match nothing".
    const built = buildFilterOptions({ ...emptyFilterState(), inStock: true }, undefined)
    expect(built).not.toHaveProperty('ManufacturerFilter')
    expect(built).not.toHaveProperty('ParameterFilterRequest')
  })

  it('builds ParameterFilterRequest with an Int32 ParameterId', () => {
    // DigiKey's own validator named this path and this type when sent a null.
    const built = buildFilterOptions(
      { ...emptyFilterState(), parameters: { 2049: ['0.1 uF', '1 uF'] } },
      60
    )
    // Verified live: inside ParameterFilterRequest the key is `CategoryFilter`
    // and a single object — not `Category`, and not the array the outer
    // FilterOptionsRequest uses. The wrong name is rejected outright, which is
    // what made Apply appear to do nothing.
    expect(built?.ParameterFilterRequest).toEqual({
      CategoryFilter: { Id: '60' },
      ParameterFilters: [{ ParameterId: 2049, FilterValues: [{ Id: '0.1 uF' }, { Id: '1 uF' }] }]
    })
  })

  it('names each filter section exactly as the API validated it', () => {
    // Every one of these was checked against the live API: a wrong key is either
    // rejected or, worse, ignored — a filter that silently does nothing.
    const built = buildFilterOptions(
      {
        ...emptyFilterState(),
        manufacturerIds: ['296'],
        packagingIds: ['2'],
        statusIds: ['0'],
        seriesIds: ['77']
      },
      60
    )
    expect(built).toEqual({
      CategoryFilter: [{ Id: '60' }],
      ManufacturerFilter: [{ Id: '296' }],
      PackagingFilter: [{ Id: '2' }],
      StatusFilter: [{ Id: '0' }],
      SeriesFilter: [{ Id: '77' }]
    })
  })

  it('drops a parameter whose values were all removed', () => {
    const built = buildFilterOptions({ ...emptyFilterState(), parameters: { 2049: [] } }, undefined)
    expect(built).toBeNull()
  })
})

describe('normalizeFacets', () => {
  // Field names taken from a real response — §18.8.
  it('reads BaseFilterV4 facets', () => {
    const facets = normalizeFacets({
      Manufacturers: [{ Id: 296, Value: 'Texas Instruments', ProductCount: 4210 }],
      Packaging: [{ Id: 2, Value: 'Tape & Reel', ProductCount: 900 }]
    })
    expect(facets.manufacturers).toEqual([
      { id: '296', label: 'Texas Instruments', productCount: 4210 }
    ])
    expect(facets.packaging[0].label).toBe('Tape & Reel')
  })

  it('reads a parametric facet, whose ValueId is a display string', () => {
    const facets = normalizeFacets({
      ParametricFilters: [
        {
          Category: { Id: 60, Value: 'Ceramic Capacitors' },
          ParameterType: 'UnitOfMeasure',
          ParameterId: 2049,
          ParameterName: 'Capacitance',
          FilterValues: [{ ProductCount: 225, ValueId: '0.1 pF', ValueName: '0.1 pF' }]
        }
      ]
    })
    expect(facets.parametric).toEqual([
      {
        parameterId: 2049,
        name: 'Capacitance',
        values: [{ id: '0.1 pF', label: '0.1 pF', productCount: 225 }]
      }
    ])
  })

  it('drops a parametric facet with no selectable values', () => {
    const facets = normalizeFacets({
      ParametricFilters: [{ ParameterId: 1, ParameterName: 'Empty', FilterValues: [] }]
    })
    expect(facets.parametric).toEqual([])
  })

  it('survives a response with no FilterOptions at all', () => {
    // A bare keyword search returns ParametricFilters: [] — verified live.
    expect(normalizeFacets(undefined)).toEqual({
      manufacturers: [],
      packaging: [],
      status: [],
      series: [],
      parametric: []
    })
  })
})

describe('buildSortOptions', () => {
  // The SortField and SortOrder enums were confirmed by probe — workstream §18.6.
  it('omits SortOptions entirely when nothing is sorted', () => {
    // Not a "relevance" value: the enum has no such member, so default ordering
    // is the absence of the object.
    expect(buildSortOptions(null)).toBeNull()
    expect(buildSortOptions(undefined)).toBeNull()
  })

  it("spells the order as DigiKey's enum, not ours", () => {
    expect(buildSortOptions({ field: 'Price', order: 'asc' })).toEqual({
      Field: 'Price',
      SortOrder: 'Ascending'
    })
    expect(buildSortOptions({ field: 'QuantityAvailable', order: 'desc' })).toEqual({
      Field: 'QuantityAvailable',
      SortOrder: 'Descending'
    })
  })
})
