import { fireEvent, render, screen } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { describe, expect, it, vi } from "vitest"

import { SessionFailureBanner } from "./session-failure-banner"
import enMessages from "@/i18n/messages/en.json"
import type { SessionFailureRecord } from "@/lib/types"

function record(
  overrides: Partial<SessionFailureRecord> = {}
): SessionFailureRecord {
  return {
    id: "t1:error",
    revision: 1,
    category: "access",
    severity: "error",
    title: "Authentication required.",
    actions: ["login"],
    resolved: false,
    ...overrides,
  }
}

function renderBanner(
  failures: SessionFailureRecord[],
  onAction?: (action: string, failure: SessionFailureRecord) => void
) {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <SessionFailureBanner failures={failures} onAction={onAction} />
    </NextIntlClientProvider>
  )
}

describe("SessionFailureBanner", () => {
  it("renders an active error strip with its suggested action wired", () => {
    const onAction = vi.fn()
    renderBanner([record()], onAction)
    expect(screen.getByRole("alert")).toBeInTheDocument()
    expect(screen.getByText("Authentication required.")).toBeInTheDocument()
    // Only the record's suggested (and known) actions render.
    expect(screen.queryByText("Retry")).not.toBeInTheDocument()
    fireEvent.click(screen.getByText("Sign in"))
    expect(onAction).toHaveBeenCalledWith(
      "login",
      expect.objectContaining({ id: "t1:error" })
    )
  })

  it("hides action buttons without a handler (read-only surfaces)", () => {
    renderBanner([record()])
    expect(screen.getByText("Authentication required.")).toBeInTheDocument()
    expect(screen.queryByText("Sign in")).not.toBeInTheDocument()
  })

  it("never renders action buttons on warning strips (adapter is mid-recovery)", () => {
    const onAction = vi.fn()
    renderBanner(
      [
        record({
          severity: "warning",
          title: "retrying request",
          actions: ["retry", "login", "new_session"],
        }),
      ],
      onAction
    )
    expect(screen.getByText("retrying request")).toBeInTheDocument()
    expect(screen.queryByText("Retry")).not.toBeInTheDocument()
    expect(screen.queryByText("Sign in")).not.toBeInTheDocument()
    expect(screen.queryByText("New session")).not.toBeInTheDocument()
  })

  it("falls back to the category label for a blank title and expands details", () => {
    renderBanner([
      record({
        category: "limit",
        title: "  ",
        details: "usage resets at 3pm",
        actions: [],
      }),
    ])
    expect(screen.getByText("Limit reached")).toBeInTheDocument()
    expect(screen.queryByText("usage resets at 3pm")).not.toBeInTheDocument()
    fireEvent.click(screen.getByLabelText("Toggle details"))
    expect(screen.getByText("usage resets at 3pm")).toBeInTheDocument()
  })

  it("maps unknown categories and actions onto safe fallbacks", () => {
    const onAction = vi.fn()
    renderBanner(
      [record({ category: "quantum", title: "", actions: ["sing", "retry"] })],
      onAction
    )
    // Unknown category → the generic label; unknown action → not rendered.
    expect(screen.getByText("Session issue")).toBeInTheDocument()
    expect(screen.queryByText("sing")).not.toBeInTheDocument()
    fireEvent.click(screen.getByText("Retry"))
    expect(onAction).toHaveBeenCalledWith("retry", expect.anything())
  })

  it("shows only the most recent recovered warning, and only when idle", () => {
    const resolvedWarning = (id: string, title: string) =>
      record({ id, severity: "warning", title, resolved: true, actions: [] })
    renderBanner([
      resolvedWarning("w1", "first retry incident"),
      resolvedWarning("w2", "second retry incident"),
      // Resolved ERRORS are watermarks only — never rendered.
      record({ id: "e1", resolved: true, title: "old auth error" }),
    ])
    expect(
      screen.getByText(/Recovered · second retry incident/)
    ).toBeInTheDocument()
    expect(screen.queryByText(/first retry incident/)).not.toBeInTheDocument()
    expect(screen.queryByText(/old auth error/)).not.toBeInTheDocument()
  })

  it("suppresses the recovered line while an active strip is showing", () => {
    renderBanner([
      record({ id: "w1", severity: "warning", resolved: true, actions: [] }),
      record({ id: "e2", title: "still failing" }),
    ])
    expect(screen.getByText("still failing")).toBeInTheDocument()
    expect(screen.queryByText(/Recovered/)).not.toBeInTheDocument()
  })

  it("renders nothing for an empty or fully-settled-error table", () => {
    const { container } = renderBanner([record({ resolved: true })])
    expect(container).toBeEmptyDOMElement()
  })
})
