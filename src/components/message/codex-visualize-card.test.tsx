import { type ReactNode } from "react"
import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  readFileBase64: vi.fn(),
  readWorkspaceFileBase64: vi.fn(),
  activeFolderPath: null as string | null,
  getHomeDirectory: vi.fn(),
  listDirectoryEntries: vi.fn(),
}))

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>()
  return {
    ...actual,
    readFileBase64: mocks.readFileBase64,
    readWorkspaceFileBase64: mocks.readWorkspaceFileBase64,
    getHomeDirectory: mocks.getHomeDirectory,
    listDirectoryEntries: mocks.listDirectoryEntries,
  }
})

vi.mock("@/contexts/active-folder-context", () => ({
  useActiveFolder: () => ({
    activeFolderId: mocks.activeFolderPath ? 1 : null,
    activeFolder: mocks.activeFolderPath
      ? { id: 1, path: mocks.activeFolderPath }
      : null,
  }),
}))

vi.mock("next-themes", () => ({
  useTheme: () => ({ resolvedTheme: "light" }),
}))

vi.mock("@/components/ai-elements/link-safety", () => ({
  FilePathLink: ({ children }: { children: ReactNode }) => (
    <span>{children}</span>
  ),
  useStreamdownLinkSafety: () => ({ enabled: false }),
}))

vi.mock("@/components/ai-elements/code-block", () => ({
  CodeBlock: ({ code }: { code: string }) => <pre>{code}</pre>,
}))

vi.mock("@/components/ai-elements/message", () => ({
  MessageResponse: ({ children }: { children: string }) => (
    <div data-testid="markdown">{children}</div>
  ),
}))

import { ContentPartsRenderer } from "./content-parts-renderer"
import {
  buildVisualizeDocument,
  resetCodexVisualizeAssetsForTests,
} from "./codex-visualize-card"
import enMessages from "@/i18n/messages/en.json"

const toBase64 = (s: string) =>
  btoa(String.fromCharCode(...new TextEncoder().encode(s)))

const MARKER = '\uE200visualize\uE202{"path":"/v/chart.html"}\uE201'

function renderText(text: string) {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <ContentPartsRenderer parts={[{ type: "text", text }]} role="assistant" />
    </NextIntlClientProvider>
  )
}

beforeEach(() => {
  resetCodexVisualizeAssetsForTests()
  mocks.readFileBase64.mockReset()
  mocks.readWorkspaceFileBase64.mockReset()
  mocks.activeFolderPath = null
  mocks.getHomeDirectory.mockReset().mockResolvedValue("/home/u")
  mocks.listDirectoryEntries.mockReset().mockRejectedValue(new Error("nope"))
})

describe("CodexVisualizeCard via ContentPartsRenderer", () => {
  it("renders prose without a marker as plain Markdown", () => {
    renderText("Just prose.")
    expect(screen.getByTestId("markdown")).toHaveTextContent("Just prose.")
    expect(screen.queryByTestId("codex-visualize-card")).toBeNull()
  })

  it("swaps the marker for a sandboxed frame showing the fragment", async () => {
    mocks.readFileBase64.mockResolvedValue(
      toBase64('<div class="card">Hello <b>viz</b></div>')
    )
    renderText(`Here you go.\n\n${MARKER}\n\nEnjoy.`)

    const card = await screen.findByTestId("codex-visualize-card")
    expect(card).toHaveAttribute("data-mode", "normal")
    const frame = await waitFor(() => {
      const el = card.querySelector("iframe")
      if (!el) throw new Error("no iframe yet")
      return el
    })
    expect(frame).toHaveAttribute("sandbox", "allow-scripts")
    expect(frame.getAttribute("srcdoc")).toContain('<div class="card">Hello')
    expect(frame.getAttribute("srcdoc")).toContain("Content-Security-Policy")
    // The fragment is read from the absolute path in the marker.
    expect(mocks.readFileBase64).toHaveBeenCalledWith(
      "/v/chart.html",
      expect.any(Number)
    )
    // The prose around the marker survives, minus the marker itself.
    const md = screen.getAllByTestId("markdown").map((n) => n.textContent)
    expect(md.join("|")).toContain("Here you go.")
    expect(md.join("|")).toContain("Enjoy.")
    expect(md.join("|")).not.toContain("visualize{")
  })

  it("shows an error instead of a frame when the file cannot be read", async () => {
    mocks.readFileBase64.mockRejectedValue(new Error("File does not exist"))
    renderText(MARKER)
    await screen.findByText("Could not load the visualization")
    expect(screen.getByText("File does not exist")).toBeInTheDocument()
    expect(document.querySelector("iframe")).toBeNull()
  })

  it("marks wide-mode visuals", async () => {
    mocks.readFileBase64.mockResolvedValue(toBase64("<p>w</p>"))
    renderText(
      '\uE200visualize\uE202{"path":"/v/app.html","mode":"wide"}\uE201'
    )
    const card = await screen.findByTestId("codex-visualize-card")
    expect(card).toHaveAttribute("data-mode", "wide")
    expect(screen.getByText("Wide")).toBeInTheDocument()
  })
})

