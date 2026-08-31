import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { renderHook } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { useCanvasMarqueeTextGuard } from "./use-canvas-marquee-text-guard"

/**
 * The board must not drag a native text selection along with a box-select.
 *
 * ReactFlow starts the marquee from the pane's own `pointerdown` and
 * deliberately leaves the browser's default alone in that case (it only calls
 * `preventDefault` when the press landed on a CHILD — see
 * `Pane.onPointerDownCapture` in `@xyflow/react`), so the press behaves like any
 * other: it anchors a selection and the drag extends it in DOCUMENT order,
 * highlighting cards the rectangle never touched.
 *
 * Two halves, tested here in that order: the hook that brackets the gesture, and
 * the stylesheet it drives.
 */

function readSource(path: string): string {
  return readFileSync(resolve(process.cwd(), path), "utf8")
}

const MARQUEE_ATTR = "data-canvas-marquee"

/** A miniature of the real DOM: the surface the hook is given, ReactFlow's pane
 *  inside it, and one node inside that (a card). */
function mountSurface() {
  const surface = document.createElement("div")
  surface.className = "canvas-surface"
  const pane = document.createElement("div")
  pane.className = "react-flow__pane"
  const card = document.createElement("div")
  card.className = "react-flow__node"
  pane.appendChild(card)
  surface.appendChild(pane)
  document.body.appendChild(surface)
  return { surface, pane, card }
}

function press(target: Element, button = 0) {
  target.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button }))
}

function release(target: Element, button = 0) {
  target.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, button }))
}

/** Stands in for the document's selection so the assertion is "we collapsed
 *  whatever was selected", not jsdom's own Selection bookkeeping. */
function stubSelection() {
  const removeAllRanges = vi.fn()
  vi.spyOn(window, "getSelection").mockReturnValue({
    removeAllRanges,
  } as unknown as Selection)
  return removeAllRanges
}

afterEach(() => {
  vi.restoreAllMocks()
  document.body.innerHTML = ""
})

describe("useCanvasMarqueeTextGuard", () => {
  it("marks the surface and collapses the old selection when a marquee starts", () => {
    const removeAllRanges = stubSelection()
    const { surface, pane } = mountSurface()
    renderHook(() => useCanvasMarqueeTextGuard({ current: surface }))

    press(pane)

    expect(surface.hasAttribute(MARQUEE_ATTR)).toBe(true)
    // The half that is invisible until it's missing: `user-select: none` on the
    // pane also refuses the press's OTHER default — collapsing what was already
    // selected — so a selection made inside a card would otherwise stay lit
    // however much blank board the user clicked afterwards.
    expect(removeAllRanges).toHaveBeenCalledTimes(1)
  })

  it("lets go on mouseup", () => {
    stubSelection()
    const { surface, pane } = mountSurface()
    renderHook(() => useCanvasMarqueeTextGuard({ current: surface }))

    press(pane)
    release(pane)

    // Leaving the attribute on would make the whole board permanently
    // unselectable — the failure mode is silent and only shows up as "I can't
    // copy anything off this canvas any more".
    expect(surface.hasAttribute(MARQUEE_ATTR)).toBe(false)
  })

  it("keeps holding when a chorded second button is released", () => {
    stubSelection()
    const { surface, pane } = mountSurface()
    renderHook(() => useCanvasMarqueeTextGuard({ current: surface }))

    press(pane)
    // Right-click during a marquee is the pan gesture; its release says nothing
    // about the left button, which is still drawing the rectangle.
    release(pane, 2)
    expect(surface.hasAttribute(MARQUEE_ATTR)).toBe(true)

    release(pane)
    expect(surface.hasAttribute(MARQUEE_ATTR)).toBe(false)
  })

  it("lets go when the button was released outside the window", () => {
    stubSelection()
    const { surface, pane } = mountSurface()
    renderHook(() => useCanvasMarqueeTextGuard({ current: surface }))

    press(pane)
    // A move with no buttons held: the release happened over another
    // application, so no `mouseup` will ever arrive here.
    window.dispatchEvent(new MouseEvent("mousemove", { buttons: 0 }))

    expect(surface.hasAttribute(MARQUEE_ATTR)).toBe(false)
  })

  it("ignores a press that lands on a node rather than the pane", () => {
    const removeAllRanges = stubSelection()
    const { surface, card } = mountSurface()
    renderHook(() => useCanvasMarqueeTextGuard({ current: surface }))

    press(card)

    // Pressing inside a card is how a user selects text there — the guard must
    // not touch it. This is ReactFlow's own test for "a marquee is starting"
    // (`event.target === container`), so the two can't disagree.
    expect(surface.hasAttribute(MARQUEE_ATTR)).toBe(false)
    expect(removeAllRanges).not.toHaveBeenCalled()
  })

  it("ignores the pan button", () => {
    const removeAllRanges = stubSelection()
    const { surface, pane } = mountSurface()
    renderHook(() => useCanvasMarqueeTextGuard({ current: surface }))

    press(pane, 2)

    expect(surface.hasAttribute(MARQUEE_ATTR)).toBe(false)
    expect(removeAllRanges).not.toHaveBeenCalled()
  })

  it("stops listening when the board unmounts mid-drag", () => {
    const removeAllRanges = stubSelection()
    const { surface, pane } = mountSurface()
    const { unmount } = renderHook(() =>
      useCanvasMarqueeTextGuard({ current: surface })
    )

    press(pane)
    unmount()

    expect(surface.hasAttribute(MARQUEE_ATTR)).toBe(false)
    press(pane)
    expect(removeAllRanges).toHaveBeenCalledTimes(1)
  })
})

