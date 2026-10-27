import { beforeEach, describe, expect, it, vi } from "vitest"
import {
  useWorkbenchStore,
  resetWorkbenchStore,
  shouldSeedConversation,
} from "./workbench-store"
import { resetTabStore, useTabStore } from "./tab-store"
import {
  resetAppWorkspaceStore,
  useAppWorkspaceStore,
} from "./app-workspace-store"
import * as api from "@/lib/api"
import type { FolderDetail, TabsChanged } from "@/lib/types"

vi.mock("@/lib/api", () => ({
  listOpenedTabs: vi.fn(),
  saveOpenedTabs: vi.fn(),
  getFolderConversation: vi.fn(),
}))

beforeEach(() => {
  resetWorkbenchStore()
  resetTabStore()
  resetAppWorkspaceStore()
  localStorage.clear()
  const folders = [1, 2, 3].map((id) => ({
    id,
    path: `/repo${id}`,
    name: `repo${id}`,
  })) as FolderDetail[]
  useAppWorkspaceStore.setState({
    folders,
    allFolders: folders,
    foldersHydrated: true,
  })
})

function open(folderId: number, id: number, pin = true) {
  useTabStore.getState().openTab(folderId, id, "claude_code", pin)
  return useTabStore.getState().activeTabId!
}

function visibleIds() {
  const { enabled, scope } = useWorkbenchStore.getState()
  return useTabStore
    .getState()
    .rawTabs.filter((tab) => !enabled || tab.folderId === scope)
    .map((tab) => tab.id)
}

