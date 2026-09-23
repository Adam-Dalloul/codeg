import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("@/lib/computer/computer-api", () => ({
  getComputerToolsSettings: vi.fn(),
  setComputerToolsPreferences: vi.fn(),
}))
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

const handlers = new Map<string, (p: unknown) => void>()
vi.mock("@/lib/platform", () => ({
  subscribe: vi.fn((event: string, handler: (p: unknown) => void) => {
    handlers.set(event, handler)
    return Promise.resolve(() => {})
  }),
}))

import { ComputerSettingsSection } from "./computer-settings"
import enMessages from "@/i18n/messages/en.json"
import {
  getComputerToolsSettings,
  setComputerToolsPreferences,
} from "@/lib/computer/computer-api"

const mockGet = vi.mocked(getComputerToolsSettings)
const mockSet = vi.mocked(setComputerToolsPreferences)

function mount() {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <ComputerSettingsSection />
    </NextIntlClientProvider>
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  handlers.clear()
  mockGet.mockResolvedValue({
    enabled: true,
    grantTtlMinutes: 30,
    blocklist: ["com.example.vault"],
  })
  mockSet.mockImplementation(async (ttl, blocklist) => ({
    enabled: true,
    grantTtlMinutes: ttl,
    blocklist,
  }))
})

describe("ComputerSettingsSection", () => {
  /** Only the timeout and the blocklist are written — never the switch —
   * and the blocklist goes out as trimmed, non-empty entries. */
  it("saves the blocklist as entries, through the preferences writer", async () => {
    mount()
    const box = await screen.findByLabelText(
      "Applications that can never be shared"
    )
    await waitFor(() => expect(box).toHaveValue("com.example.vault"))
    fireEvent.change(box, {
      target: { value: "com.example.vault\n\n  keepass.exe  \n" },
    })
    fireEvent.click(screen.getByRole("button", { name: "Save" }))
    await waitFor(() =>
      expect(mockSet).toHaveBeenCalledWith(30, [
        "com.example.vault",
        "keepass.exe",
      ])
    )
  })

  it("has nothing to save until something changes", async () => {
    mount()
    await screen.findByLabelText("Applications that can never be shared")
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Save" })).toBeDisabled()
    )
  })

  /** Another window saved the record: an untouched form follows it. */
  it("follows a save made elsewhere", async () => {
    mount()
    const box = await screen.findByLabelText(
      "Applications that can never be shared"
    )
    await waitFor(() =>
      expect(handlers.get("computer-tools-settings://changed")).toBeDefined()
    )
    act(() => {
      handlers.get("computer-tools-settings://changed")!({
        enabled: true,
        grantTtlMinutes: 60,
        blocklist: ["org.example.other"],
      })
    })
    await waitFor(() => expect(box).toHaveValue("org.example.other"))
  })
})
