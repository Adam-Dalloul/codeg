/**
 * The right-side detail panel the row's title now opens.
 *
 * What matters beyond plain rendering: the body goes through the Markdown
 * renderer rather than being printed as source, the panel shows EVERY label
 * (the row has to drop all but four), the discussion is fetched for the item
 * on show and paged through in place, and the footer offers the same
 * three-state action the row does — with the way out to the forge kept as a
 * real link.
 */
import {
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { NextIntlClientProvider } from "next-intl"
import { beforeEach, describe, expect, it, vi } from "vitest"

import enMessages from "@/i18n/messages/en.json"
import type {
  ForgeChangeDetail,
  ForgeComment,
  ForgeCommentList,
  ForgeIssueRow,
  ForgeLabel,
  ForgeTaskLink,
  WorkTaskStatus,
} from "@/lib/types"

import { ForgeIssueDetailSheet } from "./forge-issue-detail-sheet"

const setRoute = vi.fn()
vi.mock("@/contexts/workbench-route-context", () => ({
  useWorkbenchRoute: () => ({
    routeId: "forge",
    isConversations: false,
    setRoute,
    openConversations: vi.fn(),
  }),
}))
// The real one reaches the workspace context (link safety routes file links
// into the file panel), which this panel is mounted outside of. The stub keeps
// the assertion honest where it counts: it reports WHAT it was handed, so a
// panel that stopped sending the body through the renderer would fail.
vi.mock("@/components/ai-elements/message", () => ({
  MessageResponse: ({ children }: { children?: string }) => (
    <div data-testid="markdown">{children}</div>
  ),
}))
const forgeListComments = vi.hoisted(() => vi.fn())
const forgeCreateComment = vi.hoisted(() => vi.fn())
const forgeSetItemState = vi.hoisted(() => vi.fn())
const forgeChangeDetail = vi.hoisted(() => vi.fn())
const forgeChangeFiles = vi.hoisted(() => vi.fn())
vi.mock("@/lib/api", () => ({
  forgeListComments,
  forgeCreateComment,
  forgeSetItemState,
  forgeChangeDetail,
  forgeChangeFiles,
}))
const toastError = vi.hoisted(() => vi.fn())
vi.mock("sonner", () => ({ toast: { error: toastError } }))

function comment(overrides: Partial<ForgeComment> = {}): ForgeComment {
  return {
    id: "1",
    author: "octocat",
    author_avatar: null,
    body: "Looks right to me",
    created_at: "2026-08-20T00:00:00Z",
    updated_at: null,
    html_url: "https://github.com/o/r/issues/42#issuecomment-1",
    ...overrides,
  }
}

function commentPage(
  comments: ForgeComment[],
  hasNext = false,
  page = 1
): ForgeCommentList {
  return { comments, page, per_page: 20, has_next: hasNext }
}

function label(name: string, color: string | null = null): ForgeLabel {
  return { name, color }
}

function row(overrides: Partial<ForgeIssueRow> = {}): ForgeIssueRow {
  return {
    number: 42,
    title: "Login times out",
    body: "## Steps\n\n1. Sign in",
    state: "open",
    draft: false,
    labels: [label("bug")],
    author: "octocat",
    updated_at: null,
    html_url: "https://github.com/o/r/issues/42",
    is_pr: false,
    comments: 0,
    ...overrides,
  }
}

function taskLink(status: WorkTaskStatus): ForgeTaskLink {
  return {
    source_key: "github:github.com/o/r/issue/42",
    task_id: 3,
    status,
    verdict: null,
    updated_at: "2026-08-19T00:00:00Z",
  }
}

function mount(
  item: ForgeIssueRow | null,
  link: ForgeTaskLink | null = null,
  handlers: {
    onOpenChange?: () => void
    onStart?: () => void
    onRowUpdated?: (updated: ForgeIssueRow) => void
    onCommentPosted?: (item: { isPr: boolean; number: number }) => void
    folderId?: number | null
  } = {}
) {
  const onOpenChange = handlers.onOpenChange ?? vi.fn()
  const onStart = handlers.onStart ?? vi.fn()
  const onRowUpdated = handlers.onRowUpdated ?? vi.fn()
  const onCommentPosted = handlers.onCommentPosted ?? vi.fn()
  const view = render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <ForgeIssueDetailSheet
        row={item}
        link={link}
        folderId={handlers.folderId === undefined ? 7 : handlers.folderId}
        onOpenChange={onOpenChange}
        onStart={onStart}
        onRowUpdated={onRowUpdated}
        onCommentPosted={onCommentPosted}
      />
    </NextIntlClientProvider>
  )
  return { onOpenChange, onStart, onRowUpdated, onCommentPosted, view }
}

beforeEach(() => {
  vi.clearAllMocks()
  // Still in flight, by default: mounting the panel always asks for the
  // thread, and a request that RESOLVES would land its state update after a
  // test that never awaited it had finished — an `act(…)` warning on every
  // case that is about the header or the footer. The tests that are about the
  // discussion say what comes back for themselves.
  forgeListComments.mockReturnValue(new Promise(() => {}))
  // Same rule for the change section: a pull request always asks for both, and
  // a request that resolved would update state after a test about something
  // else had finished. The cases that are ABOUT the change say so themselves.
  forgeChangeDetail.mockReturnValue(new Promise(() => {}))
  forgeChangeFiles.mockReturnValue(new Promise(() => {}))
})

