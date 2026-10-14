import * as THREE from 'three'
import { BOARD_VIEW_GLSL, batchViewUniforms, type BatchView } from './boardView'
import { HIDDEN_FOR_LIFT, HIDDEN_FOR_PREVIEW, InPlaceHides } from './inPlaceHides'
import { InstanceUploads } from './instanceUploads'
import { KeyHierarchy } from './keyHierarchy'

/**
 * Shared uniforms for the primitive batch shader. `uPixelSize` is the world
 * size of one screen pixel (1 / zoomFactor) and drives anti-aliasing width;
 * ViewportEngine updates it on every zoom change.
 */
export const primitiveBatchUniforms = {
  uPixelSize: { value: 1.0 / 40.0 },
  /** Drawing-buffer size in device pixels, and whether the view is the flat
   *  orthographic one a pixel grid means anything in — see the snap below. */
  uResolution: { value: new THREE.Vector2(1, 1) },
  uSnapStrokes: { value: 0 }
}

// Instance shape types (stored in iData1.w)
const TYPE_HIDDEN = -1
const TYPE_CAPSULE = 0
const TYPE_RRECT = 1
const TYPE_RING = 2
const TYPE_ARC = 3

/** The drawable instance types by name, for `forEachInstance`. */
export type PrimitiveShape = 'capsule' | 'rrect' | 'ring' | 'arc'
const SHAPE_OF_TYPE: Record<number, PrimitiveShape | undefined> = {
  [TYPE_CAPSULE]: 'capsule',
  [TYPE_RRECT]: 'rrect',
  [TYPE_RING]: 'ring',
  [TYPE_ARC]: 'arc'
}

/**
 * All primitives are instanced unit quads expanded in the vertex shader to a
 * bounding quad around the shape, then filled analytically in the fragment
 * shader with a signed distance function. One draw call renders every stroke,
 * pad, drill, and ring in the footprint.
 *
 * Instance layout:
 *   iData0: capsule -> (x0, y0, x1, y1)
 *           rrect   -> (cx, cy, halfW, halfH)
 *           ring    -> (cx, cy, radius, halfStroke)
 *           arc     -> (cx, cy, radius, halfStroke)
 *   iData1: (param0, param1, z, type)
 *           capsule -> param0 = halfWidth
 *           rrect   -> param0 = cornerRadius, param1 = rotation (rad)
 *           arc     -> param0 = bisector angle (rad), param1 = half-aperture (rad)
 *   iColor: (r, g, b, a)
 *   iMeta:  a board's per-instance view meta (`boardView.ts`), with `view` only
 */
const vertexShader = /* glsl */ `
  attribute vec4 iData0;
  attribute vec4 iData1;
  attribute vec4 iColor;
  #ifdef BOARD_VIEW
  ${BOARD_VIEW_GLSL}
  #endif

  uniform float uPixelSize;
  uniform float uMinStrokePixels;
  uniform vec2 uResolution;
  uniform float uSnapStrokes;
  uniform float uPadPixels;
  uniform float uPadWorld;

  varying vec2 vLocal;
  varying vec4 vShape;
  varying vec4 vColor;
  varying float vType;

  void main() {
    float type = iData1.w;
    vColor = iColor;
    #ifdef BOARD_VIEW
    if (viewHidden()) type = -1.0;
    // The sign of the alpha is the sketch flag; the view scales its size.
    vColor = vec4(viewColor(iColor.rgb), iColor.a);
    #endif
    vType = type;

    if (type < -0.5) {
      // Hidden sentinel: emit degenerate clip-space position
      vLocal = vec2(0.0);
      vShape = vec4(0.0);
      gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
      return;
    }

    float aaPad = uPixelSize * 1.5;
    // Uniform outward offset of every shape in the batch, part screen-space
    // and part world-space — the selection-glow batch uses this to grow halos
    // KiCad's way (SCH_PAINTER::getShadowWidth: "a cross between the zoom
    // level and the default line width") without touching instance data, so
    // zooming re-fits the halo with no CPU rewrite. Zero in ordinary batches.
    float pad = uPixelSize * uPadPixels + uPadWorld;
    vec2 world = vec2(0.0);
    // A stroke held at the minimum width is one pixel of ink, and where that
    // pixel falls on the grid decides whether it reads as one crisp line or two
    // gray ones. An axis-aligned one is moved onto the grid; snapAxis names the
    // axis it moves along and snapCenter the point that is measured.
    vec2 snapAxis = vec2(0.0);
    vec2 snapCenter = vec2(0.0);

    if (type < 0.5) {
      // Capsule between endpoints a-b with half-width iData1.x
      vec2 a = iData0.xy;
      vec2 b = iData0.zw;
      vec2 mid = (a + b) * 0.5;
      vec2 d = b - a;
      float len = length(d);
      vec2 dir = len > 1e-9 ? d / len : vec2(1.0, 0.0);
      vec2 perp = vec2(-dir.y, dir.x);
      float halfLen = len * 0.5;
      float minHalf = uPixelSize * uMinStrokePixels * 0.5;
      float hw = max(iData1.x, minHalf) + pad;
      if (uSnapStrokes > 0.5 && iData1.x < minHalf && len > 1e-9) {
        snapCenter = mid;
        if (abs(dir.y) < 1e-5) snapAxis = vec2(0.0, 1.0);
        else if (abs(dir.x) < 1e-5) snapAxis = vec2(1.0, 0.0);
      }
      vLocal = position.xy * vec2(halfLen + hw + aaPad, hw + aaPad);
      vShape = vec4(halfLen, hw, 0.0, 0.0);
      world = mid + dir * vLocal.x + perp * vLocal.y;
    } else if (type < 1.5) {
      // Rounded rect centered at c, half-size hs, corner radius, rotation.
      // The pad also grows the corner radius: that is what a true outward
      // offset of a rounded (or sharp) rectangle looks like.
      vec2 c = iData0.xy;
      vec2 hs = iData0.zw + vec2(pad);
      float rot = iData1.y;
      vLocal = position.xy * (hs + vec2(aaPad));
      vShape = vec4(hs, iData1.x + pad, 0.0);
      float cs = cos(rot);
      float sn = sin(rot);
      world = c + vec2(vLocal.x * cs - vLocal.y * sn, vLocal.x * sn + vLocal.y * cs);
    } else if (type < 2.5) {
      // Ring (circle outline) with radius iData0.z, half-stroke iData0.w
      float halfStroke = max(iData0.w, uPixelSize * uMinStrokePixels * 0.5) + pad;
      float outer = iData0.z + halfStroke + aaPad;
      vLocal = position.xy * outer;
      vShape = vec4(iData0.z, halfStroke, 0.0, 0.0);
      world = iData0.xy + vLocal;
    } else {
      // Arc: quad is generated in the arc's local frame (bisector = +y axis)
      // then rotated into world space; the fragment SDF works in that frame.
      float halfStroke = max(iData0.w, uPixelSize * uMinStrokePixels * 0.5) + pad;
      float outer = iData0.z + halfStroke + aaPad;
      vLocal = position.xy * outer;
      vShape = vec4(iData0.z, halfStroke, sin(iData1.y), cos(iData1.y));
      float rot = iData1.x - 1.5707963267948966;
      float cs = cos(rot);
      float sn = sin(rot);
      world = iData0.xy + vec2(vLocal.x * cs - vLocal.y * sn, vLocal.x * sn + vLocal.y * cs);
    }

    gl_Position = projectionMatrix * modelViewMatrix * vec4(world, iData1.z, 1.0);

    if (snapAxis.x + snapAxis.y > 0.5) {
      vec4 c = projectionMatrix * modelViewMatrix * vec4(snapCenter, iData1.z, 1.0);
      vec2 px = (c.xy / c.w * 0.5 + 0.5) * uResolution;
      // An odd width centers on a pixel, an even one on the line between two.
      float off = 0.5 * mod(floor(uMinStrokePixels + 0.5), 2.0);
      vec2 snapped = floor(px - off + 0.5) + off;
      gl_Position.xy += snapAxis * (snapped - px) * 2.0 / uResolution * c.w;
    }
  }
`

