/**
 * The light a board is seen by — one rig for the PCB editor's 3D mode and its
 * assembly overlay (`ViewportEngine`) and for the agent's board render
 * (`boardCapture3D.ts`), so a render is the pane's picture and tuning happens
 * here once.
 *
 * The overlay is the demanding case, and why the rig is built as it is: the
 * orthographic top-down camera is perpendicular to the board, so N·V is
 * constant across a coplanar layer and a specular highlight is either
 * everywhere or nowhere — sheen carries no information. And there is no
 * perspective, so **shading and shadow are the only cues that a part stands
 * off the board**.
 *
 * Hence: the environment map is not decoration. It colors a surface by its
 * normal, which is what gives a component's vertical sides a value at all —
 * under direct light from above they would be N·L ≈ 0, and every part would
 * silhouette. The key is raked rather than overhead for the same reason, and
 * carries the shadows that sell the height the projection hides.
 */
import * as THREE from 'three'
import type { Board3DLighting } from '../../../../../preload/board3dTypes'

/** Upper-left at ~40° elevation — the direction technical illustration reads
 *  relief from. */
export const BOARD_KEY_DIRECTION = new THREE.Vector3(-0.62, 0.62, 0.78).normalize()

/** Intensities. The environment's is the scene's `environmentIntensity`. */
export const BOARD_RIG = {
  // Under mask, the environment is what lights the film's color; with the
  // face painted in the mask color it no longer has to fight brown FR4.
  environment: 0.65,
  ambient: 0.1,
  // Lights the flat films face-on (N·L ≈ 1), so mask and silk carry their
  // real color while the raked key does height. Casts nothing.
  overhead: 0.3,
  // Warm key against cool fill, so sides facing different ways differ in hue,
  // not just in brightness. The key is kept below the films' own light: on a
  // light finish, a strong key washes the whole face out to one flat value.
  key: 0.6,
  fill: 0.25
} as const

/**
 * The full 3D view's tone curve. Neutral (Khronos PBR Neutral) keeps a base
 * color what it is until it nears white, so a named mask finish reads as that
 * finish; ACES's film shoulder adds contrast, shifts saturated finishes (yellow
 * toward mustard) and clips light ones.
 */
export const BOARD_TONE_MAPPING: THREE.ToneMapping = THREE.NeutralToneMapping

export interface BoardRig {
  /** Every light, and the key's target: add it to the scene once. */
  group: THREE.Group
  key: THREE.DirectionalLight
  overhead: THREE.DirectionalLight
  fill: THREE.DirectionalLight
  ambient: THREE.AmbientLight
  /** Aim the key's shadow at `bounds` and ask for a fresh shadow map. */
  fitShadow(bounds: THREE.Box3): void
}

export function createBoardRig(): BoardRig {
  const group = new THREE.Group()
  group.name = 'board-light'

  const ambient = new THREE.AmbientLight(0xffffff, BOARD_RIG.ambient)
  const overhead = new THREE.DirectionalLight(0xffffff, BOARD_RIG.overhead)
  overhead.position.set(0, 0, 1)

  const key = new THREE.DirectionalLight(0xfff0dc, BOARD_RIG.key)
  key.position.copy(BOARD_KEY_DIRECTION)
  key.castShadow = true
  key.shadow.mapSize.set(2048, 2048)
  // An ortho projection sees no grazing angles, so the depth slope stays small
  // and the bias can too — enough for self-shadow acne, not enough to lift a
  // part off its own contact shadow.
  key.shadow.bias = -0.0005
  key.shadow.normalBias = 0.02

  const fill = new THREE.DirectionalLight(0xbfd2e8, BOARD_RIG.fill)
  fill.position.set(0.55, -0.45, 0.35)

  group.add(ambient, overhead, key, key.target, fill)

  const fitShadow = (bounds: THREE.Box3): void => {
    if (bounds.isEmpty()) return
    const center = bounds.getCenter(new THREE.Vector3())
    const size = bounds.getSize(new THREE.Vector3())
    // The directional light's shadow camera is itself orthographic, so aiming
    // it at exactly the board spends every texel on it; half the diagonal
    // covers the board from any light azimuth.
    const radius = 0.5 * Math.hypot(size.x, size.y) + size.z
    const camera = key.shadow.camera
    camera.left = -radius
    camera.right = radius
    camera.top = radius
    camera.bottom = -radius
    camera.near = 0.1
    camera.far = 4 * radius + size.z
    key.target.position.copy(center)
    key.position.copy(center).addScaledVector(BOARD_KEY_DIRECTION, 2 * radius)
    key.updateMatrixWorld()
    key.target.updateMatrixWorld()
    camera.updateProjectionMatrix()
    key.shadow.needsUpdate = true
  }

  return { group, key, overhead, fill, ambient, fitShadow }
}

/**
 * Set `rig` to a preset, whatever it was set to before, and answer the
 * environment intensity that goes with it (the scene's
 * `environmentIntensity`). `studio` is the rig as built.
 */
export const applyBoardLighting = (rig: BoardRig, lighting: Board3DLighting): number => {
  rig.key.intensity = BOARD_RIG.key
  rig.overhead.intensity = BOARD_RIG.overhead
  rig.fill.intensity = BOARD_RIG.fill
  rig.ambient.intensity = BOARD_RIG.ambient
  switch (lighting) {
    case 'soft':
      // No raked key: even light from the reflections and overhead alone.
      rig.key.intensity = 0
      rig.overhead.intensity = BOARD_RIG.overhead + BOARD_RIG.key * 0.5
      return BOARD_RIG.environment * 1.15
    case 'flat':
      // Every face alike: color as the palette names it.
      rig.key.intensity = 0
      rig.overhead.intensity = 0
      rig.fill.intensity = 0
      rig.ambient.intensity = 2.2
      return 0
    case 'dramatic':
      rig.key.intensity = BOARD_RIG.key * 2.2
      rig.overhead.intensity = 0.05
      rig.fill.intensity = 0.08
      rig.ambient.intensity = 0.04
      return BOARD_RIG.environment * 0.3
    default:
      return BOARD_RIG.environment
  }
}

/**
 * Who casts and who receives. Parts cast, because their shadows are the only
 * height cue a top-down orthographic view has. The board receives. The mask is
 * the exception: it is translucent, and a translucent caster shadows as if it
 * were solid, which would print a second copy of the board outline onto itself.
 */
export const applyShadowRoles = (root: THREE.Object3D): void => {
  for (const group of root.children) {
    const casts = group.name === 'components'
    const receives = group.name !== 'components' && group.name !== 'drawings'
    group.traverse((object) => {
      object.castShadow = casts
      object.receiveShadow = receives
    })
  }
}
