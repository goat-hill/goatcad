import { describe, expect, test } from 'vitest'
import type { SchematicHierarchy } from '../hierarchy'
import {
  childInstance,
  childSheetPath,
  currentInstance,
  enteredInstancePath,
  noteEnteredInstance,
  parentInstance,
  parentSheetPath,
  sheetBreadcrumb
} from '../sheetNavigation'

// Root with a Power sheet and one file (amp.kicad_sch) used twice: the unit of
// identity is the instance path, not the file.
const tree: SchematicHierarchy = {
  rootFilePath: '/p/main.kicad_sch',
  files: ['/p/main.kicad_sch', '/p/power.kicad_sch', '/p/amp.kicad_sch', '/p/bias.kicad_sch'],
  instances: [
    { sheetPath: '/r', namePath: '/', sheetName: 'main', filePath: '/p/main.kicad_sch', depth: 0 },
    {
      sheetPath: '/r/pw',
      namePath: '/Power',
      sheetName: 'Power',
      filePath: '/p/power.kicad_sch',
      depth: 1
    },
    {
      sheetPath: '/r/a1',
      namePath: '/A1',
      sheetName: 'A1',
      filePath: '/p/amp.kicad_sch',
      depth: 1
    },
    {
      sheetPath: '/r/a1/b',
      namePath: '/A1/Bias',
      sheetName: 'Bias',
      filePath: '/p/bias.kicad_sch',
      depth: 2
    },
    {
      sheetPath: '/r/a2',
      namePath: '/A2',
      sheetName: 'A2',
      filePath: '/p/amp.kicad_sch',
      depth: 1
    },
    {
      sheetPath: '/r/a2/b',
      namePath: '/A2/Bias',
      sheetName: 'Bias',
      filePath: '/p/bias.kicad_sch',
      depth: 2
    }
  ]
}

describe('sheet paths', () => {
  test('a child path is the parent path and the sheet node uuid', () => {
    expect(childSheetPath('/r', 'a1')).toBe('/r/a1')
    expect(childSheetPath('/r/a1/', 'b')).toBe('/r/a1/b')
  })

  test('the parent of the root is none', () => {
    expect(parentSheetPath('/r/a1/b')).toBe('/r/a1')
    expect(parentSheetPath('/r/a1')).toBe('/r')
    expect(parentSheetPath('/r')).toBeNull()
  })
})

describe('the instance a view shows', () => {
  test('the one entered through, while it is still an instance of the file', () => {
    expect(currentInstance(tree, '/p/amp.kicad_sch', '/r/a2')?.namePath).toBe('/A2')
  })

  test('otherwise the first in the tree', () => {
    expect(currentInstance(tree, '/p/amp.kicad_sch')?.sheetPath).toBe('/r/a1')
    // A path of another file is not this file's instance.
    expect(currentInstance(tree, '/p/amp.kicad_sch', '/r/pw')?.sheetPath).toBe('/r/a1')
  })

  test('files compare across separators and case', () => {
    expect(currentInstance(tree, '\\P\\AMP.kicad_sch', '/r/a2')?.sheetPath).toBe('/r/a2')
  })

  test('no tree, no instance', () => {
    expect(currentInstance(null, '/p/amp.kicad_sch')).toBeNull()
  })
})

describe('entering and leaving', () => {
  test('entering a box from a reused sheet reaches that instance of the child', () => {
    expect(childInstance(tree, '/r/a2', 'b')?.namePath).toBe('/A2/Bias')
    expect(childInstance(tree, '/r/a2', 'nope')).toBeNull()
  })

  test('leaving returns to the instance above, not the file’s first', () => {
    expect(parentInstance(tree, '/r/a2/b')?.sheetPath).toBe('/r/a2')
    expect(parentInstance(tree, '/r')).toBeNull()
  })

  test('the breadcrumb runs from the root down', () => {
    expect(sheetBreadcrumb(tree, '/r/a2/b').map((crumb) => crumb.sheetName)).toEqual([
      'main',
      'A2',
      'Bias'
    ])
    expect(sheetBreadcrumb(tree, '/r').map((crumb) => crumb.sheetPath)).toEqual(['/r'])
  })

  test('the entered path is remembered per file', () => {
    noteEnteredInstance('/p/Amp.kicad_sch', '/r/a2')
    expect(enteredInstancePath('/p/amp.kicad_sch')).toBe('/r/a2')
    expect(enteredInstancePath('/p/power.kicad_sch')).toBeUndefined()
  })
})
