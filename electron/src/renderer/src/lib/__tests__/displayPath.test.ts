import { describe, expect, it } from 'vitest'
import { abbreviateHome, displayFilePath, pathInProject } from '../displayPath'

describe('abbreviateHome', () => {
  it('replaces the home prefix with a tilde', () => {
    expect(abbreviateHome('/home/ada/pcb/psu', '/home/ada')).toBe('~/pcb/psu')
  })

  it('renders the home directory itself as a bare tilde', () => {
    expect(abbreviateHome('/home/ada', '/home/ada')).toBe('~')
    expect(abbreviateHome('/home/ada/', '/home/ada')).toBe('~')
  })

  it('leaves a path outside home alone', () => {
    expect(abbreviateHome('/opt/designs/psu', '/home/ada')).toBe('/opt/designs/psu')
  })

  it('does not treat a same-prefixed sibling as being under home', () => {
    // `/home/adalovelace` starts with `/home/ada` as a string but is a different
    // directory — the compare is segment-wise, not a prefix match.
    expect(abbreviateHome('/home/adalovelace/psu', '/home/ada')).toBe('/home/adalovelace/psu')
  })

  it('preserves Windows separators', () => {
    expect(abbreviateHome('C:\\Users\\Ada\\pcb\\psu', 'C:\\Users\\Ada')).toBe('~\\pcb\\psu')
  })

  it('matches case-insensitively, as macOS and Windows resolve paths', () => {
    expect(abbreviateHome('/Home/Ada/pcb', '/home/ada')).toBe('~/pcb')
  })

  it('passes the path through when home is unknown', () => {
    expect(abbreviateHome('/home/ada/pcb', null)).toBe('/home/ada/pcb')
    expect(abbreviateHome('/home/ada/pcb', '')).toBe('/home/ada/pcb')
  })
})

describe('pathInProject', () => {
  it('gives a file inside the project from the project folder, in forward slashes', () => {
    expect(pathInProject('/home/ada/psu/boards/main.kicad_pcb', '/home/ada/psu')).toBe(
      'boards/main.kicad_pcb'
    )
    expect(pathInProject('C:\\pcb\\psu\\main.kicad_pcb', 'c:\\PCB\\psu\\')).toBe('main.kicad_pcb')
  })

  it('is null outside the project, for the folder itself, and with no project', () => {
    expect(pathInProject('/home/ada/psu-old/main.kicad_pcb', '/home/ada/psu')).toBeNull()
    expect(pathInProject('/home/ada/psu', '/home/ada/psu')).toBeNull()
    expect(pathInProject('/home/ada/psu/main.kicad_pcb', null)).toBeNull()
  })
})

describe('displayFilePath', () => {
  it('is project-relative inside the project, else home-abbreviated', () => {
    expect(displayFilePath('/home/ada/psu/main.kicad_pcb', '/home/ada/psu', '/home/ada')).toBe(
      'main.kicad_pcb'
    )
    expect(displayFilePath('/home/ada/other/x.kicad_pcb', '/home/ada/psu', '/home/ada')).toBe(
      '~/other/x.kicad_pcb'
    )
  })
})
