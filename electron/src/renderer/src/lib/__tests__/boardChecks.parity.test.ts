/**
 * Board checks against KiCad's own DRC, on real boards. Not in the default
 * suite and never on CI: it needs KiCad installed (`kicadParity.ts`) and takes
 * minutes on a corpus. Run it with `./bin/test-parity`.
 *
 * The corpus is the repo's sample project plus whatever `PARITY_BOARDS` names:
 * a colon-separated list of `.kicad_pcb` files and directories searched for
 * them — `demos` and `qa` (`qa/data/pcbnew/`) in the pinned KiCad checkout
 * (`kicadSource`), read in place, never copied. Each board runs with the rules of its `.kicad_pro`,
 * as `kicad-cli pcb drc` does, and at that project's rule severities: a rule
 * the project ignores is not compared. Findings are compared per KiCad
 * violation key as sets of the items named — a pad as `R5.3`, anything else
 * by uuid — never by count, since a marker's position is KiCad's own.
 *
 * A board is skipped uncompared only where that is approved: kicad-cli cannot
 * load it, or it is from before KiCad 6. Any other board not compared — its
 * custom rules use what the engine does not read yet, or kicad-cli ran past
 * its caps — is a gap in parity, listed in `UNCOMPARED` with what it waits
 * on; one not listed fails the run.
 *
 * `PARITY_REPORT=<file>` keeps the full comparison; `PARITY_CACHE=<dir>` keeps KiCad's reports.
 */
import { beforeAll, describe, expect, test } from 'vitest'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'fs'
import { createHash } from 'crypto'
import { tmpdir } from 'os'
import { basename, dirname, join } from 'path'
import {
  allZones,
  getNetName,
  isTeardropZone,
  parseKicadBoard,
  type KicadBoard
} from '../kicad/board'
import { nmToMm } from '../kicad/coordinates'
import { unescapeKicadText } from '../kicad/textMarkup'
import { BOARD_KICAD_KEYS, boardChecksSteps } from '../board/boardChecks'
import { budgetFor, PARITY_TEST_TIMEOUT_MS } from './parityBudget'
import { boardRules } from '../board/rules/boardRules'
import { BoardSpatialIndex, padCopperCenter } from '../board/spatialIndex'
import { computeConnectivity } from '../board/boardConnectivity'
import {
  KICAD_COULD_NOT_LOAD,
  KicadGaveUp,
  requireKicadCli,
  kicadCliVersion,
  rememberGiveUp,
  runKicad
} from './kicadParity'
import { customRulesOf, librariesFor, parityBoards, settingsFor } from './parityBoards'
import { copperDrawings } from '../board/boardDrawings'
import { boardItemIds } from '../board/boardItems'
import { positional, worldOf } from '../board/drc/shared'
import { teardropOwner } from '../board/drc/context'
import { footprintTransform, tfPoint } from '../schematic/placement'
import { loadClipper } from '../geometry/clip'
import { MIN_FORMAT_VERSION } from '../kicad/migrate'
import { schematicNetlistOf } from '../board/schematicNetlist'
import { loadDesign } from '../schematic/__tests__/netlistFixtures'

const cli = requireKicadCli()

/** The violations the engine raises; the rest of DRC is not compared. */
const COMPARED = new Set(Object.values(BOARD_KICAD_KEYS))

/**
 * KiCad's DRC stops reporting a violation after this many: 499 for clearance
 * and unconnected items, 199 for the rest (drc_engine.cpp).
 */
const errorLimit = (key: string): number =>
  key === 'clearance' || key === 'unconnected_items' ? 499 : 199

const corpus = parityBoards()

interface Violation {
  type: string
  severity: string
  description: string
  items: Array<{ uuid: string; description: string; pos: { x: number; y: number } }>
}

/**
 * What is not checked yet, so a KiCad violation naming one is not compared:
 * barcodes (BACKLOG.md).
 */
const deferredItem = (item: { description: string }): boolean => /^Barcode\b/.test(item.description)

/**
 * What a violation says that is not compared: TrueType text's stroke weight,
 * which needs the face's outlines (kicad-parity.md deviations).
 */
const deferredViolation = (violation: Violation): boolean =>
  /TrueType font characters/.test(violation.description)

/**
 * Violations about whole nets, which KiCad names by whichever of the net's
 * items come first in memory: compared by the nets they name.
 */
const BY_NET = new Set([
  'length_out_of_range',
  'skew_out_of_range',
  'too_many_vias',
  'diff_pair_uncoupled_length_too_long'
])

/**
 * Violations that name texts, graphics and fields, which have no label of
 * their own: any item the file gives a uuid is named by it.
 */
const BY_UUID = new Set([
  'text_height',
  'text_thickness',
  'mirrored_text_on_front_layer',
  'nonmirrored_text_on_back_layer',
  'text_on_edge_cuts',
  'unresolved_variable',
  'generic_error',
  'generic_warning',
  'item_on_disabled_layer',
  'assertion_failure',
  'track_segment_length',
  'track_angle',
  'track_not_centered_on_via',
  'silk_overlap',
  'silk_over_copper',
  'silk_edge_clearance',
  'solder_mask_bridge'
])

