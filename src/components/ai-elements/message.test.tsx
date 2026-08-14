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

  it("preserves currency values as plain text", () => {
    const text = "Costs $25 direct and $13 elsewhere."
    expect(normalizeMathDelimiters(text)).toBe(text)
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
