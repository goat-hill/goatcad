/**
 * The MCP integration shapes that cross the process bridge.
 *
 * Two notes.
 *
 * **The token crosses, on purpose.** Settings shows it, for a harness this app
 * has no card for: the two client texts embed it, but a third client needs
 * the URL and the credential as they are. It is a loopback secret held by the
 * user's own app, shown in the user's own Settings.
 *
 * **A client has no connection state.** An agent tab opened inside GoatCAD is
 * told about the server when it launches, so there is nothing registered to
 * report on. What a client carries is its manual path: the line a person uses
 * in a terminal of their own, and the file it lands in.
 */

import type { Board3DViewState } from './board3dTypes'
import type { BomFormat, DrillFormat, FabOutput, GerberFormat, PositionFormat } from './fabTypes'
import type {
  BoardCreateKind,
  BoardItemKind,
  FootprintItemKind,
  SymbolItemKind
} from '../shared/itemRecords'
export type McpClientId = 'claude-code' | 'codex'

export interface McpClientInfo {
  id: McpClientId
  /** A product name — a proper noun, so not translated. */
  name: string
  /** Whether the manual path is a shell command or a config-file snippet. */
  manual: 'command' | 'snippet'
  /** The text to copy. Null while the server is not running, since there
   *  would be nothing to point at. */
  manualText: string | null
  /** The file the manual path ends up in. Shown, never written by us. */
  configPath: string
}

export interface McpServerStatus {
  running: boolean
  port: number | null
  url: string | null
  clients: McpClientInfo[]
  /** The bearer token itself, for a client with no card here. Null while the
   *  server is not running. */
  token: string | null
  /** The stored token could not be read at launch and a fresh one replaced
   *  it, so every manual registration needs redoing (`mcpToken.ts`). */
  tokenReset: boolean
}

/**
 * The server's surface in full, for Settings to show what each tool and
 * prompt takes (`mcp:surface`). Read from the registries, each fact once:
 * a tool's summary is not repeated in its guidance, nor an argument's
 * description anywhere but on the argument.
 */
export interface McpSurface {
  prompts: McpPromptInfo[]
  tools: McpToolInfo[]
}

export interface McpPromptInfo {
  /** As a person types it in Claude Code, e.g. `/mcp__goatcad__init`. */
  command: string
  description: string
  arguments: Array<{ name: string; description: string; required: boolean }>
}

export interface McpToolInfo {
  /** The registry's `domain.verb`, also the `/v1/ops/` path. */
  name: string
  /** The MCP tool name a client calls. */
  mcpName: string
  /** The `domain` of `name`, which the list groups by. */
  domain: string
  summary: string
  guidance?: string
  scope: string
  mutates: boolean
  arguments: McpArgumentInfo[]
  examples: Array<{ args: Record<string, unknown>; note: string }>
}

export interface McpArgumentInfo {
  name: string
  /** `string`, `integer`, `string[]`, `object[]`, … */
  type: string
  required: boolean
  description?: string
  /** An enum's values. */
  values?: string[]
  /** Bounds: a number's value, a string's length, an array's items. */
  min?: number
  max?: number
  /** An object's fields, or those of an array's objects. */
  fields?: McpArgumentInfo[]
}

export interface McpActionResult {
  ok: boolean
  detail?: string
}

// --- The design bridge ------------------------------------------------------
//
// A write tool cannot act in main. The KiCad AST layer, the open buffer and the
// undo stack all live in the renderer, and main holds only lite parsers — so a
// tool that edited a `.kicad_sch` on disk would need a second implementation of
// the round-trip invariant, would clobber (or be clobbered by) an unsaved
// buffer, and would have no undo. Instead main *asks the window*: the edit lands
// in the open editor as an undoable command, dirty and visible, which is why no
// separate confirmation protocol is needed — the undo stack IS the consent.

/** A request that may move an agent viewport (`viewport.open`) on its document. */
interface McpInViewport {
  /** The viewport whose box moves to frame what the call drew or changed. */
  viewport?: string
  /** What the call is doing; the viewport's box shows it as its label. */
  action?: string
}

/** Read the active (or a named) schematic sheet back. */
export interface McpDescribeRequest {
  kind: 'describe-schematic'
  /** Absolute path, or a bare file name to resolve within the project. Omitted
   *  means whichever sheet is in front of the user. */
  sheet?: string
  /** Answer with only what changed after this revision, plus the ids that went
   *  away (`docs/agent-api.md`). The revision comes from an
   *  earlier answer; one the window no longer remembers gets the whole sheet
   *  and a note saying so, never a silently short list. */
  since?: number
}

/** Place one symbol, annotated and optionally bound to a part. */
export interface McpPlaceRequest extends McpInViewport {
  kind: 'place-symbol'
  /** Run the checks before and after, and answer with what the edit broke or fixed (and, on a board, the unrouted count). Off by default, so a write costs only its edit. */
  checks?: boolean
  libId: string
  sheet?: string
  /** Millimetres in KiCad sheet space. The caller's, always: layout is the
   *  agent's design work, and the window refuses an origin that leaves a pin
   *  off the wiring grid rather than picking a spot itself. */
  at: { x: number; y: number }
  /** When set, `at` is where THIS pin lands and the origin is computed —
   *  a passive placed by its pin end onto the point it serves. */
  pin?: string
  angle?: number
  unit?: number
  /** Overrides annotate-on-place. Rejected when already taken. */
  reference?: string
  value?: string
  /** The part-identity fields, exactly as `parts-sourcing-workstream.md`
   *  names them — plain KiCad properties, which is what makes the fab BOM work
   *  the moment they exist. */
  properties?: Record<string, string>
}

/** Write part-identity fields onto an already-placed symbol. */
export interface McpBindRequest {
  kind: 'bind-part'
  /** Run the checks before and after, and answer with what the edit broke or fixed (and, on a board, the unrouted count). Off by default, so a write costs only its edit. */
  checks?: boolean
  reference: string
  sheet?: string
  value?: string
  properties: Record<string, string>
}

/** Draw a symbol for a part no library has, into the project's own library. */
export interface McpCreateSymbolRequest {
  kind: 'create-symbol'
  name: string
  library?: string
  /** Functional cohesion keys. `role` places them, `side` overrides where; `id`
   *  is never parsed. */
  groups?: {
    id: string
    role: 'power' | 'ground' | 'signal'
    side?: 'left' | 'right' | 'top' | 'bottom'
  }[]
  /** With neither pins nor groups, the symbol is blank: fields only. */
  pins?: {
    number: string
    name: string
    type: string
    group: string
    stackWith?: string
    omit?: boolean
  }[]
  /** A blank symbol's power port kind. */
  power?: 'global' | 'local'
  reference?: string
  value?: string
  description?: string
  keywords?: string
  datasheet?: string
  properties?: Record<string, string>
  overwrite?: boolean
}

/**
 * Join pins to a net by label.
 *
 * Labels, never wires (`docs/agent-api.md`): a net label at
 * each pin is netlist-correct and ERC-clean, where a route a blind model
 * invented would cross whatever is already drawn.
 */
export interface McpConnectRequest extends McpInViewport {
  kind: 'connect-pins'
  /** Run the checks before and after, and answer with what the edit broke or fixed (and, on a board, the unrouted count). Off by default, so a write costs only its edit. */
  checks?: boolean
  sheet?: string
  /** An existing net name, or a new one. A typo makes a second net rather than
   *  joining one, which is why `merge` exists. */
  net: string
  /** Pin ids from describe: `R1.2`, or `U3.VDD` where the name is unambiguous. */
  pins: string[]
  /** Required to join two nets that are both already named. A silent merge is
   *  the one schematic error nobody can see. */
  merge?: boolean
  /** Which label to write. A global label names the net across every sheet
   *  and is the net a power symbol of that name joins; a local one is scoped
   *  to this sheet. */
  labelKind?: 'local' | 'global'
}

/** Draw a wire between two pins or points, straight or with one bend, with
 *  the junction dots KiCad's rules require. */
export interface McpWireRequest extends McpInViewport {
  kind: 'draw-wire'
  /** Run the checks before and after, and answer with what the edit broke or fixed (and, on a board, the unrouted count). Off by default, so a write costs only its edit. */
  checks?: boolean
  sheet?: string
  start: { pin?: string; x?: number; y?: number }
  end: { pin?: string; x?: number; y?: number }
  /** Which leg comes first when a bend is needed. Chosen from the pins' free
   *  sides when omitted. */
  posture?: 'hv' | 'vh'
  /** Draw even though the run joins two nets that are both already named. */
  merge?: boolean
  /** Draw a bus rather than a wire: its ends are points or sheet pins. */
  bus?: boolean
}

