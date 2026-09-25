import { act, fireEvent, render, screen } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { beforeEach, describe, expect, it, vi } from "vitest"

import type { PickerWindow } from "@/lib/computer/types"

const api = vi.hoisted(() => ({
  computerAvailable: vi.fn(() => false),
  computerListShareableWindows: vi.fn<() => Promise<PickerWindow[]>>(),
  computerShareWindow: vi.fn(),
  computerWindowThumbnail: vi.fn(async () => null),
}))
vi.mock("@/lib/computer/computer-api", () => api)
vi.mock("@/lib/platform", () => ({
  subscribe: vi.fn(() => Promise.resolve(() => {})),
}))

import { ComputerWindowPicker } from "./computer-window-picker"
import enMessages from "@/i18n/messages/en.json"
import {
  resetComputerStoreForTest,
  setComputerShared,
} from "@/lib/computer/computer-store"

function window(level: PickerWindow["level"]): PickerWindow {
  return {
    targetId: "w1",
    appName: "TextEdit",
    appKey: "com.apple.TextEdit",
    pid: 42,
    title: "notes.txt",
    bounds: { x: 0, y: 0, width: 800, height: 600 },
    onScreen: true,
    minimized: false,
    level,
  }
}

function mount() {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <ComputerWindowPicker open onOpenChange={() => {}} />
    </NextIntlClientProvider>
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  resetComputerStoreForTest()
})

describe("ComputerWindowPicker", () => {
  /** A window shared before this window of codeg loaded is shown as shared —
   * the list says so, and the store has not been told anything yet. */
  it("shows a grant the store has not heard of yet", async () => {
    api.computerListShareableWindows.mockResolvedValue([window("read")])
    mount()
    expect(
      await screen.findByRole("button", { name: "Can read" })
    ).toBeInTheDocument()
  })

  /** Once the store knows, it is the live word: a grant that ended while the
   * picker was open shows as ended. */
  it("follows the store once it knows", async () => {
    api.computerListShareableWindows.mockResolvedValue([window("read")])
    mount()
    await screen.findByRole("button", { name: "Can read" })
    act(() => setComputerShared([]))
    expect(
      await screen.findByRole("button", { name: "Share" })
    ).toBeInTheDocument()
  })

  /** Stopped — even from another codeg window — the picker says so and
   * offers nothing to share; taking a window back stays possible. */
  it("offers no sharing while stopped", async () => {
    api.computerListShareableWindows.mockResolvedValue([window("read")])
    mount()
    await screen.findByRole("button", { name: "Can read" })
    act(() => setComputerShared([], true))
    await openMenu(await screen.findByRole("button", { name: "Share" }))
    expect(
      screen.getByRole("menuitem", { name: "Let agents read it" })
    ).toHaveAttribute("data-disabled")
    expect(
      screen.getByRole("menuitem", { name: "Let agents read and act on it" })
    ).toHaveAttribute("data-disabled")
    expect(screen.getByText(/No agent can read or act/)).toBeInTheDocument()
  })

  /** Acting is the second decision, made from the same menu as reading. */
  it("offers acting on a window from the same menu", async () => {
    api.computerListShareableWindows.mockResolvedValue([window("none")])
    api.computerShareWindow.mockResolvedValue([])
    mount()
    await openMenu(await screen.findByRole("button", { name: "Share" }))
    await act(async () => {
      fireEvent.click(
        screen.getByRole("menuitem", { name: "Let agents read and act on it" })
      )
      await Promise.resolve()
    })
    expect(api.computerShareWindow).toHaveBeenCalledWith("w1", "control")
  })
})

// jsdom has no `PointerEvent`; Radix reads `button` off the event.
function fireMouse(target: Element, type: string) {
  fireEvent(
    target,
    new MouseEvent(type, { bubbles: true, cancelable: true, button: 0 })
  )
}

async function openMenu(trigger: Element) {
  await act(async () => {
    fireMouse(trigger, "pointerdown")
    fireMouse(trigger, "pointerup")
    fireMouse(trigger, "click")
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}
