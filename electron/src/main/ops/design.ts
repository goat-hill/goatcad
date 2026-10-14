/**
 * Talking to the open design, and what to say when it refuses.
 *
 * Every operation that reads or edits a schematic or the project's own symbol
 * library goes through here, because main cannot do any of it itself — the
 * KiCad AST layer, the open buffer and the undo stack all live in the renderer
 * (`partsMcpBridge.ts` has the full argument). The edit lands in the editor as
 * an ordinary undoable command on a dirty tab, which is also the whole consent
 * story.
 *
 * The remedy table is the part worth keeping careful. Same discipline as the
 * distributor remedies: a typed kind with an action attached. The ones that
 * matter most are the two an agent would otherwise retry forever — a design it
 * cannot see, and a name it invented.
 */
import type { McpDesignRequest } from '../../preload/mcpTypes'
import type { OpContext } from './context'
import { fail, succeed, type OpErrorCode, type OpOutcome } from './errors'

export const DESIGN_REMEDY: Record<string, string> = {
  'no-window': 'GoatCAD has no open window. Ask the user to open their project.',
  'no-bridge': 'This server cannot reach the app window. Report it; no argument works around it.',
  'no-schematic':
    'No sheet was named, none is in front, and the project has no root sheet (the one named after the project, or its only one). Pass sheet with a file name, or ask the user which design they mean.',
  'sheet-not-found':
    'No sheet by that name is in the open project. Call schematic_describe with no arguments for the sheets.',
  'unknown-symbol':
    'No library symbol has that id; ids are exact and case-sensitive. Find it with symbol_search or symbol_list_library.',
  'reference-taken':
    'That reference is already used. Omit reference for the next free one, or pass unit with it to place another unit of that part.',
  'unit-taken':
    'That unit of the part is already placed; the candidates are its free units. Pass one of them as unit, or omit reference for a new part.',
  'unit-not-found':
    'The symbol has no unit of that number; the candidates are the free units of the part. Pass one of them as unit.',
  'unit-required':
    'The reference names a part of several units, and this edit acts on one placement. Pass a unit id from the candidates (U5A); a field or value written on the reference reaches every unit.',
  'too-few-units':
    'The new symbol lacks every unit the targets show, so nothing was written. Choose a symbol with as many units, or name parts that show a unit it has.',
  'unit-symbol-mismatch':
    'The reference names a part drawn from another symbol; the candidate is its symbol. Place the unit with that symbol, or omit reference for a new part.',
  'unit-fields':
    "A unit takes its part's fields. Drop value and the field arguments, and change the part's fields with bom_update.",
  'units-elsewhere':
    "The part has units on other sheets, and a field or flag belongs to every unit. Write it with bom_update on the part's reference.",
  'reference-not-found':
    'Nothing on the sheet or board carries that reference; it may have changed since you read it. Call schematic_describe or board_describe.',
  'no-board': 'This project has no .kicad_pcb file.',
  'not-annotated':
    'The schematic has unannotated parts (the candidates), and a sync matches parts by reference. Number them with schematic_annotate, then sync again.',
  'check-baseline-not-found':
    "No check of this document answered at that revision. Call the document's check without since for a baseline, and pass the revision it returns.",
  'board-not-found':
    'No board by that name is in the open project; the candidates are its boards. Omit board when there is only one.',
  'board-ambiguous':
    'This project has several boards, so board is required; the candidates are its boards.',
  'board-unreadable':
    'The board file could not be read or parsed. Report the detail; a retry reads the same bytes.',
  'board-unsaved':
    "The board's tab has unsaved edits and an export writes the saved file. Call project_save, then export again.",
  'zones-stale':
    'Zone fills are out of date and this call reads them; the detail says what for. Call board_refill (then project_save, before an export), then call again.',
  'profile-not-found':
    'No export profile has that id; the candidates exist, and export_profiles lists them.',
  'nothing-to-export':
    'There was nothing to write; the detail says why. Name a profile or formats, or check the board holds what this export reads.',
  'no-tuning-patterns':
    'The board has no tuning patterns; nothing was written. Lay one with route_begin and tune.',
  'nothing-to-update':
    'No placed part has that lib id, or the document has none; nothing was written. Pass a lib id from the candidates as match, or references from schematic_describe or board_describe.',
  'nothing-drawn':
    'The render framed nothing: the board has no outline or parts in view. Call board_describe, then widen box, only or show.',
  'export-blocked':
    'The pre-flight found a fabrication blocker; nothing was written. Run export_package with dryRun for the findings, fix and save the board, then export again.',
  'read-only': 'The sheet is open read-only; nothing was written. Tell the user.',
  timeout:
    'The app did not answer in time; the edit may still have landed. Read the document before retrying, or tell the user.',
  'app-closing': 'GoatCAD is shutting down. Nothing was written.',
  'send-failed': 'The request never reached the window. Nothing was written.',
  'symbol-not-found':
    'No symbol of that name is in the project library; the candidates are the nearest it holds.',
  'library-not-found': 'This project has no library of that kind of its own yet.',
  'symbol-exists':
    'A symbol of that name is already in the project library. Pass another name, or overwrite on symbol_create to replace it and its hand edits.',
  'renderer-failed':
    'The app failed to complete the request. Report the detail; a retry is likely to fail the same way.',
  'invalid-args':
    'An argument is missing or does not fit this request; the detail names it. Fix that argument and call again.',
  'item-not-found':
    'No item has that id; the candidates exist. Ids come from schematic_describe, board_describe and items_query: a reference, a unit (U5A), a pin id, <reference>#<field>, a pad <reference>.<number> (a uuid where the number repeats), or a uuid.',
  'pad-ambiguous':
    "That <reference>.<number> names several pads, since the number repeats in the footprint, and KiCad names such pads by uuid only. Pass the id of the pad you mean from the candidates; the detail gives each one's position.",
  'invalid-record':
    'A record value has the wrong shape; the detail names the key. Read the item with items_get for its shape.',
  locked:
    'The item is locked by the user. Send "locked": false in the same record only if the user means it to move, and say so.',
  'net-not-found':
    'No net by that name is on the board; the candidates are the nearest. board_sync carries a new schematic net over; pass "" for no net.',
  'layer-not-found':
    'The board has no layer by that name; the candidates are its layers (F.Cu, In1.Cu…, B.Cu, Edge.Cuts).',
  'net-conflict':
    'The copper would short two nets. Route to a pad of the net you mean, or omit net to take it from the pads.',
  'board-changed': 'The board changed during the call; nothing was written. Call it again.',
  'project-exists':
    'The folder already holds the project the candidates name. Open it with project_open.',
  'files-exist':
    'The folder already holds the schematics the candidates name. Pass adopt with the root sheet, or blank: true for a new sheet beside them.',
  'no-project-file':
    'This board has no project file (.kicad_pro) to hold these settings; its stackup and general settings are its own. project_create makes a project.',
  'would-cross':
    'The wire would run through the symbol the candidates name. Move a part with items_update, wire in two runs through a free point, or connect by label.',
  'would-overlap':
    'The run would lie along another wire, the detail names it. End the run on that wire if they belong together, or route through a free point.',
  'would-touch-pin':
    'The wire would cross the pin the candidates name, joining it to the net. Wire in two runs through a free point, or move the part.',
  'off-grid':
    'That origin puts a pin off the 2.54 mm grid; nothing was placed. Pass the origin the message names, or one that puts every pin on grid (pins at ±3.81 mm need an odd multiple of 1.27 mm).',
  'sheet-too-small':
    'The size would no longer reach past a sheet pin; the detail names the smallest size and the pins that set it. Pass at least that, or move or delete those pins with items_update or items_delete first.',
  'not-transformable':
    "That transform does not take an item of this kind; the detail names it. Drop its id: a symbol's fields only move, a footprint's model and fields do not duplicate, a pad with a padstack does not flip; on a board a pad goes with its footprint, and only graphics, texts and zones mirror.",
  'not-applicable':
    'That argument does not apply to an item of this kind; the detail says which. Read it with items_get and send only its keys.',
  'pin-not-found':
    'That pin id does not resolve on this sheet; the candidates do. A pin name is accepted only when it names exactly one pad.',
  'would-merge':
    'Both nets are already named, so connecting them merges them. Pass merge: true only after reading both names and meaning to combine them.',
  'file-not-open':
    'No open tab has that file; the candidates are the open tabs. A name matching several tabs needs its full path.',
  'save-failed':
    'The write to disk failed; the detail says which file and why, and nothing after it was written. Tell the user.',
  'file-not-found': 'No file by that name is in the project tree; the candidates are real files.',
  'unsaved-edits':
    'That tab has unsaved edits. Save it with project_save, or pass discard: true if the user wants them dropped.',
  'unknown-footprint':
    'No footprint library has that id; ids are exact and case-sensitive. Pick a candidate or find it with footprint_search or footprint_list_library.',
  'unknown-check-code':
    "No rule of this document's checks has that code; the candidates are the nearest. A full check's rows name every code it found.",
  'footprint-unreadable':
    'The indexed footprint file could not be read or parsed. Tell the user which file; a library rebuild (Settings) refreshes a moved file.',
  'field-not-found':
    "No part has a column by that name; the candidates are the design's columns. Add a new field by writing it with bom_update.",
  'field-spelling':
    'The design already has that field under another spelling. Use the spelling the candidates name.',
  'no-project': 'No project is open to write into. Ask the user to open their project.',
  'no-active-project':
    'The folder holds several projects and none is active. Ask the user to choose the active project in the sidebar.',
  'footprint-exists':
    'A footprint of that name already exists in the project library. Pass another name, or overwrite on footprint_create to replace it and its hand edits.',
  'footprint-not-found':
    'No footprint of that name is in the project library; the candidates are the nearest it holds.',
  'footprint-unsaved':
    "The footprint's tab has unsaved edits, which this would overwrite. Save them with project_save, or ask the user to revert the tab, then call again.",
  'blank-name': 'The name is empty. Name it the way the library names its neighbors.',
  'bad-name': 'The name is not a legal file name. Drop slashes, colons and similar characters.',
  'no-pads': 'The pad table is empty. Transcribe every pad from the land pattern drawing.',
  'bad-pad':
    'A pad has no size, or a hole no drill; the detail names it. Read it from the land pattern.',
  'bad-array':
    'A pad array needs count 2 or more and a numeric first number; the detail names it. Pass named pads (MP, SH) one by one.',
  'pads-overlap':
    'Two differently numbered pads share copper, a short by construction; the detail names them. Check the pitch and origin against the drawing.',
  'bad-pin1':
    'pin1 must be a pad number from the table, and is required with more than one pad. Pass the pad the drawing marks.',
  'bad-body':
    'The body is empty. Pass the top-view outline: a rect with positive size, or a polygon of three or more points.',
  'write-failed': 'The file could not be written; the detail says why. Tell the user.',
  'name-taken':
    'The project already has a file or library of that name, the candidate. Pass another name, or open the file with project_open.',
  'register-failed':
    "The file was written but the project's library table could not be updated; the detail says why. Tell the user.",
  'library-unparseable':
    'The project library could not be parsed; nothing was written. Tell the user which file.',
  'symbol-unreadable': 'The symbol could not be read or parsed. Tell the user which file.',
  'library-read-only':
    "Only the project's own library is editable. For a standard footprint, take a copy with footprint_copy and assign it with bom_update. For a standard symbol, take a copy with symbol_copy, or edit a placed part's copy (symbol with its reference and sheet).",
  'bad-package':
    'The package lacks a dimension this lead type needs; the detail names it. Read it off the package drawing.',
  'model-unresolved':
    "No 3D model to draw: the footprint links none, or its file is not on this machine (footprint_get reports each link's status). Add one with footprint_cache_model and items_create, or render the layers (render_footprint with no view).",
  refused:
    'The edit does not apply to the item as it is; act on the detail. A footprint that already links a model changes it with items_update on the id "model".',
  'not-step':
    'The file holds no geometry this app reads. Use a STEP or .wrl file; convert or replace anything else.',
  'route-session-not-found':
    'No routing session has that id. The candidates are live; or call route_begin.',
  'route-session-ended':
    'The routing session ended; the detail says why (its viewport closed, its board closed, it sat idle, or route_begin replaced it). Call route_begin again.',
  'viewport-not-found': 'No viewport has that id. The candidates are open; or call viewport_open.',
  'viewport-closed':
    'The viewport closed; the detail says why (the user closed it, its tab closed, it sat idle, viewport_close, or its routing session ended). Call viewport_open for a new one.',
  'route-start-refused':
    'The via armed for the start breaks clearance or a keepout there; nothing began. Begin elsewhere, or without the via.',
  'pad-not-found':
    'That footprint has no pad by that id; the candidates are its pads: <reference>.<number>, or a uuid where the number repeats.',
  'count-mismatch':
    'The target matched a different number than expect; nothing was written. Read the matches with the same filter (bom_get for parts, items_query for items), then narrow it or pass the count you mean.',
  'keepout-shape':
    'keepout is a boolean: true makes the zone a rule area. What it keeps out goes beside it in rules, e.g. "keepout": true, "rules": {"tracks": "not_allowed", "vias": "not_allowed"}.',
  'revision-moved':
    'The document changed since the revision passed, so the pages read so far do not join this one. Read again from offset 0 and pin the revision that answers.',
  'nothing-to-undo':
    'The undo list holds fewer steps than asked (the detail says how many), so nothing was undone. Pass steps within it.',
  'nothing-to-redo':
    'The redo list holds fewer steps than asked (the detail says how many), so nothing was redone. Only steps undone since the last edit can be redone.',
  // symbol_create's pin table, refused before anything is drawn
  // (`planSymbol`, renderer/src/lib/symbol/symbolLayout.ts).
  'no-pins':
    'Groups were given with no pins. Pass the pin table, or neither pins nor groups for a blank symbol.',
  'blank-pin-number': 'Every pin needs the pad number the datasheet prints for it.',
  'duplicate-pin-number':
    'Two pins carry the same pad number. For pins on the same net, use stackWith.',
  'unknown-group': 'Every pin needs a group, declared in groups. Assign each from the datasheet.',
  'everything-omitted': 'Every pin was omitted, which would leave an empty symbol.',
  'no-power-pins':
    'No group has role power or ground, which usually means a partial pin table. Check whether supply pins were labeled as signals.',
  'stack-target-missing': 'A stackWith names a pad that is not in the table (or was omitted).',
  'stack-self': 'A pin cannot stack on itself.',
  'stack-cycle': 'Those stackWith references form a loop.',
  'rail-name-too-long':
    'A long top or bottom pin name makes a tall, empty symbol. Move that group to a side with side: "left" or "right", or use a shorter datasheet name.'
}

