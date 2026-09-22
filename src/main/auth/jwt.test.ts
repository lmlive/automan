import { createHmac } from 'node:crypto'
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  __resetAuthSecretCacheForTests,
  AUTH_SECRET_FILENAME,
  isSessionTokenShaped,
  loadOrCreateAuthSecret,
  signSessionToken,
  verifySessionToken
} from './jwt'

function createUserDataPath(): string {
  return mkdtempSync(join(tmpdir(), 'orca-auth-jwt-'))
}

afterEach(() => {
  __resetAuthSecretCacheForTests()
})

describe('session token signing', () => {
  it('round-trips claims for the signing device', () => {
    const userDataPath = createUserDataPath()
    const { token } = signSessionToken({ userDataPath, deviceId: 'device-1', scope: 'mobile' })

    const claims = verifySessionToken({ userDataPath, token })

    expect(claims).toMatchObject({ sub: 'device-1', role: 'mobile' })
    expect(claims?.jti).toBeTruthy()
    expect(claims!.exp).toBeGreaterThan(claims!.iat)
  })

  it('reports expiry as an absolute epoch-millisecond timestamp', () => {
    const userDataPath = createUserDataPath()
    const before = Date.now()
    const { token, expiresAt } = signSessionToken({
      userDataPath,
      deviceId: 'device-1',
      scope: 'mobile',
      ttlSeconds: 60
    })

    // Why: a seconds-vs-milliseconds mix-up would look valid for ~50 000 years.
    expect(expiresAt).toBeGreaterThan(before)
    expect(expiresAt).toBeLessThan(before + 61_000)
    expect(verifySessionToken({ userDataPath, token })?.exp).toBe(Math.floor(expiresAt / 1000))
  })

  it('rejects a token signed with a different secret', () => {
    const token = signSessionToken({
      userDataPath: createUserDataPath(),
      deviceId: 'device-1',
      scope: 'mobile'
    }).token

    expect(verifySessionToken({ userDataPath: createUserDataPath(), token })).toBeNull()
  })

  it('rejects an expired token', () => {
    const userDataPath = createUserDataPath()
    const { token, expiresAt } = signSessionToken({
      userDataPath,
      deviceId: 'device-1',
      scope: 'mobile',
      ttlSeconds: 60
    })

    expect(verifySessionToken({ userDataPath, token, nowMs: expiresAt + 1000 })).toBeNull()
    // Boundary: the exact expiry second is already expired.
    expect(verifySessionToken({ userDataPath, token, nowMs: expiresAt })).toBeNull()
    expect(verifySessionToken({ userDataPath, token, nowMs: expiresAt - 1000 })).not.toBeNull()
  })

  it('rejects a tampered payload', () => {
    const userDataPath = createUserDataPath()
    const { token } = signSessionToken({ userDataPath, deviceId: 'device-1', scope: 'mobile' })
    const [header, , signature] = token.split('.')
    const forged = Buffer.from(
      JSON.stringify({
        sub: 'device-attacker',
        role: 'runtime',
        iat: Math.floor(Date.now() / 1000),
        exp: Math.floor(Date.now() / 1000) + 3600,
        jti: 'forged'
      })
    ).toString('base64url')

    expect(
      verifySessionToken({ userDataPath, token: `${header}.${forged}.${signature}` })
    ).toBeNull()
  })

  // Why: an `alg: none` token is the classic JWT forgery. The verifier must pin
  // HS256 from the header rather than trusting whatever the header claims.
  it('rejects a token whose header claims alg none', () => {
    const userDataPath = createUserDataPath()
    const noneHeader = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString(
      'base64url'
    )
    const payload = Buffer.from(
      JSON.stringify({
        sub: 'device-1',
        role: 'mobile',
        iat: Math.floor(Date.now() / 1000),
        exp: Math.floor(Date.now() / 1000) + 3600,
        jti: 'forged'
      })
    ).toString('base64url')

    expect(verifySessionToken({ userDataPath, token: `${noneHeader}.${payload}.` })).toBeNull()
    expect(
      verifySessionToken({ userDataPath, token: `${noneHeader}.${payload}.anything` })
    ).toBeNull()
  })

  it('rejects malformed and non-token input', () => {
    const userDataPath = createUserDataPath()

    for (const token of ['', 'not-a-token', 'a.b', 'a.b.c.d', 'a.b.c']) {
      expect(verifySessionToken({ userDataPath, token })).toBeNull()
    }
  })

  it('rejects claims with an unknown scope', () => {
    const userDataPath = createUserDataPath()
    const secret = loadOrCreateAuthSecret(userDataPath)
    const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url')
    const payload = Buffer.from(
      JSON.stringify({
        sub: 'device-1',
        role: 'root',
        iat: Math.floor(Date.now() / 1000),
        exp: Math.floor(Date.now() / 1000) + 3600,
        jti: 'forged'
      })
    ).toString('base64url')
    // Sign correctly with the real secret — the only problem is the scope value.
    const signature = createHmac('sha256', secret)
      .update(`${header}.${payload}`)
      .digest('base64url')

    expect(
      verifySessionToken({ userDataPath, token: `${header}.${payload}.${signature}` })
    ).toBeNull()
  })
})

describe('auth secret persistence', () => {
  it('persists the secret so tokens survive a runtime restart', () => {
    const userDataPath = createUserDataPath()
    const { token } = signSessionToken({ userDataPath, deviceId: 'device-1', scope: 'mobile' })

    // Simulate a process restart: drop the in-memory cache, keep the file.
    __resetAuthSecretCacheForTests()

    expect(verifySessionToken({ userDataPath, token })?.sub).toBe('device-1')
    expect(statSync(join(userDataPath, AUTH_SECRET_FILENAME)).mode & 0o777).toBe(0o600)
  })

  it('reuses the persisted secret instead of minting a new one', () => {
    const userDataPath = createUserDataPath()
    const first = loadOrCreateAuthSecret(userDataPath)
    __resetAuthSecretCacheForTests()

    expect(loadOrCreateAuthSecret(userDataPath).equals(first)).toBe(true)
  })

  it('regenerates a secret when the stored file is corrupt', () => {
    const userDataPath = createUserDataPath()
    const first = loadOrCreateAuthSecret(userDataPath)
    writeFileSync(join(userDataPath, AUTH_SECRET_FILENAME), '{ not json')
    __resetAuthSecretCacheForTests()

    const second = loadOrCreateAuthSecret(userDataPath)

    expect(second.length).toBe(32)
    expect(second.equals(first)).toBe(false)
    // The regenerated file must be readable again on the next load.
    __resetAuthSecretCacheForTests()
    expect(loadOrCreateAuthSecret(userDataPath).equals(second)).toBe(true)
  })

  it('stores the secret base64-encoded rather than raw', () => {
    const userDataPath = createUserDataPath()
    loadOrCreateAuthSecret(userDataPath)

    const raw = JSON.parse(readFileSync(join(userDataPath, AUTH_SECRET_FILENAME), 'utf-8'))

    expect(raw.v).toBe(1)
    expect(Buffer.from(raw.secretB64, 'base64').length).toBe(32)
  })
})

describe('isSessionTokenShaped', () => {
  it('distinguishes a session token from a device token', () => {
    expect(isSessionTokenShaped('a.b.c')).toBe(true)
    expect(isSessionTokenShaped('deadbeef'.repeat(6))).toBe(false)
    expect(isSessionTokenShaped('a.b')).toBe(false)
    expect(isSessionTokenShaped('a..c')).toBe(false)
  })
})