/** Run the electrical checks and report what they find. */
export interface McpCheckRequest {
  kind: 'check-schematic'
  sheet?: string
  /** Only findings with these codes; an unknown code is refused (`unknown-check-code`). */
  codes?: string[]
  /** Answer with what changed since the check that answered at this revision. */
  since?: number
}

/**
 * Several sheet edits as one transaction.
 *
 * `docs/agent-api.md`. The window takes one snapshot, runs
 * them in order, and either records a single undo step or restores the snapshot
 * and records nothing — a partially applied batch is not a state it can be in,
 * because `CommandHistory` stores whole documents rather than inverse commands.
 */
export interface McpBatchRequest extends McpInViewport {
  kind: 'batch'
  /** Run the checks before and after, and answer with what the edit broke or fixed (and, on a board, the unrouted count). Off by default, so a write costs only its edit. */
  checks?: boolean
  /** One batch, one sheet: the snapshot that makes it atomic is that sheet's
   *  document, so a sub-request naming a different one has nowhere to land. */
  sheet?: string
  ops: McpDesignRequest[]
  /** Each entry's dotted op name, for a failure's detail. */
  names?: string[]
  /** Answer with what the batch would do, then discard it. */
  dryRun?: boolean
}

/**
 * A picture of the sheet, for a model that otherwise cannot see it.
 *
 * `docs/agent-api.md`. Captured off the mounted editor's
 * own canvas, so it needs no second renderer; the view is fitted, captured and
 * restored in one step, so the user's pan and zoom are untouched.
 */
export interface McpRenderRequest extends McpInViewport {
  kind: 'render-sheet'
  sheet?: string
  /** Frame these references with a margin. Omitted with `box` means the whole
   *  drawing. */
  symbols?: string[]
  /** Frame this rectangle, millimetres in sheet space. Wins over `symbols`. */
  box?: { x: number; y: number; width: number; height: number }
  /** Cap on the longer edge of the PNG, in pixels. */
  maxPixels: number
  /** `svg` writes the drawing as vector instead of a PNG; defaults to `png`. */
  format?: 'png' | 'svg'
  /** SVG only: paint the editor's background behind the drawing (default true). */
  background?: boolean
}

/**
 * Which symbol definition a request reads: a library id ("Nickname:Name"), or
 * a placed symbol's reference, whose definition is the sheet's own copy
 * (`lib_symbols`, `lib/designCopy.ts`) — on `sheet`, else the sheet in front.
 */
export interface McpSymbolTarget {
  symbol: string
  sheet?: string
}

/**
 * Which footprint a request acts on: a library id ("Nickname:Name"), or with
 * `board` a placed footprint's reference, whose definition is the board's own
 * copy (`lib/board/footprintCopy.ts`).
 */
export interface McpFootprintTarget {
  footprint: string
  board?: string
}

/** A picture of one symbol definition, drawn alone. */
export interface McpRenderSymbolRequest extends McpSymbolTarget {
  kind: 'render-symbol'
  maxPixels: number
  unit?: number
  /** Body style; 1, the standard drawing, when absent. */
  style?: number
}

/** A key `get-symbol` answers besides the symbol's identity. */
export type McpSymbolColumn =
  | 'description'
  | 'isPower'
  | 'units'
  | 'unit'
  | 'styles'
  | 'style'
  | 'box'
  | 'pins'
  | 'fields'
  | 'footprintFilters'

/** One library symbol's geometry before placing: pins relative to the origin,
 *  body box, fields, footprint filters. */
export interface McpGetSymbolRequest extends McpSymbolTarget {
  kind: 'get-symbol'
  unit?: number
  /** Body style; 1, the standard drawing, when absent. */
  style?: number
  /** The keys to answer besides the identity; every key when absent. */
  columns?: McpSymbolColumn[]
}

/** One library footprint's pads, courtyard and models, from the parsed file. */
export interface McpGetFootprintRequest extends McpFootprintTarget {
  kind: 'get-footprint'
  /** Pads past this are counted rather than listed. */
  maxPads: number
  /** `full` adds the graphics and texts as item records. */
  detail?: 'pads' | 'full'
  /** Decode each model and answer where it lands (bounds, fit, mesh counts). */
  modelFit?: boolean
}

/** A pad as a footprint write takes it and `get-footprint` answers it:
 *  millimeters in the footprint's frame, y down. */
export interface McpFootprintPad {
  number: string
  type: 'smd' | 'thru_hole' | 'np_thru_hole'
  shape: 'rect' | 'roundrect' | 'circle' | 'oval'
  at: { x: number; y: number; angle?: number }
  size: { width: number; height: number }
  drill?: {
    diameter: number
    oval?: { width: number; height: number }
    offset?: { x: number; y: number }
  }
  layers?: string[]
  /** A row of identical pads. */
  array?: { count: number; dx: number; dy: number; numberStep?: number }
}

/** The project's say over a generated footprint, read from `board-intent.md`
 *  in main and echoed in the answer. */
export interface McpFootprintStyle {
  density: 'least' | 'nominal' | 'most'
  pin1Marker: 'chevron' | 'dot' | 'line'
  source: 'board-intent' | 'default'
}

/** Draw a footprint for a part no library has, into the project's own
 *  `.pretty`. */
export interface McpCreateFootprintRequest {
  kind: 'create-footprint'
  name: string
  library?: string
  attributes: 'smd' | 'tht'
  description?: string
  tags?: string
  datasheet?: string
  courtyard?: 'default' | 'connector' | 'bga' | 'crystal'
  pads: McpFootprintPad[]
  body:
    | { rect: { x: number; y: number; width: number; height: number } }
    | { polygon: Array<{ x: number; y: number }> }
  pin1?: string
  /** A symbol lib id to cross-check pad numbers against its pin numbers. */
  symbol?: string
  overwrite?: boolean
  style: McpFootprintStyle
  maxPads: number
}

/** Remove a footprint from the project's own `.pretty`. */
export interface McpDeleteFootprintRequest {
  kind: 'delete-footprint'
  /** A project library id "Nickname:Name". */
  footprint: string
}

/** A footprint's item kinds (`shared/itemRecords.ts`). */
export type McpFootprintItemKind = FootprintItemKind

/**
 * The item layer on a footprint document. `footprint` is a lib id; reads reach
 * any tier, writes only the project's own library, through the footprint
 * editor's session.
 */
export interface McpGetFootprintItemsRequest extends McpFootprintTarget {
  kind: 'get-footprint-items'
  ids: string[]
  /** Decode the model and answer where it lands (bounds, fit, mesh counts). */
  modelFit?: boolean
}

export interface McpQueryFootprintItemsRequest extends McpFootprintTarget {
  kind: 'query-footprint-items'
  /** Decode the model and answer where it lands (bounds, fit, mesh counts). */
  modelFit?: boolean
  itemKind?: McpFootprintItemKind
  layer?: string
  number?: string
  box?: { x: number; y: number; width: number; height: number }
  near?: { x: number; y: number }
  radius?: number
  limit?: number
  /** Matches to skip before the first row: the next page. */
  offset?: number
}

export interface McpUpdateFootprintItemRequest extends McpFootprintTarget {
  kind: 'update-footprint-item'
  /** Run the checks before and after, and answer with what the edit broke or fixed (and, on a board, the unrouted count). Off by default, so a write costs only its edit. */
  checks?: boolean
  id: string
  /** A partial record, in the shape `get-footprint-items` answers. */
  record: Record<string, unknown>
}

export interface McpDeleteFootprintItemsRequest extends McpFootprintTarget {
  kind: 'delete-footprint-items'
  /** Run the checks before and after, and answer with what the edit broke or fixed (and, on a board, the unrouted count). Off by default, so a write costs only its edit. */
  checks?: boolean
  ids: string[]
}

export interface McpCreateFootprintItemRequest extends McpFootprintTarget {
  kind: 'create-footprint-item'
  /** Run the checks before and after, and answer with what the edit broke or fixed (and, on a board, the unrouted count). Off by default, so a write costs only its edit. */
  checks?: boolean
  itemKind: McpFootprintItemKind
  record: Record<string, unknown>
}

/** The footprint checks over one footprint, grouped by rule. */
export interface McpCheckFootprintRequest extends McpFootprintTarget {
  kind: 'check-footprint'
  /** Only findings with these codes; an unknown code is refused (`unknown-check-code`). */
  codes?: string[]
}

/** The symbol checks over one symbol definition, grouped by rule. */
export interface McpCheckSymbolRequest extends McpSymbolTarget {
  kind: 'check-symbol'
  /** Only findings with these codes; an unknown code is refused (`unknown-check-code`). */
  codes?: string[]
}

