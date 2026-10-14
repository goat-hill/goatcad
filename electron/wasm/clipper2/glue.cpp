/**
 * GoatCAD's flat C ABI over Clipper2 — the entire wasm binding surface.
 *
 * Deliberately not embind: embind builds its JS invokers with `new Function`
 * at runtime, which the renderer's Content Security Policy forbids (and
 * should keep forbidding). A C ABI of plain exports needs no generated code,
 * so the module runs under `script-src 'self' 'wasm-unsafe-eval'`, and the
 * JS side needs no per-object memory management — typed arrays in, one
 * buffer out.
 *
 * Coordinates cross the boundary as f64 millimeters; scaling to Clipper2's
 * int64 grid happens here, so JS never touches BigInt.
 */

#include <emscripten.h>

#include <cmath>
#include <cstdint>
#include <cstdlib>
#include <vector>

#include "clipper2/clipper.h"

using namespace Clipper2Lib;

namespace {

void appendPaths(
  Paths64& out,
  const double* coords,
  const int32_t* lens,
  int32_t count,
  double scale
) {
  size_t at = 0;
  for (int32_t p = 0; p < count; p++) {
    Path64 path;
    path.reserve(lens[p]);
    for (int32_t i = 0; i < lens[p]; i++) {
      path.emplace_back(
        static_cast<int64_t>(std::llround(coords[at] * scale)),
        static_cast<int64_t>(std::llround(coords[at + 1] * scale))
      );
      at += 2;
    }
    out.push_back(std::move(path));
  }
}

struct Ring {
  int32_t depth;
  const Path64* path;
};

void collectRings(const PolyPath64& node, int32_t depth, std::vector<Ring>& rings) {
  rings.push_back({depth, &node.Polygon()});
  for (size_t i = 0; i < node.Count(); i++) collectRings(*node.Child(i), depth + 1, rings);
}

/**
 * A PolyTree as the one buffer the JS side decodes:
 *   [ringCount][ringCount * (depth, vertexCount)][all coords x,y in mm]
 * depth-first, even depth an outer ring, odd a hole. NULL if malloc fails.
 */
double* encodeTree(const PolyTree64& tree, double scale) {
  std::vector<Ring> rings;
  for (size_t i = 0; i < tree.Count(); i++) collectRings(*tree.Child(i), 0, rings);

  size_t points = 0;
  for (const Ring& ring : rings) points += ring.path->size();
  const size_t doubles = 1 + rings.size() * 2 + points * 2;
  double* buffer = static_cast<double*>(std::malloc(doubles * sizeof(double)));
  if (!buffer) return nullptr;

  double* w = buffer;
  *w++ = static_cast<double>(rings.size());
  for (const Ring& ring : rings) {
    *w++ = static_cast<double>(ring.depth);
    *w++ = static_cast<double>(ring.path->size());
  }
  const double inv = 1.0 / scale;
  for (const Ring& ring : rings) {
    for (const Point64& pt : *ring.path) {
      *w++ = static_cast<double>(pt.x) * inv;
      *w++ = static_cast<double>(pt.y) * inv;
    }
  }
  return buffer;
}

}  // namespace

extern "C" {

/**
 * Boolean op over two path sets, NonZero fill.
 *
 * op: 0 difference, 1 intersection, 2 union, 3 xor.
 * Inputs: flat [x0,y0,x1,y1,...] coords in mm; `lens` gives vertices per
 * ring. Winding decides holes, as Clipper2 has it: opposite of the outer.
 *
 * Returns one malloc'd f64 buffer the caller must goat_free:
 *   [ringCount][ringCount * (depth, vertexCount)][all coords x,y in mm]
 * Rings arrive in PolyTree depth-first order — even depth is an outer ring,
 * odd depth a hole in the ring above it. Returns NULL on any failure.
 */
EMSCRIPTEN_KEEPALIVE
double* goat_clip(
  int32_t op,
  const double* subjCoords,
  const int32_t* subjLens,
  int32_t subjCount,
  const double* clipCoords,
  const int32_t* clipLens,
  int32_t clipCount,
  double scale
) {
  try {
    Paths64 subjects;
    Paths64 clips;
    appendPaths(subjects, subjCoords, subjLens, subjCount, scale);
    appendPaths(clips, clipCoords, clipLens, clipCount, scale);

    const ClipType type = op == 0   ? ClipType::Difference
                          : op == 1 ? ClipType::Intersection
                          : op == 2 ? ClipType::Union
                                    : ClipType::Xor;
    Clipper64 clipper;
    clipper.AddSubject(subjects);
    clipper.AddClip(clips);
    PolyTree64 tree;
    if (!clipper.Execute(type, FillRule::NonZero, tree)) return nullptr;
    return encodeTree(tree, scale);
  } catch (...) {
    return nullptr;
  }
}

/**
 * Grow (delta > 0) or shrink (delta < 0) a region set by `delta` mm: its
 * outers and holes as closed polygons, NonZero, as a zone fill's minimum-width
 * pass needs. join: 0 round, 1 miter, 2 square, 3 bevel. `arcTolerance` (mm)
 * is how far a round join's chords may fall inside the true arc; `miterLimit`
 * applies to miter joins. The result is unioned so it comes back as a tree,
 * in the same buffer layout as goat_clip. NULL on any failure.
 */
EMSCRIPTEN_KEEPALIVE
double* goat_offset(
  const double* coords,
  const int32_t* lens,
  int32_t count,
  double delta,
  int32_t join,
  double miterLimit,
  double arcTolerance,
  double scale
) {
  try {
    Paths64 paths;
    appendPaths(paths, coords, lens, count, scale);
    const JoinType joinType = join == 0   ? JoinType::Round
                              : join == 1 ? JoinType::Miter
                              : join == 2 ? JoinType::Square
                                          : JoinType::Bevel;
    ClipperOffset offset(miterLimit, arcTolerance * scale);
    offset.AddPaths(paths, joinType, EndType::Polygon);
    Paths64 grown;
    offset.Execute(delta * scale, grown);

    Clipper64 clipper;
    clipper.AddSubject(grown);
    PolyTree64 tree;
    if (!clipper.Execute(ClipType::Union, FillRule::NonZero, tree)) return nullptr;
    return encodeTree(tree, scale);
  } catch (...) {
    return nullptr;
  }
}

EMSCRIPTEN_KEEPALIVE
void goat_free(void* ptr) {
  std::free(ptr);
}

}  // extern "C"
