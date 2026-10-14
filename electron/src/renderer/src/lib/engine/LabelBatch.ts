import * as THREE from 'three'
import { primitiveBatchUniforms } from './PrimitiveBatch'
import { BOARD_VIEW_GLSL, batchViewUniforms, type BatchView } from './boardView'
import { HIDDEN_FOR_LIFT, HIDDEN_FOR_PREVIEW, InPlaceHides } from './inPlaceHides'
import { InstanceUploads } from './instanceUploads'
import { KeyHierarchy } from './keyHierarchy'

/**
 * Shared signed-distance-field glyph atlas + instanced label renderer for
 * pad numbers.
 *
 * Each distinct character is rasterized once at high resolution, converted
 * to a signed distance field (exact Euclidean distance transform, tiny-sdf
 * style with sub-pixel alpha seeding), downsampled into a shared 1024x1024
 * single-channel atlas, and cached for the lifetime of the app. Labels then
 * render as instanced quads in one draw call; the fragment shader
 * reconstructs the glyph edge analytically per screen pixel, so text stays
 * crisp when magnified far beyond the atlas resolution and cleanly
 * anti-aliased when minified (AA width driven by the shared zoom-synced
 * uPixelSize uniform).
 */

// Rasterization parameters
const FONT_PX = 160 // glyph render size (px)
const PAD_R = 24 // SDF spread padding around each glyph (render px)
const SPREAD = 24 // distance field range: value 0..1 spans ±SPREAD render px
const DS = 4 // downsample factor render px -> atlas px
const CELL_H_R = 2 * PAD_R + Math.ceil(FONT_PX * 1.25) // 248, divisible by DS
const BASELINE_Y_R = PAD_R + Math.round(FONT_PX * 0.94)
// Vertical center of digits/uppercase (cap height ~0.7em) — aligned to the pad center
const CAP_CENTER_Y_R = BASELINE_Y_R - Math.round(FONT_PX * 0.35)
const ATLAS_SIZE = 1024
const CELL_H_A = CELL_H_R / DS

// World-space font size relative to the pad reference dimension. Matches the
// legacy sprite sizing: 440px font on a 1024px canvas scaled to 1.8 * refDim.
export const LABEL_FONT_WORLD = (440 / 1024) * 1.8

interface GlyphInfo {
  u0: number
  v0: number
  u1: number
  v1: number
  cellWr: number // cell width in render px (advance + 2*PAD_R, rounded to DS)
  advance: number // horizontal advance in render px
  empty: boolean // true for whitespace / unrenderable glyphs
}

const INF = 1e20

/**
 * Felzenszwalb & Huttenlocher 1D squared Euclidean distance transform.
 */
function edt1d(f: Float32Array, d: Float32Array, v: Int32Array, zb: Float64Array, n: number): void {
  v[0] = 0
  zb[0] = -INF
  zb[1] = INF
  let k = 0
  for (let q = 1; q < n; q++) {
    let s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k])
    while (s <= zb[k]) {
      k--
      s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k])
    }
    k++
    v[k] = q
    zb[k] = s
    zb[k + 1] = INF
  }
  k = 0
  for (let q = 0; q < n; q++) {
    while (zb[k + 1] < q) k++
    d[q] = (q - v[k]) * (q - v[k]) + f[v[k]]
  }
}

/** In-place 2D squared distance transform (columns then rows). */
function edt2d(grid: Float32Array, w: number, h: number): void {
  const size = Math.max(w, h)
  const f = new Float32Array(size)
  const d = new Float32Array(size)
  const v = new Int32Array(size)
  const zb = new Float64Array(size + 1)

  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) f[y] = grid[y * w + x]
    edt1d(f, d, v, zb, h)
    for (let y = 0; y < h; y++) grid[y * w + x] = d[y]
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) f[x] = grid[y * w + x]
    edt1d(f, d, v, zb, w)
    for (let x = 0; x < w; x++) grid[y * w + x] = d[x]
  }
}

class GlyphAtlas {
  public readonly texture: THREE.DataTexture

  private data: Uint8Array
  private glyphs = new Map<string, GlyphInfo>()
  private shelfX = 0
  private shelfY = 0
  private measureCtx: CanvasRenderingContext2D

  constructor() {
    this.data = new Uint8Array(ATLAS_SIZE * ATLAS_SIZE)
    this.texture = new THREE.DataTexture(
      this.data,
      ATLAS_SIZE,
      ATLAS_SIZE,
      THREE.RedFormat,
      THREE.UnsignedByteType
    )
    this.texture.minFilter = THREE.LinearMipmapLinearFilter
    this.texture.magFilter = THREE.LinearFilter
    this.texture.generateMipmaps = true
    this.texture.unpackAlignment = 1
    this.texture.needsUpdate = true

    const canvas = document.createElement('canvas')
    canvas.width = 1
    canvas.height = 1
    this.measureCtx = canvas.getContext('2d')!
    this.measureCtx.font = `bold ${FONT_PX}px sans-serif`
  }

