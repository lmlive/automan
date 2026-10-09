import type { PreloadApi } from '../../../../preload/api-types'
import type {
  EnrichedDetectedPort,
  PortForwardEntry,
  SshConnectionState,
  SshRepoReadoption,
  SshTarget
} from '../../../../shared/ssh-types'
import type {
  SshRuntimeEvent,
  SshRuntimeEventStreamMessage
} from '../../../../shared/ssh-runtime-events'
import { callRuntimeResult } from './web-runtime-calls'
import { getClientForEnvironment, requireActiveEnvironmentOrNull } from './web-runtime-session'

type SshApi = NonNullable<PreloadApi['ssh']>

export function createWebSshApi(): SshApi {
  return {
    listTargets: async () => {
      if (!requireActiveEnvironmentOrNull()) {
        return []
      }
      return (await callRuntimeResult<{ targets: SshTarget[] }>('ssh.listTargets')).targets
    },
    listRemovedTargetLabels: async () => {
      if (!requireActiveEnvironmentOrNull()) {
        return {}
      }
      return (
        await callRuntimeResult<{ labels: Record<string, string> }>('ssh.listRemovedTargetLabels')
      ).labels
    },
    addTarget: async (args) => {
      const result = await callRuntimeResult<{
        target: SshTarget
        repoReadoptions?: SshRepoReadoption[]
      }>('ssh.addTarget', {
        target: args.target
      })
      return { target: result.target, repoReadoptions: result.repoReadoptions ?? [] }
    },
    updateTarget: async (args) => {
      const target = (
        await callRuntimeResult<{ target: SshTarget | null }>('ssh.updateTarget', {
          id: args.id,
          updates: args.updates
        })
      ).target
      if (!target) {
        throw new Error(`SSH target "${args.id}" no longer exists.`)
      }
      return target
    },
    removeTarget: async (args) => {
      await callRuntimeResult('ssh.removeTarget', { id: args.id })
    },
    importConfig: async (args) => {
      const result = await callRuntimeResult<{
        targets: SshTarget[]
        repoReadoptions?: SshRepoReadoption[]
      }>('ssh.importConfig', args ?? {}, 60_000)
      return { targets: result.targets, repoReadoptions: result.repoReadoptions ?? [] }
    },
    listConfigHosts: () =>
      Promise.resolve({
        hosts: [],
        totalHostCount: 0,
        newHostCount: 0,
        matchCount: 0,
        hasMore: false
      }),
    resolveConfigHost: () => Promise.resolve(null),
    connect: async (args) =>
      (
        await callRuntimeResult<{ state: SshConnectionState }>(
          'ssh.connect',
          { targetId: args.targetId },
          10 * 60_000
        )
      ).state,
    disconnect: async (args) => {
      await callRuntimeResult('ssh.disconnect', { targetId: args.targetId })
    },
    terminateSessions: async (args) =>
      await callRuntimeResult<{ terminated: number; unverifiable: number }>(
        'ssh.terminateSessions',
        { targetId: args.targetId }
      ),
    resetRelay: async (args) => {
      await callRuntimeResult('ssh.resetRelay', { targetId: args.targetId })
    },
    getState: async (args) => {
      if (!requireActiveEnvironmentOrNull()) {
        return null
      }
      return (
        await callRuntimeResult<{ state: SshConnectionState | null }>('ssh.getState', {
          targetId: args.targetId
        })
      ).state
    },
    needsPassphrasePrompt: async (args) =>
      (
        await callRuntimeResult<{ needed: boolean }>('ssh.needsPassphrasePrompt', {
          targetId: args.targetId
        })
      ).needed,
    testConnection: (args) =>
      callRuntimeResult<{
        success: boolean
        error?: string
        state?: SshConnectionState
      }>('ssh.testConnection', { targetId: args.targetId }),
    addPortForward: async (args) =>
      (await callRuntimeResult<{ forward: PortForwardEntry }>('ssh.addPortForward', args)).forward,
    updatePortForward: async (args) =>
      (await callRuntimeResult<{ forward: PortForwardEntry }>('ssh.updatePortForward', args))
        .forward,
    removePortForward: async (args) =>
      (
        await callRuntimeResult<{ forward: PortForwardEntry | null }>('ssh.removePortForward', {
          id: args.id
        })
      ).forward,
    listPortForwards: async (args) =>
      (
        await callRuntimeResult<{ forwards: PortForwardEntry[] }>(
          'ssh.listPortForwards',
          args ?? {}
        )
      ).forwards,
    listDetectedPorts: async (args) =>
      (
        await callRuntimeResult<{ ports: EnrichedDetectedPort[] }>('ssh.listDetectedPorts', {
          targetId: args.targetId
        })
      ).ports,
    browseDir: (args) => callRuntimeResult('ssh.browseDir', args),
    submitCredential: async (args) => {
      await callRuntimeResult('ssh.submitCredential', args)
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

type SshEventSink = (event: SshRuntimeEvent) => void
const eventSinks = new Set<SshEventSink>()
let eventHandle: { unsubscribe: () => void } | null = null
let eventSubscribeStarted = false
let eventSubscriptionGeneration = 0

function subscribeSshEvents(sink: SshEventSink): () => void {
  eventSinks.add(sink)
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
    }
  }
}

function ensureSshEventSubscription(): void {
  if (eventSubscribeStarted) {
    return
  }
  const env = requireActiveEnvironmentOrNull()
  if (!env) {
    return
  }
  eventSubscribeStarted = true
  const generation = ++eventSubscriptionGeneration
  void getClientForEnvironment(env)
    .subscribe(
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
      eventSubscribeStarted = false
    })
}

function stopSshEventSubscription(): void {
  eventSubscriptionGeneration += 1
  eventSubscribeStarted = false
  eventHandle?.unsubscribe()
  eventHandle = null
}
