import { describe, expect, it } from "vitest"
import {
  hasCodexVisualizeRef,
  isCompleteHtmlDocument,
  parseCodexVisualizeArgs,
  splitCodexVisualizeRefs,
} from "./codex-visualize"

const marker = (json: string) => `visualize${json}`

describe("parseCodexVisualizeArgs", () => {
  it("accepts a path and defaults the mode", () => {
    expect(parseCodexVisualizeArgs('{"path":"/tmp/a.html"}')).toEqual({
      path: "/tmp/a.html",
      mode: "normal",
    })
  })
  it("recognises wide mode and ignores unknown modes", () => {
    expect(
      parseCodexVisualizeArgs('{"path":"/tmp/a.html","mode":"wide"}')?.mode
    ).toBe("wide")
    expect(
      parseCodexVisualizeArgs('{"path":"/tmp/a.html","mode":"huge"}')?.mode
    ).toBe("normal")
  })
  it("rejects malformed payloads", () => {
    expect(parseCodexVisualizeArgs("not json")).toBeNull()
    expect(parseCodexVisualizeArgs('{"mode":"wide"}')).toBeNull()
    expect(parseCodexVisualizeArgs('{"path":"  "}')).toBeNull()
    expect(parseCodexVisualizeArgs('["/tmp/a.html"]')).toBeNull()
  })
})

describe("splitCodexVisualizeRefs", () => {
  it("returns plain text untouched", () => {
    const text = "Just prose, nothing to visualize{here}."
    expect(hasCodexVisualizeRef(text)).toBe(false)
    expect(splitCodexVisualizeRefs(text)).toEqual([{ kind: "markdown", text }])
  })

  it("splits a reply around a marker on its own line", () => {
    const text = `Here is the chart.\n\n${marker('{"path":"/v/chart.html"}')}\n\nLet me know.`
    expect(splitCodexVisualizeRefs(text)).toEqual([
      { kind: "markdown", text: "Here is the chart.\n\n" },
      {
        kind: "visualize",
        ref: { path: "/v/chart.html", mode: "normal" },
        raw: marker('{"path":"/v/chart.html"}'),
      },
      { kind: "markdown", text: "\nLet me know." },
    ])
  })

  it("handles a marker as the whole reply and several markers", () => {
    const a = marker('{"path":"/v/a.html"}')
    const b = marker('{"path":"/v/b.html","mode":"wide"}')
    const segments = splitCodexVisualizeRefs(`${a}\n${b}`)
    expect(segments.map((s) => s.kind)).toEqual(["visualize", "visualize"])
    expect(segments[1]).toMatchObject({ ref: { mode: "wide" } })
  })

  it("keeps text written on the same line as the marker", () => {
    const segments = splitCodexVisualizeRefs(
      `See: ${marker('{"path":"/v/a.html"}')} (interactive)`
    )
    expect(segments).toEqual([
      { kind: "markdown", text: "See: " },
      expect.objectContaining({ kind: "visualize" }),
      { kind: "markdown", text: " (interactive)" },
    ])
  })

  it("leaves markers inside fenced code blocks alone", () => {
    const text = "Use:\n```text\n" + marker('{"path":"/v/a.html"}') + "\n```\n"
    expect(splitCodexVisualizeRefs(text)).toEqual([{ kind: "markdown", text }])
  })

  it("keeps a malformed marker visible as text", () => {
    const bad = marker("{oops")
    expect(splitCodexVisualizeRefs(`x ${bad} y`)).toEqual([
      { kind: "markdown", text: `x ${bad} y` },
    ])
  })

  it("ignores an unterminated marker while it is still streaming", () => {
    const partial = 'visualize{"path":"/v/a.ht'
    expect(splitCodexVisualizeRefs(partial)).toEqual([
      { kind: "markdown", text: partial },
    ])
  })
})

describe("isCompleteHtmlDocument", () => {
  it("tells fragments from documents", () => {
    expect(isCompleteHtmlDocument('<div class="card">hi</div>')).toBe(false)
    expect(isCompleteHtmlDocument("<!doctype html><html></html>")).toBe(true)
    expect(isCompleteHtmlDocument("<body>x</body>")).toBe(true)
  })
})
