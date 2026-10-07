import type { EnrichedDetectedPort, PortForwardEntry, SshConnectionState } from './ssh-types'

export type SshCredentialKind = 'passphrase' | 'password'

// Why: the SSH lifecycle in the main process reaches the desktop renderer
// through `webContents.send`, which is a no-op under headless `orca serve`.
// Paired web clients receive the same payloads through the `ssh.subscribe`
// streaming RPC, so the event shape lives in shared where both sides see it.
export type SshRuntimeEvent =
  | { type: 'stateChanged'; targetId: string; state: SshConnectionState }
  | {
      type: 'credentialRequest'
      requestId: string
      targetId: string
      kind: SshCredentialKind
      detail: string
    }
  | { type: 'credentialResolved'; requestId: string }
  | { type: 'portForwardsChanged'; targetId: string; forwards: PortForwardEntry[] }
  | { type: 'detectedPortsChanged'; targetId: string; ports: EnrichedDetectedPort[] }

export type SshRuntimeEventStreamMessage =
  | { type: 'ready'; subscriptionId: string }
  | SshRuntimeEvent
  | { type: 'end' }
