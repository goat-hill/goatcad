"""KiCad's side of kicad-compare's agent-API timings, through kipy (kicad-python).

Run by scripts/kicad-compare.mjs in the venv bin/kicad-compare makes; prints one
JSON object on stdout. Times are wall ms around each call as a script sees it. The first
call of each operation is kept apart from the repeats, as on the GoatCAD side.

  ready <socket> <deadline_s>   poll until the board answers; print the epoch ms it did
  ops <socket> <reps> <ref>     time the warm operations, <reps> times each
"""

import json
import statistics
import sys
import time

from kipy import KiCad
from kipy.geometry import Vector2


def ready(socket: str, deadline_s: float) -> dict:
    end = time.time() + deadline_s
    last = None
    while time.time() < end:
        try:
            kicad = KiCad(socket_path=f"ipc://{socket}", timeout_ms=2000)
            board = kicad.get_board()
            # A board mid-load answers busy; a footprint count proves it is in.
            if len(board.get_footprints()) > 0:
                return {"ready": time.time() * 1000}
        except Exception as error:
            last = error
        time.sleep(0.02)
    print(f"kicad_api: never ready; last error: {last}", file=sys.stderr)
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


def ops(socket: str, reps: int, ref: str) -> dict:
    # Zone refill and save of an 85 MB board outlast kipy's 2 s default.
    kicad = KiCad(socket_path=f"ipc://{socket}", timeout_ms=600000)
    board = kicad.get_board()
    result: dict = {"version": kicad.get_version().full_version}

    result["round trip"] = timed(lambda _: kicad.ping(), reps)
    footprints = board.get_footprints()
    result["counts"] = {"footprints": len(footprints), "tracks": len(board.get_tracks())}
    result["list footprints"] = timed(lambda _: board.get_footprints(), reps)
    result["list tracks"] = timed(lambda _: board.get_tracks(), reps)

    target = next((f for f in footprints if f.reference_field.text.value == ref), None)
    if target is None:
        raise SystemExit(f"kicad_api: no footprint {ref} on the board")
    home = target.position

    def move(i: int) -> None:
        # One undoable edit, as the editor commits it; alternate out and back.
        fp = board.get_items_by_id([target.id])[0]
        fp.position = Vector2.from_xy(home.x + (1_000_000 if i % 2 == 0 else 0), home.y)
        commit = board.begin_commit()
        board.update_items([fp])
        board.push_commit(commit, "kicad-compare move")

    result["move footprint"] = timed(move, reps)
    if reps % 2 == 0:
        move(1)

    # The refill polls for done; 20 ms keeps its granularity under the noise.
    result["refill zones"] = timed(
        lambda _: board.refill_zones(block=True, max_poll_seconds=600, poll_interval_seconds=0.02),
        max(1, reps // 3),
    )
    result["save"] = timed(lambda _: board.save(), max(1, reps // 3))
    return result


def main() -> None:
    mode, socket = sys.argv[1], sys.argv[2]
    if mode == "ready":
        out = ready(socket, float(sys.argv[3]))
    else:
        out = ops(socket, int(sys.argv[3]), sys.argv[4])
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
