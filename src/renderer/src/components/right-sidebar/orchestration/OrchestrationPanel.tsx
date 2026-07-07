import type React from 'react'
import { useEffect, useMemo, useState } from 'react'
import { Play, Square, Upload, Workflow } from 'lucide-react'
import { useAppStore } from '@/store'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import { OrchestrationDraftTaskRow, OrchestrationTaskRow } from './orchestration-task-row'

function getDroppedPaths(files: FileList): string[] {
  return Array.from(files).map((file) => {
    const maybePath = (file as File & { path?: string }).path
    return maybePath && maybePath.length > 0 ? maybePath : file.name
  })
}

function OrchestrationIntake(): React.JSX.Element {
  const draft = useAppStore((s) => s.orchestrationIntakeDraft)
  const attachedPaths = useAppStore((s) => s.orchestrationAttachedPaths)
  const plan = useAppStore((s) => s.orchestrationDraftPlan)
  const planning = useAppStore((s) => s.orchestrationPlanning)
  const planError = useAppStore((s) => s.orchestrationPlanError)
  const loading = useAppStore((s) => s.orchestrationLoading)
  const error = useAppStore((s) => s.orchestrationError)
  const activeWorktreeId = useAppStore((s) => s.activeWorktreeId)
  const worktrees = useAppStore((s) => s.allWorktrees())
  const setDraft = useAppStore((s) => s.setOrchestrationIntakeDraft)
  const setAttachedPaths = useAppStore((s) => s.setOrchestrationAttachedPaths)
  const draftPlan = useAppStore((s) => s.draftOrchestrationPlan)
  const confirmAndRun = useAppStore((s) => s.confirmAndRunOrchestration)
  const clearPlan = useAppStore((s) => s.clearOrchestrationDraftPlan)
  const [worktree, setWorktree] = useState(activeWorktreeId ?? '')
  const [maxConcurrent, setMaxConcurrent] = useState('3')

  useEffect(() => {
    if (!worktree && activeWorktreeId) {
      setWorktree(activeWorktreeId)
    }
  }, [activeWorktreeId, worktree])

  const addPaths = (paths: string[]): void => {
    setAttachedPaths([...new Set([...attachedPaths, ...paths])])
  }

  return (
    <section className="border-b border-border p-3">
      <div className="mb-2 flex items-center gap-2">
        <Workflow className="size-4 text-muted-foreground" />
        <h2 className="text-sm font-medium text-foreground">
          {translate(
            'auto.components.right.sidebar.orchestration.intake.title',
            'New orchestration'
          )}
        </h2>
      </div>
      <textarea
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onDrop={(event) => {
          event.preventDefault()
          addPaths(getDroppedPaths(event.dataTransfer.files))
        }}
        onDragOver={(event) => event.preventDefault()}
        placeholder={translate(
          'auto.components.right.sidebar.orchestration.intake.placeholder',
          'Describe the outcome. Drop files or folders here for context.'
        )}
        className="min-h-24 w-full resize-none rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground outline-none placeholder:text-muted-foreground focus-visible:ring-1 focus-visible:ring-ring"
      />
      <div className="mt-2 flex flex-wrap gap-1">
        {attachedPaths.map((path) => (
          <Badge
            key={path}
            variant="secondary"
            className="max-w-full rounded-full font-mono text-[10px]"
          >
            <span className="truncate">{path}</span>
          </Badge>
        ))}
      </div>
      <div className="mt-2 flex items-center gap-2">
        <input
          type="file"
          multiple
          className="hidden"
          id="orchestration-file-input"
          onChange={(event) => {
            if (event.currentTarget.files) {
              addPaths(getDroppedPaths(event.currentTarget.files))
            }
          }}
        />
        <Button asChild variant="outline" size="xs">
          <label htmlFor="orchestration-file-input" className="cursor-pointer">
            <Upload className="size-3" />
            {translate('auto.components.right.sidebar.orchestration.intake.attach', 'Attach')}
          </label>
        </Button>
        <Select value={worktree} onValueChange={setWorktree}>
          <SelectTrigger size="sm" className="h-6 min-w-0 flex-1 px-2 text-xs">
            <SelectValue
              placeholder={translate(
                'auto.components.right.sidebar.orchestration.intake.worktree',
                'Worktree'
              )}
            />
          </SelectTrigger>
          <SelectContent>
            {worktrees.length === 0 ? (
              <SelectItem value="__none__" disabled>
                {translate(
                  'auto.components.right.sidebar.orchestration.intake.worktrees.empty',
                  'No worktrees'
                )}
              </SelectItem>
            ) : (
              worktrees.map((wt) => (
                <SelectItem key={wt.id} value={wt.id} className="font-mono text-xs">
                  {wt.displayName}
                </SelectItem>
              ))
            )}
          </SelectContent>
        </Select>
        <Select value={maxConcurrent} onValueChange={setMaxConcurrent}>
          <SelectTrigger size="sm" className="h-6 w-16 px-2 text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {[1, 2, 3, 4].map((n) => (
              <SelectItem key={n} value={String(n)}>
                {n}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div className="mt-3 flex items-center gap-2">
        <Button size="sm" disabled={planning || loading} onClick={() => void draftPlan()}>
          <Play className="size-3" />
          {translate('auto.components.right.sidebar.orchestration.intake.plan', 'Plan')}
        </Button>
        {plan.length > 0 && (
          <>
            <Button
              size="sm"
              variant="outline"
              disabled={loading}
              onClick={() => void confirmAndRun({ worktree, maxConcurrent: Number(maxConcurrent) })}
            >
              {translate(
                'auto.components.right.sidebar.orchestration.intake.confirm',
                'Confirm & run'
              )}
            </Button>
            <Button size="sm" variant="ghost" onClick={clearPlan}>
              {translate('auto.components.right.sidebar.orchestration.intake.discard', 'Discard')}
            </Button>
          </>
        )}
      </div>
      {(planError || error) && (
        <p className="mt-2 text-xs text-destructive">{planError ?? error}</p>
      )}
      {plan.length > 0 && (
        <div className="mt-3 space-y-2">
          <p className="text-xs text-muted-foreground">
            {translate(
              'auto.components.right.sidebar.orchestration.intake.replaceDagNotice',
              'Confirming starts a new run and replaces the current draft DAG.'
            )}
          </p>
          {plan.map((task, index) => (
            <OrchestrationDraftTaskRow key={`${task.title}-${index}`} task={task} index={index} />
          ))}
        </div>
      )}
    </section>
  )
}