  public getGlyph(char: string): GlyphInfo {
    let glyph = this.glyphs.get(char)
    if (!glyph) {
      glyph = this.rasterize(char)
      this.glyphs.set(char, glyph)
    }
    return glyph
  }

  private rasterize(char: string): GlyphInfo {
    const advance = this.measureCtx.measureText(char).width
    let cellWr = Math.ceil(advance) + 2 * PAD_R
    cellWr += (DS - (cellWr % DS)) % DS // round up to downsample multiple

    const cellWa = cellWr / DS

    // Shelf packing; if the atlas is full, fall back to a blank glyph
    if (this.shelfX + cellWa > ATLAS_SIZE) {
      this.shelfX = 0
      this.shelfY += CELL_H_A
    }
    if (this.shelfY + CELL_H_A > ATLAS_SIZE) {
      return { u0: 0, v0: 0, u1: 0, v1: 0, cellWr, advance, empty: true }
    }
    const ax = this.shelfX
    const ay = this.shelfY
    this.shelfX += cellWa

    // 1. Rasterize the glyph at high resolution
    const canvas = document.createElement('canvas')
    canvas.width = cellWr
    canvas.height = CELL_H_R
    const ctx = canvas.getContext('2d', { willReadFrequently: true })!
    ctx.font = `bold ${FONT_PX}px sans-serif`
    ctx.textAlign = 'left'
    ctx.textBaseline = 'alphabetic'
    ctx.fillStyle = '#fff'
    ctx.fillText(char, PAD_R, BASELINE_Y_R)
    const img = ctx.getImageData(0, 0, cellWr, CELL_H_R).data

    // 2. Seed inner/outer distance grids from coverage (sub-pixel accurate:
    //    partially covered pixels seed fractional distances, tiny-sdf style)
    const n = cellWr * CELL_H_R
    const gridOuter = new Float32Array(n)
    const gridInner = new Float32Array(n)
    let empty = true
    for (let i = 0; i < n; i++) {
      const a = img[i * 4 + 3] / 255
      if (a > 0) empty = false
      if (a >= 1) {
        gridOuter[i] = 0
        gridInner[i] = INF
      } else if (a <= 0) {
        gridOuter[i] = INF
        gridInner[i] = 0
      } else {
        const dOut = Math.max(0, 0.5 - a)
        const dIn = Math.max(0, a - 0.5)
        gridOuter[i] = dOut * dOut
        gridInner[i] = dIn * dIn
      }
    }

    if (!empty) {
      edt2d(gridOuter, cellWr, CELL_H_R)
      edt2d(gridInner, cellWr, CELL_H_R)

      // 3. Combine to a signed distance (positive inside), normalize to 0..1
      //    with 0.5 at the glyph edge, and box-downsample into the atlas
      for (let ya = 0; ya < CELL_H_A; ya++) {
        for (let xa = 0; xa < cellWa; xa++) {
          let sum = 0
          for (let dy = 0; dy < DS; dy++) {
            for (let dx = 0; dx < DS; dx++) {
              const i = (ya * DS + dy) * cellWr + (xa * DS + dx)
              const sd = Math.sqrt(gridInner[i]) - Math.sqrt(gridOuter[i])
              sum += Math.min(1, Math.max(0, 0.5 + sd / (2 * SPREAD)))
            }
          }
          this.data[(ay + ya) * ATLAS_SIZE + ax + xa] = Math.round((sum / (DS * DS)) * 255)
        }
      }
      this.texture.needsUpdate = true
    }

    return {
      u0: ax / ATLAS_SIZE,
      v0: ay / ATLAS_SIZE,
      u1: (ax + cellWa) / ATLAS_SIZE,
      v1: (ay + CELL_H_A) / ATLAS_SIZE,
      cellWr,
      advance,
      empty
    }
  }
}

// One atlas for the whole app: glyphs are cached across rebuilds and scenes
let sharedAtlas: GlyphAtlas | null = null

/**
 * Called as a renderer goes. Each renderer that drew the atlas hangs a
 * listener on its texture holding that renderer's WebGL context and canvas —
 * and through the canvas its engine and document — for as long as the atlas
 * lives, which is the app's life. Disposing the texture runs them all: every
 * renderer drops its copy and its listener, and those still drawing upload the
 * atlas again on their next frame.
 */