/** The board's design rule checks (DRC), grouped by rule. */
export interface McpCheckBoardRequest {
  kind: 'check-board'
  /** Absolute path or bare file name; omitted means the project's one board. */
  board?: string
  /** Answer with what changed since the check that answered at this revision. */
  since?: number
  /** Only findings with these codes; an unknown code is refused (`unknown-check-code`). */
  codes?: string[]
}

/** The limits the rules set on one board item or between two, and what set each. */
export interface McpExplainBoardLimitsRequest {
  kind: 'explain-board-limits'
  /** Absolute path or bare file name; omitted means the project's one board. */
  board?: string
  /** One or two item ids, as `items.get` takes them. */
  items: string[]
  /** Only this copper layer. */
  layer?: string
}

/** A symbol definition's item kinds (`shared/itemRecords.ts`). */
export type McpSymbolItemKind = SymbolItemKind

/**
 * The item layer on one symbol definition: a library symbol (reads any tier,
 * writes the project's own library), or a placed symbol's copy on its sheet,
 * written through the design-copy session Edit symbol… opens.
 */
export interface McpGetSymbolItemsRequest extends McpSymbolTarget {
  kind: 'get-symbol-items'
  ids: string[]
}

export interface McpQuerySymbolItemsRequest extends McpSymbolTarget {
  kind: 'query-symbol-items'
  itemKind?: McpSymbolItemKind
  unit?: number
  number?: string
  box?: { x: number; y: number; width: number; height: number }
  near?: { x: number; y: number }
  radius?: number
  limit?: number
  /** Matches to skip before the first row: the next page. */
  offset?: number
}

export interface McpUpdateSymbolItemRequest extends McpSymbolTarget {
  kind: 'update-symbol-item'
  /** Run the checks before and after, and answer with what the edit broke or fixed. */
  checks?: boolean
  id: string
  /** A partial record, in the shape `get-symbol-items` answers. */
  record: Record<string, unknown>
}

export interface McpDeleteSymbolItemsRequest extends McpSymbolTarget {
  kind: 'delete-symbol-items'
  /** Run the checks before and after, and answer with what the edit broke or fixed. */
  checks?: boolean
  ids: string[]
}

export interface McpCreateSymbolItemRequest extends McpSymbolTarget {
  kind: 'create-symbol-item'
  /** Run the checks before and after, and answer with what the edit broke or fixed. */
  checks?: boolean
  itemKind: McpSymbolItemKind
  record: Record<string, unknown>
}

/**
 * The editors' selection transforms on a symbol's, a footprint's or a board's
 * items, by id (`items.transform`). Millimeters in the document's frame, y
 * down; main has checked that each transform carries what it needs.
 */
export interface McpItemsTransform {
  transform: 'rotate' | 'mirror' | 'flip' | 'move' | 'duplicate' | 'anchor'
  /** The items acted on; empty for `anchor`, which moves every item. */
  ids: string[]
  /** rotate: degrees, counterclockwise. */
  angle?: number
  /** mirror: "x" flips top to bottom, "y" left to right. */
  axis?: 'x' | 'y'
  /** rotate, mirror, flip: the pivot; absent, the editor's own. */
  about?: { x: number; y: number }
  /** move, duplicate: the offset. */
  by?: { x: number; y: number }
  /** anchor: the point that becomes the origin. */
  at?: { x: number; y: number }
  /** Symbol duplicate: step each copied pin's number and name on by this, from its source. */
  pinStep?: number
  /** Run the checks before and after, and answer with what the edit broke or fixed. */
  checks?: boolean
}

export interface McpTransformSymbolItemsRequest extends McpSymbolTarget, McpItemsTransform {
  kind: 'transform-symbol-items'
}

export interface McpTransformFootprintItemsRequest extends McpFootprintTarget, McpItemsTransform {
  kind: 'transform-footprint-items'
}

/** The PCB editor's selection transforms on board items, by id; never `anchor`. */
export interface McpTransformBoardItemsRequest extends McpItemsTransform, McpInViewport {
  kind: 'transform-board-items'
  board: string
}

/** Several symbol item operations as one undo step, or none. */
export interface McpBatchSymbolRequest extends McpSymbolTarget {
  kind: 'batch-symbol'
  /** Run the checks before and after, and answer with what the edit broke or fixed. */
  checks?: boolean
  ops: McpDesignRequest[]
  dryRun?: boolean
}

/** Several footprint item operations as one undo step, or none. */
export interface McpBatchFootprintRequest extends McpFootprintTarget {
  kind: 'batch-footprint'
  /** Run the checks before and after, and answer with what the edit broke or fixed (and, on a board, the unrouted count). Off by default, so a write costs only its edit. */
  checks?: boolean
  ops: McpDesignRequest[]
  dryRun?: boolean
}

/** A dimension as a package drawing prints it. */
export type McpTol = { nominal: number; tolerance?: number } | { min: number; max: number }

/** The IPC standards' pads from a package drawing (`footprint.compute_land_pattern`). Pure;
 *  the window computes it only because the footprint code lives there. */
export interface McpLandPatternRequest {
  kind: 'land-pattern'
  leadType: 'gullwing' | 'flat' | 'no_lead' | 'j_lead' | 'chip' | 'grid' | 'through_hole'
  density: 'least' | 'nominal' | 'most'
  densitySource: 'argument' | 'board-intent' | 'default'
  body: { x: McpTol; y: McpTol }
  span?: { x?: McpTol; y?: McpTol }
  lead: { width?: McpTol; length?: McpTol; thickness?: McpTol; diameter?: McpTol }
  pitch?: number
  pins?: { x?: number; y?: number }
  exposedPad?: { x: number; y: number }
  rowSpacing?: number
  numbering?: 'ccw' | 'zigzag'
  ball?: { diameter: McpTol; type?: 'collapsible' | 'non_collapsible' }
  skip?: string[]
}

/** A picture of one library footprint, drawn alone. */
export interface McpRenderFootprintRequest extends McpFootprintTarget {
  kind: 'render-footprint'
  maxPixels: number
  /** `layers` (the default) is the editor's 2D drawing; `model` is the part on
   *  a one-part board in four fixed views. */
  view?: 'layers' | 'model'
}

/** A picture of one 3D model, drawn alone in four fixed views. */
export interface McpRenderModelRequest {
  kind: 'render-model'
  /** A model path as a footprint spells it, or an absolute file path. */
  path: string
  maxPixels: number
}

/** Copy a footprint into the project's own library, unchanged. */
export interface McpCopyFootprintRequest {
  kind: 'copy-footprint'
  libId: string
  /** Defaults to the source's own name. */
  name?: string
  /** `.pretty` stem; defaults to the project's own name. */
  library?: string
}

/** A library symbol copied into the project's own symbol library, as Copy to
 *  project library does, so it can be edited. */
export interface McpCopySymbolRequest {
  kind: 'copy-symbol'
  libId: string
  /** Defaults to the source's own name. */
  name?: string
  /** `.kicad_sym` stem; defaults to the project's own name. */
  library?: string
}

/**
 * Write open tabs with unsaved edits to disk.
 *
 * The one verb that crosses the
 * undo line, by the maintainer's decision: it answers with exactly what it
 * wrote, and its guidance says most edits are not the agent's to save.
 */
export interface McpSaveRequest {
  kind: 'save-files'
  /** Absolute paths or bare file names of open tabs. Omitted means every tab
   *  with unsaved edits. */
  files?: string[]
}

/** Open a project file as a tab and make it active. Any document kind. */
export interface McpOpenRequest {
  kind: 'open-file'
  /** Absolute path or bare name of a file the project tree lists. */
  file: string
  /** The `win_…` id of the window to open it in; main routes by it and drops it. */
  window?: string
}

/** Point the window at a folder and project (`workspace.update`); refused with unsaved edits. */
export interface McpSetWorkspaceRequest {
  kind: 'set-workspace'
  root: string
  project: string | null
}

/** The window's documents with unsaved edits, which main asks before it closes one for an agent. */
export interface McpUnsavedFilesRequest {
  kind: 'unsaved-files'
}

/** Close an open tab. Refused while it holds unsaved edits unless `discard`. */
export interface McpCloseRequest {
  kind: 'close-file'
  file: string
  discard?: boolean
}

/** Remove a symbol from the project's own library. */
export interface McpDeleteSymbolRequest {
  kind: 'delete-symbol'
  /** A project library id "Nickname:Name". */
  symbol: string
}

/** Full records for named items (`docs/agent-api.md`). */
export interface McpGetItemsRequest {
  kind: 'get-items'
  sheet?: string
  /** Ids as `describe` and `query-items` print them: a reference, a pin id, a
   *  `<reference>#<field>`, or a uuid. */
  ids: string[]
}

