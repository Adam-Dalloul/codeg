import { fireEvent, render, screen } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import type { ComponentType, ReactNode } from "react"
import { describe, expect, it } from "vitest"
import enMessages from "@/i18n/messages/en.json"
import { messageBlockComponents, JsonRenderScope } from "./json-render-pre"
import { MessageResponse } from "./message"

const Pre = messageBlockComponents.pre as ComponentType<{
  children?: ReactNode
}>

function reply(source: string, language = "html") {
  return (
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <JsonRenderScope>
        <Pre>
          <code className={`language-${language}`}>{source}</code>
        </Pre>
      </JsonRenderScope>
    </NextIntlClientProvider>
  )
}

describe("HTML code preview", () => {
  it("offers preview for an HTML fence rendered by Streamdown", () => {
    render(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <JsonRenderScope>
          <MessageResponse>{"```html\n<h1>Hello</h1>\n```"}</MessageResponse>
        </JsonRenderScope>
      </NextIntlClientProvider>
    )
    fireEvent.click(screen.getByRole("button", { name: "Preview" }))
    expect(screen.getByTitle("HTML preview").getAttribute("srcdoc")).toContain(
      "<h1>Hello</h1>"
    )
  })

  it("keeps code visible until preview is requested and unmounts the frame on return", () => {
    const { container } = render(reply("<h1>Hello</h1>"))
    expect(container.querySelector("iframe")).toBeNull()
    expect(screen.getByText("<h1>Hello</h1>")).toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: "Preview" }))
    const frame = screen.getByTitle("HTML preview")
    expect(frame).toHaveAttribute("sandbox", "allow-scripts")
    expect(frame.getAttribute("srcdoc")).toContain("<h1>Hello</h1>")
    expect(frame.getAttribute("srcdoc")).toContain("Content-Security-Policy")
    expect(frame).toHaveAttribute("referrerpolicy", "no-referrer")
    fireEvent.click(screen.getByRole("button", { name: "Code" }))
    expect(container.querySelector("iframe")).toBeNull()
    expect(screen.getByText("<h1>Hello</h1>")).toBeInTheDocument()
  })

  it("updates the open preview when streamed source changes", () => {
    const { rerender } = render(reply("<p>First</p>"))
    fireEvent.click(screen.getByRole("button", { name: "Preview" }))
    rerender(reply("<p>Second</p>"))
    expect(screen.getByTitle("HTML preview").getAttribute("srcdoc")).toContain(
      "<p>Second</p>"
    )
  })

  it("leaves non-HTML fences unchanged", () => {
    render(reply("const x = 1", "javascript"))
    expect(screen.queryByRole("button", { name: "Preview" })).toBeNull()
    expect(screen.getByText("const x = 1")).toHaveAttribute(
      "data-block",
      "true"
    )
  })

  it("does not offer preview outside assistant replies", () => {
    render(
      <Pre>
        <code className="language-html">{"<p>User content</p>"}</code>
      </Pre>
    )
    expect(screen.queryByRole("button", { name: "Preview" })).toBeNull()
  })

  it.each(["HTML", "htm"])("supports the %s language label", (language) => {
    render(reply("<p>Hello</p>", language))
    expect(screen.getByRole("button", { name: "Preview" })).toBeInTheDocument()
  })
})