describe("ForgeIssueDetailSheet", () => {
  /** `null` is the closed state — the page clears the row to close. */
  it("renders nothing without an item", () => {
    mount(null)
    expect(screen.queryByText("Login times out")).not.toBeInTheDocument()
  })

  it("renders the item's body as Markdown, not as source", () => {
    mount(row())
    expect(screen.getByTestId("markdown")).toHaveTextContent("## Steps")
    expect(screen.queryByText("No description")).not.toBeInTheDocument()
  })

  /** An empty body must not leave the panel looking like it failed to load.
   *  Whitespace counts as empty — GitLab hands back "" for a description that
   *  was never written, GitHub `null`. */
  it.each([
    ["null", null],
    ["empty", ""],
    ["blank", "   \n  "],
  ])("says so when the body is %s", (_case, body) => {
    mount(row({ body }))
    expect(screen.getByText("No description")).toBeInTheDocument()
    expect(screen.queryByTestId("markdown")).not.toBeInTheDocument()
  })

  /** The row caps labels at four so the action stays on screen; the panel is
   *  where the dropped ones are finally readable. */
  it("shows every label, not the row's first four", () => {
    mount(row({ labels: ["a", "b", "c", "d", "e"].map((n) => label(n)) }))
    for (const name of ["a", "b", "c", "d", "e"]) {
      expect(screen.getByText(name)).toBeInTheDocument()
    }
  })

  /** The state is a glyph on the row, where a column of them reads at a
   *  glance. A single item has no column to compare against, so the panel
   *  spells the state out — and the glyph beside it becomes decoration, or a
   *  screen reader would say the word twice. */
  it("spells the state out beside the title", () => {
    mount(row({ is_pr: true, state: "merged" }))
    expect(screen.getByText("Merged")).toBeInTheDocument()
    expect(
      screen.queryByRole("img", { name: "Merged" })
    ).not.toBeInTheDocument()
  })

  it("keeps the forge one click away as a real link", () => {
    mount(row())
    const link = screen.getByRole("link", { name: "Open in browser" })
    expect(link).toHaveAttribute("href", "https://github.com/o/r/issues/42")
    expect(link).toHaveAttribute("target", "_blank")
  })

  it("offers Start when no task has ever handled the item", async () => {
    const user = userEvent.setup()
    const { onStart } = mount(row())
    await user.click(screen.getByRole("button", { name: "Start" }))
    expect(onStart).toHaveBeenCalledTimes(1)
    expect(setRoute).not.toHaveBeenCalled()
  })

  it("shows a live task's status chip, which goes to the board", async () => {
    const user = userEvent.setup()
    const { onStart } = mount(row(), taskLink("running"))
    expect(
      screen.queryByRole("button", { name: "Start" })
    ).not.toBeInTheDocument()
    expect(
      screen.queryByRole("button", { name: "re-trigger" })
    ).not.toBeInTheDocument()

    await user.click(screen.getByRole("button", { name: "Running" }))
    expect(setRoute).toHaveBeenCalledWith("tasks")
    expect(onStart).not.toHaveBeenCalled()
  })

  /** Same rule as the row: siblings, never nested — a control inside a button
   *  folds its text into that button's accessible name. */
  it("keeps the chip and the re-trigger as separate controls once settled", async () => {
    const user = userEvent.setup()
    const { onStart } = mount(row(), taskLink("done"))
    const chip = screen.getByRole("button", { name: "Done" })
    const retrigger = screen.getByRole("button", { name: "re-trigger" })
    expect(chip).not.toContainElement(retrigger)

    await user.click(retrigger)
    expect(onStart).toHaveBeenCalledTimes(1)
    expect(setRoute).not.toHaveBeenCalled()
  })

  /** The count sits in the identity line, where it is one more fact about the
   *  item — absent, not zero, when there is no discussion. The thread below
   *  carries its own heading and does not repeat the number: two counts that
   *  can disagree (the row is a snapshot, the thread is live) is worse than
   *  one. */
  it("reports the comment count only when there is a discussion", () => {
    mount(row({ comments: 7 }))
    const header = screen
      .getByText("Login times out")
      .closest("[data-slot='drawer-header']") as HTMLElement
    expect(within(header).getByText("7 comments")).toBeInTheDocument()

    cleanup()
    mount(row({ comments: 0 }))
    const bare = screen
      .getByText("Login times out")
      .closest("[data-slot='drawer-header']") as HTMLElement
    expect(within(bare).queryByText(/comments/i)).not.toBeInTheDocument()
  })

  describe("the discussion", () => {
    /** The item's coordinates, and only those: the repository comes from the
     *  folder's own remote, server-side. */
    it("fetches the thread for the item on show and renders it", async () => {
      forgeListComments.mockResolvedValue(
        commentPage([comment({ body: "Cannot reproduce" })])
      )
      mount(row())

      await waitFor(() =>
        expect(forgeListComments).toHaveBeenCalledWith(7, {
          kind: "issue",
          number: 42,
          page: 1,
        })
      )
      expect(await screen.findByText("octocat")).toBeInTheDocument()
      // Through the Markdown renderer, like the body — a comment is the same
      // kind of forge Markdown.
      const rendered = screen
        .getAllByTestId("markdown")
        .map((el) => el.textContent)
      expect(rendered).toContain("Cannot reproduce")
      expect(
        screen.getByRole("link", { name: "Open this comment in the browser" })
      ).toHaveAttribute(
        "href",
        "https://github.com/o/r/issues/42#issuecomment-1"
      )
    })

    /** GitLab keeps issue notes and merge-request notes on different
     *  endpoints, so the kind travels with the request. */
    it("asks about a pull request as a pull request", async () => {
      mount(row({ is_pr: true, number: 9 }))
      await waitFor(() =>
        expect(forgeListComments).toHaveBeenCalledWith(7, {
          kind: "pr",
          number: 9,
          page: 1,
        })
      )
    })

    it("says so when nobody has replied", async () => {
      forgeListComments.mockResolvedValue(commentPage([]))
      mount(row())
      expect(await screen.findByText("No comments yet")).toBeInTheDocument()
      expect(
        screen.queryByRole("button", { name: "Load more" })
      ).not.toBeInTheDocument()
    })

    /** Offset pagination over a live collection: a comment posted between the
     *  two requests shifts everything down one and serves the last of page 1
     *  again at the top of page 2. It must appear once. */
    it("appends the next page without repeating what is already on screen", async () => {
      const user = userEvent.setup()
      const first = comment({ id: "1", body: "first" })
      const second = comment({ id: "2", body: "second" })
      forgeListComments
        .mockResolvedValueOnce(commentPage([first, second], true, 1))
        .mockResolvedValueOnce(
          commentPage([second, comment({ id: "3", body: "third" })], false, 2)
        )
      mount(row())

      await screen.findByText("first")
      await user.click(screen.getByRole("button", { name: "Load more" }))

      await screen.findByText("third")
      expect(forgeListComments).toHaveBeenLastCalledWith(7, {
        kind: "issue",
        number: 42,
        page: 2,
      })
      // The one that arrived twice is on screen once, and the page already
      // read is still there.
      expect(screen.getAllByText("second")).toHaveLength(1)
      expect(screen.getByText("first")).toBeInTheDocument()
      expect(
        screen.queryByRole("button", { name: "Load more" })
      ).not.toBeInTheDocument()
    })

    /** GitLab filters its system events ("changed the milestone") AFTER
     *  paginating, so a page can come back holding nothing a human wrote while
     *  the discussion continues on the next one. "Load more" follows the
     *  forge's own `has_next`, never the row count. */
    it("still offers more when a page held only system events", async () => {
      forgeListComments.mockResolvedValue(commentPage([], true, 1))
      mount(row())

      expect(
        await screen.findByRole("button", { name: "Load more" })
      ).toBeInTheDocument()
      expect(screen.queryByText("No comments yet")).not.toBeInTheDocument()
    })

    /** A failed "load more" costs the rest of the thread, not the part being
     *  read — and the retry re-asks for the page that FAILED. */
    it("keeps the loaded pages when the next one fails, and retries that page", async () => {
      const user = userEvent.setup()
      forgeListComments
        .mockResolvedValueOnce(
          commentPage([comment({ id: "1", body: "first" })], true, 1)
        )
        .mockRejectedValueOnce(new Error("network is down"))
        .mockResolvedValueOnce(
          commentPage([comment({ id: "2", body: "later" })], false, 2)
        )
      mount(row())

      await screen.findByText("first")
      await user.click(screen.getByRole("button", { name: "Load more" }))
      expect(await screen.findByText(/network is down/)).toBeInTheDocument()
      expect(screen.getByText("first")).toBeInTheDocument()

      await user.click(screen.getByRole("button", { name: "Try again" }))
      await screen.findByText("later")
      // Page 2 again — not 3 (which would skip it) and not 1 (which would
      // throw away what is on screen).
      expect(forgeListComments).toHaveBeenLastCalledWith(7, {
        kind: "issue",
        number: 42,
        page: 2,
      })
    })

    /** The retry re-asks for the page that FAILED, and a refresh is page 1 no
     *  matter how far the thread had been paged. Deriving the retry from the
     *  "load more" cursor instead would ask for the page AFTER the one on
     *  screen and append it to the very data the refresh was there to replace. */
    it("retries a failed refresh as a refresh, not as another page", async () => {
      const user = userEvent.setup()
      forgeListComments
        .mockResolvedValueOnce(
          commentPage([comment({ id: "1", body: "stale" })], true, 1)
        )
        .mockRejectedValueOnce(new Error("refresh fell over"))
        .mockResolvedValueOnce(
          commentPage([comment({ id: "2", body: "fresh" })], false, 1)
        )
      mount(row())

      await screen.findByText("stale")
      await user.click(
        screen.getByRole("button", { name: "Refresh the comments" })
      )
      expect(await screen.findByText(/refresh fell over/)).toBeInTheDocument()

      await user.click(screen.getByRole("button", { name: "Try again" }))
      await screen.findByText("fresh")
      expect(forgeListComments).toHaveBeenLastCalledWith(7, {
        kind: "issue",
        number: 42,
        page: 1,
      })
      // Page 1 REPLACES — the stale copy the refresh was sent for is gone,
      // rather than sitting above an appended page 2.
      expect(screen.queryByText("stale")).not.toBeInTheDocument()
    })

    /** Both forges stamp an `updated_at` on creation, so the backend sends one
     *  only when it differs. The panel must not invent the mark for itself. */
    it("marks an edited comment, and only an edited one", async () => {
      forgeListComments.mockResolvedValue(
        commentPage([
          comment({ id: "1", body: "untouched" }),
          comment({
            id: "2",
            body: "revised",
            updated_at: "2026-08-21T00:00:00Z",
          }),
        ])
      )
      mount(row())
      expect(await screen.findByText(/edited/)).toBeInTheDocument()
      expect(screen.getAllByText(/edited/)).toHaveLength(1)
    })

    /** Back to page 1 wholesale: an edited or deleted comment is a change no
     *  append could show, so a refresh REPLACES rather than doubling. */
    it("refreshes the thread from the top", async () => {
      const user = userEvent.setup()
      forgeListComments
        .mockResolvedValueOnce(commentPage([comment({ id: "1", body: "old" })]))
        .mockResolvedValueOnce(commentPage([comment({ id: "9", body: "new" })]))
      mount(row())

      await screen.findByText("old")
      await user.click(
        screen.getByRole("button", { name: "Refresh the comments" })
      )

      await screen.findByText("new")
      expect(screen.queryByText("old")).not.toBeInTheDocument()
      expect(forgeListComments).toHaveBeenLastCalledWith(7, {
        kind: "issue",
        number: 42,
        page: 1,
      })
    })

    /** The panel is non-modal, so clicking another row swaps the item under it
     *  without ever closing — the thread has to follow. */
    it("follows the panel to another item", async () => {
      const { view } = mount(row())
      await waitFor(() =>
        expect(forgeListComments).toHaveBeenCalledWith(
          7,
          expect.objectContaining({ number: 42 })
        )
      )
      view.rerender(
        <NextIntlClientProvider locale="en" messages={enMessages}>
          <ForgeIssueDetailSheet
            row={row({ number: 43, title: "Another one" })}
            link={null}
            folderId={7}
            onOpenChange={vi.fn()}
            onStart={vi.fn()}
            onRowUpdated={vi.fn()}
            onCommentPosted={vi.fn()}
          />
        </NextIntlClientProvider>
      )
      await waitFor(() =>
        expect(forgeListComments).toHaveBeenLastCalledWith(
          7,
          expect.objectContaining({ number: 43, page: 1 })
        )
      )
    })

    /** A re-render that changes nothing about the item — the page re-reads the
     *  row from the list on every one — must not re-fetch, or a refresh behind
     *  the panel would reset the thread and scroll the reader to the top. */
    it("does not re-fetch when the row object is merely replaced", async () => {
      const { view } = mount(row())
      await waitFor(() => expect(forgeListComments).toHaveBeenCalledTimes(1))
      view.rerender(
        <NextIntlClientProvider locale="en" messages={enMessages}>
          <ForgeIssueDetailSheet
            row={row({ title: "Login times out (edited)" })}
            link={null}
            folderId={7}
            onOpenChange={vi.fn()}
            onStart={vi.fn()}
            onRowUpdated={vi.fn()}
            onCommentPosted={vi.fn()}
          />
        </NextIntlClientProvider>
      )
      await screen.findByText("Login times out (edited)")
      expect(forgeListComments).toHaveBeenCalledTimes(1)
    })

    /** No folder, no repository to ask about — the panel keeps everything the
     *  row already carries rather than showing a thread it cannot fetch. */
    it("skips the thread when no folder is resolved", async () => {
      mount(row(), null, { folderId: null })
      await screen.findByText("Login times out")
      expect(forgeListComments).not.toHaveBeenCalled()
      expect(screen.queryByText("Comments")).not.toBeInTheDocument()
    })
  })

  /** The page owns the open state (it holds the row), so every exit has to
   *  travel back out through `onOpenChange` — a panel that only closed itself
   *  internally would leave the page thinking it was still open. `close-press`
   *  rather than `anything()`: the drawer wrapper cancels ambient dismissals,
   *  so only that reason proves the button is really wired. */
  it("asks the page to close from the close button and from Escape", async () => {
    const user = userEvent.setup()
    const { onOpenChange } = mount(row())
    await user.click(screen.getByRole("button", { name: "Close" }))
    expect(onOpenChange).toHaveBeenCalledWith(
      false,
      expect.objectContaining({ reason: "close-press" })
    )

    cleanup()
    const second = mount(row())
    await user.keyboard("{Escape}")
    expect(second.onOpenChange).toHaveBeenCalledWith(
      false,
      expect.objectContaining({ reason: "escape-key" })
    )
  })

  /** The identity line under the title: the number, who opened it, nothing the
   *  reader has to go looking for elsewhere. */
  it("identifies the item under its title", () => {
    mount(row({ updated_at: "2026-08-20T00:00:00Z" }))
    const title = screen.getByText("Login times out")
    const header = title.closest("[data-slot='drawer-header']")
    expect(header).not.toBeNull()
    expect(within(header as HTMLElement).getByText("· #42")).toBeInTheDocument()
    expect(
      within(header as HTMLElement).getByText("· octocat")
    ).toBeInTheDocument()
    expect(
      within(header as HTMLElement).getByText(/updated/)
    ).toBeInTheDocument()
  })
})