export function releaseSharedAtlas(): void {
  sharedAtlas?.texture.dispose()
}
function getAtlas(): GlyphAtlas {
  if (!sharedAtlas) sharedAtlas = new GlyphAtlas()
  return sharedAtlas
}

const vertexShader = /* glsl */ `
  attribute vec4 iPos;  // (cx, cy, halfW, halfH)
  attribute vec4 iMisc; // (z, aaFactor, rotation, alpha)
  attribute vec4 iUV;   // (u0, v0, u1, v1)
  #ifdef BOARD_VIEW
  ${BOARD_VIEW_GLSL}
  #endif

  uniform float uPixelSize;
  uniform vec3 uColor;

  varying vec2 vUv;
  varying float vAaFactor;
  varying float vAlpha;
  varying vec3 vColor;

  void main() {
    vColor = uColor;
    vec2 off = position.xy * iPos.zw;
    float c = cos(iMisc.z);
    float s = sin(iMisc.z);
    vec2 world = iPos.xy + vec2(off.x * c - off.y * s, off.x * s + off.y * c);
    vUv = vec2(
      mix(iUV.x, iUV.z, (position.x + 1.0) * 0.5),
      mix(iUV.w, iUV.y, (position.y + 1.0) * 0.5)
    );
    vAaFactor = iMisc.y;
    // Zoom LOD (KiCad hides copper text below a size threshold): fade the
    // glyph out as its on-screen half-height drops under ~5 px — unreadable
    // text renders as smudge, so it should not render at all.
    float screenHalfH = iPos.w / max(uPixelSize, 1e-9);
    vAlpha = iMisc.w * smoothstep(3.0, 5.5, screenHalfH);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(world, iMisc.x, 1.0);
    #ifdef BOARD_VIEW
    if (viewHidden()) {
      vAlpha = 0.0;
      gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
      return;
    }
    vAlpha *= viewLabelAlpha();
    vColor = viewDimmed(uColor, viewDim());
    #endif
  }
`

const fragmentShader = /* glsl */ `
  uniform sampler2D uAtlas;
  uniform float uPixelSize;
  uniform float uCoverageMode;

  varying vec2 vUv;
  varying float vAaFactor;
  varying float vAlpha;
  varying vec3 vColor;

  void main() {
    float v = texture2D(uAtlas, vUv).r;
    // AA width: one screen pixel expressed in distance-field value units
    float aa = max(uPixelSize * vAaFactor, 1e-5);
    float alpha = clamp((v - 0.5) / aa + 0.5, 0.0, 1.0) * vAlpha;
    if (alpha < 0.004) discard;
    // Coverage pass — see PrimitiveBatch.setCoverageMode; a label joins its
    // layer's flatten rather than blending separately over it. Premultiplied,
    // for the same reason the strokes are.
    if (uCoverageMode > 0.5) {
      gl_FragColor = vec4(vColor * alpha, alpha);
      return;
    }
    gl_FragColor = vec4(vColor, alpha);
    #include <colorspace_fragment>
  }
`

/**
 * The largest font (world units) whose label block — an UPRIGHT axis-aligned
 * box needing `kW`/`kH` half-extents per font unit — fits inside a rotated
 * rectangle of half-extents (a, b) at angle `theta`, both centered together.
 * A centered upright box (u, v) sits inside the rotated rect iff
 * `u·|cosθ| + v·|sinθ| ≤ a` and `u·|sinθ| + v·|cosθ| ≤ b`; with u = kW·f and
 * v = kH·f both constraints are linear in f, so the answer is exact.
 */
export function uprightFitFont(
  a: number,
  b: number,
  theta: number,
  kW: number,
  kH: number
): number {
  const c = Math.abs(Math.cos(theta))
  const s = Math.abs(Math.sin(theta))
  const byA = kW * c + kH * s
  const byB = kW * s + kH * c
  const f = Math.min(byA > 1e-12 ? a / byA : Infinity, byB > 1e-12 ? b / byB : Infinity)
  return Number.isFinite(f) ? Math.max(f, 0) : 0
}

/**
 * The widest UPRIGHT half-width available at half-height `v` inside the same
 * rotated rectangle — the constraint pair above solved for u instead of f. A
 * block fitted by `uprightFitFont` gets exactly the width its own solve used,
 * so a line too long for it can shrink to the room alone.
 */
export function uprightHalfWidth(a: number, b: number, theta: number, v: number): number {
  const c = Math.abs(Math.cos(theta))
  const s = Math.abs(Math.sin(theta))
  const byA = c > 1e-12 ? (a - v * s) / c : Infinity
  const byB = s > 1e-12 ? (b - v * c) / s : Infinity
  return Math.max(0, Math.min(byA, byB))
}

