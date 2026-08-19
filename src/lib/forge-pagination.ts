import type { ForgeIssueList, ForgeIssueRow } from "@/lib/types"

/** How many consecutive sparse pages one click may auto-follow. Bounds the
 *  API cost of a pathological repo (hundreds of PR-only pages on the Issues
 *  tab) while making the normal mixed repo feel seamless. */
export const MAX_SPARSE_HOPS = 5

export interface NonSparsePage {
  rows: ForgeIssueRow[]
  nextCursor: string | null
  /** Pages actually fetched (1 = no sparse hop was needed). */
  hops: number
}

/**
 * Fetch a page, auto-following the cursor through SPARSE pages — the mixed
 * `/issues` feed is split into tabs client-side, so a page can legitimately
 * filter down to zero visible rows while more matches exist behind the Link
 * cursor. Stopping there would render an empty state with unreachable rows
 * (Codex round-1 finding); this keeps hopping until it has something to show,
 * runs out of pages, or hits the hop cap (the caller then still gets the
 * cursor and can offer an explicit "load more").
 */
export async function fetchNonSparsePage(
  fetchPage: (cursor: string | null) => Promise<ForgeIssueList>,
  cursor: string | null,
  maxHops: number = MAX_SPARSE_HOPS
): Promise<NonSparsePage> {
  const rows: ForgeIssueRow[] = []
  let next = cursor
  let hops = 0
  do {
    const page = await fetchPage(next)
    hops += 1
    rows.push(...page.rows)
    next = page.next_cursor
  } while (rows.length === 0 && next != null && hops < maxHops)
  return { rows, nextCursor: next, hops }
}
