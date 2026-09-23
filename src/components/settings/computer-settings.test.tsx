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
  mockSet.mockImplementation(async (prefs) => ({
    enabled: true,
    grantTtlMinutes: prefs.grantTtlMinutes ?? 30,
    blocklist: prefs.blocklist ?? ["com.example.vault"],
  }))
})

describe("ComputerSettingsSection", () => {
  /** Only what changed is written — never the switch, and not the timeout
   * when only the blocklist moved — and the blocklist goes out as trimmed,
   * non-empty entries. */
  it("saves only the changed field, through the preferences writer", async () => {
    mount()
    const box = await screen.findByLabelText(
      "Applications that can never be shared"
    )
    await waitFor(() => expect(box).toHaveValue("com.example.vault"))
    fireEvent.change(box, {
      target: { value: "com.example.vault\n\n  keepass.exe  \n" },
    })
    fireEvent.click(screen.getByRole("button", { name: "Save" }))
    await waitFor(() => expect(mockSet).toHaveBeenCalledTimes(1))
    expect(mockSet.mock.calls[0][0]).toEqual({
      grantTtlMinutes: undefined,
      blocklist: ["com.example.vault", "keepass.exe"],
    })
  })

  /** Another window's save moves the fields this form has not touched and
   * leaves the one it has; saving then writes only that one. */
  it("merges a save made elsewhere into the fields it did not touch", async () => {
    mount()
    const box = await screen.findByLabelText(
      "Applications that can never be shared"
    )
    await waitFor(() => expect(box).toHaveValue("com.example.vault"))
    await waitFor(() =>
      expect(handlers.get("computer-tools-settings://changed")).toBeDefined()
    )
    fireEvent.change(box, { target: { value: "com.example.mine" } })
    act(() => {
      handlers.get("computer-tools-settings://changed")!({
        enabled: true,
        grantTtlMinutes: 60,
        blocklist: ["com.example.vault", "org.example.theirs"],
      })
    })
    expect(box).toHaveValue("com.example.mine")
    fireEvent.click(screen.getByRole("button", { name: "Save" }))
    await waitFor(() => expect(mockSet).toHaveBeenCalledTimes(1))
    expect(mockSet.mock.calls[0][0]).toEqual({
      grantTtlMinutes: undefined,
      blocklist: ["com.example.mine"],
    })
  })

  /** A form that could not read the stored values shows no defaults to save
   * over them: it stays locked until a read succeeds. */
  it("stays locked after a failed read until one succeeds", async () => {
    mockGet.mockRejectedValueOnce(new Error("offline"))
    mount()
    const box = await screen.findByLabelText(
      "Applications that can never be shared"
    )
    await screen.findByText(/offline/)
    expect(box).toBeDisabled()
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled()
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }))
    await waitFor(() => expect(box).toHaveValue("com.example.vault"))
    expect(box).not.toBeDisabled()
  })

  /** Nothing can be edited while a save is on its way: its answer replaces
   * the fields. */
  it("locks the fields while saving", async () => {
    let finish: (
      v: Awaited<ReturnType<typeof setComputerToolsPreferences>>
    ) => void = () => {}
    mockSet.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve
        })
    )
    mount()
    const box = await screen.findByLabelText(
      "Applications that can never be shared"
    )
    await waitFor(() => expect(box).toHaveValue("com.example.vault"))
    fireEvent.change(box, { target: { value: "com.example.new" } })
    fireEvent.click(screen.getByRole("button", { name: "Save" }))
    await waitFor(() => expect(box).toBeDisabled())
    await act(async () => {
      finish({
        enabled: true,
        grantTtlMinutes: 30,
        blocklist: ["com.example.new"],
      })
    })
    await waitFor(() => expect(box).not.toBeDisabled())
    expect(box).toHaveValue("com.example.new")
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
