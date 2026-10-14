import { describe, expect, test } from 'vitest'
import { FindingMarkers, MARKER_UNIT_MM } from '../FindingMarkers'

const marker = { key: 'a', x: 10, y: 20, severity: 'error' as const }

/** The pin's on-screen height, px, at a zoom in px/mm. */
const pixelsAt = (zoom: number): number => {
  const layer = new FindingMarkers(0, MARKER_UNIT_MM.board)
  layer.setMarkers([marker])
  layer.setWorldPerPixel(1 / zoom)
  let length = 0
  while (layer.hit(marker.x, marker.y + length)) length += 0.001
  return length * zoom
}

describe('FindingMarkers', () => {
  test('its pin stands on the finding and a click on it names the finding', () => {
    const layer = new FindingMarkers(0, MARKER_UNIT_MM.board)
    layer.setMarkers([marker])
    layer.setWorldPerPixel(1 / 20)
    expect(layer.hit(10, 20.3)?.key).toBe('a')
    expect(layer.hit(10, 19.8)).toBeNull()
    expect(layer.hit(11, 20.3)).toBeNull()
  })

  test('grows as the view zooms in, slower than the design, and stays a target', () => {
    const near = pixelsAt(80)
    const far = pixelsAt(20)
    expect(near).toBeGreaterThan(far)
    expect(near / far).toBeLessThan(4)
    expect(pixelsAt(0.5)).toBeGreaterThanOrEqual(13)
  })

  test('an error draws over a warning, and the picked finding over both', () => {
    const layer = new FindingMarkers(0, MARKER_UNIT_MM.board)
    layer.setWorldPerPixel(1 / 20)
    const warning = { key: 'w', x: 10, y: 20, severity: 'warning' as const }
    const error = { key: 'e', x: 10, y: 20, severity: 'error' as const }
    layer.setMarkers([error, warning])
    expect(layer.hit(10, 20.3)?.key).toBe('e')
    layer.setMarkers([{ ...warning, selected: true }, error])
    expect(layer.hit(10, 20.3)?.key).toBe('w')
  })
})
