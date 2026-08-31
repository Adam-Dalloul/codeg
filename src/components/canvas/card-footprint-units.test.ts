import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { describe, expect, it } from "vitest"
import {
  CARD_HEIGHT,
  CARD_WIDTH,
  CARD_GAP,
  REGION_PADDING,
  regionWidthForColumns,
} from "./canvas-model"

/**
 * Guard for the canvas's one hard geometry rule.
 *
 * `canvas-model.ts` positions member cards on a PIXEL grid (CARD_WIDTH /
 * CARD_HEIGHT) and ReactFlow applies those numbers as inline `width`/`height`
 * on each node wrapper. The card component must therefore fill its wrapper and
 * never state a size of its own in `rem`: the zoom control writes
 * `font-size: 16 * zoom/100` onto `<html>` (see `appearance-provider.tsx`), so
 * a `w-56 h-[8.25rem]` card renders 246×145 at 125% while its grid slot stays
 * 224×132 — cards overlap their neighbours and the last column spills past the
 * region border.
 *
 * That is exactly how the bug shipped the first time, with the constants and
 * the classNames sitting in two files that agreed only by coincidence. This
 * test is the coupling made explicit.
 */

function readCard(name: string): string {
  return readFileSync(
    resolve(process.cwd(), `src/components/canvas/nodes/${name}`),
    "utf8"
  )
}

/** Tailwind width/height utilities that resolve through the root font size
 *  (`w-56` = 14rem, `h-[8.25rem]`). Deliberately NOT applied to icons or
 *  popovers, which SHOULD scale with the user's zoom — only to the card boxes
 *  ReactFlow has already sized in pixels. */
const REM_SIZING =
  /\b(?:w|h|min-w|min-h|max-w|max-h)-(?:\d+(?:\.\d+)?|\[[^\]]*rem[^\]]*\])\b/g

/** Utilities that are safe because they don't resolve against a font size. */
const ALLOWED = new Set(["w-full", "h-full", "min-w-0", "min-h-0"])

/** The className strings of the card ROOT elements — the ones the node wrapper
 *  sizes. Comments are stripped first so prose about the old bug can't trip the
 *  scan. */
function cardRoots(source: string): string[] {
  const code = source.replace(/\/\*[\s\S]*?\*\//g, "")
  const roots = code.match(/"flex h-[^"]*w-[^"]*"/g) ?? []
  expect(roots.length).toBeGreaterThan(0)
  return roots
}

describe("canvas card footprint", () => {
  it("conversation cards size themselves from the node wrapper, not from rem", () => {
    for (const root of cardRoots(readCard("conversation-card-node.tsx"))) {
      expect(root).toContain("h-full")
      expect(root).toContain("w-full")
    }
  })

  it("no rem-based sizing utility survives on a card root", () => {
    for (const root of cardRoots(readCard("conversation-card-node.tsx"))) {
      const offenders = (root.match(REM_SIZING) ?? []).filter(
        (u) => !ALLOWED.has(u)
      )
      expect(offenders).toEqual([])
    }
  })

  it("the expanded card keeps its body selectable and drags by its title bar", () => {
    // ReactFlow's own stylesheet puts `user-select: none` on every
    // `.react-flow__node`, so a conversation rendered inside one cannot be
    // selected or copied unless the body says otherwise out loud — and the
    // title bar has to carry the drag-handle class the node points `dragHandle`
    // at, or the whole card becomes draggable again and clicking into the
    // composer hauls it around. Both are invisible in review and only show up
    // when someone tries to copy a line of output.
    const source = readCard("conversation-detail-node.tsx")
    expect(source).toContain("select-text")
    expect(source).toContain("DRAG_HANDLE_CLASS")
  })

  it("the default region width is an exact multiple of the card grid", () => {
    // Zero slack is fine — and correct — now that the card can't outgrow its
    // slot. It is NOT fine if anything ever rounds: a single stray pixel would
    // drop a whole column.
    const width = regionWidthForColumns(3)
    expect(width).toBe(REGION_PADDING * 2 + 3 * CARD_WIDTH + 2 * CARD_GAP)
    expect(Number.isInteger(width)).toBe(true)
    expect(Number.isInteger(CARD_WIDTH)).toBe(true)
    expect(Number.isInteger(CARD_HEIGHT)).toBe(true)
  })
})
