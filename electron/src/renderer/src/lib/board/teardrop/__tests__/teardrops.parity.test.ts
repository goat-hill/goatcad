/**
 * Teardrops against pcbnew's own (kicad-parity.md, Teardrops). kicad-cli has no
 * teardrop command, so the case board goes through pcbnew itself, under
 * xvfb, with a startup plugin that runs Fill All Zones (which rebuilds every
 * teardrop, `ZONE_FILLER_TOOL::FillAllZones`) and saves. Every teardrop
 * pcbnew makes must be ours to within 5 nm, point for point.
 *
 * Linux only, and only where pcbnew sits beside kicad-cli and xvfb-run is on
 * the path; the suite fails elsewhere.
 */
import { describe, expect, test } from 'vitest'
import { execFile, execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import { loadClipper } from '../../../geometry/clip'
import { isTeardropZone, parseKicadBoard } from '../../../kicad/board'
import { mmToNm } from '../../../kicad/coordinates'
import { kicadCli } from '../../../__tests__/kicadParity'
import { boardIndex } from '../../spatialIndex'
import { planTeardrops } from '../manager'
import { DEFAULT_TEARDROP_SETTINGS } from '../params'

const which = (name: string): string | null => {
  try {
    return execFileSync('which', [name], { encoding: 'utf8' }).trim() || null
  } catch {
    return null
  }
}

/** pcbnew beside kicad-cli, or on the path where kicad-cli is. */
const pcbnew = (): string | null => {
  if (process.platform !== 'linux' || !which('xvfb-run')) return null
  const cli = kicadCli()
  if (!cli) return null
  const beside = join(dirname(cli), 'pcbnew')
  return cli.includes('/') ? (existsSync(beside) ? beside : null) : which('pcbnew')
}

/** Cancels KiCad's first-run setup, then fills every zone and saves to ORACLE_OUT. */
const PLUGIN = `import os, wx, pcbnew
OUT = os.environ.get('ORACLE_OUT')
def _dismiss():
    for w in wx.GetTopLevelWindows():
        if isinstance(w, wx.Dialog) and w.IsModal():
            w.EndModal(wx.ID_CANCEL)
    wx.CallLater(500, _dismiss)
def _run():
    for w in wx.GetTopLevelWindows():
        mb = w.GetMenuBar() if hasattr(w, 'GetMenuBar') else None
        if not mb: continue
        for i in range(mb.GetMenuCount()):
            menu = mb.GetMenu(i)
            for item in menu.GetMenuItems():
                if item.GetItemLabelText().startswith('Fill All Zones'):
                    evt = wx.CommandEvent(wx.wxEVT_COMMAND_MENU_SELECTED, item.GetId())
                    evt.SetEventObject(menu)
                    menu.ProcessEvent(evt)
    def save():
        pcbnew.SaveBoard(OUT, pcbnew.GetBoard())
        os._exit(0)
    wx.CallLater(3000, save)
if OUT:
    wx.CallLater(200, _dismiss)
    wx.CallLater(6000, _run)
`

interface Td {
  curved?: boolean
  bestWidth?: number
  bestLength?: number
  maxWidth?: number
  maxLength?: number
}

/** A board of teardrop cases, one per 10 mm cell: shapes, angles, vias, curves, spans, arcs. */
function caseBoard(): string {
  let n = 0
  const uid = (): string => {
    n++
    return `abc${(0x10000 + n).toString(16)}-0000-4000-8000-${n.toString(16).padStart(12, '0')}`
  }
  const td = (o: Td = {}): string =>
    `(teardrops (best_length_ratio ${o.bestLength ?? 0.5}) (max_length ${o.maxLength ?? 1}) ` +
    `(best_width_ratio ${o.bestWidth ?? 1}) (max_width ${o.maxWidth ?? 2}) (curved_edges ${o.curved ? 'yes' : 'no'}) ` +
    '(filter_ratio 0.9) (enabled yes) (allow_two_segments yes) (prefer_zone_connections yes))'
  const items: string[] = []
  let cellIndex = 0
  const cell = (): [number, number] => {
    const i = cellIndex++
    return [10 + (i % 10) * 10, 10 + Math.floor(i / 10) * 10]
  }
  const f = (v: number): string => v.toFixed(6)
  const ray = (x: number, y: number, deg: number, len = 5): [number, number] => [
    x + len * Math.cos((deg * Math.PI) / 180),
    y + len * Math.sin((deg * Math.PI) / 180)
  ]
  const pad = (
    x: number,
    y: number,
    shape: string,
    [w, h]: [number, number],
    o: { angle?: number; extra?: string; td?: Td; smd?: boolean; fpAngle?: number } = {}
  ): void => {
    const layers = o.smd ? '"F.Cu" "F.Mask"' : '"*.Cu" "*.Mask"'
    items.push(
      `(footprint "T:P" (layer "F.Cu") (uuid "${uid()}") (at ${x} ${y}${o.fpAngle ? ` ${o.fpAngle}` : ''}) ` +
        `(pad "1" ${o.smd ? 'smd' : 'thru_hole'} ${shape} (at 0 0${o.angle ? ` ${o.angle}` : ''}) (size ${w} ${h}) ` +
        `${o.smd ? '' : '(drill 0.6)'} (layers ${layers}) ${o.extra ?? ''} (net 1 "N1") ${td(o.td)} (uuid "${uid()}")))`
    )
  }
  const seg = (a: [number, number], b: [number, number], layer = 'F.Cu'): void => {
    items.push(
      `(segment (start ${f(a[0])} ${f(a[1])}) (end ${f(b[0])} ${f(b[1])}) (width 0.25) (layer "${layer}") (net 1) (uuid "${uid()}"))`
    )
  }
  for (const deg of [0, 30, 45, 90, 137, 200]) {
    const [x, y] = cell()
    pad(x, y, 'circle', [1.6, 1.6])
    seg([x, y], ray(x, y, deg))
  }
  for (const deg of [0, 33, 90]) {
    const [x, y] = cell()
    items.push(
      `(via (at ${x} ${y}) (size 0.8) (drill 0.4) (layers "F.Cu" "B.Cu") (net 1) ${td()} (uuid "${uid()}"))`
    )
    seg([x, y], ray(x, y, deg))
  }
  const shapes: Array<[string, [number, number], number, number, string]> = [
    ['rect', [2, 1.2], 0, 0, ''],
    ['rect', [2, 1.2], 30, 60, ''],
    ['oval', [2.4, 1.2], 0, 0, ''],
    ['oval', [1.2, 2.4], 0, 0, ''],
    ['oval', [2.4, 1.2], 0, 90, ''],
    ['roundrect', [2, 1.4], 0, 20, '(roundrect_rratio 0.25)']
  ]
  for (const [shape, size, angle, deg, extra] of shapes) {
    const [x, y] = cell()
    pad(x, y, shape, size, { angle, extra })
    seg([x, y], ray(x, y, deg))
  }
  const curved: Array<[string, [number, number], string, number]> = [
    ['circle', [1.6, 1.6], '', 30],
    ['rect', [2, 1.2], '', 0],
    ['roundrect', [2, 1.4], '(roundrect_rratio 0.25)', 35],
    ['oval', [2.4, 1.2], '', 80]
  ]
  for (const [shape, size, extra, deg] of curved) {
    const [x, y] = cell()
    pad(x, y, shape, size, { extra, td: { curved: true } })
    seg([x, y], ray(x, y, deg))
  }
  {
    const [x, y] = cell()
    pad(x, y, 'circle', [2, 2])
    seg([x, y + 0.5], [x + 5, y + 0.5])
  }
  for (const bend of [20, 50]) {
    const [x, y] = cell()
    pad(x, y, 'circle', [2, 2], { td: { maxLength: 3, bestLength: 1.5 } })
    const p1: [number, number] = [x + 1.2, y]
    seg([x, y], p1)
    seg(p1, ray(p1[0], p1[1], bend))
  }
  {
    const [x, y] = cell()
    pad(x, y, 'circle', [1.6, 1.6], { td: { bestWidth: 0.6 } })
    seg([x, y], ray(x, y, 15))
  }
  {
    const [x, y] = cell()
    pad(x, y, 'circle', [2.5, 2.5], { td: { maxWidth: 0.8, maxLength: 0.4 } })
    seg([x, y], ray(x, y, 15))
  }
  {
    const [x, y] = cell()
    pad(x, y, 'circle', [1.6, 1.6])
    seg([x - 4, y], [x + 4, y])
  }
  {
    const [x, y] = cell()
    pad(x, y, 'rect', [1.5, 0.8], { smd: true, angle: 45, fpAngle: 45 })
    seg([x, y], ray(x, y, -45))
  }
  {
    const [x, y] = cell()
    pad(x, y, 'circle', [1.6, 1.6])
    items.push(
      `(segment (start ${x} ${y}) (end ${x + 4} ${y + 1}) (width 0.25) (layers "F.Cu" "F.Mask") (net 1) (uuid "${uid()}"))`
    )
  }
  {
    const [x, y] = cell()
    items.push(
      `(via (at ${x} ${y}) (size 1) (drill 0.4) (layers "F.Cu" "B.Cu") (net 1) ${td()} (uuid "${uid()}"))`
    )
    items.push(
      `(arc (start ${x} ${y}) (mid ${x + 2.5} ${y + 1}) (end ${x + 5} ${y}) (width 0.25) (layer "F.Cu") (net 1) (uuid "${uid()}"))`
    )
  }
  {
    const [x, y] = cell()
    pad(x, y, 'circle', [1.6, 1.6])
    seg([x, y], ray(x, y, 70), 'B.Cu')
  }
  {
    const [x, y] = cell()
    pad(x, y, 'roundrect', [2, 1.4], {
      extra: '(roundrect_rratio 0) (chamfer_ratio 0.3) (chamfer top_left bottom_right)'
    })
    seg([x, y], ray(x, y, 10))
  }
  {
    const [x, y] = cell()
    pad(x, y, 'trapezoid', [2, 1.4], { extra: '(rect_delta 0 0.4)' })
    seg([x, y], ray(x, y, 10))
  }
  return `(kicad_pcb (version 20260206) (generator "pcbnew") (generator_version "10.0")
 (general (thickness 1.6) (legacy_teardrops no)) (paper "A4")
 (layers (0 "F.Cu" signal) (2 "B.Cu" signal) (25 "Edge.Cuts" user) (1 "F.Mask" user) (3 "B.Mask" user))
 (setup (pad_to_mask_clearance 0))
 (net 0 "") (net 1 "N1")
${items.join('\n')}
)`
}

const binary = pcbnew()
if (!binary) {
  throw new Error(
    'pcbnew not found: teardrop parity needs Linux, pcbnew beside kicad-cli, and xvfb-run on PATH.'
  )
}

describe('teardrops, against pcbnew', () => {
  test('every teardrop pcbnew makes is ours, to 5 nm', { timeout: 180_000 }, async () => {
    await loadClipper()
    const dir = mkdtempSync(join(tmpdir(), 'goatcad-teardrops-'))
    try {
      const plugins = join(dir, 'docs', 'kicad', '10.0', 'scripting', 'plugins')
      mkdirSync(plugins, { recursive: true })
      mkdirSync(join(dir, 'config'), { recursive: true })
      writeFileSync(join(plugins, 'goatcad_fill.py'), PLUGIN)
      const input = join(dir, 'cases.kicad_pcb')
      const output = join(dir, 'filled.kicad_pcb')
      const text = caseBoard()
      writeFileSync(input, text)
      await promisify(execFile)('xvfb-run', ['-a', binary, input], {
        env: {
          ...process.env,
          KICAD_DOCUMENTS_HOME: join(dir, 'docs'),
          KICAD_CONFIG_HOME: join(dir, 'config'),
          ORACLE_OUT: output
        },
        timeout: 120_000
      }).catch(() => undefined)
      expect(existsSync(output)).toBe(true)

      const board = parseKicadBoard(text)
      const ours = planTeardrops(board, boardIndex(board), 'all', {
        maxError: mmToNm(0.005),
        settings: DEFAULT_TEARDROP_SETTINGS,
        maskExpansion: 0
      }).add.flatMap((z) => [
        { layer: z.layer, points: z.outline },
        ...(z.mask ? [{ layer: z.mask.layer, points: z.mask.outline }] : [])
      ])
      const theirs = parseKicadBoard(readFileSync(output, 'utf8')).zones.filter(isTeardropZone)
      const close = (a: { x: number; y: number }[], b: { x: number; y: number }[]): boolean =>
        a.length === b.length &&
        a.every((p, i) => Math.abs(p.x - b[i].x) <= 5 && Math.abs(p.y - b[i].y) <= 5)
      const missing = theirs
        .filter((z) => !ours.some((o) => o.layer === z.layers[0] && close(o.points, z.points)))
        .map((z) => `${z.layers[0]} ${z.points.map((p) => `${p.x / 1e6},${p.y / 1e6}`).join(' ')}`)
      expect(missing).toEqual([])
      expect(ours.length).toBe(theirs.length)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
