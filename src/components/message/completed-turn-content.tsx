"use client"

import { memo, useCallback, useMemo, useState } from "react"
import { ChevronRightIcon } from "lucide-react"
import { useTranslations } from "next-intl"

import {
  splitTrailingAnswerParts,
  type AdaptedContentPart,
} from "@/lib/adapters/ai-elements-adapter"
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

/**
 * Split a completed assistant reply at its last progress item. Text before or
 * between tool/reasoning work is intermediate commentary; trailing response
 * content is the final answer and must remain visible. A text-only response is
 * left untouched because there is no reliable signal that any of it is
 * progress rather than the answer.
 *
 * The progress/answer taxonomy is the adapter's (`isTurnAnswerPart`), shared
 * with the Goal capsule's trailing-answer lift — the same question ("what may
 * a collapsed chip swallow?") must not get two answers.
 */
export function splitAssistantTurnParts(
  parts: AdaptedContentPart[]
): SplitAssistantTurnParts {
  const { body, trailing } = splitTrailingAnswerParts(parts)
  return { progress: body, answer: trailing }
}

/**
 * Does the split leave anything for the reader once the progress is folded
 * away? Whitespace-only text is not an answer: it renders as an empty markdown
 * block, so a turn "kept visible" by it still reads as a blank reply.
 */
function hasVisibleAnswer(answer: AdaptedContentPart[]): boolean {
  return answer.some(
    (part) => part.type !== "text" || part.text.trim().length > 0
  )
}

/**
 * Which turns the reader has opened, keyed by the group's `parts` array. The
 * thread is virtualized: scrolling a turn past the overscan buffer unmounts it,
 * and an uncontrolled Collapsible would forget the expansion — so scrolling
 * away from a turn you opened and back re-hides its work. `parts` is the right
 * key because it is exactly as stable as the turn's identity (it comes from the
 * per-turn adapter cache and the merged-run cache in `message-list-view`), and
 * being weak it is collected with the turn rather than accumulating per
 * conversation. Re-adapted content (a streaming turn settling, a merged run
 * gaining a member) yields a new array and starts collapsed, which is the
 * intent.
 */
const expandedTurns = new WeakMap<AdaptedContentPart[], boolean>()

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
  const [open, setOpen] = useState(() => expandedTurns.get(parts) ?? false)
  const handleOpenChange = useCallback(
    (next: boolean) => {
      expandedTurns.set(parts, next)
      setOpen(next)
    },
    [parts]
  )

  // Collapsing trades the process away to keep the answer. With no answer left
  // over there is nothing to keep, and the reply renders as an empty bubble
  // carrying a lone "Worked for …" chip — which is exactly the shape of the
  // turns a reader most needs to see: one stopped mid-tool-call (agents leave
  // no closing prose), a Cline reply whose `attempt_completion` card IS the
  // answer, a plan-mode turn that ends on ExitPlanMode with the plan inside
  // that card. Leave those expanded rather than hide a whole turn behind a
  // chevron.
  if (
    !completed ||
    split.progress.length === 0 ||
    !hasVisibleAnswer(split.answer)
  ) {
    return (
      <ContentPartsRenderer
        parts={parts}
        role="assistant"
        isStreaming={!completed}
      />
    )
  }

  const duration =
    typeof durationMs === "number" && durationMs > 0
      ? formatElapsedLabel(durationMs, tElapsed)
      : null
  const summary = duration ? t("workedFor", { duration }) : t("worked")

  return (
    <div className="space-y-4">
      <Collapsible
        className="w-full"
        open={open}
        onOpenChange={handleOpenChange}
      >
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
      {/* Non-empty by construction: the no-answer case returned above. */}
      <ContentPartsRenderer parts={split.answer} role="assistant" />
    </div>
  )
})
