import { afterAll, describe, expect, test } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  expandModelEnvVars,
  modelExtensionVariants,
  modelPathCandidates,
  resolveModelPath
} from '../modelResolver'

describe('expandModelEnvVars', () => {
  test('expands a set env var', () => {
    expect(expandModelEnvVars('${FOO}/a.step', { FOO: '/opt' })).toBe('/opt/a.step')
  })

  test('falls back to the model dir for an unset ${KICAD*_3DMODEL_DIR}', () => {
    expect(expandModelEnvVars('${KICAD8_3DMODEL_DIR}/a.step', {}, { modelDir: '/lib/3d' })).toBe(
      '/lib/3d/a.step'
    )
  })

  test('falls back to the PCM dir for an unset ${KICAD*_3RD_PARTY}', () => {
    // Version drift is normal here: a board written against KiCad 8 points into
    // whatever tree the machine actually has.
    expect(
      expandModelEnvVars(
        '${KICAD8_3RD_PARTY}/3dmodels/x.step',
        {},
        { thirdPartyDir: '/u/3rdparty' }
      )
    ).toBe('/u/3rdparty/3dmodels/x.step')
  })

  test('leaves an unresolved token intact', () => {
    expect(expandModelEnvVars('${KICAD8_3DMODEL_DIR}/a.step', {})).toBe(
      '${KICAD8_3DMODEL_DIR}/a.step'
    )
    // Non-KiCad vars never use a fallback — `${EASYEDA2KICAD}` and friends are
    // user-defined substitutions we do not know about.
    expect(expandModelEnvVars('${NOPE}/a.step', {}, { modelDir: '/lib/3d' })).toBe('${NOPE}/a.step')
  })
})

describe('modelExtensionVariants', () => {
  test('keeps the exact spelling first, then tries the other formats', () => {
    expect(modelExtensionVariants('/lib/a.wrl')).toEqual([
      '/lib/a.wrl',
      '/lib/a.WRL',
      '/lib/a.step',
      '/lib/a.STEP',
      '/lib/a.stp',
      '/lib/a.STP'
    ])
  })

  test('an upper-case reference still tries its own format first', () => {
    const variants = modelExtensionVariants('/lib/a.STEP')
    expect(variants[0]).toBe('/lib/a.STEP')
    expect(variants).toContain('/lib/a.step')
    expect(variants).toContain('/lib/a.wrl')
  })

  test('substitutes only the extension, never a directory dot', () => {
    // KiCad's library dirs are named `Foo.3dshapes`, so the dot that matters is
    // the last one *after* the final separator.
    expect(modelExtensionVariants('/lib/Resistor_SMD.3dshapes/R_0603.wrl')).toContain(
      '/lib/Resistor_SMD.3dshapes/R_0603.step'
    )
    expect(modelExtensionVariants('/lib/Foo.3dshapes/bare')).toEqual(['/lib/Foo.3dshapes/bare'])
  })

  test('leaves an extensionless path alone rather than inventing a file', () => {
    expect(modelExtensionVariants('/lib/a')).toEqual(['/lib/a'])
    expect(modelExtensionVariants('/lib/.hidden')).toEqual(['/lib/.hidden'])
  })
})

describe('modelPathCandidates', () => {
  test('an expanded absolute path yields its extension variants', () => {
    expect(
      modelPathCandidates(
        '${KICAD8_3DMODEL_DIR}/a.step',
        '/proj/fp',
        '/proj',
        {},
        { KICAD8_3DMODEL_DIR: '/opt/kicad/3d' }
      )
    ).toEqual([
      '/opt/kicad/3d/a.step',
      '/opt/kicad/3d/a.STEP',
      '/opt/kicad/3d/a.stp',
      '/opt/kicad/3d/a.STP',
      '/opt/kicad/3d/a.wrl',
      '/opt/kicad/3d/a.WRL'
    ])
  })

  test('a relative path explores each directory fully before the next', () => {
    // Specificity beats format: the footprint's own directory gets every
    // extension tried before the project directory is looked at at all.
    const candidates = modelPathCandidates('sub/a.wrl', '/proj/fp', '/proj')
    expect(candidates[0]).toBe('/proj/fp/sub/a.wrl')
    expect(candidates.indexOf('/proj/fp/sub/a.step')).toBeLessThan(
      candidates.indexOf('/proj/sub/a.wrl')
    )
  })

  test('an empty path yields no candidates', () => {
    expect(modelPathCandidates('   ', '/proj/fp', '/proj')).toEqual([])
  })
})

