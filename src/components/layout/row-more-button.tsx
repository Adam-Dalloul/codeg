"use client"

import { MoreHorizontal } from "lucide-react"
import type { MouseEvent as ReactMouseEvent } from "react"
import { useTranslations } from "next-intl"

import { cn } from "@/lib/utils"

interface RowMoreButtonProps {
  /** Optional className overrides. */
  className?: string
  /**
   * Translation namespace override. Defaults to `Folder.fileTreeTab`. Exposed
   * because the same button is reused in places whose menus live under a
   * different translation key (e.g. the git-changes tab).
   */
  i18nNamespace?: "Folder.fileTreeTab" | "Folder.gitChangesTab"
}

/**
 * Tiny horizontal-three-dots button rendered on the right of a tree row.
 * Clicking it dispatches a synthetic `contextmenu` MouseEvent on the row so
 * the existing Radix `ContextMenu` opens at the button's coordinates.
 *
 * The row itself owns the context menu (it's the `ContextMenuTrigger` via
 * `asChild`); this button is just an alternate, always-visible entry point —
 * primarily so touch users have a way to open the menu without resorting to
 * long-press (which we want to keep free for drag).
 *
 * The click is `stopPropagation`-ed so it doesn't fire the row's own
 * `onClick` (which would open the file preview / toggle the folder).
 */
export function RowMoreButton({
  className,
  i18nNamespace = "Folder.fileTreeTab",
}: RowMoreButtonProps) {
  const t = useTranslations(i18nNamespace)
  return (
    <button
      type="button"
      aria-label={t("moreActions")}
      data-row-more-button
      onClick={(event: ReactMouseEvent<HTMLButtonElement>) => {
        // The click event must not reach the row's onClick (open preview) or
        // bubble to the ContextMenuTrigger and fire its onClick (which Radix
        // may also wire to "open on click" in some configurations). We want
        // the synthetic contextmenu below to be the sole opener.
        event.stopPropagation()
        event.preventDefault()
        // Locate the nearest row element. Both FileTreeFile and FileTreeFolder
        // stamp `data-tree-row-path` on the interactive element that wraps
        // the row, so the trigger and the button share a DOM ancestor we can
        // find by walking up.
        const row = event.currentTarget.closest<HTMLElement>(
          "[data-tree-row-path]"
        )
        if (!row) return
        row.dispatchEvent(
          new MouseEvent("contextmenu", {
            bubbles: true,
            cancelable: true,
            button: 2,
            clientX: event.clientX,
            clientY: event.clientY,
          })
        )
      }}
      className={cn(
        "inline-flex h-5 w-5 shrink-0 items-center justify-center rounded text-muted-foreground/70 transition-colors hover:bg-muted/60 hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
        className
      )}
    >
      <MoreHorizontal className="size-3.5" aria-hidden />
    </button>
  )
}
