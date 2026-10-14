<script setup lang="ts">
/**
 * The stackup as the thing it describes: an exploded isometric stack of
 * slabs, top of the board first, the way a fab draws a build — each layer in
 * its own material, lit as the 3D view lights a board (its material settings
 * and studio light), with the copper layers etched into traces, one plated via
 * through them all, and the name in silk on each face.
 *
 * To scale in thickness: seen at an angle, a layer reads by its face, so a
 * 35 µm foil can be drawn as thin as it is. The gaps between layers are not
 * (the stack is exploded, but for silk, printed on its mask), and silk, which
 * KiCad gives no thickness, takes a typical real one. Paste is not drawn: it
 * is the assembly stencil's, not the bare board's. Hovering a slab fades every other
 * layer; hovering its row in the table does the same (`highlight`).
 *
 * Rendered on demand — a change of rows, highlight, size or theme — never in a
 * loop: nothing here moves on its own.
 */
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import * as THREE from 'three'
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js'
import type { StackupLayerRow } from '../../lib/board/boardSetupSchema'
import { getTextStrokes } from '../../lib/kicad/newstroke'
import { gpuPowerPreference } from '../../lib/gpuPreference'

const props = defineProps<{
  rows: readonly StackupLayerRow[]
  /** The row hovered in the table, by its index; null when none. */
  highlight: number | null
}>()

const emit = defineEmits<{
  /** The slab under the pointer, by its row's index; null when it leaves them. */
  (e: 'hover', index: number | null): void
}>()

const host = ref<HTMLDivElement | null>(null)
const canvas = ref<HTMLCanvasElement | null>(null)

/** Slab footprint, world units. */
const WIDTH = 7
const DEPTH = 4.4
/** Space between slabs: the stack is exploded so each layer shows its own face. */
const GAP = 0.34

/** World units per millimeter of thickness: every layer drawn to one scale. */
const SCALE = 0.8
/** Silk, which KiCad gives no thickness, at a typical real one: as thin as the ink. */
const NOMINAL_MM: Partial<Record<string, number>> = { silk: 0.015 }
/** The thinnest a face is drawn, so a zero-thickness layer still has one. */
const FLOOR = 0.004

/** A layer's drawn height: its real thickness, to scale. */
const heightOf = (row: StackupLayerRow): number =>
  Math.max(FLOOR, (row.mm > 0 ? row.mm : (NOMINAL_MM[row.kind] ?? 0)) * SCALE)

let renderer: THREE.WebGLRenderer | null = null
let scene: THREE.Scene | null = null
let camera: THREE.OrthographicCamera | null = null
let pmrem: THREE.PMREMGenerator | null = null
let envTexture: THREE.Texture | null = null
let stack: THREE.Group | null = null
/** The via's barrel, which belongs to no one layer. */
let barrel: THREE.Mesh | null = null
/** Each row's group, by row index: what a highlight keeps and a pick returns. */
const slabs = new Map<number, THREE.Group>()
const raycaster = new THREE.Raycaster()
let resize: ResizeObserver | null = null

const materialFor = (row: StackupLayerRow): THREE.Material => {
  const color = new THREE.Color(row.swatch)
  switch (row.kind) {
    case 'copper':
      return new THREE.MeshStandardMaterial({ color, roughness: 0.32, metalness: 0.85 })
    case 'mask':
      return new THREE.MeshPhysicalMaterial({
        color,
        roughness: 0.42,
        metalness: 0,
        specularIntensity: 0.25,
        transparent: true,
        opacity: 0.9
      })
    case 'silk':
      return new THREE.MeshStandardMaterial({ color, roughness: 0.88, metalness: 0 })
    default:
      return new THREE.MeshStandardMaterial({ color, roughness: 0.92, metalness: 0.02 })
  }
}

const box = (w: number, h: number, d: number, material: THREE.Material): THREE.Mesh =>
  new THREE.Mesh(new THREE.BoxGeometry(w, h, d), material)

/**
 * A copper layer as etched copper: parallel traces and a pad ringing the via,
 * running across the board on alternate layers, as routing does.
 */
