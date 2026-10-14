/**
 * `app.scripting` — how to drive this app from a script, with nothing to install.
 *
 * The operation exists because the alternative is documentation, and an agent
 * reads the tools it has rather than docs it has to be pointed at. One call
 * returns a path and a two-line snippet; there is no package to fetch, because
 * the app wrote the client into its own config directory as it started
 * (`agentScripting.ts` has the argument).
 *
 * Why an agent should want it at all: MCP costs one model turn per call, so a
 * loop over a fifty-row BOM is fifty turns as tool calls and one as a script
 * (`docs/agent-api.md`). This is the door to the second.
 */
import { defineOp } from '../registry'
import { s } from '../schema'
import { fail, succeed } from '../errors'

export const appScripting = defineOp({
  name: 'app.scripting',
  scope: 'app',
  mutates: false,
  summary: "Get the path and a snippet for this app's Python client, already on disk.",
  guidance:
    'Use for more than a handful of edits, computed geometry, or a generate-check-fix loop: a script is one turn. The app writes the client into its config directory to match this version; put the returned path on sys.path and import it, nothing to install. It is standard-library only: for numpy or other packages, run the script in your own venv. Every tool is a method with the same argument names; connect() finds the running app. Sheet helpers: gc.pin("U1.VDD") reads a pin\'s position and free side; gc.place_beside("Device:C", "U1.VDD", value="100nF") places a passive one grid step out on the pin and wires it. Board: gc.transaction(board=...) makes a batch one undo step, and refill=True pours zones once at the end. Read the worked example you need first.',
  input: s.object({}),
  run(_args, ctx) {
    const info = ctx.scripting?.()
    if (!info) {
      return fail({
        code: 'internal',
        kind: 'scripting-unavailable',
        message: 'This build of the server does not write a Python client.',
        fix: 'Use the MCP tools directly, or the HTTP API at /v1/ops/<name>.'
      })
    }
    return succeed({
      language: 'python',
      ...info,
      guidance:
        "Read examplePath (a schematic block) or boardExamplePath (a board) first, then run the snippet. Errors carry the tools' `fix`. `with gc.transaction():` (a sheet) or `with gc.transaction(board=True):` (items edits only) makes one undo step; dry_run=True previews a batch."
    })
  }
})
