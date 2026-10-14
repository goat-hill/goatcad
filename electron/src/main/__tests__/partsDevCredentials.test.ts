import { describe, it, expect } from 'vitest'
import { devCredentialsFor, loadDevCredentials, parseEnvFile } from '../partsDevCredentials'

describe('parseEnvFile', () => {
  it('reads KEY=value, ignoring comments and blanks', () => {
    expect(
      parseEnvFile(['# a comment', '', 'A=1', '  B = two  ', 'C=with=equals'].join('\n'))
    ).toEqual({ A: '1', B: 'two', C: 'with=equals' })
  })

  it('tolerates an export prefix, so the file can also be sourced by a shell', () => {
    expect(parseEnvFile('export A=1')).toEqual({ A: '1' })
  })

  it('strips surrounding quotes, which a pasted secret often arrives in', () => {
    expect(parseEnvFile(`A="one"\nB='two'`)).toEqual({ A: 'one', B: 'two' })
  })

  it('ignores a line with no assignment rather than inventing a key', () => {
    expect(parseEnvFile('not a pair\n=novalue')).toEqual({})
  })
})

describe('devCredentialsFor', () => {
  it('builds a provider only when every field it declares is present', () => {
    expect(
      devCredentialsFor('digikey', {
        GOATCAD_DEV_DIGIKEY_CLIENT_ID: 'id',
        GOATCAD_DEV_DIGIKEY_CLIENT_SECRET: 'secret'
      })
    ).toEqual({ clientId: 'id', clientSecret: 'secret' })
  })

  it('refuses a half-filled provider', () => {
    // A client id with no secret is not a usable credential; returning it would
    // turn a missing line into an authentication failure against the API.
    expect(devCredentialsFor('digikey', { GOATCAD_DEV_DIGIKEY_CLIENT_ID: 'id' })).toBeNull()
    expect(devCredentialsFor('digikey', {})).toBeNull()
    expect(
      devCredentialsFor('digikey', {
        GOATCAD_DEV_DIGIKEY_CLIENT_ID: '   ',
        GOATCAD_DEV_DIGIKEY_CLIENT_SECRET: 'secret'
      })
    ).toBeNull()
  })

  it('reads the Mouser single key', () => {
    expect(devCredentialsFor('mouser', { GOATCAD_DEV_MOUSER_API_KEY: 'k' })).toEqual({
      apiKey: 'k'
    })
  })
})

describe('loadDevCredentials', () => {
  const env = {
    GOATCAD_DEV_DIGIKEY_CLIENT_ID: 'id',
    GOATCAD_DEV_DIGIKEY_CLIENT_SECRET: 'secret'
  }

  it('reads nothing at all when the app is packaged', () => {
    // The packaged flag is the safety boundary, not the file: a release behaves
    // as if this module did not exist, whatever is sitting on disk.
    expect(loadDevCredentials(['/nonexistent'], true, env)).toEqual({})
  })

  it('falls back to the process environment when no file is found', () => {
    expect(loadDevCredentials(['/nonexistent'], false, env)).toEqual({
      digikey: { clientId: 'id', clientSecret: 'secret' }
    })
  })

  it('omits a provider the environment does not name', () => {
    expect(loadDevCredentials(['/nonexistent'], false, env).mouser).toBeUndefined()
  })
})
