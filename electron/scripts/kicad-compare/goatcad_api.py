"""GoatCAD's side of kicad-compare's agent-API timings, through the Python client
the app writes into its profile (GOATCAD_CONFIG_DIR names it).

Run by scripts/kicad-compare.mjs with the system python; prints one JSON object
on stdout. Times are wall ms around each call as a script sees it. The first
call of each operation is kept apart from the repeats: it may pay for a load.

  ready <board> <deadline_s>         poll until the board answers; print the epoch ms it did
  ops <board> <reps> <ref> <outdir>  time the warm operations, <reps> times each

A fresh profile holds one workspace, so every call acts in it. A footprint's id is
its reference.
"""

import importlib
import json
import os
import statistics
import sys
import time
from pathlib import Path

CLIENT_DIR = str(Path(os.environ["GOATCAD_CONFIG_DIR"]) / "python")
sys.path.insert(0, CLIENT_DIR)


def connect():
    # Imported late: the app writes the client as it starts, after this polls. A miss
    # before then is cached against the folder, so each try forgets it.
    sys.path_importer_cache.pop(CLIENT_DIR, None)
    importlib.invalidate_caches()
    from goatcad import connect as client

    return client(timeout=600)


def footprints(gc, board: str) -> list:
    return gc.items.query(board=board, kind="footprint")["items"]


def ready(board: str, deadline_s: float) -> dict:
    end = time.time() + deadline_s
    last = None
    while time.time() < end:
        try:
            gc = connect()
            if len(footprints(gc, board)) > 0:
                return {"ready": time.time() * 1000}
        except Exception as error:
            last = error
        time.sleep(0.02)
    print(f"goatcad_api: never ready; last error: {last}", file=sys.stderr)
    return {"ready": None}


def timed(fn, reps: int) -> dict:
    out = []
    for i in range(reps + 1):
        start = time.perf_counter()
        try:
            fn(i)
        except Exception as error:
            # One op's refusal is a finding; the ops after it still run.
            return {"error": str(error)[:300]}
        out.append((time.perf_counter() - start) * 1000)
    return {"first": out[0], "repeats": out[1:]}


def saves_until(gc, fn) -> int:
    for saves in range(60):
        try:
            fn()
            return saves
        except Exception as error:
            if type(error).__name__ != "Conflict":
                raise
            gc.workspace.save()
            time.sleep(0.5)
    raise TimeoutError("the board stayed dirty through 60 saves")


def ops(board: str, reps: int, ref: str, outdir: str) -> dict:
    gc = connect()
    result: dict = {}

    result["round trip"] = timed(lambda _: gc.workspace.list(), reps)
    rows = footprints(gc, board)
    result["counts"] = {
        "footprints": len(rows),
        "tracks": len(gc.items.query(board=board, kind="track")["items"]),
    }
    result["list footprints"] = timed(lambda _: footprints(gc, board), reps)
    result["list tracks"] = timed(lambda _: gc.items.query(board=board, kind="track"), reps)

    if not any(r["id"] == ref for r in rows):
        raise SystemExit(f"goatcad_api: no footprint {ref} on the board")
    viewport = gc.viewport.open(label="kicad-compare", board=board)["viewport"]

    def move(i: int) -> None:
        # One undoable edit, out and back as on the KiCad side.
        gc.items.transform(
            transform="move",
            board=board,
            ids=[ref],
            by={"x": 1 if i % 2 == 0 else -1, "y": 0},
            viewport=viewport,
            action=f"Move {ref}",
        )

    result["move footprint"] = timed(move, reps)
    if reps % 2 == 0:
        move(1)

    few = max(1, reps // 3)
    result["refill zones"] = timed(lambda _: gc.board.refill(board=board), few)
    result["drc"] = timed(lambda _: gc.board.check(board=board), few)
    result["erc"] = timed(lambda _: gc.schematic.check(), few)
    result["save"] = timed(lambda _: gc.workspace.save(), few)
    # Exports write the saved file and refuse a board with unsaved edits; work the app
    # finishes after a save can leave it dirty again, so count the saves it takes.
    result["saves before export"] = saves_until(
        gc, lambda: gc.export.positions(board=board, directory=f"{outdir}/pos-warmup")
    )
    result["gerbers"] = timed(
        lambda i: gc.export.gerbers(board=board, directory=f"{outdir}/gerbers-{i}"), few
    )
    result["drill"] = timed(
        lambda i: gc.export.drill(board=board, directory=f"{outdir}/drill-{i}"), few
    )
    result["positions"] = timed(
        lambda i: gc.export.positions(board=board, directory=f"{outdir}/pos-{i}"), few
    )
    return result


def main() -> None:
    mode = sys.argv[1]
    if mode == "ready":
        out = ready(sys.argv[2], float(sys.argv[3]))
    else:
        out = ops(sys.argv[2], int(sys.argv[3]), sys.argv[4], sys.argv[5])
    for key, value in out.items():
        if isinstance(value, dict) and "repeats" in value:
            r = value["repeats"]
            out[key] = {
                "first": value["first"],
                "median": statistics.median(r),
                "min": min(r),
                "max": max(r),
            }
    print(json.dumps(out))


if __name__ == "__main__":
    main()
