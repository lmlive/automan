import type { PreloadApi } from '../../../preload/api-types'
import type {
  EnrichedDetectedPort,
  PortForwardEntry,
  SshConnectionState,
  SshTarget
} from '../../../shared/ssh-types'
import type {
  SshRuntimeEvent,
  SshRuntimeEventStreamMessage
} from '../../../shared/ssh-runtime-events'
import {
  callFocusedWebRuntimeResult,
  onFocusedWebRuntimeEnvironmentChange,
  requireFocusedWebRuntimeEnvironmentOrNull,
  subscribeWebRuntimeEnvironment
} from './web-runtime-environment-registry'

type SshApi = NonNullable<PreloadApi['ssh']>

// Why: the desktop renderer drives SSH over ipcRenderer, which the browser has
// no access to. Every operation here routes to the paired runtime's `ssh.*` RPC
// — the same methods the mobile client uses — so a browser client can manage
// and connect SSH hosts when the paired server registered its SSH subsystem.
export function createWebSshApi(): SshApi {
  return {
    listTargets: async () =>
      (await callFocusedWebRuntimeResult<{ targets: SshTarget[] }>('ssh.listTargets')).targets,
    addTarget: async (args) =>
      (
        await callFocusedWebRuntimeResult<{ target: SshTarget }>('ssh.addTarget', {
          target: args.target
        })
      ).target,
    updateTarget: async (args) => {
      const target = (
        await callFocusedWebRuntimeResult<{ target: SshTarget | null }>('ssh.updateTarget', {
          id: args.id,
          updates: args.updates
        })
      ).target
      // Why: the runtime returns null when the id no longer exists (removed in
      // another client). The preload contract promises an SshTarget, so surface
      // the miss instead of resolving null and letting the caller toast success.
      if (!target) {
        throw new Error(`SSH target "${args.id}" no longer exists.`)
      }
      return target
    },
    removeTarget: async (args) => {
      await callFocusedWebRuntimeResult('ssh.removeTarget', { id: args.id })
    },
    importConfig: async (args) =>
      (
        await callFocusedWebRuntimeResult<{ targets: SshTarget[] }>(
          'ssh.importConfig',
          args ?? {},
          // Why: import shells out to `ssh -G` per host in ~/.ssh/config, which
          // is slow on a large config; the default 30s RPC timeout is too tight.
          60_000
        )
      ).targets,
    connect: async (args) =>
      (
        await callFocusedWebRuntimeResult<{ state: SshConnectionState }>(
          'ssh.connect',
          { targetId: args.targetId },
          // Why: a cold connect deploys the relay and runs `npm install` on the
          // remote (RELAY_DEPLOY_TIMEOUT_MS = 5 min in the desktop path), so the
          // default timeout would abort a connect that is still progressing.
          10 * 60_000
        )
      ).state,
    disconnect: async (args) => {
      await callFocusedWebRuntimeResult('ssh.disconnect', { targetId: args.targetId })
    },
    terminateSessions: async (args) => {
      await callFocusedWebRuntimeResult('ssh.terminateSessions', { targetId: args.targetId })
    },
    resetRelay: async (args) => {
      await callFocusedWebRuntimeResult('ssh.resetRelay', { targetId: args.targetId })
    },
    getState: async (args) =>
      (
        await callFocusedWebRuntimeResult<{ state: SshConnectionState | null }>('ssh.getState', {
          targetId: args.targetId
        })
      ).state,
    needsPassphrasePrompt: async (args) =>
      (
        await callFocusedWebRuntimeResult<{ needed: boolean }>('ssh.needsPassphrasePrompt', {
          targetId: args.targetId
        })
      ).needed,
    testConnection: (args) =>
      callFocusedWebRuntimeResult<{
        success: boolean
        error?: string
        state?: SshConnectionState
      }>('ssh.testConnection', { targetId: args.targetId }),
    addPortForward: async (args) =>
      (await callFocusedWebRuntimeResult<{ forward: PortForwardEntry }>('ssh.addPortForward', args))
        .forward,
    updatePortForward: async (args) =>
      (
        await callFocusedWebRuntimeResult<{ forward: PortForwardEntry }>(
          'ssh.updatePortForward',
          args
        )
      ).forward,
    removePortForward: async (args) =>
      (
        await callFocusedWebRuntimeResult<{ forward: PortForwardEntry | null }>(
          'ssh.removePortForward',
          { id: args.id }
        )
      ).forward,
    listPortForwards: async (args) =>
      (
        await callFocusedWebRuntimeResult<{ forwards: PortForwardEntry[] }>(
          'ssh.listPortForwards',
          args ?? {}
        )
      ).forwards,
    listDetectedPorts: async (args) =>
      (
        await callFocusedWebRuntimeResult<{ ports: EnrichedDetectedPort[] }>(
          'ssh.listDetectedPorts',
          { targetId: args.targetId }
        )
      ).ports,
    browseDir: (args) => callFocusedWebRuntimeResult('ssh.browseDir', args),
    submitCredential: async (args) => {
      await callFocusedWebRuntimeResult('ssh.submitCredential', args)
    },
    onStateChanged: (callback) =>
      subscribeSshEvents((event) => {
        if (event.type === 'stateChanged') {
          callback({ targetId: event.targetId, state: event.state })
        }
      }),
    onPortForwardsChanged: (callback) =>
      subscribeSshEvents((event) => {
        if (event.type === 'portForwardsChanged') {
          callback({ targetId: event.targetId, forwards: event.forwards })
        }
      }),
    onDetectedPortsChanged: (callback) =>
      subscribeSshEvents((event) => {
        if (event.type === 'detectedPortsChanged') {
          callback({ targetId: event.targetId, ports: event.ports })
        }
      }),
    onCredentialRequest: (callback) =>
      subscribeSshEvents((event) => {
        if (event.type === 'credentialRequest') {
          callback({
            requestId: event.requestId,
            targetId: event.targetId,
            kind: event.kind,
            detail: event.detail
          })
        }
      }),
    onCredentialResolved: (callback) =>
      subscribeSshEvents((event) => {
        if (event.type === 'credentialResolved') {
          callback({ requestId: event.requestId })
        }
      })
  }
}

