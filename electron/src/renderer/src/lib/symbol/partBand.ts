/**
 * Whether a rubber band takes a symbol part, by the part's bounding box — the
 * symbol editor's band test (SymbolViewport2D's `boxCandidates`). `crossing`
 * is the CAD split every editor draws: a band dragged left takes whatever it
 * touches, one dragged right only what it wholly encloses. Band and bounds in
 * the same units (the editor's are domain nanometers).
 */
export interface PartBounds {
  minX: number
  minY: number
  maxX: number
  maxY: number
}

export interface Band {
  xMin: number
  xMax: number
  yMin: number
  yMax: number
}

export function partInBand(bounds: PartBounds, band: Band, crossing: boolean): boolean {
  if (crossing)
    return (
      bounds.minX <= band.xMax &&
      bounds.maxX >= band.xMin &&
      bounds.minY <= band.yMax &&
      bounds.maxY >= band.yMin
    )
  return (
    bounds.minX >= band.xMin &&
    bounds.maxX <= band.xMax &&
    bounds.minY >= band.yMin &&
    bounds.maxY <= band.yMax
  )
}
