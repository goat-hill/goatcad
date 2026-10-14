/**
 * Hand-written types for the generated Emscripten loader (`clipper2.js`,
 * built by `electron/wasm/clipper2/build.sh`). The surface is exactly what
 * the build exports — five functions and two heap views.
 *
 * The heap views are replaced wholesale when wasm memory grows, so read them
 * off the module at each use; never cache one across a call that allocates.
 */

export interface Clipper2Module {
  _goat_clip(
    op: number,
    subjCoords: number,
    subjLens: number,
    subjCount: number,
    clipCoords: number,
    clipLens: number,
    clipCount: number,
    scale: number
  ): number
  _goat_offset(
    coords: number,
    lens: number,
    count: number,
    delta: number,
    join: number,
    miterLimit: number,
    arcTolerance: number,
    scale: number
  ): number
  _goat_free(ptr: number): void
  _malloc(bytes: number): number
  _free(ptr: number): void
  HEAPF64: Float64Array
  HEAP32: Int32Array
}

declare const createClipper2: (options?: {
  locateFile?: (file: string) => string
}) => Promise<Clipper2Module>

export default createClipper2