describe("Workbench conversation scope", () => {
  it.each([0, 1, 2, 99])(
    "maps a cross-group drop at visible index %s without counting hidden members",
    (index) => {
      const a1 = open(1, 11)
      const b1 = open(2, 21)
      const a2 = open(1, 12)
      const b2 = open(2, 22)
      const a3 = open(1, 13)
      const b0 = open(2, 20)
      const sourceSibling = open(2, 23)
      useTabStore.setState({
        groupLayout: {
          type: "split",
          id: "split",
          orientation: "horizontal",
          ratios: [0.5, 0.5],
          children: [
            { type: "group", id: "source" },
            { type: "group", id: "target" },
          ],
        },
        groupOf: {
          [a1]: "target",
          [b1]: "target",
          [a2]: "target",
          [b2]: "target",
          [a3]: "target",
          [b0]: "source",
          [sourceSibling]: "source",
        },
      })
      useWorkbenchStore.getState().setEnabled(true)
      useWorkbenchStore.getState().activateScope(2)
      useTabStore.getState().moveTabToGroup(b0, "target", { index })
      const state = useTabStore.getState()
      const target = state.rawTabs.filter(
        (tab) => state.groupOf[tab.id] === "target"
      )
      const visible = [b1, b2]
      visible.splice(Math.min(index, 2), 0, b0)
      expect(
        target.filter((tab) => tab.folderId === 2).map((tab) => tab.id)
      ).toEqual(visible)
      expect(
        target.filter((tab) => tab.folderId === 1).map((tab) => tab.id)
      ).toEqual([a1, a2, a3])
      expect(
        state.rawTabs
          .filter((tab) => state.groupOf[tab.id] === "source")
          .map((tab) => tab.id)
      ).toEqual([sourceSibling])
    }
  )

  it("restores A → B → A selection, including an empty folder, and exposes all tabs on disable", () => {
    const a1 = open(1, 11)
    const a2 = open(1, 12)
    const b1 = open(2, 21)
    useWorkbenchStore.getState().setEnabled(true)
    useWorkbenchStore.getState().activateScope(1)
    useTabStore.getState().switchTab(a2)
    useWorkbenchStore.getState().activateScope(2)
    expect(useTabStore.getState().activeTabId).toBe(b1)
    useWorkbenchStore.getState().activateScope(3)
    expect(useTabStore.getState().activeTabId).toBeNull()
    expect(useAppWorkspaceStore.getState().activeFolderId).toBe(3)
    expect(useTabStore.getState().rawTabs).toHaveLength(3)
    useWorkbenchStore.getState().activateScope(1)
    expect(useTabStore.getState().activeTabId).toBe(a2)
    expect(visibleIds()).toEqual([a1, a2])
    useWorkbenchStore.getState().setEnabled(false)
    expect(visibleIds()).toEqual([a1, a2, b1])
  })

  it("keeps inactive previews and drafts when opening, reordering and closing visible tabs", () => {
    useWorkbenchStore.getState().setEnabled(true)
    const a = open(1, 11, false)
    const draftA = useTabStore.getState().openNewConversationTab(1, "/repo1")
    const b = open(2, 21, false)
    const draftB = useTabStore.getState().openNewConversationTab(2, "/repo2")
    expect(draftA.tabId).not.toBe(draftB.tabId)
    expect(
      useTabStore.getState().rawTabs.find((tab) => tab.id === draftA.tabId)
        ?.folderId
    ).toBe(1)
    expect(useTabStore.getState().rawTabs.some((tab) => tab.id === a)).toBe(
      true
    )
    const visible = useTabStore
      .getState()
      .tabs.filter((tab) => tab.folderId === 2)
    useTabStore.getState().reorderTabs([...visible].reverse())
    expect(
      useTabStore
        .getState()
        .rawTabs.slice(0, 2)
        .map((tab) => tab.id)
    ).toEqual([a, draftA.tabId])
    useTabStore.getState().closeOtherTabs(b)
    expect(useTabStore.getState().rawTabs.map((tab) => tab.id)).toEqual([
      a,
      draftA.tabId,
      b,
    ])
    useTabStore.getState().closeAllTabs()
    expect(useTabStore.getState().rawTabs.map((tab) => tab.id)).toEqual([
      a,
      draftA.tabId,
    ])
    expect(useTabStore.getState().activeTabId).toBeNull()
    expect(useWorkbenchStore.getState().scope).toBe(2)
  })

  it("opening or focusing a session activates its own worktree", () => {
    const a = open(1, 11)
    useWorkbenchStore.getState().setEnabled(true)
    open(2, 21)
    expect(useWorkbenchStore.getState().scope).toBe(2)
    useTabStore.getState().switchTab(a)
    expect(useWorkbenchStore.getState().scope).toBe(1)
    expect(useAppWorkspaceStore.getState().activeFolderId).toBe(1)
  })

  it("preserves local scope and selection while reconciling complete server snapshots", async () => {
    const a = open(1, 11)
    open(2, 21)
    useWorkbenchStore.getState().setEnabled(true)
    useWorkbenchStore.getState().activateScope(1)
    const items = [
      {
        folder_id: 1,
        conversation_id: 11,
        agent_type: "claude_code",
        is_pinned: true,
        is_active: false,
        position: 0,
      },
      {
        folder_id: 2,
        conversation_id: 21,
        agent_type: "claude_code",
        is_pinned: true,
        is_active: true,
        position: 1,
      },
    ]
    items.push({
      folder_id: 3,
      conversation_id: 31,
      agent_type: "claude_code",
      is_pinned: true,
      is_active: false,
      position: 2,
    })
    useTabStore.setState({ tabsHydrated: true })
    vi.mocked(api.listOpenedTabs).mockResolvedValue({
      version: 1,
      items,
    } as never)
    await useTabStore.getState().refetchTabs()
    expect(useWorkbenchStore.getState().scope).toBe(1)
    expect(useTabStore.getState().activeTabId).toBe(a)
    expect(useTabStore.getState().rawTabs).toHaveLength(3)
    // A subsequent remote activation must also leave this client's scope alone.
    useTabStore
      .getState()
      .handleTabsChanged({ version: 2, tabs: items } as TabsChanged)
    expect(useTabStore.getState().activeTabId).toBe(a)
    expect(useTabStore.getState().rawTabs).toHaveLength(3)
  })

  it("persists the complete conversation set while a worktree is hidden", async () => {
    vi.useFakeTimers()
    try {
      open(1, 11)
      open(2, 21)
      useWorkbenchStore.getState().setEnabled(true)
      useWorkbenchStore.getState().activateScope(1)
      useTabStore.setState({ tabsHydrated: true })
      vi.mocked(api.saveOpenedTabs).mockResolvedValue({
        accepted: true,
        version: 1,
        tabs: [],
      })
      useTabStore.getState().runSaveEffect()
      await vi.advanceTimersByTimeAsync(500)
      expect(
        vi
          .mocked(api.saveOpenedTabs)
          .mock.lastCall?.[0].map((item) => item.folder_id)
      ).toEqual([1, 2])
    } finally {
      useTabStore.getState().clearSaveTimer()
      vi.useRealTimers()
    }
  })

  it("keeps an empty selected worktree empty through remote snapshots and refetch", async () => {
    open(1, 11)
    useTabStore.setState({ tabsHydrated: true })
    useWorkbenchStore.getState().setEnabled(true)
    useWorkbenchStore.getState().activateScope(1)
    useTabStore.getState().closeAllTabs()
    useWorkbenchStore.getState().activateScope(3)
    useTabStore
      .getState()
      .handleTabsChanged({ version: 1, origin: "remote", tabs: [] })
    expect(useTabStore.getState().rawTabs).toEqual([])
    vi.mocked(api.listOpenedTabs).mockResolvedValue({ version: 2, items: [] })
    await useTabStore.getState().refetchTabs()
    expect(useTabStore.getState().rawTabs).toEqual([])
    expect(useTabStore.getState().activeTabId).toBeNull()
    expect(useAppWorkspaceStore.getState().activeFolderId).toBe(3)
  })

  it("allows automatic empty-state drafts only in ordinary mode", () => {
    expect(shouldSeedConversation(true, true)).toBe(false)
    expect(shouldSeedConversation(true, false)).toBe(false)
    expect(shouldSeedConversation(false, true)).toBe(true)
    expect(shouldSeedConversation(false, false)).toBe(false)
  })

  it("defaults off and tolerates denied preference storage", () => {
    expect(useWorkbenchStore.getState().enabled).toBe(false)
    const get = vi
      .spyOn(Storage.prototype, "getItem")
      .mockImplementation(() => {
        throw new Error("denied")
      })
    const set = vi
      .spyOn(Storage.prototype, "setItem")
      .mockImplementation(() => {
        throw new Error("denied")
      })
    expect(() => useWorkbenchStore.getState().hydratePreference()).not.toThrow()
    expect(() => useWorkbenchStore.getState().setEnabled(true)).not.toThrow()
    expect(useWorkbenchStore.getState().enabled).toBe(true)
    get.mockRestore()
    set.mockRestore()
  })
})

