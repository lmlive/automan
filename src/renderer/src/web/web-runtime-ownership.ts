import type { DetectedWorktreeListResult, Worktree } from '../../../shared/types'
import { relativePathInsideRoot } from '../../../shared/cross-platform-path'
import { toRuntimeWorktreeSelector } from '../runtime/runtime-worktree-selector'
import type { StoredWebRuntimeEnvironment } from './web-runtime-environment'
import {
  callWebRuntimeEnvelope,
  callWebRuntimeResultForEnvironment,
  listWebRuntimeEnvironments,
  requireFocusedWebRuntimeEnvironmentOrNull
} from './web-runtime-environment-registry'

// Why: with several paired servers the web client has no single "the" runtime
// anymore, but the renderer still addresses files/git/worktrees by path or repo
// id (those preload signatures carry no host). Ownership has to be inferred, or
// every path-addressed call would silently hit whichever server is focused and
// fail with "No runtime worktree owns <path>".
const WORKTREE_CACHE_TTL_MS = 5_000
const REPO_OWNER_CACHE_TTL_MS = 5_000
const WEB_RUNTIME_WORKTREE_LIST_LIMIT = 10_000

type CachedWorktrees = { loadedAt: number; worktrees: Worktree[] }

// Why: visible (`worktree.list`) and detected (`worktree.detectedList`) rows are
// cached separately — path resolution needs detected rows (which include
// hidden-but-open worktrees) and must not pay for the sidebar list too.
const visibleWorktreesByEnvironmentId = new Map<string, CachedWorktrees>()
const detectedWorktreesByEnvironmentId = new Map<string, CachedWorktrees>()
const repoOwnerByRepoId = new Map<string, string>()
let repoOwnerIndexLoadedAt = 0

export function invalidateWebRuntimeWorktreeCaches(environmentId?: string | null): void {
  const trimmed = environmentId?.trim()
  if (trimmed) {
    visibleWorktreesByEnvironmentId.delete(trimmed)
    detectedWorktreesByEnvironmentId.delete(trimmed)
  } else {
    visibleWorktreesByEnvironmentId.clear()
    detectedWorktreesByEnvironmentId.clear()
  }
  repoOwnerByRepoId.clear()
  repoOwnerIndexLoadedAt = 0
}

/** Focus first, then the remaining paired servers in stored order. */
function getEnvironmentsInResolutionOrder(): StoredWebRuntimeEnvironment[] {
  const environments = listWebRuntimeEnvironments()
  const focused = requireFocusedWebRuntimeEnvironmentOrNull()
  if (!focused) {
    return environments
  }
  return [focused, ...environments.filter((environment) => environment.id !== focused.id)]
}

async function loadVisibleWorktrees(environment: StoredWebRuntimeEnvironment): Promise<Worktree[]> {
  const cached = visibleWorktreesByEnvironmentId.get(environment.id)
  if (cached && Date.now() - cached.loadedAt < WORKTREE_CACHE_TTL_MS) {
    return cached.worktrees
  }
  const worktrees = (
    await callWebRuntimeResultForEnvironment<{ worktrees: Worktree[] }>(
      environment,
      'worktree.list',
      { limit: WEB_RUNTIME_WORKTREE_LIST_LIMIT },
      15_000
    )
  ).worktrees
  visibleWorktreesByEnvironmentId.set(environment.id, { loadedAt: Date.now(), worktrees })
  return worktrees
}

async function loadDetectedWorktrees(
  environment: StoredWebRuntimeEnvironment
): Promise<Worktree[]> {
  const cached = detectedWorktreesByEnvironmentId.get(environment.id)
  if (cached && Date.now() - cached.loadedAt < WORKTREE_CACHE_TTL_MS) {
    return cached.worktrees
  }
  const repos = (
    await callWebRuntimeResultForEnvironment<{ repos: { id: string }[] }>(
      environment,
      'repo.list',
      undefined,
      15_000
    )
  ).repos
  const lists = await Promise.all(
    repos.map(async (repo) => {
      try {
        return (await callRuntimeDetectedWorktreesForEnvironment(environment, repo.id)).worktrees
      } catch {
        return []
      }
    })
  )
  const worktrees = lists.flat()
  detectedWorktreesByEnvironmentId.set(environment.id, { loadedAt: Date.now(), worktrees })
  return worktrees
}

export async function callRuntimeDetectedWorktreesForEnvironment(
  environment: StoredWebRuntimeEnvironment,
  repoId: string
): Promise<DetectedWorktreeListResult> {
  const response = await callWebRuntimeEnvelope<DetectedWorktreeListResult>(
    environment,
    'worktree.detectedList',
    { repo: repoId },
    15_000
  )
  if (response.ok) {
    return response.result
  }
  if (response.error.code !== 'method_not_found') {
    throw new Error(response.error.message)
  }
  const legacy = await callWebRuntimeResultForEnvironment<{ worktrees: Worktree[] }>(
    environment,
    'worktree.list',
    { repo: repoId, limit: WEB_RUNTIME_WORKTREE_LIST_LIMIT },
    15_000
  )
  return toLegacyDetectedWorktreeResult(repoId, legacy.worktrees)
}

export async function listAllRuntimeWorktrees(): Promise<Worktree[]> {
  const lists = await Promise.all(
    listWebRuntimeEnvironments().map(async (environment) => {
      try {
        return await loadVisibleWorktrees(environment)
      } catch {
        return []
      }
    })
  )
  return lists.flat()
}

