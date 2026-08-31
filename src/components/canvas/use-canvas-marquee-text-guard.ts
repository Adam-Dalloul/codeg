"use client"

import { useEffect, type RefObject } from "react"

/**
 * Keeps a box-select from dragging a native text selection through the board.
 *
 * ReactFlow starts the marquee from the pane's own `pointerdown` and
 * deliberately does NOT `preventDefault` it in that case — `Pane`'s capture
 * handler only suppresses the default when the press landed on a CHILD
 * (`if (!eventTargetIsContainer) { stopPropagation(); preventDefault() }`).
 * The browser therefore does what it always does on a mouse-down: it drops a
 * text-selection anchor and extends the selection as the pointer moves — in
 * DOCUMENT order, which is why an expanded card's transcript highlighted even
 * when the marquee rectangle never went near it.
 *
 * `user-select: none` on the pane (see `globals.css`) refuses the anchor, but it
 * cannot be the whole fix, in both directions:
 *
 *  - A subtree that opts back IN is selectable again — the card body says
 *    `select-text` out loud, and `<input>`/`<textarea>` do it through the UA
 *    stylesheet. So the drag is hard-disabled for the whole surface while it
 *    runs, via `data-canvas-marquee` (the same shape as `data-canvas-panning`).
 *  - Refusing the anchor also refuses the side effect nobody notices until it is
 *    gone: pressing on blank space is what COLLAPSES the previous selection.
 *    Without it, a selection made inside a card stays lit no matter where the
 *    user clicks or marquees afterwards — the board looks like it is selecting
 *    text it never touched. Hence the explicit `removeAllRanges`.
 *
 * The press is matched with ReactFlow's own test for "a marquee is starting":
 * the event target IS the pane element. `.react-flow__background` is
 * `pointer-events: none`, so a press on empty board always lands there, and
 * everything else on the surface — cards, regions, the dock, the minimap — is a
 * descendant and never matches.
 */

/** Marks the surface for the duration of a pane-initiated left drag. */
const MARQUEE_ATTR = "data-canvas-marquee"

/** Left button in the `buttons` BITMASK (a different encoding from `button`,
 *  which numbers the left button 0). */
const PRIMARY_BUTTON_MASK = 1

export function useCanvasMarqueeTextGuard(
  surfaceRef: RefObject<HTMLElement | null>
): void {
  useEffect(() => {
    const surface = surfaceRef.current
    if (!surface) return

    const stop = () => {
      surface.removeAttribute(MARQUEE_ATTR)
      window.removeEventListener("mousemove", onMouseMove, true)
      window.removeEventListener("mouseup", onMouseUp, true)
      window.removeEventListener("blur", stop)
    }

    const onMouseUp = (e: MouseEvent) => {
      // Only the button that armed the guard may disarm it. Letting go of a
      // chorded right-click (the pan gesture) mid-marquee is still a `mouseup`,
      // and taking it would re-enable selection for the rest of a drag that is
      // very much still running.
      if (e.button === 0) stop()
    }

    const onMouseMove = (e: MouseEvent) => {
      // Nobody is holding the button any more: it was released somewhere this
      // window never heard about — over another application, or outside the
      // window entirely. Leaving the attribute on would make the whole board
      // permanently unselectable, so the release has to be inferred.
      if ((e.buttons & PRIMARY_BUTTON_MASK) === 0) stop()
    }

    const onMouseDown = (e: MouseEvent) => {
      if (e.button !== 0) return
      const target = e.target
      if (
        !(target instanceof Element) ||
        !target.classList.contains("react-flow__pane")
      ) {
        return
      }
      window.getSelection()?.removeAllRanges()
      surface.setAttribute(MARQUEE_ATTR, "")
      window.addEventListener("mousemove", onMouseMove, true)
      window.addEventListener("mouseup", onMouseUp, true)
      // Alt-tabbing away mid-drag: the release lands in another application and
      // no `mouseup` ever arrives here.
      window.addEventListener("blur", stop)
    }

    // Capture, and on the surface rather than the pane: the pane is mounted by
    // ReactFlow below this ref and is replaced whenever the flow remounts.
    surface.addEventListener("mousedown", onMouseDown, true)
    return () => {
      surface.removeEventListener("mousedown", onMouseDown, true)
      stop()
    }
  }, [surfaceRef])
}
