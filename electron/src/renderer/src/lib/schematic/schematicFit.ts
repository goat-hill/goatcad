import * as THREE from 'three'
import { nmToMm } from '../kicad/coordinates'
import type { KicadPaper } from '../kicad/schematic'

/**
 * KiCad's page for a sheet that names none: A4 landscape, nominal mm (the
 * page table in `lib/kicad/schematic.ts`).
 */
const DEFAULT_PAGE_MM = { width: 297, height: 210 }

/**
 * What zoom to fit frames on a schematic sheet, in engine space (mm, y up):
 * the drawing when there is one, else the page it would be drawn on — an
 * empty sheet fits to its paper rather than doing nothing.
 */
export function schematicFitBounds(content: THREE.Box3, paper?: KicadPaper): THREE.Box3 {
  if (!content.isEmpty()) return content
  const width = paper ? nmToMm(paper.width) : DEFAULT_PAGE_MM.width
  const height = paper ? nmToMm(paper.height) : DEFAULT_PAGE_MM.height
  // The page hangs down from the sheet origin; engine space is sheet space
  // with y flipped.
  return new THREE.Box3(new THREE.Vector3(0, -height, 0), new THREE.Vector3(width, 0, 0))
}
