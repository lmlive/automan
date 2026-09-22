import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createTestStore } from './store-test-helpers'
import type { Repo } from '../../../../shared/types'
import {
  createCompatibleRuntimeStatusResponseIfNeeded,
  type RuntimeEnvironmentCallRequest
} from '../../runtime/runtime-compatibility-test-fixture'
import { clearRuntimeCompatibilityCacheForTests } from '../../runtime/runtime-rpc-client'

// Why: a paired web client has no Orca main process, so every `window.api` call
// proxies to the paired runtime. Running the 'local' catalog pass there stores a
// phantom `local` copy of each repo/worktree ahead of the real
// `runtime:<envId>` one; that phantom wins the worktree lookup and routes its
// terminals to the local IPC transport, which the web preload rejects with
// "Local PTYs are unavailable in the web client."

const remoteRepo: Repo = {
  id: 'remote-repo',
  path: '/srv/repo',
  displayName: 'Remote',
  badgeColor: '#000',
  addedAt: 1
}

const reposList = vi.fn()
const projectsList = vi.fn()
const listHostSetups = vi.fn()
const projectGroupsList = vi.fn()
const folderWorkspacesList = vi.fn()
const runtimeEnvironmentsList = vi.fn()
const runtimeEnvironmentCall = vi.fn()
const runtimeEnvironmentTransportCall = vi.fn()
const dispatchEventMock = vi.fn()

function installWebClientWindow(): void {
  vi.stubGlobal('window', {
    // Why: the web-client predicate reads this flag (and/or a /web-index.html
    // pathname); the flag alone is what the web bundle sets.
    __ORCA_WEB_CLIENT__: true,
    api: {
      repos: { list: reposList },
      projects: { list: projectsList, listHostSetups: listHostSetups },
      projectGroups: { list: projectGroupsList },
      folderWorkspaces: { list: folderWorkspacesList },
      runtimeEnvironments: {
        call: runtimeEnvironmentTransportCall,
        list: runtimeEnvironmentsList
      }
    },
    dispatchEvent: dispatchEventMock
  })
}

beforeEach(() => {
  clearRuntimeCompatibilityCacheForTests()
  vi.unstubAllGlobals()
  reposList.mockReset()
  projectsList.mockReset()
  listHostSetups.mockReset()
  projectGroupsList.mockReset()
  folderWorkspacesList.mockReset()
  runtimeEnvironmentsList.mockReset()
  runtimeEnvironmentCall.mockReset()
  runtimeEnvironmentTransportCall.mockReset()
  dispatchEventMock.mockReset()

  reposList.mockResolvedValue([remoteRepo])
  projectsList.mockResolvedValue([])
  listHostSetups.mockResolvedValue([])
  projectGroupsList.mockResolvedValue([])
  folderWorkspacesList.mockResolvedValue([])
  runtimeEnvironmentsList.mockResolvedValue([{ id: 'env-1', name: 'Orca Server' }])
  runtimeEnvironmentCall.mockImplementation((args: RuntimeEnvironmentCallRequest) => {
    if (args.method === 'repo.list') {
      return {
        id: 'rpc-repo-list',
        ok: true,
        result: { repos: [remoteRepo] },
        _meta: { runtimeId: 'runtime-remote' }
      }
    }
    if (args.method === 'projectGroup.list') {
      return {
        id: 'rpc-project-group-list',
        ok: true,
        result: { groups: [] },
        _meta: { runtimeId: 'runtime-remote' }
      }
    }
    if (args.method === 'folderWorkspace.list') {
      return {
        id: 'rpc-folder-workspace-list',
        ok: true,
        result: { folderWorkspaces: [] },
        _meta: { runtimeId: 'runtime-remote' }
      }
    }
    return {
      id: 'rpc-other',
      ok: true,
      result: { projects: [], setups: [] },
      _meta: { runtimeId: 'runtime-remote' }
    }
  })
  runtimeEnvironmentTransportCall.mockImplementation((args: RuntimeEnvironmentCallRequest) => {
    return createCompatibleRuntimeStatusResponseIfNeeded(args) ?? runtimeEnvironmentCall(args)
  })
})

describe('paired web client all-host catalog', () => {
  it('never stamps a phantom local host when every api call proxies to the runtime', async () => {
    installWebClientWindow()
    const store = createTestStore()

    await store.getState().fetchReposForAllHosts()
    await store.getState().fetchProjectGroupsForAllHosts()
    await store.getState().fetchFolderWorkspacesForAllHosts()

    const hostIds = store.getState().repos.map((repo) => repo.executionHostId)
    expect(hostIds).toEqual(['runtime:env-1'])
    // Why: the duplicate local row is what the sidebar rendered twice and what
    // made the terminal pane choose the local transport.
    expect(hostIds).not.toContain('local')
  })

  it('loads the paired runtime catalog during the local-first startup pass', async () => {
    // Why: startup calls these with remoteHosts:'skip' to paint local data first.
    // A web client has no local data, so skipping the runtime pass would leave
    // the sidebar empty until the later refresh.
    installWebClientWindow()
    const store = createTestStore()

    await store.getState().fetchReposForAllHosts({ remoteHosts: 'skip' })
    await store.getState().fetchProjectGroupsForAllHosts({ remoteHosts: 'skip' })
    await store.getState().fetchFolderWorkspacesForAllHosts({ remoteHosts: 'skip' })

    expect(store.getState().repos.map((repo) => `${repo.id}:${repo.executionHostId}`)).toEqual([
      'remote-repo:runtime:env-1'
    ])
  })

  it('keeps the local catalog pass for the desktop client', async () => {
    // Why: the desktop renderer really does own a local catalog, so the guard
    // must not remove its local rows.
    vi.stubGlobal('window', {
      api: {
        repos: { list: reposList },
        projects: { list: projectsList, listHostSetups: listHostSetups },
        projectGroups: { list: projectGroupsList },
        folderWorkspaces: { list: folderWorkspacesList },
        runtimeEnvironments: {
          call: runtimeEnvironmentTransportCall,
          list: runtimeEnvironmentsList
        }
      },
      dispatchEvent: dispatchEventMock
    })
    const store = createTestStore()

    await store.getState().fetchReposForAllHosts()

    expect(
      store
        .getState()
        .repos.map((repo) => `${repo.id}:${repo.executionHostId}`)
        .sort()
    ).toEqual(['remote-repo:runtime:env-1', 'remote-repo:local'].sort())
  })
})
