"use client"

import { memo } from "react"
import type { NodeProps, Node } from "@xyflow/react"
import { Bot, GitBranch, Trash2, Unlink } from "lucide-react"
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
import { useCanvasView } from "../canvas-view-context"

export type ConversationCardFlowNode = Node<
  ConversationCardData,
  "conversationCard"
>

/**
 * One conversation on the canvas — either a derived member card inside a
 * region's grid or a standalone pinned card (a `kind=conversation` DB row).
 * Fixed w-56 footprint (CARD_WIDTH/CARD_HEIGHT in canvas-model.ts — keep in
 * sync); hover moves the border only, per the task-card house rule.
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
      <div className="flex h-[8.25rem] w-56 flex-col items-start justify-between rounded-xl border border-dashed border-foreground/20 bg-card/60 p-3 opacity-70">
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
            "flex h-[8.25rem] w-56 flex-col rounded-xl border bg-card p-3 transition-colors",
            "border-foreground/15 hover:border-foreground/30",
            running &&
              "ring-1 ring-primary/30 motion-safe:[animation:canvas-breathe_2.6s_ease-in-out_infinite]",
            selected && "border-primary ring-2 ring-primary/25",
            mirrored && "border-primary/50 ring-2 ring-primary/15",
            dragging && "-rotate-1 shadow-lg"
          )}
        >
          <div className="flex items-center gap-1.5">
            <AgentIcon
              agentType={conversation.agent_type}
              className="size-3.5 shrink-0"
            />
            <ConversationStatusDot
              status={status}
              size="sm"
              className={cn(running && "motion-safe:animate-pulse")}
            />
            <span className="min-w-0 flex-1" />
            {conversation.child_count > 0 && (
              <span
                className="inline-flex shrink-0 items-center gap-0.5 rounded-full bg-primary/10 px-1.5 py-px font-mono text-[0.625rem] font-medium leading-4 text-primary"
                title={t("childCount", { count: conversation.child_count })}
              >
                <Bot className="size-2.5" aria-hidden="true" />
                {conversation.child_count}
              </span>
            )}
          </div>
          <p className="mt-1.5 line-clamp-2 min-h-0 flex-1 text-[0.8125rem] font-medium leading-snug">
            {title}
          </p>
          <div className="mt-auto flex min-w-0 items-center gap-1.5 text-[0.6875rem] text-muted-foreground">
            {conversation.git_branch && (
              <span className="flex min-w-0 items-center gap-0.5">
                <GitBranch className="size-2.5 shrink-0" aria-hidden="true" />
                <span dir="ltr" className="truncate font-mono">
                  {conversation.git_branch}
                </span>
              </span>
            )}
            {conversation.model && (
              <span className="min-w-0 truncate font-mono" dir="ltr">
                {conversation.model}
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
