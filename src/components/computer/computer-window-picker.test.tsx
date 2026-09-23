import { act, render, screen } from "@testing-library/react"
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
      await screen.findByRole("button", { name: "Stop sharing" })
    ).toBeInTheDocument()
  })

  /** Once the store knows, it is the live word: a grant that ended while the
   * picker was open shows as ended. */
  it("follows the store once it knows", async () => {
    api.computerListShareableWindows.mockResolvedValue([window("read")])
    mount()
    await screen.findByRole("button", { name: "Stop sharing" })
    act(() => setComputerShared([]))
    expect(
      await screen.findByRole("button", { name: "Share" })
    ).toBeInTheDocument()
  })
})
