import { fireEvent, render, screen } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { beforeEach, describe, expect, it, vi } from "vitest"

import {
  UnifiedDiffPreview,
  toSplitRows,
  type ParsedDiffRow,
} from "./unified-diff-preview"
import enMessages from "@/i18n/messages/en.json"

// The component reads the active folder only to strip a path prefix from the
// file header; a null folder is enough for these tests.
vi.mock("@/contexts/active-folder-context", () => ({
  useActiveFolder: () => ({ activeFolder: null }),
}))

function Wrapper({ children }: { children: React.ReactNode }) {
  return (
    <NextIntlClientProvider locale="en" messages={enMessages}>
      {children}
    </NextIntlClientProvider>
  )
}

// `wrapper` so `rerender` re-applies the intl provider automatically.
function renderWithIntl(ui: React.ReactElement) {
  return render(ui, { wrapper: Wrapper })
}

/** A single-file "add" diff with `lineCount` added rows. */
function newFileDiff(lineCount: number): string {
  const header = `diff --git a/big.txt b/big.txt\n--- /dev/null\n+++ b/big.txt\n@@ -0,0 +1,${lineCount} @@\n`
  const body = Array.from(
    { length: lineCount },
    (_, i) => `+line ${i + 1}`
  ).join("\n")
  return `${header}${body}\n`
}

describe("UnifiedDiffPreview", () => {
  it("renders every row for a small diff and shows no reveal control", () => {
    renderWithIntl(<UnifiedDiffPreview diffText={newFileDiff(3)} />)

    expect(screen.getByText("line 1")).toBeInTheDocument()
    expect(screen.getByText("line 3")).toBeInTheDocument()
    expect(
      screen.queryByRole("button", { name: /more lines/ })
    ).not.toBeInTheDocument()
  })

  it("caps a large diff at 500 rows and offers to reveal the rest", () => {
    renderWithIntl(<UnifiedDiffPreview diffText={newFileDiff(600)} />)

    // The first 500 rows render; rows past the cap do not.
    expect(screen.getByText("line 500")).toBeInTheDocument()
    expect(screen.queryByText("line 501")).not.toBeInTheDocument()
    expect(screen.queryByText("line 600")).not.toBeInTheDocument()

    // The reveal control reports exactly the hidden count (600 - 500).
    expect(
      screen.getByRole("button", { name: "Show 100 more lines" })
    ).toBeInTheDocument()
  })

  it("reveals all rows and drops the control once expanded", () => {
    renderWithIntl(<UnifiedDiffPreview diffText={newFileDiff(600)} />)

    fireEvent.click(screen.getByRole("button", { name: "Show 100 more lines" }))

    expect(screen.getByText("line 600")).toBeInTheDocument()
    expect(
      screen.queryByRole("button", { name: /more lines/ })
    ).not.toBeInTheDocument()
  })

  it("re-caps when the same preview receives a different large diff", () => {
    const { rerender } = renderWithIntl(
      <UnifiedDiffPreview diffText={newFileDiff(600)} />
    )
    // Fully expand the first diff.
    fireEvent.click(screen.getByRole("button", { name: "Show 100 more lines" }))
    expect(screen.getByText("line 600")).toBeInTheDocument()

    // A different, larger diff arrives at the same file position. Sections are
    // keyed positionally, so the instance is reused — the reveal must reset so
    // the new diff is capped again rather than rendered in full.
    rerender(<UnifiedDiffPreview diffText={newFileDiff(700)} />)

    expect(
      screen.getByRole("button", { name: "Show 200 more lines" })
    ).toBeInTheDocument()
    expect(screen.getByText("line 500")).toBeInTheDocument()
    expect(screen.queryByText("line 700")).not.toBeInTheDocument()
  })
})

/** A single-file modified diff: one context row, two deletions, one addition,
 *  one more context row — exercises the split pairing with unequal runs. */
function modifiedDiff(): string {
  return [
    "diff --git a/app.ts b/app.ts",
    "--- a/app.ts",
    "+++ b/app.ts",
    "@@ -1,5 1,4 @@",
    " keep one",
    "-old line A",
    "-old line B",
    "+new line A",
    " keep two",
  ].join("\n")
}

