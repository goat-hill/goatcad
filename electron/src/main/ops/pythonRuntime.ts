/**
 * The hand-written half of the Python client, as a literal.
 *
 * It lives in a TypeScript string for one reason, and it is the reason the whole
 * packaging question went away: **the app writes this file itself**, at startup,
 * into its own config directory. There is nothing to `pip install`, nothing to
 * bundle as an extra resource, and no build step that could ship a client from a
 * different version than the app it is talking to — `pythonClient.ts` renders
 * the operations from the live registry and concatenates them onto this.
 *
 * The cost is editing Python inside a TS template literal, which is why the
 * split exists at all: everything with behavior is here, fixed and reviewable in
 * one place, and only the typed method surface below it is generated. Keep
 * backticks and `${` out of it.
 *
 * Zero dependencies, standard library only. That is not minimalism for its own
 * sake — a client the app drops on disk cannot run `pip install` for its own
 * requirements, so anything it imports has to be there already.
 */
/**
 * A worked example the app writes beside the client: one block, end to end,
 * in the house method. An agent reads a working script faster than it reads
 * a tool list, and this one costs nothing until it is opened. `__PYTHON_PATH__`
 * is replaced with the real directory when the file is written.
 */
export const PYTHON_EXAMPLE = `"""One block, end to end: a 3.3 V regulator with its capacitors, rendered and checked.

Copy it and change the parts. Every call here is also an MCP tool, and the
docstrings in goatcad.py carry the same guidance per argument. The project's
own conventions are in board-intent.md; gc.project.context() reads them, and
the block below follows the defaults: main part by its origin, each passive by
its pin one grid step out on the pin it serves, a power symbol per rail, then
look at the picture and run the checks before calling it done.
"""
import sys

sys.path.insert(0, __PYTHON_PATH__)
from goatcad import connect

gc = connect()
print(gc.project.context().get("guidance"))

# The user watches the block in a viewport: every edit that sets layout, and
# every render, names it, and its box frames what each call changed or drew,
# labeled with the call's action: a few words on what is happening now.
sheet = gc.schematic.describe()["sheet"]["path"]
vp = gc.viewport.open(sheet=sheet, label="Drawing the 3.3 V regulator")["viewport"]

# The block's main part goes where the block goes, by its origin. Its answer
# lists every pin (up to twelve) with where it landed and which side is free.
reg = gc.schematic.place_symbol(
    symbol="Regulator_Linear:AMS1117-3.3", value="AMS1117-3.3", at={"x": 127.0, "y": 76.2},
    viewport=vp, action="Place the regulator",
)
u = reg["placed"]["reference"]
print(u, {p["name"]: p["free"] for p in reg["placed"]["pins"]})

# Each capacitor placed by its pin 1 on the pin it serves, wired to it.
cin, _ = gc.place_beside("Device:C", u + ".VI", value="10uF", viewport=vp, action="Add the input cap")
cout, _ = gc.place_beside("Device:C", u + ".VO", value="10uF", viewport=vp, action="Add the output cap")

# A rail per block: the power symbol placed by its pin on the capacitor's far end.
for cap, rail in ((cin, "power:+5V"), (cout, "power:+3V3")):
    far = next(p for p in cap["placed"]["pins"] if p["number"] == "2")
    gc.schematic.place_symbol(
        symbol=rail, pin="1", at=far["at"], viewport=vp, action="Add the " + rail[6:] + " rail"
    )
gc.place_beside("power:GND", u + ".GND", viewport=vp, action="Ground the regulator")

# Between blocks, labels: global for a rail, hierarchical across sheets.
gc.schematic.connect(
    net="+3V3", pins=[u + ".VO"], labelKind="global", viewport=vp, action="Label +3V3 out"
)

# Look at it against the conventions, then run the checks. Fix before the next block.
picture = gc.render.schematic(
    symbols=[u, cin["placed"]["reference"], cout["placed"]["reference"]], viewport=vp,
    action="Review the regulator",
)
print("render:", picture.get("path") or picture.get("frame"))
print(gc.schematic.check())
gc.viewport.close(viewport=vp)
`

/**
 * The board's worked example: the kind of edit a script is for — geometry
 * computed from what the board says, many writes as one undo step, one refill
 * and one check at the end. `__PYTHON_PATH__` as above.
 */
