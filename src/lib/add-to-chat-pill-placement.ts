export type AddToChatPillPlacement = "above" | "below"

/**
 * Prefer placing the selection action inside the editor when its anchor is on
 * the top visible line. Monaco's overflow layout otherwise considers space in
 * the surrounding page valid and can render the pill over the file header.
 */
export function getAddToChatPillPlacement(
  anchorLineNumber: number,
  firstVisibleLineNumber: number | null
): AddToChatPillPlacement[] {
  return firstVisibleLineNumber !== null &&
    anchorLineNumber <= firstVisibleLineNumber
    ? ["below", "above"]
    : ["above", "below"]
}
