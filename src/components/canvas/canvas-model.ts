import type {
  CanvasNode,
  CanvasNodeMovePayload,
  DbConversationSummary,
  FolderDetail,
} from "@/lib/types"

/**
 * Pure derivation layer for the conversation canvas: DB nodes + live workspace
 * store state in, ReactFlow-shaped graph out. Everything here is a plain
 * function of its inputs (unit-tested directly); interaction state — transient
 * drag positions, expanded regions, member freezes — enters as explicit
 * parameters, never as module state.
 */

/** Fixed conversation-card footprint. Width matches Tailwind `w-56`; both
 *  values mirror the backend's CARD_WIDTH/CARD_HEIGHT so a card pinned by
 *  `canvas_detach_member` lands exactly where the drag ghost showed it. */
export const CARD_WIDTH = 224
export const CARD_HEIGHT = 132

/** Region chrome geometry, shared by the layout math here and the region
 *  component's classNames (which must render the same header height and
 *  padding or member cards would overlap the chrome). */
export const REGION_HEADER_HEIGHT = 40
export const REGION_PADDING = 12
export const CARD_GAP = 12
/** Height of a collapsed region capsule (header only). */
export const REGION_COLLAPSED_HEIGHT = 40

/** Cards shown in a region before the "+N" expander takes over. A cap, not
 *  pagination: canvases curate, they don't list. */
export const MAX_VISIBLE_MEMBERS = 24

/** ReactFlow node ids. Regions/notes/pins are DB rows (`region-<dbId>`);
 *  member cards are DERIVED (`member-<regionDbId>-<convId>`, parented to the
 *  region) and never persisted. */
export function regionNodeId(dbId: number): string {
  return `region-${dbId}`
}

export function memberNodeId(
  regionDbId: number,
  conversationId: number
): string {
  return `member-${regionDbId}-${conversationId}`
}

export function parseRegionNodeId(id: string): number | null {
  if (!id.startsWith("region-")) return null
  const dbId = Number(id.slice("region-".length))
  return Number.isInteger(dbId) ? dbId : null
}

export function parseMemberNodeId(
  id: string
): { regionDbId: number; conversationId: number } | null {
  if (!id.startsWith("member-")) return null
  const parts = id.slice("member-".length).split("-")
  if (parts.length !== 2) return null
  const regionDbId = Number(parts[0])
  const conversationId = Number(parts[1])
  if (!Number.isInteger(regionDbId) || !Number.isInteger(conversationId)) {
    return null
  }
  return { regionDbId, conversationId }
}

/** Canvas scope: root-level work only. Delegation children and loop rows are
 *  sub-structure of a conversation, not peers to curate on a board. */
export function isCanvasEligible(c: DbConversationSummary): boolean {
  if (c.kind === "delegate" || c.kind === "loop") return false
  if (c.parent_id != null) return false
  return true
}

/** Two-key order (updated_at desc, id desc): recency first, and a total order
 *  even when timestamps collide (bulk imports share one clock tick). */
export function compareByRecency(
  a: DbConversationSummary,
  b: DbConversationSummary
): number {
  if (a.updated_at !== b.updated_at) {
    return a.updated_at < b.updated_at ? 1 : -1
  }
  return b.id - a.id
}

/**
 * The conversations a region shows, sorted. Folder regions merge the bound
 * folder with its worktree children (direct `parent_id` children only — a
 * region bound to a child shows just that child); agent regions match by
 * agent type across the workspace; custom regions resolve their pinned ids
 * (a stale id — deleted before the prune landed — silently drops out).
 */
export function computeRegionMembers(
  node: CanvasNode,
  conversations: DbConversationSummary[],
  allFolders: FolderDetail[]
): DbConversationSummary[] {
  switch (node.kind) {
    case "folder": {
      if (node.folder_id == null) return []
      const folderIds = new Set<number>([node.folder_id])
      for (const f of allFolders) {
        if (f.parent_id === node.folder_id) folderIds.add(f.id)
      }
      return conversations
        .filter((c) => folderIds.has(c.folder_id) && isCanvasEligible(c))
        .sort(compareByRecency)
    }
    case "agent":
      return conversations
        .filter((c) => c.agent_type === node.agent_type && isCanvasEligible(c))
        .sort(compareByRecency)
    case "custom": {
      const byId = new Map(conversations.map((c) => [c.id, c]))
      return (
        node.member_ids
          .map((id) => byId.get(id))
          // Eligibility re-checked on read: the backend validates liveness, not
          // scope, so a row that later became a sub-structure (re-parented into
          // a delegation) must drop out rather than violate the canvas scope.
          .filter(
            (c): c is DbConversationSummary => c != null && isCanvasEligible(c)
          )
          .sort(compareByRecency)
      )
    }
    default:
      return []
  }
}

