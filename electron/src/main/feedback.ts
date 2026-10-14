/**
 * Share app feedback (Help ▸ Share App Feedback…, and the activity bar).
 *
 * Feedback is a GitHub issue the user files themselves: the renderer builds a
 * prefilled new-issue link (lib/feedback.ts) and main opens it in the default
 * browser, so nothing leaves the machine until the user posts it there. Main's
 * part is what the renderer cannot know — the install, the OS, the build — a
 * screenshot of the window, and the one URL it will open.
 *
 * The screenshot is taken before the dialog draws, so it shows the app and not
 * the dialog. It stays here, per window, until the user copies it to the
 * clipboard to paste into the issue, since a link cannot carry a file.
 */

import { app, clipboard, ClipboardItem, ipcMain, screen, shell } from 'electron'
import type { NativeImage, WebContents } from 'electron'
import { readFile } from 'node:fs/promises'
import { release } from 'node:os'
import type { FeedbackSystemInfo } from '../preload/feedbackTypes'

/** Keep in sync with FEEDBACK_ISSUE_URL in renderer lib/feedback.ts, which builds the link. */
const ISSUE_URL = 'https://github.com/goat-hill/goatcad/issues/new'

/** The only link `feedback:open-issue` opens: the repo's new-issue page, with any query. */
export const isFeedbackIssueUrl = (raw: unknown): raw is string => {
  if (typeof raw !== 'string') return false
  try {
    const url = new URL(raw)
    const expected = new URL(ISSUE_URL)
    return url.origin === expected.origin && url.pathname === expected.pathname && !url.hash
  } catch {
    return false
  }
}

export const buildChannel = (deps: {
  isPackaged: boolean
  official: boolean
}): FeedbackSystemInfo['channel'] => {
  if (!deps.isPackaged) return 'dev'
  return deps.official ? 'release' : 'source'
}

/** Which installer put it here, as electron-builder.yml ships them; matters most to update bugs. */
export const installKind = (deps: {
  platform: NodeJS.Platform
  isPackaged: boolean
  env: NodeJS.ProcessEnv
}): string => {
  if (!deps.isPackaged) return 'unpackaged'
  if (deps.platform === 'darwin') return 'dmg'
  if (deps.platform === 'win32') return 'nsis'
  // electron-builder's AppImage launcher sets APPIMAGE (updater.ts relies on it too).
  if (deps.platform === 'linux') return deps.env.APPIMAGE ? 'AppImage' : 'deb'
  return 'unknown'
}

