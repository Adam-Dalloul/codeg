import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { describe, expect, it } from "vitest"

/**
 * Guard for the one-line CSS rule that keeps a marquee from dragging a native
 * text selection through the board.
 *
 * ReactFlow starts the marquee from the pane's `pointerdown`, and deliberately
 * does NOT `preventDefault` it when the press landed on the pane itself (it only
 * does so for a press on a child — see `Pane.onPointerDownCapture` in
 * `@xyflow/react`). The browser therefore anchors a text selection on the pane
 * too, and the drag extends it in DOCUMENT order — so an expanded card's
 * transcript highlighted even when the marquee rectangle never touched it.
 *
 * `user-select: none` on the pane refuses the anchor. It reads like dead styling
 * ("nothing on the pane is text"), which is exactly why it needs a test: the
 * rule protects descendants, not itself, and the bug it prevents is invisible
 * until someone drags across a live card.
 */

function readSource(path: string): string {
  return readFileSync(resolve(process.cwd(), path), "utf8")
}

/** The declaration block of `.canvas-surface .react-flow__pane`, comments
 *  stripped so prose about the bug can't satisfy the assertion. */
function paneRule(css: string): string {
  const code = css.replace(/\/\*[\s\S]*?\*\//g, "")
  const match = code.match(
    /\.canvas-surface\s+\.react-flow__pane\s*\{([^}]*)\}/
  )
  expect(
    match,
    "no .canvas-surface .react-flow__pane rule in globals.css"
  ).not.toBeNull()
  return match![1]
}

describe("canvas marquee vs native text selection", () => {
  it("the pane refuses to start a text selection", () => {
    expect(paneRule(readSource("src/app/globals.css"))).toMatch(
      /user-select:\s*none/
    )
  })

  it("the expanded card still opts its own body back in", () => {
    // The pane rule is only safe because the card overrides it for the one
    // subtree that IS text. Drop `select-text` and this fix silently becomes
    // "you can no longer copy anything off the canvas".
    expect(
      readSource("src/components/canvas/nodes/conversation-detail-node.tsx")
    ).toContain("select-text")
  })

  it("the board still draws a marquee on left-drag", () => {
    // The other way to "fix" this is to stop left-drag from selecting at all
    // (`panOnDrag={[0]}`, or dropping `selectionOnDrag`). That would trade the
    // bug for the loss of box-select, so pin the gesture down here.
    const view = readSource("src/components/canvas/canvas-view.tsx")
    expect(view).toContain("selectionOnDrag")
    expect(view).toContain("panOnDrag={[]}")
  })
})