const fragmentShader = /* glsl */ `
  uniform float uPixelSize;
  uniform float uMinCoverage;
  uniform float uCoverageMode;

  varying vec2 vLocal;
  varying vec4 vShape;
  varying vec4 vColor;
  varying float vType;

  void main() {
    float sd;
    if (vType < 0.5) {
      // Capsule along local x-axis: halfLen = vShape.x, halfWidth = vShape.y
      vec2 p = vec2(max(abs(vLocal.x) - vShape.x, 0.0), vLocal.y);
      sd = length(p) - vShape.y;
    } else if (vType < 1.5) {
      // Rounded box: half-size vShape.xy, corner radius vShape.z
      vec2 q = abs(vLocal) - (vShape.xy - vec2(vShape.z));
      sd = length(max(q, vec2(0.0))) + min(max(q.x, q.y), 0.0) - vShape.z;
    } else if (vType < 2.5) {
      // Ring: radius vShape.x, half-stroke vShape.y
      sd = abs(length(vLocal) - vShape.x) - vShape.y;
    } else {
      // Arc with round caps: radius vShape.x, half-stroke vShape.y,
      // half-aperture (sin, cos) in vShape.zw; frame bisector is +y.
      vec2 p = vec2(abs(vLocal.x), vLocal.y);
      vec2 sc = vShape.zw;
      sd = ((sc.y * p.x > sc.x * p.y) ? length(p - sc * vShape.x) : abs(length(p) - vShape.x)) -
        vShape.y;
    }

    // Sketch (outline) mode rides on the alpha's SIGN: a negative alpha draws
    // only a 1 px band along the shape's boundary at |alpha| opacity — the
    // per-instance flag costs no attribute and survives selection recolors,
    // which deliberately keep the stored alpha.
    float alpha = vColor.a;
    if (alpha < 0.0) {
      alpha = -alpha;
      sd = abs(sd) - 0.5 * max(uPixelSize, 1e-6);
    }

    float aa = max(uPixelSize, 1e-6);
    float coverage = clamp(0.5 - sd / aa, 0.0, 1.0);
    if (coverage < uMinCoverage) discard;

    // Coverage pass (see setCoverageMode). PREMULTIPLIED, because the pass
    // blends with max: taking the max of premultiplied color alongside the max
    // of alpha keeps the two consistent, so a fainter thing under a stronger
    // one cannot bleed its color through the result.
    if (uCoverageMode > 0.5) {
      float a = alpha * coverage;
      gl_FragColor = vec4(vColor.rgb * a, a);
      return;
    }
    gl_FragColor = vec4(vColor.rgb, alpha * coverage);
    #include <colorspace_fragment>
  }
`

/** Everything but a fragment the shape misses entirely still paints. */
const PAINT_MIN_COVERAGE = 0.004

