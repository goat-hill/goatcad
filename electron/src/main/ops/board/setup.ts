/**
 * `board.get_setup` and `board.update_setup` — Board Setup, read and written
 * by an agent in the page's own sections (`lib/board/boardSetup.ts`).
 *
 * Design: `docs/agent-api.md`. The stackup and the general
 * settings are the board's and land on its undo list; constraints, net
 * classes, severities and the profile live in the project file, written as the
 * page writes them, with every replaced value in the answer to put back.
 */
import { defineDesignOp } from '../registry'
import { s } from '../schema'
import { refused } from '../errors'
import { checksArg } from '../checksArg'
import { BOARD_FILE } from '../fileArgs'

const SECTIONS = [
  'stackup',
  'general',
  'constraints',
  'tuningPatterns',
  'teardrops',
  'tuningProfiles',
  'netClasses',
  'severities',
  'profile',
  'exclusions'
] as const

const boardArg = s
  .string()
  .trim()
  .describe(`${BOARD_FILE}; omit for the project's one board.`)
  .optional()

export const boardGetSetup = defineDesignOp({
  name: 'board.get_setup',
  scope: 'board',
  mutates: false,
  summary:
    'Read Board Setup: the stackup, design rules, net classes and tuning that routing and DRC hold to.',
  guidance:
    "Read before board_update_setup and before routing: the constraints and net class sizes are what DRC measures and what new tracks and vias default to. Each section comes back in the shape board_update_setup takes, in mm. netClasses.matched lists the nets each pattern takes, then Default's (the rest), as Board Setup counts them; it is read-only. severities.rules lists every rule's severity; changed marks the project's overrides, notChecked the rules not run yet.",
  input: s.object({
    board: boardArg,
    sections: s
      .array(s.enum(SECTIONS))
      .min(1)
      .describe('Only these sections; default all.')
      .optional()
  }),
  examples: [
    { args: { sections: ['constraints', 'netClasses'] }, note: 'what routing is held to' },
    { args: { sections: ['stackup'] }, note: 'the layers the board is built from' }
  ],
  request: (args) => ({
    kind: 'get-board-setup',
    ...(args.board ? { board: args.board } : {}),
    ...(args.sections ? { sections: args.sections } : {})
  })
})

export const boardUpdateSetup = defineDesignOp({
  name: 'board.update_setup',
  scope: 'board',
  mutates: true,
  summary:
    'Change Board Setup: apply a fab profile, or edit the stackup, rules, net classes or tuning.',
  guidance:
    "Send only what changes, each section in the shape board_get_setup answers. profile applies first (seeding the constraints, the Default class and the stackup); the rest lands on top. stackup's build keys regenerate the build, replacing per-layer hand edits; its layers, addDielectric and removeLayers edit rows in place, by the names board_get_setup reads, as Board Setup's table does. Stackup and general are one undo step on the board tab, unsaved. Constraints, tuningPatterns, teardrops, tuningProfiles, netClasses, severities and profile are written to the project file at once and cannot be undone: the answer's before holds every replaced value. New rules or a new stackup leave every zone stale.",
  input: s.object({
    board: boardArg,
    profile: s
      .string()
      .trim()
      .describe('Profile id from board_get_setup, e.g. "jlcpcb-4l-1.6".')
      .optional(),
    stackup: s
      .json()
      .describe(
        "Build: preset (a fab's catalog build), copperLayers (4 adds In1.Cu and In2.Cu), boardThickness, copperThickness, innerCopperThickness, prepregThickness, prepregEpsilonR (a ply's), dielectricMaterial, epsilonR (the core's), lossTangent, maskColor, silkColor, copperFinish. Rows: layers [{name, type, material, thickness, epsilonR, lossTangent, color}], addDielectric [{after, type, material, thickness, epsilonR, lossTangent}], removeLayers [dielectric names]; mm."
      )
      .optional(),
    general: s
      .json()
      .describe(
        "paper, gridOrigin {x, y}, drillOrigin {x, y} (the position file's origin; null resets to 0,0), mm."
      )
      .optional(),
    constraints: s.json().describe('Design rules, mm, e.g. {"minClearance": 0.15}.').optional(),
    tuningPatterns: s
      .json()
      .describe(
        "The length tuners' meander defaults by tuner, single, pair and skew, each partial: minAmplitude, maxAmplitude, spacing (mm), cornerRadiusPercent (0–100), singleSided."
      )
      .optional(),
    teardrops: s
      .json()
      .describe(
        'The teardrop defaults by shape, round, rect and track (track to track, with enabled), each partial: bestLengthRatio, maxLength, bestWidthRatio, maxWidth (mm), filterRatio, curvedEdges, allowTwoSegments, preferZoneConnections (round and rect).'
      )
      .optional(),
    tuningProfiles: s
      .json()
      .describe(
        "upsert [profiles by name: type, targetImpedance (ohms), timeDomain, viaDelay (ps/mm), layers [{layer, topReference, bottomReference, width, gap (mm), delay (ps/mm)}], each given list whole; solve: true fills each layer's width and delay for the target, a pair's at its gap, as KiCad's calculator], rename [{from, to}] (classes follow), remove [names] (classes clear)."
      )
      .optional(),
    netClasses: s
      .json()
      .describe(
        "upsert [classes by name; a new one starts from Default; tuningProfile names a profile, '' clears], rename [{from, to}] (patterns follow), remove [names] (patterns go), patterns (the whole ordered list), extraSizes {tracks: [mm], vias: [{size, drill}]} (the route tool's extra sizes, each list whole)."
      )
      .optional(),
    severities: s.json().describe('KiCad rule key to "error", "warning" or "ignore".').optional(),
    exclusions: s.json().describe('Refused: exclusions are made in KiCad.').optional(),
    dryRun: s.boolean().describe('Answer with what would change and write nothing.').optional(),
    checks: checksArg
  }),
  examples: [
    {
      args: { profile: 'jlcpcb-4l-1.6' },
      note: 'a 4-layer JLCPCB board'
    },
    {
      args: {
        netClasses: {
          upsert: [{ name: 'Power', trackWidth: 0.5, clearance: 0.2 }],
          patterns: [
            { pattern: '+3V3', netClass: 'Power' },
            { pattern: 'VBUS', netClass: 'Power' }
          ]
        }
      },
      note: 'a wider class for the supply nets'
    },
    {
      args: { stackup: { layers: [{ name: 'dielectric 1', thickness: 0.2, epsilonR: 4.4 }] } },
      note: 'one dielectric edited, the rest kept'
    },
    {
      args: { general: { drillOrigin: { x: 100, y: 100 } } },
      note: "the position file's origin"
    }
  ],
  request(args) {
    const { board, dryRun, ...rest } = args
    const changes = Object.fromEntries(
      Object.entries(rest).filter(([, value]) => value !== undefined)
    )
    if (!Object.keys(changes).length)
      return refused(
        'Nothing to change.',
        'Send at least one of profile, stackup, general, constraints, tuningPatterns, teardrops, tuningProfiles, netClasses or severities.'
      )
    return {
      kind: 'update-board-setup',
      ...(board ? { board } : {}),
      changes,
      ...(dryRun ? { dryRun: true } : {})
    }
  }
})