/** Whether a binding region's target is gone from the live store (closed or
 *  deleted folder, funnel-missed conversation). Unresolved regions render a
 *  greyed hint instead of members — and come back to life if the folder is
 *  reopened, which is why folder deletion never prunes canvas rows. */
export function isUnresolvedBinding(
  node: CanvasNode,
  conversationsById: ReadonlyMap<number, DbConversationSummary>,
  foldersById: ReadonlyMap<number, FolderDetail>
): boolean {
  if (node.kind === "folder") {
    return node.folder_id == null || !foldersById.has(node.folder_id)
  }
  if (node.kind === "conversation") {
    return (
      node.conversation_id == null ||
      !conversationsById.has(node.conversation_id)
    )
  }
  return false
}

export interface GridLayout {
  /** Per-card position, relative to the REGION's top-left corner. */
  positions: { x: number; y: number }[]
  /** Height the region needs to show this many cards (header + rows). */
  contentHeight: number
  columns: number
}

/** Grid-managed member placement inside a region. Members are never freely
 *  positioned — the grid owns them; a drop inside the same region snaps back. */
export function layoutRegionGrid(
  count: number,
  regionWidth: number
): GridLayout {
  const usable = Math.max(regionWidth - REGION_PADDING * 2, CARD_WIDTH)
  const columns = Math.max(
    1,
    Math.floor((usable + CARD_GAP) / (CARD_WIDTH + CARD_GAP))
  )
  const positions: { x: number; y: number }[] = []
  for (let i = 0; i < count; i++) {
    const col = i % columns
    const row = Math.floor(i / columns)
    positions.push({
      x: REGION_PADDING + col * (CARD_WIDTH + CARD_GAP),
      y: REGION_HEADER_HEIGHT + REGION_PADDING + row * (CARD_HEIGHT + CARD_GAP),
    })
  }
  const rows = Math.ceil(count / columns)
  const contentHeight =
    rows === 0
      ? REGION_COLLAPSED_HEIGHT + REGION_PADDING * 2
      : REGION_HEADER_HEIGHT +
        REGION_PADDING * 2 +
        rows * CARD_HEIGHT +
        (rows - 1) * CARD_GAP
  return { positions, contentHeight, columns }
}

export type CanvasDrop =
  /** Dropped on open canvas: detach (custom = move, bindings = copy). */
  | { type: "canvas"; x: number; y: number }
  /** Dropped into a custom region: copy membership there. */
  | { type: "custom"; regionId: number }
  /** Dropped back into its own region — snap to grid, no command. */
  | { type: "same" }
  /** Dropped onto a non-droppable node — snap back, no command. */
  | { type: "invalid" }

interface RegionRect {
  dbId: number
  kind: CanvasNode["kind"]
  x: number
  y: number
  width: number
  height: number
}

/**
 * Classify where a dragged member card landed. `pos` is the card's absolute
 * canvas position (its top-left); the hit point is the CARD CENTER, which is
 * what the drag reads as "where the user is pointing". The topmost (= last in
 * paint order, here: highest db id) hit wins; a hit on the source region is
 * `same`; a hit on any other region kind is only a valid target when it's
 * `custom`. Top-level notes and pinned cards are deliberately NOT hit-tested:
 * they aren't containers, so landing on one means "place the card here,
 * overlapping" — the same as open canvas.
 */
export function classifyDrop(
  pos: { x: number; y: number },
  regions: RegionRect[],
  sourceRegionId: number
): CanvasDrop {
  const cx = pos.x + CARD_WIDTH / 2
  const cy = pos.y + CARD_HEIGHT / 2
  let hit: RegionRect | null = null
  for (const r of regions) {
    if (cx < r.x || cx > r.x + r.width || cy < r.y || cy > r.y + r.height) {
      continue
    }
    if (!hit || r.dbId > hit.dbId) hit = r
  }
  if (!hit) return { type: "canvas", x: pos.x, y: pos.y }
  if (hit.dbId === sourceRegionId) return { type: "same" }
  if (hit.kind === "custom") return { type: "custom", regionId: hit.dbId }
  return { type: "invalid" }
}

/**
 * Shelf-packing auto-arrange: sort by height (regions first, tallest first),
 * fill left-to-right shelves up to a target row width, top-align each shelf.
 * Returns only the nodes that actually move.
 */