const copperSlab = (h: number, material: THREE.Material, across: boolean): THREE.Group => {
  const group = new THREE.Group()
  const traces = 7
  const span = across ? DEPTH : WIDTH
  const length = across ? WIDTH : DEPTH
  const pitch = span / traces
  for (let i = 0; i < traces; i++) {
    const offset = -span / 2 + pitch * (i + 0.5)
    const trace = across
      ? box(length * 0.92, h, pitch * 0.42, material)
      : box(pitch * 0.42, h, length * 0.92, material)
    if (across) trace.position.z = offset
    else trace.position.x = offset
    group.add(trace)
  }
  return group
}

/**
 * A silk stroke from (x0, z0) to (x1, z1), as a round pen plots it: a bar the
 * stroke's length with a disc at each end, so ends are round and strokes that
 * meet join round, as KiCad draws newstroke.
 */
const inkStroke = (
  x0: number,
  z0: number,
  x1: number,
  z1: number,
  width: number,
  h: number,
  material: THREE.Material
): THREE.Group => {
  const stroke = new THREE.Group()
  const length = Math.hypot(x1 - x0, z1 - z0)
  if (length > 1e-6) {
    const bar = box(length, h, width, material)
    bar.position.set((x0 + x1) / 2, 0, (z0 + z1) / 2)
    bar.rotation.y = -Math.atan2(z1 - z0, x1 - x0)
    stroke.add(bar)
  }
  for (const [x, z] of [
    [x0, z0],
    [x1, z1]
  ]) {
    const cap = new THREE.Mesh(new THREE.CylinderGeometry(width / 2, width / 2, h, 16), material)
    cap.position.set(x, 0, z)
    stroke.add(cap)
  }
  return stroke
}

/** The name's height on the board, world units; its stroke is KiCad's usual 15% of it. */
const BRAND_SIZE = 0.75

/**
 * Silkscreen: markings only — the name, centered on the face, in newstroke,
 * KiCad's own stroke font. The bottom's is mirrored, as it is printed, so it
 * reads true from underneath.
 */
const silkMarks = (h: number, material: THREE.Material, mirror: boolean): THREE.Group => {
  const group = new THREE.Group()
  const stroke = BRAND_SIZE * 0.15
  const layout = getTextStrokes('GOATCAD', {
    width: BRAND_SIZE,
    height: BRAND_SIZE,
    thickness: stroke,
    mirror,
    horizontalAlign: 'center',
    verticalAlign: 'center'
  })
  // Stroke text is y-up; the face's "up" runs away from the viewer, which is -z.
  for (const s of layout.strokes)
    group.add(inkStroke(s.x1, -s.y1, s.x2, -s.y2, stroke, h, material))
  return group
}

const disposeStack = (): void => {
  if (!stack || !scene) return
  stack.traverse((object) => {
    if (object instanceof THREE.Mesh) {
      object.geometry.dispose()
      ;(object.material as THREE.Material).dispose()
    }
  })
  scene.remove(stack)
  stack = null
  barrel = null
  slabs.clear()
}

/** The via's place: the plated barrel runs through every copper layer here. */
const VIA_AT = { x: WIDTH / 2 - 0.8, z: DEPTH / 2 - 0.8 }

/**
 * The space below a layer. Silk is printed onto the mask, so the two touch;
 * every other pair is exploded apart so each layer shows its own face.
 */
const gapAfter = (row: StackupLayerRow, next: StackupLayerRow | undefined): number =>
  (row.kind === 'silk' && next?.kind === 'mask') || (row.kind === 'mask' && next?.kind === 'silk')
    ? 0
    : GAP

