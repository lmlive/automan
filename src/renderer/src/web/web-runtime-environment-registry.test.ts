import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { StoredWebRuntimeEnvironment } from './web-runtime-environment'

class MemoryStorage implements Storage {
  private readonly values = new Map<string, string>()
  get length(): number {
    return this.values.size
  }
  clear(): void {
    this.values.clear()
  }
  getItem(key: string): string | null {
    return this.values.get(key) ?? null
  }
  key(index: number): string | null {
    return Array.from(this.values.keys())[index] ?? null
  }
  removeItem(key: string): void {
    this.values.delete(key)
  }
  setItem(key: string, value: string): void {
    this.values.set(key, value)
  }
}

function environment(id: string, name: string): StoredWebRuntimeEnvironment {
  return {
    id,
    name,
    createdAt: 1,
    updatedAt: 1,
    lastUsedAt: null,
    runtimeId: null,
    preferredEndpointId: `ws-${id}`,
    endpoints: [
      {
        id: `ws-${id}`,
        kind: 'websocket',
        label: 'WebSocket',
        endpoint: `ws://${id}.test/rpc`,
        deviceToken: `token-${id}`,
        publicKeyB64: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA='
      }
    ]
  }
}

describe('web runtime environment registry', () => {
  let storage: MemoryStorage

  beforeEach(() => {
    vi.resetModules()
    storage = new MemoryStorage()
    vi.stubGlobal('window', { localStorage: storage })
    storage.setItem(
      'orca.web.runtimeEnvironments.v1',
      JSON.stringify({
        version: 1,
        environments: [environment('web-a', 'A'), environment('web-b', 'B')]
      })
    )
  })

  it('resolves environment selectors strictly instead of redirecting stale web ids', async () => {
    const { installWebRuntimeEnvironmentRegistry, resolveWebRuntimeEnvironment } =
      await import('./web-runtime-environment-registry')
    installWebRuntimeEnvironmentRegistry()

    expect(() => resolveWebRuntimeEnvironment('web-stale')).toThrow(
      'Unknown Orca runtime environment: web-stale'
    )
  })

  it('persists the focused environment across registry reinstallation', async () => {
    const registry = await import('./web-runtime-environment-registry')
    registry.installWebRuntimeEnvironmentRegistry()
    registry.setFocusedWebRuntimeEnvironmentId('web-b')
    registry.installWebRuntimeEnvironmentRegistry()

    expect(registry.getFocusedWebRuntimeEnvironmentId()).toBe('web-b')
    expect(storage.getItem('orca.web.activeRuntimeEnvironmentId.v1')).toBe('web-b')
  })

  it('keeps an explicit disconnected focus instead of selecting the first server again', async () => {
    const registry = await import('./web-runtime-environment-registry')
    registry.installWebRuntimeEnvironmentRegistry()
    registry.setFocusedWebRuntimeEnvironmentId(null)
    registry.installWebRuntimeEnvironmentRegistry()

    expect(registry.getFocusedWebRuntimeEnvironmentId()).toBeNull()
    expect(registry.requireFocusedWebRuntimeEnvironmentOrNull()).toBeNull()
  })

  it('rejects a duplicate server name', async () => {
    const registry = await import('./web-runtime-environment-registry')
    registry.installWebRuntimeEnvironmentRegistry()

    expect(() =>
      registry.addWebRuntimeEnvironmentFromPairingCode({
        name: 'A',
        pairingCode: Buffer.from(
          JSON.stringify({
            v: 2,
            endpoint: 'ws://new.test/rpc',
            deviceToken: 'token-new',
            publicKeyB64: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA='
          })
        ).toString('base64url')
      })
    ).toThrow('A server named "A" already exists.')
  })
})
