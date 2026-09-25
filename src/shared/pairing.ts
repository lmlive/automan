import { z } from 'zod'

export const PAIRING_OFFER_VERSION = 2
const PairingScopeSchema = z.enum(['mobile', 'runtime'])

export const PairingTokenSchema = z.object({
  v: z.literal(PAIRING_OFFER_VERSION),
  deviceToken: z.string().min(1),
  publicKeyB64: z.string().min(1),
  scope: PairingScopeSchema.optional()
})

export type PairingToken = z.infer<typeof PairingTokenSchema>

export const PairingOfferSchema = z.object({
  v: z.literal(PAIRING_OFFER_VERSION),
  endpoint: z.string().min(1),
  deviceToken: z.string().min(1),
  // Why: the desktop's Curve25519 public key, base64-encoded. The mobile client
  // uses this to derive a shared secret via ECDH for end-to-end encryption.
  publicKeyB64: z.string().min(1),
  // Why: advisory UI metadata lets the web client reject phone-QR offers before
  // opening a socket; the runtime still authorizes solely from deviceToken.
  scope: PairingScopeSchema.optional()
})

export type PairingOffer = z.infer<typeof PairingOfferSchema>

export function encodePairingToken(offer: PairingOffer): string {
  return encodeBase64Url(
    PairingTokenSchema.parse({
      v: offer.v,
      deviceToken: offer.deviceToken,
      publicKeyB64: offer.publicKeyB64,
      ...(offer.scope ? { scope: offer.scope } : {})
    })
  )
}

export function parsePairingToken(input: string): PairingToken | null {
  try {
    return PairingTokenSchema.parse(decodeBase64Url(input.trim()))
  } catch {
    return null
  }
}

export function createPairingOfferFromAddressAndToken(
  address: string,
  token: string,
  defaultPort = 6768
): PairingOffer | null {
  const endpoint = normalizePairingEndpoint(address, defaultPort)
  const pairingToken = parsePairingToken(token)
  if (!endpoint || !pairingToken) {
    return null
  }
  return PairingOfferSchema.parse({ ...pairingToken, endpoint })
}

export function encodePairingOffer(offer: PairingOffer): string {
  const base64url = encodeBase64Url(offer)
  // Why: Android camera intents and Expo Router preserve query params more
  // reliably than URL fragments when launching a custom-scheme app.
  return `orca://pair?code=${base64url}`
}

export function decodePairingOffer(url: string): PairingOffer {
  const code = extractPairingCodeFromUrl(url)
  if (!code) {
    throw new Error('Invalid pairing URL: must start with orca://pair and include a pairing code')
  }
  return decodePairingBase64(code)
}

function extractPairingCodeFromUrl(url: string): string | null {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return null
  }
  // Why: prefix checks accepted routes like `orca://pairing?...`; only the
  // pairing deep-link host may carry runtime auth material.
  if (parsed.protocol !== 'orca:' || parsed.hostname !== 'pair') {
    return null
  }
  if (parsed.pathname !== '' && parsed.pathname !== '/') {
    return null
  }
  const code = parsed.searchParams.get('code')
  if (code) {
    return code
  }
  return parsed.hash ? parsed.hash.slice(1) || null : null
}

// Why: accept either an `orca://pair?...` URL or the bare base64
// string so the mobile paste-pair flow can take whichever the user
// actually copied from desktop.
export function parsePairingCode(input: string): PairingOffer | null {
  const trimmed = input.trim()
  if (!trimmed) {
    return null
  }
  try {
    if (trimmed.toLowerCase().startsWith('orca://')) {
      return decodePairingOffer(trimmed)
    }
    return decodePairingBase64(trimmed)
  } catch {
    return null
  }
}

function decodePairingBase64(base64url: string): PairingOffer {
  return PairingOfferSchema.parse(decodeBase64Url(base64url))
}

function encodeBase64Url(value: unknown): string {
  return Buffer.from(JSON.stringify(value), 'utf-8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
}

function decodeBase64Url(base64url: string): unknown {
  const base64 = base64url.replace(/-/g, '+').replace(/_/g, '/')
  return JSON.parse(Buffer.from(base64, 'base64').toString('utf-8'))
}

function normalizePairingEndpoint(address: string, defaultPort: number): string | null {
  const trimmed = address.trim()
  if (!trimmed) {
    return null
  }
  try {
    const hasProtocol = /^[a-z][a-z\d+.-]*:\/\//i.test(trimmed)
    const url = new URL(hasProtocol ? trimmed : `ws://${trimmed}`)
    if (url.protocol === 'http:') {
      url.protocol = 'ws:'
    } else if (url.protocol === 'https:') {
      url.protocol = 'wss:'
    }
    if (url.protocol !== 'ws:' && url.protocol !== 'wss:') {
      return null
    }
    if (!hasProtocol && !url.port) {
      url.port = String(defaultPort)
    }
    const endpoint = url.toString()
    return hasProtocol ? endpoint : endpoint.replace(/\/$/, '')
  } catch {
    return null
  }
}