const build = (): void => {
  if (!scene) return
  disposeStack()
  stack = new THREE.Group()
  const coppers = props.rows.filter((r) => r.kind === 'copper')
  let y = 0
  let copperCount = 0
  let silkCount = 0
  for (const row of props.rows) {
    const h = heightOf(row)
    const material = materialFor(row)
    let group: THREE.Group
    if (row.kind === 'copper') group = copperSlab(h, material, copperCount++ % 2 === 0)
    else if (row.kind === 'silk') group = silkMarks(h, material, silkCount++ > 0)
    else group = new THREE.Group().add(box(WIDTH, h, DEPTH, material))
    group.position.y = y - h / 2
    group.userData.rowIndex = row.index
    stack.add(group)
    slabs.set(row.index, group)
    y -= h + gapAfter(row, props.rows[props.rows.indexOf(row) + 1])
  }
  const height = -y - GAP
  // The plated via: a barrel from the top copper's face to the bottom copper's,
  // no further — mask and silk are not drilled — with a land on each
  // copper layer.
  const first = coppers[0] ? slabs.get(coppers[0].index) : undefined
  const last = coppers.length ? slabs.get(coppers[coppers.length - 1].index) : undefined
  const barrelTop = first ? first.position.y + heightOf(coppers[0]) / 2 : 0
  const barrelBottom = last ? last.position.y - heightOf(coppers[coppers.length - 1]) / 2 : 0
  const barrelMaterial = new THREE.MeshStandardMaterial({
    color: '#c9a35a',
    roughness: 0.3,
    metalness: 0.9
  })
  barrel = new THREE.Mesh(
    new THREE.CylinderGeometry(0.11, 0.11, barrelTop - barrelBottom, 24, 1, true),
    barrelMaterial
  )
  barrel.position.set(VIA_AT.x, (barrelTop + barrelBottom) / 2, VIA_AT.z)
  stack.add(barrel)
  for (const row of props.rows) {
    if (row.kind !== 'copper') continue
    const slab = slabs.get(row.index)!
    const land = new THREE.Mesh(
      new THREE.CylinderGeometry(0.24, 0.24, heightOf(row) * 1.3, 28),
      (slab.children[0] as THREE.Mesh).material as THREE.Material
    )
    land.position.set(VIA_AT.x, 0, VIA_AT.z)
    slab.add(land)
  }
  // Center the stack on the origin, so the camera frames it.
  stack.position.y = height / 2
  scene.add(stack)
  applyHighlight()
  fit()
}

let hovered: number | null = null

/** How much of itself a layer keeps while another is highlighted. */
const FADED = 0.12

/** Fade a mesh to FADED of itself, or back to whole. */
const fade = (object: THREE.Object3D, faded: boolean): void => {
  if (!(object instanceof THREE.Mesh)) return
  const material = object.material as THREE.Material
  const base = (material.userData.baseOpacity as number | undefined) ?? material.opacity
  material.userData.baseOpacity = base
  material.transparent = true
  material.opacity = faded ? base * FADED : base
  // A faded layer must not hide the one behind it from the depth test.
  material.depthWrite = !faded
  material.needsUpdate = true
}

/** Fade every layer but the highlighted one, and the via with them; with none highlighted, all are whole. */
const applyHighlight = (): void => {
  const target = hovered ?? props.highlight
  for (const [index, group] of slabs) {
    const faded = target !== null && index !== target
    group.traverse((object) => fade(object, faded))
  }
  if (barrel) fade(barrel, target !== null)
  render()
}

/** Where the camera looks from: up and to the right, low enough to see between the slabs. */
const VIEW_DIRECTION = new THREE.Vector3(1, 0.62, 1.35).normalize()

