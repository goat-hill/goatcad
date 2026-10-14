import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { registry } from '../index'
import { renderPythonClient } from '../pythonClient'
import { renderPythonExample } from '../../agentScripting'
import { defineOp } from '../registry'
import { s } from '../schema'
import { succeed } from '../errors'

const CONFIG = '/home/you/.config/GoatCAD'
/** What the client may import: Python's own library, never a package to install. */
const STDLIB = new Set([
  'atexit',
  'uuid',
  'json',
  'os',
  'sys',
  'urllib',
  'http',
  'socket',
  'pathlib',
  'typing',
  'contextlib',
  'time',
  'math',
  're',
  'dataclasses',
  '__future__'
])
const source = (): string => renderPythonClient(registry.list(), CONFIG)

/** The Python to check against. The suite needs one (CI's runner has it), and
 *  fails without it rather than reporting checks it did not run. */
const havePython = ((): string => {
  for (const candidate of ['python3', 'python']) {
    try {
      execFileSync(candidate, ['--version'], { stdio: 'ignore' })
      return candidate
    } catch {
      // Try the next one.
    }
  }
  throw new Error('No python3 or python on PATH: the generated Python client cannot be checked.')
})()

describe('the generated client', () => {
  it('is valid Python', () => {
    // The test that earns its place: the first version of this generator emitted
    // `def status(self, *,)` for an operation with no arguments, which type
    // checking cannot see and only a parser catches.
    const dir = mkdtempSync(join(tmpdir(), 'goatcad-py-'))
    try {
      const file = join(dir, 'goatcad.py')
      writeFileSync(file, source())
      expect(() =>
        execFileSync(havePython, ['-m', 'py_compile', file], { stdio: 'pipe' })
      ).not.toThrow()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('names no argument after a Python keyword, which a keyword-only parameter cannot be', () => {
    const keywords = new Set(
      'False None True and as assert async await break class continue def del elif else except finally for from global if import in is lambda nonlocal not or pass raise return try while with yield'.split(
        ' '
      )
    )
    for (const op of registry.list()) {
      const properties = (op.inputSchema.properties as Record<string, unknown> | undefined) ?? {}
      for (const name of Object.keys(properties))
        expect(keywords.has(name), `${op.name}: ${name}`).toBe(false)
    }
  })

  it('gives each domain its methods, the routing session included', () => {
    expect(source()).toMatch(
      /class RouteOps:[\s\S]*def begin\([\s\S]*def step\([\s\S]*def preview\(/
    )
  })

  it('ships a worked example that is valid Python', () => {
    const dir = mkdtempSync(join(tmpdir(), 'goatcad-py-'))
    try {
      const file = join(dir, 'example_block.py')
      writeFileSync(file, renderPythonExample(join(dir, 'python')))
      expect(() =>
        execFileSync(havePython, ['-m', 'py_compile', file], { stdio: 'pipe' })
      ).not.toThrow()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('place_beside forwards the part fields to place_symbol', () => {
    const dir = mkdtempSync(join(tmpdir(), 'goatcad-py-'))
    try {
      writeFileSync(join(dir, 'goatcad.py'), source())
      const script = join(dir, 'probe.py')
      writeFileSync(
        script,
        [
          'import json, sys',
          'sys.path.insert(0, sys.argv[1])',
          'import goatcad',
          'gc = goatcad.GoatCAD("http://127.0.0.1:1", "t")',
          'calls = []',
          'def call(op, args=None):',
          '    calls.append((op, {k: v for k, v in (args or {}).items() if v is not None}))',
          '    if op == "items.get":',
          '        return {"items": [{"pins": [{"id": "U1.1", "number": "1", "at": {"x": 10, "y": 10}, "free": "left"}]}]}',
          '    return {}',
          'gc.call = call',
          'gc.place_beside("Device:C", "U1.1", value="100nF", footprint="C:0402", properties={"LCSC": "C1"}, wire=False, viewport="viewport-1", action="Add C by U1")',
          'print(json.dumps([args for op, args in calls if op == "schematic.place_symbol"][0]))'
        ].join('\n')
      )
      const placed = JSON.parse(
        execFileSync(havePython, ['-I', script, dir], { encoding: 'utf8' })
      ) as Record<string, unknown>
      expect(placed).toMatchObject({
        symbol: 'Device:C',
        value: '100nF',
        footprint: 'C:0402',
        properties: { LCSC: 'C1' },
        viewport: 'viewport-1',
        action: 'Add C by U1'
      })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('reads a capped list whole at one revision, and raises on a page not asked for', () => {
    const dir = mkdtempSync(join(tmpdir(), 'goatcad-py-'))
    try {
      writeFileSync(join(dir, 'goatcad.py'), source())
      const script = [
        'import goatcad',
        'rows = [{"id": str(i)} for i in range(950)]',
        'state = {"revision": 7, "calls": []}',
        'def call(self, op, args=None):',
        '    state["calls"].append(dict(args))',
        '    if args.get("revision", state["revision"]) != state["revision"]:',
        '        raise goatcad.Conflict({"code": "conflict", "message": "moved"})',
        '    offset, limit = args.get("offset", 0), args.get("limit", 100)',
        '    page = rows[offset:offset + limit]',
        '    answer = {"items": page, "count": len(rows), "revision": state["revision"]}',
        '    if offset + len(page) < len(rows):',
        '        answer["truncated"] = True',
        '    if offset == 400:',
        '        state["revision"] += state.get("bump", 0)',
        '    return answer',
        'goatcad.GoatCAD.call = call',
        'gc = goatcad.GoatCAD("http://x", "t")',
        'whole = gc.items.query(board="b")',
        'assert [r["id"] for r in whole["items"]] == [r["id"] for r in rows]',
        'assert "truncated" not in whole',
        'assert [c.get("offset", 0) for c in state["calls"]] == [0, 400, 800]',
        'assert [c.get("revision") for c in state["calls"]] == [None, 7, 7]',
        'try:',
        '    gc.items.query(board="b", limit=10)',
        '    raise SystemExit("a truncated page did not raise")',
        'except goatcad.Truncated as err:',
        '    assert "10 of 950" in str(err)',
        'assert len(gc.items.query(board="b", limit=10, truncated_ok=True)["items"]) == 10',
        'state["bump"] = 1',
        'try:',
        '    gc.items.query(board="b")',
        '    raise SystemExit("a moved document did not raise")',
        'except goatcad.Conflict:',
        '    pass'
      ].join('\n')
      writeFileSync(join(dir, 'probe.py'), script)
      expect(() =>
        execFileSync(havePython, ['probe.py'], { cwd: dir, stdio: 'pipe' })
      ).not.toThrow()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('reads any number of ids, the cap at a time, in order', () => {
    const dir = mkdtempSync(join(tmpdir(), 'goatcad-py-'))
    try {
      writeFileSync(join(dir, 'goatcad.py'), source())
      const script = [
        'import goatcad',
        'state = {"calls": [], "revision": 3}',
        'def call(self, op, args=None):',
        '    state["calls"].append(len(args["ids"]))',
        '    answer = {"items": [{"id": i} for i in args["ids"]], "count": len(args["ids"]), "revision": state["revision"]}',
        '    state["revision"] += state.get("bump", 0)',
        '    return answer',
        'goatcad.GoatCAD.call = call',
        'gc = goatcad.GoatCAD("http://x", "t")',
        'ids = [str(i) for i in range(120)]',
        'whole = gc.items.get(board="b", ids=ids)',
        'assert [r["id"] for r in whole["items"]] == ids',
        'assert whole["count"] == 120 and whole["revision"] == 3',
        'assert state["calls"] == [50, 50, 20]',
        'state["bump"] = 1',
        'assert "revision" not in gc.items.get(board="b", ids=ids)',
        'assert gc.items.get(board="b", ids=["U1"])["count"] == 1'
      ].join('\n')
      writeFileSync(join(dir, 'probe.py'), script)
      expect(() =>
        execFileSync(havePython, ['probe.py'], { cwd: dir, stdio: 'pipe' })
      ).not.toThrow()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('names its session on every call, and ends it with a DELETE on close', () => {
    const dir = mkdtempSync(join(tmpdir(), 'goatcad-py-'))
    try {
      writeFileSync(join(dir, 'goatcad.py'), source())
      const script = [
        'import json, threading',
        'from http.server import BaseHTTPRequestHandler, HTTPServer',
        'import goatcad',
        'seen = []',
        'class Handler(BaseHTTPRequestHandler):',
        '    def log_message(self, *args):',
        '        pass',
        '    def answer(self, status, body):',
        '        seen.append((self.command, self.path, self.headers.get("mcp-session-id")))',
        '        self.send_response(status)',
        '        self.send_header("content-length", str(len(body)))',
        '        self.end_headers()',
        '        self.wfile.write(body)',
        '    def do_POST(self):',
        '        self.rfile.read(int(self.headers["content-length"]))',
        '        self.answer(200, b\'{"ok": true, "value": 1}\')',
        '    def do_DELETE(self):',
        '        self.answer(204, b"")',
        'server = HTTPServer(("127.0.0.1", 0), Handler)',
        'threading.Thread(target=server.serve_forever, daemon=True).start()',
        'with goatcad.GoatCAD("http://127.0.0.1:%d" % server.server_port, "t") as gc:',
        '    first = gc.session',
        '    gc.call("parts.status")',
        '    gc.call("parts.status")',
        'assert seen == [("POST", "/v1/ops/parts.status", first)] * 2 + [("DELETE", "/mcp", first)], seen',
        'assert gc.session != first',
        'gc.close()',
        'assert len(seen) == 3, "a close with no call since sends nothing"'
      ].join('\n')
      writeFileSync(join(dir, 'probe.py'), script)
      expect(() =>
        execFileSync(havePython, ['probe.py'], { cwd: dir, stdio: 'pipe' })
      ).not.toThrow()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("queues exactly the ops its document's batch holds, and fills their viewport and action", () => {
    const dir = mkdtempSync(join(tmpdir(), 'goatcad-py-'))
    try {
      writeFileSync(join(dir, 'goatcad.py'), source())
      const script = [
        'import goatcad',
        'sent = []',
        'def call(self, op, args=None):',
        '    sent.append((op, args))',
        '    return {"results": [{} for _ in (args or {}).get("ops", [])]}',
        'goatcad.GoatCAD.call = call',
        'gc = goatcad.GoatCAD("http://x", "t")',
        'with gc.transaction(board=True, viewport="vp", action="Add holes") as step:',
        '    gc.board.place_footprint(footprint="MountingHole:M3", at={"x": 1, "y": 2})',
        '    gc.items.delete(ids=["U1"])',
        'op, args = sent[-1]',
        'assert op == "board.batch" and args["viewport"] == "vp" and args["action"] == "Add holes"',
        'assert [entry["op"] for entry in args["ops"]] == ["board.place_footprint", "items.delete"]',
        'assert all("viewport" not in entry["args"] for entry in args["ops"])',
        'assert all("action" not in entry["args"] for entry in args["ops"])',
        '# An edit inside that names an action moves it onto the batch.',
        'with gc.transaction(viewport="vp"):',
        '    gc.schematic.wire(start={"pin": "R1.1"}, end={"x": 0, "y": 0}, action="Wire R1")',
        'op, args = sent[-1]',
        'assert args["action"] == "Wire R1" and "action" not in args["ops"][0]["args"]',
        '# A method takes action as a keyword, required by the app, not by Python.',
        'import inspect',
        'assert inspect.signature(gc.render.board).parameters["action"].default is None',
        'try:',
        '    with gc.transaction(board=True, viewport="vp"):',
        '        gc.board.fanout(footprint="U1")',
        '    raise SystemExit("board.fanout was queued")',
        'except ValueError as err:',
        '    assert "board.place_footprint" in str(err)',
        'with gc.transaction(viewport="vp"):',
        '    gc.schematic.wire(start={"pin": "R1.1"}, end={"x": 0, "y": 0})',
        'assert sent[-1][0] == "schematic.batch"',
        'try:',
        '    with gc.transaction():',
        '        gc.schematic.annotate()',
        '    raise SystemExit("schematic.annotate was queued")',
        'except ValueError:',
        '    pass'
      ].join('\n')
      writeFileSync(join(dir, 'probe.py'), script)
      expect(() =>
        execFileSync(havePython, ['probe.py'], { cwd: dir, stdio: 'pipe' })
      ).not.toThrow()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('lists each batch op from the batch op itself', () => {
    const batch = registry.get('board.batch')!
    expect(batch.batchOps).toContain('board.place_footprint')
    expect(source()).toContain(
      `"board.batch": {${batch.batchOps!.map((name) => `"${name}"`).join(', ')}}`
    )
  })

  it('says it is standard-library only, and imports nothing else', () => {
    const python = source()
    expect(python.slice(0, 600)).toContain('standard library only')
    const modules = [...python.matchAll(/^(?:import ([\w.]+)$|from ([\w.]+) import )/gm)].map(
      (m) => m[1] ?? m[2]
    )
    expect(modules.filter((name) => !STDLIB.has(name.split('.')[0]))).toEqual([])
  })

  it('carries the house-method helpers beside the generated verbs', () => {
    const python = source()
    expect(python).toContain('def place_beside(')
    expect(python).toContain('def pin(')
    expect(python).toContain('GRID = 2.54')
  })

  it('gives every operation a method under its domain', () => {
    const python = source()
    for (const op of registry.list()) {
      const [domain, verb] = op.name.split('.')
      const cls = `class ${domain.charAt(0).toUpperCase()}${domain.slice(1)}Ops:`
      expect(python).toContain(cls)
      expect(python).toContain(`    def ${verb}(`)
      expect(python).toMatch(
        new RegExp(
          `self\\._client\\._(dispatch|read_whole|read_chunked)\\("${op.name.replace('.', '\\.')}"`
        )
      )
    }
  })

  it('tells the runtime which operations edit the design', () => {
    // What a transaction branches on: a read inside a with-block runs straight
    // away, a write is collected into the batch.
    const python = source()
    expect(python).toContain('self._client._dispatch("schematic.place_symbol", {"symbol": symbol')
    expect(python).toMatch(/_dispatch\("schematic\.place_symbol",[^\n]*, True\)/)
    expect(python).toMatch(/_dispatch\("schematic\.describe",[^\n]*, False\)/)
  })

  it('bakes in where the app wrote it, so connect() takes no arguments', () => {
    expect(source()).toContain(`_WRITTEN_CONFIG_DIR = "${CONFIG}"`)
  })

  it('keeps the wire names rather than translating them to snake_case', () => {
    // One identifier in the schema, the error path and the call. Two spellings
    // for one argument is what makes a model guess.
    expect(source()).toContain('maxPixels: ')
    expect(source()).not.toContain('max_pixels')
  })
})

describe('the renderer, on shapes the registry does not have yet', () => {
  const render = (op: ReturnType<typeof defineOp>): string => renderPythonClient([op], '/tmp/x')

  const probe = (input: Parameters<typeof defineOp>[0]['input']): string =>
    render(
      defineOp({
        name: 'demo.verb',
        summary: 'A demo.',
        scope: 'app',
        mutates: false,
        input,
        run: () => succeed({})
      })
    )

  it('turns an enum into a Literal', () => {
    expect(probe(s.object({ mode: s.enum(['fast', 'slow'] as const) }))).toContain(
      'mode: Literal["fast", "slow"],'
    )
  })

  it('types a list and an open map from their item schemas', () => {
    const python = probe(
      s.object({ tags: s.array(s.string()), fields: s.record(s.string()).optional() })
    )
    expect(python).toContain('tags: list[str],')
    expect(python).toContain('fields: dict[str, str] | None = None,')
  })

  it('puts required arguments first, since Python needs the defaults last', () => {
    const python = probe(s.object({ maybe: s.string().optional(), must: s.string() }))
    expect(python.indexOf('must: str,')).toBeLessThan(python.indexOf('maybe: str | None = None,'))
  })

  it('omits the bare star when there is nothing to keyword-separate', () => {
    expect(probe(s.object({}))).toContain('    def verb(\n        self,\n    ) -> Any:')
  })

  it('makes every argument keyword-only, so a new optional one is not breaking', () => {
    expect(probe(s.object({ a: s.string() }))).toContain('        *,\n        a: str,')
  })

  it('renders an example as Python, not as JSON', () => {
    const python = render(
      defineOp({
        name: 'demo.verb',
        summary: 'A demo.',
        scope: 'app',
        mutates: false,
        input: s.object({ net: s.string(), on: s.boolean().optional() }),
        examples: [{ args: { net: 'VDD', on: true }, note: 'switch it on' }],
        run: () => succeed({})
      })
    )
    expect(python).toContain('verb(net="VDD", on=True)')
  })

  it('does not let a description break out of its docstring', () => {
    const python = probe(s.object({ a: s.string().describe('ends with a quote "') }))
    expect(python).not.toContain('""""')
  })
})
