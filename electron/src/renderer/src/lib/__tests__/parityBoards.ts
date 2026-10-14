/**
 * The boards the board parity suites run on, and how they read each: the
 * repo's sample project plus the KiCad corpus `PARITY_BOARDS` names, each at
 * its project's rules (KiCad's compiled-in defaults where it has none) and
 * with its custom rules. Shared by the DRC and zone-fill suites.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'fs'
import { homedir } from 'os'
import { basename, dirname, join } from 'path'
import { extractDesignSettings, type BoardDesignSettings } from '../kicad/project'
import { parseKicadFootprint, type KicadFootprint } from '../kicad/footprint'
import { findChild, findChildren, getAtomValues, parseSExpr, type SExprList } from '../kicad/sexpr'
import type { BoardLibraries, FootprintLibraryState } from '../board/boardLibraries'
import { expandLibraryUri } from '../../../../main/kicadGlobalTables'
import { corpusPaths } from './kicadParity'
import { KICAD_DEFAULTS } from './kicadDefaults'
import { CANARY_BOARD } from './canaryFixture'

export const sampleBoard = CANARY_BOARD

export const boardsUnder = (path: string): string[] => {
  if (!existsSync(path)) return []
  if (statSync(path).isFile()) return path.endsWith('.kicad_pcb') ? [path] : []
  return readdirSync(path, { withFileTypes: true })
    .filter((entry) => entry.name !== 'node_modules' && !entry.name.startsWith('.'))
    .flatMap((entry) => boardsUnder(join(path, entry.name)))
    .sort()
}

/** Our design settings for a board: its project's, else KiCad's own defaults. */
export const settingsFor = (boardFile: string): BoardDesignSettings => {
  const project = join(dirname(boardFile), `${basename(boardFile, '.kicad_pcb')}.kicad_pro`)
  const fromProject = existsSync(project)
    ? extractDesignSettings(readFileSync(project, 'utf8'))
    : null
  if (fromProject) {
    // A key the project does not set is KiCad's default, not GoatCAD's.
    const rules = JSON.parse(readFileSync(project, 'utf8')).board?.design_settings?.rules ?? {}
    const keyOf: Record<keyof BoardDesignSettings['rules'], string> = {
      minClearance: 'min_clearance',
      minTrackWidth: 'min_track_width',
      minConnectionWidth: 'min_connection',
      minViaAnnularWidth: 'min_via_annular_width',
      minViaDiameter: 'min_via_diameter',
      minCopperHoleClearance: 'min_hole_clearance',
      minCopperEdgeClearance: 'min_copper_edge_clearance',
      minThroughHoleDiameter: 'min_through_hole_diameter',
      minHoleToHole: 'min_hole_to_hole',
      minMicroviaDiameter: 'min_microvia_diameter',
      minMicroviaDrill: 'min_microvia_drill',
      minSilkClearance: 'min_silk_clearance',
      minTextHeight: 'min_text_height',
      minTextThickness: 'min_text_thickness',
      maxError: 'max_error',
      zonesAllowExternalFillets: 'zones_allow_external_fillets',
      minResolvedSpokes: 'min_resolved_spokes',
      useHeightForLengthCalcs: 'use_height_for_length_calcs'
    }
    const merged = { ...fromProject.rules }
    for (const key of Object.keys(keyOf) as Array<keyof BoardDesignSettings['rules']>) {
      if (rules[keyOf[key]] === undefined)
        (merged as Record<string, unknown>)[key] = KICAD_DEFAULTS[key]
    }
    return { ...fromProject, rules: merged }
  }
  return kicadDefaultSettings()
}

/** KiCad's own design settings, for a board with no project. */
export const kicadDefaultSettings = (): BoardDesignSettings => {
  return {
    rules: { ...KICAD_DEFAULTS },
    classes: [
      {
        name: 'Default',
        clearance: 0.2,
        trackWidth: 0.2,
        viaDiameter: 0.6,
        viaDrill: 0.3,
        microviaDiameter: 0.3,
        microviaDrill: 0.1,
        diffPairWidth: 0.2,
        diffPairGap: 0.25
      }
    ],
    patterns: [],
    assignments: []
  }
}

