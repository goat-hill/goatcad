/**
 * Share app feedback: the prefilled GitHub issue (main/feedback.ts opens it).
 *
 * The link fills the repo's issue forms (`.github/ISSUE_TEMPLATE/*.yml`) by
 * field id, so the ids here and there must agree. A link cannot carry a file,
 * which is why the screenshot travels by clipboard instead.
 */
import type { FeedbackSystemInfo } from '../../../preload/feedbackTypes'

/** Keep in sync with ISSUE_URL in main/feedback.ts, which refuses any other link. */
export const FEEDBACK_ISSUE_URL = 'https://github.com/goat-hill/goatcad/issues/new'

export type FeedbackKind = 'bug' | 'idea'

/** The issue form each kind opens. */
const TEMPLATES: Record<FeedbackKind, string> = { bug: 'bug.yml', idea: 'idea.yml' }

/**
 * GitHub answers a longer link with 414 rather than a form, so the
 * description gives way first; the rest of the link is small and fixed.
 */
export const MAX_ISSUE_URL_LENGTH = 8000
/** GitHub's own limit on an issue title. */
const MAX_TITLE_LENGTH = 256

export interface FeedbackDraft {
  kind: FeedbackKind
  title: string
  description: string
  /** Null when the user left system info out. */
  systemInfo: string | null
}

export interface FeedbackLink {
  url: string
  /** The description was cut to fit the link. */
  truncated: boolean
}

/** What only the renderer knows, beside main's report. */
export interface RendererInfo {
  /** The language GoatCAD is shown in. */
  uiLocale: string
  /** The WebGL renderer string, or null where the browser hides it. */
  gpu: string | null
}

/**
 * The block the issue's System info field receives. English on purpose: it is
 * read by whoever triages, not by the reporter, and it is the same block in
 * every language the app is shown in.
 */
export const formatSystemInfo = (info: FeedbackSystemInfo, renderer: RendererInfo): string => {
  const build = [`GoatCAD ${info.version}`, info.channel, info.commit].filter(Boolean)
  return [
    build.join(' · '),
    `${info.os} · ${info.arch} · ${info.install}`,
    `Electron ${info.electron} · Chromium ${info.chrome}`,
    `Locale: ${info.systemLocale} · UI: ${renderer.uiLocale}`,
    `Display scale: ${info.scaleFactor}`,
    `GPU: ${renderer.gpu ?? 'unknown'}`
  ].join('\n')
}

const param = (key: string, value: string): string =>
  `&${encodeURIComponent(key)}=${encodeURIComponent(value)}`

/** The longest prefix of `text` (whole code points) whose encoding fits in `budget`. */
const fitPrefix = (text: string, budget: number): string => {
  const chars = Array.from(text)
  let lo = 0
  let hi = chars.length
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2)
    if (encodeURIComponent(chars.slice(0, mid).join('')).length <= budget) lo = mid
    else hi = mid - 1
  }
  return chars.slice(0, lo).join('')
}

/** The new-issue link for a draft, the description cut to fit if it must be. */
export const feedbackIssueLink = (draft: FeedbackDraft): FeedbackLink => {
  const title = Array.from(draft.title.trim()).slice(0, MAX_TITLE_LENGTH).join('')
  let base = `${FEEDBACK_ISSUE_URL}?template=${TEMPLATES[draft.kind]}`
  if (title) base += param('title', title)
  if (draft.systemInfo) base += param('system-info', draft.systemInfo)

  const description = draft.description.trim()
  if (!description) return { url: base, truncated: false }
  const whole = base + param('description', description)
  if (whole.length <= MAX_ISSUE_URL_LENGTH) return { url: whole, truncated: false }

  const ellipsis = '…'
  const budget =
    MAX_ISSUE_URL_LENGTH -
    base.length -
    param('description', '').length -
    encodeURIComponent(ellipsis).length
  const cut = fitPrefix(description, budget).trimEnd()
  return { url: base + param('description', cut + ellipsis), truncated: true }
}

/** The GPU as WebGL names it; ANGLE's string carries the vendor, model and backend. */
export const webglRenderer = (): string | null => {
  try {
    const gl = document.createElement('canvas').getContext('webgl2')
    if (!gl) return null
    const debug = gl.getExtension('WEBGL_debug_renderer_info')
    const name: unknown = gl.getParameter(debug ? debug.UNMASKED_RENDERER_WEBGL : gl.RENDERER)
    gl.getExtension('WEBGL_lose_context')?.loseContext()
    return typeof name === 'string' && name ? name : null
  } catch {
    return null
  }
}