function OrchestrationRunControls(): React.JSX.Element {
  const run = useAppStore((s) => s.orchestrationRun)
  const stopRun = useAppStore((s) => s.stopOrchestrationRun)
  return (
    <div className="flex items-center justify-between border-b border-border px-3 py-2">
      <div className="min-w-0">
        <div className="truncate text-sm font-medium text-foreground">
          {run
            ? translate('auto.components.right.sidebar.orchestration.run.active', 'Run active')
            : translate('auto.components.right.sidebar.orchestration.run.none', 'No active run')}
        </div>
        {run && <div className="font-mono text-[11px] text-muted-foreground">{run.runId}</div>}
      </div>
      {run && (
        <Button variant="outline" size="xs" onClick={() => void stopRun()}>
          <Square className="size-3" />
          {translate('auto.components.right.sidebar.orchestration.run.stop', 'Stop')}
        </Button>
      )}
    </div>
  )
}

function OrchestrationTasks(): React.JSX.Element {
  const tasks = useAppStore((s) => s.orchestrationTasks)
  const loading = useAppStore((s) => s.orchestrationLoading)
  const counts = useMemo(() => {
    return tasks.reduce<Record<string, number>>((acc, task) => {
      acc[task.status] = (acc[task.status] ?? 0) + 1
      return acc
    }, {})
  }, [tasks])

  if (tasks.length === 0) {
    return (
      <div className="p-4 text-sm text-muted-foreground">
        {loading
          ? translate('auto.components.right.sidebar.orchestration.tasks.loading', 'Loading tasks…')
          : translate(
              'auto.components.right.sidebar.orchestration.tasks.empty',
              'Draft a plan to create orchestration tasks.'
            )}
      </div>
    )
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex gap-1 border-b border-border px-3 py-2">
        {(['ready', 'dispatched', 'completed', 'failed'] as const).map((status) => (
          <Badge key={status} variant="secondary" className="rounded-full font-mono text-[10px]">
            {status} {counts[status] ?? 0}
          </Badge>
        ))}
      </div>
      <ScrollArea className="min-h-0 flex-1">
        <div className="space-y-1 p-2">
          {tasks.map((task) => (
            <OrchestrationTaskRow key={task.id} task={task} />
          ))}
        </div>
      </ScrollArea>
    </div>
  )
}

function OrchestrationGates(): React.JSX.Element {
  const gates = useAppStore((s) => s.orchestrationGates)
  if (gates.length === 0) {
    return (
      <div className="p-4 text-sm text-muted-foreground">
        {translate('auto.components.right.sidebar.orchestration.gates.empty', 'No decision gates.')}
      </div>
    )
  }
  return (
    <ScrollArea className="min-h-0 flex-1">
      <div className="space-y-2 p-2">
        {gates.map((gate) => (
          <div key={gate.id} className="rounded-md border border-border px-2 py-2">
            <div className="flex items-center gap-2">
              <Badge variant={gate.status === 'pending' ? 'default' : 'secondary'}>
                {gate.status}
              </Badge>
              <span className="min-w-0 flex-1 truncate text-[13px] text-foreground">
                {gate.question}
              </span>
            </div>
            {gate.resolution && (
              <p className="mt-1 text-xs text-muted-foreground">{gate.resolution}</p>
            )}
          </div>
        ))}
      </div>
    </ScrollArea>
  )
}

export default function OrchestrationPanel(): React.JSX.Element {
  const refresh = useAppStore((s) => s.refreshOrchestration)
  const error = useAppStore((s) => s.orchestrationError)

  useEffect(() => {
    void refresh()
    const id = window.setInterval(() => void refresh(), 3000)
    return () => window.clearInterval(id)
  }, [refresh])

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-background">
      <OrchestrationIntake />
      <OrchestrationRunControls />
      {error && (
        <div className="border-b border-border px-3 py-2 text-xs text-destructive">{error}</div>
      )}
      <Tabs defaultValue="tasks" className="min-h-0 flex-1 gap-0">
        <TabsList variant="line" className="mx-3 mt-2 h-7">
          <TabsTrigger value="tasks" className="h-7 text-xs">
            {translate('auto.components.right.sidebar.orchestration.tabs.tasks', 'Tasks')}
          </TabsTrigger>
          <TabsTrigger value="gates" className="h-7 text-xs">
            {translate('auto.components.right.sidebar.orchestration.tabs.gates', 'Gates')}
          </TabsTrigger>
        </TabsList>
        <TabsContent value="tasks" className={cn('min-h-0 flex-1')}>
          <OrchestrationTasks />
        </TabsContent>
        <TabsContent value="gates" className="min-h-0 flex-1">
          <OrchestrationGates />
        </TabsContent>
      </Tabs>
    </div>
  )
}
