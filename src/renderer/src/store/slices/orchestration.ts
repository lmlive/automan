import type { StateCreator } from 'zustand'
import type { AppState } from '../types'
import { callRuntimeRpc, getActiveRuntimeTarget } from '@/runtime/runtime-rpc-client'

export type OrchestrationTaskStatus =
  | 'pending'
  | 'ready'
  | 'dispatched'
  | 'completed'
  | 'failed'
  | 'blocked'

export type OrchestrationTask = {
  id: string
  spec: string
  task_title?: string | null
  display_name?: string | null
  status: OrchestrationTaskStatus
  assignee_handle?: string | null
  dispatch_id?: string | null
}

export type OrchestrationGate = {
  id: string
  task_id: string
  question: string
  options?: string
  status: 'pending' | 'resolved' | 'timeout'
  resolution?: string | null
}

export type OrchestrationDraftTask = {
  title: string
  spec: string
  deps: string[]
}

export type OrchestrationRunResult = {
  runId: string
  status: string
}

export type OrchestrationSlice = {
  orchestrationIntakeDraft: string
  orchestrationAttachedPaths: string[]
  orchestrationDraftPlan: OrchestrationDraftTask[]
  orchestrationPlanning: boolean
  orchestrationPlanError: string | null
  orchestrationTasks: OrchestrationTask[]
  orchestrationGates: OrchestrationGate[]
  orchestrationLoading: boolean
  orchestrationError: string | null
  orchestrationRun: OrchestrationRunResult | null
  setOrchestrationIntakeDraft: (draft: string) => void
  setOrchestrationAttachedPaths: (paths: string[]) => void
  clearOrchestrationDraftPlan: () => void
  draftOrchestrationPlan: () => Promise<void>
  refreshOrchestration: () => Promise<void>
  confirmAndRunOrchestration: (options: {
    worktree?: string
    maxConcurrent: number
  }) => Promise<void>
  stopOrchestrationRun: () => Promise<void>
}

type TaskListResult = {
  tasks: OrchestrationTask[]
  count: number
}

type GateListResult = {
  gates: OrchestrationGate[]
  count: number
}

type TaskCreateResult = {
  task: { id: string; status: OrchestrationTaskStatus }
}

type DecomposeResult = {
  tasks: OrchestrationDraftTask[]
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Orchestration request failed.'
}

function makeTitle(value: string, fallback: string): string {
  const firstLine = value
    .trim()
    .split('\n')
    .find((line) => line.trim().length > 0)
  if (!firstLine) {
    return fallback
  }
  return firstLine.slice(0, 48)
}

// Why: kept as fallback when the claude --print binary is unavailable or the
// LLM decompose call fails. Produces a generic 3-step plan.
function fallbackPlan(request: string, paths: string[]): OrchestrationDraftTask[] {
  const trimmed = request.trim()
  if (!trimmed && paths.length === 0) {
    return []
  }

  const context =
    paths.length > 0 ? `\n\nReferenced files:\n${paths.map((p) => `- ${p}`).join('\n')}` : ''
  const baseSpec = `${trimmed || 'Review the attached files and propose the implementation.'}${context}`

  return [
    {
      title: makeTitle(trimmed, 'Analyze request'),
      spec: `Analyze the request, inspect the referenced context, and identify the implementation plan.\n\n${baseSpec}`,
      deps: []
    },
    {
      title: 'Implement changes',
      spec: `Implement the approved changes for the request. Keep platform, SSH, and provider compatibility in scope.\n\n${baseSpec}`,
      deps: ['#1']
    },
    {
      title: 'Verify and report',
      spec: `Verify the implementation with the narrowest relevant tests or app flow, then report files modified and any follow-up.\n\n${baseSpec}`,
      deps: ['#1', '#2']
    }
  ]
}

