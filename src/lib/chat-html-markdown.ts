import { fromMarkdown } from "mdast-util-from-markdown"

const BLOCK_START =
  /^(?:\s|<!--[\s\S]*?-->|<!doctype[^>]*>)*<(?:html|style|div|section|article|aside|main|header|footer|nav|figure|details|table|ul|ol|dl|blockquote|pre|svg|p|h[1-6])(?:\s|>)/i
const VOID = new Set(
  "area base br col embed hr img input link meta param source track wbr".split(
    " "
  )
)
const RAW = new Set(
  "style script textarea title xmp iframe noembed noframes".split(" ")
)

/**
 * 找到一个完整根元素的末尾。引号、注释和原始文本元素中的尖括号不参与配对。
 * 前置 style 属于紧随其后的可视化根元素；不把半个流式元素交给浏览器自动补全。
 */
function htmlEnd(source: string, start: number): number | null {
  const stack: string[] = []
  let visual = false
  let cursor = start
  while (cursor < source.length) {
    const lt = source.indexOf("<", cursor)
    if (lt === -1) return null
    if (stack.length === 0 && source.slice(cursor, lt).trim()) return null
    if (source.startsWith("<!--", lt)) {
      const end = source.indexOf("-->", lt + 4)
      if (end === -1) return null
      cursor = end + 3
      continue
    }
    const tag = /^<(\/)?([a-z][a-z0-9:-]*)(?=[\s/>])/i.exec(source.slice(lt))
    if (!tag) {
      if (/^<!doctype\b/i.test(source.slice(lt))) {
        const end = source.indexOf(">", lt)
        if (end === -1) return null
        cursor = end + 1
      } else {
        cursor = lt + 1
      }
      continue
    }
    const name = tag[2].toLowerCase()
    let end = lt + tag[0].length
    let quote = ""
    for (; end < source.length; end++) {
      const char = source[end]
      if (quote) {
        if (char === quote) quote = ""
      } else if (char === '"' || char === "'") {
        quote = char
      } else if (char === ">") break
    }
    if (end === source.length) return null
    cursor = end + 1
    if (tag[1]) {
      const index = stack.lastIndexOf(name)
      if (index === -1) return null
      stack.length = index
      if (visual && stack.length === 0) return cursor
    } else {
      if (stack.length === 0 && name !== "style" && name !== "script")
        visual = true
      if (VOID.has(name) || /\/\s*>$/.test(source.slice(lt, cursor))) {
        if (visual && stack.length === 0) return cursor
        continue
      }
      stack.push(name)
      if (RAW.has(name)) {
        const close = new RegExp(`</${name}(?=[\\s/>])`, "i").exec(
          source.slice(cursor)
        )
        if (!close) return null
        cursor += close.index
      }
    }
  }
  return null
}

function fence(source: string, language: string): string {
  let longest = 2
  for (const match of source.matchAll(/`+/g))
    longest = Math.max(longest, match[0].length)
  const marker = "`".repeat(longest + 1)
  return `${marker}${language}\n${source}\n${marker}`
}

/** 每条回复各用一个处理器；流式追加只重解析最后一个完整 HTML 片段之后的尾部。 */
export function createChatHtmlProcessor() {
  let sealedSource = ""
  let sealedOutput = ""
  return (
    source: string,
    streaming: boolean,
    transform: (markdown: string) => string = (text) => text
  ): string => {
    if (!source.startsWith(sealedSource)) {
      sealedSource = ""
      sealedOutput = ""
    }
    const tail = source.slice(sealedSource.length)
    if (!tail.includes("<") && !/```html?|~~~html?/i.test(tail))
      return sealedOutput + transform(tail)
    const tree = fromMarkdown(tail)
    let output = ""
    let cursor = 0
    let sealedEnd = 0
    let sealedTail = ""
    for (const node of tree.children) {
      const start = node.position?.start.offset
      const nodeEnd = node.position?.end.offset
      if (start === undefined || nodeEnd === undefined || start < cursor)
        continue
      const raw = node.type === "html" && BLOCK_START.test(tail.slice(start))
      const code = node.type === "code" && /^html?$/i.test(node.lang ?? "")
      if (!raw && !code) continue
      let end: number
      let html: string
      let complete: boolean
      if (code) {
        html = node.value
        end = nodeEnd
        const original = tail.slice(start, end)
        const marker = /^(`{3,}|~{3,})/.exec(original)?.[1]
        const closed =
          marker &&
          new RegExp(
            `(?:^|\\n)[ \\t]*${marker[0]}{${marker.length},}[ \\t]*$`
          ).test(original)
        const htmlStart = html.search(/\S/)
        complete = Boolean(
          (!streaming || closed) &&
          htmlStart !== -1 &&
          htmlEnd(html, htmlStart) !== null
        )
      } else {
        const found = htmlEnd(tail, start)
        complete = found !== null
        end = found ?? tail.length
        if (
          found === null &&
          /^(?:\s|<!--[\s\S]*?-->)*<style(?:\s|>)/i.test(tail.slice(start)) &&
          !BLOCK_START.test(tail.slice(nodeEnd))
        ) {
          end = nodeEnd
        }
        if (found !== null) {
          // style 和可视化根元素可能分属两个 AST 节点；把同一 HTML 块的相邻根元素一起交给预览。
          let limit = nodeEnd
          for (const child of tree.children) {
            if (
              child.type === "html" &&
              (child.position?.start.offset ?? Infinity) < end
            ) {
              limit = Math.max(limit, child.position?.end.offset ?? 0)
            }
          }
          while (end < limit) {
            const next =
              end + (tail.slice(end, limit).match(/^\s*/)?.[0].length ?? 0)
            if (next >= limit || !BLOCK_START.test(tail.slice(next))) {
              end = limit
              break
            }
            const nextEnd = htmlEnd(tail, next)
            if (nextEnd === null) {
              complete = false
              end = tail.length
              break
            }
            end = nextEnd
          }
        }
        html = tail.slice(start, end)
      }
      output += transform(tail.slice(cursor, start))
      output += fence(
        html,
        complete
          ? "codeg-html"
          : streaming
            ? "codeg-html-pending"
            : "codeg-html-source"
      )
      cursor = end
      if (complete) {
        sealedEnd = end
        sealedTail = output
      }
    }
    const result = sealedOutput + output + transform(tail.slice(cursor))
    if (sealedEnd > 0) {
      sealedOutput += sealedTail
      sealedSource = source.slice(0, sealedSource.length + sealedEnd)
    }
    return result
  }
}
