import * as THREE from 'three'

/**
 * Infinite 2D Grid Shader Configuration for Three.js.
 * Displays KiCad-style grid dots and origin axes using absolute zoom units.
 * Eliminates fwidth/hardware derivative dependencies for cross-platform stability.
 */
export const GridShader = {
  uniforms: {
    gridSpacing: { value: 1.0 }, // Spacing in mm
    gridOrigin: { value: new THREE.Vector2(0, 0) }, // Where the dots are laid from, mm
    gridColor: { value: new THREE.Color('#7a9185') }, // Lighter grid dots
    axisColorX: { value: new THREE.Color('#5a7065') }, // Uniform muted gray/green X-axis line
    axisColorY: { value: new THREE.Color('#5a7065') }, // Uniform muted gray/green Y-axis line
    gridOpacity: { value: 0.8 },
    axisOpacity: { value: 0.6 },
    originOpacity: { value: 0.4 },
    dotScale: { value: 1.25 },
    majorDotScale: { value: 2.0 },
    pixelSize: { value: 0.025 } // World size of 1 screen pixel (1.0 / zoomFactor)
  },

  vertexShader: `
    varying vec3 vWorldPosition;
    void main() {
      vec4 worldPosition = modelMatrix * vec4(position, 1.0);
      vWorldPosition = worldPosition.xyz;
      gl_Position = projectionMatrix * viewMatrix * worldPosition;
    }
  `,

  fragmentShader: `
    varying vec3 vWorldPosition;
    uniform float gridSpacing;
    uniform vec2 gridOrigin;
    uniform vec3 gridColor;
    uniform vec3 axisColorX;
    uniform vec3 axisColorY;
    uniform float gridOpacity;
    uniform float axisOpacity;
    uniform float originOpacity;
    uniform float dotScale;
    uniform float majorDotScale;
    uniform float pixelSize;

    void main() {
      vec2 coord = vWorldPosition.xy;

      // 1. Grid Dots, laid from the grid origin
      vec2 gridCoord = coord - gridOrigin;
      vec2 gridIdx = abs(round(gridCoord / gridSpacing));
      float modX = mod(gridIdx.x + 0.1, 10.0);
      float modY = mod(gridIdx.y + 0.1, 10.0);
      bool isMajor = (modX < 0.2) || (modY < 0.2);
      
      vec2 nearestGrid = round(gridCoord / gridSpacing) * gridSpacing;
      float distToDot = length(gridCoord - nearestGrid);
      
      float dotMultiplier = isMajor ? majorDotScale : 1.0;
      float dotRadius = pixelSize * dotScale * dotMultiplier;
      float gridIntensity = 1.0 - smoothstep(dotRadius - pixelSize * 0.5, dotRadius + pixelSize * 0.5, distToDot);

      // 2. Origin Axes (Constant 1.5 pixel width)
      float axisHalfWidth = pixelSize * 0.75;
      float axisX = 1.0 - smoothstep(axisHalfWidth - pixelSize * 0.5, axisHalfWidth + pixelSize * 0.5, abs(coord.y)); // y = 0
      float axisY = 1.0 - smoothstep(axisHalfWidth - pixelSize * 0.5, axisHalfWidth + pixelSize * 0.5, abs(coord.x)); // x = 0

      // Fade out grid dots when extremely zoomed out (when pixelSize > gridSpacing / 4.0)
      float maxDistance = gridSpacing * 0.25;
      float gridFade = 1.0 - smoothstep(maxDistance * 0.5, maxDistance, pixelSize);

      // 3. Origin Center Crosshair Marker
      float distToOrigin = length(coord);
      float originCross = 1.0 - smoothstep(pixelSize * 3.0, pixelSize * 4.0, distToOrigin);

      // 3b. A moved grid origin: a ring around it, drawn only off the document origin.
      float ringEdge = abs(length(coord - gridOrigin) - pixelSize * 6.0);
      float gridOriginRing = length(gridOrigin) > pixelSize * 0.5
        ? 1.0 - smoothstep(pixelSize * 0.5, pixelSize * 1.25, ringEdge)
        : 0.0;
      originCross = max(originCross, gridOriginRing);

      // The grid is a TRANSPARENT layer: dots/axes/origin composited over
      // nothing, so anything rendered beneath (the flattened selection-glow
      // layer, the cleared background) shows through between features. Do
      // not output opaque fills here — the plane covers the whole screen
      // and would erase underlays.
      vec4 acc = vec4(0.0);
      float aDots = gridIntensity * gridFade * gridOpacity;
      float aAxisX = axisX * axisOpacity;
      float aAxisY = axisY * axisOpacity;
      float aOrigin = originCross * originOpacity;

      // Sequential "feature over accumulator" compositing, in order:
      // dots, X axis, Y axis, origin marker.
      float outA;
      outA = aDots + acc.a * (1.0 - aDots);
      acc = vec4(outA > 1e-5 ? (gridColor * aDots + acc.rgb * acc.a * (1.0 - aDots)) / outA : vec3(0.0), outA);
      outA = aAxisX + acc.a * (1.0 - aAxisX);
      acc = vec4(outA > 1e-5 ? (axisColorX * aAxisX + acc.rgb * acc.a * (1.0 - aAxisX)) / outA : vec3(0.0), outA);
      outA = aAxisY + acc.a * (1.0 - aAxisY);
      acc = vec4(outA > 1e-5 ? (axisColorY * aAxisY + acc.rgb * acc.a * (1.0 - aAxisY)) / outA : vec3(0.0), outA);
      outA = aOrigin + acc.a * (1.0 - aOrigin);
      acc = vec4(outA > 1e-5 ? (vec3(1.0) * aOrigin + acc.rgb * acc.a * (1.0 - aOrigin)) / outA : vec3(0.0), outA);

      gl_FragColor = acc;
      #include <colorspace_fragment>
    }
  `
}
