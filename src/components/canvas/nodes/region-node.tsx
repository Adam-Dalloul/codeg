"use client"

import { memo, useState } from "react"
import { NodeResizer, type Node, type NodeProps } from "@xyflow/react"
import {
  ChevronsDownUp,
  ChevronsUpDown,
  Folder,
  MoreHorizontal,
  Pencil,
  Plus,
  Sparkles,
  Trash2,
  Unlink,
} from "lucide-react"
import { useTranslations } from "next-intl"
import { AgentIcon } from "@/components/agent-icon"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { getAgentLabel } from "@/lib/custom-agents"
import { formatFolderLabelWithAlias } from "@/lib/folder-display"
import {
  THEME_COLORS,
  THEME_COLOR_PREVIEW,
  normalizeFolderThemeColor,
  FOLDER_THEME_COLOR_INHERIT,
} from "@/lib/theme-presets"
import { cn } from "@/lib/utils"
import { useAppWorkspaceStore } from "@/stores/app-workspace-store"
import {
  MAX_VISIBLE_MEMBERS,
  REGION_HEADER_HEIGHT,
  type RegionNodeData,
} from "../canvas-model"
import { useCanvasView } from "../canvas-view-context"

export type RegionFlowNode = Node<RegionNodeData, "region">

/** Accent chip for the region header + the color picker swatches. */
function ColorDot({
  value,
  active,
}: {
  value: string | null
  active?: boolean
}) {
  const normalized = normalizeFolderThemeColor(value)
  const preview =
    normalized === FOLDER_THEME_COLOR_INHERIT
      ? null
      : THEME_COLOR_PREVIEW[normalized]
  return (
    <span
      className={cn(
        "relative inline-flex size-3 shrink-0 items-center justify-center rounded-full border border-foreground/20",
        active && "ring-2 ring-ring ring-offset-1 ring-offset-background"
      )}
      style={
        preview
          ? { backgroundColor: preview, borderColor: "transparent" }
          : undefined
      }
      aria-hidden="true"
    />
  )
}

/**
 * A canvas region: a live binding (folder / agent) or a hand-curated `custom`
 * collection. Member cards are separate RF child nodes laid out by
 * `layoutRegionGrid`; this component renders only the frame and header, so its
 * height must track `renderedHeight` (grid growth) rather than the stored one.
 */