/**
 * Fallback only — the scenes set this from `--vscode-canvas-pad-number`, which
 * flips with the theme. A pad number is ink ON a pad, so it is read against the
 * layer color under it rather than against the canvas.
 */
const LABEL_COLOR_FALLBACK = '#101513'

export interface LabelBatchOptions {
  /** Off for a scene whose draw order is authoritative — see `LayeredBatch`. */
  depthWrite?: boolean
  /** A board's view (`boardView.ts`), as `PrimitiveBatchOptions.view`. */
  view?: BatchView
}

export class LabelBatch {
  public readonly mesh: THREE.Mesh

  private geometry!: THREE.InstancedBufferGeometry
  private material: THREE.ShaderMaterial
  private atlas: GlyphAtlas

  private capacity = 0
  private count = 0
  private freeList: number[] = []

  private pos!: Float32Array
  private misc!: Float32Array
  private uv!: Float32Array

  private attrPos!: THREE.InstancedBufferAttribute
  private attrMisc!: THREE.InstancedBufferAttribute
  private attrUV!: THREE.InstancedBufferAttribute
  /** A board's per-glyph view meta (`boardView.ts`); absent without a view. */
  private meta?: Uint32Array
  private attrMeta?: THREE.InstancedBufferAttribute
  /** The board view this batch draws under, if any (see `PrimitiveBatch.view`). */
  public readonly view?: BatchView
  /** The meta the next glyph written takes (see `PrimitiveBatch.writeMeta`). */
  public writeMeta = new Uint32Array(4)
  /** What the next draw sends: only the glyphs written since the last. */
  private readonly uploads = new InstanceUploads<'pos' | 'misc' | 'uv' | 'meta'>()
  /** Glyphs hidden where they stand, by a preview or a lift: their alpha is 0. */
  private readonly hides = new InPlaceHides(
    (i) => this.misc[i * 4 + 3],
    (i, alpha) => {
      this.misc[i * 4 + 3] = alpha
      this.uploads.touch('misc', i)
    },
    0
  )

  // element key ("pad:0") -> glyph instance indices
  private elementInstances = new Map<string, number[]>()

  /** Which keys are parts of which — see KeyHierarchy (mirrors PrimitiveBatch). */
  private childKeys = new KeyHierarchy()
  // element key -> snapshot of instance centers at drag start
  private dragOrigins = new Map<string, Float32Array>()

  private bounds = new THREE.Box3()

  constructor(initialCapacity = 512, options: LabelBatchOptions = {}) {
    this.atlas = getAtlas()
    this.material = new THREE.ShaderMaterial({
      uniforms: {
        uAtlas: { value: this.atlas.texture },
        uColor: { value: new THREE.Color(LABEL_COLOR_FALLBACK) },
        uPixelSize: primitiveBatchUniforms.uPixelSize,
        uCoverageMode: { value: 0 },
        ...(options.view ? batchViewUniforms(options.view) : {})
      },
      defines: options.view ? { BOARD_VIEW: '' } : {},
      vertexShader,
      fragmentShader,
      transparent: true,
      depthTest: true,
      depthWrite: options.depthWrite ?? true,
      side: THREE.DoubleSide
    })

    this.view = options.view
    this.allocate(initialCapacity)
    this.mesh = new THREE.Mesh(this.geometry, this.material)
    this.mesh.frustumCulled = false
    // Labels draw on top of pads, fills, and hatches (vertex handles are 2000)
    this.mesh.renderOrder = 1000
    // Selection uses the analytic hitTest; never raycast the batch quad
    this.mesh.raycast = () => {}
  }

  /** Coverage for an offscreen layer flatten — see PrimitiveBatch. */
  public setCoverageMode(on: boolean): void {
    this.material.uniforms.uCoverageMode.value = on ? 1 : 0
    if (on) {
      this.material.blending = THREE.CustomBlending
      this.material.blendEquation = THREE.MaxEquation
      this.material.blendEquationAlpha = THREE.MaxEquation
      this.material.blendSrc = THREE.OneFactor
      this.material.blendDst = THREE.OneFactor
      this.material.blendSrcAlpha = THREE.OneFactor
      this.material.blendDstAlpha = THREE.OneFactor
    } else {
      this.material.blending = THREE.NormalBlending
    }
    this.material.needsUpdate = true
  }

