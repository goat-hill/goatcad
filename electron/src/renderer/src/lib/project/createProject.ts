/**
 * The files a new project is born with, and what a folder must hold for one
 * to be made there — shared by the New Project dialog and the agent's
 * `project.create`, so both write a project the same way.
 *
 * A fresh project is the scaffold (`newProjectFiles`); given a copper layer
 * count or a manufacturing profile, its board's stackup and its project's
 * rules and Default class are set as Board Setup would set them, with the
 * same functions, before anything is written.
 */
import { newProjectFiles, type ScaffoldedFile } from './scaffold'
import { scanForAdoption, type FolderEntry } from './adoptProject'
import { validateFileName } from '../fileMenu'
import { parseKicadBoard, serializeKicadBoard, setBoardStackupInAST } from '../kicad/board'
import {
  DEFAULT_CLASS_NAME,
  extractDesignSettings,
  patchBoardSetupChoice,
  patchDesignSettings
} from '../kicad/project'
import { BUILT_IN_PROFILES, defaultStackupOf, findProfile } from '../manufacturingProfiles'
import { stackupSpecOf } from '../board/boardSetup'

export interface ProjectSetupChoice {
  copperLayers?: number
  /** A built-in profile id (`manufacturingProfiles.ts`). */
  profile?: string
}

export type CreateRefusal = {
  ok: false
  error: 'bad-name' | 'project-exists' | 'invalid-record' | 'files-exist'
  detail: string
  candidates?: string[]
}

/** Why a project cannot be made in `entries` under `name`, or null when it can. */
export function refuseCreate(
  entries: FolderEntry[],
  folderName: string,
  name: string,
  adopt: string | undefined,
  blank: boolean,
  setup: ProjectSetupChoice
): CreateRefusal | null {
  const scan = scanForAdoption(entries, folderName)
  if (scan.existingProject)
    return {
      ok: false,
      error: 'project-exists',
      detail: `This folder already holds ${scan.existingProject}.`,
      candidates: [scan.existingProject]
    }
  const nameError = validateFileName(
    `${name}.kicad_pro`,
    entries.map((entry) => entry.name)
  )
  if (!name.trim() || nameError)
    return {
      ok: false,
      error: 'bad-name',
      detail: `${name}.kicad_pro is not a name a new project can take.`
    }
  const sheets = scan.schematics.map((sheet) => sheet.name)
  if (adopt !== undefined && !sheets.includes(adopt))
    return {
      ok: false,
      error: 'invalid-record',
      detail: `adopt names ${adopt}, which is not a schematic in this folder.`,
      candidates: sheets
    }
  if (adopt === undefined && !blank && sheets.length)
    return {
      ok: false,
      error: 'files-exist',
      detail: `This folder already holds schematics (${sheets.join(', ')}). Pass adopt with the root sheet to make a project of them, or blank: true for a new sheet beside them.`,
      candidates: sheets
    }
  if (adopt !== undefined && (setup.copperLayers !== undefined || setup.profile !== undefined))
    return {
      ok: false,
      error: 'invalid-record',
      detail:
        'copperLayers and profile shape a new board; an adopted project keeps the one it has. Set it with board_update_setup.'
    }
  const count = setup.copperLayers
  if (count !== undefined && (!Number.isInteger(count) || count < 2 || count > 32 || count % 2))
    return {
      ok: false,
      error: 'invalid-record',
      detail: 'copperLayers is an even count from 2 to 32.'
    }
  if (setup.profile !== undefined && !findProfile(setup.profile))
    return {
      ok: false,
      error: 'invalid-record',
      detail: `No manufacturing profile is ${setup.profile}.`,
      candidates: BUILT_IN_PROFILES.map((profile) => profile.id)
    }
  return null
}

/** A fresh project's files, its board and rules set as the choice asks. */
export function newProjectFilesWith(name: string, setup: ProjectSetupChoice): ScaffoldedFile[] {
  const files = newProjectFiles(name)
  if (setup.copperLayers === undefined && setup.profile === undefined) return files
  const profile = setup.profile ? findProfile(setup.profile) : null
  return files.map((file) => {
    if (file.name.endsWith('.kicad_pcb')) {
      const board = parseKicadBoard(file.content)
      const spec = profile ? defaultStackupOf(profile) : stackupSpecOf(board)
      setBoardStackupInAST(board, {
        ...spec,
        ...(setup.copperLayers !== undefined ? { copperLayers: setup.copperLayers } : {})
      })
      return { ...file, content: serializeKicadBoard(board) }
    }
    if (file.name.endsWith('.kicad_pro') && profile) {
      const current = extractDesignSettings(file.content)
      const classes = (current?.classes ?? []).map((netClass) =>
        netClass.name === DEFAULT_CLASS_NAME ? { ...netClass, ...profile.defaults } : netClass
      )
      const design = patchDesignSettings(file.content, {
        rules: { ...profile.rules },
        classes,
        patterns: current?.patterns ?? []
      })
      // The pick is stored as Board Setup stores it; a copper count other than
      // the profile's own build leaves the stackup Custom.
      const stackup =
        setup.copperLayers === undefined ||
        setup.copperLayers === defaultStackupOf(profile).copperLayers
          ? profile.stackups[0].id
          : null
      const patched = design && patchBoardSetupChoice(design, { profile: profile.id, stackup })
      return patched ? { ...file, content: patched } : file
    }
    return file
  })
}
