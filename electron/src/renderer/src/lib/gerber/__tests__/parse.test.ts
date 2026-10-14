import { describe, expect, it } from 'vitest'
import { GerberParseError, parseGerber } from '../parse'
import type {
  GerberArc,
  GerberCapsule,
  GerberCircle,
  GerberPoly,
  GerberRect,
  GerberRing
} from '../shapes'

// All fixtures are inline (repo test convention: tests never read
// machine-local files). Format 2.6 → 1 mm = 1_000_000.

const HEADER = '%FSLAX26Y26*%\n%MOMM*%\n'

describe('parseGerber basics', () => {
  it('parses draws and flashes with mm scaling', () => {
    const image = parseGerber(
      HEADER + '%ADD10C,0.2*%\nD10*\nX0Y0D02*\nX1500000Y0D01*\nX3000000Y1000000D03*\nM02*\n'
    )
    expect(image.units).toBe('mm')
    expect(image.items).toHaveLength(2)
    const draw = image.items[0].shape as GerberCapsule
    expect(draw.kind).toBe('capsule')
    expect(draw.x1).toBeCloseTo(1.5)
    expect(draw.halfWidth).toBeCloseTo(0.1)
    const flashItem = image.items[1].shape as GerberCircle
    expect(flashItem.kind).toBe('circle')
    expect(flashItem.cx).toBeCloseTo(3)
    expect(flashItem.cy).toBeCloseTo(1)
    expect(flashItem.r).toBeCloseTo(0.1)
    expect(image.hasClear).toBe(false)
    expect(image.warnings).toHaveLength(0)
  })

  it('scales inch files to mm', () => {
    const image = parseGerber('%FSLAX24Y24*%\n%MOIN*%\n%ADD10C,0.1*%\nD10*\nX10000Y0D03*\nM02*\n')
    const flash = image.items[0].shape as GerberCircle
    expect(flash.cx).toBeCloseTo(25.4)
    expect(flash.r).toBeCloseTo(1.27)
  })

  it('supports trailing-zero omission (FST)', () => {
    // 2.4 format, trailing omitted: "X15" → "150000" → 15.0
    const image = parseGerber('%FSTAX24Y24*%\n%MOMM*%\n%ADD10C,0.1*%\nD10*\nX15Y0D03*\nM02*\n')
    const flash = image.items[0].shape as GerberCircle
    expect(flash.cx).toBeCloseTo(15)
  })

  it('modal coordinates: missing X/Y repeat the previous value', () => {
    const image = parseGerber(
      HEADER + '%ADD10C,0.2*%\nD10*\nX1000000Y2000000D02*\nY3000000D01*\nM02*\n'
    )
    const draw = image.items[0].shape as GerberCapsule
    expect(draw.x0).toBeCloseTo(1)
    expect(draw.y0).toBeCloseTo(2)
    expect(draw.x1).toBeCloseTo(1)
    expect(draw.y1).toBeCloseTo(3)
  })
})

describe('standard apertures', () => {
  it('rect and obround flashes', () => {
    const image = parseGerber(
      HEADER + '%ADD10R,2X1*%\n%ADD11O,3X1*%\nD10*\nX0Y0D03*\nD11*\nX0Y0D03*\nM02*\n'
    )
    const rect = image.items[0].shape as GerberRect
    expect(rect.kind).toBe('rect')
    expect(rect.halfW).toBeCloseTo(1)
    expect(rect.halfH).toBeCloseTo(0.5)
    const obround = image.items[1].shape as GerberCapsule
    expect(obround.kind).toBe('capsule')
    expect(obround.x0).toBeCloseTo(-1)
    expect(obround.x1).toBeCloseTo(1)
    expect(obround.halfWidth).toBeCloseTo(0.5)
  })

  it('circle with hole becomes an exact annulus', () => {
    const image = parseGerber(HEADER + '%ADD10C,2X1*%\nD10*\nX0Y0D03*\nM02*\n')
    const ring = image.items[0].shape as GerberRing
    expect(ring.kind).toBe('ring')
    // Outer r=1, inner r=0.5 → centerline 0.75, half-stroke 0.25
    expect(ring.radius).toBeCloseTo(0.75)
    expect(ring.halfStroke).toBeCloseTo(0.25)
  })

  it('rect with hole becomes a holed polygon', () => {
    const image = parseGerber(HEADER + '%ADD10R,2X2X1*%\nD10*\nX0Y0D03*\nM02*\n')
    const poly = image.items[0].shape as GerberPoly
    expect(poly.kind).toBe('poly')
    expect(poly.outline).toHaveLength(4)
    expect(poly.holes).toHaveLength(1)
  })

  it('polygon aperture with rotation', () => {
    const image = parseGerber(HEADER + '%ADD10P,2X4X45*%\nD10*\nX0Y0D03*\nM02*\n')
    const poly = image.items[0].shape as GerberPoly
    expect(poly.outline).toHaveLength(4)
    // First vertex at 45°: (cos45, sin45)
    expect(poly.outline[0].x).toBeCloseTo(Math.SQRT1_2)
    expect(poly.outline[0].y).toBeCloseTo(Math.SQRT1_2)
  })
})