  private allocate(capacity: number): void {
    const newPos = new Float32Array(capacity * 4)
    const newMisc = new Float32Array(capacity * 4)
    const newUV = new Float32Array(capacity * 4)

    if (this.pos) {
      newPos.set(this.pos)
      newMisc.set(this.misc)
      newUV.set(this.uv)
    }
    if (this.view) {
      const newMeta = new Uint32Array(capacity * 4)
      if (this.meta) newMeta.set(this.meta)
      this.meta = newMeta
    }

    this.pos = newPos
    this.misc = newMisc
    this.uv = newUV
    this.capacity = capacity

    const geometry = new THREE.InstancedBufferGeometry()
    const quad = new THREE.PlaneGeometry(2, 2)
    geometry.setIndex(quad.getIndex())
    geometry.setAttribute('position', quad.getAttribute('position'))

    this.attrPos = new THREE.InstancedBufferAttribute(this.pos, 4)
    this.attrMisc = new THREE.InstancedBufferAttribute(this.misc, 4)
    this.attrUV = new THREE.InstancedBufferAttribute(this.uv, 4)
    this.attrPos.setUsage(THREE.DynamicDrawUsage)
    this.attrMisc.setUsage(THREE.DynamicDrawUsage)
    this.attrUV.setUsage(THREE.DynamicDrawUsage)
    if (this.meta) {
      this.attrMeta = new THREE.InstancedBufferAttribute(this.meta, 4)
      this.attrMeta.setUsage(THREE.DynamicDrawUsage)
      geometry.setAttribute('iMeta', this.attrMeta)
    }
    this.uploads.bind({
      pos: this.attrPos,
      misc: this.attrMisc,
      uv: this.attrUV,
      meta: this.attrMeta
    })
    geometry.setAttribute('iPos', this.attrPos)
    geometry.setAttribute('iMisc', this.attrMisc)
    geometry.setAttribute('iUV', this.attrUV)
    geometry.instanceCount = this.count

    const old = this.geometry
    this.geometry = geometry
    if (this.mesh) {
      this.mesh.geometry = geometry
    }
    if (old) old.dispose()
  }

  private allocIndex(): number {
    const reused = this.freeList.pop()
    if (reused !== undefined) return reused
    if (this.count >= this.capacity) this.allocate(this.capacity * 2)
    this.geometry.instanceCount = this.count + 1
    return this.count++
  }

  /**
   * Add a text label centered at (cx, cy). `refDim` is the pad reference
   * dimension controlling the font size (same rule as the legacy sprites).
   */
  public addLabel(
    key: string,
    text: string,
    cx: number,
    cy: number,
    z: number,
    refDim: number
  ): void {
    if (!text) return

    const fontWorld = refDim * LABEL_FONT_WORLD
    const s = fontWorld / FONT_PX // world units per render px
    const aaFactor = 1 / (2 * SPREAD * s)

    this.emitRun(key, text, cx, cy, z, s, aaFactor, 0, 0, 0, 1)
  }

  /**
   * One horizontal glyph run, centered at local (dx, dy) relative to a block
   * center (cx, cy), the whole block rotated by `rotation` about that center.
   * `s` is world units per render px; dy names the run's CAP center.
   */
  private emitRun(
    key: string,
    text: string,
    cx: number,
    cy: number,
    z: number,
    s: number,
    aaFactor: number,
    dx: number,
    dy: number,
    rotation: number,
    alpha: number
  ): void {
    const chars = Array.from(text)
    const glyphs = chars.map((c) => this.atlas.getGlyph(c))

    let totalAdvance = 0
    for (const g of glyphs) totalAdvance += g.advance
    let penX = dx - (totalAdvance * s) / 2
    // Align the cap-height center of the run with (dx, dy)
    const quadDy = dy - s * (CELL_H_R / 2 - CAP_CENTER_Y_R)
    const halfH = (CELL_H_R * s) / 2
    const cos = Math.cos(rotation)
    const sin = Math.sin(rotation)

    for (const g of glyphs) {
      if (!g.empty) {
        const i = this.allocIndex()
        const o = i * 4
        const halfW = (g.cellWr * s) / 2
        const quadDx = penX - PAD_R * s + halfW
        const quadCx = cx + quadDx * cos - quadDy * sin
        const quadCy = cy + quadDx * sin + quadDy * cos

        this.pos[o] = quadCx
        this.pos[o + 1] = quadCy
        this.pos[o + 2] = halfW
        this.pos[o + 3] = halfH

        this.misc[o] = z
        this.misc[o + 1] = aaFactor
        this.misc[o + 2] = rotation
        this.misc[o + 3] = alpha

        this.uv[o] = g.u0
        this.uv[o + 1] = g.v0
        this.uv[o + 2] = g.u1
        this.uv[o + 3] = g.v1
        this.meta?.set(this.writeMeta, o)

        let list = this.elementInstances.get(key)
        if (!list) {
          list = []
          this.elementInstances.set(key, list)
          this.childKeys.add(key)
        }
        list.push(i)
        this.uploads.touchInstance(i)

        // Conservative bound: the rotated quad fits in its circumradius.
        const r = Math.hypot(halfW, halfH)
        this.bounds.expandByPoint(new THREE.Vector3(quadCx - r, quadCy - r, z))
        this.bounds.expandByPoint(new THREE.Vector3(quadCx + r, quadCy + r, z))
      }
      penX += g.advance * s
    }
  }