/**
 * Items a violation names that are not compared: the edge a silkscreen item
 * crosses, which is whichever edge segment KiCad's search met first.
 */
const unnamedItem = (type: string, item: { description: string }): boolean =>
  type === 'silk_edge_clearance' && / on (Edge\.Cuts|Margin)$/.test(item.description)

/**
 * Violations KiCad may report twice for one pair on one layer: a pad and a via
 * are tested from the track loop and again from the pad loop, each reporting
 * the hole it meets (drc_test_provider_copper_clearance.cpp, testTrackClearances
 * and testPadClearances; drc_test_provider_hole_to_hole.cpp likewise). We report
 * the pair once per layer, so KiCad's count is held between ours and twice it.
 */
const TESTED_TWICE = new Set(['hole_clearance', 'hole_to_hole'])

/** The repeat suffix the multiset adds (`#2`), and the identity without it. */
const baseOf = (entry: string): string => entry.replace(/ #\d+$/, '')

/** KiCad's entries for a twice-tested rule, cut to ours wherever its count is within twice ours. */
const withinTwice = (kicad: ReadonlySet<string>, ours: ReadonlySet<string>): Set<string> => {
  const count = (set: ReadonlySet<string>): Map<string, number> => {
    const counts = new Map<string, number>()
    for (const entry of set) counts.set(baseOf(entry), (counts.get(baseOf(entry)) ?? 0) + 1)
    return counts
  }
  const theirs = count(kicad)
  const mine = count(ours)
  const out = new Set<string>()
  for (const [base, k] of theirs) {
    const o = mine.get(base) ?? 0
    const n = o > 0 && o <= k && k <= 2 * o ? o : k
    for (let i = 1; i <= n; i++) out.add(i === 1 ? base : `${base} #${i}`)
  }
  return out
}

/** A violation KiCad reports in place of another once that other hits its limit. */
const SPILLS: Record<string, string> = { silk_over_copper: 'silk_overlap' }

/** Every uuid the file names (and a pre-v6 file's tstamps). */
const uuidsIn = (text: string): Set<string> =>
  new Set([...text.matchAll(/\((?:uuid|tstamp) "?([0-9A-Fa-f-]+)"?\)/g)].map((m) => m[1]))

/**
 * Where the comparison is known to differ, and why. An entry that stops
 * differing fails the run, so the list cannot go stale.
 */
interface Known {
  key: string | string[]
  why: string
}

const KNOWN: Record<string, Known | Known[]> = {
  'demos/vme-wren/vme-wren.kicad_pcb': [
    {
      key: 'net_conflict',
      why: 'compared since fromTo() is read: we raise net conflicts on many pads KiCad matches to the schematic, not yet diagnosed (schematic parity naming, netlist-sync)'
    },
    {
      key: 'connection_width',
      why: 'compared since fromTo() is read: some narrow necks differ both ways, not yet diagnosed'
    }
  ],
  'qa/data/pcbnew/issue21482/issue21482.kicad_pcb': {
    key: 'creepage',
    why: "KiCad tests each net pair on every copper layer over one creepage graph it carries from layer to layer, and reports the pair again where a later layer's shortest path names other items (J7 and two unconnected vias, J1 and J3 thrice); we report each pair of items once"
  },
  'qa/data/pcbnew/issue25670/issue25670.kicad_pcb': {
    key: ['shorting_items', 'hole_clearance', 'solder_mask_bridge', 'unconnected_items'],
    why: 'a SIG via overlaps U1.9 (NET8): kicad-cli propagates nets on load and reads the via as NET8, where a file keeps its own nets until an edit (netPropagation.ts), so we report the short and what follows from it'
  },
  'qa/data/pcbnew/issue24078/issue24078.kicad_pcb': {
    key: 'creepage',
    why: "C4's pads straddle two overlapping cutouts (a slot and a Bézier-bounded one): KiCad's surface path goes round their union, ours finds 2.88 mm between them"
  },
  'qa/data/pcbnew/vme-wren.kicad_pcb': [
    {
      key: 'silk_over_copper',
      why: 'KiCad measures an unfilled circle against a segment or a square rectangle from its centerline alone, its stroke width ignored, so a pin-1 dot inside a pad or a line grazing a ring does not collide; we measure the stroke (kicad-parity.md deviations)'
    },
    {
      key: 'malformed_courtyard',
      why: "IC10's courtyard has four lines ending at one point: which two of them KiCad's nearest-end search returns follows its k-d tree's (nanoflann's) leaf order, which names a different pair at one gap; we take them in file order (IC40's, drawn the same, matches)"
    }
  ],
  'qa/data/pcbnew/issue5093.kicad_pcb': {
    key: 'silk_overlap',
    why: 'KiCad measures an unfilled circle against a segment or a square rectangle from its centerline alone, its stroke width ignored, so a pin-1 dot inside a pad or a line grazing a ring does not collide; we measure the stroke (kicad-parity.md deviations)'
  },
  'qa/data/pcbnew/padstacks_complex.kicad_pcb': {
    key: 'annular_width',
    why: "KiCad 10.0.6's fast annular path measures every padstack layer with the pad's front size (getPadAnnulusPts reads GetSizeX(), not the layer's), so it reports the front's ring on inner and back layers whose copper is wider or narrower; we measure each layer's own copper"
  },
  'pns_regressions/boards/stickhub-extra-via.kicad_pcb': {
    key: 'copper_edge_clearance',
    why: 'KiCad 10.0 takes the oblong NPTH slot H1 for a board edge (KiCad #24799, fixed upstream)'
  },
  'qa/data/pcbnew/issue22475/issue22475.kicad_pcb': {
    key: 'clearance',
    why: "a gap at KiCad's limit less its 0.5 µm epsilon, to a 35 mm arc run the long way round: KiCad's integer arc and our exact one land a hair apart (kicad-parity.md deviations)"
  },
  'qa/data/pcbnew/issue23469/issue23469.kicad_pcb': {
    key: 'copper_edge_clearance',
    why: "KiCad 10.0 takes SW1's oblong NPTH slot for a board edge (KiCad #24799, fixed upstream)"
  },
  '8851_HW-U1-VCU118_REV2-0_071417.kicad_pcb': [
    {
      key: 'track_dangling',
      why: 'a 0.18 mm arc lies wholly inside its via; KiCad 10.0 measures an arc against a circle by its edge alone, so never joins them (kicad-parity.md deviations)'
    },
    {
      key: 'silk_over_copper',
      why: 'KiCad stops at 199 silk-over-copper findings in its own walk order, 21 of which we do not report (its silk overlaps are capped too, and spill)'
    },
    {
      key: 'copper_sliver',
      why: 'KiCad finds one sliver on 03_SIG1 that no fill or polygon of the layer has as a corner; its source is not found yet'
    }
  ],
  'qa/data/pcbnew/issue23053/issue23053.kicad_pcb': [
    {
      key: 'copper_sliver',
      why: "a B.Cu fill's thin wedges along its straight cuts (8.8° at 9.84, -10.6) read as slivers here and not in KiCad, which reads the same ring; cause not found yet"
    },
    {
      key: 'clearance',
      why: "bruecke_mitte's stored fill closes on an edge 0.2949 mm from UZ's (rule 0.3 mm), which KiCad does not measure there, cause not found; and a via 0.1995 mm from R18.2's roundrect (rule 0.2 mm), not diagnosed"
    }
  ],
  'qa/data/pcbnew/issue8909.kicad_pcb': {
    key: 'clearance',
    why: "the VIN_FUSED and VIN fills are 0.2011 mm apart (rule 0.254 mm): KiCad's zone-to-zone sweep stops at the first edge of the second zone that starts past the end of the first's, so it never tries the pair that is close (testZonesToZones)"
  },
  'qa/data/pcbnew/issue24758/issue24758.kicad_pcb': {
    key: 'annular_width',
    why: "a via's padstack is 0 mm across on B.Cu, a ring narrower than its hole, which KiCad measures by magnitude and passes (kicad-parity.md deviations)"
  },
  'qa/data/pcbnew/complex_hierarchy.kicad_pcb': {
    key: 'annular_width',
    why: 'a MIRE pad narrower than its hole passes KiCad, which takes the ring by magnitude (kicad-parity.md deviations)'
  },
  // Schematic parity reads the netlist the schematic engine derives; where its
  // net names are not yet KiCad's, pads read as conflicting.
  'demos/cm5_minima/CM5_MINIMA_3.kicad_pcb': {
    key: 'silk_edge_clearance',
    why: 'two B.SilkS arcs read as crossing the edge, which KiCad does not report (cause not found yet)'
  },
  'demos/jetson-agx-thor-baseboard/jetson-agx-thor-baseboard.kicad_pcb': [
    {
      key: 'net_conflict',
      why: 'bus-group members (I2C_{SYS}.SDA) are named from the sheet holding the group in KiCad; the schematic engine does not name nets through buses yet'
    },
    {
      key: ['silk_edge_clearance', 'silk_over_copper'],
      why: 'a multi-line silk text ending in a newline reads as crossing the edge, which KiCad does not report (cause not found yet); and a silk circle over H5.1, whose stroke KiCad ignores against a square rectangle (kicad-parity.md deviations)'
    }
  ],
  'demos/video/video.kicad_pcb': {
    key: 'net_conflict',
    why: "nets joined only through a bus take the root bus label's name in KiCad; the schematic engine does not net through buses yet (netlist-sync, out of alpha)"
  },
  'demos/royalblue54L_feather/RoyalBlue54L-Feather.kicad_pcb': {
    key: 'net_conflict',
    why: "a bus group's member (SWD_TRG.~{RESET}) is named from its sheet in KiCad; the schematic engine does not net through buses yet (netlist-sync, out of alpha)"
  },
  'demos/openair-max/One-Air-Max.kicad_pcb': {
    key: ['silk_overlap', 'silk_over_copper'],
    why: 'KiCad measures an unfilled circle against a segment or a square rectangle from its centerline alone, its stroke width ignored, so a pin-1 dot inside a pad or a line grazing a ring does not collide; we measure the stroke (kicad-parity.md deviations)'
  },
  'qa/data/pcbnew/issue22548/issue22548.kicad_pcb': {
    key: ['net_conflict', 'missing_footprint'],
    why: "KiCad's test of one sheet file under four instances: the schematic engine leaves one U4 unannotated, where KiCad's netlist keeps U4 without its pins"
  }
}

/**
 * Boards not compared, though not an approved skip, and what each waits on —
 * parity work, not exemptions. An entry whose board is compared now fails the
 * run, unless it waits on kicad-cli's caps, which depend on the machine.
 */
const UNCOMPARED: Record<string, { why: string; caps?: true }> = {}

/**
 * Corpus files skipped by name, approved: not a board as written, though
 * kicad-cli reads past the fault.
 */
const BROKEN: Record<string, string> = {
  'qa/data/pcbnew/teardrop_offcenter_two_segment.kicad_pcb':
    'the file has text pasted after the board, which kicad-cli ignores and the app does not read'
}

const uncomparedFor = (boardFile: string): { why: string; caps?: true } | undefined =>
  Object.entries(UNCOMPARED).find(([suffix]) => boardFile.endsWith(`/${suffix}`))?.[1]

/** A board's known differences, by the end of its path: a demo and its QA copy differ. */
const knownFor = (boardFile: string): Known[] => {
  const known = Object.entries(KNOWN).find(([suffix]) => boardFile.endsWith(`/${suffix}`))?.[1]
  return known ? (Array.isArray(known) ? known : [known]) : []
}

/** The nets a violation names, as its identity. */
const netIdentity = (names: string[]): string =>
  `nets ${[...new Set(names.filter(Boolean))].sort().join(' | ')}`

/** A position as an identity: what `<kind>@x,y` rounds to on both sides. */
const posKey = (x: number, y: number): string => `${x.toFixed(3)},${y.toFixed(3)}`

interface Report {
  violations: Violation[]
  unconnected_items: Violation[]
  /** Only in a report run with `--schematic-parity`. */
  schematic_parity?: Violation[]
}

/** The rules a project turns off, which KiCad then does not run. */
const ignoredKeys = (boardFile: string): Set<string> => {
  const project = join(dirname(boardFile), `${basename(boardFile, '.kicad_pcb')}.kicad_pro`)
  if (!existsSync(project)) return new Set()
  const severities =
    JSON.parse(readFileSync(project, 'utf8')).board?.design_settings?.rule_severities ?? {}
  return new Set(
    Object.entries(severities)
      .filter(([, severity]) => severity === 'ignore')
      .map(([key]) => key)
  )
}

/** A footprint as a finding names it: its reference, else its position as the engine writes it. */
const footprintName = (bfp: KicadBoard['footprints'][number]): string => {
  const round = (mm: number): number => Math.round(mm * 1e4) / 1e4
  return (
    bfp.reference || `footprint@${round(nmToMm(bfp.position.x))},${round(nmToMm(bfp.position.y))}`
  )
}

/**
 * Our findings' item ids (`boardItemIds`, what `items_get` takes) as KiCad's
 * side is labelled: a pad `R5.3` by number or `pad@x,y` by place, copper by
 * uuid else place, and the board edge left out, which only KiCad names.
 */
const ourLabelsOf = (board: KicadBoard): Map<string, string> => {
  const { byObject, byUuid } = boardItemIds(board)
  const labels = new Map<string, string>()
  const label = (item: object, as: string): void => {
    const id = byObject.get(item)
    if (id !== undefined) labels.set(id, as)
  }
  for (const bfp of board.footprints) {
    const reference = footprintName(bfp)
    label(bfp, reference)
    // A field our checks name `R5#Reference` (boardFields.ts) KiCad names by the file's uuid.
    const id = byObject.get(bfp)
    if (id === bfp.reference)
      for (const p of bfp.footprint.properties) if (p.uuid) labels.set(`${id}#${p.key}`, p.uuid)
    for (const pad of bfp.footprint.pads) {
      const center = tfPoint(footprintTransform(bfp), pad.position.x, pad.position.y)
      label(
        pad,
        pad.number
          ? `${reference}.${pad.number}`
          : positional('pad', padCopperCenter(pad, center, 0))
      )
    }
    for (const list of [
      bfp.footprint.fpLines,
      bfp.footprint.fpArcs,
      bfp.footprint.fpCircles,
      bfp.footprint.fpRects,
      bfp.footprint.fpPolys
    ])
      for (const g of list as Array<{ layer?: string; uuid?: string }>)
        if (g.uuid && (g.layer === 'Edge.Cuts' || g.layer === 'Margin'))
          labels.set(g.uuid, 'Edge.Cuts')
  }
  for (const [list, kind] of [
    [board.segments, 'track'],
    [board.trackArcs, 'arc']
  ] as const)
    for (const track of list) label(track, track.uuid ?? positional(kind, worldOf(track.start)))
  for (const via of board.vias) label(via, via.uuid ?? positional('via', worldOf(via.position)))
  for (const list of [board.grLines, board.grArcs, board.grCircles, board.grRects, board.grPolys])
    for (const g of list as Array<{ layer?: string; uuid?: string }>)
      if (g.uuid && (g.layer === 'Edge.Cuts' || g.layer === 'Margin'))
        labels.set(byUuid.get(g.uuid) ?? g.uuid, 'Edge.Cuts')
  return labels
}

/** What a finding names an item by, from its uuid: `R5.3` for a pad, else the uuid. */
const labelsOf = (board: KicadBoard): Map<string, string> => {
  const labels = new Map<string, string>()
  for (const bfp of board.footprints) {
    const reference = footprintName(bfp)
    if (bfp.uuid) labels.set(bfp.uuid, reference)
    for (const pad of bfp.footprint.pads) {
      if (pad.uuid && pad.number) labels.set(pad.uuid, `${reference}.${pad.number}`)
    }
  }
  for (const list of [board.segments, board.trackArcs, board.vias, allZones(board)]) {
    for (const item of list) if (item.uuid) labels.set(item.uuid, item.uuid)
  }
  for (const pieces of copperDrawings(board).values())
    for (const d of pieces) if (d.uuid) labels.set(d.uuid, d.uuid)
  return labels
}

/** The net of what a finding names, by its KiCad uuid: labels repeat (a reference shared, none at all). */
const netsOf = (board: KicadBoard): Map<string, string> => {
  const nets = new Map<string, string>()
  for (const bfp of board.footprints) {
    for (const pad of bfp.footprint.pads) {
      if (pad.uuid) nets.set(pad.uuid, pad.net?.name ?? '')
    }
  }
  for (const list of [board.segments, board.trackArcs, board.vias]) {
    for (const item of list) if (item.uuid) nets.set(item.uuid, getNetName(board, item.net))
  }
  for (const zone of allZones(board)) if (zone.uuid) nets.set(zone.uuid, zone.netName ?? '')
  for (const pieces of copperDrawings(board).values())
    for (const d of pieces) if (d.uuid && d.connected) nets.set(d.uuid, getNetName(board, d.net))
  return nets
}

/** Each pad's, track's and via's island, by its KiCad uuid, as our connectivity reads it. */
const islandsByUuid = (
  board: KicadBoard,
  index: BoardSpatialIndex,
  connectivity: ReturnType<typeof computeConnectivity>
): Map<string, string> => {
  const islands = new Map<string, string>()
  for (const [net, conn] of connectivity.nets)
    for (const [item, cluster] of conn.clusterOfItem) {
      const ref = index.items[item]?.ref
      const uuid =
        ref?.type === 'pad'
          ? board.footprints[ref.index]?.footprint.pads[ref.pad]?.uuid
          : ref?.type === 'segment'
            ? board.segments[ref.index]?.uuid
            : ref?.type === 'tarc'
              ? board.trackArcs[ref.index]?.uuid
              : ref?.type === 'via'
                ? board.vias[ref.index]?.uuid
                : undefined
      if (uuid) islands.set(uuid, `${net}:${cluster}`)
    }
  return islands
}

interface Comparison {
  board: string
  key: string
  ours: string[]
  kicad: string[]
  /** KiCad hit its per-rule limit here, so only what it did report can be held to. */
  truncated: boolean
}

/**
 * KiCad's report for a board. `PARITY_CACHE=<dir>` keeps each one keyed by the
 * board, its project and its custom rules, so a rerun while iterating on the
 * engine runs no kicad-cli at all.
 */
const kicadReport = async (
  boardFile: string,
  text: string,
  schematicParity = false
): Promise<Report> => {
  const hash = createHash('sha1')
    .update(kicadCliVersion(cli))
    .update('drc')
    .update(boardFile)
    .update(text)
  for (const extension of ['.kicad_pro', '.kicad_dru']) {
    const file = join(dirname(boardFile), `${basename(boardFile, '.kicad_pcb')}${extension}`)
    if (existsSync(file)) hash.update(file).update(readFileSync(file))
  }
  // A schematic-parity run is its own report, keyed by the schematics too; the
  // plain run's key is unchanged, so its cached reports stay valid.
  if (schematicParity) {
    hash.update('schematic-parity')
    for (const name of readdirSync(dirname(boardFile)).sort())
      if (name.endsWith('.kicad_sch'))
        hash.update(name).update(readFileSync(join(dirname(boardFile), name)))
  }
  const key = hash.digest('hex')
  const cache = process.env.PARITY_CACHE
  const cached = cache ? join(cache, `${key}.json`) : null
  if (cached && existsSync(cached)) return JSON.parse(readFileSync(cached, 'utf8')) as Report
  const work = mkdtempSync(join(tmpdir(), 'goatcad-drc-parity-'))
  const reportFile = join(work, 'drc.json')
  await rememberGiveUp(key, () =>
    runKicad(cli, [
      'pcb',
      'drc',
      '--format',
      'json',
      '--severity-all',
      '--all-track-errors',
      ...(schematicParity ? ['--schematic-parity'] : []),
      '-o',
      reportFile,
      boardFile
    ])
  )
  const reportText = readFileSync(reportFile, 'utf8')
  // /tmp is often RAM; a run over a corpus must not leave a report per board there.
  rmSync(work, { recursive: true, force: true })
  if (cache && cached) {
    mkdirSync(cache, { recursive: true })
    writeFileSync(cached, reportText)
  }
  return JSON.parse(reportText) as Report
}

const compare = async (boardFile: string): Promise<Comparison[]> => {
  const broken = Object.entries(BROKEN).find(([suffix]) => boardFile.endsWith(`/${suffix}`))
  if (broken) throw new NotCompared(broken[1], true)
  const text = readFileSync(boardFile, 'utf8')
  // KiCad first: a file it cannot load (not a board, or a newer format) is skipped, not ours to read.
  const parsed = await kicadReport(boardFile, text)
  const board = parseKicadBoard(text)
  // A development build before KiCad 6 wrote footprints as `(module …)`, which
  // the parser does not read: the app opens no file that old (MIN_FORMAT_VERSION).
  if ((board.version ?? 0) < MIN_FORMAT_VERSION.kicad_pcb && /^\s*\(module /m.test(text))
    throw new NotCompared(
      `its footprints are pre-KiCad 6 (module …), which the app does not open`,
      true
    )
  const index = BoardSpatialIndex.build(board)
  const settings = settingsFor(boardFile)
  const customRules = customRulesOf(boardFile)
  if (customRules) {
    const { unsupported } = boardRules(board, settings, customRules).customRules
    if (unsupported.length > 0)
      throw new NotCompared(`its custom rules use ${unsupported.join(', ')}, not read yet`, false)
  }
  // With a schematic beside it, the board is also held to it: KiCad's
  // schematic-parity run, and ours with the design read as the app reads it.
  const schematicFile = boardFile.replace(/\.kicad_pcb$/, '.kicad_sch')
  // A schematic kicad-cli cannot load (one saved by a newer KiCad) leaves the board compared without it.
  const parity = existsSync(schematicFile)
    ? await kicadReport(boardFile, text, true).catch((error: unknown) => {
        if (error instanceof KicadGaveUp && error.message === KICAD_COULD_NOT_LOAD) return null
        throw error
      })
    : null
  const schematic = parity ? schematicNetlistOf(await loadDesign(schematicFile)) : null
  // The budget starts once kicad-cli has reported: it bounds our side.
  const budget = budgetFor('board', boardFile)
  const connectivity = computeConnectivity(board, index)
  const ourLabels = ourLabelsOf(board)
  const ours = budget
    .drain(
      boardChecksSteps({
        board,
        index,
        connectivity,
        settings,
        customRules,
        libraries: librariesFor(boardFile),
        schematic
      }),
      () => 'checking the board'
    )
    .filter((finding) => BOARD_KICAD_KEYS[finding.code] !== undefined)
    .map((finding) => ({
      ...finding,
      // An outline problem names its edge shapes; KiCad names none.
      items:
        finding.code === 'invalid-outline'
          ? ['Edge.Cuts']
          : finding.items.map((id) => ourLabels.get(id) ?? id)
    }))

  const violations = [
    ...parsed.violations,
    ...parsed.unconnected_items,
    ...(parity?.schematic_parity ?? [])
  ].filter((violation) => !deferredViolation(violation))
  const labels = labelsOf(board)
  // KiCad names a teardrop by its own uuid; ours names the pad or via it belongs to.
  const { byObject } = boardItemIds(board)
  for (const zone of allZones(board)) {
    if (!zone.uuid || !isTeardropZone(zone)) continue
    const ref = teardropOwner(index, zone)?.ref
    const owner =
      ref?.type === 'pad'
        ? board.footprints[ref.index]?.footprint.pads[ref.pad]
        : ref?.type === 'segment'
          ? board.segments[ref.index]
          : ref?.type === 'tarc'
            ? board.trackArcs[ref.index]
            : ref?.type === 'via'
              ? board.vias[ref.index]
              : undefined
    const id = owner && byObject.get(owner)
    if (id !== undefined) labels.set(zone.uuid, ourLabels.get(id) ?? id)
  }
  const uuids = uuidsIn(text)
  const nets = netsOf(board)
  const ignored = ignoredKeys(boardFile)

  // An identity is the sorted labels of the items a violation names, less the
  // board edge (which only KiCad names as an item). An unnumbered pad is its
  // position on both sides. A missing connection is identified by its net
  // alone: both sides span the same islands, but a spanning tree may pick
  // different pairs to span them with. A creepage violation is identified by
  // its two nets: of items equally near, KiCad names whichever its memory
  // order reaches first.
  const netPair = (uuids: string[]): string =>
    uuids
      .map((uuid) => nets.get(uuid) ?? '?')
      .sort()
      .join(' | ')
  const identity = (items: string[]): string =>
    items
      .filter((item) => item !== 'Edge.Cuts')
      .map((item) => {
        // Only a whole position: `footprint@x,y.3` is a pad of an unreferenced footprint.
        const positional = /^(\w+)@(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)$/.exec(item)
        return positional
          ? `${positional[1]}@${posKey(Number(positional[2]), Number(positional[3]))}`
          : item
      })
      .sort()
      .join(' | ')
  // Past its limit for shorts KiCad reports each further short between two
  // items as a clearance of 0 (drc_test_provider_copper_clearance.cpp); those
  // are shorts here. Copper touching a fill is a clearance of 0 either way.
  const shortsCapped =
    violations.filter((v) => v.type === 'shorting_items').length >= errorLimit('shorting_items')
  const keyOf = (violation: Violation): string =>
    shortsCapped &&
    violation.type === 'clearance' &&
    /actual 0\.0000 mm/.test(violation.description) &&
    !violation.items.some(
      (item) => item.description.startsWith('Zone ') || item.description.includes('[<no net>]')
    )
      ? 'shorting_items'
      : violation.type
  // A mask opening of no copper of its own that bares two nets is named with
  // whichever bared item KiCad's threads recorded first, which no order
  // reproduces: such a bridge is compared by its opening alone.
  const maskOpenings = new Set(
    ours
      .filter((f) => BOARD_KICAD_KEYS[f.code] === 'solder_mask_bridge' && f.items.length === 3)
      .map((f) => f.items[0])
  )
  // Identities are a multiset: two findings that name items alike (pads of one
  // number, a reference repeated) count twice, and the second reads `#2`.
  const add = (set: Set<string>, identity: string): void => {
    let entry = identity
    for (let n = 2; set.has(entry); n++) entry = `${identity} #${n}`
    set.add(entry)
  }
  // A missing connection KiCad names spans two of our islands, or we would
  // read those items as joined: a check the per-net count cannot make.
  const islandOf = islandsByUuid(board, index, connectivity)
  const joinedHere: string[] = []
  const kicadByKey = new Map<string, Set<string>>()
  for (const raw of violations) {
    const violation = { ...raw, type: keyOf(raw) }
    if (!COMPARED.has(violation.type)) continue
    // A missing connection is compared by its net alone, whatever it names.
    if (violation.type !== 'unconnected_items' && violation.items.some(deferredItem)) continue
    const items = violation.items
      .filter((item) => !unnamedItem(violation.type, item))
      .map((item) => {
        const known = labels.get(item.uuid)
        if (known !== undefined) return known
        if (/^(NPTH pad|PTH pad|Pad) /.test(item.description))
          return `pad@${item.pos.x},${item.pos.y}`
        if (BY_UUID.has(violation.type) && uuids.has(item.uuid)) return item.uuid
        // A footprint the file gives no uuid, at its position, as ours names it.
        if (/^Footprint\b/.test(item.description) && !uuids.has(item.uuid))
          return `footprint@${item.pos.x},${item.pos.y}`
        return ''
      })
      .filter(Boolean)
    const set = kicadByKey.get(violation.type) ?? new Set()
    if (violation.type === 'unconnected_items') {
      const net = /\[([^\]]*)\]/.exec(violation.items[0]?.description ?? '')?.[1] ?? ''
      add(set, `${net}`)
      const [a, b] = violation.items.map((item) => islandOf.get(item.uuid))
      if (a !== undefined && a === b)
        joinedHere.push(`${net}: ${violation.items.map((item) => item.description).join(' to ')}`)
    } else if (BY_NET.has(violation.type)) {
      add(set, netIdentity(violation.items.map((item) => nets.get(item.uuid) ?? '')))
    } else if (violation.type === 'creepage') {
      add(set, netPair(violation.items.map((item) => item.uuid)))
    } else if (violation.type === 'solder_mask_bridge' && maskOpenings.has(items[0])) {
      add(set, `opening ${items[0]}`)
    } else {
      add(set, identity(items))
    }
    kicadByKey.set(violation.type, set)
  }
  const oursByKey = new Map<string, Set<string>>()
  for (const finding of ours) {
    const key = BOARD_KICAD_KEYS[finding.code]
    const set = oursByKey.get(key) ?? new Set()
    if (key === 'unconnected_items') {
      // KiCad's report prints a net unescaped (`/A/B`, not `/A{slash}B`).
      add(set, unescapeKicadText(nets.get(finding.kicadIds?.[0] ?? '') ?? ''))
    } else if (BY_NET.has(key)) {
      add(set, netIdentity((finding.kicadIds ?? []).map((id) => nets.get(id) ?? '')))
    } else if (key === 'creepage') {
      add(set, netPair(finding.kicadIds ?? []))
    } else if (key === 'solder_mask_bridge' && finding.items.length === 3) {
      add(set, `opening ${finding.items[0]}`)
    } else {
      add(set, identity(finding.items))
    }
    oursByKey.set(key, set)
  }
  const counts = new Map<string, number>()
  for (const { type } of violations) counts.set(type, (counts.get(type) ?? 0) + 1)
  if (shortsCapped) counts.set('shorting_items', errorLimit('shorting_items'))

  // Past its limit for silk overlaps KiCad goes on to the pair's next layer
  // pair, so a silk overlap it no longer reports comes out as silk over copper.
  for (const [spilled, capped] of Object.entries(SPILLS)) {
    if ((counts.get(capped) ?? 0) < errorLimit(capped)) continue
    const theirs = kicadByKey.get(spilled)
    for (const entry of oursByKey.get(capped) ?? []) theirs?.delete(entry)
  }

  const out: Comparison[] = []
  if (joinedHere.length > 0 && !ignored.has('unconnected_items'))
    out.push({
      board: boardFile,
      key: 'unconnected_items',
      ours: [],
      kicad: joinedHere.map((pair) => `islands ${pair}, which we join`),
      truncated: false
    })
  for (const key of TESTED_TWICE) {
    const theirs = kicadByKey.get(key)
    if (theirs) kicadByKey.set(key, withinTwice(theirs, oursByKey.get(key) ?? new Set()))
  }
  for (const key of new Set([...kicadByKey.keys(), ...oursByKey.keys()])) {
    if (ignored.has(key)) continue
    out.push({
      board: boardFile,
      key,
      ours: [...(oursByKey.get(key) ?? [])].sort(),
      kicad: [...(kicadByKey.get(key) ?? [])].sort(),
      truncated: (counts.get(key) ?? 0) >= errorLimit(key)
    })
  }
  return out
}

/** A board the engine does not read — its custom rules, or its format: not comparable. */
class NotCompared extends Error {
  constructor(
    message: string,
    /** Whether skipping it is approved (a pre-KiCad 6 file), not a gap in parity. */
    readonly approved: boolean
  ) {
    super(message)
  }
}

describe('board checks against KiCad DRC', () => {
  // Custom pads' thermal rings go through the geometry engine, as in the app.
  beforeAll(async () => {
    await loadClipper()
  })

  for (const boardFile of corpus) {
    test(basename(boardFile), { timeout: PARITY_TEST_TIMEOUT_MS }, async (ctx) => {
      let comparisons: Comparison[]
      try {
        comparisons = await compare(boardFile)
      } catch (error) {
        if (!(error instanceof KicadGaveUp || error instanceof NotCompared)) throw error
        const approved =
          error instanceof NotCompared ? error.approved : error.message === KICAD_COULD_NOT_LOAD
        if (approved) return ctx.skip(error.message)
        const listed = uncomparedFor(boardFile)
        expect(
          listed,
          `not compared (${error.message}), which is not an approved skip: make it comparable, or list it in UNCOMPARED`
        ).toBeDefined()
        return ctx.skip(`not compared: ${listed!.why}`)
      }
      const listed = uncomparedFor(boardFile)
      if (listed && !listed.caps)
        expect.fail(`compared now, though UNCOMPARED lists it (${listed.why}): remove the entry`)
      if (process.env.PARITY_REPORT) {
        writeFileSync(process.env.PARITY_REPORT, JSON.stringify(comparisons, null, 2) + '\n', {
          flag: 'a'
        })
      }
      const differences = comparisons.flatMap(({ key, ours, kicad, truncated }) => {
        const missing = kicad.filter((item) => !ours.includes(item))
        const extra = truncated ? [] : ours.filter((item) => !kicad.includes(item))
        return [
          ...missing.map((item) => `${key}: KiCad reports ${item || '(unnamed)'}; we do not`),
          ...extra.map((item) => `${key}: we report ${item || '(unnamed)'}; KiCad does not`)
        ]
      })
      // Each known difference still differs, and nothing else does.
      const explained = new Set<string>()
      for (const known of knownFor(boardFile)) {
        const keys = typeof known.key === 'string' ? [known.key] : known.key
        const expected = differences.filter((line) =>
          keys.some((key) => line.startsWith(`${key}: `))
        )
        expect(expected, known.why).not.toEqual([])
        for (const line of expected) explained.add(line)
      }
      expect(differences.filter((line) => !explained.has(line))).toEqual([])
    })
  }
})
