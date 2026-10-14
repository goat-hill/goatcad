/**
 * Self-update for direct installs (docs/RELEASES.md §4).
 *
 * electron-updater against the `generic` feed in electron-builder.yml
 * (`latest*.yml` beside the installers on download.goatcad.com). The check runs
 * shortly after launch and then periodically, the download happens in the
 * background, and the only thing the user sees is one dialog once a build is
 * ready: restart now, or let it install on quit. The setting is read on every
 * check, so turning it off in Settings takes effect before the next one.
 * Settings ▸ About's Check now runs one at once (`checkForUpdatesNow`),
 * whatever the setting.
 */

import { app, dialog, BrowserWindow } from 'electron'
import { autoUpdater } from 'electron-updater'

export type UpdaterAvailability =
  { ok: true } | { ok: false; reason: 'unpackaged' | 'package-manager' }

/**
 * Whether this install is one the app may update itself. A package manager
 * owns the installs it made (RELEASES.md §4.2): on Linux only an AppImage
 * qualifies — electron-builder's launcher sets `APPIMAGE` — so a `.deb` install
 * never self-updates.
 */
export const updaterAvailability = (deps: {
  platform: NodeJS.Platform
  env: NodeJS.ProcessEnv
  isPackaged: boolean
}): UpdaterAvailability => {
  if (!deps.isPackaged) return { ok: false, reason: 'unpackaged' }
  if (deps.platform === 'linux' && !deps.env.APPIMAGE) {
    return { ok: false, reason: 'package-manager' }
  }
  return { ok: true }
}

/** What a check the user asked for found: Settings ▸ About shows it on the button. */
export type UpdateCheckOutcome = 'available' | 'up-to-date' | 'failed' | 'unavailable'

/** Set once the updater runs; null while this install may not update itself. */
let checkNow: (() => Promise<UpdateCheckOutcome>) | null = null

/** Whether this install updates itself; Settings disables Check now where it does not. */
export const canCheckForUpdates = (): boolean => checkNow !== null

/** Checks at once; a newer build downloads and then asks, as a scheduled check's does. */
export const checkForUpdatesNow = (): Promise<UpdateCheckOutcome> =>
  checkNow ? checkNow() : Promise.resolve('unavailable')

const FIRST_CHECK_DELAY_MS = 10_000
const CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000

export function startUpdater(deps: { enabled: () => boolean }): void {
  // GOATCAD_DEV_UPDATE=1 lets an unpackaged run exercise the flow against
  // dev-app-update.yml; nothing else about the gate changes.
  const forceDev = process.env.GOATCAD_DEV_UPDATE === '1'
  const availability = updaterAvailability({
    platform: process.platform,
    env: process.env,
    isPackaged: app.isPackaged || forceDev
  })
  if (!availability.ok) {
    console.info(`[updater] off: ${availability.reason}`)
    return
  }

  autoUpdater.forceDevUpdateConfig = forceDev
  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = true
  // Without a listener, EventEmitter turns a failed check — offline, a feed
  // that is not there yet — into an uncaught exception in main.
  autoUpdater.on('error', (err) => {
    console.warn(`[updater] ${err.message}`)
  })

  let restartRequested = false
  let prompted = false

  autoUpdater.on('update-downloaded', (info) => {
    // Once per build: the periodic check re-emits this for a download it
    // already has, and a second dialog would only nag.
    if (prompted) return
    prompted = true
    const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
    const options = {
      type: 'info' as const,
      message: `GoatCAD ${info.version} is ready to install`,
      detail: 'Restart now to use it, or it installs the next time you quit.',
      buttons: ['Restart now', 'Later'],
      defaultId: 0,
      cancelId: 1,
      // Windows would otherwise render the buttons as command links.
      noLink: true
    }
    const shown = win ? dialog.showMessageBox(win, options) : dialog.showMessageBox(options)
    void shown.then(({ response }) => {
      if (response !== 0) return
      // Quit through the app so unsaved work gets its prompt and a canceled
      // close cancels the restart; the install itself runs in `will-quit`
      // below. Calling quitAndInstall here would spawn the Windows installer
      // before the windows had agreed to close.
      restartRequested = true
      app.quit()
    })
  })

  app.on('will-quit', () => {
    if (!restartRequested) return
    restartRequested = false
    // Silent install, then relaunch. electron-updater's own quit hook installs
    // without relaunching, which is the "Later" path.
    autoUpdater.quitAndInstall(true, true)
  })

  const check = (): void => {
    if (!deps.enabled()) return
    autoUpdater.checkForUpdates().catch((err: unknown) => {
      console.warn(`[updater] check failed: ${err instanceof Error ? err.message : String(err)}`)
    })
  }

  checkNow = async () => {
    // Asked for, so a build already downloaded and put off with Later asks again.
    prompted = false
    try {
      const result = await autoUpdater.checkForUpdates()
      return result?.isUpdateAvailable ? 'available' : 'up-to-date'
    } catch (err) {
      console.warn(`[updater] check failed: ${err instanceof Error ? err.message : String(err)}`)
      return 'failed'
    }
  }

  setTimeout(check, FIRST_CHECK_DELAY_MS).unref()
  setInterval(check, CHECK_INTERVAL_MS).unref()
}
