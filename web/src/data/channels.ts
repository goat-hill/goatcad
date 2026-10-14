import type { Platform } from './release'

/**
 * The site's copy of the distribution strategy in docs/RELEASES.md §3.
 *
 * One entry per package-manager channel. `live` is the only field that moves in
 * normal operation: flip it the day the submission lands, and the command shows
 * up on both the landing page and the docs install page at once. Nothing on the
 * site renders a command for a channel that is not live — a reader who runs an
 * aspirational command gets an error, which is worse than seeing no command at
 * all (RELEASES.md §1).
 *
 * Direct downloads are deliberately NOT modelled here. They come from
 * release.json (WEB.md §4), which the bump job writes from the assets a release
 * actually uploaded, so they cannot drift from the pipeline.
 */
export interface Channel {
  id: string
  platform: Platform
  /** Manager name, as a reader would say it. */
  name: string
  /** Install command, verbatim. */
  install: string
  /** How that manager updates it — the answer to "will this auto-update?". */
  upgrade: string
  /** False until the submission is actually live. Nothing renders while false. */
  live: boolean
}

export const CHANNELS: Channel[] = [
  {
    id: 'homebrew-tap',
    platform: 'mac',
    name: 'Homebrew',
    // The personal tap, not homebrew-cask: cask has a notability bar and
    // expects a notarized app. Migrating to `--cask goatcad` later is a change
    // to this one string (and a cask that keeps working meanwhile).
    install: 'brew install --cask goat-hill/tap/goatcad',
    upgrade: 'brew upgrade --cask goatcad',
    live: false
  },
  {
    id: 'aur',
    platform: 'linux',
    name: 'AUR',
    install: 'yay -S goatcad-bin',
    upgrade: 'yay -Syu',
    live: false
  },
  {
    id: 'winget',
    platform: 'win',
    name: 'winget',
    // Deferred until the code-signing cert lands (RELEASES.md §3) — listed so
    // the shape is settled and turning it on is one boolean.
    install: 'winget install GoatHill.GoatCAD',
    upgrade: 'winget upgrade GoatHill.GoatCAD',
    live: false
  }
]

/** Live channels only, optionally for one platform. Order follows RELEASES.md §3. */
export function liveChannels(platform?: Platform): Channel[] {
  return CHANNELS.filter((c) => c.live && (platform === undefined || c.platform === platform))
}
