import type { SshRuntimeEvent } from '../../shared/ssh-runtime-events'

// Why: the SSH lifecycle in `ipc/ssh.ts` reaches the desktop renderer through
// `webContents.send`, which is a no-op under headless `orca serve`. Paired web
// clients get the same events through this bus instead, fanned out by the
// `ssh.subscribe` streaming RPC over the WebSocket.
export type { SshRuntimeEvent }

const listeners = new Set<(event: SshRuntimeEvent) => void>()

export function onSshRuntimeEvent(listener: (event: SshRuntimeEvent) => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function emitSshRuntimeEvent(event: SshRuntimeEvent): void {
  for (const listener of listeners) {
    listener(event)
  }
}
