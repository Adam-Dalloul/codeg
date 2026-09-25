import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { GitLogTab } from "./aux-panel-git-log-tab"
import enMessages from "@/i18n/messages/en.json"

const state = vi.hoisted(() => ({
  folder: { id: 1, path: "/worktrees/a" },
  gitLog: vi.fn(async () => ({ entries: [] })),
}))

vi.mock("@/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api")>()),
  gitLog: state.gitLog,
  getGitBranch: async () => "main",
  gitListAllBranches: async () => ({
    local: ["main"],
    remote: [],
    worktree_branches: [],
    main_worktree_branch: null,
  }),
  gitCurrentUser: async () => null,
}))

vi.mock("@/contexts/active-folder-context", () => ({
  useActiveFolder: () => ({ activeFolder: state.folder }),
}))

vi.mock("@/contexts/workspace-context", () => ({
  useWorkspaceActions: () => ({
    openCommitDiff: vi.fn(),
    openFilePreview: vi.fn(),
  }),
}))

vi.mock("@/hooks/use-workspace-state-store", () => ({
  useWorkspaceStateStore: () => ({ isGitRepo: true }),
}))

vi.mock("@/hooks/use-git-quick-actions", () => ({
  useGitQuickActions: () => ({
    running: false,
    pull: vi.fn(),
    fetchAll: vi.fn(),
    openPushWindow: vi.fn(),
    dialogs: null,
  }),
}))

vi.mock("@/stores/app-workspace-store", () => ({
  useAppWorkspaceStore: (
    selector: (state: { gitHeads: Map<number, unknown> }) => unknown
  ) => selector({ gitHeads: new Map() }),
}))

vi.mock("@/lib/platform", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/platform")>()),
  subscribe: async () => () => {},
}))

vi.mock("@/components/layout/remote-manage-dialog", () => ({
  RemoteManageDialog: () => null,
}))

function renderTab() {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <GitLogTab />
    </NextIntlClientProvider>
  )
}

describe("Commits tab branch query", () => {
  beforeEach(() => {
    window.localStorage.clear()
    state.folder = { id: 1, path: "/worktrees/a" }
    state.gitLog.mockClear()
  })
  afterEach(() => cleanup())

  it("queries only the current worktree HEAD on first open", async () => {
    renderTab()
    await waitFor(() =>
      expect(state.gitLog).toHaveBeenCalledWith(
        "/worktrees/a",
        100,
        "HEAD",
        undefined,
        0,
        undefined,
        false,
        false
      )
    )
  })

  it("keeps a deliberate All branches selection after remount", async () => {
    const first = renderTab()
    await screen.findByRole("button", { name: "Clear branch filter" })
    fireEvent.click(screen.getByRole("button", { name: "Clear branch filter" }))
    await waitFor(() =>
      expect(state.gitLog).toHaveBeenCalledWith(
        "/worktrees/a",
        100,
        undefined,
        undefined,
        0,
        undefined,
        true,
        false
      )
    )

    first.unmount()
    state.gitLog.mockClear()
    renderTab()
    await waitFor(() =>
      expect(state.gitLog).toHaveBeenCalledWith(
        "/worktrees/a",
        100,
        undefined,
        undefined,
        0,
        undefined,
        true,
        false
      )
    )
  })
})
