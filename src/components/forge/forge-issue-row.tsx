"use client"

import { useTranslations } from "next-intl"
import { CircleCheck, CircleDot, GitPullRequestArrow } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { statusLabelKey } from "@/components/tasks/task-card"
import { useWorkbenchRoute } from "@/contexts/workbench-route-context"
import { formatRelative } from "@/components/conversations/sidebar-conversation-grouping"
import { cn } from "@/lib/utils"
import { chipStateForLink } from "@/lib/forge-task-chip"
import type { ForgeIssueRow, ForgeTaskLink } from "@/lib/types"

/** Render-time "now" is fine here: the list re-renders on every refresh. */
function relative(iso: string): string {
  return formatRelative(iso, Date.now())
}

/**
 * One workbench row: `#number title labels · author · updated` plus the
 * three-state action — start (no task), a live status chip (active task,
 * click-through to the board), or done/canceled with a re-trigger.
 */
export function ForgeIssueRowItem({
  row,
  link,
  onStart,
}: {
  row: ForgeIssueRow
  link: ForgeTaskLink | null
  onStart: () => void
}) {
  const t = useTranslations("Forge")
  const tTasks = useTranslations("Tasks")
  const { setRoute } = useWorkbenchRoute()

  const chip = chipStateForLink(link)
  const active = chip === "active"
  const terminal = chip === "terminal"

  return (
    <div className="flex min-w-0 items-center gap-3 px-4 py-2.5">
      {row.is_pr ? (
        <GitPullRequestArrow className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
      ) : row.state === "open" ? (
        <CircleDot className="h-3.5 w-3.5 shrink-0 text-emerald-600" />
      ) : (
        <CircleCheck className="h-3.5 w-3.5 shrink-0 text-violet-500" />
      )}
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-1.5">
          <a
            href={row.html_url}
            target="_blank"
            rel="noreferrer"
            className="truncate text-sm font-medium hover:underline"
            title={row.title}
          >
            {row.title}
          </a>
          {row.labels.slice(0, 4).map((label) => (
            <Badge
              key={label}
              variant="outline"
              className="h-4 shrink-0 rounded-full px-1.5 text-[0.625rem] font-normal text-muted-foreground"
            >
              {label}
            </Badge>
          ))}
        </div>
        <div className="mt-0.5 flex items-center gap-1.5 text-[0.6875rem] text-muted-foreground">
          <span className="font-mono">#{row.number}</span>
          {row.author ? <span>· {row.author}</span> : null}
          {row.updated_at ? <span>· {relative(row.updated_at)}</span> : null}
        </div>
      </div>

      {link == null ? (
        <Button
          size="sm"
          className="h-7 shrink-0 rounded-full px-3 text-xs"
          variant="secondary"
          onClick={onStart}
        >
          {t("start")}
        </Button>
      ) : (
        // Two sibling controls, never one nested in the other: an interactive
        // element inside a button folds its text into the outer button's
        // accessible name, and keyboard activation of the inner one is left to
        // whatever the browser decides. Siblings also drop the
        // stopPropagation / manual Enter-and-Space handling a real button
        // gives for free.
        <div className="flex shrink-0 items-center gap-1.5">
          <button
            type="button"
            onClick={() => setRoute("tasks")}
            title={t("viewTask")}
            className={cn(
              "inline-flex h-6 items-center rounded-full px-2.5 text-[0.6875rem]",
              active
                ? "bg-primary/10 text-primary hover:bg-primary/15"
                : "bg-muted text-muted-foreground hover:bg-muted/80"
            )}
          >
            {tTasks(statusLabelKey(link.status))}
          </button>
          {terminal ? (
            <button
              type="button"
              onClick={onStart}
              className="text-[0.6875rem] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
            >
              {t("retrigger")}
            </button>
          ) : null}
        </div>
      )}
    </div>
  )
}
