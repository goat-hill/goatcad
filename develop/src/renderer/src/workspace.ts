// Renderer-side helpers for the Workspace viewer (a worktree's .goatherd/ demos).

// Encoder for the goatherd-media:// scheme; the decoder + path fence live in
// main/mediaProtocol.ts — change the two together. Per-segment encoding keeps
// spaces and other awkward characters in file names intact.
export function workspaceMediaUrl(absPath: string): string {
  const segments = absPath.split(/[/\\]/).filter(Boolean).map(encodeURIComponent)
  return `goatherd-media://local/${segments.join('/')}`
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

// Resolve a link/image target found in a markdown file. Absolute web/data URLs
// pass through; everything else is treated as relative to the file and mapped
// onto the media scheme so embedded screenshots load. baseUrl is the media URL
// of the markdown file itself, so the standard-scheme URL parser does the
// relative resolution for us.
function makeResolver(baseUrl: string): (target: string) => string {
  return (target) => {
    if (/^(https?:|data:|mailto:|goatherd-media:)/i.test(target)) return target
    try {
      return new URL(target, baseUrl).toString()
    } catch {
      return target
    }
  }
}

// Sentinels for shielding inline-code spans from the emphasis/link passes; NUL
// can't appear in the escaped text, so the placeholder can't collide with prose.
const CODE_OPEN = '\u0000'
const CODE_CLOSE = '\u0001'

function renderInline(text: string, resolve: (target: string) => string): string {
  let out = escapeHtml(text)
  const codes: string[] = []
  out = out.replace(/`([^`]+)`/g, (_m, code: string) => {
    codes.push(code)
    return `${CODE_OPEN}${codes.length - 1}${CODE_CLOSE}`
  })
  out = out.replace(
    /!\[([^\]]*)\]\(([^)]+)\)/g,
    (_m, alt: string, src: string) => `<img alt="${alt}" src="${resolve(src)}" />`
  )
  out = out.replace(
    /\[([^\]]+)\]\(([^)]+)\)/g,
    (_m, label: string, href: string) => `<a href="${resolve(href)}">${label}</a>`
  )
  out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
  out = out.replace(/\*([^*]+)\*/g, '<em>$1</em>')
  out = out.replace(/(^|\W)_([^_]+)_(?=\W|$)/g, '$1<em>$2</em>')
  out = out.replace(
    new RegExp(`${CODE_OPEN}(\\d+)${CODE_CLOSE}`, 'g'),
    (_m, n: string) => `<code>${codes[Number(n)]}</code>`
  )
  return out
}

const BLOCK_BREAK = /^(#{1,6}\s|>|\s*[-*+]\s|```)/

// A deliberately small Markdown-to-HTML renderer: enough for an agent to wrap a
// demo with headings, prose, lists, code, and — the point — embedded images.
// Raw HTML in the source is escaped, so a rendered .md can't inject scripts;
// agents wanting rich, trusted markup drop a .html file (shown in a sandboxed
// iframe) instead.
export function renderMarkdown(source: string, mediaUrl: string): string {
  const resolve = makeResolver(mediaUrl)
  const lines = source.replace(/\r\n?/g, '\n').split('\n')
  const html: string[] = []
  let inList = false
  const closeList = (): void => {
    if (inList) {
      html.push('</ul>')
      inList = false
    }
  }

  let i = 0
  while (i < lines.length) {
    const line = lines[i]

    if (/^```/.test(line)) {
      closeList()
      const body: string[] = []
      i++
      while (i < lines.length && !/^```/.test(lines[i])) {
        body.push(lines[i])
        i++
      }
      i++ // consume the closing fence
      html.push(`<pre><code>${escapeHtml(body.join('\n'))}</code></pre>`)
      continue
    }

    const heading = line.match(/^(#{1,6})\s+(.*)$/)
    if (heading) {
      closeList()
      const level = heading[1].length
      html.push(`<h${level}>${renderInline(heading[2], resolve)}</h${level}>`)
      i++
      continue
    }

    if (/^(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      closeList()
      html.push('<hr />')
      i++
      continue
    }

    const quote = line.match(/^>\s?(.*)$/)
    if (quote) {
      closeList()
      html.push(`<blockquote>${renderInline(quote[1], resolve)}</blockquote>`)
      i++
      continue
    }

    const item = line.match(/^\s*[-*+]\s+(.*)$/)
    if (item) {
      if (!inList) {
        html.push('<ul>')
        inList = true
      }
      html.push(`<li>${renderInline(item[1], resolve)}</li>`)
      i++
      continue
    }

    if (/^\s*$/.test(line)) {
      closeList()
      i++
      continue
    }

    // Paragraph: gather following lines until a blank line or a block starter.
    closeList()
    const para = [line]
    i++
    while (i < lines.length && !/^\s*$/.test(lines[i]) && !BLOCK_BREAK.test(lines[i])) {
      para.push(lines[i])
      i++
    }
    html.push(`<p>${renderInline(para.join(' '), resolve)}</p>`)
  }

  closeList()
  return html.join('\n')
}
