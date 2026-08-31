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
 * Guard for the canvas's one hard geometry rule: THE BOARD HAS ITS OWN UNITS,
 * and both halves of every board element have to live in them.
 *
 * `canvas-model.ts` positions elements on a grid of plain numbers (CARD_WIDTH /
 * CARD_HEIGHT), ReactFlow applies them as inline `width`/`height`, SQLite stores
 * them and the Rust side mirrors them. They cannot follow the appearance zoom,
 * which writes `font-size: 16 * zoom/100` onto `<html>` (see
 * `appearance-provider.tsx`) — a rem is not a coordinate.
 *
 * So a board element must neither size ITSELF in rem (a `w-56 h-[8.25rem]` card
 * renders 246×145 at 125% while its slot stays 224×132, and cards overlap their
 * neighbours), nor fill itself with rem CONTENTS (a fixed 132-tall box whose
 * type grew by 50% clipped its title through the middle of a line). The first
 * half shipped as a bug once, the second half three times.
 */

function readNode(name: string): string {
  return readFileSync(
    resolve(process.cwd(), `src/components/canvas/nodes/${name}`),
    "utf8"
  )
}

function readSource(path: string): string {
  return readFileSync(resolve(process.cwd(), path), "utf8")
}

/** Tailwind width/height utilities that resolve through the root font size
 *  (`w-56` = 14rem, `h-[8.25rem]`). Deliberately NOT applied to icons or
 *  popovers, which SHOULD scale with the user's zoom — only to the card boxes
 *  ReactFlow has already sized in pixels. */
const REM_SIZING =
  /\b(?:w|h|min-w|min-h|max-w|max-h)-(?:\d+(?:\.\d+)?|\[[^\]]*rem[^\]]*\])\b/g

/** Utilities that are safe because they don't resolve against a font size. */
const ALLOWED = new Set(["w-full", "h-full", "min-w-0", "min-h-0"])

/** Every board element and the root element the board sizes. All four opt out
 *  of the appearance zoom the same way. */
const BOARD_NODES = [
  "conversation-card-node.tsx",
  "conversation-detail-node.tsx",
  "region-node.tsx",
  "note-node.tsx",
] as const

/** The className strings of the card ROOT elements — the ones the node wrapper
 *  sizes. Comments are stripped first so prose about the old bug can't trip the
 *  scan. */
function cardRoots(source: string): string[] {
  const code = source.replace(/\/\*[\s\S]*?\*\//g, "")
  const roots = code.match(/"[^"]*flex h-[^"]*w-[^"]*"/g) ?? []
  expect(roots.length).toBeGreaterThan(0)
  return roots
}

/** Source with comments stripped, so a `0.8125rem` mentioned in prose doesn't
 *  read as a declaration. */
function code(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "")
}

describe("canvas card footprint", () => {
  it("conversation cards size themselves from the node wrapper, not from rem", () => {
    for (const root of cardRoots(readNode("conversation-card-node.tsx"))) {
      expect(root).toContain("h-full")
      expect(root).toContain("w-full")
    }
  })

  it("no rem-based sizing utility survives on a card root", () => {
    for (const root of cardRoots(readNode("conversation-card-node.tsx"))) {
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
    const source = readNode("conversation-detail-node.tsx")
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

describe("board units", () => {
  it.each(BOARD_NODES)("%s opts its subtree out of the app zoom", (name) => {
    // One class per board element, on the root the node wrapper sizes. Miss one
    // and that element alone keeps double-scaling — invisible at 100%, which is
    // where it will be reviewed.
    expect(code(readNode(name))).toContain("canvas-board-units")
  })

  it.each(BOARD_NODES)("%s states its type sizes in board units", (name) => {
    // `text-[0.8125rem]` and friends resolve against the root font size no
    // matter what the scope redefines, because they name the unit themselves.
    // Everything else — `p-3`, `size-3.5`, `text-xs`, `rounded-xl` — goes
    // through `--spacing` / `--text-*` / `--radius` and is converted for free.
    expect(code(readNode(name))).not.toMatch(/\[[\d.]+rem\]/)
  })

  it("the scope actually redefines the variables Tailwind sizes through", () => {
    const css = readSource("src/app/globals.css")
    const block = css.match(/\.canvas-board-units\s*\{([^}]*)\}/)
    expect(block, "no .canvas-board-units rule in globals.css").not.toBeNull()
    const body = block![1]
    // `--spacing` alone covers every padding, gap, margin and `size-*`;
    // `--text-*` covers the type scale; `--radius` covers `rounded-*`.
    expect(body).toMatch(/--spacing:\s*\d+px/)
    expect(body).toMatch(/--text-xs:\s*\d+px/)
    expect(body).toMatch(/--text-sm:\s*\d+px/)
    expect(body).toMatch(/--text-base:\s*\d+px/)
    expect(body).toMatch(/--radius:\s*\d+px/)
    // The two INHERITED metrics, which no variable covers.
    expect(body).toMatch(/font-size:\s*16px/)
    expect(body).toMatch(/line-height:\s*1\.5(?!\w)/)
  })

  it("restates line-height without a unit", () => {
    // `:root` declares it in `em` on purpose (a rem there is frozen at 16px in
    // WebKit — see the note in globals.css), and an em line-height computes to
    // an absolute LENGTH before it inherits. So a board element that only fixes
    // font sizes still inherits the root's 36px line box at 150% zoom, which is
    // enough to burst a region's fixed 40px header. Unitless is the whole fix,
    // and it is invisible until someone changes the zoom.
    const css = readSource("src/app/globals.css")
    const body = css.match(/\.canvas-board-units\s*\{([^}]*)\}/)![1]
    expect(body).not.toMatch(/line-height:[^;]*e?m\s*;/)
  })

  it("the collapsed card's title takes every whole line the box has room for", () => {
    // The point of board units: this arithmetic is a CONSTANT now, so the clamp
    // can be one too. 132 box − 51.75 chrome (16 padding + 14 top row + 4 + 4 +
    // 13.75 footer) = 80.25, and four 17.875 lines (13px × leading-snug) fit
    // with room to spare. Clamping lower truncates a title the card has space
    // for (the complaint); higher would clip a line in half, since `line-clamp`
    // clips to the box rather than to whole lines.
    const source = code(readNode("conversation-card-node.tsx"))
    expect(source).toContain("line-clamp-4")
    expect(source).toContain("text-[13px]")
    expect(source).toContain("leading-snug")
    expect(51.75 + 4 * 17.875).toBeLessThanOrEqual(CARD_HEIGHT)
    expect(51.75 + 5 * 17.875).toBeGreaterThan(CARD_HEIGHT)
  })
})