describe('polarity', () => {
  it('LPC marks items clear and sets hasClear', () => {
    const image = parseGerber(
      HEADER + '%ADD10C,1*%\nD10*\nX0Y0D03*\n%LPC*%\nX0Y0D03*\n%LPD*%\nX1000000Y0D03*\nM02*\n'
    )
    expect(image.items.map((i) => i.polarity)).toEqual(['dark', 'clear', 'dark'])
    expect(image.hasClear).toBe(true)
  })
})

describe('regions', () => {
  it('builds a polygon from linear segments', () => {
    const image = parseGerber(
      HEADER + 'G36*\nX0Y0D02*\nX2000000D01*\nY2000000D01*\nX0D01*\nY0D01*\nG37*\nM02*\n'
    )
    const poly = image.items[0].shape as GerberPoly
    expect(poly.kind).toBe('poly')
    expect(poly.outline).toHaveLength(4)
    expect(poly.outline[2]).toEqual({ x: 2, y: 2 })
  })

  it('tessellates arc segments inside regions', () => {
    const image = parseGerber(
      HEADER + 'G75*\nG36*\nX1000000Y0D02*\nG03X0Y1000000I-1000000J0D01*\nG01X0Y0D01*\nG37*\nM02*\n'
    )
    const poly = image.items[0].shape as GerberPoly
    expect(poly.outline.length).toBeGreaterThan(5)
    // All arc points at radius 1 from origin
    const mid = poly.outline[Math.floor(poly.outline.length / 2)]
    expect(Math.hypot(mid.x, mid.y)).toBeCloseTo(1, 2)
  })
})

describe('arcs', () => {
  it('multi-quadrant (G75) CCW arc', () => {
    const image = parseGerber(
      HEADER + '%ADD10C,0.2*%\nD10*\nG75*\nX1000000Y0D02*\nG03X0Y1000000I-1000000J0D01*\nM02*\n'
    )
    const arc = image.items[0].shape as GerberArc
    expect(arc.kind).toBe('arc')
    expect(arc.cx).toBeCloseTo(0)
    expect(arc.cy).toBeCloseTo(0)
    expect(arc.radius).toBeCloseTo(1)
    expect(arc.startAngle).toBeCloseTo(0)
    expect(arc.sweep).toBeCloseTo(Math.PI / 2)
  })

  it('coincident endpoints in G75 mean a full circle', () => {
    const image = parseGerber(
      HEADER + '%ADD10C,0.2*%\nD10*\nG75*\nX1000000Y0D02*\nG02X1000000Y0I-1000000J0D01*\nM02*\n'
    )
    const arc = image.items[0].shape as GerberArc
    expect(Math.abs(arc.sweep)).toBeCloseTo(2 * Math.PI)
  })

  it('single-quadrant (G74) picks the valid center', () => {
    const image = parseGerber(
      HEADER + '%ADD10C,0.2*%\nD10*\nG74*\nX1000000Y0D02*\nG03X0Y1000000I1000000J0D01*\nM02*\n'
    )
    const arc = image.items[0].shape as GerberArc
    expect(arc.cx).toBeCloseTo(0)
    expect(arc.cy).toBeCloseTo(0)
    expect(arc.sweep).toBeCloseTo(Math.PI / 2)
  })
})

