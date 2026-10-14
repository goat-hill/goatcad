/**
 * The meshes a PCB scene draws outside its batches — pours, pad and shape
 * fills, hatch: where they paint (`placeFillMesh`, `PaintOrder`) and how they
 * join the selected band. Strokes and labels are copied up a band in their
 * batches (`LayeredBatch.liftElements`); a fill mesh moves itself: its z
 * shifts by one band (layers.ts `LIFT_Z`), its render order follows its new
 * slot, and its material follows where it now draws.
 *
 * Shared by `BoardScene` and `FootprintScene`, which build their fills the
 * same way: an ordinary translucent material, or a hatch's shader.
 */
import * as THREE from 'three'
import { LIFT_Z, layerSlot } from '../kicad/layers'
import type { PaintLane, PaintOrder } from '../kicad/paintOrder'

/**
 * How far selection moves a PCB item's own color: toward white on a dark
 * canvas, toward black on a light one. Enough to tell it apart; drawing it in
 * the selected band, in front of everything else, does the rest.
 */
export const selectionShift = (lighten: boolean): number => (lighten ? 0.35 : -0.3)

/**
 * Put a fill mesh at `z` (its slot and depth) in `lane`, and draw it where the
 * paint order puts that address. The lane is kept on the mesh, so a change of
 * view or a lift can place it again (`repaintFillMeshes`).
 */
export function placeFillMesh(
  mesh: THREE.Object3D,
  z: number,
  lane: Extract<PaintLane, 'fill' | 'hatch'>,
  paint: PaintOrder
): void {
  mesh.position.z = z
  mesh.userData.paintLane = lane
  mesh.renderOrder = paint.renderOrder(layerSlot(z), lane)
}

/** Every fill mesh under `root` drawn where `paint` now puts it: a change of view. */
export function repaintFillMeshes(root: THREE.Object3D, paint: PaintOrder): void {
  root.traverse((object) => {
    const lane = object.userData.paintLane as PaintLane | undefined
    if (lane) object.renderOrder = paint.renderOrder(layerSlot(object.position.z), lane)
  })
}

/** Move a fill mesh into or out of the selected band; false when it is already there. */
export function liftFillMesh(mesh: THREE.Mesh, lifted: boolean, paint: PaintOrder): boolean {
  if ((mesh.userData.lifted === true) === lifted) return false
  mesh.userData.lifted = lifted
  mesh.position.z += (lifted ? 1 : -1) * LIFT_Z
  const lane = (mesh.userData.paintLane as PaintLane | undefined) ?? 'fill'
  mesh.renderOrder = paint.renderOrder(layerSlot(mesh.position.z), lane)
  return true
}

/** Draw a fill mesh in `color` at `opacity`; a hatch through its uniforms. */
export function setFillLook(mesh: THREE.Mesh, color: THREE.Color, opacity: number): void {
  const material = mesh.material
  if (Array.isArray(material)) return
  if (material.userData.isHatch && material instanceof THREE.ShaderMaterial) {
    ;(material.uniforms.uColor.value as THREE.Color).copy(color)
    material.uniforms.uOpacity.value = opacity
  } else if (material instanceof THREE.MeshBasicMaterial) {
    material.color.copy(color)
    material.opacity = opacity
  }
}
