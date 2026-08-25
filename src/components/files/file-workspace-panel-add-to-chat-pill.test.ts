import { readFileSync } from "node:fs"
import { resolve } from "node:path"

import { describe, expect, it } from "vitest"

const panelSource = readFileSync(
  resolve(process.cwd(), "src/components/files/file-workspace-panel.tsx"),
  "utf8"
)

// The pill's placement only misbehaves against a real Monaco layout (see
// add-to-chat-pill-placement.test.ts for the decision itself), so these guard
// the wiring that unit tests cannot reach: that the decision is fed Monaco's
// own viewport-relative anchor offset, and that it is re-run on the two events
// that invalidate it.
describe("file-workspace-panel add-to-chat pill placement wiring", () => {
  it("feeds the placement helper the viewport-relative anchor offset", () => {
    // Not the raw `getTopForPosition`: that is content-relative, and dropping
    // the scrollTop term silently reinstates the bug for every scrolled file.
    expect(panelSource).toMatch(
      /getTopForPosition\([\s\S]{0,120}getAddToChatPillPlacement\(\s*anchorTop < 0 \? null : anchorTop - editor\.getScrollTop\(\)/
    )
    expect(panelSource).toMatch(
      /measuredHeight \|\| ADD_TO_CHAT_PILL_FALLBACK_HEIGHT_PX/
    )
  })

  it("re-lays out once the hidden-until-shown pill can finally be measured", () => {
    expect(panelSource).toMatch(
      /if \(pill\.remeasure\(\)\) editorInstance\.layoutContentWidget\(pill\.widget\)/
    )
  })

  it("re-decides the placement when the anchor is scrolled vertically", () => {
    // Monaco latches the preference at layout time, so a visible pill keeps a
    // stale above/below choice until something lays it out again.
    expect(panelSource).toMatch(
      /onDidScrollChange\(\(event\) => \{[\s\S]{0,160}event\.scrollTopChanged && pill\.isVisible\(\)[\s\S]{0,120}layoutContentWidget\(pill\.widget\)/
    )
  })

  it("disposes the scroll listener with the rest of the add-to-chat teardown", () => {
    expect(panelSource).toMatch(
      /scrollListenerRef\.current\?\.dispose\(\)\s*\n\s*scrollListenerRef\.current = null/
    )
  })
})
