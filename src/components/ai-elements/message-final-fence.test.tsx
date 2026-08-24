import { act, render } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"

vi.mock("@/components/ai-elements/link-safety", () => ({
  useStreamdownLinkSafety: () => ({ enabled: false }),
}))

import { MessageResponse } from "./message"

// The #555 shape: a reply that mentions `_meta`-style tokens earlier and ends
// exactly at a closing fence. Under mode="streaming", remend appends a `_`
// closer after the final ``` and the fence stops closing, so the block renders
// "```_" as content. The static default must keep the block intact.
const REPLY =
  "Files: `_meta` and `R27QD_REPORT.md` done.\n\nSHA-256:\n\n```text\nabc123\n```"

describe("MessageResponse finished reply ending at a code fence", () => {
  it("keeps the final fence closed", async () => {
    const r = render(<MessageResponse>{REPLY}</MessageResponse>)
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 400))
    })
    const text = r.container.textContent ?? ""
    expect(text).toContain("abc123")
    expect(text).not.toContain("```")
    expect(text).not.toContain("```_")
  })
})
