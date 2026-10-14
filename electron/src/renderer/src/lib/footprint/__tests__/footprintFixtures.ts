/** Footprints as a datasheet gives them, shared by the generator's tests. */
import type { FootprintSpec } from '../footprintGenerate'

/** A JST PH 4-pin vertical header, as the vendor drawing gives it. */
export const JST_PH_4: FootprintSpec = {
  name: 'JST_PH_B4B-PH-K_1x04_P2.00mm_Vertical',
  attributes: 'tht',
  description: 'JST PH series connector, B4B-PH-K',
  tags: 'connector JST PH vertical',
  courtyard: 'connector',
  pads: [
    {
      number: '1',
      type: 'thru_hole',
      shape: 'roundrect',
      at: { x: 0, y: 0 },
      size: { width: 1.2, height: 1.75 },
      drill: { diameter: 0.75 }
    },
    {
      number: '2',
      type: 'thru_hole',
      shape: 'oval',
      at: { x: 2, y: 0 },
      size: { width: 1.2, height: 1.75 },
      drill: { diameter: 0.75 },
      array: { count: 3, dx: 2, dy: 0 }
    }
  ],
  body: { rect: { x: -1.95, y: -1.7, width: 9.9, height: 4.5 } },
  pin1: '1'
}

/** A 3x3 mm QFN-20 at 0.4 mm pitch with a 1.65 mm exposed pad. */
export const QFN_20: FootprintSpec = {
  name: 'QFN-20-1EP_3x3mm_P0.4mm_EP1.65x1.65mm',
  attributes: 'smd',
  pads: [
    {
      number: '1',
      type: 'smd',
      shape: 'roundrect',
      at: { x: -1.45, y: -0.8 },
      size: { width: 0.85, height: 0.2 },
      array: { count: 5, dx: 0, dy: 0.4 }
    },
    {
      number: '6',
      type: 'smd',
      shape: 'roundrect',
      at: { x: -0.8, y: 1.45 },
      size: { width: 0.2, height: 0.85 },
      array: { count: 5, dx: 0.4, dy: 0 }
    },
    {
      number: '11',
      type: 'smd',
      shape: 'roundrect',
      at: { x: 1.45, y: 0.8 },
      size: { width: 0.85, height: 0.2 },
      array: { count: 5, dx: 0, dy: -0.4 }
    },
    {
      number: '16',
      type: 'smd',
      shape: 'roundrect',
      at: { x: 0.8, y: -1.45 },
      size: { width: 0.2, height: 0.85 },
      array: { count: 5, dx: -0.4, dy: 0 }
    },
    {
      number: '21',
      type: 'smd',
      shape: 'rect',
      at: { x: 0, y: 0 },
      size: { width: 1.65, height: 1.65 }
    }
  ],
  body: { rect: { x: -1.5, y: -1.5, width: 3, height: 3 } },
  pin1: '1'
}
