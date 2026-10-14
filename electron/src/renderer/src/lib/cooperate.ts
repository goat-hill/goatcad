/**
 * Cooperative scheduling for long computations on the renderer thread.
 *
 * A stepwise build (a generator that yields between small chunks) is driven
 * in a loop that checks `FRAME_BUDGET_MS` and calls `yieldControl()` when the
 * budget is spent. The yield is a MessageChannel round-trip rather than
 * `setTimeout(0)`: chained timeouts hit Chromium's 4 ms nesting clamp after a
 * few hops, which would add most of a second across a few hundred yields,
 * while a message port resumes on the very next macrotask — input and
 * rendering still interleave, but no forced delay accumulates.
 */

/** How long one uninterrupted slice of work may run, in milliseconds. */
export const FRAME_BUDGET_MS = 12

const channel = typeof MessageChannel !== 'undefined' ? new MessageChannel() : null
const resolvers: Array<() => void> = []
if (channel) {
  channel.port1.onmessage = () => resolvers.shift()?.()
}

/** Resolve on the next macrotask, letting input and rendering run. */
export function yieldControl(): Promise<void> {
  if (!channel) return new Promise((resolve) => setTimeout(resolve, 0))
  return new Promise((resolve) => {
    resolvers.push(resolve)
    channel.port2.postMessage(null)
  })
}

/**
 * Resolve once the browser has had a chance to put a frame on screen: the
 * rAF callback runs while that frame is still being assembled, the macrotask
 * after it. Progress overlays wait on this before lifting, so the bar comes
 * off rendered pixels instead of the blank frame that precedes them.
 */
export function afterPaint(): Promise<void> {
  if (typeof requestAnimationFrame === 'undefined') {
    return new Promise((resolve) => setTimeout(resolve, 0))
  }
  return new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0)))
}
