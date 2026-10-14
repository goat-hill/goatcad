/**
 * `footprint.cache_model` — a 3D model, in the repository, from a source the
 * agent names.
 *
 * The mirror image of
 * `parts_cache_datasheet` on the one point that matters: there the address is
 * resolved from what a distributor published and the caller cannot supply one,
 * because an aggregator's PDF can be the wrong revision and nothing downstream
 * could tell. Here no API publishes an address at all, so the caller supplies
 * it — and what keeps that honest is the record, not a gate. The source the
 * agent states and the host the bytes came from are both written down.
 *
 * GoatCAD ranks no hosts and blocks none. Which sources are worth trusting is
 * in the project's conventions (`board-intent.md`), where the user can read
 * and change it.
 */
import { defineOp } from '../registry'
import { s } from '../schema'
import { fail, refused, succeed, type OpOutcome } from '../errors'
import { isLegalModelName, MAX_MODEL_BYTES, MODEL_SOURCES } from '../../partsMcpModels'

const NO_PROJECT_FIX =
  'No project is open, so there is nowhere to put a model. Ask the user to open their project.'

const FIX: Record<string, string> = {
  'not-step':
    'Not a readable STEP file (no ISO-10303-21 header, or no geometry): a saved web page, a ZIP or an IGES/STL lands here. Pass the STEP file itself.',
  'too-large': `Over ${Math.round(MAX_MODEL_BYTES / (1024 * 1024))} MB, likely a whole assembly. Find the vendor's simplified model, or tell the user.`,
  unreadable: 'That file could not be read. Check the path.',
  'model-exists':
    'A model of that name is already cached. Use it, pass another name, or pass refresh to overwrite it for every footprint that links it.',
  'not-cached':
    'The address returned no STEP file. Download it yourself and pass path with url set to its source, or ask the user for it.'
}

export const footprintCacheModel = defineOp({
  name: 'footprint.cache_model',
  scope: 'project',
  mutates: false,
  summary:
    "Save a STEP model into the project's .3dshapes folder and return the path a model record links.",
  guidance:
    "Prefer a model a matching standard footprint already links (footprint_get; no download), then the manufacturer's STEP file. You supply the address; it and your stated source are recorded in the folder's index.json. Ask the user before a third-party source. STEP only; the file is parsed before it is kept. Pass url or path, or both to record where a local file came from.",
  input: s.object({
    name: s
      .string()
      .trim()
      .describe(
        'File name without extension, usually the footprint or package name, e.g. "SOT-23-5".'
      ),
    source: s
      .enum(MODEL_SOURCES)
      .describe(
        "Source kind: manufacturer (the maker's own file), distributor, third-party (ask the user first), or user (the user's file)."
      ),
    url: s
      .string()
      .trim()
      .describe(
        'https address to fetch the STEP file from; with path, where that file came from. Recorded.'
      )
      .optional(),
    path: s.string().trim().describe('Absolute path to a STEP file already on disk.').optional(),
    mpn: s.string().trim().describe('Part number the model is for, recorded with it.').optional(),
    refresh: s
      .boolean()
      .describe('Overwrite a cached model of that name. Defaults to false.')
      .optional()
  }),
  examples: [
    {
      args: {
        name: 'SOT-23-5',
        source: 'manufacturer',
        url: 'https://example.com/models/SOT-23-5.step',
        mpn: 'AP2112K-3.3TRG1'
      },
      note: "the maker's STEP file"
    },
    {
      args: { name: 'JST_PH_S4B', source: 'user', path: '/home/u/Downloads/S4B-PH-K-S.step' },
      note: "the user's file"
    }
  ],
  async run(args, ctx): Promise<OpOutcome> {
    if (!args.name) {
      return refused(
        'name is required and must not be empty.',
        'Name it the way the library names its neighbors — the package or the ordering code.'
      )
    }
    if (!isLegalModelName(args.name)) {
      return refused(
        `"${args.name}" is not a legal file name.`,
        'Drop slashes, colons and other characters a file system refuses, and do not start with a dot.',
        { kind: 'bad-name' }
      )
    }
    if (!args.url && !args.path) {
      return refused(
        'Pass url or path.',
        'url fetches the file; path takes one on disk, with url recorded as its source.'
      )
    }
    if (!ctx.models) {
      return fail({
        code: 'internal',
        kind: 'models-unavailable',
        message: 'This build of the server has no model store.'
      })
    }
    const projectPath = ctx.project?.() ?? null
    if (!projectPath) {
      return fail({
        code: 'no-document',
        kind: 'no-project',
        message: 'No project is open, so there is nowhere to put a model.',
        fix: NO_PROJECT_FIX
      })
    }

    const saved = await ctx.models.cache(projectPath, {
      name: args.name,
      source: args.source,
      ...(args.url ? { url: args.url } : {}),
      ...(args.path ? { filePath: args.path } : {}),
      ...(args.mpn ? { mpn: args.mpn } : {}),
      ...(args.refresh === true ? { refresh: true } : {})
    })
    if (!saved.ok) {
      return fail({
        code: saved.error === 'unreadable' ? 'not-found' : 'refused',
        kind: saved.error,
        message: saved.detail,
        fix: FIX[saved.error] ?? FIX['not-cached'],
        ...(saved.attempts ? { data: { attempts: saved.attempts } } : {})
      })
    }
    return succeed({
      model: {
        path: saved.token,
        file: saved.path,
        source: saved.record.source,
        host: saved.record.host ?? null,
        url: saved.record.url ?? null,
        mpn: saved.record.mpn ?? null,
        fetchedAt: saved.record.fetchedAt,
        bytes: saved.record.bytes,
        sha256: saved.record.sha256
      },
      bounds: saved.measurement.bounds,
      triangles: saved.measurement.triangles,
      meshes: saved.measurement.meshes,
      guidance:
        "Check bounds (millimeters) against the datasheet's package and look with render_model; tens of millimeters for a small part means wrong units, many meshes an assembly. Then pass model.path as a model record's path: items_update on id model where the footprint links one, else items_create (a standard footprint needs footprint_copy first)."
    })
  }
})