/**
 * The panel WRITES: a comment, and the item's open/closed state.
 *
 * The rule both share is that the FORGE's answer is what lands on screen — not
 * the text that was typed, not a locally flipped `state`. That is what makes
 * the panel survive a pull request somebody merged in the browser a moment
 * ago, and what keeps a posted comment keyed by an id the next page can
 * de-duplicate against.
 */
describe("ForgeIssueDetailSheet writes", () => {
  it("posts what was typed and appends the comment the forge stored", async () => {
    const user = userEvent.setup()
    forgeListComments.mockResolvedValue(commentPage([]))
    // NOT an echo of the draft: a different id, a different author, and a
    // permalink — the three things the thread keys, de-duplicates and links by.
    forgeCreateComment.mockResolvedValue(
      comment({ id: "991", author: "alice", body: "looks fixed" })
    )
    const { onCommentPosted } = mount(row())
    await screen.findByText("No comments yet")

    const box = screen.getByPlaceholderText("Leave a comment…")
    await user.type(box, "  looks fixed  ")
    await user.click(screen.getByRole("button", { name: "Comment" }))

    await waitFor(() =>
      expect(forgeCreateComment).toHaveBeenCalledWith(7, {
        kind: "issue",
        number: 42,
        // Trimmed before it goes out — a comment padded with what a keyboard
        // left behind is one nobody meant to publish.
        body: "looks fixed",
      })
    )
    expect(await screen.findByText("looks fixed")).toBeInTheDocument()
    expect(screen.getByText("alice")).toBeInTheDocument()
    // The draft is cleared only once it exists somewhere else.
    expect(box).toHaveValue("")
    // The ITEM, not a row: a snapshot taken at submit time could carry this
    // item's pre-close state back over a newer one (see `onCommentPosted`).
    expect(onCommentPosted).toHaveBeenCalledWith({ isPr: false, number: 42 })
  })

  it("keeps the draft when the post fails", async () => {
    const user = userEvent.setup()
    forgeListComments.mockResolvedValue(commentPage([]))
    forgeCreateComment.mockRejectedValue(new Error("rate limited"))
    const { onCommentPosted } = mount(row())
    await screen.findByText("No comments yet")

    const box = screen.getByPlaceholderText("Leave a comment…")
    await user.type(box, "worth keeping")
    await user.click(screen.getByRole("button", { name: "Comment" }))

    expect(await screen.findByText("rate limited")).toBeInTheDocument()
    // Losing what somebody wrote to a network failure they cannot retry from
    // is the one outcome a composer must never have.
    expect(box).toHaveValue("worth keeping")
    expect(onCommentPosted).not.toHaveBeenCalled()
  })

  it("will not post an empty comment", async () => {
    const user = userEvent.setup()
    forgeListComments.mockResolvedValue(commentPage([]))
    mount(row())
    await screen.findByText("No comments yet")

    const submit = screen.getByRole("button", { name: "Comment" })
    expect(submit).toBeDisabled()
    // Whitespace is not text: both forges accept it and render a blank card
    // this app has no way to delete.
    await user.type(screen.getByPlaceholderText("Leave a comment…"), "   ")
    expect(submit).toBeDisabled()
  })

  it("confirms a close, then adopts the row the forge answered with", async () => {
    const user = userEvent.setup()
    // GitHub's PATCH answers with bare label names on GitLab; here the point
    // is the STATE, which came back as something the caller did not ask for.
    forgeSetItemState.mockResolvedValue(
      row({ state: "closed", labels: [label("bug")] })
    )
    const { onRowUpdated } = mount(row({ labels: [label("bug", "#d73a4a")] }))

    await user.click(
      screen.getByRole("button", { name: "Close #42 on the forge" })
    )
    // Nothing has been sent yet: the dialog is the confirmation.
    expect(forgeSetItemState).not.toHaveBeenCalled()
    expect(await screen.findByText("Close this item?")).toBeInTheDocument()

    await user.click(
      within(screen.getByRole("alertdialog")).getByRole("button", {
        name: "Close",
      })
    )
    await waitFor(() =>
      expect(forgeSetItemState).toHaveBeenCalledWith(7, {
        kind: "issue",
        number: 42,
        action: "close",
      })
    )
    await waitFor(() => expect(onRowUpdated).toHaveBeenCalled())
    const adopted = vi.mocked(onRowUpdated).mock.calls[0][0] as ForgeIssueRow
    expect(adopted.state).toBe("closed")
    // The colour the single-item payload could not carry is restored from the
    // row the panel already had — otherwise every chip drops to grey the
    // instant somebody presses Close.
    expect(adopted.labels).toEqual([label("bug", "#d73a4a")])
  })

  it("offers reopen on a closed item and nothing at all on a merged one", () => {
    mount(row({ state: "closed" }))
    expect(
      screen.getByRole("button", { name: "Reopen #42 on the forge" })
    ).toBeInTheDocument()
    cleanup()

    // A merged change has no state left to set: GitHub refuses to reopen it
    // and GitLab reopens it against a branch that is gone. A button that can
    // only fail is worse than no button.
    mount(row({ is_pr: true, state: "merged" }))
    expect(
      screen.queryByRole("button", { name: /on the forge/ })
    ).not.toBeInTheDocument()
  })

  it("reports a refused state change without closing the confirmation", async () => {
    const user = userEvent.setup()
    forgeSetItemState.mockRejectedValue(new Error("issue is locked"))
    const { onRowUpdated } = mount(row())

    await user.click(
      screen.getByRole("button", { name: "Close #42 on the forge" })
    )
    await user.click(
      within(screen.getByRole("alertdialog")).getByRole("button", {
        name: "Close",
      })
    )
    await waitFor(() =>
      expect(toastError).toHaveBeenCalledWith("issue is locked")
    )
    expect(onRowUpdated).not.toHaveBeenCalled()
    // Still open, so the action can be retried from where it was started.
    expect(screen.getByText("Close this item?")).toBeInTheDocument()
  })
})