export function packLayout(
  nodes: CanvasNode[],
  renderedHeights: ReadonlyMap<number, number>,
  opts: { gap?: number; rowWidth?: number } = {}
): CanvasNodeMovePayload[] {
  const gap = opts.gap ?? 48
  const rowWidth = opts.rowWidth ?? 2400
  const sorted = [...nodes].sort((a, b) => {
    const ha = renderedHeights.get(a.id) ?? a.height
    const hb = renderedHeights.get(b.id) ?? b.height
    if (ha !== hb) return hb - ha
    return a.id - b.id
  })
  const moves: CanvasNodeMovePayload[] = []
  let shelfX = 0
  let shelfY = 0
  let shelfHeight = 0
  for (const node of sorted) {
    const h = renderedHeights.get(node.id) ?? node.height
    if (shelfX > 0 && shelfX + node.width > rowWidth) {
      shelfY += shelfHeight + gap
      shelfX = 0
      shelfHeight = 0
    }
    if (node.x !== shelfX || node.y !== shelfY) {
      moves.push({ id: node.id, x: shelfX, y: shelfY })
    }
    shelfX += node.width + gap
    shelfHeight = Math.max(shelfHeight, h)
  }
  return moves
}

// ─── ReactFlow graph derivation ───

export interface RegionNodeData {
  dbNode: CanvasNode
  /** Total members the region resolves to (visible cards may be capped). */
  memberTotal: number
  /** Members currently `in_progress` — the header's running badge. */
  runningCount: number
  unresolved: boolean
  /** The height the region actually renders at (grid growth / collapse). */
  renderedHeight: number
  [key: string]: unknown
}

export interface ConversationCardData {
  conversation: DbConversationSummary | null
  conversationId: number
  /** Set on derived member cards: the region that owns the grid slot. */
  regionDbId?: number
  /** Set on top-level pinned cards: the backing DB row id. */
  pinDbId?: number
  unresolved: boolean
  [key: string]: unknown
}

export interface NoteNodeData {
  dbNode: CanvasNode
  [key: string]: unknown
}

/** ReactFlow-compatible node shape (structurally a subset of RF's `Node`,
 *  kept RF-import-free so the derivation stays a plain testable function). */
export interface CanvasFlowNode {
  id: string
  type: "region" | "conversationCard" | "note"
  position: { x: number; y: number }
  parentId?: string
  data: RegionNodeData | ConversationCardData | NoteNodeData
  width?: number
  height?: number
  draggable?: boolean
  selectable?: boolean
}

export interface DeriveFlowInput {
  dbNodes: Iterable<CanvasNode>
  conversations: DbConversationSummary[]
  allFolders: FolderDetail[]
  /** Regions whose "+N" expander is open (UI state, never persisted). */
  expandedRegions: ReadonlySet<number>
  /**
   * Transient drag positions keyed by RF node id — the dragged node's position
   * is ALWAYS taken from here while a drag is live, so remote updates cannot
   * yank the card out from under the pointer. Member positions are relative to
   * their region (RF child-node semantics), top-level ones absolute.
   */
  overlay: ReadonlyMap<string, { x: number; y: number }>
  /**
   * Member snapshot taken at drag start, per region: while a member card is
   * dragging, its region's grid is laid out from this frozen list so a remote
   * membership change cannot reflow the grid mid-drag (the store still
   * updates; the reflow lands at drag stop when the freeze clears).
   */
  frozenMembers: ReadonlyMap<number, number[]> | null
  /**
   * Transient resize dimensions keyed by RF node id (NodeResizer feed). Like
   * `overlay`, wins over stored width/height while the handles are live;
   * cleared by the resize-end commit.
   */
  sizeOverlay?: ReadonlyMap<string, { width: number; height: number }>
}

export interface DeriveFlowResult {
  nodes: CanvasFlowNode[]
  /** Absolute region rects for drop classification, in derive order. */
  regionRects: {
    dbId: number
    kind: CanvasNode["kind"]
    x: number
    y: number
    width: number
    height: number
  }[]
  /** Rendered (not stored) heights, for shelf packing. */
  renderedHeights: Map<number, number>
}

/**
 * DB nodes + live workspace state → the full RF node array. Output order is
 * regions/notes/pins by ascending db id, then member cards — RF requires a
 * parent before its children, and ascending id doubles as the paint order that
 * `classifyDrop` mirrors (highest id wins a hit).
 */