/** The unified rows `parseUnifiedDiff` derives from `modifiedDiff`, so the
 *  pairing unit tests feed the exact shape production renders. */
function modifiedRows(): ParsedDiffRow[] {
  return [
    { type: "context", text: "keep one", sign: " ", oldLine: 1, newLine: 1 },
    {
      type: "deleted",
      text: "old line A",
      sign: "-",
      oldLine: 2,
      newLine: null,
    },
    {
      type: "deleted",
      text: "old line B",
      sign: "-",
      oldLine: 3,
      newLine: null,
    },
    { type: "added", text: "new line A", sign: "+", oldLine: null, newLine: 2 },
    { type: "context", text: "keep two", sign: " ", oldLine: 4, newLine: 3 },
  ]
}

describe("UnifiedDiffPreview — side-by-side view", () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it("renders unified signs by default and keeps the split mode opt-in", () => {
    renderWithIntl(<UnifiedDiffPreview diffText={modifiedDiff()} />)

    expect(screen.getAllByText("+")).toHaveLength(1)
    expect(screen.getAllByText("-")).toHaveLength(2)
  })

  it("reads a persisted split preference before the first render", () => {
    localStorage.setItem("workspace:diff-view-mode", "split")
    renderWithIntl(<UnifiedDiffPreview diffText={modifiedDiff()} />)

    expect(screen.queryByText("+")).not.toBeInTheDocument()
    // Context rows now render once per side.
    expect(screen.getAllByText("keep one")).toHaveLength(2)
  })

  it("toggles to split, renders both sides, and persists the choice", () => {
    renderWithIntl(<UnifiedDiffPreview diffText={modifiedDiff()} />)

    fireEvent.click(
      screen.getByRole("button", { name: "Switch to side-by-side view" })
    )

    // No unified sign column anymore; both sides' texts are on screen.
    expect(screen.queryByText("+")).not.toBeInTheDocument()
    expect(screen.getAllByText("keep one")).toHaveLength(2)
    expect(screen.getByText("old line A")).toBeInTheDocument()
    expect(screen.getByText("new line A")).toBeInTheDocument()
    expect(localStorage.getItem("workspace:diff-view-mode")).toBe("split")
  })

  it("toggles back to unified and persists it", () => {
    localStorage.setItem("workspace:diff-view-mode", "split")
    renderWithIntl(<UnifiedDiffPreview diffText={modifiedDiff()} />)

    fireEvent.click(
      screen.getByRole("button", { name: "Switch to inline view" })
    )

    expect(screen.getByText("+")).toBeInTheDocument()
    expect(localStorage.getItem("workspace:diff-view-mode")).toBe("unified")
  })
})

describe("toSplitRows", () => {
  it("spans context rows across both sides", () => {
    const [row] = toSplitRows(modifiedRows().slice(0, 1))

    expect(row?.left).toEqual({
      line: 1,
      text: "keep one",
      marker: "none",
    })
    expect(row?.right).toEqual({
      line: 1,
      text: "keep one",
      marker: "none",
    })
  })

  it("pairs a delete-run with its add-run positionally", () => {
    const rows = toSplitRows(modifiedRows().slice(1, 4))

    expect(rows).toHaveLength(2)
    // First pair: old A faces new A.
    expect(rows[0]?.left).toMatchObject({
      text: "old line A",
      marker: "deleted",
    })
    expect(rows[0]?.right).toMatchObject({
      text: "new line A",
      marker: "added",
    })
    // The longer delete run leaves a filler cell on the right.
    expect(rows[1]?.left).toMatchObject({ text: "old line B" })
    expect(rows[1]?.right).toEqual({
      line: null,
      text: null,
      marker: "none",
    })
  })

  it("gives a pure insertion an empty left cell", () => {
    const rows = toSplitRows([
      { type: "added", text: "fresh", sign: "+", oldLine: null, newLine: 5 },
    ])

    expect(rows).toHaveLength(1)
    expect(rows[0]?.left).toEqual({ line: null, text: null, marker: "none" })
    expect(rows[0]?.right).toMatchObject({ text: "fresh", line: 5 })
  })
})
