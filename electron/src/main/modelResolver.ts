import { existsSync } from 'fs'
import { dirname, isAbsolute, resolve } from 'path'
import type { ModelResolveResult } from '../preload/modelTypes'

/**
 * Resolve a KiCad footprint `(model ...)` path to an absolute file on disk.
 *
 * KiCad stores model paths in three shapes: env-var-prefixed tokens
 * (`${KICAD8_3DMODEL_DIR}/Foo.3dshapes/Bar.step`, the library form), absolute
 * paths, or paths relative to the footprint or project. Env vars expand from
 * `process.env`; when a `${KICAD*_3DMODEL_DIR}` or `${KICAD*_3RD_PARTY}` var is
 * unset — the normal case, since we are not launched from KiCad's shell — the
 * caller's detected fallback stands in (see `kicadLibraries.ts`, or the
 * `kicad3dModelDir` config override).
 *
 * **The extension in the file is a hint, not the answer.** Every KiCad footprint
 * references `.wrl`, but the two formats ship as separate downloads and most
 * Linux distributions package only the multi-gigabyte STEP set — so on a stock
 * install literally every standard part's `.wrl` link points at a file that is
 * not there while its `.step` sibling sits next to it. Each candidate is
 * therefore tried across the model extensions we can load, in both cases (KiCad
 * libraries mix `.step` and `.STEP`). Nothing is guessed: a variant only wins by
 * existing on disk.
 *
 * The candidate-ordering logic is factored into `modelPathCandidates` so it can
 * be unit-tested without touching the filesystem.
 */

const KICAD_MODEL_DIR_VAR = /^KICAD\d*_3DMODEL_DIR$/
const KICAD_3RD_PARTY_VAR = /^KICAD\d*_3RD_PARTY$/

/**
 * Model formats the app can load, in the order to prefer when substituting.
 * STEP first: it carries real geometry and per-face color, and it tessellates
 * in the main-process worker rather than on the renderer thread.
 */
const MODEL_EXTENSIONS = ['step', 'stp', 'wrl']

/** Where each KiCad path token falls back to when the env var is unset. */
export interface ModelPathFallbacks {
  /** The detected install's `3dmodels/` dir, for `${KICAD*_3DMODEL_DIR}`. */
  modelDir?: string
  /** The user's PCM `3rdparty/` dir, for `${KICAD*_3RD_PARTY}`. */
  thirdPartyDir?: string
  /** The open project's folder, for `${KIPRJMOD}` — KiCad sets it per project,
   *  so it is never in our environment. */
  projectDir?: string
}

/** Expand `${VAR}` tokens, falling back to the detected KiCad dirs. */
export function expandModelEnvVars(
  input: string,
  env: NodeJS.ProcessEnv,
  fallbacks: ModelPathFallbacks = {}
): string {
  return input.replace(/\$\{([^}]+)\}/g, (whole, name: string) => {
    const value = env[name]
    if (value) return value
    if (KICAD_MODEL_DIR_VAR.test(name) && fallbacks.modelDir) return fallbacks.modelDir
    if (KICAD_3RD_PARTY_VAR.test(name) && fallbacks.thirdPartyDir) return fallbacks.thirdPartyDir
    if (name === 'KIPRJMOD' && fallbacks.projectDir) return fallbacks.projectDir
    // Leave an unresolved token intact; the path simply won't exist on disk.
    return whole
  })
}

/**
 * One path expanded across the loadable model extensions, exact spelling first.
 * A path with no extension at all is returned untouched — there is nothing to
 * swap, and appending one would be inventing a file.
 */
export function modelExtensionVariants(path: string): string[] {
  const dot = path.lastIndexOf('.')
  const separator = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  if (dot <= separator + 1) return [path]

  const base = path.slice(0, dot)
  const own = path.slice(dot + 1).toLowerCase()
  const variants = [path]
  // The file's own format first (a case-only miss is the cheap fix), then the
  // others in preference order.
  for (const extension of [own, ...MODEL_EXTENSIONS.filter((e) => e !== own)]) {
    for (const cased of [extension, extension.toUpperCase()]) {
      const candidate = `${base}.${cased}`
      if (!variants.includes(candidate)) variants.push(candidate)
    }
  }
  return variants
}

/**
 * Ordered list of absolute paths to try, most-specific first. Pure: no disk I/O.
 * Absolute (after env expansion) resolves to itself; a relative path is tried
 * against the footprint's own directory, then the project directory. Each is
 * then expanded across the model extensions, so a directory is fully explored
 * before the next one is tried.
 */
export function modelPathCandidates(
  modelPath: string,
  footprintDir: string | null,
  projectPath: string | null,
  fallbacks: ModelPathFallbacks = {},
  env: NodeJS.ProcessEnv = process.env
): string[] {
  const expanded = expandModelEnvVars(modelPath.trim(), env, fallbacks)
  if (!expanded) return []
  const bases = isAbsolute(expanded)
    ? [expanded]
    : [
        ...(footprintDir ? [resolve(footprintDir, expanded)] : []),
        ...(projectPath ? [resolve(projectPath, expanded)] : [])
      ]
  return bases.flatMap(modelExtensionVariants)
}

/**
 * Why a path did not resolve. `missing`: the folder it names is there and the
 * file is not — the library links a model nobody drew. `not-installed`: the
 * folder, or the models directory itself, is absent, or a `${VAR}` has no value.
 */
export function unresolvedReason(
  candidates: readonly string[],
  expanded: string
): 'missing' | 'not-installed' {
  if (/\$\{[^}]+\}/.test(expanded)) return 'not-installed'
  return candidates.some((candidate) => existsSync(dirname(candidate)))
    ? 'missing'
    : 'not-installed'
}

export function resolveModelPath(
  modelPath: string,
  footprintDir: string | null,
  projectPath: string | null,
  fallbacks: ModelPathFallbacks = {},
  env: NodeJS.ProcessEnv = process.env
): ModelResolveResult {
  const withProject = { ...(projectPath ? { projectDir: projectPath } : {}), ...fallbacks }
  const candidates = modelPathCandidates(modelPath, footprintDir, projectPath, withProject, env)
  for (const candidate of candidates) {
    if (existsSync(candidate)) return { path: candidate }
  }
  return {
    notFound: true,
    reason: unresolvedReason(candidates, expandModelEnvVars(modelPath.trim(), env, withProject))
  }
}