// Why: one `ssh.subscribe` socket serves every SSH listener the renderer
// installs (useIpcEvents registers five). A subscription per listener would
// open five child WebSockets and re-receive every event five times.
type SshEventSink = (event: SshRuntimeEvent) => void
const eventSinks = new Set<SshEventSink>()
let eventHandle: { unsubscribe: () => void } | null = null
let eventSubscribeStarted = false
let eventSubscriptionGeneration = 0
let focusChangeUnsubscribe: (() => void) | null = null

function subscribeSshEvents(sink: SshEventSink): () => void {
  eventSinks.add(sink)
  ensureFocusChangeSubscription()
  ensureSshEventSubscription()
  let unsubscribed = false
  return () => {
    if (unsubscribed) {
      return
    }
    unsubscribed = true
    eventSinks.delete(sink)
    if (eventSinks.size === 0) {
      stopSshEventSubscription()
      focusChangeUnsubscribe?.()
      focusChangeUnsubscribe = null
    }
  }
}

function ensureFocusChangeSubscription(): void {
  if (focusChangeUnsubscribe) {
    return
  }
  focusChangeUnsubscribe = onFocusedWebRuntimeEnvironmentChange(() => {
    eventSubscriptionGeneration += 1
    eventHandle?.unsubscribe()
    eventHandle = null
    eventSubscribeStarted = false
    if (eventSinks.size > 0) {
      ensureSshEventSubscription()
    }
  })
}

function ensureSshEventSubscription(): void {
  if (eventSubscribeStarted) {
    return
  }
  // Why: an unpaired browser has no runtime to subscribe against. Leaving the
  // flag unset means a listener registered after pairing retries; a listener
  // registered before it receives nothing until then.
  if (!requireFocusedWebRuntimeEnvironmentOrNull()) {
    return
  }
  eventSubscribeStarted = true
  const generation = ++eventSubscriptionGeneration
  void subscribeWebRuntimeEnvironment(
    'active',
    'ssh.subscribe',
    undefined,
    {
      onResponse: (response) => {
        if (generation !== eventSubscriptionGeneration || !response.ok) {
          return
        }
        const message = response.result as SshRuntimeEventStreamMessage
        if (message.type === 'ready' || message.type === 'end') {
          return
        }
        for (const sink of eventSinks) {
          sink(message)
        }
      },
      onClose: () => {
        if (generation !== eventSubscriptionGeneration) {
          return
        }
        // Why: a dropped socket must not leave the flag set, or no later
        // listener registration would ever re-establish the subscription.
        eventHandle = null
        eventSubscribeStarted = false
      }
    },
    { timeoutMs: 15_000 }
  )
    .then((handle) => {
      if (generation !== eventSubscriptionGeneration) {
        handle.unsubscribe()
        return
      }
      eventHandle = handle
    })
    .catch(() => {
      if (generation !== eventSubscriptionGeneration) {
        return
      }
      // Why: an older runtime without ssh.subscribe rejects here. Reset so a
      // later registration can retry against a runtime that has been upgraded.
      eventSubscribeStarted = false
    })
}

function stopSshEventSubscription(): void {
  eventSubscriptionGeneration += 1
  eventSubscribeStarted = false
  eventHandle?.unsubscribe()
  eventHandle = null
}
