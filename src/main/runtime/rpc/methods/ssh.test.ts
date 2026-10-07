import { describe, expect, it, vi, beforeEach } from 'vitest'
import { RpcDispatcher } from '../dispatcher'
import type { RpcRequest } from '../core'
import type { OrcaRuntimeService } from '../../orca-runtime'
import { SSH_METHODS } from './ssh'

const { connectRegisteredSshTargetMock, getRegisteredSshStateMock } = vi.hoisted(() => ({
  connectRegisteredSshTargetMock: vi.fn(),
  getRegisteredSshStateMock: vi.fn()
}))

const { getSshOperationsMock, onSshRuntimeEventMock } = vi.hoisted(() => ({
  getSshOperationsMock: vi.fn(),
  onSshRuntimeEventMock: vi.fn()
}))

vi.mock('../../../ipc/ssh', () => ({
  connectRegisteredSshTarget: connectRegisteredSshTargetMock,
  getRegisteredSshState: getRegisteredSshStateMock
}))

vi.mock('../../../ipc/ssh-operations', () => ({
  getSshOperations: getSshOperationsMock
}))

vi.mock('../../../ipc/ssh-runtime-events', () => ({
  onSshRuntimeEvent: onSshRuntimeEventMock
}))

function makeRequest(method: string, params?: unknown): RpcRequest {
  return { id: 'req-1', authToken: 'tok', method, params }
}

function makeRuntime(): OrcaRuntimeService {
  return {
    getRuntimeId: () => 'test-runtime',
    registerSubscriptionCleanup: vi.fn()
  } as unknown as OrcaRuntimeService
}

describe('ssh RPC methods', () => {
  it('returns the registered SSH target state', async () => {
    const state = {
      targetId: 'ssh-1',
      status: 'connected',
      error: null,
      reconnectAttempt: 0
    }
    getRegisteredSshStateMock.mockReturnValueOnce(state)
    const dispatcher = new RpcDispatcher({ runtime: makeRuntime(), methods: SSH_METHODS })

    const response = await dispatcher.dispatch(makeRequest('ssh.getState', { targetId: 'ssh-1' }))

    expect(getRegisteredSshStateMock).toHaveBeenCalledWith('ssh-1')
    expect(response).toMatchObject({ ok: true, result: { state } })
  })

  it('connects through the registered desktop SSH lifecycle', async () => {
    const state = {
      targetId: 'ssh-1',
      status: 'connected',
      error: null,
      reconnectAttempt: 0
    }
    connectRegisteredSshTargetMock.mockResolvedValueOnce(state)
    const dispatcher = new RpcDispatcher({ runtime: makeRuntime(), methods: SSH_METHODS })

    const response = await dispatcher.dispatch(makeRequest('ssh.connect', { targetId: 'ssh-1' }))

    expect(connectRegisteredSshTargetMock).toHaveBeenCalledWith('ssh-1')
    expect(response).toMatchObject({ ok: true, result: { state } })
  })

  it('returns null when the target has no registered state yet', async () => {
    getRegisteredSshStateMock.mockReturnValueOnce(undefined)
    const dispatcher = new RpcDispatcher({ runtime: makeRuntime(), methods: SSH_METHODS })

    const response = await dispatcher.dispatch(makeRequest('ssh.getState', { targetId: 'ssh-1' }))

    expect(response).toMatchObject({ ok: true, result: { state: null } })
  })
})

