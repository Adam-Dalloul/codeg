import { describe, expect, it } from "vitest"
import type {
  CanvasNode,
  DbConversationSummary,
  FolderDetail,
} from "@/lib/types"
import {
  CARD_GAP,
  CARD_HEIGHT,
  CARD_WIDTH,
  MAX_VISIBLE_MEMBERS,
  REGION_COLLAPSED_HEIGHT,
  REGION_HEADER_HEIGHT,
  REGION_PADDING,
  classifyDrop,
  compareByRecency,
  computeRegionMembers,
  deriveFlowGraph,
  layoutRegionGrid,
  memberNodeId,
  packLayout,
  parseMemberNodeId,
  parseRegionNodeId,
  regionNodeId,
  type ConversationCardData,
  type RegionNodeData,
} from "./canvas-model"

function conv(
  id: number,
  over: Partial<DbConversationSummary> = {}
): DbConversationSummary {
  return {
    id,
    folder_id: 1,
    title: `conv ${id}`,
    title_locked: false,
    agent_type: "claude_code",
    status: "completed",
    kind: "regular",
    model: null,
    git_branch: null,
    external_id: null,
    message_count: 1,
    child_count: 0,
    created_at: "2026-08-30T00:00:00Z",
    updated_at: "2026-08-30T10:00:00Z",
    pinned_at: null,
    ...over,
  }
}

function folder(id: number, over: Partial<FolderDetail> = {}): FolderDetail {
  return {
    id,
    name: `folder-${id}`,
    path: `/tmp/folder-${id}`,
    git_branch: null,
    default_agent_type: null,
    last_opened_at: "2026-08-30T00:00:00Z",
    sort_order: id,
    color: "inherit",
    parent_id: null,
    kind: "regular",
    alias: null,
    ...over,
  } as FolderDetail
}

function node(id: number, over: Partial<CanvasNode> = {}): CanvasNode {
  return {
    id,
    kind: "custom",
    folder_id: null,
    agent_type: null,
    conversation_id: null,
    member_ids: [],
    title: null,
    content: null,
    color: null,
    collapsed: false,
    x: 0,
    y: 0,
    width: 720,
    height: 344,
    created_at: "2026-08-30T00:00:00Z",
    updated_at: "2026-08-30T00:00:00Z",
    ...over,
  }
}

const NO_DRAG = {
  expandedRegions: new Set<number>(),
  overlay: new Map<string, { x: number; y: number }>(),
  frozenMembers: null,
}

describe("node id codecs", () => {
  it("round-trips region and member ids", () => {
    expect(parseRegionNodeId(regionNodeId(42))).toBe(42)
    expect(parseMemberNodeId(memberNodeId(3, 99))).toEqual({
      regionDbId: 3,
      conversationId: 99,
    })
    expect(parseRegionNodeId("member-3-99")).toBeNull()
    expect(parseMemberNodeId("region-42")).toBeNull()
  })
})