export function deriveFlowGraph(input: DeriveFlowInput): DeriveFlowResult {
  const {
    dbNodes,
    conversations,
    allFolders,
    expandedRegions,
    overlay,
    frozenMembers,
    sizeOverlay,
  } = input
  const conversationsById = new Map(conversations.map((c) => [c.id, c]))
  const foldersById = new Map(allFolders.map((f) => [f.id, f]))

  const sorted = [...dbNodes].sort((a, b) => a.id - b.id)
  const topNodes: CanvasFlowNode[] = []
  const memberNodes: CanvasFlowNode[] = []
  const regionRects: DeriveFlowResult["regionRects"] = []
  const renderedHeights = new Map<number, number>()

  for (const dbNode of sorted) {
    const rfId = regionNodeId(dbNode.id)
    const dragPos = overlay.get(rfId)
    const position = dragPos ?? { x: dbNode.x, y: dbNode.y }
    const liveSize = sizeOverlay?.get(rfId)

    if (dbNode.kind === "note") {
      const width = liveSize?.width ?? dbNode.width
      const height = liveSize?.height ?? dbNode.height
      renderedHeights.set(dbNode.id, height)
      topNodes.push({
        id: rfId,
        type: "note",
        position,
        width,
        height,
        data: { dbNode } satisfies NoteNodeData,
      })
      continue
    }

    if (dbNode.kind === "conversation") {
      const conversation =
        dbNode.conversation_id != null
          ? (conversationsById.get(dbNode.conversation_id) ?? null)
          : null
      renderedHeights.set(dbNode.id, CARD_HEIGHT)
      topNodes.push({
        id: rfId,
        type: "conversationCard",
        position,
        width: CARD_WIDTH,
        height: CARD_HEIGHT,
        data: {
          conversation,
          conversationId: dbNode.conversation_id ?? -1,
          pinDbId: dbNode.id,
          unresolved: isUnresolvedBinding(
            dbNode,
            conversationsById,
            foldersById
          ),
        } satisfies ConversationCardData,
      })
      continue
    }

    // Region kinds: folder / agent / custom.
    const unresolved = isUnresolvedBinding(
      dbNode,
      conversationsById,
      foldersById
    )
    const frozen = frozenMembers?.get(dbNode.id)
    // An unresolved binding shows the hint state, never cards — stale member
    // rows would paint right over it.
    const members = unresolved
      ? []
      : frozen
        ? frozen
            .map((id) => conversationsById.get(id))
            .filter((c): c is DbConversationSummary => c != null)
        : computeRegionMembers(dbNode, conversations, allFolders)
    const expanded = expandedRegions.has(dbNode.id)
    const visible =
      expanded || dbNode.collapsed
        ? members
        : members.slice(0, MAX_VISIBLE_MEMBERS)
    const shown = dbNode.collapsed ? [] : visible
    const regionWidth = liveSize?.width ?? dbNode.width
    const grid = layoutRegionGrid(shown.length, regionWidth)
    // The "+N" expander floats along the bottom edge; reserve a row of chrome
    // for it so it never overlaps the last card row.
    const expanderPad =
      !dbNode.collapsed && !expanded && members.length > MAX_VISIBLE_MEMBERS
        ? 36
        : 0
    const renderedHeight = dbNode.collapsed
      ? REGION_COLLAPSED_HEIGHT
      : Math.max(
          liveSize?.height ?? dbNode.height,
          grid.contentHeight + expanderPad
        )
    renderedHeights.set(dbNode.id, renderedHeight)

    let runningCount = 0
    for (const m of members) {
      if (m.status === "in_progress") runningCount++
    }

    topNodes.push({
      id: rfId,
      type: "region",
      position,
      width: regionWidth,
      height: renderedHeight,
      data: {
        dbNode,
        memberTotal: members.length,
        runningCount,
        unresolved,
        renderedHeight,
      } satisfies RegionNodeData,
    })
    regionRects.push({
      dbId: dbNode.id,
      kind: dbNode.kind,
      x: position.x,
      y: position.y,
      width: regionWidth,
      height: renderedHeight,
    })

    for (let i = 0; i < shown.length; i++) {
      const conversation = shown[i]
      const mid = memberNodeId(dbNode.id, conversation.id)
      const dragged = overlay.get(mid)
      memberNodes.push({
        id: mid,
        type: "conversationCard",
        position: dragged ?? grid.positions[i],
        parentId: rfId,
        width: CARD_WIDTH,
        height: CARD_HEIGHT,
        data: {
          conversation,
          conversationId: conversation.id,
          regionDbId: dbNode.id,
          unresolved: false,
        } satisfies ConversationCardData,
      })
    }
  }

  return { nodes: [...topNodes, ...memberNodes], regionRects, renderedHeights }
}

/** Seed layout for the empty-canvas CTA: one folder region per open workspace
 *  folder, shelf-packed with a uniform footprint. */
export function seedRegionsFromFolders(
  folders: FolderDetail[]
): { folderId: number; x: number; y: number; width: number; height: number }[] {
  const width = 3 * CARD_WIDTH + 2 * CARD_GAP + 2 * REGION_PADDING
  const height =
    REGION_HEADER_HEIGHT + 2 * REGION_PADDING + 2 * CARD_HEIGHT + CARD_GAP
  const perRow = 2
  return folders.map((f, i) => ({
    folderId: f.id,
    x: (i % perRow) * (width + 48),
    y: Math.floor(i / perRow) * (height + 48),
    width,
    height,
  }))
}
