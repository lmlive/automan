import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { PreloadApi } from '../../../preload/api-types'

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

function pairingCode(endpoint: string, token: string): string {
  return Buffer.from(
    JSON.stringify({
      v: 2,
      endpoint,
      deviceToken: token,
      publicKeyB64: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA='
    })
  ).toString('base64url')
}

describe('web preload multi-server environments', () => {
  beforeEach(() => {
    vi.resetModules()
    const localStorage = new MemoryStorage()
    const windowStub = {
      localStorage,
      location: { protocol: 'http:', reload: vi.fn() },
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      setTimeout,
      clearTimeout,
      setInterval,
      clearInterval,
      atob: (value: string) => Buffer.from(value, 'base64').toString('binary'),
      btoa: (value: string) => Buffer.from(value, 'binary').toString('base64')
    } as unknown as Window & typeof globalThis
    vi.stubGlobal('window', windowStub)
    vi.stubGlobal('navigator', { userAgent: 'Linux', hardwareConcurrency: 8 })
  })

  it('lists and resolves both servers after adding the second one', async () => {
    const { installWebPreloadApi } = await import('./web-preload-api')
    installWebPreloadApi()
    const api = (window as unknown as { api: PreloadApi }).api

    const first = await api.runtimeEnvironments.addFromPairingCode({
      name: 'Server A',
      pairingCode: pairingCode('ws://a.test/rpc', 'token-a')
    })
    const second = await api.runtimeEnvironments.addFromPairingCode({
      name: 'Server B',
      pairingCode: pairingCode('ws://b.test/rpc', 'token-b')
    })

    expect((await api.runtimeEnvironments.list()).map((environment) => environment.name)).toEqual([
      'Server A',
      'Server B'
    ])
    await expect(
      api.runtimeEnvironments.resolve({ selector: first.environment.id })
    ).resolves.toMatchObject({ id: first.environment.id, name: 'Server A' })
    await expect(
      api.runtimeEnvironments.resolve({ selector: second.environment.id })
    ).resolves.toMatchObject({ id: second.environment.id, name: 'Server B' })
  })

  it('routes mobile pairing management through the focused runtime', async () => {
    const { WebRuntimeClient } = await import('./web-runtime-client')
    vi.spyOn(
      WebRuntimeClient.prototype as unknown as { openConnection: () => void },
      'openConnection'
    ).mockImplementation(() => undefined)
    const callSpy = vi.spyOn(WebRuntimeClient.prototype, 'call').mockImplementation((async (
      method: string
    ) => {
      if (method === 'mobile.pairing.listNetworkInterfaces') {
        return {
          ok: true,
          result: { interfaces: [{ name: 'tailscale0', address: '100.64.1.20' }] },
          _meta: { runtimeId: 'runtime-a' }
        }
      }
      if (method === 'mobile.pairing.create') {
        return {
          ok: true,
          result: {
            available: true,
            pairingUrl: 'orca://pair?code=mobile',
            endpoint: 'ws://100.64.1.20:6768',
            deviceId: 'mobile-1'
          },
          _meta: { runtimeId: 'runtime-a' }
        }
      }
      throw new Error(`Unexpected method: ${method}`)
    }) as typeof WebRuntimeClient.prototype.call)
    const { installWebPreloadApi } = await import('./web-preload-api')
    installWebPreloadApi()
    const api = (window as unknown as { api: PreloadApi }).api
    const added = await api.runtimeEnvironments.addFromPairingCode({
      name: 'Server A',
      pairingCode: pairingCode('ws://a.test/rpc', 'token-a')
    })
    await api.settings.set({ activeRuntimeEnvironmentId: added.environment.id })

    await expect(api.mobile.listNetworkInterfaces()).resolves.toEqual({
      interfaces: [{ name: 'tailscale0', address: '100.64.1.20' }]
    })
    await expect(api.mobile.getPairingQR({ address: '100.64.1.20' })).resolves.toMatchObject({
      available: true,
      pairingUrl: 'orca://pair?code=mobile',
      endpoint: 'ws://100.64.1.20:6768',
      deviceId: 'mobile-1',
      qrDataUrl: expect.stringMatching(/^data:image\/png;base64,/)
    })
    expect(callSpy).toHaveBeenCalledWith(
      'mobile.pairing.create',
      { address: '100.64.1.20' },
      { timeoutMs: undefined }
    )
  })

  it('removes only the selected server after focus has been cleared', async () => {
    const { installWebPreloadApi } = await import('./web-preload-api')
    installWebPreloadApi()
    const api = (window as unknown as { api: PreloadApi }).api

    const first = await api.runtimeEnvironments.addFromPairingCode({
      name: 'Server A',
      pairingCode: pairingCode('ws://a.test/rpc', 'token-a')
    })
    await api.runtimeEnvironments.addFromPairingCode({
      name: 'Server B',
      pairingCode: pairingCode('ws://b.test/rpc', 'token-b')
    })
    await api.settings.set({ activeRuntimeEnvironmentId: null })
    await api.runtimeEnvironments.remove({ selector: first.environment.id })

    expect((await api.runtimeEnvironments.list()).map((environment) => environment.name)).toEqual([
      'Server B'
    ])
  })
})
