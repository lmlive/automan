import type { RuntimeRpcResponse } from '../../../shared/runtime-rpc-envelope'
import { RuntimeRpcCallQueuePool } from '../../../shared/runtime-rpc-call-queue'
import type { StoredWebRuntimeEnvironment } from './web-runtime-environment'
import {
  createStoredWebRuntimeEnvironment,
  getPreferredWebPairingOffer,
  readStoredWebRuntimeEnvironments,
  removeStoredWebRuntimeEnvironment,
  updateStoredEnvironmentRuntimeId,
  upsertStoredWebRuntimeEnvironment
} from './web-runtime-environment'
import { createWebPairingOfferFromAddressAndToken, parseWebPairingInput } from './web-pairing'
import {
  WebRuntimeClient,
  type WebRuntimeSubscriptionHandle,
  type SubscribeOptions
} from './web-runtime-client'

// Why: the web client is the browser twin of the desktop renderer, which keeps
// every paired runtime alive at once. A single-environment slot made "Add Server"
// destroy the previous pairing (including the local ws://127.0.0.1 server), so the
// client could never hold a remote server and the local one together.
let storedEnvironments: StoredWebRuntimeEnvironment[] = []
let focusedEnvironmentId: string | null = null
// Why: one socket per paired server. Sharing a single client made every call —
// including subscriptions and status probes — go to whichever server was added last.
const clientsByEnvironmentId = new Map<string, WebRuntimeClient>()
const runtimeCallQueuePool = new RuntimeRpcCallQueuePool()
const FOCUSED_ENVIRONMENT_STORAGE_KEY = 'orca.web.activeRuntimeEnvironmentId.v1'
const NO_FOCUSED_ENVIRONMENT = '__none__'

export function installWebRuntimeEnvironmentRegistry(): void {
  storedEnvironments = readStoredWebRuntimeEnvironments()
  const persistedFocusId = window.localStorage.getItem(FOCUSED_ENVIRONMENT_STORAGE_KEY)
  focusedEnvironmentId =
    persistedFocusId === NO_FOCUSED_ENVIRONMENT
      ? null
      : resolveEffectiveFocusId(storedEnvironments, persistedFocusId ?? focusedEnvironmentId)
  persistFocusedEnvironmentId(focusedEnvironmentId)
  for (const id of Array.from(clientsByEnvironmentId.keys())) {
    if (!storedEnvironments.some((environment) => environment.id === id)) {
      closeWebRuntimeClient(id)
    }
  }
}

export function listWebRuntimeEnvironments(): StoredWebRuntimeEnvironment[] {
  installWebRuntimeEnvironmentRegistry()
  return storedEnvironments
}

/**
 * Focus is explicit once several servers are paired; with a single server it is
 * implicit so a fresh pairing keeps working without touching the selector.
 */
export function getFocusedWebRuntimeEnvironmentId(): string | null {
  installWebRuntimeEnvironmentRegistry()
  return focusedEnvironmentId
}

export function setFocusedWebRuntimeEnvironmentId(environmentId: string | null): void {
  installWebRuntimeEnvironmentRegistry()
  const next = environmentId?.trim() || null
  focusedEnvironmentId = next && storedEnvironments.some((entry) => entry.id === next) ? next : null
  persistFocusedEnvironmentId(focusedEnvironmentId)
}

export function addWebRuntimeEnvironmentFromPairingCode(args: {
  name: string
  pairingCode: string
  address?: string
}): StoredWebRuntimeEnvironment {
  const offer = args.address
    ? createWebPairingOfferFromAddressAndToken(args.address, args.pairingCode)
    : parseWebPairingInput(args.pairingCode)
  if (!offer) {
    throw new Error(
      args.address ? 'Invalid Orca server address or token.' : 'Invalid Orca pairing code.'
    )
  }
  const trimmedName = args.name.trim()
  const duplicate = storedEnvironments.find(
    (environment) => environment.name.trim().toLowerCase() === trimmedName.toLowerCase()
  )
  if (duplicate) {
    throw new Error(`A server named "${duplicate.name}" already exists.`)
  }
  const environment = createStoredWebRuntimeEnvironment({ name: trimmedName, offer })
  upsertStoredWebRuntimeEnvironment(environment)
  storedEnvironments = readStoredWebRuntimeEnvironments()
  return environment
}

export function removeWebRuntimeEnvironment(selector: string): StoredWebRuntimeEnvironment {
  const environment = resolveWebRuntimeEnvironment(selector)
  closeWebRuntimeClient(environment.id)
  removeStoredWebRuntimeEnvironment(environment.id)
  storedEnvironments = readStoredWebRuntimeEnvironments()
  focusedEnvironmentId = resolveEffectiveFocusId(storedEnvironments, focusedEnvironmentId)
  return environment
}

/**
 * Non-destructive: drop the live transport but keep the pairing saved, matching
 * the desktop's `runtimeEnvironments:disconnect` contract.
 */
