import { describe, expect, it } from "vitest"

import { buildQuotedMarkdown } from "./message-quote"

describe("buildQuotedMarkdown", () => {
  it("prefixes a single line", () => {
    expect(buildQuotedMarkdown("hello world")).toBe("> hello world")
  })

  it("prefixes every line of a multi-line selection", () => {
    expect(buildQuotedMarkdown("first\nsecond\nthird")).toBe(
      "> first\n> second\n> third"
    )
  })

  it("keeps interior blank lines inside the same blockquote", () => {
    // A bare `>` continues the quote; an empty line would end it and leave the
    // rest as unquoted prose.
    expect(buildQuotedMarkdown("para one\n\npara two")).toBe(
      "> para one\n>\n> para two"
    )
  })

  it("drops leading and trailing blank lines", () => {
    expect(buildQuotedMarkdown("\n\n  \nkept\n \n\n")).toBe("> kept")
  })

  it("normalizes CRLF and CR newlines", () => {
    expect(buildQuotedMarkdown("a\r\nb\rc")).toBe("> a\n> b\n> c")
  })

  it("drops per-line trailing whitespace so it can't become a hard break", () => {
    expect(buildQuotedMarkdown("a  \nb\t")).toBe("> a\n> b")
  })

  it("preserves leading indentation inside the quote", () => {
    expect(buildQuotedMarkdown("fn main() {\n    let x = 1;\n}")).toBe(
      "> fn main() {\n>     let x = 1;\n> }"
    )
  })

  it("leaves Markdown markers in the selection literal", () => {
    expect(buildQuotedMarkdown("# Title\n- item")).toBe("> # Title\n> - item")
  })

  it("returns an empty string for a blank selection", () => {
    expect(buildQuotedMarkdown("")).toBe("")
    expect(buildQuotedMarkdown("   \n\t\n")).toBe("")
  })
})