describe("Workbench scope repairs", () => {
  function setFolders(
    list: Array<{ id: number; parent_id?: number; kind?: string }>
  ) {
    const all = list.map(({ id, parent_id = null, kind = "folder" }) => ({
      id,
      path: `/repo${id}`,
      name: `repo${id}`,
      parent_id,
      kind,
    })) as unknown as FolderDetail[]
    useAppWorkspaceStore.setState({
      folders: all.filter((f) => f.kind !== "chat"),
      allFolders: all,
      foldersHydrated: true,
    })
  }
  // TabProvider re-syncs the active folder after every tab write.
  function sync() {
    useTabStore.getState().syncActiveFolderId()
  }

  it("turning the mode back on keeps the tab the user is on", () => {
    const a1 = open(1, 11)
    const a2 = open(1, 12)
    open(2, 21)
    useTabStore.getState().switchTab(a1)
    sync()
    useWorkbenchStore.getState().setEnabled(true)
    useWorkbenchStore.getState().activateScope(2)
    useWorkbenchStore.getState().setEnabled(false)
    useTabStore.getState().switchTab(a2)
    sync()
    useWorkbenchStore.getState().setEnabled(true)
    expect(useWorkbenchStore.getState().scope).toBe(1)
    expect(useTabStore.getState().activeTabId).toBe(a2)
  })

  it("turning the mode on keeps each split group's pick", () => {
    const a1 = open(1, 11)
    const a2 = open(1, 12)
    const a3 = open(1, 13)
    useTabStore.setState({
      groupLayout: {
        type: "split",
        id: "split",
        orientation: "horizontal",
        ratios: [0.5, 0.5],
        children: [
          { type: "group", id: "g1" },
          { type: "group", id: "g2" },
        ],
      },
      groupOf: { [a1]: "g1", [a2]: "g2", [a3]: "g2" },
      groupSelection: { g1: a1, g2: a3 },
      activeTabId: a1,
    })
    sync()
    useWorkbenchStore.getState().setEnabled(true)
    expect(useTabStore.getState().activeTabId).toBe(a1)
    expect(useTabStore.getState().groupSelection).toEqual({ g1: a1, g2: a3 })
  })

  it("keeps a chat conversation's hidden chat folder active in the global scope", () => {
    setFolders([{ id: 1 }, { id: 9, kind: "chat" }])
    open(1, 11)
    useWorkbenchStore.getState().setEnabled(true)
    open(9, 91)
    sync()
    expect(useWorkbenchStore.getState().scope).toBe("global")
    expect(useAppWorkspaceStore.getState().activeFolderId).toBe(9)
    // Re-selecting the already-active chat changes no tab, so nothing would
    // re-sync a wrong value: the scope switch itself must not clear it.
    open(9, 91)
    expect(useAppWorkspaceStore.getState().activeFolderId).toBe(9)
    useWorkbenchStore.getState().activateScope(1)
    expect(useAppWorkspaceStore.getState().activeFolderId).toBe(1)
  })

  it("an empty scope still owns the folder chrome", () => {
    open(1, 11)
    useWorkbenchStore.getState().setEnabled(true)
    useWorkbenchStore.getState().activateScope(2)
    expect(useTabStore.getState().activeTabId).toBeNull()
    expect(useAppWorkspaceStore.getState().activeFolderId).toBe(2)
  })

  it("closing the active tab focuses its neighbour in the scope", () => {
    open(1, 11)
    open(2, 21)
    const a2 = open(1, 12)
    open(2, 22)
    const a3 = open(1, 13)
    useWorkbenchStore.getState().setEnabled(true)
    useWorkbenchStore.getState().activateScope(1)
    useTabStore.getState().switchTab(a3)
    useTabStore.getState().closeTab(a3)
    expect(useTabStore.getState().activeTabId).toBe(a2)
  })

  it("an emptied group falls to the nearest group shown in the scope", () => {
    const a1 = open(1, 11)
    const a2 = open(1, 12)
    const b1 = open(2, 21)
    const a3 = open(1, 13)
    useTabStore.setState({
      groupLayout: {
        type: "split",
        id: "split",
        orientation: "horizontal",
        ratios: [1 / 3, 1 / 3, 1 / 3],
        children: [
          { type: "group", id: "g1" },
          { type: "group", id: "g2" },
          { type: "group", id: "g3" },
        ],
      },
      groupOf: { [a1]: "g1", [a2]: "g1", [b1]: "g2", [a3]: "g3" },
      groupSelection: { g1: a2, g2: b1, g3: a3 },
      activeTabId: a3,
    })
    useWorkbenchStore.getState().setEnabled(true)
    useWorkbenchStore.getState().activateScope(1)
    useTabStore.getState().switchTab(a2)
    useTabStore.getState().switchTab(a3)
    expect(useTabStore.getState().groupSelection.g1).toBe(a2)
    useTabStore.getState().closeTab(a3)
    // g2 sits between, but holds only the other worktree's tab.
    expect(useTabStore.getState().activeTabId).toBe(a2)
  })

  it("removing the scoped worktree moves to its parent repo", () => {
    setFolders([{ id: 1 }, { id: 2 }, { id: 3, parent_id: 1 }])
    open(2, 21)
    open(3, 31)
    useWorkbenchStore.getState().setEnabled(true)
    useWorkbenchStore.getState().activateScope(3)
    useTabStore.getState().closeTabsByFolder(3)
    useAppWorkspaceStore.getState().applyFolderRemove(3)
    expect(useWorkbenchStore.getState().scope).toBe(1)
    expect(useAppWorkspaceStore.getState().activeFolderId).toBe(1)
  })

  it("removing a scoped folder without tabs or parent moves to a remaining tab's scope", () => {
    setFolders([{ id: 1 }, { id: 2 }, { id: 3 }])
    const b1 = open(2, 21)
    useWorkbenchStore.getState().setEnabled(true)
    useWorkbenchStore.getState().activateScope(3)
    useAppWorkspaceStore.setState({
      folders: useAppWorkspaceStore
        .getState()
        .folders.filter((folder) => folder.id !== 3),
    })
    expect(useWorkbenchStore.getState().scope).toBe(2)
    expect(useTabStore.getState().activeTabId).toBe(b1)
  })

  it("falls back to the first open folder when no tab is left", () => {
    setFolders([{ id: 1 }, { id: 2 }])
    useWorkbenchStore.getState().setEnabled(true)
    useWorkbenchStore.getState().activateScope(2)
    useAppWorkspaceStore.getState().applyFolderRemove(2)
    expect(useWorkbenchStore.getState().scope).toBe(1)
  })

  it("inherits the agent of the tab the user is on, not the target scope's", () => {
    useTabStore.getState().openTab(2, 21, "claude_code", true)
    useTabStore.getState().openTab(1, 11, "codex", true)
    useWorkbenchStore.getState().setEnabled(true)
    useWorkbenchStore.getState().activateScope(1)
    const draft = useTabStore
      .getState()
      .openNewConversationTab(2, "/repo2", { inheritFromActive: true })
    expect(useWorkbenchStore.getState().scope).toBe(2)
    expect(draft.agentType).toBe("codex")
  })

  it("switching a draft to chat mode moves that draft into the global scope", () => {
    useWorkbenchStore.getState().setEnabled(true)
    useWorkbenchStore.getState().activateScope("global")
    const globalDraft = useTabStore.getState().openChatModeTab().tabId
    useWorkbenchStore.getState().activateScope(1)
    const draftA = useTabStore
      .getState()
      .openNewConversationTab(1, "/repo1").tabId
    expect(draftA).not.toBe(globalDraft)

    const moved = useTabStore
      .getState()
      .openChatModeTab({ retargetTabId: draftA })
    expect(moved.tabId).toBe(draftA)
    expect(useWorkbenchStore.getState().scope).toBe("global")
    expect(useTabStore.getState().activeTabId).toBe(draftA)
    expect(
      useTabStore.getState().rawTabs.find((tab) => tab.id === draftA)
    ).toMatchObject({ isChat: true, folderId: 0 })
    expect(
      useTabStore.getState().rawTabs.some((tab) => tab.id === globalDraft)
    ).toBe(true)
  })

  it("a new chat inherits the agent of the tab the user is on", () => {
    useTabStore.getState().openTab(1, 11, "open_code", true)
    useWorkbenchStore.getState().setEnabled(true)
    useWorkbenchStore.getState().activateScope(1)
    const chat = useTabStore.getState().openChatModeTab()
    expect(useWorkbenchStore.getState().scope).toBe("global")
    expect(chat.agentType).toBe("open_code")
  })

  it("the folder picker moves its own draft, and the scope follows it", async () => {
    useWorkbenchStore.getState().setEnabled(true)
    useWorkbenchStore.getState().activateScope(2)
    const draftB = useTabStore
      .getState()
      .openNewConversationTab(2, "/repo2").tabId
    useWorkbenchStore.getState().activateScope(1)
    const draftA = useTabStore
      .getState()
      .openNewConversationTab(1, "/repo1").tabId
    expect(draftA).not.toBe(draftB)

    useTabStore.getState().openNewConversationTab(2, "/repo2", {
      inheritFromActive: true,
      retargetTabId: draftA,
    })
    // Still on screen in its own worktree while the retarget is queued.
    expect(useWorkbenchStore.getState().scope).toBe(1)
    expect(useTabStore.getState().activeTabId).toBe(draftA)
    expect(useTabStore.getState().draftRetargetRequests).toMatchObject([
      { tabId: draftA, folderId: 2 },
    ])

    useTabStore.getState().consumeDraftRetargets()
    await vi.waitFor(() =>
      expect(
        useTabStore.getState().rawTabs.find((tab) => tab.id === draftA)
          ?.folderId
      ).toBe(2)
    )
    expect(useWorkbenchStore.getState().scope).toBe(2)
    expect(useTabStore.getState().activeTabId).toBe(draftA)
    expect(
      useTabStore.getState().rawTabs.some((tab) => tab.id === draftB)
    ).toBe(true)
  })
})
