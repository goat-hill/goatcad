import { describe, expect, it } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'fs'
import { join } from 'path'
import { DESIGN_CODE, DESIGN_REMEDY } from '../design'

const RENDERER = join(__dirname, '../../../renderer/src')

const sources = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) return name === '__tests__' ? [] : sources(path)
    return /\.(ts|vue)$/.test(name) ? [path] : []
  })

describe('window failure kinds', () => {
  it('every kind a door returns has a code and a remedy', () => {
    const kinds = new Set<string>()
    for (const file of [...sources(join(RENDERER, 'lib')), join(RENDERER, 'App.vue')]) {
      for (const match of readFileSync(file, 'utf8').matchAll(/error: '([a-z-]+)'/g)) {
        kinds.add(match[1])
      }
    }
    const missing = [...kinds].filter((kind) => !DESIGN_CODE[kind] || !DESIGN_REMEDY[kind])
    expect(missing).toEqual([])
  })
})