/**
 * What a pull request IS, above its discussion — and the three answers the CI
 * section has to keep apart: green, nothing configured, and "this account
 * cannot look".
 */
describe("ForgeIssueDetailSheet change section", () => {
  function change(
    overrides: Partial<ForgeChangeDetail> = {}
  ): ForgeChangeDetail {
    return {
      number: 42,
      base_ref: "main",
      head_ref: "fix/timeout",
      head_repo: null,
      head_sha: "abc123",
      draft: false,
      state: "open",
      mergeable: true,
      merge_state: "clean",
      additions: 120,
      deletions: 8,
      changed_files: 3,
      commits: 2,
      checks: { checks: [], available: true, partial: false },
      ...overrides,
    }
  }

  it("is asked for only on a proposed change", async () => {
    mount(row({ is_pr: false }))
    await waitFor(() => expect(forgeListComments).toHaveBeenCalled())
    // An issue has no branches, no diff and no CI — and asking would spend two
    // upstream requests to be told so.
    expect(forgeChangeDetail).not.toHaveBeenCalled()
    expect(forgeChangeFiles).not.toHaveBeenCalled()
  })

  it("draws the branch pair, the counters and the files", async () => {
    forgeChangeDetail.mockResolvedValue(
      change({ head_repo: "contributor/app", draft: true })
    )
    forgeChangeFiles.mockResolvedValue({
      files: [
        {
          path: "src/a.rs",
          previous_path: null,
          status: "modified",
          additions: 10,
          deletions: 2,
          binary: false,
        },
        {
          path: "logo.png",
          previous_path: null,
          status: "added",
          additions: null,
          deletions: null,
          binary: true,
        },
      ],
      page: 1,
      per_page: 50,
      has_next: false,
    })
    mount(row({ is_pr: true, state: "open", draft: true }))

    expect(await screen.findByText("main")).toBeInTheDocument()
    // The fork is named; a same-repository head would show the branch alone.
    expect(screen.getByText("contributor/app:fix/timeout")).toBeInTheDocument()
    expect(screen.getByText("Can be merged")).toBeInTheDocument()
    expect(screen.getByText("3 files")).toBeInTheDocument()
    expect(screen.getByText("2 commits")).toBeInTheDocument()

    expect(await screen.findByText("src/a.rs")).toBeInTheDocument()
    expect(screen.getByText("+10")).toBeInTheDocument()
    // A binary file has no line counts on either forge; zeroes would claim it
    // changed nothing.
    expect(screen.getByText("binary")).toBeInTheDocument()
    expect(forgeChangeFiles).toHaveBeenCalledWith(7, { number: 42, page: 1 })
  })

  it("tells 'no checks ran' apart from 'could not look'", async () => {
    forgeChangeDetail.mockResolvedValue(
      change({ checks: { checks: [], available: true, partial: false } })
    )
    forgeChangeFiles.mockResolvedValue({
      files: [],
      page: 1,
      per_page: 50,
      has_next: false,
    })
    mount(row({ is_pr: true }))
    expect(await screen.findByText("No checks ran")).toBeInTheDocument()
    cleanup()

    forgeChangeDetail.mockResolvedValue(
      change({ checks: { checks: [], available: false, partial: false } })
    )
    mount(row({ is_pr: true }))
    // Not "no checks": a token without the scope over a red build would
    // otherwise read as a green one.
    expect(
      await screen.findByText(
        "This account cannot read the repository's checks."
      )
    ).toBeInTheDocument()
  })

  it("counts only the check states worth a headline", async () => {
    forgeChangeDetail.mockResolvedValue(
      change({
        checks: {
          available: true,
          partial: false,
          checks: [
            {
              id: "1",
              name: "build",
              state: "success",
              summary: null,
              url: null,
              allow_failure: false,
            },
            {
              id: "2",
              name: "lint",
              state: "failure",
              summary: "2 problems",
              url: null,
              allow_failure: true,
            },
            {
              id: "3",
              name: "e2e",
              state: "running",
              summary: null,
              url: null,
              allow_failure: false,
            },
            // Skipped is NOT a pass, and it is not a failure either — it must
            // not be counted into either headline.
            {
              id: "4",
              name: "deploy",
              state: "neutral",
              summary: null,
              url: null,
              allow_failure: false,
            },
          ],
        },
      })
    )
    forgeChangeFiles.mockResolvedValue({
      files: [],
      page: 1,
      per_page: 50,
      has_next: false,
    })
    mount(row({ is_pr: true }))

    expect(await screen.findByText("1 passing")).toBeInTheDocument()
    expect(screen.getByText("1 failing")).toBeInTheDocument()
    expect(screen.getByText("1 in progress")).toBeInTheDocument()
    // A red job the pipeline tolerates is a different fact from one that
    // blocks the change.
    expect(screen.getByText("may fail")).toBeInTheDocument()
    // Each state carries a translated label, so the strip means something
    // without colour vision.
    expect(screen.getByRole("img", { name: "Failed" })).toBeInTheDocument()
    expect(screen.getByRole("img", { name: "No verdict" })).toBeInTheDocument()
  })

  it("says nothing about mergeability it does not know, and nothing at all once merged", async () => {
    forgeChangeFiles.mockResolvedValue({
      files: [],
      page: 1,
      per_page: 50,
      has_next: false,
    })
    // Both forges answer "not worked out yet" — GitHub with a null, GitLab
    // with `unchecked`. Reading that as "cannot be merged" would send someone
    // hunting a conflict that may not exist.
    forgeChangeDetail.mockResolvedValue(
      change({ mergeable: null, merge_state: "unknown" })
    )
    mount(row({ is_pr: true }))
    expect(
      await screen.findByText("Checking whether it can be merged…")
    ).toBeInTheDocument()
    expect(screen.queryByText("Has conflicts")).not.toBeInTheDocument()
    cleanup()

    // Already landed: both forges keep answering the question, and "has
    // conflicts" on something that merged reads as a problem that is not there.
    forgeChangeDetail.mockResolvedValue(
      change({ state: "merged", mergeable: false, merge_state: "dirty" })
    )
    mount(row({ is_pr: true, state: "merged" }))
    expect(await screen.findByText("main")).toBeInTheDocument()
    expect(screen.queryByText("Has conflicts")).not.toBeInTheDocument()
    expect(
      screen.queryByText("Checking whether it can be merged…")
    ).not.toBeInTheDocument()
  })

  it("omits the counters the forge did not report", async () => {
    // A GitLab merge request: no line counts, no commit count, and a
    // `changes_count` the backend refused to trust.
    forgeChangeDetail.mockResolvedValue(
      change({
        additions: null,
        deletions: null,
        commits: null,
        changed_files: null,
      })
    )
    forgeChangeFiles.mockResolvedValue({
      files: [],
      page: 1,
      per_page: 50,
      has_next: false,
    })
    mount(row({ is_pr: true }))
    expect(await screen.findByText("Can be merged")).toBeInTheDocument()
    // A zero here would claim the change touches nothing.
    expect(screen.queryByText(/files$/)).not.toBeInTheDocument()
    expect(screen.queryByText(/commits$/)).not.toBeInTheDocument()
    expect(screen.queryByText("+0")).not.toBeInTheDocument()
  })
})

