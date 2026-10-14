import { describe, expect, it } from 'vitest'
import { datasheetTarget, datasheetUrl } from '../datasheet'

describe('datasheetUrl', () => {
  it('takes a web address and gives a bare www host its scheme', () => {
    expect(datasheetUrl('https://ti.com/lit/ds/x.pdf')).toBe('https://ti.com/lit/ds/x.pdf')
    expect(datasheetUrl('www.st.com/a.pdf')).toBe('https://www.st.com/a.pdf')
  })

  it('reads KiCad’s ~ and a path as no link', () => {
    expect(datasheetUrl('~')).toBeNull()
    expect(datasheetUrl('${KIPRJMOD}/datasheets/a.pdf')).toBeNull()
  })
})

describe('datasheetTarget', () => {
  it('sends a web address to the browser', () => {
    expect(datasheetTarget('https://x.com/a.pdf', '/p')).toEqual({
      kind: 'url',
      url: 'https://x.com/a.pdf'
    })
  })

  it('resolves a project file against the design folder', () => {
    expect(datasheetTarget('${KIPRJMOD}/datasheets/LM1117.pdf', '/home/u/board/')).toEqual({
      kind: 'file',
      path: '/home/u/board/datasheets/LM1117.pdf'
    })
    expect(datasheetTarget('${KIPRJMOD}/datasheets/a.pdf', 'C:\\work\\board')).toEqual({
      kind: 'file',
      path: 'C:\\work\\board\\datasheets/a.pdf'
    })
    expect(datasheetTarget('${KIPRJMOD}/a.pdf', null)).toBeNull()
  })

  it('takes an absolute path as it is and nothing else', () => {
    expect(datasheetTarget('/opt/ds/a.pdf', '/p')).toEqual({ kind: 'file', path: '/opt/ds/a.pdf' })
    expect(datasheetTarget('ds/a.pdf', '/p')).toBeNull()
    expect(datasheetTarget('~', '/p')).toBeNull()
    expect(datasheetTarget('', '/p')).toBeNull()
  })
})
