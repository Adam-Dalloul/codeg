"use client"

/**
 * Live AIR async tasks, docked under the composer beside the session-failure
 * strips (`conversation-shell`).
 *
 * These are Claude's NON-AGENT background jobs — a `Bash(run_in_background)`
 * shell, a workflow, a monitor — reported on the adapter's own lifecycle
 * channel (claude-agent-acp 0.73+). The transcript already draws the tool call
 * that LAUNCHED such a job, but it cannot say whether the job is still alive:
 * the poll-derived card explicitly refuses to claim "running" because a
 * transcript can't tell a live task from one whose CLI died. This strip is the
 * authoritative answer, and it is the only surface that can offer a stop.
 *
 * Only non-terminal tasks render (`liveAsyncTasks`). A settled task leaves at
 * once — its outcome belongs to the transcript, and a permanent list of
 * finished jobs docked under the composer would grow all session. Terminal rows
 * stay in the reducer table as the ids later corrections revise; see
 * `lib/async-tasks.ts`.
 */

import { useCallback, useState } from "react"
import { useTranslations } from "next-intl"
import {
  Activity,
  ExternalLink,
  Loader2,
  PauseCircle,
  Square,
  TerminalIcon,
  Workflow,
} from "lucide-react"

import { Button } from "@/components/ui/button"
import { Shimmer } from "@/components/ai-elements/shimmer"
import { cn } from "@/lib/utils"
import { isLocalDesktop, openPath } from "@/lib/platform"
import { formatTokenCount } from "@/lib/token-format"
import { liveAsyncTasks } from "@/lib/async-tasks"
import type { AsyncTaskRecord } from "@/lib/types"

/** The adapter's friendly `taskType` vocabulary. An unmapped future type keeps
 *  the generic glyph rather than rendering nothing. */
const TASK_ICONS: Record<string, typeof TerminalIcon> = {
  shell: TerminalIcon,
  workflow: Workflow,
  monitor: Activity,
}

export function AsyncTaskStrip({
  tasks,
  onStop,
}: {
  tasks: AsyncTaskRecord[]
  /** Resolves to the adapter's verdict: `false` means it declined to stop the
   *  task. Undefined disables every stop button (no live connection to ask). */
  onStop?: (taskId: string) => Promise<boolean>
}) {
  const live = liveAsyncTasks(tasks)
  if (live.length === 0) return null

  return (
    <div className="border-t border-border bg-muted/30">
      {live.map((task) => (
        <AsyncTaskRow key={task.task_id} task={task} onStop={onStop} />
      ))}
    </div>
  )
}

function AsyncTaskRow({
  task,
  onStop,
}: {
  task: AsyncTaskRecord
  onStop?: (taskId: string) => Promise<boolean>
}) {
  const t = useTranslations("Folder.chat.asyncTasks")
  const [stopping, setStopping] = useState(false)
  const paused = task.state === "paused"
  const Icon = TASK_ICONS[task.task_type] ?? Activity

  const handleStop = useCallback(async () => {
    if (!onStop || stopping) return
    setStopping(true)
    try {
      await onStop(task.task_id)
    } finally {
      // Deliberately NOT left latched on success. The row disappears when the
      // task's terminal state arrives on the wire, which is the real
      // confirmation; keeping the button disabled on a `false` verdict (the
      // adapter declined) would strand the user with no way to try again.
      setStopping(false)
    }
  }, [onStop, stopping, task.task_id])

  // The meta line is the "is this making progress" evidence: the tool the task
  // last ran, then its cost. Both are absent until the first progress tick.
  const meta = [
    task.last_tool_name,
    task.usage
      ? t("tokens", { count: formatTokenCount(task.usage.total_tokens) })
      : null,
  ].filter(Boolean) as string[]

  return (
    <div className="flex items-center gap-2 px-4 py-1.5 text-xs">
      {paused ? (
        <PauseCircle
          aria-hidden="true"
          className="size-3.5 shrink-0 text-muted-foreground"
        />
      ) : (
        <Icon aria-hidden="true" className="size-3.5 shrink-0 text-primary" />
      )}
      <span
        className="min-w-0 truncate font-medium text-foreground"
        title={task.description || task.name}
      >
        {paused ? (
          task.name
        ) : (
          <Shimmer as="span" duration={1.4} shineColor="var(--primary)">
            {task.name}
          </Shimmer>
        )}
      </span>
      {/* `show_in_transcript: false` means the task is already drawn as its own
          tool call above. Saying so keeps the row from reading as a second,
          separate job the agent started. */}
      {!task.show_in_transcript && (
        <span className="shrink-0 text-muted-foreground/70">
          {t("alsoInTranscript")}
        </span>
      )}
      {meta.length > 0 && (
        <span className="min-w-0 truncate text-muted-foreground/70 tabular-nums">
          {meta.join(" · ")}
        </span>
      )}
      <span className="ms-auto flex shrink-0 items-center gap-1">
        {/* Only on a local desktop: `openPath` silently no-ops in web and
            remote-desktop windows, where the path belongs to another host. */}
        {task.output_file_path && isLocalDesktop() && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-6 gap-1 px-2 text-xs"
            onClick={() => void openPath(task.output_file_path as string)}
          >
            <ExternalLink aria-hidden="true" className="size-3" />
            {t("openOutput")}
          </Button>
        )}
        {task.can_stop && onStop && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={stopping}
            className={cn(
              "h-6 gap-1 px-2 text-xs",
              "text-muted-foreground hover:text-destructive"
            )}
            onClick={() => void handleStop()}
          >
            {stopping ? (
              <Loader2 aria-hidden="true" className="size-3 animate-spin" />
            ) : (
              <Square aria-hidden="true" className="size-3" />
            )}
            {t("stop")}
          </Button>
        )}
      </span>
    </div>
  )
}
