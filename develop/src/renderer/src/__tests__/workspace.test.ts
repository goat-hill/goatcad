import { describe, expect, it } from 'vitest'
import { renderMarkdown, workspaceMediaUrl } from '../workspace'

describe('workspaceMediaUrl', () => {
  it('encodes each path segment', () => {
    expect(workspaceMediaUrl('/tmp/a demo/review.png')).toBe(
      'goatherd-media://local/tmp/a%20demo/review.png'
    )
  })
})

describe('renderMarkdown', () => {
  it('escapes source HTML and resolves local images through the media scheme', () => {
    const mediaUrl = workspaceMediaUrl('/tmp/demo/review.md')

    expect(
      renderMarkdown('# Review\n\n![Board](board image.png)\n\n<script>alert(1)</script>', mediaUrl)
    ).toBe(
      '<h1>Review</h1>\n<p><img alt="Board" src="goatherd-media://local/tmp/demo/board%20image.png" /></p>\n<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>'
    )
  })
})
