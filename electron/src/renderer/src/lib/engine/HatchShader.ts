import * as THREE from 'three'
import { primitiveBatchUniforms } from './PrimitiveBatch'

/** Hatch stripe patterns (matches KiCad fill styles). */
export const HATCH_PATTERN = {
  /**
   * Stripes along y − x = c in the mesh's own frame: rising left to right
   * (`/`) where y is up, as it is in every scene (KiCad "hatch").
   */
  HATCH: 1,
  /** Stripes along y + x = c: falling left to right (`\`) (KiCad "reverse_hatch"). */
  REVERSE: 2,
  /** Both directions (KiCad "cross_hatch") */
  CROSS: 3
} as const

const vertexShader = /* glsl */ `
  varying vec2 vLocal;

  void main() {
    vLocal = position.xy;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`

/**
 * Draws the stripe pattern procedurally in geometry-local space, so the
 * pattern is clipped exactly to the polygon triangles and translates with
 * the mesh. Stripe spacing/width stay correct at every zoom; anti-aliasing
 * width comes from the shared uPixelSize uniform.
 */
const fragmentShader = /* glsl */ `
  uniform vec3 uColor;
  uniform float uOpacity;
  uniform float uPitch;
  uniform float uHalfStroke;
  uniform float uPattern;
  uniform float uPixelSize;

  varying vec2 vLocal;

  float stripeCoverage(float s, float aa) {
    // Distance to the nearest stripe centerline (multiples of uPitch)
    float d = abs(s - uPitch * floor(s / uPitch + 0.5));
    // Never thinner than one screen pixel — the strokes' own floor
    // (minStrokePixels) — so a zero half-stroke is a hairline at every zoom.
    float halfStroke = max(uHalfStroke, 0.5 * aa);
    return clamp(0.5 - (d - halfStroke) / aa, 0.0, 1.0);
  }

  void main() {
    float aa = max(uPixelSize, 1e-6);
    float invSqrt2 = 0.7071067811865476;

    float cov = 0.0;
    if (uPattern < 1.5 || uPattern > 2.5) {
      // -45 degree stripes: rotated-space y' = (y - x) / sqrt(2)
      cov = max(cov, stripeCoverage((vLocal.y - vLocal.x) * invSqrt2, aa));
    }
    if (uPattern > 1.5) {
      // +45 degree stripes: rotated-space y' = (y + x) / sqrt(2)
      cov = max(cov, stripeCoverage((vLocal.y + vLocal.x) * invSqrt2, aa));
    }

    if (cov < 0.004) discard;
    gl_FragColor = vec4(uColor, uOpacity * cov);
    #include <colorspace_fragment>
  }
`

/**
 * Create a hatch fill material. One material per hatched element (uniforms
 * are per-element) — the compiled program is shared by Three.js since the
 * shader source is identical.
 */
export function createHatchMaterial(
  color: THREE.Color,
  opacity: number,
  pitch: number,
  halfStroke: number,
  pattern: number
): THREE.ShaderMaterial {
  const mat = new THREE.ShaderMaterial({
    uniforms: {
      uColor: { value: color.clone() },
      uOpacity: { value: opacity },
      uPitch: { value: pitch },
      uHalfStroke: { value: halfStroke },
      uPattern: { value: pattern },
      uPixelSize: primitiveBatchUniforms.uPixelSize
    },
    vertexShader,
    fragmentShader,
    transparent: true,
    depthTest: true,
    // The scenes that draw hatches order themselves by paint (see LayeredBatch);
    // a hatch that wrote depth would mask its own stripes out of what follows.
    depthWrite: false,
    side: THREE.DoubleSide
  })
  // Flag for highlight handling in FootprintScene (uColor instead of .color)
  mat.userData = { isHatch: true }
  return mat
}
