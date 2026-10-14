import { describe, expect, test } from 'vitest'
import * as THREE from 'three'
import {
  LIFT_Z,
  LIFTED_SLOT_OFFSET,
  PCB_LAYER_STACK,
  PREVIEW_SLOT,
  layerZ
} from '../../kicad/layers'
import { PaintOrder } from '../../kicad/paintOrder'
import { CHROME_STACK } from '../SelectionChrome'
import { liftFillMesh, placeFillMesh, repaintFillMeshes } from '../selectedBand'

const green = new THREE.Color(0, 1, 0)

const paint = new PaintOrder()

const fill = (material: THREE.Material, z = layerZ(6, 'fill')): THREE.Mesh => {
  const mesh = new THREE.Mesh(new THREE.BufferGeometry(), material)
  mesh.userData = { defaultColor: green.clone() }
  placeFillMesh(mesh, z, 'fill', paint)
  return mesh
}

const basic = (): THREE.MeshBasicMaterial =>
  new THREE.MeshBasicMaterial({ color: green, transparent: true, opacity: 0.32 })

describe('liftFillMesh', () => {
  test('moves a fill up one band and back, its place in the band its own slot', () => {
    const mesh = fill(basic())
    const home = { z: mesh.position.z, order: mesh.renderOrder }
    expect(liftFillMesh(mesh, true, paint)).toBe(true)
    expect(mesh.position.z).toBeCloseTo(home.z + LIFT_Z)
    expect(mesh.renderOrder).toBe(paint.renderOrder(6 + LIFTED_SLOT_OFFSET, 'fill'))
    expect(liftFillMesh(mesh, false, paint)).toBe(true)
    expect(mesh.position.z).toBeCloseTo(home.z)
    expect(mesh.renderOrder).toBe(home.order)
  })

  test('is a no-op where the fill already is', () => {
    const mesh = fill(basic())
    expect(liftFillMesh(mesh, false, paint)).toBe(false)
    liftFillMesh(mesh, true, paint)
    expect(liftFillMesh(mesh, true, paint)).toBe(false)
  })

  test('a change of view draws a fill where its lane now paints, lifted or not', () => {
    const group = new THREE.Group()
    const home = fill(basic())
    const lifted = fill(basic())
    liftFillMesh(lifted, true, paint)
    group.add(home, lifted)
    const view = new PaintOrder({ activeLayer: 'B.Cu' })
    repaintFillMeshes(group, view)
    expect(home.renderOrder).toBe(view.renderOrder(6, 'fill'))
    expect(lifted.renderOrder).toBe(view.renderOrder(6 + LIFTED_SLOT_OFFSET, 'fill'))
  })
})

describe('the PCB stack under the selection chrome', () => {
  // The chrome is drawn early and depth tested, so anything above its z paints
  // over the handles — a selected line did, once the band doubled the stack.
  const chromeZ = Math.min(...Object.values(CHROME_STACK).map((layer) => layer.z))

  test('the selected band stays below the handles', () => {
    const top = PCB_LAYER_STACK.length - 1
    expect(layerZ(top, 'label') + LIFT_Z).toBeLessThan(chromeZ)
  })

  test('so do the previews above it, at every depth', () => {
    expect(layerZ(PREVIEW_SLOT, 'label')).toBeLessThan(chromeZ)
  })
})
