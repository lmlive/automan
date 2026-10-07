import { ipcMain, type BrowserWindow } from 'electron'
import { randomUUID } from 'node:crypto'
import type { SshCredentialKind } from '../ssh/ssh-connection-utils'
import { emitSshRuntimeEvent } from './ssh-runtime-events'

const CREDENTIAL_TIMEOUT_MS = 120_000
const pendingRequests = new Map<string, { resolve: (value: string | null) => void }>()

// Why: set by registerCredentialHandler (desktop) and by the serve-mode
// registration, so a credential resolved over the RPC path can still notify
// whichever window, if any, is attached.
let getCurrentMainWindowResolver: () => BrowserWindow | null = () => null

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
  detail: string
): Promise<string | null> {
  const requestId = randomUUID()
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      if (pendingRequests.delete(requestId)) {
        notifyCredentialResolved(getMainWindow, requestId)
        resolve(null)
      }
    }, CREDENTIAL_TIMEOUT_MS)

    pendingRequests.set(requestId, {
      resolve: (value) => {
        clearTimeout(timer)
        resolve(value)
      }
    })

    const win = getMainWindow()
    if (win && !win.isDestroyed()) {
      win.webContents.send('ssh:credential-request', { requestId, targetId, kind, detail })
    }
    // Why: a desktop runtime can simultaneously serve a paired browser. Fan the
    // prompt to both transports; the shared pending map makes the first response
    // win and later submissions harmless.
    emitSshRuntimeEvent({ type: 'credentialRequest', requestId, targetId, kind, detail })
  })
}

// Why: the RPC layer answers prompts from paired web clients, which have no
// ipcRenderer. Kept next to the ipcMain handler so both paths share one
// pendingRequests map — a credential can only ever resolve once.
export function resolveCredentialRequest(requestId: string, value: string | null): void {
  const pending = pendingRequests.get(requestId)
  if (!pending) {
    return
  }
  pendingRequests.delete(requestId)
  notifyCredentialResolved(getCurrentMainWindowResolver, requestId)
  pending.resolve(value)
}

export function registerCredentialHandler(getMainWindow: () => BrowserWindow | null): void {
  getCurrentMainWindowResolver = getMainWindow
  ipcMain.removeHandler('ssh:submitCredential')
  ipcMain.handle(
    'ssh:submitCredential',
    (_event, args: { requestId: string; value: string | null }) => {
      const pending = pendingRequests.get(args.requestId)
      if (pending) {
        pendingRequests.delete(args.requestId)
        notifyCredentialResolved(getMainWindow, args.requestId)
        pending.resolve(args.value)
      }
    }
  )
}
