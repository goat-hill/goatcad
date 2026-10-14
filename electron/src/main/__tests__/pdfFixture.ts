/** Hand-built PDFs for the reader tests: text placed at points, optional
 *  bookmarks, no compression, so a failure is readable in the file. */

export interface PlacedText {
  x: number
  /** From the top of the page, like the reader's coordinates. */
  y: number
  text: string
  size?: number
}

export interface FixturePage {
  items: PlacedText[]
}

export interface FixtureBookmark {
  title: string
  page: number
  children?: FixtureBookmark[]
}

const PAGE_W = 612
const PAGE_H = 792

const escape = (text: string): string => text.replace(/[\\()]/g, (c) => `\\${c}`)

export function buildPdf(pages: FixturePage[], bookmarks: FixtureBookmark[] = []): Buffer {
  const objects: string[] = []
  const add = (body: string): number => {
    objects.push(body)
    return objects.length
  }
  const catalog = add('') // placeholder, filled last
  const pagesObj = add('')
  const font = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>')
  const pageRefs: number[] = []
  for (const page of pages) {
    const content = page.items
      .map(
        (item) =>
          `BT /F1 ${item.size ?? 10} Tf ${item.x} ${PAGE_H - item.y} Td (${escape(item.text)}) Tj ET`
      )
      .join('\n')
    const stream = add(`<< /Length ${content.length} >>\nstream\n${content}\nendstream`)
    pageRefs.push(
      add(
        `<< /Type /Page /Parent ${pagesObj} 0 R /MediaBox [0 0 ${PAGE_W} ${PAGE_H}] /Contents ${stream} 0 R /Resources << /Font << /F1 ${font} 0 R >> >> >>`
      )
    )
  }
  objects[pagesObj - 1] =
    `<< /Type /Pages /Kids [${pageRefs.map((r) => `${r} 0 R`).join(' ')}] /Count ${pageRefs.length} >>`

  let outlines: number | null = null
  if (bookmarks.length) {
    outlines = add('')
    const build = (items: FixtureBookmark[], parent: number): { first: number; last: number } => {
      const ids = items.map(() => add(''))
      items.forEach((item, i) => {
        const kids = item.children?.length ? build(item.children, ids[i]) : null
        objects[ids[i] - 1] =
          `<< /Title (${escape(item.title)}) /Parent ${parent} 0 R` +
          ` /Dest [${pageRefs[item.page - 1]} 0 R /Fit]` +
          (i > 0 ? ` /Prev ${ids[i - 1]} 0 R` : '') +
          (i < ids.length - 1 ? ` /Next ${ids[i + 1]} 0 R` : '') +
          (kids
            ? ` /First ${kids.first} 0 R /Last ${kids.last} 0 R /Count ${item.children!.length}`
            : '') +
          ' >>'
      })
      return { first: ids[0], last: ids[ids.length - 1] }
    }
    const top = build(bookmarks, outlines)
    objects[outlines - 1] =
      `<< /Type /Outlines /First ${top.first} 0 R /Last ${top.last} 0 R /Count ${bookmarks.length} >>`
  }
  objects[catalog - 1] =
    `<< /Type /Catalog /Pages ${pagesObj} 0 R` +
    (outlines ? ` /Outlines ${outlines} 0 R /PageMode /UseOutlines` : '') +
    ' >>'

  let out = '%PDF-1.4\n'
  const offsets: number[] = []
  objects.forEach((body, i) => {
    offsets.push(out.length)
    out += `${i + 1} 0 obj\n${body}\nendobj\n`
  })
  const xref = out.length
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  for (const offset of offsets) out += `${String(offset).padStart(10, '0')} 00000 n \n`
  out += `trailer\n<< /Size ${objects.length + 1} /Root ${catalog} 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return Buffer.from(out, 'latin1')
}

/** Two pages: a title page, and a spec table with MIN/TYP/MAX columns. */
export const specSheet = (): Buffer =>
  buildPdf([
    { items: [{ x: 72, y: 100, text: 'GoatCAD Test Regulator', size: 18 }] },
    {
      items: [
        { x: 72, y: 80, text: 'Electrical Characteristics', size: 14 },
        { x: 72, y: 110, text: 'PARAMETER' },
        { x: 300, y: 110, text: 'MIN' },
        { x: 360, y: 110, text: 'TYP' },
        { x: 420, y: 110, text: 'MAX' },
        { x: 480, y: 110, text: 'UNIT' },
        { x: 72, y: 130, text: 'Input voltage range' },
        { x: 300, y: 130, text: '3' },
        { x: 420, y: 130, text: '17' },
        { x: 480, y: 130, text: 'V' },
        { x: 72, y: 150, text: 'Quiescent current' },
        { x: 360, y: 150, text: '17' },
        { x: 420, y: 150, text: '30' },
        { x: 480, y: 150, text: 'uA' }
      ]
    }
  ])
