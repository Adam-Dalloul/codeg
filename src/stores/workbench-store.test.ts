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
