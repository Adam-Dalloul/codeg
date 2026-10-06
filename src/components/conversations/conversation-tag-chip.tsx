"use client"

import { memo } from "react"
import { useTranslations } from "next-intl"
import { tagChipStyle } from "@/lib/conversation-tags"
import type { ConversationTagDetail } from "@/lib/types"
import { cn } from "@/lib/utils"

/**
 * Two chip scales: `xs` sits inside a 2rem sidebar row next to 14px text, `sm`
 * everywhere there is room to read a name properly (the conversation header,
 * the hover bubble, pickers and editors).
 */
export type ConversationTagChipSize = "xs" | "sm"

const SIZE_CLASS: Record<ConversationTagChipSize, string> = {
  // The sidebar row's existing badge geometry (the running-count chip): a
  // 15px box, 10px text. Capped narrow — two chips must still leave the title
  // something to show.
  xs: "h-[0.9375rem] max-w-[4.5rem] px-[0.3125rem] text-[0.625rem]",
  sm: "h-[1.125rem] max-w-[8rem] px-[0.4375rem] text-[0.6875rem]",
}

/**
 * One tag, in its own colour. The colour treatment is `.forge-label`'s (see
 * `tagChipStyle`): one stored colour, a readable chip in both themes. Size is
 * the caller's, but the chip always truncates its name rather than growing.
 */
export const ConversationTagChip = memo(function ConversationTagChip({
  tag,
  size = "sm",
  className,
}: {
  tag: ConversationTagDetail
  size?: ConversationTagChipSize
  className?: string
}) {
  return (
    <span
      style={tagChipStyle(tag.color)}
      title={tag.name}
      className={cn(
        "forge-label inline-flex min-w-0 shrink items-center rounded-full border font-medium leading-none",
        SIZE_CLASS[size],
        className
      )}
    >
      <span className="min-w-0 truncate">{tag.name}</span>
    </span>
  )
})

/**
 * A conversation's tags as a row of chips: the first `max` in display order,
 * then a neutral "+N" chip for the rest (whose names it lists in its tooltip).
 * Renders nothing for an empty list, so callers can mount it unconditionally.
 */
export const ConversationTagChips = memo(function ConversationTagChips({
  tags,
  max,
  size = "sm",
  className,
}: {
  /** Already resolved and ordered — see `resolveTags`. */
  tags: readonly ConversationTagDetail[]
  max: number
  size?: ConversationTagChipSize
  className?: string
}) {
  const t = useTranslations("ConversationTags")
  if (tags.length === 0) return null
  const shown = tags.slice(0, Math.max(0, max))
  const hidden = tags.slice(shown.length)
  return (
    <span
      className={cn(
        "inline-flex min-w-0 items-center",
        size === "xs" ? "gap-[0.1875rem]" : "gap-1",
        className
      )}
    >
      {shown.map((tag) => (
        <ConversationTagChip key={tag.id} tag={tag} size={size} />
      ))}
      {hidden.length > 0 ? (
        <span
          title={hidden.map((tag) => tag.name).join(", ")}
          className={cn(
            "inline-flex shrink-0 items-center rounded-full border border-border bg-muted/60 font-medium leading-none text-muted-foreground tabular-nums",
            SIZE_CLASS[size]
          )}
        >
          <span aria-hidden>+{hidden.length}</span>
          <span className="sr-only">
            {t("moreTags", { count: hidden.length })}
          </span>
        </span>
      ) : null}
    </span>
  )
})
