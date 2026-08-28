import { type ReactElement } from "react"
import { fireEvent, render, screen } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { describe, expect, it } from "vitest"

import enMessages from "@/i18n/messages/en.json"
import type { AdaptedContentPart } from "@/lib/adapters/ai-elements-adapter"
import {
  CompletedTurnContent,
  splitAssistantTurnParts,
} from "./completed-turn-content"

function renderWithIntl(ui: ReactElement) {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      {ui}
    </NextIntlClientProvider>
  )
}

const COMPLETED_PARTS: AdaptedContentPart[] = [
  {
    type: "reasoning",
    content: "Inspecting the repository",
    isStreaming: false,
  },
  { type: "text", text: "I found the relevant component." },
  {
    type: "tool-call",
    toolCallId: "call-1",
    toolName: "Read",
    input: '{"file_path":"src/app.tsx"}',
    state: "output-available",
    output: "source",
  },
  { type: "text", text: "The fix is complete." },
]

// Expansion is remembered per `parts` array identity (so a virtualizer-
// recycled row re-mounts open), which makes a shared array a hidden channel
// between tests. Render tests take a fresh copy.
const freshCompletedParts = (): AdaptedContentPart[] => [...COMPLETED_PARTS]

describe("splitAssistantTurnParts", () => {
  it("keeps only the trailing final response outside progress", () => {
    const split = splitAssistantTurnParts(COMPLETED_PARTS)

    expect(split.progress).toEqual(COMPLETED_PARTS.slice(0, 3))
    expect(split.answer).toEqual(COMPLETED_PARTS.slice(3))
  })

  it("does not guess within a text-only answer", () => {
    const parts: AdaptedContentPart[] = [
      { type: "text", text: "First paragraph" },
      { type: "text", text: "Second paragraph" },
    ]

    expect(splitAssistantTurnParts(parts)).toEqual({
      progress: [],
      answer: parts,
    })
  })
})

describe("CompletedTurnContent with nothing left to show", () => {
  // A reply that ends on its last tool call has no trailing answer, so
  // collapsing would leave an empty bubble under a lone "Worked for" chip.
  // Reachable on every agent (a turn stopped mid-tool-call) and by design on
  // some: Cline's `attempt_completion` card and a plan-mode turn's
  // ExitPlanMode card ARE the answer.
  const TOOL_ONLY_PARTS: AdaptedContentPart[] = [
    { type: "text", text: "Wrapping up." },
    {
      type: "tool-call",
      toolCallId: "call-final",
      toolName: "attempt_completion",
      input: '{"result":"All done."}',
      state: "output-available",
      output: null,
    },
  ]

  it("stays expanded when the reply ends on progress", () => {
    renderWithIntl(
      <CompletedTurnContent
        parts={TOOL_ONLY_PARTS}
        durationMs={5_000}
        completed
      />
    )

    expect(screen.queryByText("Worked for 5s")).not.toBeInTheDocument()
    expect(screen.getByText("Wrapping up.")).toBeInTheDocument()
    // The completion card renders the result as both its header title and its
    // body, so match on presence rather than a unique node.
    expect(screen.getAllByText("All done.").length).toBeGreaterThan(0)
  })

  it("does not treat a blank trailing text part as the answer", () => {
    renderWithIntl(
      <CompletedTurnContent
        parts={[...TOOL_ONLY_PARTS, { type: "text", text: "   \n" }]}
        durationMs={5_000}
        completed
      />
    )

    expect(screen.queryByText("Worked for 5s")).not.toBeInTheDocument()
    expect(screen.getAllByText("All done.").length).toBeGreaterThan(0)
  })
})

describe("CompletedTurnContent", () => {
  it("collapses completed progress by default and keeps the answer visible", () => {
    renderWithIntl(
      <CompletedTurnContent
        parts={freshCompletedParts()}
        durationMs={69_000}
        completed
      />
    )

    const trigger = screen.getByRole("button", { name: "Worked for 1m 9s" })
    expect(trigger).toHaveAttribute("aria-expanded", "false")
    expect(screen.getByText("The fix is complete.")).toBeInTheDocument()
    expect(
      screen.queryByText("I found the relevant component.")
    ).not.toBeInTheDocument()

    fireEvent.click(trigger)

    expect(trigger).toHaveAttribute("aria-expanded", "true")
    expect(
      screen.getByText("I found the relevant component.")
    ).toBeInTheDocument()
    expect(screen.getByText("The fix is complete.")).toBeInTheDocument()
  })

  it("re-mounts expanded after the virtualizer recycled the row", () => {
    // Scrolling a turn past the overscan buffer unmounts it; coming back must
    // not re-hide work the reader had opened. Same `parts` reference across
    // both mounts — that is what survives the recycle in the real thread.
    const parts = freshCompletedParts()
    const first = renderWithIntl(
      <CompletedTurnContent parts={parts} durationMs={69_000} completed />
    )
    fireEvent.click(screen.getByRole("button", { name: "Worked for 1m 9s" }))
    expect(
      screen.getByText("I found the relevant component.")
    ).toBeInTheDocument()
    first.unmount()

    renderWithIntl(
      <CompletedTurnContent parts={parts} durationMs={69_000} completed />
    )

    expect(
      screen.getByRole("button", { name: "Worked for 1m 9s" })
    ).toHaveAttribute("aria-expanded", "true")
    expect(
      screen.getByText("I found the relevant component.")
    ).toBeInTheDocument()
  })

  it("leaves running progress expanded", () => {
    renderWithIntl(
      <CompletedTurnContent
        parts={freshCompletedParts()}
        durationMs={69_000}
        completed={false}
      />
    )

    expect(screen.queryByText("Worked for 1m 9s")).not.toBeInTheDocument()
    expect(
      screen.getByText("I found the relevant component.")
    ).toBeInTheDocument()
    expect(
      screen.getByRole("button", { name: /Read src\/app\.tsx/ })
    ).toBeInTheDocument()
    expect(screen.getByText("The fix is complete.")).toBeInTheDocument()
  })
})