describe("computeRegionMembers", () => {
  it("folder regions merge the bound folder with its direct worktree children", () => {
    const folders = [
      folder(1),
      folder(2, { parent_id: 1 }), // direct worktree child → merged
      folder(3, { parent_id: 2 }), // flattened parent_id points at 1 in prod;
      // here it points elsewhere, so it must NOT be merged
    ]
    const conversations = [
      conv(10, { folder_id: 1 }),
      conv(11, { folder_id: 2 }),
      conv(12, { folder_id: 3 }),
    ]
    const members = computeRegionMembers(
      node(1, { kind: "folder", folder_id: 1 }),
      conversations,
      folders
    )
    expect(members.map((m) => m.id).sort()).toEqual([10, 11])
  })

  it("a region bound to a worktree child shows only that child", () => {
    const folders = [folder(1), folder(2, { parent_id: 1 })]
    const conversations = [
      conv(10, { folder_id: 1 }),
      conv(11, { folder_id: 2 }),
    ]
    const members = computeRegionMembers(
      node(1, { kind: "folder", folder_id: 2 }),
      conversations,
      folders
    )
    expect(members.map((m) => m.id)).toEqual([11])
  })

  it("excludes delegation children and loop rows everywhere", () => {
    const conversations = [
      conv(10),
      conv(11, { kind: "delegate" }),
      conv(12, { kind: "loop" }),
      conv(13, { parent_id: 10 }),
    ]
    const members = computeRegionMembers(
      node(1, { kind: "agent", agent_type: "claude_code" }),
      conversations,
      [folder(1)]
    )
    expect(members.map((m) => m.id)).toEqual([10])
  })

  it("custom regions resolve pinned ids and drop stale ones, recency-sorted", () => {
    const conversations = [
      conv(10, { updated_at: "2026-08-30T09:00:00Z" }),
      conv(11, { updated_at: "2026-08-30T11:00:00Z" }),
    ]
    const members = computeRegionMembers(
      node(1, { kind: "custom", member_ids: [10, 999, 11] }),
      conversations,
      []
    )
    expect(members.map((m) => m.id)).toEqual([11, 10])
  })

  it("orders by (updated_at desc, id desc) — id breaks timestamp ties", () => {
    const same = "2026-08-30T10:00:00Z"
    const list = [conv(1, { updated_at: same }), conv(2, { updated_at: same })]
    expect([...list].sort(compareByRecency).map((c) => c.id)).toEqual([2, 1])
  })
})

describe("layoutRegionGrid", () => {
  it("computes columns from the region width and wraps rows", () => {
    // 720 wide → usable 696 → floor((696+12)/236) = 3 columns.
    const grid = layoutRegionGrid(5, 720)
    expect(grid.columns).toBe(3)
    expect(grid.positions[0]).toEqual({
      x: REGION_PADDING,
      y: REGION_HEADER_HEIGHT + REGION_PADDING,
    })
    expect(grid.positions[3].y).toBe(
      REGION_HEADER_HEIGHT + REGION_PADDING + CARD_HEIGHT + CARD_GAP
    )
    expect(grid.contentHeight).toBe(
      REGION_HEADER_HEIGHT + 2 * REGION_PADDING + 2 * CARD_HEIGHT + CARD_GAP
    )
  })

  it("never returns fewer than one column", () => {
    expect(layoutRegionGrid(2, 10).columns).toBe(1)
  })
})

describe("classifyDrop", () => {
  const regions = [
    { dbId: 1, kind: "custom" as const, x: 0, y: 0, width: 400, height: 300 },
    { dbId: 2, kind: "folder" as const, x: 600, y: 0, width: 400, height: 300 },
    // Overlaps region 1; higher id = painted on top, must win the hit.
    { dbId: 3, kind: "custom" as const, x: 200, y: 0, width: 400, height: 300 },
  ]

  it("open canvas → detach at the drop point", () => {
    expect(classifyDrop({ x: 1500, y: 800 }, regions, 1)).toEqual({
      type: "canvas",
      x: 1500,
      y: 800,
    })
  })

  it("hit on the source region → same (snap back)", () => {
    // Card center at (112+66, 66+50) inside region 1 only.
    expect(classifyDrop({ x: -50, y: 20 }, regions, 1)).toEqual({
      type: "same",
    })
  })

  it("hit on another custom region → copy target; topmost id wins overlap", () => {
    // Center lands where regions 1 and 3 overlap → 3 wins.
    const drop = classifyDrop({ x: 200, y: 50 }, regions, 1)
    expect(drop).toEqual({ type: "custom", regionId: 3 })
  })

  it("hit on a binding region → invalid (bindings are computed, not curated)", () => {
    expect(classifyDrop({ x: 700, y: 50 }, regions, 1)).toEqual({
      type: "invalid",
    })
  })
})

