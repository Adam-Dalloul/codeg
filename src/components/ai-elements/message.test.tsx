import { render, screen } from "@testing-library/react"
import type { ReactNode } from "react"
import { describe, expect, it, vi } from "vitest"

vi.mock("streamdown", () => ({
  Streamdown: ({
    children,
    className,
  }: {
    children: ReactNode
    className?: string
  }) => (
    <div className={className} data-testid="streamdown-root">
      {children}
    </div>
  ),
  defaultRemarkPlugins: {},
  defaultRehypePlugins: {},
}))

vi.mock("@streamdown/cjk", () => ({ cjk: {} }))
vi.mock("@streamdown/math", () => ({
  createMathPlugin: () => ({}),
}))
vi.mock("@streamdown/mermaid", () => ({ mermaid: {} }))
vi.mock("@streamdown/code", () => ({
  code: {
    highlight: vi.fn(),
    supportsLanguage: vi.fn(() => true),
  },
}))

vi.mock("@/components/ai-elements/link-safety", () => ({
  useStreamdownLinkSafety: () => ({ enabled: false }),
}))

import { MessageResponse, normalizeMathDelimiters } from "./message"

describe("MessageResponse", () => {
  it("applies marker styles so ordered Markdown lists render as lists", () => {
    render(<MessageResponse>{"1. First\n2. Second"}</MessageResponse>)

    expect(screen.getByTestId("streamdown-root")).toHaveClass(
      "[&_ol]:list-decimal",
      "[&_ol]:pl-3"
    )
  })
})

describe("normalizeMathDelimiters", () => {
  it("normalizes \\[...\\] to $$...$$", () => {
    expect(normalizeMathDelimiters("\\[ x^2 \\]")).toBe("$$ x^2 $$")
  })

  it("normalizes \\(...\\) to $$...$$", () => {
    expect(normalizeMathDelimiters("\\( y \\)")).toBe("$$ y $$")
  })

  it("does not rewrite currency or shell $ tokens", () => {
    // This helper only rewrites `\(`/`\[`. The real `$` fix is
    // `singleDollarTextMath: false` — covered in math-delimiters.parse.test.ts.
    const text = "Costs $25. Set $HOME and $1."
    expect(normalizeMathDelimiters(text)).toBe(text)
  })

  it("pads multi-line \\(...\\) at the start of a block so $$ is not a flow fence", () => {
    expect(normalizeMathDelimiters("\\(a\nb\\)")).toBe("\u200b$$a\nb$$")
    expect(normalizeMathDelimiters("\\(a\nb\n\\)")).toBe("\u200b$$a\nb$$\n")
  })

  it("moves a prefix-only closer line after $$ so it cannot fence", () => {
    expect(normalizeMathDelimiters("> \\(a\n> b\n> \\)")).toBe(
      "> \u200b$$a\n> b$$\n> "
    )
    expect(normalizeMathDelimiters("- Note:\n  \\(a\n  b\n  \\) holds.")).toBe(
      "- Note:\n  \u200b$$a\n  b$$\n   holds."
    )
  })

  it("treats +, indent, extra marker spaces, and list continuation as fence prefixes", () => {
    expect(normalizeMathDelimiters("+ \\(a\n  b\\)")).toBe("+ \u200b$$a\n  b$$")
    expect(normalizeMathDelimiters(" \\(a\nb\\)")).toBe(" \u200b$$a\nb$$")
    expect(normalizeMathDelimiters("   \\(a\nb\\)")).toBe("   \u200b$$a\nb$$")
    expect(normalizeMathDelimiters("-  \\(a\n   b\\)")).toBe(
      "-  \u200b$$a\n   b$$"
    )
    expect(normalizeMathDelimiters(">  \\(a\n>  b\\)")).toBe(
      ">  \u200b$$a\n>  b$$"
    )
    expect(
      normalizeMathDelimiters("- Note that\n  \\(a + b\n  = c\\) holds.")
    ).toBe("- Note that\n  \u200b$$a + b\n  = c$$ holds.")
  })

  it("canonicalizes CR / CRLF before offset logic", () => {
    // After LF fold, trailing newlines peel so the closer is not alone.
    expect(normalizeMathDelimiters("\\(a\r\n\\)")).toBe("$$a$$\n")
    expect(normalizeMathDelimiters("\\(a\rb\\)")).toBe("\u200b$$a\nb$$")
  })

  it("prefix scan stays linear on a deep failed prefix", () => {
    const text = `${"> ".repeat(40)}x \\(a\nb\\)`
    const start = performance.now()
    const out = normalizeMathDelimiters(text)
    expect(performance.now() - start).toBeLessThan(50)
    expect(out).toContain("$$a\nb$$")
    expect(out.startsWith("\u200b")).toBe(false)
  })

  it("does not pad mid-paragraph multi-line \\(...\\)", () => {
    expect(normalizeMathDelimiters("text \\(a\nb\\) tail")).toBe(
      "text $$a\nb$$ tail"
    )
  })

  it("does not collapse newlines inside \\(...\\) (TeX % comments)", () => {
    expect(normalizeMathDelimiters("\\(a % comment\nb + c\\)")).toBe(
      "\u200b$$a % comment\nb + c$$"
    )
  })

  it("preserves inline and fenced code blocks", () => {
    expect(normalizeMathDelimiters("Use `$x` in `\\(y\\)`")).toBe(
      "Use `$x` in `\\(y\\)`"
    )
    expect(normalizeMathDelimiters("```\n\\(a\\)\n```")).toBe(
      "```\n\\(a\\)\n```"
    )
  })

  it("normalizes mixed LaTeX and currency correctly", () => {
    const input = "Costs $25 and the equation \\(x^2 + y^2\\)."
    const expected = "Costs $25 and the equation $$x^2 + y^2$$."
    expect(normalizeMathDelimiters(input)).toBe(expected)
  })
})