/** A board's custom rules, its project's `.kicad_dru` text; undefined when it has none. */
export const customRulesOf = (boardFile: string): string | undefined => {
  const rules = join(dirname(boardFile), `${basename(boardFile, '.kicad_pcb')}.kicad_dru`)
  return existsSync(rules) ? readFileSync(rules, 'utf8') : undefined
}

/** The corpus: the sample project, then every board under what `PARITY_BOARDS` names. */
export const parityBoards = (): string[] => [
  ...boardsUnder(sampleBoard),
  ...corpusPaths(process.env.PARITY_BOARDS, 'qa/data/pcbnew').flatMap(boardsUnder)
]

/**
 * The footprint libraries as `kicad-cli pcb drc` found them: KiCad's global
 * `fp-lib-table` (`PARITY_FP_LIB_TABLE`, else the user's KiCad 10 config),
 * its nested tables read in, then the board's own `fp-lib-table`, whose rows
 * win. `${KICAD*_FOOTPRINT_DIR}` is the installed library
 * (`PARITY_FOOTPRINT_DIR`, else KiCad's Linux install).
 */
/**
 * Where an installed KiCad 10 keeps its global footprint table and its
 * standard footprints, as kicad-cli reads them: the Linux packages' places,
 * or the macOS app's.
 */
const KICAD_PATHS =
  process.platform === 'darwin'
    ? {
        fpLibTable: join(homedir(), 'Library/Preferences/kicad/10.0/fp-lib-table'),
        footprints: '/Applications/KiCad/KiCad.app/Contents/SharedSupport/footprints'
      }
    : {
        fpLibTable: join(homedir(), '.config/kicad/10.0/fp-lib-table'),
        footprints: '/usr/share/kicad/footprints'
      }

export const librariesFor = (boardFile: string): BoardLibraries => {
  const dir = dirname(boardFile)
  const footprintDir = process.env.PARITY_FOOTPRINT_DIR ?? KICAD_PATHS.footprints
  const rows = new Map<string, { path: string; type: string; disabled: boolean }>()
  const read = (file: string, depth = 0): void => {
    if (depth > 4 || !existsSync(file)) return
    let root: SExprList
    try {
      root = parseSExpr(readFileSync(file, 'utf8')) as SExprList
    } catch {
      return
    }
    for (const lib of findChildren(root, 'lib')) {
      const value = (token: string): string => {
        const node = findChild(lib, token)
        return (node && getAtomValues(node)[0]) ?? ''
      }
      // KiCad reads `$(VAR)` as `${VAR}`.
      const written = value('uri').replace(/\$\(([^)]+)\)/g, '${$1}')
      const uri = expandLibraryUri(written.replace(/\$\{KIPRJMOD\}/g, dir), process.env, {
        footprintDir,
        home: homedir()
      })
      const path = uri.startsWith('/') ? uri : join(dirname(file), uri)
      if (value('type') === 'Table') read(path, depth + 1)
      else
        rows.set(value('name'), {
          path,
          type: value('type'),
          disabled: findChild(lib, 'disabled') !== null
        })
    }
  }
  read(process.env.PARITY_FP_LIB_TABLE ?? KICAD_PATHS.fpLibTable)
  read(join(dir, 'fp-lib-table'))
  const parsed = new Map<string, KicadFootprint | null | undefined>()
  const state = (nickname: string): FootprintLibraryState => {
    const row = rows.get(nickname)
    if (!row) return 'missing'
    if (row.disabled) return 'disabled'
    return existsSync(row.path) ? 'ok' : 'unreadable'
  }
  return {
    library: state,
    location: (nickname) => rows.get(nickname)?.path,
    footprint: (nickname, name) => {
      const row = rows.get(nickname)
      // Only KiCad's own `.pretty` format is read here.
      if (!row || row.type !== 'KiCad') return undefined
      const file = join(row.path, `${name}.kicad_mod`)
      if (!parsed.has(file)) {
        let footprint: KicadFootprint | null | undefined
        try {
          footprint = existsSync(file) ? parseKicadFootprint(readFileSync(file, 'utf8')) : null
        } catch {
          // A file the parser cannot read goes unjudged, as in the app.
          footprint = undefined
        }
        parsed.set(file, footprint)
      }
      return parsed.get(file)
    }
  }
}