describe("packLayout", () => {
  it("shelves nodes tallest-first and only reports actual moves", () => {
    const a = node(1, { x: 0, y: 0, width: 1000, height: 600 })
    const b = node(2, { x: 999, y: 999, width: 1000, height: 300 })
    const c = node(3, { x: 0, y: 0, width: 1000, height: 200 })
    const moves = packLayout([a, b, c], new Map(), { gap: 50, rowWidth: 2200 })
    // a stays at (0,0) → not reported; b beside it; c wraps to a new shelf.
    expect(moves).toEqual([
      { id: 2, x: 1050, y: 0 },
      { id: 3, x: 0, y: 650 },
    ])
  })

  it("prefers rendered heights over stored ones", () => {
    const a = node(1, { width: 100, height: 100 })
    const b = node(2, { x: 500, y: 500, width: 100, height: 400 })
    // Rendered: a is actually taller → a leads the shelf order.
    const moves = packLayout(
      [a, b],
      new Map([
        [1, 800],
        [2, 100],
      ]),
      { gap: 10, rowWidth: 1000 }
    )
    expect(moves).toEqual([{ id: 2, x: 110, y: 0 }])
  })
})

describe("deriveFlowGraph", () => {
  const folders = [folder(1)]
  const conversations = [
    conv(10, { status: "in_progress", updated_at: "2026-08-30T12:00:00Z" }),
    conv(11, { updated_at: "2026-08-30T11:00:00Z" }),
  ]

  it("emits regions before member cards, members parented and grid-placed", () => {
    const region = node(1, { kind: "folder", folder_id: 1 })
    const { nodes } = deriveFlowGraph({
      dbNodes: [region],
      conversations,
      allFolders: folders,
      ...NO_DRAG,
    })
    expect(nodes.map((n) => n.type)).toEqual([
      "region",
      "conversationCard",
      "conversationCard",
    ])
    const member = nodes[1]
    expect(member.parentId).toBe(regionNodeId(1))
    expect(member.position).toEqual({
      x: REGION_PADDING,
      y: REGION_HEADER_HEIGHT + REGION_PADDING,
    })
    // Recency order: the in-progress conv 10 was updated later → first slot.
    expect((member.data as ConversationCardData).conversationId).toBe(10)
    const regionData = nodes[0].data as RegionNodeData
    expect(regionData.runningCount).toBe(1)
    expect(regionData.memberTotal).toBe(2)
  })

  it("drag overlay wins over stored/grid positions", () => {
    const region = node(1, { kind: "folder", folder_id: 1, x: 100, y: 100 })
    const overlay = new Map([
      [regionNodeId(1), { x: 500, y: 600 }],
      [memberNodeId(1, 10), { x: 42, y: 43 }],
    ])
    const { nodes, regionRects } = deriveFlowGraph({
      dbNodes: [region],
      conversations,
      allFolders: folders,
      expandedRegions: new Set(),
      overlay,
      frozenMembers: null,
    })
    expect(nodes[0].position).toEqual({ x: 500, y: 600 })
    expect(regionRects[0]).toMatchObject({ x: 500, y: 600 })
    const dragged = nodes.find((n) => n.id === memberNodeId(1, 10))!
    expect(dragged.position).toEqual({ x: 42, y: 43 })
  })

  it("frozen member lists override the live computation while dragging", () => {
    const region = node(1, { kind: "folder", folder_id: 1 })
    const { nodes } = deriveFlowGraph({
      dbNodes: [region],
      conversations,
      allFolders: folders,
      expandedRegions: new Set(),
      overlay: new Map(),
      // Snapshot from drag start: only conv 11 (10 arrived remotely since).
      frozenMembers: new Map([[1, [11]]]),
    })
    const members = nodes.filter((n) => n.type === "conversationCard")
    expect(
      members.map((n) => (n.data as ConversationCardData).conversationId)
    ).toEqual([11])
  })

  it("collapsed regions render as a capsule with no member cards", () => {
    const region = node(1, { kind: "folder", folder_id: 1, collapsed: true })
    const { nodes, renderedHeights } = deriveFlowGraph({
      dbNodes: [region],
      conversations,
      allFolders: folders,
      ...NO_DRAG,
    })
    expect(nodes).toHaveLength(1)
    expect(renderedHeights.get(1)).toBe(REGION_COLLAPSED_HEIGHT)
  })

  it("caps visible members at MAX_VISIBLE_MEMBERS until expanded", () => {
    const many = Array.from({ length: MAX_VISIBLE_MEMBERS + 5 }, (_, i) =>
      conv(100 + i)
    )
    const region = node(1, { kind: "agent", agent_type: "claude_code" })
    const capped = deriveFlowGraph({
      dbNodes: [region],
      conversations: many,
      allFolders: [],
      ...NO_DRAG,
    })
    expect(
      capped.nodes.filter((n) => n.type === "conversationCard")
    ).toHaveLength(MAX_VISIBLE_MEMBERS)

    const expanded = deriveFlowGraph({
      dbNodes: [region],
      conversations: many,
      allFolders: [],
      expandedRegions: new Set([1]),
      overlay: new Map(),
      frozenMembers: null,
    })
    expect(
      expanded.nodes.filter((n) => n.type === "conversationCard")
    ).toHaveLength(MAX_VISIBLE_MEMBERS + 5)
  })

  it("marks unresolved bindings (missing folder / missing conversation)", () => {
    const ghostFolder = node(1, { kind: "folder", folder_id: 404 })
    const ghostPin = node(2, {
      kind: "conversation",
      conversation_id: 404,
      x: 900,
    })
    const { nodes } = deriveFlowGraph({
      dbNodes: [ghostFolder, ghostPin],
      conversations,
      allFolders: folders,
      ...NO_DRAG,
    })
    expect((nodes[0].data as RegionNodeData).unresolved).toBe(true)
    const pin = nodes[1].data as ConversationCardData
    expect(pin.unresolved).toBe(true)
    expect(pin.conversation).toBeNull()
    expect(pin.pinDbId).toBe(2)
  })

  it("unresolved regions emit NO member cards (the hint state owns the body)", () => {
    // Folder 1 is gone from the store but its conversations linger (e.g. a
    // just-closed folder mid-refetch): the region must not paint cards over
    // its unresolved hint.
    const region = node(1, { kind: "folder", folder_id: 1 })
    const { nodes } = deriveFlowGraph({
      dbNodes: [region],
      conversations,
      allFolders: [],
      ...NO_DRAG,
    })
    expect(nodes).toHaveLength(1)
    const data = nodes[0].data as RegionNodeData
    expect(data.unresolved).toBe(true)
    expect(data.memberTotal).toBe(0)
  })

  it("custom members are re-checked for canvas eligibility on read", () => {
    const region = node(1, { kind: "custom", member_ids: [10, 50] })
    const { nodes } = deriveFlowGraph({
      dbNodes: [region],
      conversations: [conv(10), conv(50, { kind: "delegate" })],
      allFolders: [],
      ...NO_DRAG,
    })
    const members = nodes.filter((n) => n.type === "conversationCard")
    expect(
      members.map((n) => (n.data as ConversationCardData).conversationId)
    ).toEqual([10])
  })

  it("live resize dimensions override stored geometry and reflow the grid", () => {
    // Stored 3-column region resized down to one column width mid-gesture.
    const region = node(1, { kind: "folder", folder_id: 1 })
    const { nodes, regionRects } = deriveFlowGraph({
      dbNodes: [region],
      conversations,
      allFolders: folders,
      expandedRegions: new Set(),
      overlay: new Map(),
      frozenMembers: null,
      sizeOverlay: new Map([[regionNodeId(1), { width: 280, height: 600 }]]),
    })
    expect(nodes[0].width).toBe(280)
    expect(regionRects[0].width).toBe(280)
    // 280 wide → 1 column → second member wraps to the next row.
    const second = nodes[2]
    expect(second.position.x).toBe(REGION_PADDING)
    expect(second.position.y).toBe(
      REGION_HEADER_HEIGHT + REGION_PADDING + CARD_HEIGHT + CARD_GAP
    )
  })

  it("pinned conversation cards use the fixed card footprint", () => {
    const pin = node(2, { kind: "conversation", conversation_id: 10 })
    const { nodes } = deriveFlowGraph({
      dbNodes: [pin],
      conversations,
      allFolders: folders,
      ...NO_DRAG,
    })
    expect(nodes[0].width).toBe(CARD_WIDTH)
    expect(nodes[0].height).toBe(CARD_HEIGHT)
    expect((nodes[0].data as ConversationCardData).conversation?.id).toBe(10)
  })
})
