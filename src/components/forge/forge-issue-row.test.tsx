/**
 * The workbench row's three-state action. Two rules matter beyond the plain
 * rendering: the chip and the re-trigger are SIBLING controls (a button nested
 * in a button folds its text into the outer one's accessible name, and leaves
 * keyboard activation to the browser), and each does its own thing — the chip
 * navigates to the board, the re-trigger opens the dialog.
 */
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { NextIntlClientProvider } from "next-intl"
import { beforeEach, describe, expect, it, vi } from "vitest"

import enMessages from "@/i18n/messages/en.json"
import type { ForgeIssueRow, ForgeTaskLink, WorkTaskStatus } from "@/lib/types"

import { ForgeIssueRowItem } from "./forge-issue-row"

const setRoute = vi.fn()
vi.mock("@/contexts/workbench-route-context", () => ({
  useWorkbenchRoute: () => ({
    routeId: "forge",
    isConversations: false,
    setRoute,
    openConversations: vi.fn(),
  }),
}))

function row(overrides: Partial<ForgeIssueRow> = {}): ForgeIssueRow {
  return {
    number: 42,
    title: "Login times out",
    body: "steps to reproduce…",
    state: "open",
    labels: ["bug", "p1"],
    author: "octocat",
    updated_at: null,
    html_url: "https://github.com/o/r/issues/42",
    is_pr: false,
    ...overrides,
  }
}

function link(status: WorkTaskStatus): ForgeTaskLink {
  return {
    source_key: "github:github.com/o/r/issue/42",
    task_id: 3,
    status,
    verdict: null,
    updated_at: "2026-08-19T00:00:00Z",
  }
}

function mount(
  item: ForgeIssueRow,
  taskLink: ForgeTaskLink | null,
  onStart = vi.fn()
) {
  render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <ForgeIssueRowItem row={item} link={taskLink} onStart={onStart} />
    </NextIntlClientProvider>
  )
  return onStart
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe("ForgeIssueRowItem", () => {
  it("offers Start when no task has ever handled the item", async () => {
    const user = userEvent.setup()
    const onStart = mount(row(), null)
    await user.click(screen.getByRole("button", { name: "Start" }))
    expect(onStart).toHaveBeenCalledTimes(1)
    expect(setRoute).not.toHaveBeenCalled()
  })

  it("shows a live status chip that goes to the board, with no re-trigger", async () => {
    const user = userEvent.setup()
    const onStart = mount(row(), link("running"))
    expect(
      screen.queryByRole("button", { name: "Start" })
    ).not.toBeInTheDocument()
    expect(
      screen.queryByRole("button", { name: "re-trigger" })
    ).not.toBeInTheDocument()

    await user.click(screen.getByRole("button", { name: "Running" }))
    expect(setRoute).toHaveBeenCalledWith("tasks")
    // A running task is not something to trigger again.
    expect(onStart).not.toHaveBeenCalled()
  })

  it("keeps the chip and the re-trigger as separate controls on a finished task", async () => {
    const user = userEvent.setup()
    const onStart = mount(row(), link("done"))

    // Nested, the chip's accessible name would swallow "re-trigger" and the
    // inner control would need hand-written Enter/Space handling.
    const chip = screen.getByRole("button", { name: "Done" })
    const retrigger = screen.getByRole("button", { name: "re-trigger" })
    expect(chip).not.toContainElement(retrigger)

    await user.click(retrigger)
    expect(onStart).toHaveBeenCalledTimes(1)
    // The re-trigger opens the dialog; it does not also navigate away.
    expect(setRoute).not.toHaveBeenCalled()

    await user.click(chip)
    expect(setRoute).toHaveBeenCalledWith("tasks")
    expect(onStart).toHaveBeenCalledTimes(1)
  })

  it("re-triggers from the keyboard, which a plain button gives for free", async () => {
    const user = userEvent.setup()
    const onStart = mount(row(), link("canceled"))
    screen.getByRole("button", { name: "re-trigger" }).focus()
    await user.keyboard("{Enter}")
    await user.keyboard(" ")
    expect(onStart).toHaveBeenCalledTimes(2)
  })

  it("links the title out to the forge and shows the first labels", () => {
    mount(row({ labels: ["a", "b", "c", "d", "e"] }), null)
    const title = screen.getByRole("link", { name: "Login times out" })
    expect(title).toHaveAttribute("href", "https://github.com/o/r/issues/42")
    expect(title).toHaveAttribute("target", "_blank")
    // Four labels fit the row; the fifth would push the action off the edge.
    expect(screen.getByText("d")).toBeInTheDocument()
    expect(screen.queryByText("e")).not.toBeInTheDocument()
    expect(screen.getByText("#42")).toBeInTheDocument()
    expect(screen.getByText("· octocat")).toBeInTheDocument()
  })
})
