import { describe, expect, test } from 'vitest'
import * as THREE from 'three'
import { mmToNm } from '../../kicad/coordinates'
import { schematicFitBounds } from '../schematicFit'

describe('schematicFitBounds', () => {
  test('frames the drawing when the sheet has one', () => {
    const content = new THREE.Box3(new THREE.Vector3(10, -40, 0), new THREE.Vector3(60, -5, 0))
    expect(schematicFitBounds(content, undefined)).toBe(content)
  })

  test('an empty sheet frames its paper, hanging down from the origin', () => {
    const paper = { size: 'A3', portrait: false, width: mmToNm(420), height: mmToNm(297) }
    const bounds = schematicFitBounds(new THREE.Box3(), paper)
    expect(bounds.min.x).toBeCloseTo(0)
    expect(bounds.min.y).toBeCloseTo(-297)
    expect(bounds.max.x).toBeCloseTo(420)
    expect(bounds.max.y).toBeCloseTo(0)
  })

  test('an empty sheet with no paper frames the KiCad default, A4 landscape', () => {
    const bounds = schematicFitBounds(new THREE.Box3())
    expect(bounds.max.x).toBeCloseTo(297)
    expect(bounds.min.y).toBeCloseTo(-210)
  })
})
