/**
 * Blank-file templates — the one place that knows what a valid empty design
 * file of each type looks like (docs/projects.md §6).
 *
 * Templates are **built as an AST and serialized through the same writer every
 * editor saves with**, never pasted as text. A text blob is only ever compared
 * to itself: it can be subtly unserializable, its quoting has to be
 * hand-maintained, and it cannot be re-targeted if the encoding changes. An
 * AST that round-trips through `serializeSExpr` round-trips by construction —
 * `__tests__/templates.test.ts` pins the output and reparses it.
 *
 * The project file is JSON, so its "AST" is a typed object; same principle.
 */
import { makeAtom, makeList } from '../kicad/footprint'
import { serializeSExpr, type SExprList, type SExprNode } from '../kicad/sexpr'
import { CURRENT_FORMAT_VERSION } from '../kicad/migrate'

/** The one format we write: KiCad 10's (RULES.md §7). */
const SCHEMATIC_VERSION = String(CURRENT_FORMAT_VERSION.kicad_sch)
const BOARD_VERSION = String(CURRENT_FORMAT_VERSION.kicad_pcb)
const SYMBOL_LIB_VERSION = String(CURRENT_FORMAT_VERSION.kicad_symbol_lib)
const FOOTPRINT_VERSION = String(CURRENT_FORMAT_VERSION.footprint)
const GENERATOR = 'goatcad'
const GENERATOR_VERSION = '1.0'

/** KiCad project-file schema version (`meta.version`). */
const PROJECT_SCHEMA_VERSION = 3

/**
 * Compact literal form for hand-authored nodes: a nested array is a list, a
 * bare string is an unquoted atom, and `q('…')` marks a quoted one. Keeps a
 * template readable as the file it produces.
 */
type Literal = string | QuotedAtom | Literal[]

interface QuotedAtom {
  readonly quoted: string
}

export const q = (value: string): QuotedAtom => ({ quoted: value })

const build = (literal: Literal): SExprNode => {
  if (Array.isArray(literal)) return makeList(literal.map(build), 0)
  if (typeof literal === 'string') return makeAtom(literal, false, 0)
  return makeAtom(literal.quoted, true, 0)
}

const render = (literal: Literal[]): string => `${serializeSExpr(build(literal) as SExprList)}\n`

const header = (version: string): Literal[] => [
  ['version', version],
  ['generator', q(GENERATOR)],
  ['generator_version', q(GENERATOR_VERSION)]
]

/**
 * A blank schematic. The uuid is supplied rather than generated so a project's
 * `.kicad_pro` can name the same root sheet — KiCad's `sheets` array keys on
 * the root schematic's uuid, so the two files must agree.
 */
export const schematicTemplate = (rootUuid: string): string =>
  render([
    'kicad_sch',
    ...header(SCHEMATIC_VERSION),
    ['uuid', q(rootUuid)],
    ['paper', q('A4')],
    ['lib_symbols'],
    ['sheet_instances', ['path', q('/'), ['page', q('1')]]]
  ])

/**
 * A blank two-layer board. The layer table is the stackup, so it is generated
 * from `copperLayers` rather than frozen as text — four-layer boards and the
 * P0.4 stackup editor extend this rather than forking a second template.
 */
export const boardTemplate = (copperLayers: 2 | 4 = 2): string => {
  // KiCad 10's ids and order: copper front to back (F.Cu 0, In*n*.Cu 2*n*+2,
  // B.Cu 2), then each technical pair front first.
  const inner: Literal[] =
    copperLayers === 4
      ? [
          ['4', q('In1.Cu'), 'signal'],
          ['6', q('In2.Cu'), 'signal']
        ]
      : []

  return render([
    'kicad_pcb',
    ...header(BOARD_VERSION),
    ['general', ['thickness', '1.6'], ['legacy_teardrops', 'no']],
    ['paper', q('A4')],
    [
      'layers',
      ['0', q('F.Cu'), 'signal'],
      ...inner,
      ['2', q('B.Cu'), 'signal'],
      ['9', q('F.Adhes'), 'user', q('F.Adhesive')],
      ['11', q('B.Adhes'), 'user', q('B.Adhesive')],
      ['13', q('F.Paste'), 'user'],
      ['15', q('B.Paste'), 'user'],
      ['5', q('F.SilkS'), 'user', q('F.Silkscreen')],
      ['7', q('B.SilkS'), 'user', q('B.Silkscreen')],
      ['1', q('F.Mask'), 'user'],
      ['3', q('B.Mask'), 'user'],
      ['17', q('Dwgs.User'), 'user', q('User.Drawings')],
      ['19', q('Cmts.User'), 'user', q('User.Comments')],
      ['25', q('Edge.Cuts'), 'user'],
      ['27', q('Margin'), 'user'],
      ['31', q('F.CrtYd'), 'user', q('F.Courtyard')],
      ['29', q('B.CrtYd'), 'user', q('B.Courtyard')],
      ['35', q('F.Fab'), 'user'],
      ['33', q('B.Fab'), 'user']
    ],
    ['setup', ['pad_to_mask_clearance', '0']]
  ])
}

/** A blank symbol library — an empty `kicad_symbol_lib` with no symbols. */
export const symbolLibraryTemplate = (): string =>
  render(['kicad_symbol_lib', ...header(SYMBOL_LIB_VERSION)])

/** A blank footprint. Lives inside a `.pretty` directory, named by its file. */
export const footprintTemplate = (name: string): string =>
  render([
    'footprint',
    q(name),
    ...header(FOOTPRINT_VERSION),
    ['layer', q('F.Cu')],
    ['attr', 'through_hole']
  ])

/**
 * A blank KiCad project file. Deliberately a *minimal valid v3 subset* rather
 * than the full default KiCad writes: the omitted keys are defaults KiCad
 * refills on first open, and every value we do not model is a value that would
 * drift. Grows as P0.4 gives us a real design-rules model to serialize.
 */
export const projectTemplate = (name: string, rootUuid: string): string =>
  `${JSON.stringify(
    {
      board: { design_settings: {}, layer_presets: [], viewports: [] },
      boards: [],
      libraries: { pinned_footprint_libs: [], pinned_symbol_libs: [] },
      meta: { filename: `${name}.kicad_pro`, version: PROJECT_SCHEMA_VERSION },
      net_settings: {
        classes: [
          {
            bus_width: 12,
            clearance: 0.2,
            diff_pair_gap: 0.25,
            diff_pair_width: 0.2,
            line_style: 0,
            microvia_diameter: 0.3,
            microvia_drill: 0.1,
            name: 'Default',
            pcb_color: 'rgba(0, 0, 0, 0.000)',
            schematic_color: 'rgba(0, 0, 0, 0.000)',
            track_width: 0.2,
            via_diameter: 0.6,
            via_drill: 0.3,
            wire_width: 6
          }
        ],
        meta: { version: 3 }
      },
      pcbnew: { page_layout_descr_file: '' },
      schematic: { legacy_lib_dir: '', legacy_lib_list: [] },
      // KiCad keys the root sheet by the schematic's own uuid, not its filename.
      sheets: [[rootUuid, 'Root']],
      text_variables: {}
    },
    null,
    2
  )}\n`