/** Frame the stack: an orthographic view scaled to the pane, with a margin. */
const fit = (): void => {
  const el = host.value
  if (!renderer || !camera || !el || !stack) return
  const width = el.clientWidth
  const height = el.clientHeight
  if (width === 0 || height === 0) return
  renderer.setSize(width, height, false)
  // Frame the stack by its corners in the camera's view, not by a bounding
  // sphere, which leaves it small.
  const bounds = new THREE.Box3().setFromObject(stack)
  const center = bounds.getCenter(new THREE.Vector3())
  camera.position.copy(center).add(VIEW_DIRECTION.clone().multiplyScalar(20))
  camera.lookAt(center)
  camera.updateMatrixWorld()
  let left = Infinity
  let right = -Infinity
  let bottom = Infinity
  let top = -Infinity
  for (const x of [bounds.min.x, bounds.max.x])
    for (const y of [bounds.min.y, bounds.max.y])
      for (const z of [bounds.min.z, bounds.max.z]) {
        const p = new THREE.Vector3(x, y, z).applyMatrix4(camera.matrixWorldInverse)
        left = Math.min(left, p.x)
        right = Math.max(right, p.x)
        bottom = Math.min(bottom, p.y)
        top = Math.max(top, p.y)
      }
  const margin = 1.06
  let halfW = ((right - left) / 2) * margin
  let halfH = ((top - bottom) / 2) * margin
  const aspect = width / height
  if (halfW / halfH > aspect) halfH = halfW / aspect
  else halfW = halfH * aspect
  const cx = (left + right) / 2
  const cy = (top + bottom) / 2
  camera.left = cx - halfW
  camera.right = cx + halfW
  camera.top = cy + halfH
  camera.bottom = cy - halfH
  camera.updateProjectionMatrix()
  render()
}

const render = (): void => {
  if (renderer && scene && camera) renderer.render(scene, camera)
}

const pick = (event: PointerEvent): number | null => {
  const el = canvas.value
  if (!el || !camera || !stack) return null
  const rect = el.getBoundingClientRect()
  const pointer = new THREE.Vector2(
    ((event.clientX - rect.left) / rect.width) * 2 - 1,
    -((event.clientY - rect.top) / rect.height) * 2 + 1
  )
  raycaster.setFromCamera(pointer, camera)
  for (const hit of raycaster.intersectObjects([...slabs.values()], true)) {
    let object: THREE.Object3D | null = hit.object
    while (object && object.userData.rowIndex === undefined) object = object.parent
    if (object) return object.userData.rowIndex as number
  }
  return null
}

const onPointerMove = (event: PointerEvent): void => {
  const index = pick(event)
  if (index === hovered) return
  hovered = index
  emit('hover', index)
  applyHighlight()
}

const onPointerLeave = (): void => {
  if (hovered === null) return
  hovered = null
  emit('hover', null)
  applyHighlight()
}

onMounted(() => {
  if (!canvas.value || !host.value) return
  renderer = new THREE.WebGLRenderer({
    canvas: canvas.value,
    antialias: true,
    alpha: true,
    powerPreference: gpuPowerPreference()
  })
  renderer.setPixelRatio(window.devicePixelRatio)
  renderer.outputColorSpace = THREE.SRGBColorSpace
  renderer.toneMapping = THREE.ACESFilmicToneMapping
  scene = new THREE.Scene()
  // The 3D view's studio light, so a material reads here as it does there.
  pmrem = new THREE.PMREMGenerator(renderer)
  envTexture = pmrem.fromScene(new RoomEnvironment(), 0.04).texture
  scene.environment = envTexture
  scene.environmentIntensity = 0.55
  const key = new THREE.DirectionalLight(0xfff0dc, 1.1)
  key.position.set(4, 8, 6)
  const fill = new THREE.DirectionalLight(0xbfd2e8, 0.35)
  fill.position.set(-6, 3, -2)
  scene.add(key, fill, new THREE.AmbientLight(0xffffff, 0.25))
  camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 100)
  build()
  resize = new ResizeObserver(() => fit())
  resize.observe(host.value)
})

onBeforeUnmount(() => {
  resize?.disconnect()
  disposeStack()
  envTexture?.dispose()
  pmrem?.dispose()
  renderer?.dispose()
  renderer = null
})

watch(() => props.rows, build, { deep: true })
watch(() => props.highlight, applyHighlight)
</script>

<template>
  <div ref="host" class="stackup-preview-3d">
    <canvas
      ref="canvas"
      class="stackup-canvas"
      @pointermove="onPointerMove"
      @pointerleave="onPointerLeave"
    />
  </div>
</template>

<style scoped>
.stackup-preview-3d {
  position: relative;
  width: 100%;
  height: 100%;
  min-height: 260px;
}

.stackup-canvas {
  display: block;
  width: 100%;
  height: 100%;
}
</style>
