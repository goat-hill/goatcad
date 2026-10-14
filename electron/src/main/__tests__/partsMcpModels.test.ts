import { describe, expect, test } from 'vitest'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  emptyModelManifest,
  hostOf,
  isFetchableModelUrl,
  isLegalModelName,
  isStepFileName,
  looksLikeStep,
  modelFileName,
  parseModelManifest,
  serializeModelManifest,
  upsertModel,
  type ModelRecord
} from '../partsMcpModels'
import { cacheModel, modelStoreFor, projectStem } from '../partsMcpModelStore'
import { measureMeshes } from '../modelBounds'
import type { StepMeshData } from '../../preload/modelTypes'

const record = (over: Partial<ModelRecord> = {}): ModelRecord => ({
  file: 'SOT-23-5.step',
  source: 'manufacturer',
  fetchedAt: 1,
  bytes: 10,
  sha256: 'abc',
  ...over
})

describe('naming', () => {
  test('refuses what a file system refuses, rather than sanitizing it', () => {
    expect(isLegalModelName('SOT-23-5')).toBe(true)
    expect(isLegalModelName('Molex_5055670671')).toBe(true)
    expect(isLegalModelName('a/b')).toBe(false)
    expect(isLegalModelName('C:evil')).toBe(false)
    // A leading dot would hide the file from every listing that shows the folder.
    expect(isLegalModelName('.hidden')).toBe(false)
  })

  test('always writes .step', () => {
    expect(modelFileName(' SOT-23-5 ')).toBe('SOT-23-5.step')
    expect(isStepFileName('part.STP')).toBe(true)
    expect(isStepFileName('part.wrl')).toBe(false)
  })
})

describe('what counts as a STEP file', () => {
  const bytes = (text: string): Uint8Array => new TextEncoder().encode(text)

  test('reads the ISO header, past whitespace and a byte-order mark', () => {
    expect(looksLikeStep(bytes('ISO-10303-21;\nHEADER;'))).toBe(true)
    expect(looksLikeStep(bytes('﻿  ISO-10303-21;'))).toBe(true)
  })

  test("a vendor's HTML error page is not one", () => {
    expect(looksLikeStep(bytes('<!DOCTYPE html><html><body>Not found'))).toBe(false)
    expect(looksLikeStep(new Uint8Array([0x50, 0x4b, 0x03, 0x04]))).toBe(false)
  })
})

describe('provenance', () => {
  test('records the host the bytes came from, beside the claim', () => {
    expect(hostOf('https://cdn.example.com/a/b.step')).toBe('cdn.example.com')
    expect(hostOf('not a url')).toBeUndefined()
    expect(hostOf(undefined)).toBeUndefined()
  })

  test('http is not fetched; https is', () => {
    expect(isFetchableModelUrl('https://example.com/a.step')).toBe(true)
    expect(isFetchableModelUrl('http://example.com/a.step')).toBe(false)
    expect(isFetchableModelUrl('file:///etc/passwd')).toBe(false)
  })
})

describe('the manifest', () => {
  test('replaces the entry for a file rather than appending a second', () => {
    const once = upsertModel(emptyModelManifest(), record())
    const twice = upsertModel(once, record({ bytes: 20 }))
    expect(twice.models).toHaveLength(1)
    expect(twice.models[0].bytes).toBe(20)
  })

  test('sorts, so the committed diff is readable', () => {
    const manifest = upsertModel(
      upsertModel(emptyModelManifest(), record({ file: 'z.step' })),
      record({ file: 'a.step' })
    )
    expect(manifest.models.map((entry) => entry.file)).toEqual(['a.step', 'z.step'])
  })

  test('survives anything on disk: the models are the real content', () => {
    expect(parseModelManifest(null).models).toEqual([])
    expect(parseModelManifest('{ truncated').models).toEqual([])
    expect(parseModelManifest('{"version":1}').models).toEqual([])
  })
})

describe('where the models go', () => {
  test('is named after the project file, as KiCad names a .3dshapes folder', () => {
    const dir = mkdtempSync(join(tmpdir(), 'goatcad-models-'))
    writeFileSync(join(dir, 'phone-omenal.kicad_pro'), '{}')
    expect(projectStem(dir)).toBe('phone-omenal')
    const store = modelStoreFor(dir)
    expect(store.token).toBe('phone-omenal.3dshapes')
    expect(store.dir).toBe(join(dir, 'phone-omenal.3dshapes'))
  })

  test('falls back to the folder name when no project file names it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'goatcad-noproject-'))
    expect(modelStoreFor(dir).token).toBe(`${dir.split('/').pop()}.3dshapes`)
  })
})

describe('measuring a tessellated model', () => {
  const mesh = (positions: number[], indices: number[]): StepMeshData => ({
    name: 'm',
    color: null,
    faceColors: [],
    positions: new Float32Array(positions),
    normals: null,
    indices: new Uint32Array(indices)
  })

  test('is the box over every vertex of every mesh', () => {
    const measured = measureMeshes([mesh([0, 0, 0, 1, 2, 3], [0, 1, 0]), mesh([-1, 0, 0.5], [])])
    expect(measured.bounds).toEqual({
      w: 2,
      h: 2,
      d: 3,
      min: { x: -1, y: 0, z: 0 },
      max: { x: 1, y: 2, z: 3 }
    })
    expect(measured.triangles).toBe(1)
    expect(measured.meshes).toBe(2)
  })

  test('a file that tessellated to nothing has no box', () => {
    expect(measureMeshes([]).bounds).toBeNull()
  })
})

describe('the manifest a project commits', () => {
  test("reads an older manifest's originalPath and writes it back without one", () => {
    const old = JSON.stringify({
      version: 1,
      models: [{ ...record(), originalPath: '/tmp/x.step' }]
    })
    const manifest = parseModelManifest(old)
    expect(manifest.models[0].file).toBe('SOT-23-5.step')
    expect(serializeModelManifest(manifest)).not.toContain('originalPath')
  })

  test('an adopted file leaves no local path behind', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'goatcad-adopt-'))
    const source = join(dir, 'x.step')
    writeFileSync(source, 'ISO-10303-21;\nEND-ISO-10303-21;\n')
    const mesh: StepMeshData = {
      name: 'm',
      color: null,
      faceColors: [],
      positions: new Float32Array([0, 0, 0, 1, 1, 1, 1, 0, 0]),
      normals: null,
      indices: new Uint32Array([0, 1, 2])
    }
    const outcome = await cacheModel(
      dir,
      { name: 'X', source: 'user', filePath: source },
      () => Promise.reject(new Error('no fetch')),
      async () => ({ success: true, meshes: [mesh] }),
      7
    )
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(outcome.record).not.toHaveProperty('originalPath')
    expect(readFileSync(modelStoreFor(dir).manifestPath, 'utf8')).not.toContain(source)
  })
})
