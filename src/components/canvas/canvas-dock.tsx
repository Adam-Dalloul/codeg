"use client"

import type { ReactNode } from "react"
import { Panel, useReactFlow, useStore, type Node } from "@xyflow/react"
import {
  ChevronsDownUp,
  ChevronsUpDown,
  CircleMinus,
  CirclePlus,
  Expand,
  ExternalLink,
  Grid2x2,
  ImageDown,
  LayoutGrid,
  Loader2,
  Maximize2,
  Minimize2,
  Palette,
  PanelRight,
  Pencil,
  Sparkles,
  Trash2,
  Unlink,
  X,
} from "lucide-react"
import { useTranslations } from "next-intl"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import type { CreateCanvasNodeInput } from "@/lib/api"
import { cn } from "@/lib/utils"
import { AddNodeMenu } from "./add-node-menu"
import type {
  ConversationCardData,
  NoteNodeData,
  RegionNodeData,
} from "./canvas-model"
import { regionHeightForRows, regionWidthForColumns } from "./canvas-model"
import {
  ColorDot,
  ColorPalette,
  GRID_CHOICES,
  GridChoice,
} from "./canvas-swatches"
import { useCanvasView } from "./canvas-view-context"
import type { ConversationDraftData } from "./nodes/conversation-detail-node"

/**
 * The canvas's action surface: a bottom-centred dock whose left half is always
 * the same board-level tools and whose right half is whatever the current
 * selection can do — plus the zoom pill in the corner (`CanvasZoomPanel`),
 * which is the one control that belongs nowhere near a selection.
 *
 * One surface on purpose. Element actions used to be spread across a card
 * context menu, a region header dropdown and a hover button in a note's corner
 * — three idioms, none of them discoverable, and one of them (right-click) now
 * belongs to panning. Selecting an element and reading its verbs off a fixed
 * bar is the same move a canvas app makes for a reason: the actions are always
 * in the place you last saw them.
 */

const DOCK_BUTTON =
  "inline-flex size-8 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-foreground/10 hover:text-foreground disabled:pointer-events-none disabled:opacity-40"

const DOCK_BUTTON_DANGER =
  "inline-flex size-8 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive"

function DockButton({
  label,
  onClick,
  disabled,
  danger,
  children,
}: {
  label: string
  onClick: () => void
  disabled?: boolean
  danger?: boolean
  children: ReactNode
}) {
  return (
    <button
      type="button"
      className={danger ? DOCK_BUTTON_DANGER : DOCK_BUTTON}
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      title={label}
    >
      {children}
    </button>
  )
}

/** Long enough to read as a move, short enough not to fight a second click. */
const ZOOM_STEP_DURATION_MS = 150

/** Float slop: `zoomTo(2)` lands on 1.9999999999999998 often enough that an
 *  exact `>= maxZoom` would leave the button live at the stop. */
const ZOOM_EPSILON = 0.001

/**
 * Viewport zoom, in its own pill in the bottom-right corner.
 *
 * Deliberately NOT in the dock: the dock is a selection-driven strip whose
 * contents change as you click around the board, and a zoom readout that slides
 * sideways every time you select a region is a control you have to hunt for. It
 * also collided head-on with "add to canvas" — both spelled `Plus`, one row
 * apart. Circled glyphs, a fixed corner, nothing else in it.
 *
 * Its own component so it can subscribe to the LIVE zoom: `canvas-view` keeps
 * the zoom in a ref (deliberately — the drag path reads it every frame and must
 * not re-render), so the readout has to come from ReactFlow's store instead. The
 * selector returns a number, so zustand bails out on every pan and re-renders
 * only when the zoom actually moves.
 */
