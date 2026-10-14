# Clipper2 wasm build

GoatCAD's 2D polygon-boolean kernel: [Clipper2](https://github.com/AngusJohnson/Clipper2)
(the engine KiCad links for zone fills) compiled to WebAssembly behind our own
flat C ABI (`glue.cpp`).

## Why our own build and not the `clipper2-wasm` npm package

The npm package binds with Emscripten's **embind**, which generates its JS
invokers with `new Function(...)` at runtime. The renderer's Content Security
Policy (`script-src 'self' 'wasm-unsafe-eval'`) rightly forbids that, and
loosening it to `'unsafe-eval'` for a third-party build choice is backwards.
Our glue exports four plain C functions — no embind, no runtime codegen — so
the module runs under the strict CSP, and the JS side marshals typed arrays
instead of managing embind object lifetimes.

## What is committed

`src/renderer/src/lib/geometry/wasm/` holds the build outputs:

- `clipper2.js` — generated Emscripten ES6 loader (lint/format-ignored)
- `clipper2.wasm` — the module
- `clipper2.version.json` — provenance: Clipper2 version, tarball sha256, toolchain

App builds, tests and CI use these files as-is. **Nobody needs emscripten
unless they are rebuilding the wasm itself.**

## Rebuilding

Needed only to bump the pinned Clipper2 version or after editing `glue.cpp`:

```sh
electron/wasm/clipper2/build.sh
```

Always builds inside the pinned `emscripten/emsdk` Docker image so the
toolchain is identical on every machine — the only requirement is a running
Docker daemon. The script downloads the pinned upstream release tarball into
`upstream/` (gitignored) and verifies its sha256 before compiling. To bump
Clipper2: update `CLIPPER2_VERSION` and `CLIPPER2_SHA256` at the top of
`build.sh`, rebuild, run the test suite (`electron/bin/test` — the
`lib/geometry` suite exercises the real wasm), and commit the changed
artifacts together with the script change.

## The ABI

One call per boolean op (see `glue.cpp` for the full contract):

```
goat_clip(op, subjCoords, subjLens, subjCount,
              clipCoords, clipLens, clipCount, scale) -> f64* | NULL
goat_free(ptr)
```

Coordinates are f64 millimeters; scaling to Clipper2's int64 grid (×1e6,
KiCad's own resolution) happens in C++. The result is a single buffer of
depth-tagged rings in PolyTree order, decoded by
`src/renderer/src/lib/geometry/clip.ts` — the only file that talks to this
module.