export const PYTHON_BOARD_EXAMPLE = `"""A board, the way a script is worth it: computed placement, routed, checked.

Coarse placement of a module's decoupling capacitors: each goes beside the
supply pad it serves, read from the board rather than guessed, and the whole
set lands as one undo step. Then each is routed with the editor's own router,
the way a person routes: Attempt Finish for the obvious paths, a session that
tries alternatives for one that needs steering. The pours are refilled once,
the copper looked at a layer at a time, and the checks read. Every call is
also an MCP tool (viewport_open, items_update with board, board_batch,
route_finish, route_begin, route_preview, route_step, board_refill,
render_board, board_check).
"""
import sys

sys.path.insert(0, __PYTHON_PATH__)
from goatcad import connect

gc = connect()
board = gc.board.describe()
path = board["board"]["path"]
print(path, board["counts"], "unrouted:", board["unrouted"])

# The user watches the work in a viewport: every edit that sets layout, and
# every render, names it, and its box frames what each call changed or drew,
# labeled with the call's action: a few words on what is happening now.
vp = gc.viewport.open(board=path, label="Decoupling U1")["viewport"]

# The rules routing is held to, and the width a track takes by default.
setup = gc.board.get_setup(board=path, sections=["constraints", "netClasses"])
print(setup["netClasses"]["classes"])

# Where the module's supply pads are: a footprint's record lists every pad with
# its net and board position (millimeters, y down).
module = gc.items.get(board=path, ids=["U1"])["items"][0]
supply = [p for p in module["pads"] if p["net"].lstrip("/") == "+3V3"]
caps = [f["reference"] for f in board["footprints"] if f["reference"].startswith("C")]

# One undo step for the lot: each capacitor 2 mm off its pad, turned to face it.
with gc.transaction(board=path, viewport=vp, action="Place caps by U1 supply") as step:
    for pad, cap in zip(supply, caps):
        gc.items.update(id=cap, record={"at": {"x": pad["at"]["x"], "y": pad["at"]["y"] - 2}, "angle": 90})
print(step.result["changed"])

# Route with the editor's router, never with tracks drawn point by point: it
# keeps clearance, shoves what is in the way and leaves pads cleanly. Attempt
# Finish takes the obvious path from each start; each that arrives is its own
# undo step, and what it drops is named.
done = gc.route.finish(
    board=path, starts=[cap + ".1" for cap in caps], layer="F.Cu", viewport=vp,
    action="Finish the cap routes",
)
print("arrived:", done["arrived"], "dropped:", done["dropped"])

# A dropped one needs steering: begin a session there, preview two ways in, and
# step with the shorter of those that arrive.
for miss in done["dropped"]:
    doing = "Route " + miss["from"]
    session = gc.route.begin(
        board=path, start=miss["from"], layer="F.Cu", viewport=vp, action=doing
    )["session"]
    ways = [[{"to": supply[0]["id"]}], [{"posture": "flip"}, {"to": supply[0]["id"]}]]
    tried = gc.route.preview(session=session, candidates=ways, action="Compare two ways in")
    arriving = [(c["length"], way) for c, way in zip(tried["candidates"], ways) if c.get("arrives")]
    if arriving:
        best = min(arriving, key=lambda a: a[0])[1]
        print(gc.route.step(session=session, gestures=best, action=doing)["arrived"])

# Pours once at the end, then the front copper over the dimmed rest, then the checks.
gc.board.refill(board=path)
gc.render.board(
    board=path, footprints=["U1"], preset="copper", activeLayer="F.Cu", viewport=vp,
    action="Review U1 copper",
)
print(gc.board.check(board=path))
gc.viewport.close(viewport=vp)
`

/**
 * The ops whose Python method reads every match (`GoatCAD._read_whole`) and
 * takes `truncated_ok`; the generator renders them so.
 */
export const PYTHON_WHOLE_READS: ReadonlySet<string> = new Set(['items.query'])

/**
 * The by-id reads whose Python method asks for any number of ids
 * (`GoatCAD._read_chunked`), by the list argument it splits; the chunk is
 * that argument's `maxItems`.
 */
export const PYTHON_CHUNKED_READS: ReadonlyMap<string, string> = new Map([['items.get', 'ids']])

