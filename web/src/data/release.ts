import releaseFile from './release.json'

export type Platform = 'mac' | 'win' | 'linux'

/**
 * One entry per artifact a visitor can click, matching what the release
 * pipeline actually uploads (docs/RELEASES.md §2). `mac`/`win`/`linux` are
 * the primary installer per platform and are required — a missing one fails the
 * bump job rather than shipping a dead button. `linuxDeb` is secondary: Debian
 * and Ubuntu expect a package, but the AppImage remains the "any distro"
 * answer, so it degrades to absent rather than blocking a release.
 */
export interface ReleaseAssets {
  /** macOS .dmg, Apple silicon (the only mac build — RELEASES.md §2.1) */
  mac: string
  /** Windows NSIS .exe */
  win: string
  /** Linux .AppImage */
  linux: string
  /** Linux .deb, when the release published one */
  linuxDeb?: string
}

export interface Release {
  /** Semver of the published release, e.g. "1.2.0". Null when nothing is published yet. */
  version: string | null
  /** Link to the GitHub release notes. Null when nothing is published yet. */
  notesUrl: string | null
  /** Direct installer URLs. Null when nothing is published yet. */
  assets: ReleaseAssets | null
}

/**
 * The latest published release, read at build time so the download buttons are
 * fully static — no runtime API call, no loading state, no dependency on
 * GitHub's API being reachable. The bump job overwrites the file on
 * `release: published` — see docs/WEB.md §4 for why that trigger and not the
 * tag.
 */
export const release: Release = releaseFile

/** Narrows `release` so callers get non-null `version`/`assets` inside the guard. */
export function isPublished(
  r: Release
): r is Release & { version: string; notesUrl: string; assets: ReleaseAssets } {
  return r.version !== null && r.assets !== null
}

export const PLATFORM_LABELS: Record<Platform, string> = {
  mac: 'macOS',
  win: 'Windows',
  linux: 'Linux'
}

/** What each platform's primary download actually is, for the docs matrix. */
export const PLATFORM_ARTIFACTS: Record<Platform, { kind: string; arch: string }> = {
  mac: { kind: '.dmg', arch: 'Apple silicon' },
  win: { kind: '.exe', arch: 'x64' },
  linux: { kind: '.AppImage', arch: 'x64' }
}
