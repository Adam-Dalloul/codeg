import { unified } from "unified"
import remarkParse from "remark-parse"
import remarkMath from "remark-math"
import { visit } from "unist-util-visit"
import { describe, expect, it } from "vitest"
import { normalizeMathDelimiters } from "./message"

interface MathNode {
  type: "inlineMath" | "math"
  value: string
  meta: string | null
}

function parseMath(text: string, singleDollarTextMath = false): MathNode[] {
  const tree = unified()
    .use(remarkParse)
    .use(remarkMath, { singleDollarTextMath })
    .parse(text)
  const nodes: MathNode[] = []
  visit(tree, (node) => {
    if (node.type === "inlineMath" || node.type === "math") {
      const math = node as {
        type: "inlineMath" | "math"
        value: string
        meta?: string | null
      }
      nodes.push({
        type: math.type,
        value: math.value,
        meta: math.meta ?? null,
      })
    }
  })
  return nodes
}

describe("remark-math with singleDollarTextMath: false", () => {
  it("does not parse currency pairs as inlineMath", () => {
    const text =
      "The Pro plan costs $9.99 but the Team plan costs $19.99 per month."
    expect(parseMath(normalizeMathDelimiters(text))).toEqual([])
  })

  it("treats $x$ as literal text (recorded: reverts b23f6a5a)", () => {
    expect(parseMath("$x$")).toEqual([])
    expect(parseMath(normalizeMathDelimiters("$x$"))).toEqual([])
  })

  it("does not parse shell variables as inlineMath", () => {
    expect(parseMath("Set $HOME and $PATH before running.")).toEqual([])
    expect(parseMath("Use $1 and $2 as positional args.")).toEqual([])
  })

  it("keeps single-line \\(...\\) as inline math after normalize", () => {
    const nodes = parseMath(normalizeMathDelimiters("Also \\(x\\)."))
    expect(nodes).toEqual([{ type: "inlineMath", value: "x", meta: null }])
  })

  it("keeps multi-line \\(...\\) at the start of a block (does not drop the first line)", () => {
    const one = parseMath(normalizeMathDelimiters("\\(a\nb\\)"))
    expect(one).toHaveLength(1)
    expect(one[0]?.type).toBe("inlineMath")
    expect(one[0]?.value.replace(/\s+/g, "")).toBe("ab")

    const two = parseMath(normalizeMathDelimiters("\\(a\nb\n\\)"))
    expect(two).toHaveLength(1)
    expect(two[0]?.type).toBe("inlineMath")
    expect(two[0]?.value).toContain("a")
    expect(two[0]?.value).toContain("b")
  })

  it("keeps formula text when the closer sits on a continuation prefix", () => {
    const quote = parseMath(normalizeMathDelimiters("> \\(a\n> b\n> \\)"))
    expect(quote).toHaveLength(1)
    expect(quote[0]?.type).toBe("inlineMath")
    expect(quote[0]?.value.replace(/\s+/g, "")).toBe("ab")

    const list = parseMath(
      normalizeMathDelimiters("- Note:\n  \\(a\n  b\n  \\) holds.")
    )
    expect(list).toHaveLength(1)
    expect(list[0]?.type).toBe("inlineMath")
    expect(list[0]?.value.replace(/\s+/g, "")).toBe("ab")
  })

  it("keeps wrapped list-continuation math as inline, not a flow fence", () => {
    const nodes = parseMath(
      normalizeMathDelimiters("- Note that\n  \\(a + b\n  = c\\) holds.")
    )
    expect(nodes).toHaveLength(1)
    expect(nodes[0]?.type).toBe("inlineMath")
    expect(nodes[0]?.value.replace(/\s+/g, "")).toBe("a+b=c")
  })

  it("parses CR / CRLF multiline \\(...\\) as inline math", () => {
    const crlf = parseMath(normalizeMathDelimiters("\\(a\r\n\\)"))
    expect(crlf).toHaveLength(1)
    expect(crlf[0]?.type).toBe("inlineMath")
    expect(crlf[0]?.value.replace(/\s+/g, "")).toBe("a")

    const cr = parseMath(normalizeMathDelimiters("\\(a\rb\\)"))
    expect(cr).toHaveLength(1)
    expect(cr[0]?.type).toBe("inlineMath")
    expect(cr[0]?.value.replace(/\s+/g, "")).toBe("ab")
  })
})