describe("the stylesheet the guard drives", () => {
  /** A rule's declaration block, comments stripped so prose about the bug can't
   *  satisfy the assertion. */
  function ruleBody(css: string, selector: RegExp): string {
    const code = css.replace(/\/\*[\s\S]*?\*\//g, "")
    const match = code.match(selector)
    expect(match, `no rule matching ${selector} in globals.css`).not.toBeNull()
    return match![1]
  }

  it("refuses to start a selection on the pane", () => {
    expect(
      ruleBody(
        readSource("src/app/globals.css"),
        /\.canvas-surface\s+\.react-flow__pane\s*\{([^}]*)\}/
      )
    ).toMatch(/user-select:\s*none/)
  })

  it("hard-disables selection everywhere while the marquee runs", () => {
    // `!important`, and reaching every descendant, is the point: the pane rule
    // above is overridden by anything that opts back in, and two things do —
    // the card body's `select-text` and the UA stylesheet's rule for form
    // controls. Without this the sweep still lights up a transcript.
    const body = ruleBody(
      readSource("src/app/globals.css"),
      /\.canvas-surface\[data-canvas-marquee\],\s*\.canvas-surface\[data-canvas-marquee\]\s*\*\s*\{([^}]*)\}/
    )
    expect(body).toMatch(/user-select:\s*none\s*!important/)
  })

  it("still lets an expanded card opt its own body back in", () => {
    // The rules above are only acceptable because the card overrides them
    // outside the gesture. Drop `select-text` and this fix silently becomes
    // "you can no longer copy anything off the canvas".
    expect(
      readSource("src/components/canvas/nodes/conversation-detail-node.tsx")
    ).toContain("select-text")
  })

  it("still draws a marquee on left-drag", () => {
    // The other way to "fix" this is to stop left-drag from selecting at all
    // (`panOnDrag={[0]}`, or dropping `selectionOnDrag`). That would trade the
    // bug for the loss of box-select, so pin the gesture down here.
    const view = readSource("src/components/canvas/canvas-view.tsx")
    expect(view).toContain("selectionOnDrag")
    expect(view).toContain("panOnDrag={[]}")
  })
})
