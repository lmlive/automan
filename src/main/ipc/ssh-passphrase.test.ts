import { beforeEach, describe, expect, it, vi } from 'vitest'

const { emitSshRuntimeEventMock } = vi.hoisted(() => ({
  emitSshRuntimeEventMock: vi.fn()
}))

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn(),
    removeHandler: vi.fn()
  }
}))

vi.mock('./ssh-runtime-events', () => ({
  emitSshRuntimeEvent: emitSshRuntimeEventMock
}))

import { requestCredential, resolveCredentialRequest } from './ssh-passphrase'

describe('SSH credential prompts', () => {
  beforeEach(() => {
    emitSshRuntimeEventMock.mockReset()
  })

  it('fans prompts out to desktop and paired runtime clients', async () => {
    const send = vi.fn()
    const getMainWindow = () => ({ isDestroyed: () => false, webContents: { send } }) as never

    const pending = requestCredential(getMainWindow, 'ssh-1', 'password', 'Password required')

    expect(send).toHaveBeenCalledWith(
      'ssh:credential-request',
      expect.objectContaining({ targetId: 'ssh-1', kind: 'password' })
    )
    expect(emitSshRuntimeEventMock).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'credentialRequest', targetId: 'ssh-1', kind: 'password' })
    )
    const requestId = emitSshRuntimeEventMock.mock.calls[0]?.[0].requestId as string
    resolveCredentialRequest(requestId, null)
    await expect(pending).resolves.toBeNull()
  })
})