/** `PRETTY_NAME` from an os-release file, the distribution's own name for itself. */
export const prettyNameFromOsRelease = (text: string): string | null => {
  const line = text.split('\n').find((l) => l.startsWith('PRETTY_NAME='))
  if (!line) return null
  const value = line
    .slice('PRETTY_NAME='.length)
    .trim()
    .replace(/^(["'])(.*)\1$/, '$2')
  return value || null
}

/**
 * The OS as a person quotes it. On Linux the kernel alone says little, so the
 * distribution leads and the kernel follows; macOS and Windows report their
 * own version through `process.getSystemVersion()`.
 */
export const osLabel = (deps: {
  platform: NodeJS.Platform
  systemVersion: string
  kernel: string
  distribution: string | null
}): string => {
  if (deps.platform === 'darwin') return `macOS ${deps.systemVersion}`
  if (deps.platform === 'win32') return `Windows ${deps.systemVersion}`
  if (deps.platform === 'linux') {
    return deps.distribution
      ? `${deps.distribution} (Linux ${deps.kernel})`
      : `Linux ${deps.kernel}`
  }
  return `${deps.platform} ${deps.systemVersion}`
}

const readDistribution = async (): Promise<string | null> => {
  for (const path of ['/etc/os-release', '/usr/lib/os-release']) {
    try {
      return prettyNameFromOsRelease(await readFile(path, 'utf8'))
    } catch {
      // The other path, or no name at all: the kernel still identifies it.
    }
  }
  return null
}

const systemInfo = async (): Promise<FeedbackSystemInfo> => {
  const platform = process.platform
  return {
    version: app.getVersion(),
    channel: buildChannel({ isPackaged: app.isPackaged, official: __GOATCAD_BUILD__.official }),
    commit: __GOATCAD_BUILD__.commit,
    platform,
    os: osLabel({
      platform,
      systemVersion: process.getSystemVersion(),
      kernel: release(),
      distribution: platform === 'linux' ? await readDistribution() : null
    }),
    arch: process.arch,
    install: installKind({ platform, isPackaged: app.isPackaged, env: process.env }),
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    systemLocale: app.getSystemLocale(),
    scaleFactor: screen.getPrimaryDisplay().scaleFactor
  }
}

/** Wide enough to recognize in the dialog, small enough to send over IPC as a data URL. */
const THUMBNAIL_WIDTH = 640

/**
 * GitHub refuses an issue image over 10 MB, and a HiDPI capture of a busy
 * board can be larger as PNG. Stay under it with room for MB-vs-MiB rounding.
 */
export const GITHUB_IMAGE_MAX_BYTES = 9_000_000

/** The parts of a NativeImage `pngWithin` uses, so the rule is testable without electron. */
interface ScalableImage {
  toPNG(): Buffer
  getSize(): { width: number; height: number }
  resize(options: { width: number; quality: 'best' }): ScalableImage
}

/**
 * The image as PNG no larger than `maxBytes`, scaled down from the original
 * until it fits; null when it never does. PNG bytes grow roughly with area, so
 * each step shrinks the width by the square root of the overshoot.
 */
export const pngWithin = (image: ScalableImage, maxBytes: number): Buffer | null => {
  let png = image.toPNG()
  let { width } = image.getSize()
  for (let attempt = 0; attempt < 6 && png.length > maxBytes; attempt++) {
    width = Math.floor(width * Math.min(0.9, 0.95 * Math.sqrt(maxBytes / png.length)))
    if (width < 1) return null
    png = image.resize({ width, quality: 'best' }).toPNG()
  }
  return png.length <= maxBytes ? png : null
}

/** The last capture per window, until the dialog closes; weak, so a closed window drops its own. */
const screenshots = new WeakMap<WebContents, NativeImage>()

export function registerFeedbackIpc(): void {
  ipcMain.handle('feedback:system-info', () => systemInfo())

  // The page only, never the desktop: the window's own content is all the
  // report is about, and all the user has agreed to show.
  ipcMain.handle('feedback:capture', async (event): Promise<string | null> => {
    try {
      const image = await event.sender.capturePage()
      if (image.isEmpty()) return null
      screenshots.set(event.sender, image)
      const { width } = image.getSize()
      const thumbnail =
        width > THUMBNAIL_WIDTH ? image.resize({ width: THUMBNAIL_WIDTH, quality: 'good' }) : image
      return thumbnail.toDataURL()
    } catch (err) {
      console.warn('[feedback] capture failed', err)
      return null
    }
  })

  ipcMain.handle('feedback:copy-screenshot', async (event): Promise<boolean> => {
    const image = screenshots.get(event.sender)
    if (!image) return false
    try {
      const bytes = pngWithin(image, GITHUB_IMAGE_MAX_BYTES)
      if (!bytes) return false
      const png = new Blob([new Uint8Array(bytes)], { type: 'image/png' })
      await clipboard.write([new ClipboardItem({ 'image/png': png })])
      return true
    } catch (err) {
      console.warn('[feedback] could not copy the screenshot', err)
      return false
    }
  })

  ipcMain.handle('feedback:discard', (event): void => {
    screenshots.delete(event.sender)
  })

  ipcMain.handle('feedback:open-issue', async (_event, url: unknown): Promise<boolean> => {
    if (!isFeedbackIssueUrl(url)) return false
    try {
      await shell.openExternal(url)
      return true
    } catch (err) {
      // No browser registered, or xdg-open missing: the dialog offers the link to copy.
      console.warn('[feedback] could not open the browser', err)
      return false
    }
  })
}