export const createOrchestrationSlice: StateCreator<AppState, [], [], OrchestrationSlice> = (
  set,
  get
) => ({
  orchestrationIntakeDraft: '',
  orchestrationAttachedPaths: [],
  orchestrationDraftPlan: [],
  orchestrationPlanning: false,
  orchestrationPlanError: null,
  orchestrationTasks: [],
  orchestrationGates: [],
  orchestrationLoading: false,
  orchestrationError: null,
  orchestrationRun: null,

  setOrchestrationIntakeDraft: (draft) => set({ orchestrationIntakeDraft: draft }),
  setOrchestrationAttachedPaths: (paths) => set({ orchestrationAttachedPaths: paths }),
  clearOrchestrationDraftPlan: () =>
    set({ orchestrationDraftPlan: [], orchestrationPlanError: null }),

  draftOrchestrationPlan: async () => {
    const target = getActiveRuntimeTarget(get().settings)
    set({ orchestrationPlanning: true, orchestrationPlanError: null })
    try {
      const result = await callRuntimeRpc<DecomposeResult>(target, 'orchestration.decompose', {
        request: get().orchestrationIntakeDraft,
        paths: get().orchestrationAttachedPaths
      })
      set({
        orchestrationDraftPlan: result.tasks,
        orchestrationPlanning: false,
        orchestrationPlanError:
          result.tasks.length === 0 ? 'Decompose returned an empty plan.' : null
      })
    } catch {
      // Why: fall back to the deterministic plan when the LLM decompose fails
      // (binary not found, timeout, parse error) so the UI stays usable.
      const plan = fallbackPlan(get().orchestrationIntakeDraft, get().orchestrationAttachedPaths)
      set({
        orchestrationDraftPlan: plan,
        orchestrationPlanning: false,
        orchestrationPlanError: plan.length === 0 ? 'Enter a request or attach files first.' : null
      })
    }
  },

  refreshOrchestration: async () => {
    const target = getActiveRuntimeTarget(get().settings)
    set({ orchestrationLoading: true, orchestrationError: null })
    try {
      const [tasks, gates] = await Promise.all([
        callRuntimeRpc<TaskListResult>(target, 'orchestration.taskList', {}),
        callRuntimeRpc<GateListResult>(target, 'orchestration.gateList', {})
      ])
      set({
        orchestrationTasks: tasks.tasks,
        orchestrationGates: gates.gates,
        orchestrationLoading: false,
        orchestrationError: null
      })
    } catch (error) {
      set({ orchestrationLoading: false, orchestrationError: getErrorMessage(error) })
    }
  },

  confirmAndRunOrchestration: async ({ worktree, maxConcurrent }) => {
    const target = getActiveRuntimeTarget(get().settings)
    const plan = get().orchestrationDraftPlan
    if (plan.length === 0) {
      set({ orchestrationPlanError: 'Draft a plan before running orchestration.' })
      return
    }

    const activeTask = get().orchestrationTasks.find((task) =>
      ['pending', 'ready', 'dispatched', 'blocked'].includes(task.status)
    )
    if (activeTask) {
      set({
        orchestrationError:
          'Stop or finish the current orchestration run before starting a new one.'
      })
      return
    }

    set({ orchestrationLoading: true, orchestrationError: null })
    try {
      // Why: orchestration tasks are runtime-global today; a new UI run must
      // clear the prior DAG before task-create or the coordinator will pick up
      // stale tasks from previous runs.
      await callRuntimeRpc<{ reset: string }>(target, 'orchestration.reset', { tasks: true })
      set({ orchestrationTasks: [], orchestrationGates: [], orchestrationRun: null })

      const ids: string[] = []
      for (let i = 0; i < plan.length; i += 1) {
        const task = plan[i]
        const deps = task.deps.map((ref) => {
          const index = Number(ref.replace(/^#/, '')) - 1
          const id = ids[index]
          if (!id) {
            throw new Error(`Invalid dependency reference ${ref}`)
          }
          return id
        })
        const created = await callRuntimeRpc<TaskCreateResult>(target, 'orchestration.taskCreate', {
          spec: task.spec,
          taskTitle: task.title,
          displayName: task.title,
          deps: JSON.stringify(deps)
        })
        ids.push(created.task.id)
      }

      const run = await callRuntimeRpc<OrchestrationRunResult>(target, 'orchestration.run', {
        spec: get().orchestrationIntakeDraft || plan[0]?.spec || 'Orchestration run',
        from: 'coordinator',
        pollIntervalMs: 2000,
        maxConcurrent,
        ...(worktree ? { worktree } : {})
      })
      set({ orchestrationRun: run, orchestrationDraftPlan: [], orchestrationLoading: false })
      await get().refreshOrchestration()
    } catch (error) {
      set({ orchestrationLoading: false, orchestrationError: getErrorMessage(error) })
    }
  },

  stopOrchestrationRun: async () => {
    const target = getActiveRuntimeTarget(get().settings)
    set({ orchestrationLoading: true, orchestrationError: null })
    try {
      await callRuntimeRpc<{ runId: string; status: string }>(target, 'orchestration.runStop', {})
      set({ orchestrationRun: null, orchestrationLoading: false })
      await get().refreshOrchestration()
    } catch (error) {
      set({ orchestrationLoading: false, orchestrationError: getErrorMessage(error) })
    }
  }
})