describe('aperture macros', () => {
  it('evaluates parameters, variables, and rotation', () => {
    const image = parseGerber(
      HEADER + '%AMBOX*\n$3=$1x2*\n21,1,$3,$2,0,0,45*%\n%ADD11BOX,1X0.5*%\nD11*\nX0Y0D03*\nM02*\n'
    )
    const rect = image.items[0].shape as GerberRect
    expect(rect.kind).toBe('rect')
    expect(rect.halfW).toBeCloseTo(1) // $3 = 1 × 2, halved
    expect(rect.halfH).toBeCloseTo(0.25)
    expect(rect.rotation).toBeCloseTo(Math.PI / 4)
  })

  it('expands thermals into four petals', () => {
    const image = parseGerber(
      HEADER + '%AMTH*\n7,0,0,1.0,0.6,0.2,0*%\n%ADD12TH*%\nD12*\nX0Y0D03*\nM02*\n'
    )
    expect(image.items).toHaveLength(4)
    expect(image.items.every((i) => i.shape.kind === 'poly')).toBe(true)
  })

  it('outline primitive with closure and rotation', () => {
    const image = parseGerber(
      HEADER + '%AMTRI*\n4,1,3,0,0,1,0,1,1,0,0,0*%\n%ADD13TRI*%\nD13*\nX0Y0D03*\nM02*\n'
    )
    const poly = image.items[0].shape as GerberPoly
    expect(poly.kind).toBe('poly')
    expect(poly.outline).toHaveLength(4)
    expect(poly.outline[2]).toEqual({ x: 1, y: 1 })
  })

  it('clear exposure flips polarity and warns', () => {
    const image = parseGerber(
      HEADER + '%AMDONUT*\n1,1,1.0,0,0*\n1,0,0.5,0,0*%\n%ADD14DONUT*%\nD14*\nX0Y0D03*\nM02*\n'
    )
    expect(image.items[0].polarity).toBe('dark')
    expect(image.items[1].polarity).toBe('clear')
    expect(image.warnings.some((w) => w.includes('clear-exposure'))).toBe(true)
  })
})

describe('step & repeat', () => {
  it('replicates the block with offsets', () => {
    const image = parseGerber(HEADER + '%ADD10C,1*%\nD10*\n%SRX2Y2I5J4*%\nX0Y0D03*\n%SR*%\nM02*\n')
    expect(image.items).toHaveLength(4)
    const centers = image.items
      .map((i) => i.shape as GerberCircle)
      .map((c) => `${c.cx},${c.cy}`)
      .sort()
    expect(centers).toEqual(['0,0', '0,4', '5,0', '5,4'])
  })
})

describe('X2 attributes', () => {
  it('reads TF.FileFunction from %TF and the G04 #@! legacy form', () => {
    const direct = parseGerber('%TF.FileFunction,Copper,L1,Top*%\n' + HEADER + 'M02*\n')
    expect(direct.fileFunction).toBe('Copper,L1,Top')

    const legacy = parseGerber('G04 #@! TF.FileFunction,Soldermask,Bot*\n' + HEADER + 'M02*\n')
    expect(legacy.fileFunction).toBe('Soldermask,Bot')
  })
})

describe('rejection and diagnostics', () => {
  it('rejects RS-274D (coordinates before FS/MO)', () => {
    expect(() => parseGerber('X001000Y001000D01*\nM02*\n')).toThrow(GerberParseError)
    expect(() => parseGerber('X001000Y001000D01*\nM02*\n')).toThrow(/RS-274D/)
  })

  it('rejects incremental coordinates', () => {
    expect(() => parseGerber('%FSLIX26Y26*%\n%MOMM*%\nM02*\n')).toThrow(/[Ii]ncremental/)
  })

  it('rejects files with no Gerber structure at all', () => {
    expect(() => parseGerber('just some text with an asterisk*')).toThrow(GerberParseError)
  })

  it('warns on missing M02 and undefined apertures', () => {
    const image = parseGerber(HEADER + 'D99*\nX0Y0D03*\n')
    expect(image.warnings.some((w) => w.includes('D99'))).toBe(true)
    expect(image.warnings.some((w) => w.includes('M02'))).toBe(true)
    expect(image.items).toHaveLength(0)
  })
})
