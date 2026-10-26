import { describe, expect, it } from "vitest"
import { createChatHtmlProcessor } from "./chat-html-markdown"

describe("聊天 HTML 片段识别", () => {
  it("按顶层 Markdown AST 识别 HTML，保留前后正文和内部空行", () => {
    const source =
      'Before.\n\n<div style="display:grid">\n\n<p>A</p>\n\n</div>\n\nAfter.'
    const result = createChatHtmlProcessor()(source, false)
    expect(result).toContain("Before.")
    expect(result).toContain("After.")
    expect(result).toContain("```codeg-html\n<div")
    expect(result).toContain("\n\n<p>A</p>\n\n</div>")
  })

  it("将前置 style 与其后的根元素放在同一个片段", () => {
    const result = createChatHtmlProcessor()(
      '<style>.x { color:red }</style>\n\n<div class="x">A</div>',
      false
    )
    expect(result.match(/```codeg-html\n/g)).toHaveLength(1)
    expect(result).toContain(
      '<style>.x { color:red }</style>\n\n<div class="x">A</div>'
    )
  })

  it.each([
    "```text\n<div>Example</div>\n```",
    "An inline `<div>Example</div>`.",
    "Some <span>inline HTML</span> text.",
    "    <div>Indented code</div>",
  ])("不重写普通代码和行内 HTML：%s", (source) => {
    expect(createChatHtmlProcessor()(source, false)).toBe(source)
  })

  it("正确跳过注释、属性中的尖括号和 CSS 原始文本", () => {
    const source =
      '<!-- <div> -->\n<style>.x::before{content:"</div>"}</style>\n<div title="a > b"><svg><path d="M0 0" /></svg><br>A</div>'
    const result = createChatHtmlProcessor()(source, false)
    expect(result).toContain("```codeg-html\n")
    expect(result).toContain(source)
  })

  it("流式内容不完整时使用等待状态，结束后保留源码", () => {
    const source = '<div class="card"><p>Partial</p>'
    const process = createChatHtmlProcessor()
    expect(process(source, true)).toContain("```codeg-html-pending\n")
    expect(process(source, false)).toContain("```codeg-html-source\n")
  })

  it("完整前缀不受后续 HTML 和 Markdown 追加影响，编辑历史内容时重置缓存", () => {
    const process = createChatHtmlProcessor()
    const first = process("<div>First</div>", true)
    expect(process("<div>First</div>\n\nTail.", true)).toBe(first + "\n\nTail.")
    const changed = process("<div>Changed</div>", false)
    expect(changed).toContain("Changed")
    expect(changed).not.toContain("First")
  })

  it("使用足够长的围栏，HTML 内部的反引号不会逃逸成主页面内容", () => {
    const result = createChatHtmlProcessor()(
      "<div>```\n<script>no()</script></div>",
      false
    )
    expect(result).toContain("````codeg-html\n")
    expect(result.trimEnd().endsWith("````")).toBe(true)
  })

  it("完整页面也作为单个 HTML 片段处理", () => {
    const source =
      "<!doctype html>\n<html><head><style>body{color:red}</style></head><body><p>A</p></body></html>"
    expect(createChatHtmlProcessor()(source, false)).toContain(
      "```codeg-html\n" + source
    )
  })

  it("同一原始 HTML 块中的相邻根元素都被保留在预览内", () => {
    const html =
      '<style>.x{color:red}</style>\n<div class="x">A</div>\n<div class="x">B</div>'
    const result = createChatHtmlProcessor()(html, false)
    expect(result).toContain('class="x">B</div>\n```')
    expect(result.match(/```codeg-html\n/g)).toHaveLength(1)
  })

  it("单独的 style 不吞掉其后的 Markdown 正文", () => {
    const result = createChatHtmlProcessor()(
      "<style>.x{color:red}</style>\n\nNormal **prose**.",
      false
    )
    expect(result).toContain("</style>\n```\n\nNormal **prose**.")
  })

  it("同一 HTML 块中第二个根元素未闭合时不提前渲染", () => {
    const result = createChatHtmlProcessor()("<div>A</div>\n<div>B", true)
    expect(result).toContain("```codeg-html-pending\n")
  })

  it("Markdown 预处理只影响正文，不改写 HTML 的原始字节", () => {
    const html = '<div title="literal">```\\(inside\\)</div>'
    const result = createChatHtmlProcessor()(
      "Outside\\(x\\)\n\n" + html,
      false,
      (text) => text.split("\\(").join("$")
    )
    expect(result).toContain("Outside$x\\)")
    expect(result).toContain(html)
  })
})
