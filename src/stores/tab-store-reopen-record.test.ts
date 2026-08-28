import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import {
  peekClosedTab,
  resetClosedTabStackForTests,
} from "@/lib/closed-tab-stack"
import {
  resetAppWorkspaceStore,
  useAppWorkspaceStore,
} from "./app-workspace-store"
import { resetTabStore, useTabStore } from "./tab-store"
import type { FolderDetail } from "@/lib/types"

vi.mock("@/lib/api", () => ({
  listOpenedTabs: vi.fn(),
  saveOpenedTabs: vi.fn(),
  getFolderConversation: vi.fn(),
}))

vi.mock("@/lib/platform", () => ({
  subscribe: vi.fn(),
  onTransportReconnect: vi.fn(),
}))

const folder = {
  id: 1,
  name: "repo",
  path: "/repo",
} as unknown as FolderDetail

function seedTabs() {
  useAppWorkspaceStore.setState({ folders: [folder], allFolders: [folder] })
  useTabStore.setState({
    rawTabs: [
      {
        id: "conv-1",
        kind: "conversation",
        folderId: 1,
        conversationId: 7,
        agentType: "claude_code",
        title: "kept",
        isPinned: false,
      },
      {
        id: "conv-2",
        kind: "conversation",
        folderId: 1,
        conversationId: 8,
        agentType: "claude_code",
        title: "closed",
        isPinned: false,
      },
    ],
    activeTabId: "conv-2",
  })
}

beforeEach(() => {
  resetTabStore()
  resetAppWorkspaceStore()
  resetClosedTabStackForTests()
  seedTabs()
})

afterEach(() => {
  resetClosedTabStackForTests()
})

describe("what reopen-last-closed-tab is allowed to remember", () => {
  it("records an ordinary close", () => {
    useTabStore.getState().closeTab("conv-2")
    expect(peekClosedTab()).toMatchObject({
      kind: "conversation",
      conversationId: 8,
    })
  })

  // Reopening these would mint a tab — and an `opened_tabs` row — pointing at a
  // conversation the user just deleted.
  it("does not record a close that follows a delete", () => {
    useTabStore.getState().closeTab("conv-2", { recordForReopen: false })
    expect(peekClosedTab()).toBeNull()
  })

  it("does not record the sidebar / manage-dialog delete path", () => {
    // `closeConversationTab` is only ever called right after
    // `deleteConversation`, so it opts out on every caller's behalf.
    useTabStore.getState().closeConversationTab(1, 8, "claude_code")
    expect(useTabStore.getState().rawTabs).toHaveLength(1)
    expect(peekClosedTab()).toBeNull()
  })

  it("does not record tabs dropped with their folder", () => {
    useTabStore.getState().closeTabsByFolder(1)
    expect(useTabStore.getState().rawTabs).toHaveLength(0)
    expect(peekClosedTab()).toBeNull()
  })
})
