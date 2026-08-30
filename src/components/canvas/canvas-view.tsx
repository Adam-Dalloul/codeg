"use client"

import "@xyflow/react/dist/style.css"

import { useCallback, useMemo, useState } from "react"
import {
  Background,
  BackgroundVariant,
  MiniMap,
  Panel,
  ReactFlow,
  ReactFlowProvider,
  getNodesBounds,
  getViewportForBounds,
  useReactFlow,
  type Node,
  type NodeChange,
  type NodeTypes,
} from "@xyflow/react"
import {
  Expand,
  ImageDown,
  LayoutGrid,
  Loader2,
  Map as MapIcon,
  Wand2,
} from "lucide-react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"
import { toPng } from "html-to-image"
import { useWorkbenchRoute } from "@/contexts/workbench-route-context"
import { useTabActions } from "@/contexts/tab-context"
import {
  canvasCreateNode,
  canvasDeleteNode,
  canvasDetachMember,
  canvasMoveNodes,
  canvasUpdateNode,
  type CanvasNodePatchInput,
  type CreateCanvasNodeInput,
} from "@/lib/api"
import { toErrorMessage } from "@/lib/app-error"
import type { CanvasNodeMovePayload, DbConversationSummary } from "@/lib/types"
import { cn } from "@/lib/utils"
import { useAppWorkspaceStore } from "@/stores/app-workspace-store"
import { applyMovesTo, useCanvasStore } from "@/stores/canvas-store"
import { AddNodeMenu } from "./add-node-menu"
import { useCanvasData } from "./canvas-data"
import {
  computeRegionMembers,
  deriveFlowGraph,
  packLayout,
  parseMemberNodeId,
  parseRegionNodeId,
  regionNodeId,
  seedRegionsFromFolders,
  classifyDrop,
  type ConversationCardData,
} from "./canvas-model"
import {
  CanvasViewProvider,
  type CanvasViewContextValue,
} from "./canvas-view-context"
import { ConversationCardNode } from "./nodes/conversation-card-node"
import { NoteNode } from "./nodes/note-node"
import { RegionNode } from "./nodes/region-node"

// Each component takes the NARROW NodeProps of its own node type; the registry
// wants them contravariantly widened, which TS can't express — the standard RF
// escape hatch.
const NODE_TYPES = {
  region: RegionNode,
  conversationCard: ConversationCardNode,
  note: NoteNode,
} as unknown as NodeTypes

/** Toolbar buttons share the mermaid floating-bar recipe. */
const TOOL_BUTTON_CLASS =
  "inline-flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-foreground/10 hover:text-foreground disabled:pointer-events-none disabled:opacity-50"