describe('resolveModelPath', () => {
  const dir = mkdtempSync(join(tmpdir(), 'goatcad-model-'))
  writeFileSync(join(dir, 'part.step'), 'x')
  writeFileSync(join(dir, 'upper.STEP'), 'x')
  const thirdParty = join(dir, '3rdparty')
  mkdirSync(thirdParty)
  writeFileSync(join(thirdParty, 'vendor.step'), 'x')

  afterAll(() => rmSync(dir, { recursive: true, force: true }))

  test('resolves a relative path that exists in the footprint dir', () => {
    expect(resolveModelPath('part.step', dir, null)).toEqual({ path: join(dir, 'part.step') })
  })

  test('reports a file absent from a folder that exists as missing', () => {
    expect(resolveModelPath('missing.step', dir, null)).toEqual({
      notFound: true,
      reason: 'missing'
    })
  })

  test('reports an absent folder as not installed', () => {
    expect(resolveModelPath('Gone.3dshapes/part.step', dir, null)).toEqual({
      notFound: true,
      reason: 'not-installed'
    })
  })

  test('reports a variable with no value as not installed', () => {
    expect(resolveModelPath('${KICAD8_3DMODEL_DIR}/part.step', null, null, {}, {})).toEqual({
      notFound: true,
      reason: 'not-installed'
    })
  })

  test('resolves ${KIPRJMOD} against the project folder', () => {
    expect(resolveModelPath('${KIPRJMOD}/part.step', null, dir, {}, {})).toEqual({
      path: join(dir, 'part.step')
    })
  })

  test('resolves via the ${KICAD*_3DMODEL_DIR} fallback', () => {
    expect(resolveModelPath('${KICAD8_3DMODEL_DIR}/part.step', null, null, { modelDir: dir }, {})) //
      .toEqual({ path: join(dir, 'part.step') })
  })

  test('resolves via the ${KICAD*_3RD_PARTY} fallback', () => {
    expect(
      resolveModelPath(
        '${KICAD8_3RD_PARTY}/vendor.step',
        null,
        null,
        { thirdPartyDir: thirdParty },
        {}
      )
    ).toEqual({ path: join(thirdParty, 'vendor.step') })
  })

  // The case this whole substitution exists for: every KiCad footprint links
  // `.wrl`, and most Linux packages ship only the STEP set.
  test('finds the STEP sibling of a .wrl link', () => {
    expect(resolveModelPath('part.wrl', dir, null)).toEqual({ path: join(dir, 'part.step') })
  })

  // Only `upper.STEP` can answer this on a case-sensitive filesystem; on a
  // case-insensitive one (macOS, Windows) the literal `upper.step` already opens
  // that same file, so the spelling that comes back is the platform's business.
  // Assert the file reached instead — the variant order that finds it on Linux
  // is covered filesystem-independently by the modelExtensionVariants tests.
  test('finds a file whose extension differs only in case', () => {
    const resolved = resolveModelPath('upper.step', dir, null)
    if (!('path' in resolved)) throw new Error('upper.step should have resolved to upper.STEP')
    expect(existsSync(resolved.path)).toBe(true)
    expect(resolved.path.toLowerCase()).toBe(join(dir, 'upper.step').toLowerCase())
  })
})