/**
 * The three ways a posted comment used to go wrong, and the half-readable
 * check list — all four are races or orderings rather than plain rendering,
 * so each one is driven through the exact sequence that produced it.
 */
describe("ForgeIssueDetailSheet write races", () => {
  function change(
    overrides: Partial<ForgeChangeDetail> = {}
  ): ForgeChangeDetail {
    return {
      number: 42,
      base_ref: "main",
      head_ref: "fix/timeout",
      head_repo: null,
      head_sha: "abc123",
      draft: false,
      state: "open",
      mergeable: true,
      merge_state: "clean",
      additions: null,
      deletions: null,
      changed_files: null,
      commits: null,
      checks: { checks: [], available: true, partial: false },
      ...overrides,
    }
  }

  /** A posted comment is the NEWEST one. Appended into the paged collection it
   *  would sit at position 21 with pages 1–20 loaded, and the next "load more"
   *  would file comments 21–30 AFTER it — a thread reading 1…20, 31, 21…30. */
  it("keeps a posted comment last until its own page arrives", async () => {
    const user = userEvent.setup()
    forgeListComments.mockResolvedValueOnce(
      commentPage([comment({ id: "1", body: "oldest" })], true, 1)
    )
    forgeCreateComment.mockResolvedValue(
      comment({ id: "31", body: "just posted" })
    )
    mount(row())
    await screen.findByText("oldest")

    await user.type(
      screen.getByPlaceholderText("Leave a comment…"),
      "just posted"
    )
    await user.click(screen.getByRole("button", { name: "Comment" }))
    await screen.findByText("just posted")

    // Page 2 holds comments OLDER than the one just posted.
    forgeListComments.mockResolvedValueOnce(
      commentPage([comment({ id: "2", body: "middle" })], false, 2)
    )
    await user.click(screen.getByRole("button", { name: "Load more" }))
    await screen.findByText("middle")

    // Scoped to the thread: the item's own description goes through the same
    // renderer and would otherwise lead this list.
    const thread = screen.getByRole("list")
    const bodies = within(thread)
      .getAllByTestId("markdown")
      .map((el) => el.textContent)
    expect(bodies).toEqual(["oldest", "middle", "just posted"])
  })

  /** …and once the page it really lives on arrives, it is the same comment,
   *  not a second copy of it. */
  it("retires the posted copy when the forge serves the real one", async () => {
    const user = userEvent.setup()
    forgeListComments.mockResolvedValueOnce(commentPage([], true, 1))
    forgeCreateComment.mockResolvedValue(
      comment({ id: "31", body: "just posted" })
    )
    mount(row())
    await screen.findByPlaceholderText("Leave a comment…")

    await user.type(
      screen.getByPlaceholderText("Leave a comment…"),
      "just posted"
    )
    await user.click(screen.getByRole("button", { name: "Comment" }))
    await screen.findByText("just posted")

    forgeListComments.mockResolvedValueOnce(
      commentPage([comment({ id: "31", body: "just posted" })], false, 2)
    )
    await user.click(screen.getByRole("button", { name: "Load more" }))

    await waitFor(() =>
      expect(screen.getAllByText("just posted")).toHaveLength(1)
    )
  })

  /** A page-1 load still in flight REPLACES the collection wholesale. A
   *  comment posted while it was out must survive that — it exists on the
   *  forge, and a panel that dropped it would say a published comment is not
   *  there. */
  it("survives a refresh that lands after the post", async () => {
    const user = userEvent.setup()
    let releaseRefresh: (page: ForgeCommentList) => void = () => {}
    forgeListComments
      .mockResolvedValueOnce(commentPage([comment({ id: "1", body: "first" })]))
      .mockReturnValueOnce(
        new Promise<ForgeCommentList>((resolve) => {
          releaseRefresh = resolve
        })
      )
    forgeCreateComment.mockResolvedValue(
      comment({ id: "9", body: "posted mid-refresh" })
    )
    mount(row())
    await screen.findByText("first")

    // Refresh out, not yet back.
    await user.click(
      screen.getByRole("button", { name: "Refresh the comments" })
    )
    await user.type(
      screen.getByPlaceholderText("Leave a comment…"),
      "posted mid-refresh"
    )
    await user.click(screen.getByRole("button", { name: "Comment" }))
    await screen.findByText("posted mid-refresh")

    // The refresh lands now, without the new comment in it (the forge's own
    // page-1 was built before the post).
    releaseRefresh(commentPage([comment({ id: "1", body: "first" })]))

    await waitFor(() => expect(screen.getByText("first")).toBeInTheDocument())
    expect(screen.getByText("posted mid-refresh")).toBeInTheDocument()
  })

  /** The count is counted by the PAGE onto whatever it holds when this
   *  arrives — the sheet only says which item, because a row captured at
   *  submit time could be older than a close that resolved meanwhile. */
  it("reports the item rather than a row snapshot", async () => {
    const user = userEvent.setup()
    forgeListComments.mockResolvedValue(commentPage([]))
    forgeCreateComment.mockResolvedValue(comment({ id: "9", body: "ok" }))
    const { onCommentPosted } = mount(row({ is_pr: true, comments: 4 }))
    await screen.findByText("No comments yet")

    await user.type(screen.getByPlaceholderText("Leave a comment…"), "ok")
    await user.click(screen.getByRole("button", { name: "Comment" }))

    await waitFor(() => expect(onCommentPosted).toHaveBeenCalled())
    expect(onCommentPosted).toHaveBeenCalledWith({ isPr: true, number: 42 })
  })

  /** GitHub keeps check runs and commit statuses behind two DIFFERENT
   *  fine-grained permissions, so a token with only one of them gets a 403
   *  from one endpoint and an honest empty list from the other. Drawing that
   *  as "no checks ran" is green over red. */
  it("does not call a half-readable empty check list 'no checks ran'", async () => {
    forgeChangeFiles.mockResolvedValue({
      files: [],
      page: 1,
      per_page: 50,
      has_next: false,
    })
    forgeChangeDetail.mockResolvedValue(
      change({ checks: { checks: [], available: true, partial: true } })
    )
    mount(row({ is_pr: true }))
    expect(
      await screen.findByText(
        "This account cannot read the repository's checks."
      )
    ).toBeInTheDocument()
    expect(screen.queryByText("No checks ran")).not.toBeInTheDocument()
  })

  /** With something readable, the half that arrived is shown — and said to be
   *  a half. */
  it("marks a partial check list beside the checks it did get", async () => {
    forgeChangeFiles.mockResolvedValue({
      files: [],
      page: 1,
      per_page: 50,
      has_next: false,
    })
    forgeChangeDetail.mockResolvedValue(
      change({
        checks: {
          available: true,
          partial: true,
          checks: [
            {
              id: "1",
              name: "codecov",
              state: "success",
              summary: null,
              url: null,
              allow_failure: false,
            },
          ],
        },
      })
    )
    mount(row({ is_pr: true }))
    expect(await screen.findByText("codecov")).toBeInTheDocument()
    expect(screen.getByText("some could not be read")).toBeInTheDocument()
  })
})
