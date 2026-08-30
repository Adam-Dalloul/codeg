"use client"

import { memo, useState } from "react"
import { NodeResizer, type Node, type NodeProps } from "@xyflow/react"
import { Trash2 } from "lucide-react"
import { useTranslations } from "next-intl"
import {
  THEME_COLOR_PREVIEW,
  normalizeFolderThemeColor,
  FOLDER_THEME_COLOR_INHERIT,
} from "@/lib/theme-presets"
import { cn } from "@/lib/utils"
import type { NoteNodeData } from "../canvas-model"
import { useCanvasView } from "../canvas-view-context"

export type NoteFlowNode = Node<NoteNodeData, "note">

/**
 * A sticky note. The textarea is `nodrag nowheel` (typing and scrolling must
 * not pan the canvas); edits are committed on blur as a single patch — notes
 * are annotations, not collaborative documents, so LWW per blur is plenty.
 */
export const NoteNode = memo(function NoteNode({
  data,
  selected,
}: NodeProps<NoteFlowNode>) {
  const t = useTranslations("Canvas")
  const { dbNode } = data
  const { patchNode, endNodeResize, deleteNode } = useCanvasView()
  const [draft, setDraft] = useState(dbNode.content ?? "")
  const [focused, setFocused] = useState(false)
  // Remote edits land while we're NOT editing; while focused the local draft
  // wins (same freeze idea as dragging). Adjust-during-render, not an effect:
  // track the last remote value seen and resync the draft when it moves.
  const [lastRemote, setLastRemote] = useState(dbNode.content ?? "")
  const remote = dbNode.content ?? ""
  if (remote !== lastRemote) {
    setLastRemote(remote)
    if (!focused) setDraft(remote)
  }

  const normalized = normalizeFolderThemeColor(dbNode.color)
  const tint =
    normalized === FOLDER_THEME_COLOR_INHERIT
      ? null
      : THEME_COLOR_PREVIEW[normalized]

  return (
    <div
      className={cn(
        // Sized by the RF node wrapper (derive feeds width/height, including
        // live NodeResizer dimensions).
        "group/note relative flex h-full w-full flex-col rounded-xl border bg-card transition-colors",
        "border-foreground/15 hover:border-foreground/30",
        selected && "border-primary ring-2 ring-primary/25"
      )}
    >
      <NodeResizer
        isVisible={Boolean(selected)}
        minWidth={140}
        minHeight={96}
        lineClassName="!border-primary/40"
        handleClassName="!size-2 !rounded-sm !border-primary !bg-background"
        onResizeEnd={(_e, params) =>
          endNodeResize(dbNode.id, {
            width: params.width,
            height: params.height,
            x: params.x,
            y: params.y,
          })
        }
      />
      {tint && (
        <div
          className="pointer-events-none absolute inset-0 rounded-xl opacity-[0.12]"
          style={{ backgroundColor: tint }}
          aria-hidden="true"
        />
      )}
      <textarea
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onFocus={() => setFocused(true)}
        onBlur={() => {
          setFocused(false)
          // On save failure the draft is KEPT (patchNode toasts): resetting
          // to the stored value would throw away the user's text, and the
          // kept draft doubles as the retry payload for the next blur.
          if (draft !== (dbNode.content ?? "")) {
            void patchNode(dbNode.id, { content: draft })
          }
        }}
        placeholder={t("notePlaceholder")}
        className="nodrag nowheel relative min-h-0 flex-1 resize-none rounded-xl bg-transparent p-3 text-[0.8125rem] leading-relaxed outline-none placeholder:text-muted-foreground/50"
      />
      <button
        type="button"
        className="nodrag absolute right-1.5 top-1.5 inline-flex size-6 items-center justify-center rounded-md text-muted-foreground opacity-0 transition-opacity hover:bg-destructive/10 hover:text-destructive focus-visible:opacity-100 group-hover/note:opacity-100"
        onClick={() => void deleteNode(dbNode.id)}
        aria-label={t("removeNote")}
      >
        <Trash2 className="size-3" />
      </button>
    </div>
  )
})