function CanvasFlow() {
  useCanvasData()
  const t = useTranslations("Canvas")
  const { openConversations } = useWorkbenchRoute()
  const { openTab } = useTabActions()
  const { fitView } = useReactFlow()

  const dbNodes = useCanvasStore((s) => s.nodes)
  const hydrated = useCanvasStore((s) => s.hydrated)
  const conversations = useAppWorkspaceStore((s) => s.conversations)
  const allFolders = useAppWorkspaceStore((s) => s.allFolders)
  const openFolders = useAppWorkspaceStore((s) => s.folders)

  const [expandedRegions, setExpandedRegions] = useState<ReadonlySet<number>>(
    () => new Set()
  )
  const [selectedIds, setSelectedIds] = useState<ReadonlySet<string>>(
    () => new Set()
  )
  // Transient drag positions (RF node id → parent-relative position). State,
  // not a ref: the derive layer must re-run as the pointer moves.
  const [overlay, setOverlay] = useState<
    ReadonlyMap<string, { x: number; y: number }>
  >(() => new Map())
  // Transient resize dimensions (NodeResizer feed); cleared by endNodeResize.
  const [sizeOverlay, setSizeOverlay] = useState<
    ReadonlyMap<string, { width: number; height: number }>
  >(() => new Map())
  // Member-list freeze for the region whose member is mid-drag (ref: read only
  // inside the derive memo via state bump below).
  const [frozenMembers, setFrozenMembers] = useState<ReadonlyMap<
    number,
    number[]
  > | null>(null)
  const [exporting, setExporting] = useState(false)
  const [seeding, setSeeding] = useState(false)

  const derived = useMemo(
    () =>
      deriveFlowGraph({
        dbNodes: dbNodes.values(),
        conversations,
        allFolders,
        expandedRegions,
        overlay,
        frozenMembers,
        sizeOverlay,
      }),
    [
      dbNodes,
      conversations,
      allFolders,
      expandedRegions,
      overlay,
      frozenMembers,
      sizeOverlay,
    ]
  )

  const rfNodes = useMemo(
    () =>
      derived.nodes.map((n) => ({
        ...n,
        selected: selectedIds.has(n.id),
      })) as Node[],
    [derived.nodes, selectedIds]
  )

  const selectedConversationIds = useMemo(() => {
    const out = new Set<number>()
    for (const n of derived.nodes) {
      if (n.type === "conversationCard" && selectedIds.has(n.id)) {
        const data = n.data as ConversationCardData
        if (data.conversation) out.add(data.conversation.id)
      }
    }
    return out
  }, [derived.nodes, selectedIds])

  // ── Commands (every mutation: fire → optimistic applyResponse → toast on
  // error; the event stream is what advances the revision) ──

  const patchNode = useCallback(
    async (nodeId: number, patch: CanvasNodePatchInput) => {
      try {
        const res = await canvasUpdateNode(nodeId, patch)
        useCanvasStore
          .getState()
          .applyResponse(res.revision, (nodes) =>
            nodes.set(res.value.id, res.value)
          )
      } catch (e) {
        toast.error(toErrorMessage(e))
      }
    },
    []
  )

  const deleteNode = useCallback(async (nodeId: number) => {
    try {
      const res = await canvasDeleteNode(nodeId)
      useCanvasStore
        .getState()
        .applyResponse(res.revision, (nodes) => nodes.delete(nodeId))
    } catch (e) {
      toast.error(toErrorMessage(e))
    }
  }, [])

  const createNode = useCallback(async (input: CreateCanvasNodeInput) => {
    try {
      const res = await canvasCreateNode(input)
      useCanvasStore
        .getState()
        .applyResponse(res.revision, (nodes) =>
          nodes.set(res.value.id, res.value)
        )
    } catch (e) {
      toast.error(toErrorMessage(e))
    }
  }, [])

  const moveNodes = useCallback(async (moves: CanvasNodeMovePayload[]) => {
    if (moves.length === 0) return
    try {
      const res = await canvasMoveNodes(moves)
      // res.value is what the backend actually wrote (clamped, ghosts
      // dropped) — mirroring the broadcast payload exactly.
      useCanvasStore
        .getState()
        .applyResponse(res.revision, (nodes) => applyMovesTo(nodes, res.value))
    } catch (e) {
      toast.error(toErrorMessage(e))
    }
  }, [])

  const openConversation = useCallback(
    (conversation: DbConversationSummary, pin: boolean) => {
      // Full-page route overlays the workspace: switch back FIRST or the tab
      // opens invisibly underneath the canvas.
      openConversations()
      openTab(
        conversation.folder_id,
        conversation.id,
        conversation.agent_type,
        pin,
        conversation.title ?? undefined
      )
    },
    [openConversations, openTab]
  )

  const expandRegion = useCallback((regionDbId: number) => {
    setExpandedRegions((prev) => new Set(prev).add(regionDbId))
  }, [])

  const endNodeResize = useCallback(
    (
      nodeId: number,
      geometry: { x: number; y: number; width: number; height: number }
    ) => {
      const rfId = regionNodeId(nodeId)
      void patchNode(nodeId, geometry).finally(() => {
        // Resizes never get a dragStop, so the overlays they fed are cleared
        // here — success (store now holds the geometry) and failure (snap
        // back to the stored one) both want them gone. If a NEW gesture on
        // the same node started during the patch round-trip, this clear
        // costs it one frame at most: every live gesture rewrites its
        // overlay entry on the next change batch.
        setOverlay((prev) => {
          if (!prev.has(rfId)) return prev
          const next = new Map(prev)
          next.delete(rfId)
          return next
        })
        setSizeOverlay((prev) => {
          if (!prev.has(rfId)) return prev
          const next = new Map(prev)
          next.delete(rfId)
          return next
        })
      })
    },
    [patchNode]
  )

  const viewContext = useMemo<CanvasViewContextValue>(
    () => ({
      expandedRegions,
      expandRegion,
      selectedConversationIds,
      patchNode,
      endNodeResize,
      deleteNode,
      openConversation,
    }),
    [
      expandedRegions,
      expandRegion,
      selectedConversationIds,
      patchNode,
      endNodeResize,
      deleteNode,
      openConversation,
    ]
  )

  // ── Drag reconcile ──

  const handleNodesChange = useCallback((changes: NodeChange[]) => {
    setSelectedIds((prev) => {
      let next: Set<string> | null = null
      for (const change of changes) {
        if (change.type !== "select") continue
        next ??= new Set(prev)
        if (change.selected) next.add(change.id)
        else next.delete(change.id)
      }
      return next ?? prev
    })
    // Position changes feed the transient overlay — never the store; the store
    // position only moves via command responses / events. Both drags (cleared
    // at dragStop) and top/left-handle resizes (cleared by endNodeResize)
    // land here.
    setOverlay((prev) => {
      let next: Map<string, { x: number; y: number }> | null = null
      for (const change of changes) {
        if (change.type !== "position" || !change.position) continue
        next ??= new Map(prev)
        next.set(change.id, change.position)
      }
      return next ?? prev
    })
    // Dimension changes feed the size overlay ONLY while a NodeResizer handle
    // is actively held (`resizing`): RF also emits dimension changes for
    // plain DOM measurements (mount, visibility), and admitting those would
    // pin every node's size and shadow remote resizes forever. Cleared by
    // endNodeResize.
    setSizeOverlay((prev) => {
      let next: Map<string, { width: number; height: number }> | null = null
      for (const change of changes) {
        if (
          change.type !== "dimensions" ||
          !change.dimensions ||
          change.resizing !== true
        ) {
          continue
        }
        next ??= new Map(prev)
        next.set(change.id, change.dimensions)
      }
      return next ?? prev
    })
  }, [])

  const handleNodeDragStart = useCallback(
    (_e: unknown, node: Node) => {
      const member = parseMemberNodeId(node.id)
      if (!member) return
      const dbNode = dbNodes.get(member.regionDbId)
      if (!dbNode) return
      // Freeze the source region's member list so a remote change can't
      // reflow the grid mid-drag.
      const members = computeRegionMembers(dbNode, conversations, allFolders)
      setFrozenMembers(new Map([[member.regionDbId, members.map((m) => m.id)]]))
    },
    [dbNodes, conversations, allFolders]
  )

  const clearDragState = useCallback((nodeIds: string[]) => {
    setOverlay((prev) => {
      if (prev.size === 0) return prev
      const next = new Map(prev)
      for (const id of nodeIds) next.delete(id)
      return next.size === prev.size ? prev : next
    })
    setFrozenMembers(null)
  }, [])

  const handleNodeDragStop = useCallback(
    async (_e: unknown, node: Node, draggedNodes: Node[]) => {
      const dragged = draggedNodes.length > 0 ? draggedNodes : [node]
      const draggedIds = dragged.map((n) => n.id)

      // Top-level nodes in the drag (even when a member card is the grabbed
      // one — mixed multi-selections drag together): one batched position
      // write for all of them.
      const moves: CanvasNodeMovePayload[] = []
      for (const n of dragged) {
        const dbId = parseRegionNodeId(n.id)
        if (dbId != null) {
          moves.push({ id: dbId, x: n.position.x, y: n.position.y })
        }
      }

      const member = parseMemberNodeId(node.id)
      if (!member) {
        try {
          await moveNodes(moves)
        } finally {
          clearDragState(draggedIds)
        }
        return
      }

      // Member card: classify the drop against region rects (positions are
      // parent-relative; the source region's rect anchors the absolute point).
      // Only the GRABBED member re-homes; other selected members snap back
      // when their overlay clears — multi-card detach is deliberately not a
      // gesture (one transaction per card would spray events).
      if (moves.length > 0) void moveNodes(moves)
      // The memoized rects lag the very last drag frame (state flushes after
      // this handler), and in a mixed selection regions travelled WITH the
      // card — reconcile them against the dragged nodes' final positions
      // before classifying.
      const finalPos = new Map(dragged.map((n) => [n.id, n.position]))
      const rects = derived.regionRects.map((r) => {
        const moved = finalPos.get(regionNodeId(r.dbId))
        return moved ? { ...r, x: moved.x, y: moved.y } : r
      })
      const sourceRect = rects.find((r) => r.dbId === member.regionDbId)
      const abs = sourceRect
        ? {
            x: sourceRect.x + node.position.x,
            y: sourceRect.y + node.position.y,
          }
        : node.position
      const drop = classifyDrop(abs, rects, member.regionDbId)

      try {
        if (drop.type === "canvas") {
          const res = await canvasDetachMember(
            member.regionDbId,
            member.conversationId,
            drop.x,
            drop.y
          )
          useCanvasStore.getState().applyResponse(res.revision, (nodes) => {
            const region = nodes.get(member.regionDbId)
            if (region && region.kind === "custom") {
              nodes.set(member.regionDbId, {
                ...region,
                member_ids: region.member_ids.filter(
                  (m) => m !== member.conversationId
                ),
              })
            }
            nodes.set(res.value.id, res.value)
          })
        } else if (drop.type === "custom") {
          const res = await canvasUpdateNode(drop.regionId, {
            memberAdd: member.conversationId,
          })
          useCanvasStore
            .getState()
            .applyResponse(res.revision, (nodes) =>
              nodes.set(res.value.id, res.value)
            )
        }
        // "same" / "invalid": no command — clearing the overlay snaps the
        // card back into its grid slot.
      } catch (e) {
        toast.error(toErrorMessage(e))
        void useCanvasStore.getState().refetch()
      } finally {
        clearDragState(draggedIds)
      }
    },
    [derived.regionRects, moveNodes, clearDragState]
  )

  // ── Node-level open ──

  const handleNodeClick = useCallback(
    (e: React.MouseEvent, node: Node) => {
      if (e.metaKey || e.ctrlKey || e.shiftKey) return
      if (node.type !== "conversationCard") return
      const data = node.data as ConversationCardData
      if (data.conversation) openConversation(data.conversation, false)
    },
    [openConversation]
  )

  const handleNodeDoubleClick = useCallback(
    (_e: React.MouseEvent, node: Node) => {
      if (node.type !== "conversationCard") return
      const data = node.data as ConversationCardData
      if (data.conversation) openConversation(data.conversation, true)
    },
    [openConversation]
  )

  // ── Toolbar actions ──

  const autoArrange = useCallback(() => {
    const moves = packLayout([...dbNodes.values()], derived.renderedHeights)
    void moveNodes(moves)
  }, [dbNodes, derived.renderedHeights, moveNodes])

  const seedFromWorkspace = useCallback(async () => {
    if (seeding) return
    setSeeding(true)
    try {
      for (const seed of seedRegionsFromFolders(openFolders)) {
        await createNode({
          kind: "folder",
          folderId: seed.folderId,
          x: seed.x,
          y: seed.y,
          width: seed.width,
          height: seed.height,
        })
      }
      window.setTimeout(() => void fitView({ padding: 0.2, duration: 400 }), 80)
    } finally {
      setSeeding(false)
    }
  }, [seeding, openFolders, createNode, fitView])

  const exportPng = useCallback(async () => {
    const viewportEl = document.querySelector<HTMLElement>(
      ".react-flow__viewport"
    )
    if (!viewportEl || rfNodes.length === 0) return
    setExporting(true)
    try {
      const bounds = getNodesBounds(rfNodes)
      const width = Math.min(Math.max(bounds.width + 128, 640), 4096)
      const height = Math.min(Math.max(bounds.height + 128, 480), 4096)
      const viewport = getViewportForBounds(
        bounds,
        width,
        height,
        0.25,
        2,
        0.08
      )
      const background = getComputedStyle(
        document.documentElement
      ).getPropertyValue("--background")
      const dataUrl = await toPng(viewportEl, {
        backgroundColor: background.trim() || undefined,
        width,
        height,
        style: {
          width: `${width}px`,
          height: `${height}px`,
          transform: `translate(${viewport.x}px, ${viewport.y}px) scale(${viewport.zoom})`,
        },
        filter: (el) =>
          !(el instanceof HTMLElement && el.dataset?.canvasExportSkip != null),
      })
      const link = document.createElement("a")
      link.download = "canvas.png"
      link.href = dataUrl
      link.click()
    } catch (e) {
      toast.error(toErrorMessage(e))
    } finally {
      setExporting(false)
    }
  }, [rfNodes])

  const empty = hydrated && dbNodes.size === 0

  return (
    <CanvasViewProvider value={viewContext}>
      <div className="canvas-surface relative h-full w-full">
        <ReactFlow
          nodes={rfNodes}
          edges={[]}
          nodeTypes={NODE_TYPES}
          onNodesChange={handleNodesChange}
          onNodeDragStart={handleNodeDragStart}
          onNodeDragStop={handleNodeDragStop}
          onNodeClick={handleNodeClick}
          onNodeDoubleClick={handleNodeDoubleClick}
          fitView
          fitViewOptions={{ padding: 0.2, maxZoom: 1 }}
          minZoom={0.1}
          maxZoom={2}
          onlyRenderVisibleElements
          selectionKeyCode="Shift"
          multiSelectionKeyCode={["Meta", "Control"]}
          deleteKeyCode={null}
          zoomOnDoubleClick={false}
          proOptions={{ hideAttribution: true }}
        >
          <Background
            variant={BackgroundVariant.Dots}
            gap={24}
            size={1.5}
            className="canvas-dots"
          />
          <MiniMap
            pannable
            zoomable
            position="bottom-right"
            className="canvas-minimap"
            data-canvas-export-skip=""
          />
          <Panel position="top-left" data-canvas-export-skip="">
            <div className="flex items-center gap-0.5 rounded-lg border border-border bg-background/90 p-0.5 shadow-sm supports-backdrop-filter:backdrop-blur-sm">
              <AddNodeMenu
                onCreate={(input) => void createNode(input)}
                triggerClassName={TOOL_BUTTON_CLASS}
              />
              <button
                type="button"
                className={TOOL_BUTTON_CLASS}
                onClick={() => void fitView({ padding: 0.2, duration: 300 })}
                aria-label={t("fitView")}
                title={t("fitView")}
              >
                <Expand className="size-3.5" />
              </button>
              <button
                type="button"
                className={TOOL_BUTTON_CLASS}
                onClick={autoArrange}
                aria-label={t("autoArrange")}
                title={t("autoArrange")}
              >
                <LayoutGrid className="size-3.5" />
              </button>
              <button
                type="button"
                className={TOOL_BUTTON_CLASS}
                onClick={() => void exportPng()}
                disabled={exporting || rfNodes.length === 0}
                aria-label={t("exportPng")}
                title={t("exportPng")}
              >
                {exporting ? (
                  <Loader2 className="size-3.5 animate-spin" />
                ) : (
                  <ImageDown className="size-3.5" />
                )}
              </button>
            </div>
          </Panel>
        </ReactFlow>

        {!hydrated && (
          <div className="absolute inset-0 flex items-center justify-center">
            <Loader2 className="size-5 animate-spin text-muted-foreground/60" />
          </div>
        )}

        {empty && (
          <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-3 p-8 text-center">
            <MapIcon
              className="size-10 text-muted-foreground/40"
              aria-hidden="true"
            />
            <div className="flex flex-col gap-1">
              <p className="text-sm font-medium">{t("empty")}</p>
              <p className="max-w-sm text-xs text-muted-foreground">
                {t("emptyHint")}
              </p>
            </div>
            <button
              type="button"
              className={cn(
                "pointer-events-auto inline-flex items-center gap-1.5 rounded-full bg-primary px-3.5 py-1.5 text-xs font-medium text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-50",
                seeding && "opacity-70"
              )}
              onClick={() => void seedFromWorkspace()}
              disabled={seeding || openFolders.length === 0}
            >
              {seeding ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <Wand2 className="size-3.5" aria-hidden="true" />
              )}
              {t("seedFromWorkspace")}
            </button>
          </div>
        )}
      </div>
    </CanvasViewProvider>
  )
}

/** Default export for `next/dynamic` — the RF provider wrapper lives here so
 *  every hook below it (`useReactFlow` in the toolbar/menu) has its store. */
export default function CanvasView() {
  return (
    <ReactFlowProvider>
      <CanvasFlow />
    </ReactFlowProvider>
  )
}