describe('ssh RPC CRUD and port forwarding', () => {
  const operations = {
    listTargets: vi.fn(),
    addTarget: vi.fn(),
    updateTarget: vi.fn(),
    removeTarget: vi.fn(),
    importConfig: vi.fn(),
    connect: vi.fn(),
    disconnect: vi.fn(),
    terminateSessions: vi.fn(),
    resetRelay: vi.fn(),
    getState: vi.fn(),
    needsPassphrasePrompt: vi.fn(),
    testConnection: vi.fn(),
    addPortForward: vi.fn(),
    updatePortForward: vi.fn(),
    removePortForward: vi.fn(),
    listPortForwards: vi.fn(),
    listDetectedPorts: vi.fn(),
    browseDir: vi.fn(),
    submitCredential: vi.fn()
  }

  beforeEach(() => {
    for (const fn of Object.values(operations)) {
      fn.mockReset()
    }
    getSshOperationsMock.mockReturnValue(operations)
  })

  it('lists targets through the shared operations table', async () => {
    operations.listTargets.mockReturnValue([{ id: 'ssh-1' }])
    const dispatcher = new RpcDispatcher({ runtime: makeRuntime(), methods: SSH_METHODS })

    const response = await dispatcher.dispatch(makeRequest('ssh.listTargets'))

    expect(response).toMatchObject({ ok: true, result: { targets: [{ id: 'ssh-1' }] } })
  })

  it('rejects an addTarget payload with no host', async () => {
    const dispatcher = new RpcDispatcher({ runtime: makeRuntime(), methods: SSH_METHODS })

    const response = await dispatcher.dispatch(
      makeRequest('ssh.addTarget', {
        target: { label: 'x', host: '', port: 22, username: 'u' }
      })
    )

    expect(response).toMatchObject({ ok: false, error: { code: 'invalid_argument' } })
    expect(operations.addTarget).not.toHaveBeenCalled()
  })

  it('rejects an out-of-range port', async () => {
    const dispatcher = new RpcDispatcher({ runtime: makeRuntime(), methods: SSH_METHODS })

    const response = await dispatcher.dispatch(
      makeRequest('ssh.addTarget', {
        target: { label: 'x', host: 'h', port: 70000, username: 'u' }
      })
    )

    expect(response).toMatchObject({ ok: false, error: { code: 'invalid_argument' } })
  })

  it('passes through unknown target fields on addTarget', async () => {
    // Why: SshTarget carries desktop-authored optional fields (jumpHost,
    // identityFile, relayGracePeriodSeconds). A web client must not strip them
    // when re-saving a target that the desktop created.
    operations.addTarget.mockReturnValue({ id: 'ssh-1', host: 'h' })
    const dispatcher = new RpcDispatcher({ runtime: makeRuntime(), methods: SSH_METHODS })

    const response = await dispatcher.dispatch(
      makeRequest('ssh.addTarget', {
        target: { label: 'x', host: 'h', port: 22, username: 'u', jumpHost: 'bastion' }
      })
    )

    expect(response.ok).toBe(true)
    expect(operations.addTarget).toHaveBeenCalledWith(
      expect.objectContaining({ jumpHost: 'bastion' })
    )
  })

  it('rejects internal target ownership fields', async () => {
    const dispatcher = new RpcDispatcher({ runtime: makeRuntime(), methods: SSH_METHODS })

    const response = await dispatcher.dispatch(
      makeRequest('ssh.addTarget', {
        target: {
          label: 'x',
          host: 'h',
          port: 22,
          username: 'u',
          owner: { type: 'on-demand-runtime', runtimeId: 'hidden' }
        }
      })
    )

    expect(response).toMatchObject({ ok: false, error: { code: 'invalid_argument' } })
    expect(operations.addTarget).not.toHaveBeenCalled()
  })

  it('rejects invalid relay grace periods', async () => {
    const dispatcher = new RpcDispatcher({ runtime: makeRuntime(), methods: SSH_METHODS })

    const response = await dispatcher.dispatch(
      makeRequest('ssh.updateTarget', {
        id: 'ssh-1',
        updates: { relayGracePeriodSeconds: 1 }
      })
    )

    expect(response).toMatchObject({ ok: false, error: { code: 'invalid_argument' } })
    expect(operations.updateTarget).not.toHaveBeenCalled()
  })

  it('forwards port-forward arguments and unwraps the entry', async () => {
    operations.addPortForward.mockResolvedValue({ id: 'fwd-1', connectionId: 'ssh-1' })
    const dispatcher = new RpcDispatcher({ runtime: makeRuntime(), methods: SSH_METHODS })

    const response = await dispatcher.dispatch(
      makeRequest('ssh.addPortForward', {
        targetId: 'ssh-1',
        localPort: 3000,
        remoteHost: '127.0.0.1',
        remotePort: 3000
      })
    )

    expect(operations.addPortForward).toHaveBeenCalledWith({
      targetId: 'ssh-1',
      localPort: 3000,
      remoteHost: '127.0.0.1',
      remotePort: 3000
    })
    expect(response).toMatchObject({ ok: true, result: { forward: { id: 'fwd-1' } } })
  })

  it('lists forwards for a target and for all targets', async () => {
    operations.listPortForwards.mockReturnValue([])
    const dispatcher = new RpcDispatcher({ runtime: makeRuntime(), methods: SSH_METHODS })

    await dispatcher.dispatch(makeRequest('ssh.listPortForwards', { targetId: 'ssh-1' }))
    expect(operations.listPortForwards).toHaveBeenLastCalledWith('ssh-1')

    await dispatcher.dispatch(makeRequest('ssh.listPortForwards'))
    expect(operations.listPortForwards).toHaveBeenLastCalledWith(undefined)
  })

  it('surfaces a missing SSH subsystem as an error rather than a crash', async () => {
    getSshOperationsMock.mockImplementation(() => {
      throw new Error('SSH handlers are not registered.')
    })
    const dispatcher = new RpcDispatcher({ runtime: makeRuntime(), methods: SSH_METHODS })

    const response = await dispatcher.dispatch(makeRequest('ssh.listTargets'))

    expect(response).toMatchObject({
      ok: false,
      error: { message: 'SSH handlers are not registered.' }
    })
  })
})

describe('ssh.subscribe streaming', () => {
  beforeEach(() => {
    onSshRuntimeEventMock.mockReset()
  })

  it('registers a cleanup and emits ready, then fans out lifecycle events', async () => {
    const registerSubscriptionCleanup = vi.fn()
    // Why: an array (not a `let`) — TS narrows a closure-assigned `let` to its
    // initial `null` at the call site, which reads as `never`.
    const listeners: ((event: unknown) => void)[] = []
    const unsubscribe = vi.fn()
    onSshRuntimeEventMock.mockImplementation((fn: (event: unknown) => void) => {
      listeners.push(fn)
      return unsubscribe
    })
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      registerSubscriptionCleanup
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: SSH_METHODS })

    const replies: unknown[] = []
    const dispatchPromise = dispatcher.dispatchStreaming(
      makeRequest('ssh.subscribe'),
      (response) => replies.push(JSON.parse(response)),
      { connectionId: 'conn-1' }
    )

    await vi.waitFor(() => expect(replies).toHaveLength(1))
    expect(replies[0]).toMatchObject({ ok: true, result: { type: 'ready' } })

    listeners[0]?.({ type: 'credentialResolved', requestId: 'r-1' })
    await vi.waitFor(() => expect(replies).toHaveLength(2))
    expect(replies[1]).toMatchObject({ result: { type: 'credentialResolved' } })

    // Why: the server-side listener must be reaped when the socket closes, or a
    // reconnecting web client leaks one runtime-event listener per reconnect.
    const [subscriptionId, cleanup] = registerSubscriptionCleanup.mock.calls[0] as [
      string,
      () => void,
      string
    ]
    expect(subscriptionId).toContain('conn-1')
    cleanup()
    expect(unsubscribe).toHaveBeenCalledTimes(1)
    await dispatchPromise
  })
})
