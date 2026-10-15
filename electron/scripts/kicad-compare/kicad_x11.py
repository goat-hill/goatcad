"""KiCad's window for kicad-compare, through X11 (KiCad runs on XWayland by its own choice).

Run with the system python, which has python-xlib; prints one JSON object on stdout.

  window <pid> <title> <deadline_s>   wait for <pid>'s window titled <title> to map; its epoch ms
  gesture <pid> <pan|zoom>            drive a gesture on its canvas; the epoch ms it ran between
  fallback <pid> <deadline_s>         close KiCad's "could not use OpenGL" notice if it shows

KiCad 10 drops to software rendering, behind a modal notice that stalls its API, when
the GPU reports too little free video memory for the board (cached_container_gpu.cpp).

XWayland drops XTEST input, so the gesture is sent to the canvas as events, which GTK
reads only with GDK_CORE_DEVICE_EVENTS=1 (kicad-compare sets it). The shapes match
the GoatCAD side's in kicad-compare.mjs: a 60-step middle-drag on an ellipse, 16 ms
apart, and 15 wheel notches in then 15 out, 30 ms apart.
"""

import json
import math
import sys
import time

from Xlib import X, Xatom, display
from Xlib.protocol import event

d = display.Display()
root = d.screen().root
NET_WM_PID = d.intern_atom("_NET_WM_PID")
NET_WM_NAME = d.intern_atom("_NET_WM_NAME")
UTF8_STRING = d.intern_atom("UTF8_STRING")


def title_of(w) -> str:
    # GTK puts a title with a non-Latin-1 character ("board — PCB Editor") only here.
    prop = w.get_full_property(NET_WM_NAME, UTF8_STRING)
    if prop is not None:
        value = prop.value
        return value.decode() if isinstance(value, bytes) else str(value)
    return str(w.get_wm_name() or "")


def windows(w=root):
    yield w
    try:
        children = w.query_tree().children
    except Exception:
        return
    for c in children:
        yield from windows(c)


def toplevel(pid: int, title: str):
    for w in windows():
        try:
            if w.get_attributes().map_state != X.IsViewable:
                continue
            prop = w.get_full_property(NET_WM_PID, Xatom.CARDINAL)
            if prop and prop.value[0] == pid and title in title_of(w):
                return w
        except Exception:
            continue
    return None


def canvas(top):
    """The GL canvas's own window if GTK made one, else the toplevel and a point on the canvas."""
    best, area = None, 0
    for w in windows(top):
        if w == top:
            continue
        try:
            g = w.get_geometry()
            if w.get_attributes().map_state == X.IsViewable and g.width * g.height > area:
                best, area = w, g.width * g.height
        except Exception:
            continue
    frame = top.get_geometry()
    if best is None or area < frame.width * frame.height // 4:
        # One X window for the frame: the canvas sits right of center, between the toolbars
        # and the appearance panel.
        return top, int(frame.width * 0.45), frame.height // 2
    g = best.get_geometry()
    return best, g.width // 2, g.height // 2


def send(w, kind, x, y, button=0, state=0):
    origin = w.translate_coords(root, 0, 0)
    fields = dict(
        time=X.CurrentTime,
        root=root,
        window=w,
        child=X.NONE,
        root_x=x - origin.x,
        root_y=y - origin.y,
        event_x=x,
        event_y=y,
        state=state,
        same_screen=1,
    )
    if kind == "motion":
        e = event.MotionNotify(detail=0, **fields)
        mask = X.PointerMotionMask | X.ButtonMotionMask
    else:
        cls = event.ButtonPress if kind == "press" else event.ButtonRelease
        e = cls(detail=button, **fields)
        mask = X.ButtonPressMask if kind == "press" else X.ButtonReleaseMask
    w.send_event(e, event_mask=mask, propagate=True)
    d.flush()


def gesture(pid: int, kind: str) -> dict:
    top = toplevel(pid, "PCB Editor")
    w, cx, cy = canvas(top)
    start = time.time() * 1000
    if kind == "pan":
        send(w, "motion", cx, cy)
        send(w, "press", cx, cy, button=2)
        for i in range(60):
            x = int(cx + math.sin(i / 10) * 300)
            y = int(cy + math.cos(i / 10) * 200)
            send(w, "motion", x, y, state=X.Button2Mask)
            time.sleep(0.016)
        send(w, "release", x, y, button=2, state=X.Button2Mask)
    else:
        send(w, "motion", cx, cy)
        for button in (4, 5):
            for _ in range(15):
                send(w, "press", cx, cy, button=button)
                send(w, "release", cx, cy, button=button)
                time.sleep(0.03)
    return {"start": start, "end": time.time() * 1000}


def close_fallback(pid: int, deadline_s: float) -> dict:
    protocols = d.intern_atom("WM_PROTOCOLS")
    delete = d.intern_atom("WM_DELETE_WINDOW")
    end = time.time() + deadline_s
    while time.time() < end:
        notice = toplevel(pid, "Information")
        if notice is not None:
            # The window manager's close, which dismisses a wx message box.
            data = (32, [delete, X.CurrentTime, 0, 0, 0])
            notice.send_event(event.ClientMessage(window=notice, client_type=protocols, data=data))
            d.flush()
            return {"fallback": True}
        time.sleep(0.05)
    return {"fallback": False}


def main() -> None:
    mode, pid = sys.argv[1], int(sys.argv[2])
    if mode == "fallback":
        print(json.dumps(close_fallback(pid, float(sys.argv[3]))))
    elif mode == "window":
        title, end = sys.argv[3], time.time() + float(sys.argv[4])
        while time.time() < end:
            if toplevel(pid, title) is not None:
                print(json.dumps({"shown": time.time() * 1000}))
                return
            time.sleep(0.01)
        print(json.dumps({"shown": None}))
    else:
        print(json.dumps(gesture(pid, sys.argv[3])))


if __name__ == "__main__":
    main()
