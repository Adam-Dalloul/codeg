"use client"

import { memo, useMemo } from "react"
import { ChevronRightIcon } from "lucide-react"
import { useTranslations } from "next-intl"

import type { AdaptedContentPart } from "@/lib/adapters/ai-elements-adapter"
import { formatElapsedLabel } from "@/lib/format-elapsed"
import { cn } from "@/lib/utils"
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/instant-collapsible"
import { ContentPartsRenderer } from "./content-parts-renderer"

export interface SplitAssistantTurnParts {
  progress: AdaptedContentPart[]
  answer: AdaptedContentPart[]
}

function isProgressPart(part: AdaptedContentPart): boolean {
  switch (part.type) {
    case "reasoning":
    case "tool-call":
    case "tool-result":
    case "tool-group":
    case "delegation-status-group":
    case "background-task-group":
    case "goal-run":
    case "plan":
      return true
    case "text":
    case "proposed-plan":
    case "generated-image":
      return false
  }
}

/**
 * Split a completed assistant reply at its last progress item. Text before or
 * between tool/reasoning work is intermediate commentary; trailing response
 * content is the final answer and must remain visible. A text-only response is
 * left untouched because there is no reliable signal that any of it is
 * progress rather than the answer.
 */
export function splitAssistantTurnParts(
  parts: AdaptedContentPart[]
): SplitAssistantTurnParts {
  let lastProgressIndex = -1
  for (let i = parts.length - 1; i >= 0; i -= 1) {
    if (isProgressPart(parts[i])) {
      lastProgressIndex = i
      break
    }
  }

  if (lastProgressIndex < 0) {
    return { progress: [], answer: parts }
  }

  return {
    progress: parts.slice(0, lastProgressIndex + 1),
    answer: parts.slice(lastProgressIndex + 1),
  }
}

export const CompletedTurnContent = memo(function CompletedTurnContent({
  parts,
  durationMs,
  completed,
}: {
  parts: AdaptedContentPart[]
  durationMs?: number | null
  completed: boolean
}) {
  const t = useTranslations("Folder.chat.messageList")
  const tElapsed = useTranslations("Folder.chat.liveTurnStats")
  const split = useMemo(() => splitAssistantTurnParts(parts), [parts])

  if (!completed || split.progress.length === 0) {
    return <ContentPartsRenderer parts={parts} role="assistant" />
  }

  const duration =
    typeof durationMs === "number" && durationMs > 0
      ? formatElapsedLabel(durationMs, tElapsed)
      : null
  const summary = duration ? t("workedFor", { duration }) : t("worked")

  return (
    <div className="space-y-4">
      <Collapsible className="w-full">
        <CollapsibleTrigger className="group inline-flex items-center gap-1.5 rounded-md px-1 py-1 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background">
          <ChevronRightIcon
            aria-hidden="true"
            className="size-3 shrink-0 opacity-60 transition-transform group-data-[state=open]:rotate-90"
          />
          <span className="tabular-nums">{summary}</span>
        </CollapsibleTrigger>
        <CollapsibleContent
          className={cn(
            "w-full outline-none",
            "data-[state=open]:animate-in data-[state=closed]:animate-out",
            "data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0"
          )}
        >
          <div className="mt-3 border-s border-border/70 ps-3">
            <ContentPartsRenderer parts={split.progress} role="assistant" />
          </div>
        </CollapsibleContent>
      </Collapsible>
      {split.answer.length > 0 ? (
        <ContentPartsRenderer parts={split.answer} role="assistant" />
      ) : null}
    </div>
  )
})
