import type {
  EnrichedDetectedPort,
  PortForwardEntry,
  SshConnectionState,
  SshTarget
} from '../../shared/ssh-types'

export type SshTargetDraft = Omit<SshTarget, 'id'>

export type SshTestConnectionResult = {
  success: boolean
  error?: string
  state?: SshConnectionState
}

export type SshBrowseResult = {
  entries: { name: string; isDirectory: boolean }[]
  resolvedPath: string
}

export type SshAddPortForwardArgs = {
  targetId: string
  localPort: number
  remoteHost: string
  remotePort: number
  label?: string
}

export type SshUpdatePortForwardArgs = SshAddPortForwardArgs & { id: string }

// Why: the SSH lifecycle lives in ipc/ssh.ts as closures inside
// registerSshHandlers. Headless `orca serve` has no renderer, so paired web
// clients reach the same operations through runtime RPC. Publishing the
// closures as one object keeps a single implementation — a second copy for the
// web path would drift from the IPC one on credential, relay, and port state.
export type SshOperations = {
  listTargets(): SshTarget[]
  addTarget(target: SshTargetDraft): SshTarget
  updateTarget(id: string, updates: Partial<SshTargetDraft>): SshTarget | null
  removeTarget(id: string): Promise<void>
  importConfig(args?: { reAdopt?: boolean }): SshTarget[]
  connect(targetId: string): Promise<SshConnectionState>
  disconnect(targetId: string): Promise<void>
  terminateSessions(targetId: string): Promise<void>
  resetRelay(targetId: string): Promise<void>
  getState(targetId: string): SshConnectionState | undefined
  needsPassphrasePrompt(targetId: string): boolean
  testConnection(targetId: string): Promise<SshTestConnectionResult>
  addPortForward(args: SshAddPortForwardArgs): Promise<PortForwardEntry>
  updatePortForward(args: SshUpdatePortForwardArgs): Promise<PortForwardEntry>
  removePortForward(id: string): Promise<PortForwardEntry | null>
  listPortForwards(targetId?: string): PortForwardEntry[]
  listDetectedPorts(targetId: string): EnrichedDetectedPort[]
  browseDir(args: { targetId: string; dirPath: string }): Promise<SshBrowseResult>
  submitCredential(args: { requestId: string; value: string | null }): void
}

let registeredOperations: SshOperations | null = null

export function registerSshOperations(operations: SshOperations): void {
  registeredOperations = operations
}

export function clearSshOperations(): void {
  registeredOperations = null
}

/** Throws when the SSH subsystem was never registered for this process. */
export function getSshOperations(): SshOperations {
  if (!registeredOperations) {
    throw new Error('SSH handlers are not registered.')
  }
  return registeredOperations
}
