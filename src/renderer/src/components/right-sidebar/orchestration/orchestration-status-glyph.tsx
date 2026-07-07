import type React from 'react'
import { cn } from '@/lib/utils'
import type { OrchestrationTaskStatus } from '@/store/slices/orchestration'

const STATUS_GLYPH: Record<OrchestrationTaskStatus, string> = {
  pending: '◇',
  ready: '◇',
  dispatched: '◷',
  completed: '✓',
  failed: '✕',
  blocked: '⊘'
}

const STATUS_CLASS: Record<OrchestrationTaskStatus, string> = {
  pending: 'text-muted-foreground',
  ready: 'text-muted-foreground',
  dispatched: 'text-muted-foreground motion-safe:animate-spin',
  completed: 'text-emerald-600 dark:text-emerald-500',
  failed: 'text-destructive',
  blocked: 'text-amber-600 dark:text-amber-500'
}

export function OrchestrationStatusGlyph({
  status,
  className
}: {
  status: OrchestrationTaskStatus
  className?: string
}): React.JSX.Element {
  return (
    <span
      aria-hidden="true"
      className={cn(
        'inline-flex size-4 items-center justify-center text-xs',
        STATUS_CLASS[status],
        className
      )}
    >
      {STATUS_GLYPH[status]}
    </span>
  )
}