/** Items on the sheet, filtered by kind, region, proximity or net. */
export interface McpQueryItemsRequest {
  kind: 'query-items'
  sheet?: string
  itemKind?:
    | 'symbol'
    | 'field'
    | 'label'
    | 'wire'
    | 'junction'
    | 'no_connect'
    | 'text'
    | 'rect'
    | 'sheet'
    | 'sheet_pin'
    | McpSheetGraphicKind
  /** Millimetres in sheet space; items whose box touches it. */
  box?: { x: number; y: number; width: number; height: number }
  /** Around a pin id, or a point, within `radius` millimetres. */
  near?: { pin?: string; x?: number; y?: number }
  radius?: number
  net?: string
  limit?: number
  /** Matches to skip before the first row: the next page. */
  offset?: number
  /** The sheet revision the first page answered; refused (`revision-moved`) once it moved. */
  revision?: number
}

/** The sheet's graphics, buses and the rest an agent reads and writes beside its wiring. */
export type McpSheetGraphicKind =
  | 'polyline'
  | 'circle'
  | 'arc'
  | 'bezier'
  | 'text_box'
  | 'rule_area'
  | 'image'
  | 'table'
  | 'bus'
  | 'bus_entry'
  | 'directive_label'

/** A label's or sheet pin's signal shape, or a directive label's flag. */
export type McpSheetShape =
  | 'input'
  | 'output'
  | 'bidirectional'
  | 'tri_state'
  | 'passive'
  | 'round'
  | 'dot'
  | 'diamond'
  | 'rectangle'

/**
 * How a sheet item is drawn, keyed as items_get answers it. Colors are
 * "#RRGGBB" or "#RRGGBBAA"; null goes back to the default color.
 */
export interface McpSheetStyle {
  /** Stroke width in millimetres; 0 is the default pen. */
  width?: number
  strokeType?: 'default' | 'solid' | 'dash' | 'dot' | 'dash_dot' | 'dash_dot_dot'
  strokeColor?: string | null
  fill?: 'none' | 'outline' | 'background' | 'color' | 'hatch' | 'reverse_hatch' | 'cross_hatch'
  fillColor?: string | null
  bold?: boolean
  italic?: boolean
  justify?: 'left' | 'center' | 'right'
  verticalJustify?: 'top' | 'center' | 'bottom'
  color?: string | null
}

/** Where a sheet graphic, bus entry, table or directive label lies, in sheet millimetres. */
export interface McpSheetGeometry {
  /** Rectangles and text boxes: the outline. */
  box?: { x: number; y: number; width: number; height: number }
  /** Polylines, beziers (four: start, two controls, end) and rule areas. */
  points?: Array<{ x: number; y: number }>
  center?: { x: number; y: number }
  radius?: number
  /** Arcs: start, a point along the way, end. A bus entry's end is its wire side. */
  start?: { x: number; y: number }
  mid?: { x: number; y: number }
  end?: { x: number; y: number }
  /** Images: times the size the picture's own resolution gives. */
  scale?: number
  /** Tables: the cell texts, row by row. */
  cells?: string[][]
  borderExternal?: boolean
  borderHeader?: boolean
  borderWidth?: number
  separatorRows?: boolean
  separatorCols?: boolean
  separatorWidth?: number
  /** Directive labels: the Netclass field. */
  netClass?: string
  /** Directive labels: the pole's length. */
  length?: number
}

/**
 * Write a partial record back onto one item (`docs/agent-api.md`).
 * Which keys apply depends on the kind; one that does not is refused
 * rather than ignored. A symbol move carries the labels and no-connects on its
 * pins.
 */
export interface McpUpdateItemRequest extends McpInViewport, McpSheetStyle, McpSheetGeometry {
  kind: 'update-item'
  /** Run the checks before and after, and answer with what the edit broke or fixed (and, on a board, the unrouted count). Off by default, so a write costs only its edit. */
  checks?: boolean
  sheet?: string
  id: string
  /** Sheet millimetres: a symbol's origin, a label's or text's anchor, a
   *  field's anchor, a junction or flag's point, a wire's first point. */
  at?: { x: number; y: number }
  angle?: number
  /** Symbols only. `'none'` clears it. */
  mirror?: 'x' | 'y' | 'none'
  dnp?: boolean
  inBom?: boolean
  onBoard?: boolean
  /** Labels and texts: the content. */
  text?: string
  /** Symbols: the Value field. Fields: the value. */
  value?: string
  /** Sheet pins: the signal name. */
  name?: string
  /** Fields only. */
  hidden?: boolean
  /** Symbols and directive labels: field values by name. */
  fields?: Record<string, string>
  /** Symbols and sheets: whether the wires on the moved pins follow the move
   *  (the default) or stay behind. */
  wires?: 'follow' | 'leave'
  /** Sheet pins and global or hierarchical labels: what the signal does;
   *  directive labels: the flag. */
  shape?: McpSheetShape
  /** Sheet pins only: which edge it sits on. */
  side?: 'left' | 'right' | 'top' | 'bottom'
  /** Sheets: the box's size in sheet millimetres, from its top-left corner.
   *  Labels, texts and text boxes: the glyph height. */
  size?: { width: number; height: number } | number
}

export interface McpDeleteItemsRequest extends McpInViewport {
  kind: 'delete-items'
  /** Run the checks before and after, and answer with what the edit broke or fixed (and, on a board, the unrouted count). Off by default, so a write costs only its edit. */
  checks?: boolean
  sheet?: string
  ids: string[]
}

/** Add a label, a text, a flag, a junction, a graphic, a bus entry, a table or an image. */
export interface McpCreateItemRequest extends McpInViewport, McpSheetStyle, McpSheetGeometry {
  kind: 'create-item'
  /** Run the checks before and after, and answer with what the edit broke or fixed (and, on a board, the unrouted count). Off by default, so a write costs only its edit. */
  checks?: boolean
  sheet?: string
  itemKind:
    | 'label'
    | 'text'
    | 'no_connect'
    | 'junction'
    | 'rect'
    | 'sheet_pin'
    | Exclude<McpSheetGraphicKind, 'bus'>
  text?: string
  labelKind?: 'local' | 'global' | 'hierarchical'
  /** Put it on this pin, at the pin's free side. Labels, flags and directive labels. */
  pin?: string
  at?: { x: number; y: number }
  angle?: number
  /** Labels, texts and text boxes: glyph height in millimetres (1.27 when omitted). */
  size?: number
  /** Sheet pins: which sheet on this page carries it, by item id. */
  ofSheet?: string
  /** Sheet pins: the name, which must match a hierarchical label in the child. */
  name?: string
  /** Sheet pins, and global/hierarchical labels: what the signal does here;
   *  directive labels: the flag. */
  shape?: McpSheetShape
  /** Sheet pins: which edge to put it on. `at` overrides with a point. */
  side?: 'left' | 'right' | 'top' | 'bottom'
  /** Images: the picture file, absolute or relative to the sheet. */
  path?: string
  /** Tables: each column's width and each row's height, in millimetres. */
  columnWidths?: number[]
  rowHeights?: number[]
}

/** Draw a hierarchical sheet on this page and create the file behind it. */
export interface McpAddSheetRequest extends McpInViewport {
  kind: 'add-sheet'
  /** Run the checks before and after, and answer with what the edit broke or fixed (and, on a board, the unrouted count). Off by default, so a write costs only its edit. */
  checks?: boolean
  sheet?: string
  name: string
  file?: string
  at?: { x: number; y: number }
  size?: { width: number; height: number }
  pins?: Array<{
    name: string
    shape?: 'input' | 'output' | 'bidirectional' | 'tri_state' | 'passive'
    side?: 'left' | 'right' | 'top' | 'bottom'
  }>
}

/** Set the page a sheet is drawn on. */
/** Tidy a sheet's wires and junction dots (`lib/schematic/wireCleanup.ts`). */
export interface McpCleanupRequest {
  kind: 'cleanup-schematic'
  /** Run the checks before and after, and answer with what the edit broke or fixed (and, on a board, the unrouted count). Off by default, so a write costs only its edit. */
  checks?: boolean
  sheet?: string
}

export interface McpSetPaperRequest {
  kind: 'set-paper'
  /** Run the checks before and after, and answer with what the edit broke or fixed (and, on a board, the unrouted count). Off by default, so a write costs only its edit. */
  checks?: boolean
  sheet?: string
  size: string
  portrait?: boolean
  width?: number
  height?: number
}

