/**
 * When one of the app's processes dies: which, and why, on stderr and in
 * `process-crashes.log` under `app.getPath('logs')`. A window's page is the
 * one a person sees die — Electron draws no crash page, so the window keeps
 * its last frame, frozen and unresponsive — so a page that crashed offers a
 * reload instead, never on its own. The window's tabs are forgotten the moment
 * it crashes, so neither that reload nor the next launch reopens the tab that
 * crashed it. In dev, a crash also leaves a minidump in
 * `app.getPath('crashDumps')`, kept on disk and never uploaded.
 *
 * English only: the page that would translate is the one that died, the same
 * reason the updater's dialog is English.
 */
import { app, crashReporter, dialog, type BrowserWindow } from 'electron'
import * as fs from 'fs'
import { join } from 'path'

/** One crash record: a JSON line, so the log greps and parses. */
export const crashLine = (at: Date, entry: Record<string, unknown>): string =>
  JSON.stringify({ at: at.toISOString(), ...entry })

const record = (entry: Record<string, unknown>): void => {
  const line = crashLine(new Date(), entry)
  console.error(`process gone: ${line}`)
  try {
    const dir = app.getPath('logs')
    fs.mkdirSync(dir, { recursive: true })
    fs.appendFileSync(join(dir, 'process-crashes.log'), `${line}\n`)
  } catch {
    // A log that cannot be written must not take the app down with it.
  }
}

/** Keep minidumps locally in dev. Called before `ready`, as Electron asks. */
export function startCrashDumps(dev: boolean): void {
  if (dev) crashReporter.start({ uploadToServer: false })
}

/** Log every child process that goes: the GPU process, utilities, a page. */
export function watchProcessCrashes(): void {
  app.on('child-process-gone', (_event, details) => {
    record({
      process: details.type,
      ...(details.name ? { name: details.name } : {}),
      ...(details.serviceName ? { service: details.serviceName } : {}),
      reason: details.reason,
      exitCode: details.exitCode
    })
  })
}

/**
 * A window's page crashed or hung: log it, and offer a reload rather than a
 * frozen window. `forgetTabs` empties the window's session and saves it.
 */
export function watchPageCrash(win: BrowserWindow, forgetTabs: () => void): void {
  const contents = win.webContents
  contents.on('unresponsive', () =>
    record({ process: 'renderer', window: win.id, reason: 'unresponsive' })
  )
  contents.on('responsive', () =>
    record({ process: 'renderer', window: win.id, reason: 'responsive' })
  )
  contents.on('render-process-gone', (_event, details) => {
    record({
      process: 'renderer',
      window: win.id,
      reason: details.reason,
      exitCode: details.exitCode
    })
    if (details.reason === 'clean-exit' || win.isDestroyed()) return
    forgetTabs()
    void dialog
      .showMessageBox(win, {
        type: 'error',
        message: 'This window stopped working',
        detail: `Its page crashed (${details.reason}, code ${details.exitCode}). Changes that were not saved are lost. The project reopens without its tabs, so the one that crashed it stays closed.`,
        buttons: ['Reload', 'Close Window'],
        defaultId: 0,
        cancelId: 1,
        // Windows would otherwise render the buttons as command links.
        noLink: true
      })
      .then(({ response }) => {
        if (win.isDestroyed()) return
        // Close skips the unsaved-changes round trip: the page that answers it is gone.
        if (response === 0) contents.reload()
        else win.destroy()
      })
  })
}
