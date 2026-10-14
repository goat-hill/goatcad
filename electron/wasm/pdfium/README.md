# pdfium wasm build

pdfium compiled to WebAssembly behind our own flat C ABI (`glue.cpp`), the
engine for reading datasheets on every platform the app runs on. Same shape as
`../clipper2/`: pinned upstream, one Docker image for the toolchain, our own
exports and no embind.

## What is committed

`src/main/wasm/` holds the build outputs, so app builds, tests and CI use
them as-is and **nobody needs emscripten unless they are rebuilding**:

- `pdfium.js` — generated Emscripten loader (lint/format-ignored)
- `pdfium.wasm` — the module, about 3.4 MB
- `pdfium.version.json` — provenance: pdfium branch and commit, toolchain
- `pdfium.d.ts` — hand-written types for the loader and the ABI

The consumer is `src/main/datasheetReader.ts` behind the `read_datasheet` op
(`docs/parts-mcp-workstream.md` §11.4), on a worker thread that loads the
module on the first read and is retired after a minute idle: the module
instantiates in about 10 ms, so there is nothing to gain by preloading, and
30 to 70 MB of heap to give back.

What is different from Clipper2: pdfium is not a tarball but a Chromium-style
checkout driven by depot_tools, gn and ninja, so `build.sh` fetches that
toolchain into `upstream/` (gitignored, several GB) and patches three files to
let gn target emscripten. Run the gates from `electron/` as usual; the
formatter and linter ignore `wasm/*/upstream/`, and that matters — prettier
will otherwise rewrite the checkout.

## Files

- `build.sh` — the whole pipeline: checkout, patch, configure, build, link.
  Takes an optional step name to resume from (`patch`, `configure`, `build`,
  `link`) when iterating on a failure. Runs inside the pinned emsdk image;
  on a machine where Docker needs root, `sudo build.sh` keeps outputs owned
  by the invoking user.
- `patches/` — ours, authored against the pinned pdfium branch and the
  Chromium `build/` revision its DEPS pins. `build-default-toolchain.patch`
  removes Chromium's refusal to make wasm the default toolchain (it exists
  only because Chromium's own root targets cannot build for it; pdfium's
  can). `pdfium-fxge-platform.patch` gives wasm a platform layer by reusing
  the Linux one. `pdfium-openjpeg-posix.patch` asks musl for `fseeko` on the
  one C11 target that calls it. Anything more the build needs is discovered
  by building.
- `glue.cpp` — the ABI. All coordinates are page points, top-left origin,
  y down, so text boxes and render clips line up with a page image by one
  scale factor. Text comes back as UTF-16LE (pdfium's native encoding);
  renders come back as tightly packed BGRA rows.
- `smoke.mjs` — generates a one-page PDF in memory, opens it, checks page
  count and size, extracts text and per-character boxes, renders the page
  and a clip around the first glyph, and prints timings. Plain `node`, no
  harness: `node wasm/pdfium/smoke.mjs`.

## Measured

On a 43-page, 2.5 MB TI datasheet: open 3 ms, text for every page 175 ms,
a page rendered at 2x (about 1200 by 1600 px) in 27 ms. On a 653-page, 33 MB
Microchip datasheet: open 23 ms, 1.3 ms per page of text, 70 MB peak heap.
Text comes back in reading order with rows intact; column identity in spec
tables is not preserved by pdfium's text order, which is what the
per-character boxes are for.

## Bumping

Change `PDFIUM_BRANCH` (a `chromium/NNNN` release branch) in `build.sh`,
rebuild, re-run `smoke.mjs`. If a patch fails to apply, re-author it against
the new tree; the reasoning in each patch header says what it is for.