export function CanvasZoomPanel() {
  const t = useTranslations("Canvas")
  const { zoomIn, zoomOut, zoomTo } = useReactFlow()
  const zoom = useStore((s) => s.transform[2])
  const minZoom = useStore((s) => s.minZoom)
  const maxZoom = useStore((s) => s.maxZoom)

  return (
    <Panel position="bottom-right" data-canvas-export-skip="">
      <div
        className="flex items-center gap-0.5 rounded-full border border-border bg-background/95 p-1 shadow-lg supports-backdrop-filter:backdrop-blur-sm"
        role="toolbar"
        aria-label={t("zoomControls")}
      >
        <DockButton
          label={t("zoomOut")}
          onClick={() => void zoomOut({ duration: ZOOM_STEP_DURATION_MS })}
          disabled={zoom <= minZoom + ZOOM_EPSILON}
        >
          <CircleMinus className="size-4" />
        </DockButton>
        {/* The readout doubles as "back to 100%" — the one zoom level a user
            asks for by name. Fixed width so 8% → 100% → 200% doesn't shove the
            neighbouring buttons sideways as the board moves. */}
        <button
          type="button"
          className="inline-flex h-8 w-12 shrink-0 items-center justify-center rounded-full font-mono text-[0.6875rem] text-muted-foreground transition-colors hover:bg-foreground/10 hover:text-foreground"
          onClick={() => void zoomTo(1, { duration: ZOOM_STEP_DURATION_MS })}
          aria-label={t("resetZoom")}
          title={t("resetZoom")}
        >
          {Math.round(zoom * 100)}%
        </button>
        <DockButton
          label={t("zoomIn")}
          onClick={() => void zoomIn({ duration: ZOOM_STEP_DURATION_MS })}
          disabled={zoom >= maxZoom - ZOOM_EPSILON}
        >
          <CirclePlus className="size-4" />
        </DockButton>
      </div>
    </Panel>
  )
}

/** Separates the fixed tools from the selection's verbs. */
function DockDivider() {
  return (
    <span className="mx-1 h-5 w-px shrink-0 bg-border" aria-hidden="true" />
  )
}