describe("HTML files a reply mentions", () => {
  const frameOf = async (card: HTMLElement) =>
    waitFor(() => {
      const el = card.querySelector("iframe")
      if (!el) throw new Error("no iframe yet")
      return el
    })

  it("offers a collapsed Preview row and expands it on demand", async () => {
    mocks.readFileBase64.mockResolvedValue(
      toBase64(
        "<!doctype html><html><head><title>Fitness Report</title></head><body><h1>Week 38</h1></body></html>"
      )
    )
    renderText("I wrote the report to `/Users/u/fit/fitness-report.html`.")

    const row = await screen.findByTestId("html-file-preview")
    expect(row).toHaveTextContent("fitness-report.html")
    expect(mocks.readFileBase64).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole("button", { name: /Preview/ }))
    const card = await screen.findByTestId("codex-visualize-card")
    const frame = await frameOf(card)
    const doc = frame.getAttribute("srcdoc") ?? ""
    // A complete document keeps its own markup, gains the sandbox CSP and
    // the size reporter, and titles the card with its <title>.
    expect(doc).toContain("<h1>Week 38</h1>")
    expect(doc).toContain("Content-Security-Policy")
    expect(doc).toContain("codeg-visualize:size")
    await screen.findByText("Fitness Report")

    fireEvent.click(screen.getByRole("button", { name: "Hide preview" }))
    expect(await screen.findByTestId("html-file-preview")).toBeInTheDocument()
  })

  it("resolves relative mentions against the active folder", async () => {
    mocks.activeFolderPath = "/repo"
    mocks.readFileBase64.mockResolvedValue(toBase64("<p>ok</p>"))
    renderText("Open [the page](site/index.html) to check.")
    fireEvent.click(await screen.findByRole("button", { name: /Preview/ }))
    await screen.findByTestId("codex-visualize-card")
    await waitFor(() =>
      expect(mocks.readFileBase64).toHaveBeenCalledWith(
        "/repo/site/index.html",
        expect.any(Number)
      )
    )
  })

  it("drops relative mentions when there is no folder to resolve them", () => {
    renderText("See `index.html`.")
    expect(screen.queryByTestId("html-file-preview")).toBeNull()
  })

  it("expands ~/ paths against the home directory", async () => {
    mocks.readFileBase64.mockResolvedValue(toBase64("<p>ok</p>"))
    renderText("Saved to ~/reports/fitness.html")
    fireEvent.click(await screen.findByRole("button", { name: /Preview/ }))
    await waitFor(() =>
      expect(mocks.readFileBase64).toHaveBeenCalledWith(
        "/home/u/reports/fitness.html",
        expect.any(Number)
      )
    )
  })

  it("renders a Hermes ::preview directive expanded in place", async () => {
    mocks.readFileBase64.mockResolvedValue(toBase64("<p>hermes</p>"))
    renderText(
      'Here:\n::preview{file="/h/out/report.html"}\nMEDIA:/h/out/report.html'
    )
    const card = await screen.findByTestId("codex-visualize-card")
    expect((await frameOf(card)).getAttribute("srcdoc")).toContain(
      "<p>hermes</p>"
    )
    // The MEDIA: line names the same file, so no second preview row.
    expect(screen.queryByTestId("html-file-preview")).toBeNull()
    expect(
      screen
        .getAllByTestId("markdown")
        .map((n) => n.textContent)
        .join("")
    ).not.toContain("preview{")
  })
})

describe("buildVisualizeDocument", () => {
  const assets = { css: ":root{--x:1}", kit: null, calendar: null }

  it("wraps a fragment in a themed, CSP-protected document", () => {
    const doc = buildVisualizeDocument({
      fragment: "<p>hi</p>",
      assets,
      title: "A <b>",
      dark: true,
      themeOverrides: ":root{--background:red}",
    })
    expect(doc).toContain('style="color-scheme:dark"')
    expect(doc).toContain("<title>A &lt;b&gt;</title>")
    expect(doc).toContain(":root{--x:1}")
    expect(doc).toContain(":root{--background:red}")
    expect(doc).toContain("<p>hi</p>")
    expect(doc).toMatch(/Content-Security-Policy.*default-src 'none'/)
    // The frame paints no page background of its own, so the card's surface
    // (and the workspace background behind it) shows through.
    expect(doc).toContain("html,body{background:transparent !important")
    expect(doc).toContain("html>body{padding:1rem 1.25rem}")
  })

  it("puts the fragment into the plugin kit's slot when one is available", () => {
    const doc = buildVisualizeDocument({
      fragment: "<p>hi</p>",
      assets: {
        css: "",
        kit: "<!--__INLINE_VISUALIZATION_FRAGMENT__--><script>tooltips()</script>",
        calendar: "registerCalendar()",
      },
      title: "t",
      dark: false,
      themeOverrides: "",
    })
    expect(doc).toContain("<p>hi</p><script>tooltips()</script>")
    // calendar.js is only injected for fragments that use <viz-calendar>.
    expect(doc).not.toContain("registerCalendar()")
  })

  it("injects the calendar runtime for fragments that use it", () => {
    const doc = buildVisualizeDocument({
      fragment: "<viz-calendar></viz-calendar>",
      assets: { css: "", kit: null, calendar: "registerCalendar()" },
      title: "t",
      dark: false,
      themeOverrides: "",
    })
    expect(doc).toContain("<script>registerCalendar()</script><viz-calendar>")
  })
})