/** Renumber designators (`schematic.annotate`): KiCad's Annotate Schematic. */
export interface McpAnnotateRequest {
  kind: 'annotate-schematic'
  /** Run the checks before and after, and answer with what the edit broke or fixed (and, on a board, the unrouted count). Off by default, so a write costs only its edit. */
  checks?: boolean
  sheet?: string
  scope: 'design' | 'sheet'
  recurse: boolean
  /** References to confine the run to on the sheet — KiCad's selection scope. */
  symbols?: string[]
  order: 'xy' | 'yx'
  numbering: 'sequential' | 'sheet100' | 'sheet1000'
  start: number
  reset: boolean
  dryRun: boolean
}

/** A condition on one BOM column; a list of them must all hold. */
export interface McpBomFilter {
  field: string
  match: 'equals' | 'notEquals' | 'contains' | 'matches' | 'empty' | 'notEmpty'
  value?: string | undefined
}

/** The design's parts as a table (`bom.get`): every sheet, power symbols left out. */
export interface McpGetBomRequest {
  kind: 'get-bom'
  /** Any sheet of the project, only to say which project. */
  sheet?: string
  /** Columns after Reference; generated names with or without `${}`. */
  fields?: string[]
  groupBy?: string[]
  where?: McpBomFilter[]
  sortBy?: string
  limit?: number
}

/** Field values and placement flags onto many parts at once (`bom.update`),
 *  across every sheet, as one undoable step. */
export interface McpUpdateBomRequest {
  kind: 'update-bom'
  sheet?: string
  /** The parts by reference, or… */
  references?: string[]
  /** …the parts every condition holds for, with `expect` beside it. */
  where?: McpBomFilter[]
  /** How many parts the target must match, or nothing is written. */
  expect?: number
  fields?: Record<string, string>
  dnp?: boolean
  inBom?: boolean
  onBoard?: boolean
  dryRun: boolean
}

/**
 * Placed symbols redrawn from a library (`schematic.update_symbols`,
 * `lib/schematic/symbolUpdate.ts`), across every sheet: each from its own lib
 * id, or, with `symbol`, changed to that one.
 */
export interface McpUpdateSymbolsSchematicRequest {
  kind: 'update-symbols-schematic'
  /** Run the checks before and after, and answer with what the edit broke or fixed. Off by default, so a write costs only its edit. */
  checks?: boolean
  sheet?: string
  /** The parts by reference, every unit of each; absent, every symbol `match` names, else every symbol. */
  references?: string[]
  /** Every symbol with this lib id. */
  match?: string
  /** Change to this lib id instead of updating from each one's own. */
  symbol?: string
  /** What to take fresh from the library; absent keys take the verb's defaults (`UPDATE_DEFAULTS`, `CHANGE_DEFAULTS`). */
  options?: {
    updateReference?: boolean
    updateValue?: boolean
    resetFieldText?: boolean
    resetEmptyFields?: boolean
    removeExtraFields?: boolean
    resetFieldVisibility?: boolean
    resetFieldEffects?: boolean
    resetFieldPositions?: boolean
    resetAttributes?: boolean
    resetPinTextVisibility?: boolean
    resetAlternatePins?: boolean
    resetCustomPower?: boolean
    fields?: string[]
  }
  dryRun?: boolean
}

/** The board read back (`board.describe`): what is on it and what is left to route. */
export interface McpDescribeBoardRequest {
  kind: 'describe-board'
  /** Absolute path or bare file name; omitted means the project's one board. */
  board?: string
  /** Answer only what moved since this revision, when the window still remembers it. */
  since?: number
  /** Nets whose routed length to answer, by name. */
  lengths?: string[]
}

/** A board's item kinds (`shared/itemRecords.ts`). */
export type McpBoardItemKind = BoardItemKind

/** The kinds an agent creates on a board (`shared/itemRecords.ts`). */
export type McpBoardCreateKind = BoardCreateKind

/**
 * The item layer on a board. `board` is an absolute path or a bare file name.
 * Writes land through the board's session, the tab opened behind the active
 * one when none holds it.
 */
export interface McpGetBoardItemsRequest {
  kind: 'get-board-items'
  board: string
  ids: string[]
}

export interface McpQueryBoardItemsRequest {
  kind: 'query-board-items'
  board: string
  itemKind?: McpBoardItemKind
  layer?: string
  net?: string
  box?: { x: number; y: number; width: number; height: number }
  near?: { x?: number; y?: number; id?: string }
  radius?: number
  limit?: number
  /** Matches to skip before the first row: the next page. */
  offset?: number
  /** The board revision the first page answered; refused (`revision-moved`) once it moved. */
  revision?: number
}

export interface McpUpdateBoardItemRequest extends McpInViewport {
  kind: 'update-board-item'
  /** Run the checks before and after, and answer with what the edit broke or fixed (and, on a board, the unrouted count). Off by default, so a write costs only its edit. */
  checks?: boolean
  board: string
  id: string
  /** A partial record, in the shape `get-board-items` answers. */
  record: Record<string, unknown>
  /** A footprint's move: whether the tracks ending on its pads follow it (the PCB editor's D drag) or stay. Default leave. */
  tracks?: 'follow' | 'leave'
}

export interface McpDeleteBoardItemsRequest extends McpInViewport {
  kind: 'delete-board-items'
  /** Run the checks before and after, and answer with what the edit broke or fixed (and, on a board, the unrouted count). Off by default, so a write costs only its edit. */
  checks?: boolean
  board: string
  /** The items by id; or, without ids, every item the filters match. */
  ids?: string[]
  itemKind?: McpBoardItemKind
  layer?: string
  net?: string
  box?: { x: number; y: number; width: number; height: number }
  /** With the filters: how many they must match, or nothing is deleted (`count-mismatch`). */
  expect?: number
}

export interface McpCreateBoardItemRequest extends McpInViewport {
  kind: 'create-board-item'
  /** Run the checks before and after, and answer with what the edit broke or fixed (and, on a board, the unrouted count). Off by default, so a write costs only its edit. */
  checks?: boolean
  board: string
  itemKind: McpBoardCreateKind
  record: Record<string, unknown>
}

/** Several board item operations as one undo step, or none. */
export interface McpBatchBoardRequest extends McpInViewport {
  kind: 'batch-board'
  /** Run the checks before and after, and answer with what the edit broke or fixed (and, on a board, the unrouted count). Off by default, so a write costs only its edit. */
  checks?: boolean
  board?: string
  ops: McpDesignRequest[]
  dryRun?: boolean
  /** Refill the zone fills the batch left stale, in the same undo step. */
  refill?: boolean
}

/** A new project in a folder (`project.create`), as the New Project dialog makes one. */
export interface McpCreateProjectRequest {
  kind: 'create-project'
  name: string
  /** Absolute path; omitted means the folder this window has open. */
  folder?: string
  /** A schematic already in the folder to make the project's root sheet. */
  adopt?: string
  /** Scaffold a new root sheet even though the folder holds others. */
  blank?: boolean
  copperLayers?: number
  profile?: string
}

/** A blank file of the active project (`project.create_file`), as New ▸ makes one. */
export interface McpCreateFileRequest {
  kind: 'create-file'
  fileKind: 'schematic' | 'board' | 'symbol_library' | 'footprint_library'
  /** The file stem; the extension comes from `fileKind`. */
  name: string
  /** The `win_…` id of the window to open it in; main routes by it and drops it. */
  window?: string
}

/** Board Setup's sections as records (`lib/board/boardSetup.ts`). */
export interface McpGetBoardSetupRequest {
  kind: 'get-board-setup'
  board?: string
  sections?: Array<
    | 'stackup'
    | 'general'
    | 'constraints'
    | 'tuningPatterns'
    | 'teardrops'
    | 'tuningProfiles'
    | 'netClasses'
    | 'severities'
    | 'profile'
    | 'exclusions'
  >
}

/** A partial Board Setup: the board half as one undo step, the project half as one write. */
export interface McpUpdateBoardSetupRequest {
  kind: 'update-board-setup'
  /** Run the checks before and after, and answer with what the edit broke or fixed (and, on a board, the unrouted count). Off by default, so a write costs only its edit. */
  checks?: boolean
  board?: string
  changes: Record<string, unknown>
  dryRun?: boolean
}

/**
 * An interface's budget as a tuning profile, a net class and its rules, for the
 * nets the patterns name (`board.apply_interface_preset`, `lib/board/interfacePresets.ts`).
 */
export interface McpApplyInterfacePresetRequest {
  kind: 'apply-interface-preset'
  board?: string
  preset: string
  mode?: string
  netClass: string
  patterns: string[]
  /** A pair's gap, or a coplanar line's gap to its ground, mm. */
  gap?: number
  /** The first solved layer's width, mm; the gap is solved for it. */
  width?: number
  layers?: string[]
  dryRun?: boolean
}

