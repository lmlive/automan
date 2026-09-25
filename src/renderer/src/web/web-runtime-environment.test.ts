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

describe('web runtime environment storage', () => {
  let storage: MemoryStorage

  beforeEach(() => {
    vi.resetModules()
    storage = new MemoryStorage()
    vi.stubGlobal('window', { localStorage: storage })
  })

  it('migrates the legacy single environment into the multi-environment store', async () => {
    storage.setItem('orca.web.runtimeEnvironment.v1', JSON.stringify(environment('web-a', 'A')))
    const { readStoredWebRuntimeEnvironments } = await import('./web-runtime-environment')

    expect(readStoredWebRuntimeEnvironments().map((entry) => entry.id)).toEqual(['web-a'])
    expect(JSON.parse(storage.getItem('orca.web.runtimeEnvironments.v1') ?? '{}')).toEqual({
      version: 1,
      environments: [environment('web-a', 'A')]
    })
  })

  it('keeps existing environments when a second environment is added', async () => {
    const { readStoredWebRuntimeEnvironments, upsertStoredWebRuntimeEnvironment } =
      await import('./web-runtime-environment')

    upsertStoredWebRuntimeEnvironment(environment('web-a', 'A'))
    upsertStoredWebRuntimeEnvironment(environment('web-b', 'B'))

    expect(readStoredWebRuntimeEnvironments().map((entry) => entry.name)).toEqual(['A', 'B'])
  })
})
