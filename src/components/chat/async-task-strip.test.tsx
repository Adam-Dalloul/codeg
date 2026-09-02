import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { NextIntlClientProvider } from "next-intl"
import { describe, expect, it, vi, beforeEach } from "vitest"

const mocks = vi.hoisted(() => ({
  isLocalDesktop: vi.fn(() => true),
  openPath: vi.fn(),
  toastError: vi.fn(),
}))

vi.mock("@/lib/platform", () => ({
  isLocalDesktop: mocks.isLocalDesktop,
  openPath: mocks.openPath,
}))

vi.mock("sonner", () => ({
  toast: { error: mocks.toastError },
}))

import { AsyncTaskStrip } from "./async-task-strip"
import enMessages from "@/i18n/messages/en.json"
import type { AsyncTaskRecord } from "@/lib/types"

function task(overrides: Partial<AsyncTaskRecord> = {}): AsyncTaskRecord {
  return {
    task_id: "t1",
    name: "pnpm test",
    task_type: "shell",
    description: "pnpm test --watch",
    show_in_transcript: true,
    can_stop: true,
    state: "running",
    ...overrides,
  }
}

function renderStrip(ui: React.ReactNode) {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      {ui}
    </NextIntlClientProvider>
  )
}

const t = enMessages.Folder.chat.asyncTasks

beforeEach(() => {
  mocks.isLocalDesktop.mockReturnValue(true)
  mocks.openPath.mockReset()
  mocks.toastError.mockClear()
})

describe("AsyncTaskStrip", () => {
  it("renders nothing once every task has settled", () => {
    // A settled task's outcome belongs to the transcript; a permanent list of
    // finished jobs docked under the composer would grow all session.
    const { container } = renderStrip(
      <AsyncTaskStrip
        tasks={[
          task({ task_id: "a", state: "completed" }),
          task({ task_id: "b", state: "failed" }),
        ]}
      />
    )
    expect(container).toBeEmptyDOMElement()
  })

  it("stops a task and reports a declined stop through the caller", async () => {
    const onStop = vi.fn().mockResolvedValue(true)
    renderStrip(<AsyncTaskStrip tasks={[task()]} onStop={onStop} />)
    await userEvent.click(screen.getByRole("button", { name: t.stop }))
    expect(onStop).toHaveBeenCalledWith("t1")
  })

  it("hides the stop button when the adapter withheld the affordance", () => {
    renderStrip(
      <AsyncTaskStrip tasks={[task({ can_stop: false })]} onStop={vi.fn()} />
    )
    expect(
      screen.queryByRole("button", { name: t.stop })
    ).not.toBeInTheDocument()
  })

  it("hides the stop button for a surface with no live connection", () => {
    // A viewer passes no handler — the button would be a dead control.
    renderStrip(<AsyncTaskStrip tasks={[task()]} />)
    expect(
      screen.queryByRole("button", { name: t.stop })
    ).not.toBeInTheDocument()
  })

  it("offers the output file only where opening one does something", async () => {
    const withOutput = task({ output_file_path: "/tmp/tasks/t1.output" })
    const { unmount } = renderStrip(<AsyncTaskStrip tasks={[withOutput]} />)
    await userEvent.click(screen.getByRole("button", { name: t.openOutput }))
    expect(mocks.openPath).toHaveBeenCalledWith("/tmp/tasks/t1.output")
    unmount()

    // `openPath` silently no-ops in web and remote-desktop windows, where the
    // path belongs to another host — rendering the button there is a lie.
    mocks.isLocalDesktop.mockReturnValue(false)
    renderStrip(<AsyncTaskStrip tasks={[withOutput]} />)
    expect(
      screen.queryByRole("button", { name: t.openOutput })
    ).not.toBeInTheDocument()
  })

  it("reports a refused open instead of dropping the rejection", async () => {
    // The path is the adapter's and the opener plugin validates it against the
    // capability scope, so a path outside that scope is refused at the door.
    // Unhandled, the rejection surfaced as a bare "Not allowed to open path"
    // with nothing to act on; the toast names the path, which is what a scope
    // widening needs.
    mocks.openPath.mockRejectedValue(
      new Error("Not allowed to open path /private/tmp/claude-501/x.output")
    )
    renderStrip(
      <AsyncTaskStrip
        tasks={[task({ output_file_path: "/private/tmp/claude-501/x.output" })]}
      />
    )
    await userEvent.click(screen.getByRole("button", { name: t.openOutput }))
    expect(mocks.toastError).toHaveBeenCalledTimes(1)
    expect(mocks.toastError.mock.calls[0]![0]).toContain(
      "/private/tmp/claude-501/x.output"
    )
  })

  it("marks a task that is already drawn as its own tool call", () => {
    renderStrip(
      <AsyncTaskStrip tasks={[task({ show_in_transcript: false })]} />
    )
    expect(screen.getByText(t.alsoInTranscript)).toBeInTheDocument()
  })
})
