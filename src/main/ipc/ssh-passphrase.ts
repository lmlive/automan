import { ipcMain, type BrowserWindow } from 'electron'
import { randomUUID } from 'node:crypto'
import { SSH_CREDENTIAL_TIMEOUT_MS, type SshCredentialKind } from '../ssh/ssh-connection-utils'
import { emitSshRuntimeEvent } from './ssh-runtime-events'

const pendingRequests = new Map<string, { resolve: (value: string | null) => void }>()

function notifyCredentialResolved(
  getMainWindow: () => BrowserWindow | null,
  requestId: string
): void {
  emitSshRuntimeEvent({ type: 'credentialResolved', requestId })
  const win = getMainWindow()
  if (win && !win.isDestroyed()) {
    win.webContents.send('ssh:credential-resolved', { requestId })
  }
}

export function requestCredential(
  getMainWindow: () => BrowserWindow | null,
  targetId: string,
  kind: SshCredentialKind,
  detail: string,
  echo?: boolean,
  signal?: AbortSignal
): Promise<string | null> {
  const requestId = randomUUID()
  const { promise, resolve } = Promise.withResolvers<string | null>()
  let timer: ReturnType<typeof setTimeout>
  const finish = (value: string | null): void => {
    if (!pendingRequests.delete(requestId)) {
      return
    }
    clearTimeout(timer)
    signal?.removeEventListener('abort', onAbort)
    notifyCredentialResolved(getMainWindow, requestId)
    resolve(value)
  }
  const onAbort = (): void => finish(null)
  timer = setTimeout(() => finish(null), SSH_CREDENTIAL_TIMEOUT_MS)
  pendingRequests.set(requestId, { resolve: finish })
  if (signal?.aborted) {
    finish(null)
    return promise
  }
  signal?.addEventListener('abort', onAbort, { once: true })

  emitSshRuntimeEvent({ type: 'credentialRequest', requestId, targetId, kind, detail })
  const win = getMainWindow()
  if (win && !win.isDestroyed()) {
    win.webContents.send('ssh:credential-request', { requestId, targetId, kind, detail, echo })
  }
  return promise
}

export function resolveCredentialRequest(requestId: string, value: string | null): void {
  pendingRequests.get(requestId)?.resolve(value)
}

export function registerCredentialHandler(): void {
  ipcMain.removeHandler('ssh:submitCredential')
  ipcMain.handle(
    'ssh:submitCredential',
    (_event, args: { requestId: string; value: string | null }) => {
      resolveCredentialRequest(args.requestId, args.value)
    }
  )
}
