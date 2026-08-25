import { describe, expect, it } from "vitest"
import { getAddToChatPillPlacement } from "./add-to-chat-pill-placement"

// Measured in Chrome against monaco-editor 0.55.1 with the shipped defaults
// (editor font 13 => 20px lines on macOS / 18px on Windows, pill box 25px).
const PILL_HEIGHT = 25
const LINE_HEIGHT = 20

describe("getAddToChatPillPlacement", () => {
  it("keeps a first-line selection below the editor chrome", () => {
    // Anchor flush with the viewport top: zero room above.
    expect(getAddToChatPillPlacement(0, PILL_HEIGHT)).toEqual([
      "below",
      "above",
    ])
  })

  it("keeps a second-line selection below the editor chrome", () => {
    // One line of room (20px) is still less than the pill (25px), so ABOVE
    // would clip the pill's top edge into the file path bar.
    expect(getAddToChatPillPlacement(LINE_HEIGHT, PILL_HEIGHT)).toEqual([
      "below",
      "above",
    ])
  })

  it("keeps the existing above-first placement once the pill clears the top", () => {
    expect(getAddToChatPillPlacement(2 * LINE_HEIGHT, PILL_HEIGHT)).toEqual([
      "above",
      "below",
    ])
  })

  it("treats an exactly-fitting gap as room enough for above", () => {
    expect(getAddToChatPillPlacement(PILL_HEIGHT, PILL_HEIGHT)).toEqual([
      "above",
      "below",
    ])
  })

  it("keeps the existing above-first placement deep in the viewport", () => {
    expect(getAddToChatPillPlacement(180, PILL_HEIGHT)).toEqual([
      "above",
      "below",
    ])
  })

  it("goes below for a top line that is only partially scrolled into view", () => {
    // A 1.5-line scroll leaves 10px above the anchor — Monaco's page-relative
    // check still says ABOVE fits, but it does not.
    expect(getAddToChatPillPlacement(10, PILL_HEIGHT)).toEqual([
      "below",
      "above",
    ])
  })

  it("goes below for an anchor scrolled above the viewport", () => {
    expect(getAddToChatPillPlacement(-40, PILL_HEIGHT)).toEqual([
      "below",
      "above",
    ])
  })

  it("falls back to the existing order when the anchor top is unknown", () => {
    expect(getAddToChatPillPlacement(null, PILL_HEIGHT)).toEqual([
      "above",
      "below",
    ])
  })

  it("scales with the pill: a taller (zoomed) pill needs more room", () => {
    expect(getAddToChatPillPlacement(40, 50)).toEqual(["below", "above"])
    expect(getAddToChatPillPlacement(60, 50)).toEqual(["above", "below"])
  })
})