export interface PrimitiveBatchOptions {
  minStrokePixels?: number
  /**
   * Outward offset applied to EVERY shape in the batch, in screen pixels
   * (`padPixels`) and world mm (`padWorld`), summed per side in the shader.
   * The selection-glow batch passes KiCad's shadow terms here so halos track
   * zoom without instance rewrites; see the vertex shader note.
   */
  padPixels?: number
  padWorld?: number
  /**
   * `erase` multiplies the destination by (1 - coverage) instead of painting —
   * for offscreen coverage layers (ViewportEngine composite stack) where
   * clear-polarity content must punch antialiased holes in what was drawn
   * before it. Only meaningful when the batch renders into such a target.
   */
  blendMode?: 'normal' | 'erase'
  /**
   * Off for a scene whose draw order is already authoritative (see
   * `LayeredBatch`). A stroke's anti-aliased rim is a fraction of a pixel of
   * paint but a whole pixel of depth, so writing depth from it masks a
   * stroke-shaped outline out of whatever translucent content follows.
   */
  depthWrite?: boolean
  /**
   * Draw as coverage for an offscreen pass the caller tints afterwards, rather
   * than as finished color — see `setCoverageMode`.
   */
  coverage?: boolean
  /**
   * A board's view (`boardView.ts`): each instance keeps a meta word, written
   * from `writeMeta`, and the shader applies the view to it.
   */
  view?: BatchView
}

export class PrimitiveBatch {
  public readonly mesh: THREE.Mesh

  private geometry!: THREE.InstancedBufferGeometry
  private material: THREE.ShaderMaterial
  private coverageMode: boolean

  private capacity = 0
  private count = 0
  private freeList: number[] = []
  /** An instance landed out of z order (a recycled slot, or below the tail): paint order is not z order. */
  private outOfOrder = false

  private data0!: Float32Array
  private data1!: Float32Array
  private color!: Float32Array
  private defaultColor!: Float32Array

  private attr0!: THREE.InstancedBufferAttribute
  private attr1!: THREE.InstancedBufferAttribute
  private attrColor!: THREE.InstancedBufferAttribute
  /** A board's per-instance view meta (`boardView.ts`); absent without a view. */
  private meta?: Uint32Array
  private attrMeta?: THREE.InstancedBufferAttribute

  /** The board view this batch draws under, if any: its slot's uniforms are the caller's to set. */
  public readonly view?: BatchView
  /**
   * The meta the next instance written takes (`boardView.ts`). A layered batch
   * hands every slot the same array, so the scene sets it once per item.
   */
  public writeMeta = new Uint32Array(4)

  // element key ("line:3", "pad:0", ...) -> instance indices
  private elementInstances = new Map<string, number[]>()
  // element key -> snapshot of iData0 slices at drag start
  private dragOrigins = new Map<string, Float32Array>()
  // Keys whose instances currently show a non-default color (selection);
  // resetColors restores exactly these instances instead of rewriting and
  // re-uploading the whole color buffer.
  private coloredKeys = new Set<string>()
  // resolved key -> z offset currently applied to its instances (selection
  // lift); offsets are DELTA-applied so re-applying the same value is free.
  private zOffsets = new Map<string, number>()

  /** Which keys are parts of which — see KeyHierarchy. */
  private childKeys = new KeyHierarchy()
  /** What the next draw sends: only the instances written since the last. */
  private readonly uploads = new InstanceUploads<'d0' | 'd1' | 'color' | 'meta'>()
  /** Instances hidden where they stand, by a preview or a lift: their type is the sentinel. */
  private readonly hides = new InPlaceHides(
    (i) => this.data1[i * 4 + 3],
    (i, type) => {
      this.data1[i * 4 + 3] = type
      this.uploads.touch('d1', i)
    },
    TYPE_HIDDEN
  )

  private bounds = new THREE.Box3()

