import type { PublicKnownRuntimeEnvironment } from '../../../shared/runtime-environments'
import type { WebPairingOffer } from './web-pairing'
import { createBrowserUuid } from '@/lib/browser-uuid'
import { translate } from '@/i18n/i18n'

export type StoredWebRuntimeEnvironment = Omit<PublicKnownRuntimeEnvironment, 'endpoints'> & {
  endpoints: {
    id: string
    kind: 'websocket'
    label: string
    endpoint: string
    deviceToken: string
    publicKeyB64: string
  }[]
}

// Why: the desktop keeps every paired runtime in a list (orca-environments.json).
// The web client must match it, or adding a server replaces the previous one.
// v1 held a single environment; it is migrated into the list on first read.
const ENVIRONMENTS_STORAGE_KEY = 'orca.web.runtimeEnvironments.v1'
const LEGACY_ENVIRONMENT_STORAGE_KEY = 'orca.web.runtimeEnvironment.v1'

function parseEnvironment(value: unknown): StoredWebRuntimeEnvironment | null {
  if (!value || typeof value !== 'object') {
    return null
  }
  const parsed = value as StoredWebRuntimeEnvironment
  if (
    typeof parsed.id !== 'string' ||
    !parsed.id ||
    typeof parsed.name !== 'string' ||
    !parsed.name ||
    !Array.isArray(parsed.endpoints) ||
    parsed.endpoints.length === 0
  ) {
    return null
  }
  return parsed
}

export function readStoredWebRuntimeEnvironments(): StoredWebRuntimeEnvironment[] {
  const stored = window.localStorage.getItem(ENVIRONMENTS_STORAGE_KEY)
  if (stored !== null) {
    try {
      const parsed = JSON.parse(stored) as { environments?: unknown }
      if (!Array.isArray(parsed.environments)) {
        return []
      }
      return parsed.environments
        .map((entry) => parseEnvironment(entry))
        .filter((entry): entry is StoredWebRuntimeEnvironment => entry !== null)
    } catch {
      return []
    }
  }
  const legacy = parseLegacyStoredEnvironment()
  if (!legacy) {
    return []
  }
  writeStoredWebRuntimeEnvironments([legacy])
  return [legacy]
}

/** First saved environment. Only for "is anything paired" checks and form defaults. */
export function readStoredWebRuntimeEnvironment(): StoredWebRuntimeEnvironment | null {
  return readStoredWebRuntimeEnvironments()[0] ?? null
}

export function writeStoredWebRuntimeEnvironments(
  environments: StoredWebRuntimeEnvironment[]
): void {
  window.localStorage.setItem(
    ENVIRONMENTS_STORAGE_KEY,
    JSON.stringify({ version: 1, environments })
  )
}

/** Insert or replace by id, preserving insertion order for deterministic fallbacks. */
export function upsertStoredWebRuntimeEnvironment(
  environment: StoredWebRuntimeEnvironment
): StoredWebRuntimeEnvironment[] {
  const current = readStoredWebRuntimeEnvironments()
  const exists = current.some((entry) => entry.id === environment.id)
  const next = exists
    ? current.map((entry) => (entry.id === environment.id ? environment : entry))
    : [...current, environment]
  writeStoredWebRuntimeEnvironments(next)
  return next
}

export function removeStoredWebRuntimeEnvironment(id: string): StoredWebRuntimeEnvironment[] {
  const next = readStoredWebRuntimeEnvironments().filter((entry) => entry.id !== id)
  writeStoredWebRuntimeEnvironments(next)
  return next
}

export function clearStoredWebRuntimeEnvironments(): void {
  window.localStorage.removeItem(ENVIRONMENTS_STORAGE_KEY)
  window.localStorage.removeItem(LEGACY_ENVIRONMENT_STORAGE_KEY)
}

export function createStoredWebRuntimeEnvironment(args: {
  name: string
  offer: WebPairingOffer
}): StoredWebRuntimeEnvironment {
  const id = `web-${createBrowserUuid()}`
  const now = Date.now()
  return {
    id,
    name: args.name.trim() || 'Orca Server',
    createdAt: now,
    updatedAt: now,
    lastUsedAt: null,
    runtimeId: null,
    preferredEndpointId: `ws-${id}`,
    endpoints: [
      {
        id: `ws-${id}`,
        kind: 'websocket',
        label: translate('auto.web.web.runtime.environment.07f788de83', 'WebSocket'),
        endpoint: args.offer.endpoint,
        deviceToken: args.offer.deviceToken,
        publicKeyB64: args.offer.publicKeyB64
      }
    ]
  }
}

export function redactStoredWebRuntimeEnvironment(
  environment: StoredWebRuntimeEnvironment
): PublicKnownRuntimeEnvironment {
  return {
    ...environment,
    endpoints: environment.endpoints.map(
      ({ deviceToken: _token, publicKeyB64: _key, ...rest }) => ({
        ...rest
      })
    )
  }
}

export function getPreferredWebPairingOffer(
  environment: StoredWebRuntimeEnvironment
): WebPairingOffer {
  const endpoint =
    environment.endpoints.find((entry) => entry.id === environment.preferredEndpointId) ??
    environment.endpoints[0]
  if (!endpoint) {
    throw new Error('No runtime endpoint is stored for this web client.')
  }
  return {
    v: 2,
    endpoint: endpoint.endpoint,
    deviceToken: endpoint.deviceToken,
    publicKeyB64: endpoint.publicKeyB64
  }
}

export function updateStoredEnvironmentRuntimeId(
  environment: StoredWebRuntimeEnvironment,
  runtimeId: string | null
): StoredWebRuntimeEnvironment[] {
  return upsertStoredWebRuntimeEnvironment({
    ...environment,
    runtimeId,
    updatedAt: Date.now(),
    lastUsedAt: Date.now()
  })
}

export function isMixedContentWebSocket(endpoint: string): boolean {
  return window.location.protocol === 'https:' && endpoint.startsWith('ws://')
}

function parseLegacyStoredEnvironment(): StoredWebRuntimeEnvironment | null {
  const raw = window.localStorage.getItem(LEGACY_ENVIRONMENT_STORAGE_KEY)
  if (!raw) {
    return null
  }
  try {
    return parseEnvironment(JSON.parse(raw))
  } catch {
    return null
  }
}
