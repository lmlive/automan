import type React from 'react'
import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/utils'
import type { OrchestrationDraftTask, OrchestrationTask } from '@/store/slices/orchestration'
import { OrchestrationStatusGlyph } from './orchestration-status-glyph'

type OrchestrationTaskRowProps = {
  task: OrchestrationTask
}

export function OrchestrationTaskRow({ task }: OrchestrationTaskRowProps): React.JSX.Element {
  const label = task.display_name ?? task.task_title ?? task.spec
  const assigned = task.assignee_handle ? ` → ${task.assignee_handle}` : ''
  return (
    <div
      className="group rounded-md border border-transparent px-2 py-2 transition-colors hover:bg-accent"
      data-current="false"
    >
      <div className="flex items-start gap-2">
        <OrchestrationStatusGlyph status={task.status} className="mt-0.5" />
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-2 text-[13px] leading-5">
            <span className="truncate font-medium text-foreground">{label}</span>
            <span className="shrink-0 font-mono text-[11px] text-muted-foreground">
              {task.status}
            </span>
          </div>
          <div className="truncate text-xs text-muted-foreground">
            {task.spec}
            {assigned && <span className="font-mono">{assigned}</span>}
          </div>
        </div>
        {task.dispatch_id && (
          <Badge variant="secondary" className="shrink-0 rounded-full font-mono text-[10px]">
            {task.dispatch_id.slice(0, 8)}
          </Badge>
        )}
      </div>
    </div>
  )
}

export function OrchestrationDraftTaskRow({
  task,
  index
}: {
  task: OrchestrationDraftTask
  index: number
}): React.JSX.Element {
  return (
    <div className={cn('rounded-md border border-border bg-card px-2 py-2')}>
      <div className="flex items-center gap-2 text-[13px]">
        <span className="font-mono text-[11px] text-muted-foreground">#{index + 1}</span>
        <span className="min-w-0 flex-1 truncate font-medium text-foreground">{task.title}</span>
        {task.deps.length > 0 && (
          <Badge variant="secondary" className="rounded-full font-mono text-[10px]">
            deps {task.deps.join(',')}
          </Badge>
        )}
      </div>
      <p className="mt-1 line-clamp-2 text-xs leading-5 text-muted-foreground">{task.spec}</p>
    </div>
  )
}