  /** Advance of a text in render px (layout math for fitted blocks). */
  private runAdvance(text: string): number {
    let total = 0
    for (const c of Array.from(text)) total += this.atlas.getGlyph(c).advance
    return total
  }

  /**
   * A multi-line UPRIGHT label fitted inside a rotated box — the pad-number +
   * net label (BoardScene). Lines stack top-down, centered, sized per line so
   * the first stays legible however long the rest run; the block never rotates
   * (KiCad keeps pad ink upright), so the fit is the inscription of an upright
   * box in the rotated pad — `uprightFitFont` solves it exactly.
   */
  public addLabelBlock(
    key: string,
    lines: readonly string[],
    cx: number,
    cy: number,
    z: number,
    boxW: number,
    boxH: number,
    rotation: number,
    alpha = 1
  ): void {
    const texts = lines.filter((t) => t.length > 0)
    if (texts.length === 0) return

    // The text stays UPRIGHT at every pad rotation (KiCad's reading); the
    // rotation parameter only shapes the region the block must fit inside.
    // Secondary lines (the net name) render at 70% of the number's size.
    const weights = texts.map((_, i) => (i === 0 ? 1 : 0.7))
    const advances = texts.map((t) => this.runAdvance(t))
    const LINE_PITCH = 1.15 // line box per fontWorld unit
    const MARGIN = 0.9 // usable fraction of the pad box

    // Half-extents the block needs per font unit. Only the FIRST line's width
    // counts: the pad number is the line that has to stay legible, so a long
    // net name shrinks itself to the width the block already has rather than
    // dragging the number down with it — KiCad's pcb_painter likewise sizes
    // each of the two lines from its own length.
    const kW = advances[0] / FONT_PX / 2 / MARGIN
    const kH = (weights.reduce((acc, w) => acc + w, 0) * LINE_PITCH) / 2 / MARGIN

    const font = uprightFitFont(boxW / 2, boxH / 2, rotation, kW, kH)
    if (!(font > 0)) return

    // The width that fit gives the block; line 0 fills it exactly by construction.
    const room = uprightHalfWidth(boxW / 2, boxH / 2, rotation, kH * font) * MARGIN

    // Stack the lines around the block center (y-up: first line on top). A line
    // keeps its reserved band even when its own text renders smaller.
    const pitches = weights.map((w) => font * w * LINE_PITCH)
    const total = pitches.reduce((a, p) => a + p, 0)
    let top = total / 2
    for (let i = 0; i < texts.length; i++) {
      const nominal = font * weights[i]
      const halfRun = (advances[i] * nominal) / FONT_PX / 2
      const lineFont = halfRun > room ? (nominal * room) / halfRun : nominal
      const s = lineFont / FONT_PX
      const aaFactor = 1 / (2 * SPREAD * s)
      const capCenterY = top - pitches[i] / 2
      this.emitRun(key, texts[i], cx, cy, z, s, aaFactor, 0, capCenterY, 0, alpha)
      top -= pitches[i]
    }
  }

  /**
   * A net name laid along a track segment — KiCad's renderNetNameForSegment:
   * text sized from the track width (glyph ≈ 0.55×width), oriented with the
   * segment but normalized so it never reads upside-down, and drawn only
   * when the segment is longer than the name (chars × width, KiCad's gate).
   * KiCad repeats the name per viewport; a retained scene can't, so long
   * segments repeat by LENGTH instead (about every eight name-widths, capped)
   * — with the shader's zoom fade doing the "appears at the right zoom" half.
   */
  public addLabelAlong(
    key: string,
    text: string,
    x0: number,
    y0: number,
    x1: number,
    y1: number,
    trackWidth: number,
    z: number,
    alpha: number
  ): void {
    if (!text || trackWidth <= 0) return
    const chars = Array.from(text).length
    const dx = x1 - x0
    const dy = y1 - y0
    const length = Math.hypot(dx, dy)
    if (length < chars * trackWidth) return

    // Glyph cap ≈ 0.55 × track width (cap height ≈ 0.7 of the font box).
    const font = (trackWidth * 0.55) / 0.7
    const s = font / FONT_PX
    const aaFactor = 1 / (2 * SPREAD * s)
    let angle = Math.atan2(dy, dx)
    while (angle > Math.PI / 2 + 1e-9) angle -= Math.PI
    while (angle <= -Math.PI / 2 + 1e-9) angle += Math.PI

    const nameWorld = this.runAdvance(text) * s
    const repeats = Math.max(1, Math.min(4, Math.round(length / (nameWorld * 8))))
    const divisions = repeats + 1
    for (let i = 1; i < divisions; i++) {
      const t = i / divisions
      this.emitRun(key, text, x0 + dx * t, y0 + dy * t, z, s, aaFactor, 0, 0, angle, alpha)
    }
  }

