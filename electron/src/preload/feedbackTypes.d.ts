/**
 * What Share app feedback reports about the install (main/feedback.ts). The
 * renderer adds what only it knows — the UI language and the WebGL renderer —
 * and formats the lot into the issue (lib/feedback.ts).
 */
export interface FeedbackSystemInfo {
  version: string
  /**
   * `release` is a build release.yml made; `source` is anyone else's packaged
   * build; `dev` is an unpackaged run. Self-reported, so it tells triage what a
   * reporter is running, not whether to trust them.
   */
  channel: 'release' | 'source' | 'dev'
  /** The commit it was built from, when the build knew it. */
  commit: string | null
  platform: NodeJS.Platform
  /** The OS name and version as a person would quote it ("Ubuntu 24.04.1 LTS", "macOS 15.3"). */
  os: string
  arch: string
  /** dmg, nsis, AppImage, deb — or unpackaged. */
  install: string
  electron: string
  chrome: string
  /** The OS locale, which can differ from the language GoatCAD is shown in. */
  systemLocale: string
  /** The primary display's scale factor. */
  scaleFactor: number
}
