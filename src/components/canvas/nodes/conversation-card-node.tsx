"use client"

import { memo } from "react"
import type { NodeProps, Node } from "@xyflow/react"
import { Bot, Folder, GitBranch, Trash2, Unlink } from "lucide-react"
import { useTranslations } from "next-intl"
import { AgentIcon } from "@/components/agent-icon"
import { ConversationStatusDot } from "@/components/conversations/conversation-status-dot"
import { SidebarConversationHoverDetails } from "@/components/conversations/sidebar-conversation-hover-details"
import {
  HoverCard,
  HoverCardContent,
  HoverCardTrigger,
} from "@/components/ui/hover-card"
import { formatConversationTitle } from "@/lib/conversation-title"
import type { ConversationStatus } from "@/lib/types"
import { cn } from "@/lib/utils"
import type { ConversationCardData } from "../canvas-model"
import { ColorWash } from "../canvas-swatches"
import { useCanvasView } from "../canvas-view-context"

export type ConversationCardFlowNode = Node<
  ConversationCardData,
  "conversationCard"
>

/**
 * One conversation on the canvas — either a derived member card inside a
 * region's grid or a standalone pinned card (a `kind=conversation` DB row).
 *
 * ⚠️ The card takes its box from the ReactFlow node wrapper (`h-full w-full`),
 * which the derive layer sizes in PIXELS from CARD_WIDTH/CARD_HEIGHT. It must
 * never size itself with a rem utility (`w-56`, `h-[8.25rem]`): the app's zoom
 * control rewrites the root font-size, so a rem footprint grows past its px grid
 * slot at any zoom above 100% — neighbouring cards then overlap and the last
 * column spills outside the region border. Text inside stays in rem on purpose;
 * it's clamped, not load-bearing.
 *
 * Hover moves the border only, per the task-card house rule.
 *
 * The card carries no menu of its own: right-click is the pan gesture on this
 * board, and every verb (expand, open in workspace, remove) lives in the action
 * dock keyed off the selection.
 */
export const ConversationCardNode = memo(function ConversationCardNode({
  data,
  selected,
  dragging,
}: NodeProps<ConversationCardFlowNode>) {
  const t = useTranslations("Canvas")
  const { selectedConversationIds, deleteNode } = useCanvasView()
  const conversation = data.conversation

  // Pinned card whose conversation is gone (funnel-missed): a grey shell with
  // an explicit way out. Never rendered for member cards — an unresolvable
  // member simply drops out of the grid.
  if (!conversation) {
    return (
      <div className="flex h-full w-full flex-col items-start justify-between overflow-hidden rounded-xl border border-dashed border-foreground/20 bg-card/60 p-3 opacity-70">
        <div className="flex items-center gap-1.5 text-muted-foreground">
          <Unlink className="size-3.5" aria-hidden="true" />
          <span className="text-xs">{t("unresolvedConversation")}</span>
        </div>
        {data.pinDbId != null && (
          <button
            type="button"
            className="nodrag inline-flex items-center gap-1 rounded-md px-1.5 py-1 text-xs text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive"
            onClick={() => void deleteNode(data.pinDbId!)}
          >
            <Trash2 className="size-3" aria-hidden="true" />
            {t("removeCard")}
          </button>
        )}
      </div>
    )
  }

  const status = conversation.status as ConversationStatus
  const running = status === "in_progress"
  // Mirror highlight: another instance of this conversation is selected
  // somewhere on the board (multi-region membership made visible).
  const mirrored = !selected && selectedConversationIds.has(conversation.id)
  const title = conversation.title
    ? formatConversationTitle(conversation.title)
    : t("untitled")

  return (
    <HoverCard openDelay={600} closeDelay={80}>
      <HoverCardTrigger asChild>
        <div
          className={cn(
            "flex h-full w-full flex-col overflow-hidden rounded-xl border bg-card p-3 transition-colors",
            "border-foreground/15 hover:border-foreground/30",
            running &&
              "ring-1 ring-primary/30 motion-safe:[animation:canvas-breathe_2.6s_ease-in-out_infinite]",
            selected && "border-primary ring-2 ring-primary/25",
            mirrored && "border-primary/50 ring-2 ring-primary/15",
            dragging && "-rotate-1"
          )}
        >
          {/* The owning region's colour, carried in through node data. Lighter
              than the region's own wash: this sits on the card's OPAQUE surface
              (the region's is on a translucent frame), so the same opacity
              would read as a slab and drown the title. */}
          <ColorWash
            color={data.regionColor}
            className="rounded-xl"
            opacity={0.08}
          />
          <div className="relative flex items-center gap-1.5">
            <AgentIcon
              agentType={conversation.agent_type}
              className="size-3.5 shrink-0"
            />
            <ConversationStatusDot
              status={status}
              size="sm"
              className={cn(running && "motion-safe:animate-pulse")}
            />
            {/* The model sits with the agent it belongs to — "which brain is
                this" is one fact, and splitting it across the card's two ends
                made the reader assemble it. Empty until the backend has seen a
                model for the session (`seed_model_if_empty`), so the row must
                read fine without it: the flex spacer is the same element either
                way, just carrying text when there is text. */}
            <span
              className="min-w-0 flex-1 truncate font-mono text-[0.625rem] text-muted-foreground"
              dir="ltr"
              title={conversation.model ?? undefined}
            >
              {conversation.model}
            </span>
            {conversation.child_count > 0 && (
              <span
                className="inline-flex shrink-0 items-center gap-0.5 rounded-full bg-primary/10 px-1.5 py-px font-mono text-[0.625rem] font-medium leading-4 text-primary"
                title={t("childCount", {
                  count: conversation.child_count,
                })}
              >
                <Bot className="size-2.5" aria-hidden="true" />
                {conversation.child_count}
              </span>
            )}
          </div>
          <p className="relative mt-1.5 line-clamp-2 min-h-0 flex-1 text-[0.8125rem] font-medium leading-snug">
            {title}
          </p>
          {/* Where the conversation lives: folder on the left, branch on the
              right. Both truncate and both may be absent (a folderless chat has
              no folder; a non-git folder has no branch), so neither is allowed
              to reserve space the other could use — hence `min-w-0` on each and
              `justify-between` rather than a fixed spacer. */}
          <div className="relative mt-auto flex min-w-0 items-center justify-between gap-1.5 text-[0.6875rem] text-muted-foreground">
            {data.folderName ? (
              <span
                className="flex min-w-0 items-center gap-0.5"
                title={data.folderName}
              >
                <Folder className="size-2.5 shrink-0" aria-hidden="true" />
                <span className="truncate">{data.folderName}</span>
              </span>
            ) : (
              <span />
            )}
            {conversation.git_branch && (
              <span
                className="flex min-w-0 items-center gap-0.5"
                title={conversation.git_branch}
              >
                <GitBranch className="size-2.5 shrink-0" aria-hidden="true" />
                <span dir="ltr" className="truncate font-mono">
                  {conversation.git_branch}
                </span>
              </span>
            )}
          </div>
        </div>
      </HoverCardTrigger>
      <HoverCardContent
        side="right"
        align="start"
        sideOffset={8}
        className="nodrag nowheel w-72"
      >
        <SidebarConversationHoverDetails conversation={conversation} />
      </HoverCardContent>
    </HoverCard>
  )
})