/**
 * Which of the eight codes each window failure is. Every kind a door returns
 * has a row here and in `DESIGN_REMEDY` (`designKinds.test.ts`).
 *
 * The kind survives alongside it: a client branches on the code, an agent
 * reads the kind and the fix. Anything not listed is our bug until proven
 * otherwise, which is the right default for a failure the window invented.
 */
export const DESIGN_CODE: Record<string, OpErrorCode> = {
  'no-window': 'no-document',
  'no-bridge': 'internal',
  'no-schematic': 'no-document',
  'sheet-not-found': 'not-found',
  'unknown-symbol': 'not-found',
  'reference-taken': 'conflict',
  'unit-taken': 'conflict',
  'unit-not-found': 'not-found',
  'unit-symbol-mismatch': 'conflict',
  'too-few-units': 'refused',
  'unit-required': 'refused',
  'unit-fields': 'refused',
  'units-elsewhere': 'refused',
  'reference-not-found': 'not-found',
  'no-board': 'no-document',
  'not-annotated': 'conflict',
  'board-not-found': 'not-found',
  'check-baseline-not-found': 'not-found',
  'board-ambiguous': 'invalid-args',
  'board-unreadable': 'internal',
  'board-unsaved': 'conflict',
  'zones-stale': 'conflict',
  'profile-not-found': 'not-found',
  'nothing-to-export': 'invalid-args',
  'no-tuning-patterns': 'not-found',
  'nothing-to-update': 'not-found',
  'nothing-drawn': 'invalid-args',
  'export-blocked': 'refused',
  'read-only': 'refused',
  timeout: 'timeout',
  'app-closing': 'refused',
  'send-failed': 'internal',
  'symbol-not-found': 'not-found',
  'library-not-found': 'not-found',
  'symbol-exists': 'conflict',
  'renderer-failed': 'internal',
  'invalid-args': 'invalid-args',
  'pin-not-found': 'not-found',
  'item-not-found': 'not-found',
  'pad-ambiguous': 'refused',
  'invalid-record': 'invalid-args',
  locked: 'refused',
  'net-not-found': 'not-found',
  'layer-not-found': 'not-found',
  'net-conflict': 'conflict',
  'board-changed': 'conflict',
  'no-project-file': 'no-document',
  'project-exists': 'conflict',
  'files-exist': 'conflict',
  'not-applicable': 'refused',
  'not-transformable': 'refused',
  'sheet-too-small': 'refused',
  'off-grid': 'refused',
  'would-cross': 'refused',
  'would-touch-pin': 'refused',
  'would-overlap': 'refused',
  'would-merge': 'conflict',
  'file-not-open': 'not-found',
  'save-failed': 'internal',
  'file-not-found': 'not-found',
  'unsaved-edits': 'conflict',
  'unknown-footprint': 'not-found',
  'footprint-unreadable': 'internal',
  'unknown-check-code': 'not-found',
  'field-not-found': 'not-found',
  'field-spelling': 'conflict',
  'count-mismatch': 'conflict',
  'revision-moved': 'conflict',
  'nothing-to-undo': 'refused',
  'nothing-to-redo': 'refused',
  'keepout-shape': 'invalid-args',
  'no-project': 'no-document',
  'no-active-project': 'no-document',
  'footprint-exists': 'conflict',
  'footprint-not-found': 'not-found',
  'footprint-unsaved': 'conflict',
  'blank-name': 'invalid-args',
  'bad-name': 'invalid-args',
  'no-pads': 'invalid-args',
  'bad-pad': 'invalid-args',
  'bad-array': 'invalid-args',
  'pads-overlap': 'refused',
  'bad-pin1': 'invalid-args',
  'bad-body': 'invalid-args',
  'no-pins': 'invalid-args',
  'blank-pin-number': 'invalid-args',
  'duplicate-pin-number': 'invalid-args',
  'unknown-group': 'invalid-args',
  'everything-omitted': 'invalid-args',
  'no-power-pins': 'refused',
  'stack-target-missing': 'invalid-args',
  'stack-self': 'invalid-args',
  'stack-cycle': 'invalid-args',
  'rail-name-too-long': 'refused',
  'pad-not-found': 'not-found',
  'route-session-not-found': 'not-found',
  'route-session-ended': 'conflict',
  'viewport-not-found': 'not-found',
  'viewport-closed': 'not-found',
  'route-start-refused': 'refused',
  'write-failed': 'internal',
  'name-taken': 'conflict',
  'register-failed': 'internal',
  'library-unparseable': 'internal',
  'bad-package': 'invalid-args',
  'library-read-only': 'refused',
  'symbol-unreadable': 'internal',
  'model-unresolved': 'not-found',
  'not-step': 'refused',
  refused: 'refused'
}

