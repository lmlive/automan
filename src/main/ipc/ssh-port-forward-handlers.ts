import { ipcMain } from 'electron'
import type { EnrichedDetectedPort, PortForwardEntry } from '../../shared/ssh-types'
import {
  enrichSshForwardEntries,
  getWorktreeIdsForConnection
} from '../ports/ssh-advertised-url-enrichment'
import { activeSessions } from './ssh-active-relay-sessions'
import {
  connectionManager,
  getCurrentMainWindow,
  persistedStore,
  portForwardManager
} from './ssh-ipc-context'
import { persistPortForwards } from './ssh-port-forward-persistence'
import { broadcastPortForwards, enrichDetected } from './ssh-renderer-broadcast'

export async function addPortForward(args: {
  targetId: string
  localPort: number
  remoteHost: string
  remotePort: number
  label?: string
}): Promise<PortForwardEntry> {
  const conn = connectionManager!.getConnection(args.targetId)
  if (!conn) {
    throw new Error(`SSH connection "${args.targetId}" not found`)
  }
  const entry = await portForwardManager!.addForward(
    args.targetId,
    conn,
    args.localPort,
    args.remoteHost,
    args.remotePort,
    args.label
  )
  persistPortForwards(args.targetId)
  broadcastPortForwards(getCurrentMainWindow, args.targetId)
  return entry
}

export async function updatePortForward(args: {
  id: string
  targetId: string
  localPort: number
  remoteHost: string
  remotePort: number
  label?: string
}): Promise<PortForwardEntry> {
  const conn = connectionManager!.getConnection(args.targetId)
  if (!conn) {
    throw new Error(`SSH connection "${args.targetId}" not found`)
  }
  try {
    const entry = await portForwardManager!.updateForward(
      args.id,
      conn,
      args.localPort,
      args.remoteHost,
      args.remotePort,
      args.label
    )
    persistPortForwards(entry.connectionId)
    broadcastPortForwards(getCurrentMainWindow, entry.connectionId)
    return entry
  } catch (err) {
    // Why: edit/rollback may have failed, so resync renderer to actual runtime state.
    persistPortForwards(args.targetId)
    broadcastPortForwards(getCurrentMainWindow, args.targetId)
    throw err
  }
}

export async function removePortForward(id: string): Promise<PortForwardEntry | null> {
  const removed = await portForwardManager!.removeForwardAndWait(id)
  if (removed) {
    persistPortForwards(removed.connectionId)
    broadcastPortForwards(getCurrentMainWindow, removed.connectionId)
  }
  return removed
}

export function listPortForwards(targetId?: string): PortForwardEntry[] {
  const all = portForwardManager!.listForwards(targetId)
  if (!persistedStore || !targetId) {
    // Why: cross-target entries can't be mapped to worktrees in one call, so serve the raw list.
    return all
  }
  return enrichSshForwardEntries(all, getWorktreeIdsForConnection(persistedStore, targetId))
}

export function listDetectedPorts(targetId: string): EnrichedDetectedPort[] {
  const session = activeSessions.get(targetId)
  const ports = session?.getPortScanner()?.getDetectedPorts(targetId) ?? []
  return enrichDetected(targetId, ports)
}

export function registerSshPortForwardHandlers(): void {
  ipcMain.handle(
    'ssh:addPortForward',
    async (
      _event,
      args: {
        targetId: string
        localPort: number
        remoteHost: string
        remotePort: number
        label?: string
      }
    ) => addPortForward(args)
  )

  ipcMain.handle(
    'ssh:updatePortForward',
    async (
      _event,
      args: {
        id: string
        targetId: string
        localPort: number
        remoteHost: string
        remotePort: number
        label?: string
      }
    ) => updatePortForward(args)
  )

  ipcMain.handle('ssh:removePortForward', async (_event, args: { id: string }) => {
    return removePortForward(args.id)
  })

  ipcMain.handle('ssh:listPortForwards', (_event, args?: { targetId?: string }) => {
    return listPortForwards(args?.targetId)
  })

  ipcMain.handle('ssh:listDetectedPorts', (_event, args: { targetId: string }) => {
    return listDetectedPorts(args.targetId)
  })
}
