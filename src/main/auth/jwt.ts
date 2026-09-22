// Why: paired clients authenticate with a long-lived device token that only a
// revoke can invalidate. Session tokens add a short-lived credential so a token
// captured from a log or a reconnect frame expires on its own. The signing
// secret must survive runtime restarts (a client reconnecting after an update
// still presents a token minted by the previous process), so it is persisted
// beside the other runtime credentials and shares their 0o600 + Windows ACL
// hardening.
import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { hardenExistingSecureFile, writeSecureJsonFile } from '../../shared/secure-file'
import type { DeviceScope } from '../../shared/runtime-types'

export const AUTH_SECRET_FILENAME = 'orca-auth-secret.json'
export const SESSION_TOKEN_TTL_SECONDS = 2 * 60 * 60

const SECRET_VERSION = 1
const SECRET_BYTES = 32
const MAX_SECRET_FILE_BYTES = 4 * 1024

type AuthSecretFile = {
  v: number
  secretB64: string
}

export type SessionTokenClaims = {
  // Why: the device id, not the device token. Authorization still re-reads the
  // device registry, so a revoked device loses access before the token expires.
  sub: string
  role: DeviceScope
  iat: number
  exp: number
  jti: string
}

// Why: the secret is read on every handshake and handshakes repeat on each
// reconnect, so cache the loaded key per userData path instead of re-reading and
// re-hardening the file once per connection.
let cachedSecret: { secretPath: string; key: Buffer } | null = null

export function loadOrCreateAuthSecret(userDataPath: string): Buffer {
  const secretPath = join(userDataPath, AUTH_SECRET_FILENAME)
  if (cachedSecret?.secretPath === secretPath) {
    return cachedSecret.key
  }
  const key = readAuthSecret(secretPath) ?? createAuthSecret(secretPath)
  cachedSecret = { secretPath, key }
  return key
}

function readAuthSecret(secretPath: string): Buffer | null {
  if (!existsSync(secretPath)) {
    return null
  }
  try {
    hardenExistingSecureFile(secretPath)
    // Why: this runs on the handshake path, so an oversized or corrupt file must
    // be rejected by size before it is read into memory.
    if (statSync(secretPath).size > MAX_SECRET_FILE_BYTES) {
      return null
    }
    const raw = JSON.parse(readFileSync(secretPath, 'utf-8')) as AuthSecretFile
    if (raw.v !== SECRET_VERSION || typeof raw.secretB64 !== 'string') {
      return null
    }
    const key = Buffer.from(raw.secretB64, 'base64')
    return key.length === SECRET_BYTES ? key : null
  } catch {
    return null
  }
}

function createAuthSecret(secretPath: string): Buffer {
  const key = randomBytes(SECRET_BYTES)
  writeSecureJsonFile(secretPath, {
    v: SECRET_VERSION,
    secretB64: key.toString('base64')
  } satisfies AuthSecretFile)
  return key
}

function signSegments(segments: string, key: Buffer): string {
  return createHmac('sha256', key).update(segments).digest('base64url')
}

export function signSessionToken(args: {
  userDataPath: string
  deviceId: string
  scope: DeviceScope
  ttlSeconds?: number
}): { token: string; expiresAt: number } {
  const issuedAt = Math.floor(Date.now() / 1000)
  const expiresAt = issuedAt + (args.ttlSeconds ?? SESSION_TOKEN_TTL_SECONDS)
  const claims: SessionTokenClaims = {
    sub: args.deviceId,
    role: args.scope,
    iat: issuedAt,
    exp: expiresAt,
    jti: randomUUID()
  }
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url')
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url')
  const segments = `${header}.${payload}`
  return {
    token: `${segments}.${signSegments(segments, loadOrCreateAuthSecret(args.userDataPath))}`,
    expiresAt: expiresAt * 1000
  }
}

// Why: null means "not a valid session token" rather than a thrown protocol
// error, because the handshake treats it as "try the device token instead".
export function verifySessionToken(args: {
  userDataPath: string
  token: string
  nowMs?: number
}): SessionTokenClaims | null {
  const segments = args.token.split('.')
  if (segments.length !== 3) {
    return null
  }
  const [header, payload, signature] = segments as [string, string, string]

  const expected = signSegments(`${header}.${payload}`, loadOrCreateAuthSecret(args.userDataPath))
  const provided = Buffer.from(signature)
  const expectedBuffer = Buffer.from(expected)
  // Why: timingSafeEqual throws on length mismatch; comparing lengths first
  // leaks nothing the signature length does not already reveal.
  if (provided.length !== expectedBuffer.length || !timingSafeEqual(provided, expectedBuffer)) {
    return null
  }

  let headerValue: unknown
  let claimsValue: unknown
  try {
    headerValue = JSON.parse(Buffer.from(header, 'base64url').toString('utf-8'))
    claimsValue = JSON.parse(Buffer.from(payload, 'base64url').toString('utf-8'))
  } catch {
    return null
  }

  // Why: pin the algorithm instead of trusting the header, so a token claiming
  // `alg: none` (or any other algorithm) is never accepted by a verifier that
  // only ever computes HS256.
  if (
    typeof headerValue !== 'object' ||
    headerValue === null ||
    (headerValue as { alg?: unknown }).alg !== 'HS256'
  ) {
    return null
  }

  if (typeof claimsValue !== 'object' || claimsValue === null) {
    return null
  }
  const claims = claimsValue as Partial<SessionTokenClaims>
  if (
    typeof claims.sub !== 'string' ||
    claims.sub.length === 0 ||
    (claims.role !== 'mobile' && claims.role !== 'runtime') ||
    typeof claims.exp !== 'number' ||
    !Number.isFinite(claims.exp) ||
    typeof claims.jti !== 'string' ||
    claims.jti.length === 0
  ) {
    return null
  }

  if (claims.exp <= Math.floor((args.nowMs ?? Date.now()) / 1000)) {
    return null
  }

  return {
    sub: claims.sub,
    role: claims.role,
    iat: typeof claims.iat === 'number' ? claims.iat : 0,
    exp: claims.exp,
    jti: claims.jti
  }
}

// Why: device tokens are 48 hex characters while a session token always has
// three dot-separated segments, so the shape alone decides which verifier runs.
export function isSessionTokenShaped(credential: string): boolean {
  const segments = credential.split('.')
  return segments.length === 3 && segments.every((segment) => segment.length > 0)
}

export function __resetAuthSecretCacheForTests(): void {
  cachedSecret = null
}
