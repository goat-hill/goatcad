import { describe, expect, it } from 'vitest'
import {
  FEEDBACK_ISSUE_URL,
  MAX_ISSUE_URL_LENGTH,
  feedbackIssueLink,
  formatSystemInfo
} from '../feedback'
import type { FeedbackSystemInfo } from '../../../../preload/feedbackTypes'

const params = (url: string): URLSearchParams => new URL(url).searchParams

describe('feedbackIssueLink', () => {
  it('prefills the kind’s form by field id', () => {
    const { url, truncated } = feedbackIssueLink({
      kind: 'idea',
      title: '  Panelize boards  ',
      description: 'Tabs & mouse bites, 50% of the time',
      systemInfo: 'GoatCAD 1.0'
    })
    expect(url.startsWith(`${FEEDBACK_ISSUE_URL}?`)).toBe(true)
    expect(truncated).toBe(false)
    const q = params(url)
    expect(q.get('template')).toBe('idea.yml')
    expect(q.get('title')).toBe('Panelize boards')
    expect(q.get('description')).toBe('Tabs & mouse bites, 50% of the time')
    expect(q.get('system-info')).toBe('GoatCAD 1.0')
  })

  it('leaves out what is empty or withheld', () => {
    const q = params(
      feedbackIssueLink({ kind: 'bug', title: ' ', description: '', systemInfo: null }).url
    )
    expect([...q.keys()]).toEqual(['template'])
    expect(q.get('template')).toBe('bug.yml')
  })

  it('cuts the description to fit the link, on a whole character', () => {
    const description = 'é'.repeat(5000)
    const { url, truncated } = feedbackIssueLink({
      kind: 'bug',
      title: 'Crash',
      description,
      systemInfo: 'info'
    })
    expect(truncated).toBe(true)
    expect(url.length).toBeLessThanOrEqual(MAX_ISSUE_URL_LENGTH)
    const sent = params(url).get('description') ?? ''
    expect(sent.endsWith('…')).toBe(true)
    expect(sent.slice(0, -1)).toMatch(/^é+$/)
    expect(params(url).get('system-info')).toBe('info')
  })
})

describe('formatSystemInfo', () => {
  const info: FeedbackSystemInfo = {
    version: '1.2.3',
    channel: 'release',
    commit: 'abc123def456',
    platform: 'linux',
    os: 'Ubuntu 24.04 (Linux 6.8.0)',
    arch: 'x64',
    install: 'AppImage',
    electron: '38.0.0',
    chrome: '140.0.0.0',
    systemLocale: 'en-US',
    scaleFactor: 2
  }

  it('reads as one line per subject', () => {
    expect(formatSystemInfo(info, { uiLocale: 'de', gpu: null })).toBe(
      [
        'GoatCAD 1.2.3 · release · abc123def456',
        'Ubuntu 24.04 (Linux 6.8.0) · x64 · AppImage',
        'Electron 38.0.0 · Chromium 140.0.0.0',
        'Locale: en-US · UI: de',
        'Display scale: 2',
        'GPU: unknown'
      ].join('\n')
    )
  })

  it('drops a commit the build did not know', () => {
    const text = formatSystemInfo(
      { ...info, commit: null, channel: 'source' },
      { uiLocale: 'en', gpu: 'ANGLE' }
    )
    expect(text.split('\n')[0]).toBe('GoatCAD 1.2.3 · source')
    expect(text.endsWith('GPU: ANGLE')).toBe(true)
  })
})