/** Run one design request and shape its answer as an operation outcome. */
export const design = async (ctx: OpContext, request: McpDesignRequest): Promise<OpOutcome> => {
  if (!ctx.design) {
    return fail({
      code: 'internal',
      kind: 'no-bridge',
      message: 'This server cannot reach the app window.',
      fix: DESIGN_REMEDY['no-bridge']
    })
  }
  const outcome = await ctx.design(request)
  if (outcome.ok) return succeed(outcome.payload)
  return fail({
    code: DESIGN_CODE[outcome.error] ?? 'internal',
    kind: outcome.error,
    message:
      outcome.detail ?? DESIGN_REMEDY[outcome.error] ?? 'The app could not complete the request.',
    fix: DESIGN_REMEDY[outcome.error] ?? DESIGN_REMEDY['renderer-failed'],
    ...(outcome.candidates?.length ? { candidates: outcome.candidates } : {}),
    ...(outcome.detail ? { data: { detail: outcome.detail } } : {})
  })
}

/**
 * The part-identity fields, from named arguments to KiCad property keys.
 *
 * Named rather than left to a free-form map, deliberately: these keys are what
 * `fabBom.ts` already resolves and what KiCad's own BOM reads
 * (`parts-sourcing-workstream.md`), and a model asked to supply the key as
 * well as the value will eventually write "Part Number" or "mfr". Spelling them
 * in the schema turns recall into a lookup, which is the same reason
 * `parts_list_filters` exists. `properties` stays open for everything else, which is
 * where a distributor order code goes: `LCSC` used to have a named argument
 * here that no schema ever declared, so nothing could reach it.
 */