export async function listAllRuntimeDetectedWorktrees(): Promise<Worktree[]> {
  const lists = await Promise.all(
    listWebRuntimeEnvironments().map(async (environment) => {
      try {
        return await loadDetectedWorktrees(environment)
      } catch {
        return []
      }
    })
  )
  return lists.flat()
}

export async function listRuntimeWorktreesForRepo(repoId: string): Promise<Worktree[]> {
  const environment = await resolveEnvironmentForRepo(repoId)
  const result = await callWebRuntimeResultForEnvironment<{ worktrees: Worktree[] }>(
    environment,
    'worktree.list',
    { repo: repoId, limit: WEB_RUNTIME_WORKTREE_LIST_LIMIT }
  )
  return result.worktrees
}

export async function listDetectedWorktreesForRepo(
  repoId: string
): Promise<DetectedWorktreeListResult> {
  const environment = await resolveEnvironmentForRepo(repoId)
  return callRuntimeDetectedWorktreesForEnvironment(environment, repoId)
}

/**
 * Which paired server owns this repo id. Repo ids are runtime-scoped, so the
 * first server that lists the repo wins; focus is probed first.
 */
export async function resolveEnvironmentForRepo(
  repoId: string
): Promise<StoredWebRuntimeEnvironment> {
  const environments = getEnvironmentsInResolutionOrder()
  if (environments.length === 0) {
    throw new Error('Pair this web client with an Orca server first.')
  }
  if (environments.length === 1) {
    return environments[0]!
  }
  if (Date.now() - repoOwnerIndexLoadedAt < REPO_OWNER_CACHE_TTL_MS) {
    const cached = repoOwnerByRepoId.get(repoId)
    const match = cached ? environments.find((entry) => entry.id === cached) : null
    if (match) {
      return match
    }
  }
  const perEnvironment = await Promise.all(
    environments.map(async (environment) => {
      try {
        const repos = (
          await callWebRuntimeResultForEnvironment<{ repos: { id: string }[] }>(
            environment,
            'repo.list',
            undefined,
            15_000
          )
        ).repos
        return { environment, repoIds: repos.map((repo) => repo.id) }
      } catch {
        return { environment, repoIds: [] as string[] }
      }
    })
  )
  repoOwnerByRepoId.clear()
  for (const { environment, repoIds } of perEnvironment) {
    for (const id of repoIds) {
      if (!repoOwnerByRepoId.has(id)) {
        repoOwnerByRepoId.set(id, environment.id)
      }
    }
  }
  repoOwnerIndexLoadedAt = Date.now()
  const owner = repoOwnerByRepoId.get(repoId)
  const match = owner ? environments.find((entry) => entry.id === owner) : null
  if (!match) {
    throw new Error(`No paired Orca server owns repo ${repoId}`)
  }
  return match
}

export async function resolveRuntimeWorktreeByPath(
  worktreePath: string
): Promise<{ environment: StoredWebRuntimeEnvironment; worktree: Worktree }> {
  const environments = getEnvironmentsInResolutionOrder()
  if (environments.length === 0) {
    throw new Error('Pair this web client with an Orca server first.')
  }
  // Why: hidden-but-open worktrees must still resolve for git/file operations.
  // `worktree.list` is sidebar-visible only, so path resolution uses detected rows.
  const candidates = await Promise.all(
    environments.map(async (environment) => {
      try {
        return { environment, worktrees: await loadDetectedWorktrees(environment) }
      } catch {
        return { environment, worktrees: [] as Worktree[] }
      }
    })
  )
  for (const { environment, worktrees } of candidates) {
    const match = findOwningWorktree(worktrees, worktreePath)
    if (match) {
      return { environment, worktree: match }
    }
  }
  throw new Error(`No runtime worktree owns ${worktreePath}`)
}

export async function resolveRuntimeFilePath(
  filePath: string,
  preferredWorktreePath?: string
): Promise<{
  environment: StoredWebRuntimeEnvironment
  worktree: Worktree
  relativePath: string
}> {
  const target = await resolveRuntimeWorktreeByPath(preferredWorktreePath ?? filePath)
  const relativePath = relativePathInsideRoot(target.worktree.path, filePath)
  if (relativePath === null) {
    throw new Error(`File is outside runtime worktree: ${filePath}`)
  }
  return { ...target, relativePath }
}

export function toEnvironmentWorktreeSelector(worktree: Worktree): string {
  return toRuntimeWorktreeSelector(worktree.id)
}

/** Deepest worktree containing the path wins, so nested worktrees stay addressable. */
function findOwningWorktree(worktrees: Worktree[], targetPath: string): Worktree | null {
  const match = worktrees
    .map((worktree) => ({
      worktree,
      relativePath: relativePathInsideRoot(worktree.path, targetPath)
    }))
    .filter((entry) => entry.relativePath !== null)
    .sort((a, b) => b.worktree.path.length - a.worktree.path.length)[0]
  return match?.worktree ?? null
}

function toLegacyDetectedWorktreeResult(
  repoId: string,
  worktrees: Worktree[]
): DetectedWorktreeListResult {
  return {
    repoId,
    authoritative: true,
    source: 'session-fallback',
    worktrees: worktrees.map((worktree) => ({
      ...worktree,
      ownership: 'orca-managed',
      selectedCheckout: false,
      visible: true
    }))
  }
}
