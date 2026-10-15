/*
 * KiCad's window for kicad-compare on macOS: kicad_x11.py's commands, through
 * Quartz. Run as `osascript -l JavaScript kicad_mac.js <command> <pid> ...`;
 * prints one JSON object.
 *
 *   window <pid> <title> <deadline_s>   wait for <pid>'s first sizable window; its epoch ms
 *   gesture <pid> <pan|zoom>            drive a gesture on its largest window; the epoch ms it ran between
 *   fallback <pid> <deadline_s>         always {"fallback": false}: macOS reports no free
 *                                       video memory, so KiCad never takes that path there
 *
 * Window titles need Screen Recording permission, so a window is known by its
 * owner's pid and size, and the title is unused. The gesture is real HID input,
 * which needs Accessibility permission for the terminal; without it macOS drops
 * the events silently and the frame count reads zero. Same shapes as the X11
 * driver: a 60-step middle-drag on an ellipse, 16 ms apart, and 15 wheel
 * notches in then 15 out, 30 ms apart.
 */
/* global ObjC, $ -- JXA, run by osascript, not node */
/* eslint-disable @typescript-eslint/explicit-function-return-type -- plain JS dev script, no type annotations */
ObjC.import('CoreGraphics')
ObjC.import('Foundation')

const now = () => Date.now()
const sleep = (ms) => $.NSThread.sleepForTimeInterval(ms / 1000)

/** The pid's normal-layer windows, largest first, in global display points. */
function windowsOf(pid) {
  const list = ObjC.deepUnwrap(
    ObjC.castRefToObject(
      $.CGWindowListCopyWindowInfo($.kCGWindowListOptionOnScreenOnly, $.kCGNullWindowID)
    )
  )
  return (list || [])
    .filter((w) => w.kCGWindowOwnerPID === pid && w.kCGWindowLayer === 0)
    .map((w) => w.kCGWindowBounds)
    .filter((b) => b.Width > 400 && b.Height > 300)
    .sort((a, b) => b.Width * b.Height - a.Width * a.Height)
}

function post(type, x, y, button) {
  const e = $.CGEventCreateMouseEvent(null, type, $.CGPointMake(x, y), button)
  $.CGEventPost($.kCGHIDEventTap, e)
}

function wheel(lines, x, y) {
  post($.kCGEventMouseMoved, x, y, 0)
  const e = $.CGEventCreateScrollWheelEvent2(null, $.kCGScrollEventUnitLine, 1, lines, 0, 0)
  $.CGEventPost($.kCGHIDEventTap, e)
}

function gesture(pid, kind) {
  const b = windowsOf(pid)[0]
  // The canvas sits right of center, between the toolbars and the appearance panel.
  const cx = b.X + b.Width * 0.45
  const cy = b.Y + b.Height * 0.5
  const start = now()
  if (kind === 'pan') {
    post($.kCGEventMouseMoved, cx, cy, 0)
    post($.kCGEventOtherMouseDown, cx, cy, $.kCGMouseButtonCenter)
    let x = cx
    let y = cy
    for (let i = 0; i < 60; i++) {
      x = cx + Math.sin(i / 10) * 300
      y = cy + Math.cos(i / 10) * 200
      post($.kCGEventOtherMouseDragged, x, y, $.kCGMouseButtonCenter)
      sleep(16)
    }
    post($.kCGEventOtherMouseUp, x, y, $.kCGMouseButtonCenter)
  } else {
    for (const lines of [1, -1]) {
      for (let i = 0; i < 15; i++) {
        wheel(lines, cx, cy)
        sleep(30)
      }
    }
  }
  return { start, end: now() }
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars -- osascript's entry point
function run(argv) {
  const [mode, pidArg, a, b] = argv
  const pid = Number(pidArg)
  if (mode === 'fallback') return JSON.stringify({ fallback: false })
  if (mode === 'window') {
    const end = now() + Number(b) * 1000
    while (now() < end) {
      if (windowsOf(pid).length > 0) return JSON.stringify({ shown: now() })
      sleep(10)
    }
    return JSON.stringify({ shown: null })
  }
  return JSON.stringify(gesture(pid, a))
}
