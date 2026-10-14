import { describe, expect, it } from 'vitest'
import { isProjectEntry, splitRecents } from '../recents'
import type { RecentEntry } from '../../../../preload/recentTypes'

const withProject: RecentEntry = {
  kind: 'project',
  path: '/pcb/psu/psu.kicad_pro',
  workspaceRoot: '/pcb/psu',
  projectPath: '/pcb/psu/psu.kicad_pro'
}
const bareFolder: RecentEntry = {
  kind: 'project',
  path: '/notes',
  workspaceRoot: '/notes',
  projectPath: null
}
const fileInProject: RecentEntry = {
  kind: 'file',
  path: '/pcb/psu/main.kicad_sch',
  workspaceRoot: '/pcb/psu',
  projectPath: '/pcb/psu/psu.kicad_pro'
}
const looseFile: RecentEntry = {
  kind: 'file',
  path: '/notes/scratch.kicad_sch',
  workspaceRoot: '/notes',
  projectPath: null
}

describe('isProjectEntry', () => {
  it('is true only for an entry that carries a project context', () => {
    expect(isProjectEntry(withProject)).toBe(true)
    expect(isProjectEntry(fileInProject)).toBe(false)
  })

  it('is false for a folder that held no project, despite its kind', () => {
    // The case that shipped wrong once: kind alone put this above the projects.
    expect(bareFolder.kind).toBe('project')
    expect(isProjectEntry(bareFolder)).toBe(false)
  })
})

describe('splitRecents', () => {
  it('groups folders-without-projects with the files, not the projects', () => {
    const { projects, files } = splitRecents([withProject, bareFolder, fileInProject, looseFile])
    expect(projects.map((r) => r.path)).toEqual(['/pcb/psu/psu.kicad_pro'])
    expect(files.map((r) => r.path)).toEqual([
      '/notes',
      '/pcb/psu/main.kicad_sch',
      '/notes/scratch.kicad_sch'
    ])
  })

  it('preserves the incoming order within each group', () => {
    const older: RecentEntry = {
      ...withProject,
      path: '/a/a.kicad_pro',
      projectPath: '/a/a.kicad_pro'
    }
    const { projects } = splitRecents([withProject, older])
    expect(projects.map((r) => r.path)).toEqual(['/pcb/psu/psu.kicad_pro', '/a/a.kicad_pro'])
  })

  it('handles an empty list', () => {
    expect(splitRecents([])).toEqual({ projects: [], files: [] })
  })
})