export const PYTHON_RUNTIME = `import atexit
import http.client
import json
import os
import socket
import sys
import urllib.error
import urllib.parse
import urllib.request
import uuid
from pathlib import Path
from typing import Any, Literal


class GoatCADError(Exception):
    """A failed operation.

    Every failure names the next call in \`fix\`. That is the whole point of the
    error shape: a traceback that says what to do is worth more to whoever is
    reading it than one that only says what went wrong.
    """

    def __init__(self, error: dict) -> None:
        self.code = error.get("code", "internal")
        self.message = error.get("message", "")
        self.fix = error.get("fix")
        self.candidates = error.get("candidates") or []
        self.path = error.get("path")
        self.kind = error.get("kind")
        self.data = error.get("data") or {}
        super().__init__(str(self))

    def __str__(self) -> str:
        parts = [self.message]
        if self.path:
            parts.append("at " + self.path)
        if self.fix:
            parts.append("Fix: " + self.fix)
        if self.candidates:
            parts.append("Did you mean: " + ", ".join(map(str, self.candidates)))
        return " ".join(part for part in parts if part)


class InvalidArgs(GoatCADError):
    pass


class NotFound(GoatCADError):
    pass


class Refused(GoatCADError):
    pass


class Conflict(GoatCADError):
    pass


class NoDocument(GoatCADError):
    pass


class UnknownOp(GoatCADError):
    pass


class Timeout(GoatCADError):
    pass


class Internal(GoatCADError):
    pass


class Truncated(GoatCADError):
    """A capped answer the caller did not ask to take as one page.

    Raised by the client, not the app: a script that loops over a partial
    list believes it saw everything, and acts on that.
    """


_ERRORS = {
    "invalid-args": InvalidArgs,
    "not-found": NotFound,
    "refused": Refused,
    "conflict": Conflict,
    "no-document": NoDocument,
    "unknown-op": UnknownOp,
    "timeout": Timeout,
    "internal": Internal,
}


# Rows per page when the client reads a list whole: items.query's cap,
# QUERY_MAX_LIMIT in ops/items/query.ts.
_PAGE = 400


class NotConnected(Exception):
    """GoatCAD is not running, or is not reachable from here."""


GRID = 2.54
"""The pin pitch every library symbol is drawn on, in millimetres."""

_STEP = {"right": (1, 0), "left": (-1, 0), "up": (0, -1), "down": (0, 1)}

# The angle that turns a two-pin passive (Device:R, Device:C, ...) so that
# pin 1 faces the pin it serves and the body runs away from it, keyed by the
# served pin's free side. Pin 2 is the opposite end, so 180 more.
_FACING = {"right": 90, "left": 270, "up": 180, "down": 0}


def step(point: dict, direction: str, n: float = 1) -> dict:
    """A point moved n grid steps in a direction (sheet space, y down)."""
    dx, dy = _STEP[direction]
    return {"x": round(point["x"] + dx * n * GRID, 2), "y": round(point["y"] + dy * n * GRID, 2)}


def _config_dir() -> Path:
    override = os.environ.get("GOATCAD_CONFIG_DIR")
    if override:
        return Path(override)
    # Baked in by the app that wrote this file; the per-platform guesses below
    # are for a copy of it running somewhere else.
    written_by = Path(_WRITTEN_CONFIG_DIR) if _WRITTEN_CONFIG_DIR else None
    if written_by and written_by.exists():
        return written_by
    if sys.platform == "darwin":
        return Path.home() / "Library" / "Application Support" / "GoatCAD"
    if os.name == "nt":
        base = os.environ.get("APPDATA")
        return Path(base) / "GoatCAD" if base else Path.home() / "AppData" / "Roaming" / "GoatCAD"
    base = os.environ.get("XDG_CONFIG_HOME")
    return (Path(base) if base else Path.home() / ".config") / "GoatCAD"


class PendingCall:
    """A call queued inside a transaction.

    Reading its result before the transaction commits raises rather than
    returning None, because a silent None here would be read as "the edit did
    nothing" when in fact it has not happened yet.
    """

    def __init__(self, index: int, op: str) -> None:
        self.index = index
        self.op = op
        self._transaction: "Transaction | None" = None

    @property
    def result(self) -> Any:
        if self._transaction is None or not self._transaction.committed:
            raise RuntimeError(
                self.op + " has not run yet. A transaction sends its operations when the "
                "with-block exits; read results after it, from the transaction or from "
                "this call's .result."
            )
        return self._transaction.results[self.index]


class Transaction:
    """Several edits as one undo step, or a rehearsal of them.

    Mutating calls made inside the block are collected and sent as a single
    batch when it exits; read-only calls go straight out, because they change
    nothing and waiting for them would only make a script slower to debug.

    A sheet's transaction is \`schematic.batch\`; with \`board\` it is
    \`board.batch\`, and \`refill\` pours every zone in the same step. Either
    queues exactly the edits its batch holds (_BATCH_OPS, read from the batch
    op) and raises on any other. \`checks\` runs the checks once round the
    whole step and answers with what it broke or fixed under result["checks"];
    off by default, as on every write. \`viewport\` and \`action\` (what the
    box on the user's canvas says is happening) go on the batch, and are
    required when an edit inside sets layout; an edit inside needs neither of
    its own, and one it names moves onto the batch.
    """

    def __init__(
        self,
        client: "GoatCAD",
        dry_run: bool = False,
        sheet: str | None = None,
        board: str | bool | None = None,
        refill: bool = False,
        checks: bool = False,
        viewport: str | None = None,
        action: str | None = None,
    ) -> None:
        self._client = client
        self.dry_run = dry_run
        self.sheet = sheet
        self.board = board
        self.refill = refill
        self.checks = checks
        self.viewport = viewport
        self.action = action
        self.queued: list[dict] = []
        self.calls: list[PendingCall] = []
        self.committed = False
        self.result: Any = None
        self.results: list[Any] = []

    def _queue(self, op: str, args: dict) -> PendingCall:
        # One viewport frames the whole batch, under one action; an entry
        # naming its own is refused.
        for key in ("viewport", "action"):
            if key in args:
                args = dict(args)
                given = args.pop(key)
                if getattr(self, key) is None:
                    setattr(self, key, given)
        batch = "board.batch" if self.board is not None else "schematic.batch"
        held = _BATCH_OPS.get(batch, set())
        if op not in held:
            raise ValueError(
                op + " cannot run inside a " + ("board" if self.board is not None else "sheet")
                + " transaction, whose " + batch + " holds " + ", ".join(sorted(held))
                + "; call it after the with-block."
            )
        if self.board is not None:
            # The batch names the board once; an entry naming its own is refused.
            args = {key: value for key, value in args.items() if key != "board"}
        call = PendingCall(len(self.queued), op)
        call._transaction = self
        self.queued.append({"op": op, "args": args})
        self.calls.append(call)
        return call

    def __enter__(self) -> "Transaction":
        self._client._open = self
        return self

    def __exit__(self, exc_type, exc, tb) -> Literal[False]:
        self._client._open = None
        if exc_type is not None or not self.queued:
            return False
        args: dict[str, Any] = {"ops": self.queued}
        if self.dry_run:
            args["dryRun"] = True
        if self.checks:
            args["checks"] = True
        if self.viewport is not None:
            args["viewport"] = self.viewport
        if self.action is not None:
            args["action"] = self.action
        if self.board is not None:
            if isinstance(self.board, str):
                args["board"] = self.board
            if self.refill:
                args["refill"] = True
            self.result = self._client.call("board.batch", args)
        else:
            if self.sheet:
                args["sheet"] = self.sheet
            self.result = self._client.call("schematic.batch", args)
        self.results = self.result.get("results", []) if isinstance(self.result, dict) else []
        self.committed = True
        return False


class _UnixConnection(http.client.HTTPConnection):
    """HTTP over the app's user-only socket, which needs no token."""

    def __init__(self, path: str, timeout: float) -> None:
        super().__init__("localhost", timeout=timeout)
        self._path = path

    def connect(self) -> None:
        sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        sock.settimeout(self.timeout)
        sock.connect(self._path)
        self.sock = sock


class _UnixHandler(urllib.request.HTTPHandler):
    def __init__(self, path: str) -> None:
        super().__init__()
        self._path = path

    def http_open(self, req):
        return self.do_open(lambda host, timeout=30.0, **_: _UnixConnection(self._path, timeout), req)


class GoatCAD:
    """A connection to the running app.

    The app knows it by the session id it sends on every call: the viewport it
    opens is this connection's one, and close() (run at exit, or by a with
    block) takes that viewport off the user's canvas. Every call acts in
    workspace_id, sent with each call, else in the only workspace open; a
    call's own workspace argument wins over it.
    """

    def __init__(
        self,
        base_url: str,
        token: str,
        timeout: float = 30.0,
        workspace_id: str | None = None,
        socket_path: str | None = None,
    ) -> None:
        self.base_url = base_url.rstrip("/")
        self.token = token
        self.timeout = timeout
        self.workspace_id = workspace_id
        self._opener = (
            urllib.request.build_opener(_UnixHandler(socket_path))
            if socket_path
            else urllib.request.build_opener()
        )
        self.session = uuid.uuid4().hex
        self._called = False
        self._open: Transaction | None = None
        for domain, factory in _DOMAINS.items():
            setattr(self, domain, factory(self))
        atexit.register(self.close)

    def __enter__(self) -> "GoatCAD":
        return self

    def __exit__(self, exc_type, exc, tb) -> Literal[False]:
        self.close()
        return False

    def _headers(self) -> dict:
        headers = {"mcp-session-id": self.session}
        if self.token:
            headers["authorization"] = "Bearer " + self.token
        if self.workspace_id:
            headers["x-goatcad-workspace"] = self.workspace_id
        return headers

    def close(self) -> None:
        """End this connection: its viewport closes. Later calls start a new one."""
        if not self._called:
            return
        self._called = False
        request = urllib.request.Request(
            self.base_url + "/mcp", headers=self._headers(), method="DELETE"
        )
        try:
            self._opener.open(request, timeout=self.timeout).close()
        except (urllib.error.URLError, OSError):
            pass
        self.session = uuid.uuid4().hex

    def call(self, op: str, args: dict | None = None) -> Any:
        """Run any operation by name.

        The escape hatch, and a deliberate one: an app newer than this file has
        verbs it does not know about, and they should be reachable without
        waiting for a regenerated client.
        """
        payload = {key: value for key, value in (args or {}).items() if value is not None}
        request = urllib.request.Request(
            self.base_url + "/v1/ops/" + op,
            data=json.dumps(payload).encode("utf-8"),
            headers=dict(self._headers(), **{"content-type": "application/json"}),
            method="POST",
        )
        self._called = True
        try:
            with self._opener.open(request, timeout=self.timeout) as response:
                body = json.loads(response.read().decode("utf-8"))
        except urllib.error.HTTPError as err:
            detail = err.read().decode("utf-8", "replace")
            raise NotConnected(
                "GoatCAD refused the request (HTTP " + str(err.code) + "): " + detail
            ) from err
        except urllib.error.URLError as err:
            raise NotConnected(
                "GoatCAD is not answering at " + self.base_url + ". Is it running? " + str(err.reason)
            ) from err

        if isinstance(body, dict) and body.get("ok") is False:
            error = body.get("error") or {}
            raise _ERRORS.get(error.get("code"), GoatCADError)(error)
        return body.get("value") if isinstance(body, dict) else body

    def _dispatch(self, op: str, args: dict, mutates: bool) -> Any:
        if self._open is not None and mutates:
            return self._open._queue(op, {k: v for k, v in args.items() if v is not None})
        return self.call(op, args)

    def _read_whole(self, op: str, args: dict, truncated_ok: bool) -> Any:
        """Every match of a capped list, read page by page at one revision.

        With limit or offset given the caller asked for a page: it comes back
        as the app answered it, and a truncated one raises unless truncated_ok.
        Otherwise every page is read, each pinned to the revision the first
        answered, so a document that moves between pages refuses (Conflict)
        rather than joining two states.
        """
        args = {key: value for key, value in args.items() if value is not None}
        if "limit" in args or "offset" in args:
            answer = self.call(op, args)
            if isinstance(answer, dict) and answer.get("truncated") and not truncated_ok:
                shown = len(answer.get("items") or [])
                raise Truncated({
                    "code": "truncated",
                    "message": op + " answered " + str(shown) + " of " + str(answer.get("count"))
                    + " rows.",
                    "fix": "Omit limit and offset to read every row, or pass truncated_ok=True "
                    "to take this page.",
                })
            return answer
        first = self.call(op, dict(args, limit=_PAGE))
        if not isinstance(first, dict):
            return first
        items = list(first.get("items") or [])
        pin = {"revision": first["revision"]} if first.get("revision") is not None else {}
        page = first
        while page.get("truncated"):
            page = self.call(op, dict(args, limit=_PAGE, offset=len(items), **pin))
            rows = page.get("items") or []
            if page.get("count") != first.get("count") or not rows:
                raise Conflict({
                    "code": "conflict",
                    "kind": "revision-moved",
                    "message": op + " matched " + str(first.get("count")) + " then "
                    + str(page.get("count")) + " rows: the document changed between pages.",
                    "fix": "Call it again.",
                })
            items.extend(rows)
        whole = dict(page)
        whole["items"] = items
        whole.pop("offset", None)
        whole.pop("truncated", None)
        return whole

    def _read_chunked(self, op: str, args: dict, key: str, cap: int) -> Any:
        """Any number of ids, asked for cap at a time and joined in order.

        Each chunk is its own call, so the chunks may answer at different
        revisions if the document changes between them; the joined answer
        then carries no revision.
        """
        args = {k: v for k, v in args.items() if v is not None}
        ids = list(args.get(key) or [])
        if len(ids) <= cap:
            return self.call(op, args)
        answers = [self.call(op, dict(args, **{key: ids[i:i + cap]}))
                   for i in range(0, len(ids), cap)]
        whole = dict(answers[0])
        whole["items"] = [item for answer in answers for item in (answer.get("items") or [])]
        whole["count"] = len(whole["items"])
        if len({answer.get("revision") for answer in answers}) > 1:
            whole.pop("revision", None)
        return whole

    def ops(self) -> list[dict]:
        """Every operation this app has, with its summary and scope."""
        return self._get("/v1/ops").get("ops", [])

    def describe(self, op: str) -> dict:
        """One operation in full: guidance, input schema and examples, by its name
        ("schematic.place_symbol"). GUIDE.md beside this file lists every name."""
        return self._get("/v1/ops/" + urllib.parse.quote(op))

    def schema(self) -> dict:
        """Every input schema, versioned. What this file was generated from."""
        return self._get("/v1/schema")

    def _get(self, path: str) -> dict:
        request = urllib.request.Request(
            self.base_url + path,
            headers=self._headers(),
            method="GET",
        )
        with self._opener.open(request, timeout=self.timeout) as response:
            return json.loads(response.read().decode("utf-8"))

    def transaction(
        self,
        dry_run: bool = False,
        sheet: str | None = None,
        board: str | bool | None = None,
        refill: bool = False,
        checks: bool = False,
        viewport: str | None = None,
        action: str | None = None,
    ) -> Transaction:
        """Collect the edits in a with-block into one undoable step.

        On a sheet by default. board=True (the project's one board) or a board
        file name makes it a board's: the edits board.batch holds (items edits
        and board.place_footprint), with board= left off them, land as one step,
        and refill=True pours every zone after them. checks=True answers with
        what the step broke or fixed (result["checks"]). viewport= and action=
        (a few words the user's box shows, "Place the decoupling") are the
        batch's, required when an edit inside sets layout; the edits inside
        take none of their own.
        """
        return Transaction(
            self, dry_run=dry_run, sheet=sheet, board=board, refill=refill, checks=checks,
            viewport=viewport, action=action,
        )

    def pin(self, id: str, sheet: str | None = None) -> dict:
        """One placed pin's row: where it is (\`at\`) and which side is free.

        \`id\` is reference.pad or reference.NAME ("U1.2", "U1.VDD"). The part must
        already be on the sheet: inside a transaction, a part placed in the same
        block has no reference yet.
        """
        reference, _, wanted = id.partition(".")
        answer = self.items.get(ids=[reference], sheet=sheet)
        for item in answer.get("items", []):
            for pin in item.get("pins", []):
                if pin.get("id") == id or pin.get("number") == wanted or pin.get("name") == wanted:
                    return pin
        raise NotFound({"code": "not-found", "message": "No pin " + id + " on the sheet.",
                        "fix": "items_get on the reference lists its pins by number and name."})

    def place_beside(
        self,
        symbol: str,
        on: str,
        *,
        viewport: str | None = None,
        action: str | None = None,
        pin: str = "1",
        value: str | None = None,
        footprint: str | None = None,
        mpn: str | None = None,
        manufacturer: str | None = None,
        properties: dict[str, str] | None = None,
        steps: float = 1,
        angle: int | None = None,
        wire: bool = True,
        sheet: str | None = None,
    ) -> tuple:
        """Place a passive on the pin it serves, and wire it there.

        The house method in one call: \`pin\` of the new part lands \`steps\` grid
        steps out along the free side of the served pin \`on\` ("U1.VDD"), turned
        so its body runs away from the part, and a wire joins the two. Works for
        anything placed by a pin — a power symbol on a capacitor's far end as
        much as a capacitor on a supply pin. \`angle\` overrides the turn; the
        default assumes a vertical two-pin symbol with pin 1 at the top, which
        every Device passive is. \`value\`, \`footprint\`, \`mpn\`, \`manufacturer\`
        and \`properties\` are place_symbol's; \`viewport\` and \`action\` are the
        ones both calls name, required outside a transaction.

        Returns (place answer, wire answer). Inside a transaction both are
        PendingCalls; the served part must already be committed.
        """
        served = self.pin(on, sheet=sheet)
        side = served["free"]
        at = step(served["at"], side, steps)
        if angle is None:
            angle = _FACING[side]
            if pin != "1":
                angle = (angle + 180) % 360
        placed = self.schematic.place_symbol(
            symbol=symbol, value=value, footprint=footprint, mpn=mpn,
            manufacturer=manufacturer, properties=properties,
            pin=pin, at=at, angle=angle, sheet=sheet, viewport=viewport, action=action,
        )
        joined = (
            self.schematic.wire(
                start={"pin": on}, end=at, sheet=sheet, viewport=viewport, action=action
            )
            if wire
            else None
        )
        return placed, joined


_NO_TOKEN = (
    " Run this from an agent tab in GoatCAD, which is handed the token, or copy the "
    "token from Settings > AI Integrations into GOATCAD_MCP_TOKEN."
)


def _stored_token(token_file: Path) -> str:
    """The token from the app's store, when the store can be read without the app.

    The app encrypts it through the OS keyring, which only the app can undo;
    only a store written where no keyring existed holds it in the clear.
    """
    try:
        stored = json.loads(token_file.read_text())
    except (OSError, ValueError) as err:
        raise NotConnected("No readable token at " + str(token_file) + "." + _NO_TOKEN) from err
    if not isinstance(stored, dict) or not isinstance(stored.get("data"), str):
        raise NotConnected("The token at " + str(token_file) + " is not one GoatCAD wrote." + _NO_TOKEN)
    if stored.get("encrypted") is not False:
        raise NotConnected("GOATCAD_MCP_TOKEN is not set, and the stored token is encrypted." + _NO_TOKEN)
    return stored["data"]


def connect(workspace: str | None = None, timeout: float = 30.0) -> GoatCAD:
    """Find the running app and connect to it, acting in a workspace.

    The app publishes its address in its own config directory as it starts,
    and hands every terminal tab its workspace in GOATCAD_WORKSPACE and every
    agent tab the token in GOATCAD_MCP_TOKEN, so a script started there needs
    no arguments. Elsewhere, pass workspace: an id from gc.workspace.list(), or
    call gc.workspace.start() on the connection.
    """
    workspace = workspace or os.environ.get("GOATCAD_WORKSPACE") or None
    url = os.environ.get("GOATCAD_URL")
    token = os.environ.get("GOATCAD_MCP_TOKEN")
    if url and token:
        return GoatCAD(url, token, timeout, workspace)

    directory = _config_dir()
    endpoint_file = directory / "goatcad-endpoint.json"
    token_file = directory / "mcp-token"
    if not endpoint_file.exists():
        raise NotConnected(
            "No running GoatCAD found (looked for " + str(endpoint_file) + "). Start the app, "
            "and make sure its MCP server is enabled in Settings."
        )
    endpoint = json.loads(endpoint_file.read_text())
    # The user-only socket needs no token; a port, or a Windows pipe, does.
    path = endpoint.get("socket")
    if not url and path and endpoint.get("socketTrusted") and hasattr(socket, "AF_UNIX"):
        return GoatCAD("http://localhost", token or "", timeout, workspace, path)
    if not token:
        token = _stored_token(token_file)
    return GoatCAD(url or endpoint["baseUrl"], token, timeout, workspace)
`
