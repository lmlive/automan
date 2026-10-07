import { z } from 'zod'
import {
  MAX_SSH_RELAY_GRACE_PERIOD_SECONDS,
  MIN_SSH_RELAY_GRACE_PERIOD_SECONDS
} from '../../../../shared/ssh-types'
import { connectRegisteredSshTarget, getRegisteredSshState } from '../../../ipc/ssh'
import { getSshOperations } from '../../../ipc/ssh-operations'
import { onSshRuntimeEvent, type SshRuntimeEvent } from '../../../ipc/ssh-runtime-events'
import { defineMethod, defineStreamingMethod, type RpcAnyMethod } from '../core'

const SshTarget = z.object({
  targetId: z.string().min(1)
})

const SshTargetId = z.object({
  id: z.string().min(1)
})

const SshGracePeriod = z
  .number()
  .int()
  .refine(
    (value) =>
      value === 0 ||
      (value >= MIN_SSH_RELAY_GRACE_PERIOD_SECONDS &&
        value <= MAX_SSH_RELAY_GRACE_PERIOD_SECONDS),
    'Invalid SSH relay grace period'
  )

const SshTargetDraft = z
  .object({
    label: z.string(),
    configHost: z.string().optional(),
    host: z.string().min(1, 'Missing SSH host'),
    port: z.number().int().min(1).max(65535),
    username: z.string(),
    identityFile: z.string().optional(),
    proxyCommand: z.string().optional(),
    jumpHost: z.string().optional(),
    relayGracePeriodSeconds: SshGracePeriod.optional(),
    systemSshConnectionReuse: z.boolean().optional()
  })
  .strict()

const SshTargetUpdates = SshTargetDraft.partial().extend({
  source: z.literal('manual').optional()
})

const SshImportConfig = z.object({ reAdopt: z.boolean().optional() }).optional()

const SshPortForward = z.object({
  targetId: z.string().min(1),
  localPort: z.number().int().min(1).max(65535),
  remoteHost: z.string().min(1),
  remotePort: z.number().int().min(1).max(65535),
  label: z.string().optional()
})

const SshPortForwardUpdate = SshPortForward.extend({ id: z.string().min(1) })

const SshPortForwardId = z.object({ id: z.string().min(1) })

const SshOptionalTargetId = z.object({ targetId: z.string().optional() }).optional()

const SshBrowse = z.object({
  targetId: z.string().min(1),
  dirPath: z.string().min(1)
})

const SshSubmitCredential = z.object({
  requestId: z.string().min(1),
  value: z.string().nullable()
})

let sshSubscriptionSeq = 0

// Why: `ssh.connect`/`ssh.getState` stay on the registered-target helpers (they
// have call sites in the mobile client and tests), while CRUD and port forwarding
// go through the shared operations table. Both routes land on the same
// implementations registered by registerSshHandlers.
export const SSH_METHODS: readonly RpcAnyMethod[] = [
  defineMethod({
    name: 'ssh.getState',
    params: SshTarget,
    handler: (params) => ({ state: getRegisteredSshState(params.targetId) ?? null })
  }),
  defineMethod({
    name: 'ssh.connect',
    params: SshTarget,
    handler: async (params) => ({ state: await connectRegisteredSshTarget(params.targetId) })
  }),
  defineMethod({
    name: 'ssh.listTargets',
    params: null,
    handler: () => ({ targets: getSshOperations().listTargets() })
  }),
  defineMethod({
    name: 'ssh.addTarget',
    params: z.object({ target: SshTargetDraft }),
    handler: (params) => ({ target: getSshOperations().addTarget(params.target as never) })
  }),
  defineMethod({
    name: 'ssh.updateTarget',
    params: z.object({ id: z.string().min(1), updates: SshTargetUpdates }),
    handler: (params) => ({
      target: getSshOperations().updateTarget(params.id, params.updates as never)
    })
  }),
  defineMethod({
    name: 'ssh.removeTarget',
    params: SshTargetId,
    handler: async (params) => {
      await getSshOperations().removeTarget(params.id)
      return { removed: true }
    }
  }),
  defineMethod({
    name: 'ssh.importConfig',
    params: SshImportConfig,
    handler: (params) => ({ targets: getSshOperations().importConfig(params ?? undefined) })
  }),
  defineMethod({
    name: 'ssh.disconnect',
    params: SshTarget,
    handler: async (params) => {
      await getSshOperations().disconnect(params.targetId)
      return { disconnected: true }
    }
  }),
  defineMethod({
    name: 'ssh.terminateSessions',
    params: SshTarget,
    handler: async (params) => {
      await getSshOperations().terminateSessions(params.targetId)
      return { terminated: true }
    }
  }),
  defineMethod({
    name: 'ssh.resetRelay',
    params: SshTarget,
    handler: async (params) => {
      await getSshOperations().resetRelay(params.targetId)
      return { reset: true }
    }
  }),
  defineMethod({
    name: 'ssh.needsPassphrasePrompt',
    params: SshTarget,
    handler: (params) => ({
      needed: getSshOperations().needsPassphrasePrompt(params.targetId)
    })
  }),
  defineMethod({
    name: 'ssh.testConnection',
    params: SshTarget,
    handler: (params) => getSshOperations().testConnection(params.targetId)
  }),
  defineMethod({
    name: 'ssh.addPortForward',
    params: SshPortForward,
    handler: async (params) => ({ forward: await getSshOperations().addPortForward(params) })
  }),
  defineMethod({
    name: 'ssh.updatePortForward',
    params: SshPortForwardUpdate,
    handler: async (params) => ({ forward: await getSshOperations().updatePortForward(params) })
  }),
  defineMethod({
    name: 'ssh.removePortForward',
    params: SshPortForwardId,
    handler: async (params) => ({ forward: await getSshOperations().removePortForward(params.id) })
  }),
  defineMethod({
    name: 'ssh.listPortForwards',
    params: SshOptionalTargetId,
    handler: (params) => ({ forwards: getSshOperations().listPortForwards(params?.targetId) })
  }),
  defineMethod({
    name: 'ssh.listDetectedPorts',
    params: SshTarget,
    handler: (params) => ({ ports: getSshOperations().listDetectedPorts(params.targetId) })
  }),
  defineMethod({
    name: 'ssh.browseDir',
    params: SshBrowse,
    handler: (params) => getSshOperations().browseDir(params)
  }),
  defineMethod({
    name: 'ssh.submitCredential',
    params: SshSubmitCredential,
    handler: (params) => {
      getSshOperations().submitCredential(params)
      return { submitted: true }
    }
  }),
  // Why: the desktop renderer receives SSH lifecycle events over ipcRenderer.
  // Paired web clients have no IPC channel, so they subscribe here instead and
  // receive the same payloads the desktop's webContents.send calls carry.
  defineStreamingMethod({
    name: 'ssh.subscribe',
    params: null,
    handler: async (_params, { runtime, connectionId }, emit) => {
      await new Promise<void>((resolve) => {
        const unsubscribe = onSshRuntimeEvent((event: SshRuntimeEvent) => {
          emit(event)
        })

        const seq = ++sshSubscriptionSeq
        const subscriptionId = `ssh-events-${connectionId ?? 'inproc'}-${seq}`
        runtime.registerSubscriptionCleanup(
          subscriptionId,
          () => {
            unsubscribe()
            emit({ type: 'end' })
            resolve()
          },
          connectionId
        )

        emit({ type: 'ready', subscriptionId })
      })
    }
  })
]
