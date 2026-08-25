import { describe, expect, it } from "vitest"
import { getAddToChatPillPlacement } from "./add-to-chat-pill-placement"

describe("getAddToChatPillPlacement", () => {
  it("keeps a first-line selection below the editor chrome", () => {
    expect(getAddToChatPillPlacement(1, 1)).toEqual(["below", "above"])
  })

  it("keeps the existing above-first placement for normal lines", () => {
    expect(getAddToChatPillPlacement(8, 1)).toEqual(["above", "below"])
  })

  it("keeps the existing above-first placement near the viewport bottom", () => {
    expect(getAddToChatPillPlacement(20, 1)).toEqual(["above", "below"])
  })

  it("places a scrolled viewport's top line below the chrome", () => {
    expect(getAddToChatPillPlacement(12, 12)).toEqual(["below", "above"])
  })

  it("falls back to the existing order before Monaco reports a viewport", () => {
    expect(getAddToChatPillPlacement(1, null)).toEqual(["above", "below"])
  })
})