export function disconnectWebRuntimeEnvironment(selector: string): StoredWebRuntimeEnvironment {
  const environment = resolveWebRuntimeEnvironment(selector)
  closeWebRuntimeClient(environment.id)
  return environment
}

export function resolveWebRuntimeEnvironment(selector: string): StoredWebRuntimeEnvironment {
  installWebRuntimeEnvironmentRegistry()
  const trimmed = selector.trim()
  const byId = storedEnvironments.find((environment) => environment.id === trimmed)
  if (byId) {
    return byId
  }
  const byName = storedEnvironments.filter((environment) => environment.name === trimmed)
  if (byName.length === 1) {
    return byName[0]!
  }
  if (trimmed === 'active') {
    const focused = requireFocusedWebRuntimeEnvironmentOrNull()
    if (focused) {
      return focused
    }
  }
  throw new Error(`Unknown Orca runtime environment: ${selector}`)
}

export function requireFocusedWebRuntimeEnvironment(): StoredWebRuntimeEnvironment {
  const environment = requireFocusedWebRuntimeEnvironmentOrNull()
  if (!environment) {
    throw new Error('Pair this web client with an Orca server first.')
  }
  return environment
}

export function requireFocusedWebRuntimeEnvironmentOrNull(): StoredWebRuntimeEnvironment | null {
  installWebRuntimeEnvironmentRegistry()
  return storedEnvironments.find((environment) => environment.id === focusedEnvironmentId) ?? null
}

export function getWebRuntimeClient(environment: StoredWebRuntimeEnvironment): WebRuntimeClient {
  const existing = clientsByEnvironmentId.get(environment.id)
  if (existing) {
    return existing
  }
  const client = new WebRuntimeClient(getPreferredWebPairingOffer(environment))
  clientsByEnvironmentId.set(environment.id, client)
  return client
}

export function closeWebRuntimeClient(environmentId: string): void {
  const client = clientsByEnvironmentId.get(environmentId)
  if (!client) {
    return
  }
  clientsByEnvironmentId.delete(environmentId)
  client.close()
}

export function closeAllWebRuntimeClients(): void {
  for (const id of Array.from(clientsByEnvironmentId.keys())) {
    closeWebRuntimeClient(id)
  }
}

export async function callWebRuntimeEnvelope<TResult = unknown>(
  environment: StoredWebRuntimeEnvironment,
  method: string,
  params?: unknown,
  timeoutMs?: number
): Promise<RuntimeRpcResponse<TResult>> {
  const response = await runtimeCallQueuePool.enqueue(environment.id, method, () =>
    getWebRuntimeClient(environment).call(method, params, { timeoutMs })
  )
  noteWebRuntimeResponse(environment, response)
  return response as RuntimeRpcResponse<TResult>
}

export function callFocusedWebRuntimeEnvelope<TResult = unknown>(
  method: string,
  params?: unknown,
  timeoutMs?: number
): Promise<RuntimeRpcResponse<TResult>> {
  return callWebRuntimeEnvelope(requireFocusedWebRuntimeEnvironment(), method, params, timeoutMs)
}

export async function callWebRuntimeResultForEnvironment<TResult>(
  environment: StoredWebRuntimeEnvironment,
  method: string,
  params?: unknown,
  timeoutMs?: number
): Promise<TResult> {
  const response = await callWebRuntimeEnvelope(environment, method, params, timeoutMs)
  if (!response.ok) {
    throw new Error(response.error.message)
  }
  return response.result as TResult
}

export async function callFocusedWebRuntimeResult<TResult>(
  method: string,
  params?: unknown,
  timeoutMs?: number
): Promise<TResult> {
  const response = await callFocusedWebRuntimeEnvelope(method, params, timeoutMs)
  if (!response.ok) {
    throw new Error(response.error.message)
  }
  return response.result as TResult
}

export function subscribeWebRuntimeEnvironment(
  selector: string,
  method: string,
  params: unknown,
  callbacks: Parameters<WebRuntimeClient['subscribe']>[2],
  options?: SubscribeOptions
): Promise<WebRuntimeSubscriptionHandle> {
  const environment = resolveWebRuntimeEnvironment(selector)
  return getWebRuntimeClient(environment).subscribe(method, params, callbacks, options)
}

export function noteWebRuntimeResponse(
  environment: StoredWebRuntimeEnvironment,
  response: RuntimeRpcResponse<unknown>
): void {
  const runtimeId = response.ok ? response._meta.runtimeId : (response._meta?.runtimeId ?? null)
  storedEnvironments = updateStoredEnvironmentRuntimeId(environment, runtimeId)
}

function persistFocusedEnvironmentId(environmentId: string | null): void {
  window.localStorage.setItem(
    FOCUSED_ENVIRONMENT_STORAGE_KEY,
    environmentId ?? NO_FOCUSED_ENVIRONMENT
  )
}

function resolveEffectiveFocusId(
  environments: StoredWebRuntimeEnvironment[],
  preferred: string | null
): string | null {
  if (preferred && environments.some((environment) => environment.id === preferred)) {
    return preferred
  }
  return environments[0]?.id ?? null
}