  /** Drop all instances (start of a full scene rebuild). */
  public reset(): void {
    this.count = 0
    this.freeList = []
    this.hides.clear()
    this.elementInstances.clear()
    this.childKeys.clear()
    this.dragOrigins.clear()
    this.bounds.makeEmpty()
    // What is drawn next is written from slot 0 up, and sent as it is written.
    this.geometry.instanceCount = 0
  }

  /** `key` plus every key filed beneath it. See KeyHierarchy. */
  private expand(key: string): string[] {
    return this.childKeys.expand(key, (k) => this.elementInstances.has(k))
  }

  /** Test-only: per-key glyph positions (see PrimitiveBatch.debugElements). */
  public debugElements(): Map<string, string[]> {
    const out = new Map<string, string[]>()
    for (const [key, all] of this.elementInstances) {
      // A lifted element's home copy is not where its paint is.
      const list = all.filter((i) => !this.hides.isHiddenFor(i, HIDDEN_FOR_LIFT))
      if (list.length === 0) continue
      const rows = list.map((i) => [...this.pos.subarray(i * 4, i * 4 + 4)].join(','))
      rows.sort()
      out.set(key, rows)
    }
    return out
  }

  /**
   * Hide or restore an element's glyphs in place, without recycling them —
   * the label counterpart of `PrimitiveBatch.setElementHidden`, for a preview
   * that stands in for an item (a dragged track) until it is committed or
   * sprung back.
   */
  public setElementHidden(key: string, hidden: boolean): void {
    for (const resolved of this.expand(key)) {
      for (const i of this.elementInstances.get(resolved) ?? []) {
        if (hidden) this.hides.hide(i, HIDDEN_FOR_PREVIEW)
        else this.hides.show(i, HIDDEN_FOR_PREVIEW)
      }
    }
  }

  /** Whether the batch holds any glyph of `key` or its parts. */
  public hasElement(key: string): boolean {
    return this.expand(key).some((resolved) => this.elementInstances.has(resolved))
  }

  /** Every key holding glyphs, a part under its own name. */
  public elementKeys(): string[] {
    return [...this.elementInstances.keys()]
  }

  /**
   * Copy an element's glyphs — and its parts' — into another batch, their z
   * shifted by `dz`, and hide them here (see `PrimitiveBatch.liftCopyTo`). A
   * glyph a preview hides stays hidden in the copy; a drag origin goes too.
   */
  public liftCopyTo(key: string, target: LabelBatch, dz: number): void {
    for (const resolved of this.expand(key)) {
      const list = this.elementInstances.get(resolved)
      if (!list) continue
      for (const i of list) {
        if (this.hides.isHiddenFor(i, HIDDEN_FOR_LIFT)) continue
        const o = i * 4
        target.receiveGlyph(
          resolved,
          this.pos.subarray(o, o + 4),
          this.misc.subarray(o, o + 4),
          this.uv.subarray(o, o + 4),
          this.meta?.subarray(o, o + 4),
          this.hides.shownValue(i),
          dz,
          this.hides.isHiddenFor(i, HIDDEN_FOR_PREVIEW)
        )
        this.hides.hide(i, HIDDEN_FOR_LIFT)
      }
      target.receiveOrigin(resolved, this.dragOrigins.get(resolved))
    }
  }

  /** Show again what `liftCopyTo` hid of an element. */
  public dropLift(key: string): void {
    for (const resolved of this.expand(key))
      for (const i of this.elementInstances.get(resolved) ?? []) this.hides.show(i, HIDDEN_FOR_LIFT)
  }

  /** Whether any glyph of an element — or its parts — has not been copied up by a lift. */
  public hasUnlifted(key: string): boolean {
    return this.expand(key).some((resolved) =>
      (this.elementInstances.get(resolved) ?? []).some(
        (i) => !this.hides.isHiddenFor(i, HIDDEN_FOR_LIFT)
      )
    )
  }

