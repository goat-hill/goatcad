/**
 * A canvas's size in DEVICE pixels, exactly — what its drawing buffer has to be
 * for the compositor to put it on screen 1:1.
 *
 * `floor(clientWidth * devicePixelRatio)` is not that. `clientWidth` is a whole
 * CSS pixel and a laid-out box is not: half of a split is 697.17px wide, and at
 * a ratio of 1.5 its box covers 1046 device pixels while the arithmetic says
 * 1045. The buffer is then stretched by a fraction of a pixel across the pane —
 * and sized to a whole-pixel CSS width, it no longer fills the box, so it sits
 * on a fractional device pixel too. Either resamples the whole canvas, and a
 * one-pixel stroke smears across two. Only the browser knows where it snapped
 * the box, and `devicePixelContentBoxSize` is where it says so.
 *
 * It also fires when the ratio itself changes with the CSS size unmoved — a
 * window that starts at 1 and is told its fractional scale a moment later, as
 * on Wayland, or one dragged to another monitor.
 */
export function observeDevicePixelSize(
  element: Element,
  onSize: (width: number, height: number) => void
): ResizeObserver {
  const observer = new ResizeObserver((entries) => {
    const entry = entries[entries.length - 1]
    if (!entry) return
    const box = entry.devicePixelContentBoxSize?.[0]
    if (box) {
      onSize(box.inlineSize, box.blockSize)
      return
    }
    const ratio = window.devicePixelRatio
    onSize(
      Math.round(entry.contentRect.width * ratio),
      Math.round(entry.contentRect.height * ratio)
    )
  })
  try {
    observer.observe(element, { box: 'device-pixel-content-box' })
  } catch {
    observer.observe(element)
  }
  return observer
}