export const RegionNode = memo(function RegionNode({
  data,
  selected,
}: NodeProps<RegionFlowNode>) {
  const t = useTranslations("Canvas")
  const { dbNode, memberTotal, runningCount, unresolved } = data
  const {
    expandedRegions,
    expandRegion,
    patchNode,
    endNodeResize,
    deleteNode,
  } = useCanvasView()
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState("")

  const folder = useAppWorkspaceStore((s) =>
    dbNode.kind === "folder" && dbNode.folder_id != null
      ? s.allFolders.find((f) => f.id === dbNode.folder_id)
      : undefined
  )

  const fallbackName =
    dbNode.kind === "folder"
      ? folder
        ? formatFolderLabelWithAlias(folder)
        : t("unresolvedFolder")
      : dbNode.kind === "agent"
        ? getAgentLabel(dbNode.agent_type ?? "")
        : t("customRegion")
  const name = dbNode.title?.trim() || fallbackName

  const collapsed = dbNode.collapsed
  const expanded = expandedRegions.has(dbNode.id)
  const hiddenCount = expanded ? 0 : memberTotal - MAX_VISIBLE_MEMBERS

  const commitRename = () => {
    setEditing(false)
    const next = draft.trim()
    if (next !== (dbNode.title ?? "")) {
      void patchNode(dbNode.id, { title: next })
    }
  }

  const headerIcon =
    dbNode.kind === "agent" && dbNode.agent_type ? (
      <AgentIcon agentType={dbNode.agent_type} className="size-3.5 shrink-0" />
    ) : dbNode.kind === "folder" ? (
      <Folder className="size-3.5 shrink-0 text-muted-foreground" />
    ) : (
      <Sparkles className="size-3.5 shrink-0 text-muted-foreground" />
    )

  return (
    <div
      className={cn(
        // Size comes from the RF node wrapper (derive feeds width/height,
        // including live NodeResizer dimensions) — never from local style.
        "relative flex h-full w-full flex-col rounded-2xl border bg-card/50 transition-colors",
        collapsed && "rounded-full",
        unresolved
          ? "border-dashed border-foreground/20"
          : "border-foreground/15",
        selected && "border-primary ring-2 ring-primary/25"
      )}
    >
      <NodeResizer
        isVisible={Boolean(selected) && !collapsed}
        minWidth={260}
        minHeight={160}
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
      <div
        className="flex shrink-0 items-center gap-1.5 px-3"
        style={{ height: REGION_HEADER_HEIGHT }}
      >
        <ColorDot value={dbNode.color} />
        {headerIcon}
        {editing ? (
          <input
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commitRename}
            onKeyDown={(e) => {
              if (e.key === "Enter") commitRename()
              if (e.key === "Escape") setEditing(false)
            }}
            placeholder={fallbackName}
            className="nodrag min-w-0 flex-1 rounded-md border border-input bg-background px-1.5 py-0.5 text-[0.8125rem] font-semibold outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />
        ) : (
          <span
            className={cn(
              "min-w-0 flex-1 truncate text-[0.8125rem] font-semibold",
              unresolved && "text-muted-foreground"
            )}
            onDoubleClick={() => {
              setDraft(dbNode.title ?? "")
              setEditing(true)
            }}
          >
            {name}
          </span>
        )}
        {runningCount > 0 && (
          <span
            className="inline-flex shrink-0 items-center gap-1 rounded-full bg-primary/10 px-1.5 py-px font-mono text-[0.625rem] font-medium leading-4 text-primary"
            title={t("runningCount", { count: runningCount })}
          >
            <span className="size-1.5 rounded-full bg-primary motion-safe:animate-pulse" />
            {runningCount}
          </span>
        )}
        <span className="shrink-0 font-mono text-[0.6875rem] text-muted-foreground">
          {memberTotal}
        </span>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              className="nodrag inline-flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-foreground/10 hover:text-foreground"
              aria-label={t("regionMenu")}
            >
              <MoreHorizontal className="size-3.5" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="nodrag w-44">
            <DropdownMenuItem
              onSelect={() => {
                setDraft(dbNode.title ?? "")
                setEditing(true)
              }}
            >
              <Pencil className="text-muted-foreground" />
              {t("rename")}
            </DropdownMenuItem>
            <DropdownMenuItem
              onSelect={() =>
                void patchNode(dbNode.id, { collapsed: !collapsed })
              }
            >
              {collapsed ? (
                <ChevronsUpDown className="text-muted-foreground" />
              ) : (
                <ChevronsDownUp className="text-muted-foreground" />
              )}
              {collapsed ? t("expand") : t("collapse")}
            </DropdownMenuItem>
            <DropdownMenuSub>
              <DropdownMenuSubTrigger>
                <ColorDot value={dbNode.color} />
                <span className="ml-2">{t("color")}</span>
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent className="nodrag">
                <div className="grid grid-cols-6 gap-1 p-1">
                  {THEME_COLORS.map((c) => (
                    <button
                      key={c}
                      type="button"
                      className="inline-flex size-6 items-center justify-center rounded-md transition-colors hover:bg-foreground/10"
                      onClick={() =>
                        void patchNode(dbNode.id, {
                          color: c === dbNode.color ? "" : c,
                        })
                      }
                      aria-label={c}
                    >
                      <ColorDot value={c} active={dbNode.color === c} />
                    </button>
                  ))}
                </div>
              </DropdownMenuSubContent>
            </DropdownMenuSub>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              variant="destructive"
              onSelect={() => void deleteNode(dbNode.id)}
            >
              <Trash2 />
              {t("removeRegion")}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {!collapsed && unresolved && (
        <div className="flex flex-1 flex-col items-center justify-center gap-1.5 p-4 text-center">
          <Unlink
            className="size-5 text-muted-foreground/50"
            aria-hidden="true"
          />
          <p className="max-w-56 text-xs text-muted-foreground">
            {t("unresolvedFolderHint")}
          </p>
        </div>
      )}

      {!collapsed && !unresolved && memberTotal === 0 && (
        <div className="flex flex-1 items-center justify-center p-4">
          <p className="text-xs text-muted-foreground/70">
            {dbNode.kind === "custom" ? t("emptyCustomHint") : t("emptyRegion")}
          </p>
        </div>
      )}

      {!collapsed && hiddenCount > 0 && (
        <div className="absolute inset-x-0 bottom-0 flex justify-center pb-2">
          <button
            type="button"
            className="nodrag inline-flex items-center gap-1 rounded-full border border-foreground/15 bg-background/90 px-2.5 py-1 text-[0.6875rem] font-medium text-muted-foreground shadow-sm transition-colors hover:text-foreground supports-backdrop-filter:backdrop-blur-sm"
            onClick={() => expandRegion(dbNode.id)}
          >
            <Plus className="size-3" aria-hidden="true" />
            {t("showMore", { count: hiddenCount })}
          </button>
        </div>
      )}
    </div>
  )
})
