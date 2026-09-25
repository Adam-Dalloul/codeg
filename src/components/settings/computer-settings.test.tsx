import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("@/lib/computer/computer-api", () => ({
  getComputerToolsSettings: vi.fn(),
  setComputerToolsPreferences: vi.fn(),
  computerAvailable: vi.fn(() => true),
  computerStopKeyStatus: vi.fn(),
}))
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }))
vi.mock("@/hooks/use-is-mac", () => ({ useIsMac: () => false }))

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
  computerStopKeyStatus,
  getComputerToolsSettings,
  setComputerToolsPreferences,
} from "@/lib/computer/computer-api"

const mockGet = vi.mocked(getComputerToolsSettings)
const mockSet = vi.mocked(setComputerToolsPreferences)
const mockStopKey = vi.mocked(computerStopKeyStatus)

const DEFAULT_KEY = "Control+Alt+Escape"

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
    stopShortcut: DEFAULT_KEY,
  })
  mockSet.mockImplementation(async (prefs) => ({
    enabled: true,
    grantTtlMinutes: prefs.grantTtlMinutes ?? 30,
    blocklist: prefs.blocklist ?? ["com.example.vault"],
    stopShortcut: prefs.stopShortcut ?? DEFAULT_KEY,
  }))
  mockStopKey.mockResolvedValue({ active: DEFAULT_KEY })
})

/** The shortcut button, once the stored values are in. */
async function shortcutButton(label = "Ctrl+Alt+Esc") {
  return screen.findByRole("button", { name: label })
}

function press(
  code: string,
  held: Partial<Record<"ctrlKey" | "altKey" | "shiftKey", boolean>> = {}
) {
  act(() => {
    window.dispatchEvent(
      new KeyboardEvent("keydown", { code, bubbles: true, ...held })
    )
  })
}

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
        stopShortcut: DEFAULT_KEY,
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
        stopShortcut: DEFAULT_KEY,
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
        stopShortcut: DEFAULT_KEY,
      })
    })
    await waitFor(() => expect(box).toHaveValue("org.example.other"))
  })

  /** New keys are recorded off the physical keys, and saved as the one
   * spelling — alone, like every other field. */
  it("records a new stop shortcut and saves only it", async () => {
    mount()
    fireEvent.click(await shortcutButton())
    expect(screen.getByRole("button", { name: "Press keys…" })).toBeVisible()
    press("ControlLeft", { ctrlKey: true })
    press("KeyK", { ctrlKey: true, shiftKey: true })
    await shortcutButton("Ctrl+Shift+K")
    fireEvent.click(screen.getByRole("button", { name: "Save" }))
    await waitFor(() => expect(mockSet).toHaveBeenCalledTimes(1))
    expect(mockSet.mock.calls[0][0]).toEqual({
      stopShortcut: "Control+Shift+KeyK",
    })
  })

  /** Keys too easy to press, or not on the list, are refused where they are
   * pressed; Escape alone gives up and keeps what was there. */
  it("refuses keys that would make a poor stop shortcut", async () => {
    mount()
    fireEvent.click(await shortcutButton())
    press("KeyK", { ctrlKey: true })
    expect(
      screen.getByText(
        "Hold at least two modifiers, one of them Ctrl (or ⌘ on a Mac)."
      )
    ).toBeVisible()
    press("Space", { ctrlKey: true, altKey: true })
    expect(screen.getByText(/That key can't be used/)).toBeVisible()
    press("Escape")
    await shortcutButton()
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled()
  })

  it("can be switched off, and back to the default", async () => {
    mount()
    await shortcutButton()
    expect(
      screen.queryByRole("button", { name: "Default" })
    ).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: "Turn off" }))
    await shortcutButton("Off")
    fireEvent.click(screen.getByRole("button", { name: "Default" }))
    await shortcutButton()
    fireEvent.click(screen.getByRole("button", { name: "Turn off" }))
    fireEvent.click(screen.getByRole("button", { name: "Save" }))
    await waitFor(() => expect(mockSet).toHaveBeenCalledTimes(1))
    expect(mockSet.mock.calls[0][0]).toEqual({ stopShortcut: "" })
  })

  /** Whether the OS holds the keys is said, so nobody counts on a shortcut
   * that does nothing — and it follows the backend's news. */
  it("says whether the shortcut is in force", async () => {
    mockStopKey.mockResolvedValue({ failed: DEFAULT_KEY, detail: "taken" })
    mount()
    await screen.findByText(
      "Not active: another app is probably using these keys. Choose others."
    )
    await waitFor(() =>
      expect(handlers.get("computer://stop-key")).toBeDefined()
    )
    act(() => {
      handlers.get("computer://stop-key")!({ active: DEFAULT_KEY })
    })
    await screen.findByText("Active: press it anywhere to stop every agent.")
  })

  it("says the shortcut waits for computer use to be switched on", async () => {
    mockGet.mockResolvedValue({
      enabled: false,
      grantTtlMinutes: 30,
      blocklist: [],
      stopShortcut: DEFAULT_KEY,
    })
    mockStopKey.mockResolvedValue({})
    mount()
    await screen.findByText("Takes effect while computer use is switched on.")
  })
})
