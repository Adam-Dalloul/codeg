import { describe, expect, it, vi } from "vitest"
import { fetchNonSparsePage, MAX_SPARSE_HOPS } from "./forge-pagination"
import type { ForgeIssueList, ForgeIssueRow } from "./types"

function row(number: number): ForgeIssueRow {
  return {
    number,
    title: `item ${number}`,
    body: null,
    state: "open",
    labels: [],
    author: null,
    updated_at: null,
    html_url: `https://github.test/x/y/issues/${number}`,
    is_pr: false,
  }
}

function pages(
  sequence: ForgeIssueList[]
): (cursor: string | null) => Promise<ForgeIssueList> {
  return vi.fn(async (cursor: string | null) => {
    const index = cursor == null ? 0 : Number.parseInt(cursor, 10)
    return sequence[index]
  })
}

describe("fetchNonSparsePage", () => {
  it("auto-follows the cursor through pages the tab filter emptied", async () => {
    // Codex round-1 regression: PR-only page 1 filters to zero Issues rows,
    // page 2 holds the matches — stopping at page 1 rendered a dead-end empty
    // state with unreachable rows.
    const fetch = pages([
      { rows: [], next_cursor: "1" },
      { rows: [row(3)], next_cursor: "2" },
    ])
    const page = await fetchNonSparsePage(fetch, null)
    expect(page.rows.map((r) => r.number)).toEqual([3])
    expect(page.nextCursor).toBe("2")
    expect(page.hops).toBe(2)
  })

  it("returns straight away when the first page is visible", async () => {
    const fetch = pages([{ rows: [row(1)], next_cursor: "1" }])
    const page = await fetchNonSparsePage(fetch, null)
    expect(page.rows.map((r) => r.number)).toEqual([1])
    expect(page.hops).toBe(1)
  })

  it("stops at the hop cap but keeps the cursor alive for load-more", async () => {
    const sparse = Array.from({ length: MAX_SPARSE_HOPS + 3 }, (_, i) => ({
      rows: [] as ForgeIssueRow[],
      next_cursor: String(i + 1),
    }))
    const fetch = pages(sparse)
    const page = await fetchNonSparsePage(fetch, null)
    expect(page.rows).toEqual([])
    expect(page.hops).toBe(MAX_SPARSE_HOPS)
    // The empty state can continue from here — the cursor is NOT dropped.
    expect(page.nextCursor).toBe(String(MAX_SPARSE_HOPS))
  })

  it("ends cleanly when the feed runs out while sparse", async () => {
    const fetch = pages([
      { rows: [], next_cursor: "1" },
      { rows: [], next_cursor: null },
    ])
    const page = await fetchNonSparsePage(fetch, null)
    expect(page.rows).toEqual([])
    expect(page.nextCursor).toBeNull()
    expect(page.hops).toBe(2)
  })
})