/** Schematic Setup's sections: the ERC's severities and exclusions. */
export interface McpGetSchematicSetupRequest {
  kind: 'get-schematic-setup'
  sections?: Array<'severities' | 'exclusions'>
}

export interface McpUpdateSchematicSetupRequest {
  kind: 'update-schematic-setup'
  /** Run the checks before and after, and answer with what the edit broke or fixed (and, on a board, the unrouted count). Off by default, so a write costs only its edit. */
  checks?: boolean
  changes: Record<string, unknown>
  dryRun?: boolean
}

/** Refill every zone of a board (continuing where a budget-cut refill stopped). */
export interface McpRefillBoardRequest {
  kind: 'refill-board'
  /** Run the checks before and after, and answer with what the edit broke or fixed (and, on a board, the unrouted count). Off by default, so a write costs only its edit. */
  checks?: boolean
  board?: string
}

/** Debris tracks and vias removed and straight runs merged (`board.cleanup`, `lib/board/trackCleanup.ts`). */
export interface McpCleanupBoardRequest extends McpInViewport {
  kind: 'cleanup-board'
  /** Run the checks before and after, and answer with what the edit broke or fixed (and, on a board, the unrouted count). Off by default, so a write costs only its edit. */
  checks?: boolean
  board?: string
  /** Which passes run, by `CleanupOptions` key; an absent key takes KiCad's default. */
  passes?: {
    shorts?: boolean
    redundantVias?: boolean
    danglingVias?: boolean
    mergeTracks?: boolean
    danglingTracks?: boolean
    tracksInPads?: boolean
  }
  /** Only copper on these nets, by name. */
  nets?: string[]
  /** Only copper on these copper layers. */
  layers?: string[]
  /** Only these tracks and vias, by item id. */
  items?: string[]
  dryRun?: boolean
}

/** Teardrops added, set or removed on the pads and vias, then all rebuilt (`board.set_teardrops`, `lib/board/teardrop/edit.ts`). */
export interface McpSetTeardropsBoardRequest extends McpInViewport {
  kind: 'set-teardrops-board'
  /** Run the checks before and after, and answer with what the edit broke or fixed (and, on a board, the unrouted count). Off by default, so a write costs only its edit. */
  checks?: boolean
  board?: string
  mode: 'add' | 'set' | 'remove' | 'removeAll'
  /** What gets teardrops; absent, the project's last. */
  targets?: Array<'vias' | 'pthPads' | 'smdPads' | 'trackToTrack'>
  /** For `set`: lengths in mm, ratios as fractions. */
  values?: {
    bestLengthRatio?: number
    maxLength?: number
    bestWidthRatio?: number
    maxWidth?: number
    curvedEdges?: boolean
    filterRatio?: number
    allowTwoSegments?: boolean
    preferZoneConnections?: boolean
  }
  /** Only pads and vias on these nets, by name. */
  nets?: string[]
  /** Only pads and vias on these copper layers. */
  layers?: string[]
  /** Only these pads and vias, by item id. */
  items?: string[]
  roundOnly?: boolean
  existingOnly?: boolean
  dryRun?: boolean
}

/** Every tuning pattern laid again to the rules as they are (`board.update_tuning_patterns`, `lib/board/patternRetune.ts`). */
export interface McpUpdateTuningPatternsBoardRequest extends McpInViewport {
  kind: 'update-tuning-patterns-board'
  /** Run the checks before and after, and answer with what the edit broke or fixed (and, on a board, the unrouted count). Off by default, so a write costs only its edit. */
  checks?: boolean
  board?: string
  dryRun?: boolean
}

/** A footprint's pads taken to vias (`board.fanout`, `lib/board/fanout.ts`). */
export interface McpFanoutBoardRequest extends McpInViewport {
  kind: 'fanout-board'
  /** Run the checks before and after, and answer with what the edit broke or fixed (and, on a board, the unrouted count). Off by default, so a write costs only its edit. */
  checks?: boolean
  board?: string
  footprint: string
  pads?: string[]
  nets?: string[]
  style?: 'auto' | 'dogbone' | 'under-pads' | 'inline' | 'staggered'
  direction?: 'out' | 'in' | 'ne' | 'se' | 'sw' | 'nw'
  surfaceRows?: number
  via?: { size?: number; drill?: number }
  dryRun?: boolean
}

/**
 * One step of an agent's route, as the route tool's hotkeys and mouse give it
 * (`route.step`, `lib/board/routeAgent.ts`). A gesture holds one action;
 * `to`/`at` may stand with `click`.
 */
export interface McpRouteGesture {
  /** Move the cursor onto an item by id. */
  to?: string
  /** Move the cursor to a point, board mm, y down. */
  at?: { x: number; y: number }
  click?: boolean
  via?: { type?: 'through' | 'blind' | 'micro'; to?: string }
  /** A copper layer by name, or `next` / `prev`. */
  layer?: string
  posture?: 'flip'
  corner?: '45' | 'arc45' | '90' | 'arc90'
  mode?: 'shove' | 'walkaround' | 'highlight'
  /** mm. */
  width?: number
  widthRow?: number
  /** mm. */
  viaSize?: { size: number; drill: number }
  viaRow?: number
  undo?: boolean
  finish?: 'attempt' | 'here'
  commit?: boolean
  cancel?: boolean
}

/** How a routing session's pictures draw the board: the editor's own display options. */
export interface McpRouteView {
  layers?: string[]
  /** The editor's inactive-layer mode. */
  otherLayers?: 'show' | 'dim' | 'hide'
  side?: 'front' | 'back'
  /** A rectangle, board mm, y down. */
  frame?: { x: number; y: number; width: number; height: number }
  /** A square this many mm across, centered on the head; wins when `frame` is absent. */
  follow?: number
  ratsnest?: boolean
  /** Dim everything but the routed net, as the editor does while routing. */
  highlight?: boolean
}

/**
 * The router switches an agent's session may override (`PcbRouterSettings`), its
 * mode and corners, and *Use starting track width*, the project's (`.kicad_prl`).
 */
export interface McpRouteSettings {
  mode?: 'shove' | 'walkaround' | 'highlight'
  corner?: '45' | 'arc45' | '90' | 'arc90'
  shoveVias?: boolean
  jumpOverObstacles?: boolean
  removeLoops?: boolean
  smartPads?: boolean
  autoPosture?: boolean
  startDiagonal?: boolean
  fixAllSegments?: boolean
  allowViolations?: boolean
  useConnectedWidth?: boolean
}

/**
 * A pair routed instead of a track (`route.begin`'s `pair`, router-behavior.md
 * PR1–PR6): its sizes a row of the pair list (0 the net class), or typed, mm.
 */
export interface McpRoutePair {
  row?: number
  width?: number
  gap?: number
  viaGap?: number
}

/**
 * A length or skew tune instead of a route (`route.begin`'s `tune`,
 * router-behavior.md T1–T6): the tuner, its target, mm, and its meanders.
 */
export interface McpRouteTune {
  mode: 'single' | 'pair' | 'skew'
  target?: number
  overrideRules?: boolean
  minAmplitude?: number
  maxAmplitude?: number
  spacing?: number
  cornerRadiusPercent?: number
  singleSided?: boolean
}

/** A routing session started (`route.begin`). */
export interface McpBeginRouteRequest extends McpInViewport {
  kind: 'begin-route'
  board?: string
  /** A pad, via or track by id. */
  start?: string
  /** A point, board mm, y down. */
  at?: { x: number; y: number }
  net?: string
  layer?: string
  width?: number
  widthRow?: number
  viaSize?: { size: number; drill: number }
  viaRow?: number
  pair?: McpRoutePair
  tune?: McpRouteTune
  settings?: McpRouteSettings
  grid?: { spacing?: number; snap?: 'copper' | 'grid' | 'none' }
  view?: McpRouteView
  render?: boolean
  maxPixels?: number
  /** The agent viewport on this board to route in; its box follows the head. */
  viewport: string
}

/** Gestures applied to a routing session in order (`route.step`). */
export interface McpStepRouteRequest {
  kind: 'step-route'
  /** What the call is doing; the session viewport's box shows it as its label. */
  action?: string
  session: string
  gestures: McpRouteGesture[]
  view?: McpRouteView
  render?: boolean
  maxPixels?: number
  /** Run the checks before and after a commit, and answer with what it broke or fixed. */
  checks?: boolean
}

/** Candidate gesture lists, each run from the session's state without changing it (`route.preview`). */
export interface McpPreviewRouteRequest {
  kind: 'preview-route'
  /** What the call is doing; the session viewport's box shows it as its label. */
  action?: string
  session: string
  candidates: McpRouteGesture[][]
  render?: boolean
  maxPixels?: number
}

