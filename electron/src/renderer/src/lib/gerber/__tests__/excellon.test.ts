import { describe, expect, it } from 'vitest'
import { parseExcellon } from '../excellon'

// Inline fixtures in the shapes ECAD tools write (repo convention: tests never
// read machine-local files).

describe('parseExcellon', () => {
  it('reads tools, hits and G85 slots, with plating and role from the X2 comments', () => {
    const image = parseExcellon(
      [
        'M48',
        '; #@! TF.FileFunction,MixedPlating,1,2',
        'FMAT,2',
        'METRIC',
        '; #@! TA.AperFunction,Plated,PTH,ViaDrill',
        'T1C0.300',
        '; #@! TA.AperFunction,NonPlated,NPTH,ComponentDrill',
        'T2C0.650',
        '%',
        'G90',
        'G05',
        'T1',
        'X55.0Y-60.0',
        'Y-65.0',
        'T2',
        'X86.525Y-72.07G85X87.475Y-72.07',
        'G05',
        'M30'
      ].join('\n')
    )
    expect(image.fileFunction).toBe('MixedPlating,1,2')
    expect(image.hits).toEqual([
      { x: 55, y: -60, diameter: 0.3, plated: true, via: true },
      { x: 55, y: -65, diameter: 0.3, plated: true, via: true },
      {
        x: 87,
        y: -72.07,
        diameter: 0.65,
        plated: false,
        slot: { from: { x: 86.525, y: -72.07 }, to: { x: 87.475, y: -72.07 } }
      }
    ])
    expect(image.warnings).toEqual([])
  })

  it('reads a routed slot: move, plunge, cut, retract', () => {
    const image = parseExcellon(
      [
        'M48',
        'METRIC',
        'T1C0.6',
        '%',
        'T1',
        'G00X1.0Y2.0',
        'M15',
        'G01X3.0Y2.0',
        'M16',
        'G05',
        'X9.0Y9.0',
        'M30'
      ].join('\n')
    )
    expect(image.hits.map((h) => h.slot ?? { x: h.x, y: h.y })).toEqual([
      { from: { x: 1, y: 2 }, to: { x: 3, y: 2 } },
      { x: 9, y: 9 }
    ])
  })

  it('reads integer coordinates by the zero mode and digit format', () => {
    const suppressLeading = parseExcellon(
      [
        'M48',
        ';FORMAT={3:3/ absolute / metric / suppress leading zeros}',
        'METRIC,TZ',
        'T1C0.5',
        '%',
        'T1',
        'X55000Y-1500',
        'M30'
      ].join('\n')
    )
    expect(suppressLeading.hits[0]).toMatchObject({ x: 55, y: -1.5 })
    const suppressTrailing = parseExcellon(
      ['M48', 'INCH,LZ', 'T1C0.02', '%', 'T1', 'X01Y-005', 'M30'].join('\n')
    )
    // 2.4 inch: "01" is 01.0000 in, "005" is 00.5000 in.
    expect(suppressTrailing.hits[0].x).toBeCloseTo(25.4, 9)
    expect(suppressTrailing.hits[0].y).toBeCloseTo(-12.7, 9)
    expect(suppressTrailing.hits[0].diameter).toBeCloseTo(0.508, 9)
  })

  it('takes holes as plated unless a comment says otherwise', () => {
    const plain = parseExcellon(
      ['M48', 'METRIC', 'T1C1.0', '%', 'T1', 'X1.0Y1.0', 'M30'].join('\n')
    )
    expect(plain.hits[0].plated).toBe(true)
    const npth = parseExcellon(
      [
        'M48',
        '; #@! TF.FileFunction,NonPlated,1,2,NPTH',
        'METRIC',
        'T1C1.0',
        '%',
        'T1',
        'X1.0Y1.0',
        'M30'
      ].join('\n')
    )
    expect(npth.hits[0].plated).toBe(false)
  })
})