  constructor(initialCapacity = 2048, options: PrimitiveBatchOptions = {}) {
    const shapeUniforms = {
      uMinStrokePixels: { value: options.minStrokePixels ?? 0 },
      uPadPixels: { value: options.padPixels ?? 0 },
      uPadWorld: { value: options.padWorld ?? 0 }
    }
    this.material = new THREE.ShaderMaterial({
      uniforms: {
        uPixelSize: primitiveBatchUniforms.uPixelSize,
        uResolution: primitiveBatchUniforms.uResolution,
        uSnapStrokes: primitiveBatchUniforms.uSnapStrokes,
        uMinCoverage: { value: PAINT_MIN_COVERAGE },
        uCoverageMode: { value: 0 },
        ...shapeUniforms,
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

    if (options.blendMode === 'erase') {
      this.material.blending = THREE.CustomBlending
      this.material.blendEquation = THREE.AddEquation
      this.material.blendSrc = THREE.ZeroFactor
      this.material.blendDst = THREE.OneMinusSrcAlphaFactor
      this.material.blendSrcAlpha = THREE.ZeroFactor
      this.material.blendDstAlpha = THREE.OneMinusSrcAlphaFactor
    }

    this.coverageMode = options.coverage ?? false
    if (this.coverageMode) this.applyCoverageMode()

    this.view = options.view
    this.allocate(initialCapacity)
    this.mesh = new THREE.Mesh(this.geometry, this.material)
    this.mesh.frustumCulled = false
    // A single-batch scene draws before its standalone fill meshes; a layered
    // one overwrites this per slot (LayeredBatch).
    this.mesh.renderOrder = 1
    // Selection uses the analytic hitTest; never raycast the batch quad
    this.mesh.raycast = () => {}
  }

  /**
   * Draw this batch as *coverage* rather than as finished color: every fragment
   * reports how much paint it is owed, and the caller's composite applies the
   * one color and the one opacity afterwards.
   *
   * The blend equation is the point. Normal alpha blending asks "what was here
   * before?" and mixes, so a stroke crossing another at 15% lands 15% on top of
   * 15% and the joint reads darker than either — which is what makes a
   * preview's tracks look like overlapping ribbons instead of a track. Max asks
   * "how much paint did anything owe this pixel?", the honest question for a
   * single layer: two strokes crossing cover a pixel exactly as thoroughly as
   * one of them does.
   *
   * Taking the max rather than forcing everything opaque is what keeps a zone
   * pour reading fainter than the track over it — the two owe different
   * coverage, so where they meet the stronger simply wins.
   */
  public setCoverageMode(on: boolean): void {
    if (this.coverageMode === on) return
    this.coverageMode = on
    this.applyCoverageMode()
  }

  private applyCoverageMode(): void {
    this.material.uniforms.uCoverageMode.value = this.coverageMode ? 1 : 0
    if (this.coverageMode) {
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
    const newData0 = new Float32Array(capacity * 4)
    const newData1 = new Float32Array(capacity * 4)
    const newColor = new Float32Array(capacity * 4)
    const newDefault = new Float32Array(capacity * 4)

    if (this.data0) {
      newData0.set(this.data0)
      newData1.set(this.data1)
      newColor.set(this.color)
      newDefault.set(this.defaultColor)
    }
    if (this.view) {
      const newMeta = new Uint32Array(capacity * 4)
      if (this.meta) newMeta.set(this.meta)
      this.meta = newMeta
    }

    this.data0 = newData0
    this.data1 = newData1
    this.color = newColor
    this.defaultColor = newDefault
    this.capacity = capacity

    const geometry = new THREE.InstancedBufferGeometry()
    const quad = new THREE.PlaneGeometry(2, 2)
    geometry.setIndex(quad.getIndex())
    geometry.setAttribute('position', quad.getAttribute('position'))

    this.attr0 = new THREE.InstancedBufferAttribute(this.data0, 4)
    this.attr1 = new THREE.InstancedBufferAttribute(this.data1, 4)
    this.attrColor = new THREE.InstancedBufferAttribute(this.color, 4)
    this.attr0.setUsage(THREE.DynamicDrawUsage)
    this.attr1.setUsage(THREE.DynamicDrawUsage)
    this.attrColor.setUsage(THREE.DynamicDrawUsage)
    geometry.setAttribute('iData0', this.attr0)
    geometry.setAttribute('iData1', this.attr1)
    geometry.setAttribute('iColor', this.attrColor)
    if (this.meta) {
      this.attrMeta = new THREE.InstancedBufferAttribute(this.meta, 4)
      this.attrMeta.setUsage(THREE.DynamicDrawUsage)
      geometry.setAttribute('iMeta', this.attrMeta)
    }
    this.uploads.bind({
      d0: this.attr0,
      d1: this.attr1,
      color: this.attrColor,
      meta: this.attrMeta
    })
    geometry.instanceCount = this.count

    const old = this.geometry
    this.geometry = geometry
    if (this.mesh) {
      this.mesh.geometry = geometry
    }
    if (old) old.dispose()
  }

  /** Whether instance `i` broke the ascending-z order a sort leaves. */
  private noteOrder(i: number): void {
    if (i !== this.count - 1 || (i > 0 && this.data1[i * 4 + 2] < this.data1[i * 4 - 2]))
      this.outOfOrder = true
  }

  /** Whether paint order has drifted from z order since the last sort. */
  public get needsSort(): boolean {
    return this.outOfOrder
  }

  private allocIndex(): number {
    const reused = this.freeList.pop()
    if (reused !== undefined) return reused
    // A new buffer is created whole at its first upload, so nothing is queued.
    if (this.count >= this.capacity) this.allocate(this.capacity * 2)
    this.geometry.instanceCount = this.count + 1
    return this.count++
  }

  private writeInstance(
    key: string,
    d0x: number,
    d0y: number,
    d0z: number,
    d0w: number,
    param0: number,
    param1: number,
    z: number,
    type: number,
    color: THREE.Color,
    alpha: number
  ): void {
    const i = this.allocIndex()
    const o = i * 4

    this.data0[o] = d0x
    this.data0[o + 1] = d0y
    this.data0[o + 2] = d0z
    this.data0[o + 3] = d0w

    this.data1[o] = param0
    this.data1[o + 1] = param1
    this.data1[o + 2] = z
    this.data1[o + 3] = type

    this.color[o] = color.r
    this.color[o + 1] = color.g
    this.color[o + 2] = color.b
    this.color[o + 3] = alpha
    this.defaultColor.set(this.color.subarray(o, o + 4), o)
    this.meta?.set(this.writeMeta, o)
    this.noteOrder(i)

    let list = this.elementInstances.get(key)
    if (!list) {
      list = []
      this.elementInstances.set(key, list)
      this.childKeys.add(key)
    }
    list.push(i)

    this.uploads.touchInstance(i)
  }

  /** Expand the cached bounds without allocating Vector3s (hot path: called
   *  once per instance during a full rebuild). */
  private expandBounds(minX: number, minY: number, maxX: number, maxY: number, z: number): void {
    const min = this.bounds.min
    const max = this.bounds.max
    if (minX < min.x) min.x = minX
    if (minY < min.y) min.y = minY
    if (z < min.z) min.z = z
    if (maxX > max.x) max.x = maxX
    if (maxY > max.y) max.y = maxY
    if (z > max.z) max.z = z
  }

  public addCapsule(
    key: string,
    x0: number,
    y0: number,
    x1: number,
    y1: number,
    halfWidth: number,
    color: THREE.Color,
    alpha: number,
    z: number
  ): void {
    this.writeInstance(key, x0, y0, x1, y1, halfWidth, 0, z, TYPE_CAPSULE, color, alpha)
    this.expandBounds(
      Math.min(x0, x1) - halfWidth,
      Math.min(y0, y1) - halfWidth,
      Math.max(x0, x1) + halfWidth,
      Math.max(y0, y1) + halfWidth,
      z
    )
  }

  public addRoundRect(
    key: string,
    cx: number,
    cy: number,
    halfW: number,
    halfH: number,
    cornerRadius: number,
    rotation: number,
    color: THREE.Color,
    alpha: number,
    z: number
  ): void {
    this.writeInstance(
      key,
      cx,
      cy,
      halfW,
      halfH,
      cornerRadius,
      rotation,
      z,
      TYPE_RRECT,
      color,
      alpha
    )
    const r = Math.hypot(halfW, halfH)
    this.expandBounds(cx - r, cy - r, cx + r, cy + r, z)
  }

  public addRing(
    key: string,
    cx: number,
    cy: number,
    radius: number,
    halfStroke: number,
    color: THREE.Color,
    alpha: number,
    z: number
  ): void {
    this.writeInstance(key, cx, cy, radius, halfStroke, 0, 0, z, TYPE_RING, color, alpha)
    const r = radius + halfStroke
    this.expandBounds(cx - r, cy - r, cx + r, cy + r, z)
  }

  /**
   * Circular arc stroke with round caps. `bisector` is the world angle of the
   * arc's angular midpoint (radians, CCW from +x); `aperture` is half the
   * total sweep, so the arc spans bisector ± aperture.
   */
  public addArc(
    key: string,
    cx: number,
    cy: number,
    radius: number,
    halfStroke: number,
    bisector: number,
    aperture: number,
    color: THREE.Color,
    alpha: number,
    z: number
  ): void {
    this.writeInstance(
      key,
      cx,
      cy,
      radius,
      halfStroke,
      bisector,
      aperture,
      z,
      TYPE_ARC,
      color,
      alpha
    )
    const r = radius + halfStroke
    this.expandBounds(cx - r, cy - r, cx + r, cy + r, z)
  }

  /** Drop all instances (start of a full scene rebuild). */
  public reset(): void {
    this.count = 0
    this.freeList = []
    this.outOfOrder = false
    this.elementInstances.clear()
    this.childKeys.clear()
    this.hides.clear()
    this.dragOrigins.clear()
    this.coloredKeys.clear()
    this.zOffsets.clear()
    this.bounds.makeEmpty()
    // What is drawn next is written from slot 0 up, and sent as it is written.
    this.geometry.instanceCount = 0
  }

  /**
   * Sort instances by z ascending so semi-transparent layers (mask/paste)
   * blend correctly over the layers beneath them, and a via's bore paints
   * over its wall. Called once per full rebuild, and after a patch that left
   * instances out of order (`needsSort`): with no depth writes, buffer order
   * is the stacking.
   */
  public finalizeSorted(): void {
    this.outOfOrder = false
    const n = this.count
    // Counting sort: instances share a small set of layer z values, so
    // grouping by z and concatenating groups in ascending order gives the
    // same stable ordering as a comparator sort at O(n) instead of
    // O(n log n) with a JS comparator (hundreds of ms on dense boards).
    const zGroups = new Map<number, number[]>()
    for (let i = 0; i < n; i++) {
      const z = this.data1[i * 4 + 2]
      const group = zGroups.get(z)
      if (group) group.push(i)
      else zGroups.set(z, [i])
    }
    const zs = Array.from(zGroups.keys()).sort((a, b) => a - b)
    const order: number[] = new Array(n)
    let at = 0
    for (const z of zs) {
      const group = zGroups.get(z)!
      for (let k = 0; k < group.length; k++) order[at++] = group[k]
    }

    const oldToNew = new Array<number>(n)
    const d0 = this.data0.slice(0, n * 4)
    const d1 = this.data1.slice(0, n * 4)
    const col = this.color.slice(0, n * 4)
    const def = this.defaultColor.slice(0, n * 4)
    const meta = this.meta?.slice(0, n * 4)

    for (let newIdx = 0; newIdx < n; newIdx++) {
      const oldIdx = order[newIdx]
      oldToNew[oldIdx] = newIdx
      this.data0.set(d0.subarray(oldIdx * 4, oldIdx * 4 + 4), newIdx * 4)
      this.data1.set(d1.subarray(oldIdx * 4, oldIdx * 4 + 4), newIdx * 4)
      this.color.set(col.subarray(oldIdx * 4, oldIdx * 4 + 4), newIdx * 4)
      this.defaultColor.set(def.subarray(oldIdx * 4, oldIdx * 4 + 4), newIdx * 4)
      if (meta) this.meta!.set(meta.subarray(oldIdx * 4, oldIdx * 4 + 4), newIdx * 4)
    }

    for (const list of this.elementInstances.values()) {
      for (let i = 0; i < list.length; i++) list[i] = oldToNew[list[i]]
    }
    // Recycled/hidden slots ride the same permutation (they exist in the
    // buffer as TYPE_HIDDEN instances). Only relevant when a full sort runs
    // after incremental edits; a rebuild resets both first.
    for (let i = 0; i < this.freeList.length; i++) this.freeList[i] = oldToNew[this.freeList[i]]
    this.hides.remap(oldToNew)

    this.uploads.uploadAll()
  }

  /**
   * Rebind elements to new keys — the index-shift fixup after a command
   * splices a board collection (what was `segment:103` is now `segment:100`).
   * Two-phase (collect, then write) so overlapping renames can't clobber each
   * other, and hierarchical: renaming a parent carries its filed child keys.
   * Instance data is untouched — this is pure map surgery.
   */
  public renameElements(renames: ReadonlyArray<readonly [string, string]>): void {
    interface Moved {
      to: string
      instances: number[]
      colored: boolean
      zOffset: number | undefined
      origin: Float32Array | undefined
    }
    const moved: Moved[] = []
    for (const [from, to] of renames) {
      for (const resolved of this.expand(from)) {
        const instances = this.elementInstances.get(resolved)
        if (!instances) continue
        const renamed = resolved === from ? to : to + resolved.slice(from.length)
        moved.push({
          to: renamed,
          instances,
          colored: this.coloredKeys.delete(resolved),
          zOffset: this.zOffsets.get(resolved),
          origin: this.dragOrigins.get(resolved)
        })
        this.elementInstances.delete(resolved)
        this.zOffsets.delete(resolved)
        this.dragOrigins.delete(resolved)
      }
      this.childKeys.delete(from)
    }
    for (const m of moved) {
      this.elementInstances.set(m.to, m.instances)
      this.childKeys.add(m.to)
      if (m.colored) this.coloredKeys.add(m.to)
      if (m.zOffset !== undefined) this.zOffsets.set(m.to, m.zOffset)
      if (m.origin !== undefined) this.dragOrigins.set(m.to, m.origin)
    }
  }

  /** `key` plus every key filed beneath it. See KeyHierarchy. */
  private expand(key: string): string[] {
    return this.childKeys.expand(key, (k) => this.elementInstances.has(k))
  }

  /** `key` as the per-instance calls resolve it: itself, or the parts filed beneath it. */
  public resolveKeys(key: string): string[] {
    return this.expand(key)
  }

  /**
   * Test-only: per-key live instance values, rows sorted — position-in-buffer
   * insensitive, so an incrementally patched batch compares equal to a
   * freshly rebuilt one exactly when their content agrees.
   */
  public debugElements(): Map<string, string[]> {
    const out = new Map<string, string[]>()
    for (const [key, all] of this.elementInstances) {
      // A lifted element's home copy is not where its paint is.
      const list = all.filter((i) => !this.hides.isHiddenFor(i, HIDDEN_FOR_LIFT))
      if (list.length === 0) continue
      const rows = list.map((i) =>
        [
          ...this.data0.subarray(i * 4, i * 4 + 4),
          ...this.data1.subarray(i * 4, i * 4 + 4),
          ...this.color.subarray(i * 4, i * 4 + 4),
          ...(this.meta?.subarray(i * 4, i * 4 + 4) ?? [])
        ].join(',')
      )
      rows.sort()
      out.set(key, rows)
    }
    return out
  }

  /** Test-only: each live instance's z in buffer order, which is paint order. */
  public debugDrawOrder(): number[] {
    const live: number[] = []
    for (const list of this.elementInstances.values())
      live.push(...list.filter((i) => !this.hides.isHiddenFor(i, HIDDEN_FOR_LIFT)))
    live.sort((a, b) => a - b)
    return live.map((i) => this.data1[i * 4 + 2])
  }

  /** Hide and recycle all instances belonging to an element. */
  public removeElement(key: string): void {
    // Removing a parent removes its parts — leaving them behind would orphan
    // paint that nothing can name any more.
    for (const resolved of this.expand(key)) {
      const list = this.elementInstances.get(resolved)
      if (!list) continue
      for (const i of list) {
        this.data1[i * 4 + 3] = TYPE_HIDDEN
        this.uploads.touch('d1', i)
        this.freeList.push(i)
        // Forget any hide: the slot is about to be reused, and a stale one
        // would stamp this element's type onto whatever moves in.
        this.hides.forget(i)
      }
      this.elementInstances.delete(resolved)
      this.coloredKeys.delete(resolved)
      // A recycled slot must not inherit a stale "already lifted" claim.
      this.zOffsets.delete(resolved)
      // Nor a stale origin: what is drawn again under this key saves its own.
      this.dragOrigins.delete(resolved)
    }
    this.childKeys.delete(key)
  }

  /** Whether the batch holds any instance of `key` or its parts. */
  public hasElement(key: string): boolean {
    return this.expand(key).some((resolved) => this.elementInstances.has(resolved))
  }

  /** Every key holding instances, a part under its own name (`footprint:3/pad:1`). */
  public elementKeys(): string[] {
    return [...this.elementInstances.keys()]
  }

  /**
   * Copy an element's instances — and its parts' — into another batch, their z
   * shifted by `dz`, and hide them here: the same paint, drawn at another place
   * in the stack (`LayeredBatch.liftElements`), while these stay where they are
   * in this batch's order for `dropLift` to show again. The copy carries what
   * an instance is: its current and default color, a selection tint, a preview
   * hide, a drag origin (a placement ghost is lifted after its origin is
   * saved). Instances already lifted are not copied again.
   */
  public liftCopyTo(key: string, target: PrimitiveBatch, dz: number): void {
    for (const resolved of this.expand(key)) {
      const list = this.elementInstances.get(resolved)
      if (!list) continue
      for (const i of list) {
        if (this.hides.isHiddenFor(i, HIDDEN_FOR_LIFT)) continue
        const o = i * 4
        target.receiveInstance(
          resolved,
          this.data0.subarray(o, o + 4),
          this.data1.subarray(o, o + 4),
          this.hides.shownValue(i),
          dz,
          this.color.subarray(o, o + 4),
          this.defaultColor.subarray(o, o + 4),
          this.meta?.subarray(o, o + 4),
          this.hides.isHiddenFor(i, HIDDEN_FOR_PREVIEW)
        )
        this.hides.hide(i, HIDDEN_FOR_LIFT)
      }
      if (this.coloredKeys.has(resolved)) target.coloredKeys.add(resolved)
      target.receiveOrigin(resolved, this.dragOrigins.get(resolved))
    }
  }

  /** Show again what `liftCopyTo` hid of an element; its copy is the band's to remove. */
  public dropLift(key: string): void {
    for (const resolved of this.expand(key))
      for (const i of this.elementInstances.get(resolved) ?? []) this.hides.show(i, HIDDEN_FOR_LIFT)
  }

  /** Whether any instance of an element — or its parts — has not been copied up by a lift. */
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

  /** One instance arriving from `liftCopyTo`, as it is but for its z. */
  private receiveInstance(
    key: string,
    d0: Float32Array,
    d1: Float32Array,
    type: number,
    dz: number,
    color: Float32Array,
    defaultColor: Float32Array,
    meta: Uint32Array | undefined,
    previewHidden: boolean
  ): void {
    const i = this.allocIndex()
    const o = i * 4
    this.data0.set(d0, o)
    this.data1.set(d1, o)
    this.data1[o + 2] += dz
    this.data1[o + 3] = type
    this.color.set(color, o)
    this.defaultColor.set(defaultColor, o)
    if (meta) this.meta?.set(meta, o)
    this.noteOrder(i)
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

  public setElementColor(key: string, color: THREE.Color): void {
    for (const resolved of this.expand(key)) {
      const list = this.elementInstances.get(resolved)
      if (!list) continue
      for (const i of list) {
        const o = i * 4
        this.color[o] = color.r
        this.color[o + 1] = color.g
        this.color[o + 2] = color.b
        // Keep default alpha so mask/paste highlights stay translucent
        this.uploads.touch('color', i)
      }
      // Track the resolved keys, so resetColors restores exactly these
      // instances without expanding again.
      this.coloredKeys.add(resolved)
    }
  }

  /**
   * Replay an element's shapes into another batch under the same key, in one
   * color — how a halo batch takes the outline of whatever is selected without
   * the scene re-deriving its geometry. Hidden instances stay out of it.
   */
  public copyElementTo(
    key: string,
    target: PrimitiveBatch,
    color: THREE.Color,
    alpha: number
  ): void {
    for (const resolved of this.expand(key)) {
      const list = this.elementInstances.get(resolved)
      if (!list) continue
      for (const i of list) {
        const o = i * 4
        if (this.data1[o + 3] === TYPE_HIDDEN) continue
        target.writeInstance(
          key,
          this.data0[o],
          this.data0[o + 1],
          this.data0[o + 2],
          this.data0[o + 3],
          this.data1[o],
          this.data1[o + 1],
          this.data1[o + 2],
          this.data1[o + 3],
          color,
          alpha
        )
      }
    }
  }

  /**
   * Shift every instance of an element from its own default color. Positive
   * amounts lighten toward white; negative amounts darken toward black.
   */
  public shiftElementColors(key: string, amount: number): void {
    const clamped = THREE.MathUtils.clamp(amount, -1, 1)
    for (const resolved of this.expand(key)) {
      const list = this.elementInstances.get(resolved)
      if (!list) continue
      for (const i of list) {
        const o = i * 4
        for (let channel = 0; channel < 3; channel++) {
          const base = this.defaultColor[o + channel]
          this.color[o + channel] =
            clamped >= 0 ? base + (1 - base) * clamped : base * (1 + clamped)
        }
        this.uploads.touch('color', i)
      }
      this.coloredKeys.add(resolved)
    }
  }

  /**
   * Mix every instance of an element from its own default color toward
   * `target` by `amount` (0 leaves it, 1 replaces it). `resetColors` undoes it.
   */
  public tintElementColors(key: string, target: THREE.Color, amount: number): void {
    const t = THREE.MathUtils.clamp(amount, 0, 1)
    const goal = [target.r, target.g, target.b]
    for (const resolved of this.expand(key)) {
      const list = this.elementInstances.get(resolved)
      if (!list) continue
      for (const i of list) {
        const o = i * 4
        for (let channel = 0; channel < 3; channel++) {
          const base = this.defaultColor[o + channel]
          this.color[o + channel] = base + (goal[channel] - base) * t
        }
        this.uploads.touch('color', i)
      }
      this.coloredKeys.add(resolved)
    }
  }

  /**
   * Stop drawing an element without recycling its instances, so it can come
   * back unchanged. `removeElement` frees them and is not reversible.
   *
   * The symbol editor uses this while resizing: a resize changes a shape rather
   * than offsetting it, so `translateElement` cannot express it — the resized
   * form is drawn into the preview batch and the real one is hidden underneath,
   * instead of the two being visible at once.
   */
  public setElementHidden(key: string, hidden: boolean): void {
    for (const resolved of this.expand(key)) {
      for (const i of this.elementInstances.get(resolved) ?? []) {
        if (hidden) this.hides.hide(i, HIDDEN_FOR_PREVIEW)
        else this.hides.show(i, HIDDEN_FOR_PREVIEW)
      }
    }
  }

  /** Bring back everything `setElementHidden` is currently hiding. */
  public showAllHidden(): void {
    for (const i of this.hides.heldFor(HIDDEN_FOR_PREVIEW)) this.hides.show(i, HIDDEN_FOR_PREVIEW)
  }

  /**
   * Repaint elements by key: `paint` returns an element's new color from its
   * current one, or null to leave it. Written as the new DEFAULT color, so a
   * later `resetColors` (a selection clearing) keeps the repaint.
   */
  public repaintElements(paint: (key: string, color: THREE.Color) => THREE.Color | null): void {
    const scratch = new THREE.Color()
    for (const [key, list] of this.elementInstances) {
      for (const i of list) {
        const o = i * 4
        scratch.setRGB(this.defaultColor[o], this.defaultColor[o + 1], this.defaultColor[o + 2])
        const next = paint(key, scratch)
        // Null is a per-key answer: the element's other instances stay too.
        if (!next) break
        this.color[o] = this.defaultColor[o] = next.r
        this.color[o + 1] = this.defaultColor[o + 1] = next.g
        this.color[o + 2] = this.defaultColor[o + 2] = next.b
        this.uploads.touch('color', i)
      }
    }
  }

  /** Restore every recolored instance to its default color. */
  public resetColors(): void {
    if (this.coloredKeys.size === 0) return
    for (const key of this.coloredKeys) {
      const list = this.elementInstances.get(key)
      if (!list) continue
      for (const i of list) {
        const o = i * 4
        this.color.set(this.defaultColor.subarray(o, o + 4), o)
        this.uploads.touch('color', i)
      }
    }
    this.coloredKeys.clear()
  }

  /**
   * Lift an element's instances — and its parts' — by a z offset; 0 restores.
   * This is the DYNAMIC layer over the caller's static z stack: selection
   * bubbles an item above unselected content by offsetting every instance
   * uniformly, so the item's internal stacking rides along unchanged and the
   * depth buffer resolves the rest. Idempotent per key: the applied offset is
   * tracked and only the difference is written.
   */
  public setElementZOffset(key: string, offset: number): void {
    for (const resolved of this.expand(key)) {
      const applied = this.zOffsets.get(resolved) ?? 0
      const delta = offset - applied
      if (delta === 0) continue
      const list = this.elementInstances.get(resolved)
      if (!list) continue
      for (const i of list) {
        this.data1[i * 4 + 2] += delta
        this.uploads.touch('d1', i)
      }
      if (offset === 0) this.zOffsets.delete(resolved)
      else this.zOffsets.set(resolved, offset)
    }
  }

  public saveOrigins(keys: string[]): void {
    // Snapshots are stored per RESOLVED key, so translateElement finds one
    // whether it is handed the parent or the child.
    for (const key of keys) {
      for (const resolved of this.expand(key)) {
        const list = this.elementInstances.get(resolved)
        if (!list) continue
        const snapshot = new Float32Array(list.length * 4)
        for (let k = 0; k < list.length; k++) {
          snapshot.set(this.data0.subarray(list[k] * 4, list[k] * 4 + 4), k * 4)
        }
        this.dragOrigins.set(resolved, snapshot)
      }
    }
  }

  public clearOrigins(): void {
    this.dragOrigins.clear()
  }

  /** Move an element's instances — and its parts' — to (drag origin + delta). */
  public translateElement(key: string, dx: number, dy: number): void {
    const resolved = this.expand(key)
    if (resolved.length > 1 || resolved[0] !== key) {
      for (const child of resolved) this.translateResolved(child, dx, dy)
      return
    }
    this.translateResolved(key, dx, dy)
  }

  private translateResolved(key: string, dx: number, dy: number): void {
    const list = this.elementInstances.get(key)
    const origin = this.dragOrigins.get(key)
    if (!list || !origin) return

    for (let k = 0; k < list.length; k++) {
      const i = list[k]
      const o = i * 4
      const s = k * 4
      const type = this.data1[o + 3]
      this.data0[o] = origin[s] + dx
      this.data0[o + 1] = origin[s + 1] + dy
      if (type === TYPE_CAPSULE) {
        // Capsules store two endpoints; move both
        this.data0[o + 2] = origin[s + 2] + dx
        this.data0[o + 3] = origin[s + 3] + dy
      } else {
        this.data0[o + 2] = origin[s + 2]
        this.data0[o + 3] = origin[s + 3]
      }
      this.uploads.touch('d0', i)
    }
  }

  public getBounds(target: THREE.Box3): THREE.Box3 {
    return target.union(this.bounds)
  }

  /**
   * Every instance that draws, in buffer order, as the raw instance layout the
   * header documents (`iData0`, `iData1`, `iColor`). For a serializer that
   * writes the same shapes to another format (`schematicSvg.ts`): the views are
   * into the live buffers, valid for the duration of the call only.
   */
  public forEachInstance(
    visit: (type: PrimitiveShape, d0: Float32Array, d1: Float32Array, rgba: Float32Array) => void
  ): void {
    for (let i = 0; i < this.count; i++) {
      const o = i * 4
      const shape = SHAPE_OF_TYPE[this.data1[o + 3]]
      if (!shape) continue
      visit(
        shape,
        this.data0.subarray(o, o + 4),
        this.data1.subarray(o, o + 4),
        this.color.subarray(o, o + 4)
      )
    }
  }

  /**
   * Grow `target` by what one element — and its parts — paints where it is now,
   * by the same per-shape extents the batch's own bounds use. Hidden paint
   * counts: a layer switched off still holds the item the user selected.
   */
  public elementBounds(key: string, target: THREE.Box3): THREE.Box3 {
    for (const resolved of this.expand(key)) {
      for (const i of this.elementInstances.get(resolved) ?? []) {
        const o = i * 4
        const type = this.hides.shownValue(i)
        const x = this.data0[o]
        const y = this.data0[o + 1]
        let minX: number, minY: number, maxX: number, maxY: number
        if (type === TYPE_CAPSULE) {
          const half = this.data1[o]
          minX = Math.min(x, this.data0[o + 2]) - half
          maxX = Math.max(x, this.data0[o + 2]) + half
          minY = Math.min(y, this.data0[o + 3]) - half
          maxY = Math.max(y, this.data0[o + 3]) + half
        } else if (type === TYPE_RRECT || type === TYPE_RING || type === TYPE_ARC) {
          const r =
            type === TYPE_RRECT
              ? Math.hypot(this.data0[o + 2], this.data0[o + 3])
              : this.data0[o + 2] + this.data0[o + 3]
          minX = x - r
          maxX = x + r
          minY = y - r
          maxY = y + r
        } else continue
        const z = this.data1[o + 2]
        target.expandByPoint(new THREE.Vector3(minX, minY, z))
        target.expandByPoint(new THREE.Vector3(maxX, maxY, z))
      }
    }
    return target
  }

  public dispose(): void {
    this.geometry.dispose()
    this.material.dispose()
  }
}