/** Attempt Finish Selected from pads and vias (`route.finish`, router-behavior.md R46). */
export interface McpFinishRoutesRequest extends McpInViewport {
  kind: 'finish-routes'
  board?: string
  /** Pad, via or footprint ids; a footprint stands for its pads with a net. */
  starts: string[]
  layer?: string
  settings?: McpRouteSettings
  /** Run the checks before and after, and answer with what the landings broke or fixed. */
  checks?: boolean
}

/** A library footprint placed by hand (`board.place_footprint`, `lib/board/footprintPlace.ts`). */
export interface McpPlaceFootprintBoardRequest extends McpInViewport {
  kind: 'place-footprint-board'
  /** Run the checks before and after, and answer with what the edit broke or fixed (and, on a board, the unrouted count). Off by default, so a write costs only its edit. */
  checks?: boolean
  board?: string
  /** Lib id. */
  footprint: string
  /** mm, board coordinates (y down). */
  at: { x: number; y: number }
  angle?: number
  /** Default front. */
  side?: 'front' | 'back'
  reference?: string
  dryRun?: boolean
}

/**
 * Placed footprints rebuilt from a library (`board.update_footprints`,
 * `lib/board/footprintExchange.ts`): each from its own lib id, or, with
 * `footprint`, changed to that one.
 */
export interface McpUpdateFootprintsBoardRequest {
  kind: 'update-footprints-board'
  /** Run the checks before and after, and answer with what the edit broke or fixed (and, on a board, the unrouted count). Off by default, so a write costs only its edit. */
  checks?: boolean
  board?: string
  /** The footprints by reference; absent, every one `match` names, else every footprint. */
  references?: string[]
  /** Every footprint with this lib id. */
  match?: string
  /** Change to this lib id instead of updating from each one's own. */
  footprint?: string
  /** What to take fresh from the library; absent keys take the verb's defaults. */
  options?: {
    removeExtraTexts?: boolean
    resetTextLayers?: boolean
    resetTextEffects?: boolean
    resetTextPositions?: boolean
    resetTextContent?: boolean
    resetFabricationAttributes?: boolean
    resetClearanceOverrides?: boolean
    reset3DModels?: boolean
  }
  dryRun?: boolean
}

/** The schematic carried onto the board (`board.sync`): every part with a
 *  footprint lands, the rest are named and skipped, as KiCad's netlist
 *  import does (`docs/agent-api.md`). */
export interface McpSyncBoardRequest {
  kind: 'sync-board'
  /** Run the checks before and after, and answer with what the edit broke or fixed (and, on a board, the unrouted count). Off by default, so a write costs only its edit. */
  checks?: boolean
  board?: string
  /** Remove board footprints whose symbol is gone. Off by default, as in KiCad. */
  prune?: boolean
  /** Rebuild a footprint whose symbol names another. On by default, as in KiCad. */
  replaceFootprints?: boolean
  /** Write symbol fields, Do not populate and Exclude from BOM onto footprints. On by default, as in KiCad. */
  updateFields?: boolean
  dryRun: boolean
}

/**
 * A picture of the board (`render.board`), for a model that cannot see it.
 *
 * Drawn from the parsed board in a scene of its own, never from the editor's
 * — a picture is an audit of the document, not of the session's selection and
 * layer. Nothing is changed and no tab moves.
 */
export interface McpRenderBoardRequest extends McpInViewport {
  kind: 'render-board'
  board?: string
  /** Frame these footprints by reference, with a margin. */
  footprints?: string[]
  /** Frame this rectangle, millimetres in board space (y down). Wins over `footprints`. */
  box?: { x: number; y: number; width: number; height: number }
  /** `back` mirrors the view, as the editor's flip does. */
  side?: 'front' | 'back'
  /** Draw only these layers, by name. Exactly one of `layers` and `preset` is sent. */
  layers?: string[]
  /** A fixed layer list, expanded against the board (`lib/board/renderPresets.ts`). */
  preset?: McpRenderBoardPreset
  /** Pour zone fills; absent draws zones as outlines only. */
  fills?: boolean
  /** Drawn on top; the other layers are dimmed to `dim`. */
  activeLayer?: string
  /** 0–1, how much of a non-active layer survives; only with `activeLayer`. Absent is the canvas's dim. */
  dim?: number
  /** Cap on the longer edge of the PNG, in pixels. */
  maxPixels: number
}

export type McpRenderBoardPreset = 'front' | 'back' | 'copper' | 'silk' | 'all'

/**
 * A 3D render of the board (`render.board_3d`): the 3D pane's scene from
 * a camera the caller names, off-screen. Nothing is changed and no tab moves.
 */
export interface McpRenderBoard3DRequest {
  kind: 'render-board-3d'
  board?: string
  view?: 'iso' | 'top' | 'bottom' | 'front' | 'back' | 'left' | 'right'
  /** Degrees; override the preset's bearing. */
  azimuth?: number
  elevation?: number
  roll?: number
  projection?: 'perspective' | 'orthographic'
  fov?: number
  /** 1 fits what is framed. */
  zoom?: number
  footprints?: string[]
  /** Millimetres in board space (y down). Wins over `footprints`. */
  box?: { x: number; y: number; width: number; height: number }
  center?: { x: number; y: number; z?: number }
  width?: number
  height?: number
  show?: Partial<Board3DViewState>
  hide?: string[]
  only?: string[]
  lighting?: 'studio' | 'soft' | 'flat' | 'dramatic'
  exposure?: number
  /** 'theme', 'transparent' or #RRGGBB. */
  background?: string
  mask?: string
  silk?: string
}

/**
 * `export.*`: one fab writer, or a profile's package, over the board's saved
 * file (fabrication-export-workstream.md, "The export ops"). Refused while the
 * board's tab holds unsaved edits or stale zone fills.
 */
export interface McpExportBoardRequest {
  kind: 'export-board'
  board?: string
  /** What to write: one writer's files, or the package a profile names. */
  output: FabOutput | 'package'
  /** The folder the files land in: absolute, or relative to the board's folder. Default `fab`. */
  directory?: string
  /** A writer's format; for a package, these replace the profile's. */
  gerber?: GerberFormat
  drill?: DrillFormat
  bom?: BomFormat
  cpl?: PositionFormat
  /** package: the built-in profile to start from (`export.profiles`); none starts from no outputs. */
  profile?: string
  /** package: the outputs zipped together, replacing the profile's. */
  archive?: FabOutput[]
  /** package: answer the pre-flight and the file list without writing. */
  dryRun?: boolean
}

/**
 * `render.gerbers`: a folder of Gerber and Excellon files drawn back as
 * the Gerber viewer composites them, off-screen. Nothing is changed.
 */
export interface McpRenderGerbersRequest {
  kind: 'render-gerbers'
  /** The board whose folder a relative `directory` is read from. */
  board?: string
  /** The folder holding the set: absolute, or relative to the board's folder. Default `fab`. */
  directory?: string
  /** Draw only these layers, by KiCad layer name or file name. */
  layers?: string[]
  /** Frame this rectangle, in the files' own millimetres (y up). */
  box?: { x: number; y: number; width: number; height: number }
  maxPixels: number
}

/** `export.profiles`: the built-in profiles, or one in full. */
export interface McpExportProfilesRequest {
  kind: 'export-profiles'
  profile?: string
}

/**
 * An agent viewport (`viewport.open`): a labeled box on the person's canvas
 * where an agent works. With `viewport`, relabels that one.
 */
export interface McpOpenViewportRequest {
  kind: 'open-viewport'
  /** The board or the sheet to open it on; neither only with `viewport`. */
  board?: string
  sheet?: string
  label: string
  viewport?: string
  /** The agent connection asking (`main/mcpSessions.ts`); main reads it and drops it. */
  connection?: string
  /**
   * The id main gave this open, unique across windows: the connection's own
   * viewport, relabeled and moved when the window still holds it, else opened.
   */
  id?: string
}

/** `viewport.close`: the box leaves the canvas and any routing in it ends. */
export interface McpCloseViewportRequest {
  kind: 'close-viewport'
  viewport: string
  /** Why, when main closes it rather than the agent: its client left, or it moved window. */
  reason?: string
}

/**
 * Edit ▸ Undo or Redo on one document's undo list (`*.undo`, `*.redo`): its
 * last `steps` steps, all or none, whoever made them.
 */
interface McpHistoryStepRequest {
  /** Redo instead of undo. */
  redo?: true
  /** How many steps; refused, with nothing stepped, when the list holds fewer. */
  steps: number
}

export interface McpUndoSheetRequest extends McpHistoryStepRequest, McpInViewport {
  kind: 'undo-sheet'
  sheet?: string
}