/** A dock button that opens a picker upward. */
function DockMenu({
  label,
  trigger,
  children,
}: {
  label: string
  trigger: ReactNode
  children: ReactNode
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className={DOCK_BUTTON}
          aria-label={label}
          title={label}
        >
          {trigger}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent side="top" align="center" className="w-44">
        {children}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function RegionActions({ data }: { data: RegionNodeData }) {
  const t = useTranslations("Canvas")
  const {
    expandedRegions,
    setRegionExpanded,
    setRenamingRegionId,
    patchNode,
    deleteNode,
  } = useCanvasView()
  const { dbNode, memberTotal, visibleCount } = data
  const expanded = expandedRegions.has(dbNode.id)
  const hasHidden = memberTotal > visibleCount

  /** Pin a grid axis and resize the frame to match in ONE patch — leaving the
   *  stored geometry behind would make the region render at a width the derive
   *  layer overrides, so the next plain resize would snap it back. */
  const setGrid = (columns: number, rows: number) => {
    void patchNode(dbNode.id, {
      gridColumns: columns,
      gridRows: rows,
      ...(columns > 0 ? { width: regionWidthForColumns(columns) } : {}),
      ...(rows > 0 ? { height: regionHeightForRows(rows) } : {}),
    })
  }

  return (
    <>
      <DockButton
        label={t("rename")}
        onClick={() => setRenamingRegionId(dbNode.id)}
      >
        <Pencil className="size-4" />
      </DockButton>
      <DockButton
        label={dbNode.collapsed ? t("expand") : t("collapse")}
        onClick={() =>
          void patchNode(dbNode.id, { collapsed: !dbNode.collapsed })
        }
      >
        {dbNode.collapsed ? (
          <ChevronsUpDown className="size-4" />
        ) : (
          <ChevronsDownUp className="size-4" />
        )}
      </DockButton>
      {(hasHidden || expanded) && (
        <DockButton
          label={expanded ? t("showFewerMembers") : t("showAllMembers")}
          onClick={() => setRegionExpanded(dbNode.id, !expanded)}
        >
          {expanded ? (
            <Minimize2 className="size-4" />
          ) : (
            <Maximize2 className="size-4" />
          )}
        </DockButton>
      )}
      <DockMenu label={t("grid")} trigger={<Grid2x2 className="size-4" />}>
        <DropdownMenuLabel className="text-[0.6875rem] font-normal text-muted-foreground">
          {t("gridColumns")}
        </DropdownMenuLabel>
        <div className="grid grid-cols-4 gap-1 p-1">
          <GridChoice
            label={t("gridAuto")}
            active={dbNode.grid_columns === 0}
            onSelect={() => setGrid(0, dbNode.grid_rows)}
          />
          {GRID_CHOICES.map((n) => (
            <GridChoice
              key={n}
              label={String(n)}
              active={dbNode.grid_columns === n}
              onSelect={() => setGrid(n, dbNode.grid_rows)}
            />
          ))}
        </div>
        <DropdownMenuLabel className="text-[0.6875rem] font-normal text-muted-foreground">
          {t("gridRows")}
        </DropdownMenuLabel>
        <div className="grid grid-cols-4 gap-1 p-1">
          <GridChoice
            label={t("gridAuto")}
            active={dbNode.grid_rows === 0}
            onSelect={() => setGrid(dbNode.grid_columns, 0)}
          />
          {GRID_CHOICES.map((n) => (
            <GridChoice
              key={n}
              label={String(n)}
              active={dbNode.grid_rows === n}
              onSelect={() => setGrid(dbNode.grid_columns, n)}
            />
          ))}
        </div>
      </DockMenu>
      <DockMenu
        label={t("color")}
        trigger={<ColorDot value={dbNode.color} className="size-4" />}
      >
        <ColorPalette
          value={dbNode.color}
          onSelect={(color) => void patchNode(dbNode.id, { color })}
        />
      </DockMenu>
      <DockButton
        label={t("removeRegion")}
        danger
        onClick={() => void deleteNode(dbNode.id)}
      >
        <Trash2 className="size-4" />
      </DockButton>
    </>
  )
}

function NoteActions({ data }: { data: NoteNodeData }) {
  const t = useTranslations("Canvas")
  const { patchNode, deleteNode } = useCanvasView()
  const { dbNode } = data
  return (
    <>
      <DockMenu label={t("color")} trigger={<Palette className="size-4" />}>
        <ColorPalette
          value={dbNode.color}
          onSelect={(color) => void patchNode(dbNode.id, { color })}
        />
      </DockMenu>
      <DockButton
        label={t("removeNote")}
        danger
        onClick={() => void deleteNode(dbNode.id)}
      >
        <Trash2 className="size-4" />
      </DockButton>
    </>
  )
}

function CardActions({
  data,
  detail,
}: {
  data: ConversationCardData
  detail: boolean
}) {
  const t = useTranslations("Canvas")
  const {
    setCardDetail,
    detachMember,
    removeMember,
    deleteNode,
    openConversation,
    openConversationDrawer,
  } = useCanvasView()
  const conversation = data.conversation
  const { pinDbId, regionDbId } = data
  if (!conversation) {
    return pinDbId != null ? (
      <DockButton
        label={t("removeCard")}
        danger
        onClick={() => void deleteNode(pinDbId)}
      >
        <Trash2 className="size-4" />
      </DockButton>
    ) : null
  }

  return (
    <>
      {detail ? (
        <DockButton
          label={t("collapseConversation")}
          onClick={() => pinDbId != null && setCardDetail(pinDbId, false)}
        >
          <Minimize2 className="size-4" />
        </DockButton>
      ) : (
        <>
          <DockButton
            label={t("expandConversation")}
            onClick={() => {
              if (pinDbId != null) setCardDetail(pinDbId, true)
              else if (regionDbId != null) {
                void detachMember(regionDbId, conversation.id, { expand: true })
              }
            }}
          >
            <Expand className="size-4" />
          </DockButton>
          {/* The other way into the same conversation. Expanding gives it board
              space and, for a region member, takes it out of the region first;
              this one leaves the board exactly as it is. */}
          <DockButton
            label={t("openDetailPanel")}
            onClick={() => openConversationDrawer(conversation.id)}
          >
            <PanelRight className="size-4" />
          </DockButton>
        </>
      )}
      <DockButton
        label={t("openInWorkspace")}
        onClick={() => openConversation(conversation, true)}
      >
        <ExternalLink className="size-4" />
      </DockButton>
      {regionDbId != null && (
        <>
          <DockButton
            label={t("detachToCanvas")}
            onClick={() => void detachMember(regionDbId, conversation.id)}
          >
            <Unlink className="size-4" />
          </DockButton>
          {data.regionOwnsMembers && (
            <DockButton
              label={t("removeFromRegion")}
              danger
              onClick={() => void removeMember(regionDbId, conversation.id)}
            >
              <Trash2 className="size-4" />
            </DockButton>
          )}
        </>
      )}
      {pinDbId != null && (
        <DockButton
          label={t("removeCard")}
          danger
          onClick={() => void deleteNode(pinDbId)}
        >
          <Trash2 className="size-4" />
        </DockButton>
      )}
    </>
  )
}

function DraftActions({ data }: { data: ConversationDraftData }) {
  const t = useTranslations("Canvas")
  const { dismissDraft, sendingDrafts } = useCanvasView()
  // Nothing to discard once the first send is minting the row: `dismissDraft`
  // refuses anyway, and a button that silently does nothing is worse than no
  // button. The card's own control disappears for the same window.
  if (sendingDrafts.has(data.draftId)) return null
  return (
    <DockButton
      label={t("discardDraft")}
      danger
      onClick={() => dismissDraft(data.draftId)}
    >
      <X className="size-4" />
    </DockButton>
  )
}

interface CanvasDockProps {
  onCreate: (input: CreateCanvasNodeInput) => void
  onNewConversation: (point: { x: number; y: number }) => void
  onFitView: () => void
  onAutoArrange: () => void
  onExportPng: () => void
  exporting: boolean
  exportDisabled: boolean
  /** The RF nodes currently selected, in board order. */
  selectedNodes: Node[]
  /** Conversations in the selection — a "group these" gesture needs at least
   *  one, and the count is what the chip shows. */
  selectedConversationCount: number
  onGroupSelection: () => void
  onDeleteSelection: () => void
}

export function CanvasDock({
  onCreate,
  onNewConversation,
  onFitView,
  onAutoArrange,
  onExportPng,
  exporting,
  exportDisabled,
  selectedNodes,
  selectedConversationCount,
  onGroupSelection,
  onDeleteSelection,
}: CanvasDockProps) {
  const t = useTranslations("Canvas")
  // The board's own width (ReactFlow tracks it with a ResizeObserver), not the
  // window's: this route sits beside the workspace sidebar, so `100vw` would
  // overstate the room by the whole sidebar and let the strip run under the
  // zoom pill. Kept in the same units the pill is drawn in — the reserve below
  // is `rem`, so it grows with the app's zoom exactly as the pill does.
  const boardWidth = useStore((s) => s.width)

  const single = selectedNodes.length === 1 ? selectedNodes[0] : null
  let elementActions: ReactNode = null
  if (single) {
    switch (single.type) {
      case "region":
        elementActions = (
          <RegionActions data={single.data as unknown as RegionNodeData} />
        )
        break
      case "note":
        elementActions = (
          <NoteActions data={single.data as unknown as NoteNodeData} />
        )
        break
      case "conversationCard":
      case "conversationDetail":
        elementActions = (
          <CardActions
            data={single.data as unknown as ConversationCardData}
            detail={single.type === "conversationDetail"}
          />
        )
        break
      case "conversationDraft":
        elementActions = (
          <DraftActions
            data={single.data as unknown as ConversationDraftData}
          />
        )
        break
    }
  } else if (selectedNodes.length > 1) {
    elementActions = (
      <>
        <span className="px-1 font-mono text-[0.6875rem] text-muted-foreground">
          {t("selectedCount", { count: selectedNodes.length })}
        </span>
        <DockButton
          label={t("createRegionFromSelection")}
          onClick={onGroupSelection}
          disabled={selectedConversationCount === 0}
        >
          <Sparkles className="size-4" />
        </DockButton>
        <DockButton
          label={t("deleteSelected")}
          danger
          onClick={onDeleteSelection}
        >
          <Trash2 className="size-4" />
        </DockButton>
      </>
    )
  }

  return (
    <Panel position="bottom-center" data-canvas-export-skip="">
      <div
        className={cn(
          // Fully rounded and wrapping: the element half grows and shrinks with
          // the selection, and a narrow window must fold it rather than push it
          // off the edge.
          "flex flex-wrap items-center justify-center gap-0.5",
          "rounded-full border border-border bg-background/95 p-1 shadow-lg supports-backdrop-filter:backdrop-blur-sm"
        )}
        // The strip is CENTRED, so half of whatever it grows to reaches toward
        // the corner the zoom pill sits in. Folding early is the price of never
        // hiding a control under another one; `18rem` is two pill widths plus
        // both panel margins.
        style={{ maxWidth: `max(15rem, calc(${boardWidth}px - 18rem))` }}
        role="toolbar"
        aria-label={t("canvasActions")}
      >
        <AddNodeMenu
          onCreate={onCreate}
          onNewConversation={onNewConversation}
          triggerClassName={DOCK_BUTTON}
          side="top"
        />
        <DockButton label={t("fitView")} onClick={onFitView}>
          <Expand className="size-4" />
        </DockButton>
        <DockButton label={t("autoArrange")} onClick={onAutoArrange}>
          <LayoutGrid className="size-4" />
        </DockButton>
        <DockButton
          label={t("exportPng")}
          onClick={onExportPng}
          disabled={exporting || exportDisabled}
        >
          {exporting ? (
            <Loader2 className="size-4 animate-spin" />
          ) : (
            <ImageDown className="size-4" />
          )}
        </DockButton>
        {elementActions && (
          <>
            <DockDivider />
            {elementActions}
          </>
        )}
      </div>
    </Panel>
  )
}