/**
 * The fields a verb names rather than takes loose: the ones GoatCAD itself
 * reads (`docs/agent-api.md`). Footprint is validated
 * against the index and consumed by the board; Datasheet resolves
 * `${KIPRJMOD}`; MPN keys the datasheet cache and the fab BOM; Manufacturer
 * disambiguates a colliding MPN. A field only a person or a fab reads (LCSC,
 * Tolerance, an order code) stays in `properties`.
 */
const PART_FIELD_KEYS: Record<string, string> = {
  footprint: 'Footprint',
  mpn: 'MPN',
  manufacturer: 'Manufacturer',
  datasheet: 'Datasheet'
}

/** The identity fields of a place or bind, merged into one property map. */
export interface PartFieldArgs {
  footprint?: string
  mpn?: string
  manufacturer?: string
  datasheet?: string
  properties?: Record<string, string>
}

export const partProperties = (args: PartFieldArgs): Record<string, string> => {
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(args.properties ?? {})) {
    if (key.trim()) out[key.trim()] = value
  }
  // Named arguments win over the same key passed loose, so a caller that sends
  // both cannot end up with two spellings of the same fact.
  const named: Record<string, string | undefined> = {
    footprint: args.footprint,
    mpn: args.mpn,
    manufacturer: args.manufacturer,
    datasheet: args.datasheet
  }
  for (const [arg, key] of Object.entries(PART_FIELD_KEYS)) {
    const value = named[arg]
    if (typeof value === 'string' && value.trim()) out[key] = value.trim()
  }
  return out
}
