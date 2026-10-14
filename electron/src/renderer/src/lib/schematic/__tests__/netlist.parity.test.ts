/**
 * The netlist writer against KiCad's own `kicad-cli sch export netlist`, on
 * the sample project. Not in the default suite: it needs KiCad installed
 * (`kicadParity.ts`). Run it with `./bin/test-parity`.
 *
 * Nets are compared in full — name, class and every node with its pin
 * function and type, in order. Components are compared by reference, value,
 * footprint and sheet; the header's date and tool are ours to write. On the
 * sample the whole file matches KiCad's but for the header, the `libraries`
 * list (its URIs are the symbol tables', which a design does not carry) and
 * the order of pins that share a position within a unit, which KiCad's own
 * sort leaves unspecified.
 */
import { describe, expect, test } from 'vitest'
import { execFile } from 'child_process'
import { cpSync, mkdtempSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { promisify } from 'util'
import { requireKicadCli } from '../../__tests__/kicadParity'
import { writeNetlist } from '../netlist'
import { loadDesign, readNetlist } from './netlistFixtures'
import { CANARY_DIR } from '../../__tests__/canaryFixture'

const run = promisify(execFile)
const cli = requireKicadCli()

const project = CANARY_DIR

describe('netlist parity with kicad-cli', () => {
  test('the sample project exports the nets KiCad exports', async () => {
    // A copy: kicad-cli may touch the project, and the sample is never written.
    const dir = mkdtempSync(join(tmpdir(), 'goatcad-netlist-'))
    cpSync(project, dir, { recursive: true })
    const root = join(dir, 'canary.kicad_sch')
    const out = join(dir, 'kicad.net')
    await run(cli, ['sch', 'export', 'netlist', '-o', out, root])

    const design = await loadDesign(root)
    const ours = readNetlist(
      writeNetlist(design, { source: root, date: 'now', tool: 'GoatCAD test' })
    )
    const theirs = readNetlist(readFileSync(out, 'utf8'))

    expect(ours.nets.map((net) => net.name)).toEqual(theirs.nets.map((net) => net.name))
    for (let i = 0; i < theirs.nets.length; i++) expect(ours.nets[i]).toEqual(theirs.nets[i])
    expect(ours.components.map((comp) => comp.ref).join(' ')).toBe(
      theirs.components.map((comp) => comp.ref).join(' ')
    )
    expect(ours.components).toEqual(theirs.components)
    expect(ours.sheets).toEqual(theirs.sheets)
  }, 60_000)
})
