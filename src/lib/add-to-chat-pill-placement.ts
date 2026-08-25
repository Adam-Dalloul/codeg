export type AddToChatPillPlacement = "above" | "below"

/**
 * Orders the placement preferences Monaco walks for the "Add to Chat" pill.
 *
 * The pill is an `allowEditorOverflow` content widget, and for those Monaco
 * runs `_layoutBoxInPage`, which asks whether the widget fits above the anchor
 * *in the page* (`absoluteAboveTop >= 22`) instead of *in the editor viewport*.
 * Every pixel the surrounding app chrome occupies — tab strip, file path bar —
 * therefore reads as free space, ABOVE always "fits", and the pill renders past
 * the editor's top edge where that chrome covers it.
 *
 * So re-run the test Monaco applies to non-overflowing widgets
 * (`_layoutBoxInViewport`: `fitsAbove = anchor.top >= height`) against the
 * editor viewport, and demote ABOVE whenever the anchor line does not have a
 * whole pill's worth of room above it. Monaco still makes the final call — this
 * only reorders the list it walks, so its own BELOW/bottom-edge handling and
 * its force-first-preference second pass are untouched.
 *
 * @param spaceAboveAnchorPx Pixels from the top edge of the editor viewport to
 *   the top of the anchor line — Monaco's own `anchor.top`, i.e.
 *   `editor.getTopForPosition(line, column) - editor.getScrollTop()`. Pass
 *   `null` when it cannot be read; the pre-existing ABOVE-first order is kept.
 * @param pillHeightPx Rendered height of the pill, in px.
 */
export function getAddToChatPillPlacement(
  spaceAboveAnchorPx: number | null,
  pillHeightPx: number
): AddToChatPillPlacement[] {
  return spaceAboveAnchorPx === null || spaceAboveAnchorPx >= pillHeightPx
    ? ["above", "below"]
    : ["below", "above"]
}