  /**
   * A drag origin arriving with its instances: appended to any this batch
   * already holds for `key`, as the instances were appended to its list.
   */
  private receiveOrigin(key: string, origin: Float32Array | undefined): void {
    if (!origin) return
    const held = this.dragOrigins.get(key)
    if (!held) {
      this.dragOrigins.set(key, origin.slice())
      return
    }
    const joined = new Float32Array(held.length + origin.length)
    joined.set(held)
    joined.set(origin, held.length)
    this.dragOrigins.set(key, joined)
  }

  /** One glyph arriving from `liftCopyTo`, as it is but for its z. */
  private receiveGlyph(
    key: string,
    pos: Float32Array,
    misc: Float32Array,
    uv: Float32Array,
    meta: Uint32Array | undefined,
    alpha: number,
    dz: number,
    previewHidden: boolean
  ): void {
    const i = this.allocIndex()
    const o = i * 4
    this.pos.set(pos, o)
    this.misc.set(misc, o)
    this.misc[o] += dz
    this.misc[o + 3] = alpha
    this.uv.set(uv, o)
    if (meta) this.meta?.set(meta, o)
    let list = this.elementInstances.get(key)
    if (!list) {
      list = []
      this.elementInstances.set(key, list)
      this.childKeys.add(key)
    }
    list.push(i)
    this.uploads.touchInstance(i)
    if (previewHidden) this.hides.hide(i, HIDDEN_FOR_PREVIEW)
  }

  /** Hide and recycle all glyph instances belonging to an element. */
  public removeElement(key: string): void {
    for (const resolved of this.expand(key)) {
      const list = this.elementInstances.get(resolved)
      if (!list) continue
      for (const i of list) {
        this.hides.forget(i)
        // Zero size collapses the quad; no fragments are produced
        this.pos[i * 4 + 2] = 0
        this.pos[i * 4 + 3] = 0
        this.uploads.touch('pos', i)
        this.freeList.push(i)
      }
      this.elementInstances.delete(resolved)
      this.dragOrigins.delete(resolved)
    }
    this.childKeys.delete(key)
  }

  /** Rebind elements to new keys (see PrimitiveBatch.renameElements). */
  public renameElements(renames: ReadonlyArray<readonly [string, string]>): void {
    const moved: Array<{ to: string; instances: number[]; origin: Float32Array | undefined }> = []
    for (const [from, to] of renames) {
      for (const resolved of this.expand(from)) {
        const instances = this.elementInstances.get(resolved)
        if (!instances) continue
        moved.push({
          to: resolved === from ? to : to + resolved.slice(from.length),
          instances,
          origin: this.dragOrigins.get(resolved)
        })
        this.elementInstances.delete(resolved)
        this.dragOrigins.delete(resolved)
      }
      this.childKeys.delete(from)
    }
    for (const m of moved) {
      this.elementInstances.set(m.to, m.instances)
      this.childKeys.add(m.to)
      if (m.origin !== undefined) this.dragOrigins.set(m.to, m.origin)
    }
  }

  public saveOrigins(keys: string[]): void {
    for (const key of keys) {
      for (const resolved of this.expand(key)) {
        const list = this.elementInstances.get(resolved)
        if (!list) continue
        const snapshot = new Float32Array(list.length * 2)
        for (let k = 0; k < list.length; k++) {
          snapshot[k * 2] = this.pos[list[k] * 4]
          snapshot[k * 2 + 1] = this.pos[list[k] * 4 + 1]
        }
        this.dragOrigins.set(resolved, snapshot)
      }
    }
  }

  public clearOrigins(): void {
    this.dragOrigins.clear()
  }

  /** Move an element's glyphs to (drag origin + delta). */
  public translateElement(key: string, dx: number, dy: number): void {
    for (const resolved of this.expand(key)) {
      const list = this.elementInstances.get(resolved)
      const origin = this.dragOrigins.get(resolved)
      if (!list || !origin) continue

      for (let k = 0; k < list.length; k++) {
        const o = list[k] * 4
        this.pos[o] = origin[k * 2] + dx
        this.pos[o + 1] = origin[k * 2 + 1] + dy
        this.uploads.touch('pos', list[k])
      }
    }
  }

  /** Recolor every glyph at once — one uniform, no instance rewrite. */
  public setColor(color: THREE.ColorRepresentation): void {
    ;(this.material.uniforms.uColor.value as THREE.Color).set(color)
  }

  public getBounds(target: THREE.Box3): THREE.Box3 {
    return target.union(this.bounds)
  }

  public dispose(): void {
    this.geometry.dispose()
    this.material.dispose()
  }
}