export interface McpUndoBoardRequest extends McpHistoryStepRequest, McpInViewport {
  kind: 'undo-board'
  board?: string
}

export interface McpUndoSymbolRequest extends McpHistoryStepRequest, McpSymbolTarget {
  kind: 'undo-symbol'
}

export interface McpUndoFootprintRequest extends McpHistoryStepRequest, McpFootprintTarget {
  kind: 'undo-footprint'
}

export type McpDesignRequest =
  | McpOpenViewportRequest
  | McpCloseViewportRequest
  | McpUndoSheetRequest
  | McpUndoBoardRequest
  | McpUndoSymbolRequest
  | McpUndoFootprintRequest
  | McpExportBoardRequest
  | McpExportProfilesRequest
  | McpRenderGerbersRequest
  | McpDescribeBoardRequest
  | McpGetBoardItemsRequest
  | McpQueryBoardItemsRequest
  | McpUpdateBoardItemRequest
  | McpDeleteBoardItemsRequest
  | McpCreateBoardItemRequest
  | McpBatchBoardRequest
  | McpRefillBoardRequest
  | McpFanoutBoardRequest
  | McpCleanupBoardRequest
  | McpSetTeardropsBoardRequest
  | McpApplyInterfacePresetRequest
  | McpBeginRouteRequest
  | McpStepRouteRequest
  | McpPreviewRouteRequest
  | McpFinishRoutesRequest
  | McpPlaceFootprintBoardRequest
  | McpUpdateFootprintsBoardRequest
  | McpUpdateTuningPatternsBoardRequest
  | McpCreateProjectRequest
  | McpCreateFileRequest
  | McpGetBoardSetupRequest
  | McpUpdateBoardSetupRequest
  | McpGetSchematicSetupRequest
  | McpUpdateSchematicSetupRequest
  | McpSyncBoardRequest
  | McpRenderBoardRequest
  | McpRenderBoard3DRequest
  | McpDescribeRequest
  | McpAnnotateRequest
  | McpGetBomRequest
  | McpUpdateBomRequest
  | McpUpdateSymbolsSchematicRequest
  | McpGetItemsRequest
  | McpQueryItemsRequest
  | McpUpdateItemRequest
  | McpDeleteItemsRequest
  | McpCreateItemRequest
  | McpAddSheetRequest
  | McpSetPaperRequest
  | McpCleanupRequest
  | McpPlaceRequest
  | McpBindRequest
  | McpConnectRequest
  | McpWireRequest
  | McpCheckRequest
  | McpRenderRequest
  | McpRenderSymbolRequest
  | McpCopySymbolRequest
  | McpGetSymbolRequest
  | McpGetFootprintRequest
  | McpRenderFootprintRequest
  | McpRenderModelRequest
  | McpCopyFootprintRequest
  | McpSaveRequest
  | McpOpenRequest
  | McpSetWorkspaceRequest
  | McpUnsavedFilesRequest
  | McpCloseRequest
  | McpCreateSymbolRequest
  | McpDeleteSymbolRequest
  | McpCreateFootprintRequest
  | McpDeleteFootprintRequest
  | McpGetFootprintItemsRequest
  | McpQueryFootprintItemsRequest
  | McpUpdateFootprintItemRequest
  | McpDeleteFootprintItemsRequest
  | McpCreateFootprintItemRequest
  | McpCheckFootprintRequest
  | McpCheckSymbolRequest
  | McpCheckBoardRequest
  | McpExplainBoardLimitsRequest
  | McpBatchFootprintRequest
  | McpGetSymbolItemsRequest
  | McpQuerySymbolItemsRequest
  | McpUpdateSymbolItemRequest
  | McpDeleteSymbolItemsRequest
  | McpCreateSymbolItemRequest
  | McpBatchSymbolRequest
  | McpTransformSymbolItemsRequest
  | McpTransformFootprintItemsRequest
  | McpTransformBoardItemsRequest
  | McpLandPatternRequest
  | McpBatchRequest

// --- What a design answer is shaped like -----------------------------------
//
// One shape per kind of answer, across sheet, board, symbol and footprint
// (docs/MCP-STYLE.md, "Answer shapes"). Every door builds its answers from these.

/** The ids a write touched. Ids only: an op that owes more names it under its
 *  own key (`placed`, `touching`). */
export interface McpChanged {
  created: string[]
  updated: string[]
  deleted: string[]
  /**
   * Set only on an MCP answer whose lists were capped (`main/ops/answerLists.ts`):
   * every list's full length. The doors never set it.
   */
  counts?: { created: number; updated: number; deleted: number }
  truncated?: true
}

/**
 * One finding on its own: the items it is between (ids `items_get` takes),
 * where, on which layer, and what was measured against what limit. A board's.
 */
export interface McpCheckFinding {
  items: string[]
  /** Millimeters, y down, in the document's frame. */
  at?: { x: number; y: number }
  layer?: string
  /** `actual` breaks `limit`, a floor (`min`) or a ceiling (`max`); `rule` set the limit. */
  measure?: {
    actual: number
    limit: number
    bound: 'min' | 'max'
    unit: 'mm' | 'deg' | 'count' | 'ps'
    rule?: string
  }
  /** What the finding turns on where there are no numbers: the nets a short joins. */
  detail?: string
}

/** One rule's row in a check delta: items when few, a count past `DELTA_ITEMS`. */
export interface McpDeltaRow {
  code: string
  severity: 'error' | 'warning'
  items?: string[]
  count?: number
  /** Board: the first `DELTA_ITEMS` findings on their own. */
  findings?: McpCheckFinding[]
  /** Board: more findings than `findings` holds. */
  truncated?: true
}

export interface McpCheckDelta {
  new: McpDeltaRow[]
  resolved: McpDeltaRow[]
}

/** What every write answers with. A dry run answers the same, plus `dryRun: true`,
 *  at the current revision. */
export interface McpWriteAnswer {
  changed: McpChanged
  revision: number
  dryRun?: true
  /** With `checks: true`: what the write broke or fixed. */
  checks?: McpCheckDelta
  /**
   * Derived work the write left undone: a board's zone fills, which every
   * write leaves stale until `board.refill`, and the rules whose findings are
   * held back until then.
   */
  stale?: { fills?: true; rules?: string[] }
  guidance?: string
}

/** A pin or pad row of a placed part. */
export interface McpPlacedTerminal {
  id: string
  number: string
  name?: string
  at: { x: number; y: number }
  /** Sheet: the side a wire or label leaves the pin from. */
  free?: 'right' | 'up' | 'left' | 'down'
  net?: string
}

/** What a placement answers under `placed`, on a sheet or a board. */
export interface McpPlaced {
  id: string
  reference: string
  libId: string
  at: { x: number; y: number }
  angle: number
  /** Board. */
  side?: 'front' | 'back'
  /** Sheet. */
  mirror?: 'x' | 'y'
  /** Sheet. */
  unit?: number
  pins?: McpPlacedTerminal[]
  pads?: McpPlacedTerminal[]
  /** Past the row cap: the count instead of the rows. */
  pinCount?: number
  padCount?: number
}

/** One rule's row in a full check. */
export interface McpCheckRow {
  code: string
  /** Absent on the count-0 row of a code `codes` asked for that found nothing. */
  severity?: 'error' | 'warning'
  /** One sentence for the rule. */
  rule: string
  count: number
  items: string[]
  /** Board: each finding on its own, the first `FINDINGS_PER_RULE` of `count` unless `codes` names the rule. */
  findings?: McpCheckFinding[]
  /** Sheet: `items` is capped. Board: `findings` is. Never with `codes`. */
  truncated?: true
}

/** What every `*.check` answers. With `since`, `checks` is the delta instead. */
export interface McpCheckAnswer {
  ok: boolean
  checks: McpCheckRow[] | McpCheckDelta
  /** `elsewhere`: a sheet check named with `sheet` counts the findings on other sheets here. */
  counts: { error: number; warning: number; elsewhere?: number }
  /** Sheet and board: pass as `since` later. */
  revision?: number
  guidance?: string
}

/** Envelope: `id` correlates the reply, since one window may be answering
 *  several tool calls at once. */
export interface McpDesignEnvelope {
  id: string
  request: McpDesignRequest
}

export interface McpDesignReply {
  id: string
  ok: boolean
  /** Tool-shaped payload on success. */
  payload?: unknown
  /** A typed reason, never prose — the same discipline `PartsErrorKind` follows,
   *  so an agent can tell "no window is open" from "that reference is taken". */
  error?: string
  detail?: string
  /** The real ids, when the failure is a name that did not resolve. This is what
   *  turns a dead end into one more turn (`agent-api.md`). */
  candidates?: string[]
}
