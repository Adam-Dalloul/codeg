import { act, fireEvent, render, screen } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { beforeEach, describe, expect, it, vi } from "vitest"
import enMessages from "@/i18n/messages/en.json"
import { JsonRenderScope } from "./json-render-pre"
import { MessageResponse } from "./message"

vi.mock("next-themes", () => ({
  useTheme: () => ({ resolvedTheme: "light" }),
}))

function reply(text: string, streaming = false, assistant = true) {
  const content = (
    <MessageResponse
      mode={streaming ? "streaming" : "static"}
      parseIncompleteMarkdown={streaming}
    >
      {text}
    </MessageResponse>
  )
  return (
    <NextIntlClientProvider locale="en" messages={enMessages}>
      {assistant ? <JsonRenderScope>{content}</JsonRenderScope> : content}
    </NextIntlClientProvider>
  )
}

beforeEach(() => {
  localStorage.clear()
  localStorage.setItem("workspace:chat-html-rendering", "true")
})

describe("rich HTML in assistant replies", () => {
  it("renders styled HTML between Markdown paragraphs without injecting it into the host", async () => {
    const html =
      '<style>.cards{display:grid;grid-template-columns:1fr 1fr}</style>\n<div class="cards"><div>A</div><div>B</div></div>'
    const { container } = render(
      reply(`Before **card**.\n\n${html}\n\nAfter card.`)
    )
    expect(screen.getByText("card")).toBeInTheDocument()
    expect(screen.getByText("After card.")).toBeInTheDocument()
    const frame = await screen.findByTitle("HTML preview")
    expect(frame.getAttribute("srcdoc")).toContain(
      "grid-template-columns:1fr 1fr"
    )
    expect(frame.getAttribute("srcdoc")).toContain('class="cards"')
    expect(container.querySelector(".cards")).toBeNull()
  })

  it("shows HTML fences directly while preserving their source view", async () => {
    render(reply("```html\n<div>Card</div>\n```"))
    expect(await screen.findByTitle("HTML preview")).toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: "Code" }))
    expect(screen.queryByTitle("HTML preview")).toBeNull()
    expect(screen.getByText("<div>Card</div>")).toBeInTheDocument()
    expect(screen.queryByText("codeg-html")).toBeNull()
  })

  it("leaves HTML fences as code when the setting is disabled", () => {
    localStorage.setItem("workspace:chat-html-rendering", "false")
    render(reply("```html\n<div>Card</div>\n```"))
    expect(screen.queryByTitle("HTML preview")).toBeNull()
    expect(screen.queryByRole("button", { name: "Preview" })).toBeNull()
  })

  it("does not enable rich HTML for user messages", () => {
    render(reply("```html\n<div>User content</div>\n```", false, false))
    expect(screen.queryByTitle("HTML preview")).toBeNull()
  })

  it("waits for a complete fragment and keeps its frame when later prose arrives", async () => {
    const { rerender } = render(
      reply('<div style="display:flex"><p>First</p>', true)
    )
    expect(screen.queryByTitle("HTML preview")).toBeNull()
    expect(screen.getByRole("status")).toBeInTheDocument()
    const complete = '<div style="display:flex"><p>First</p></div>'
    rerender(reply(complete, true))
    const frame = await screen.findByTitle("HTML preview")
    const document = frame.getAttribute("srcdoc")
    rerender(reply(complete + "\n\nFollowing **prose**.", true))
    expect(screen.getByTitle("HTML preview")).toBe(frame)
    expect(frame.getAttribute("srcdoc")).toBe(document)
    rerender(reply(complete + "\n\nFollowing **prose**."))
    expect(screen.getByTitle("HTML preview")).toBe(frame)
  })

  it("does not activate incomplete HTML fences during streaming", () => {
    render(reply("```html\n<div>Complete markup</div>", true))
    expect(screen.queryByTitle("HTML preview")).toBeNull()
    expect(screen.getByRole("status")).toBeInTheDocument()
  })

  it("executes only the host height reporter, never model scripts", async () => {
    render(
      reply(
        '<div onclick="alert(1)"><script>window.MODEL_SCRIPT=1</script><style>.x{color:red}</style><p>Safe</p></div>'
      )
    )
    const frame = await screen.findByTitle("HTML preview")
    const doc = frame.getAttribute("srcdoc")!
    expect(doc).not.toContain("MODEL_SCRIPT")
    expect(doc).not.toContain("onclick")
    expect(doc).toContain("script-src 'nonce-")
    expect(doc).not.toContain("'unsafe-eval'")
    expect(frame).toHaveAttribute("sandbox", "allow-scripts")
    expect(frame).toHaveAttribute("referrerpolicy", "no-referrer")
  })

  it("ignores spoofed height messages and uses reports from its own frame", async () => {
    render(reply("<div>Card</div>"))
    const frame = (await screen.findByTitle(
      "HTML preview"
    )) as HTMLIFrameElement
    const initialHeight = frame.style.height
    act(() =>
      window.dispatchEvent(
        new MessageEvent("message", {
          source: window,
          data: { type: "codeg-visualize:size", height: 1000 },
        })
      )
    )
    expect(frame.style.height).toBe(initialHeight)
    act(() =>
      window.dispatchEvent(
        new MessageEvent("message", {
          source: frame.contentWindow,
          data: { type: "codeg-visualize:size", height: 240 },
        })
      )
    )
    expect(frame.style.height).toBe("240px")
  })
})
