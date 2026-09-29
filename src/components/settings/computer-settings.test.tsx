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
import type { ComputerToolsSettings, DefaultBlock } from "@/lib/computer/types"

const mockGet = vi.mocked(getComputerToolsSettings)
const mockSet = vi.mocked(setComputerToolsPreferences)
const mockStopKey = vi.mocked(computerStopKeyStatus)

const DEFAULT_KEY = "Control+Alt+Escape"

const DEFAULTS: DefaultBlock[] = [
  {
    key: "system-settings",
    name: "System Settings",
    locked: true,
    names: ["systemsettings.exe"],
  },
  {
    key: "1password",
    name: "1Password",
    locked: false,
    names: ["1password.exe"],
  },
]

/** The record as the backend answers it. */
function record(
  overrides: Partial<ComputerToolsSettings> = {}
): ComputerToolsSettings {
  return {
    enabled: true,
    grantTtlMinutes: 30,
    blocklist: ["com.example.vault"],
    blocklistRemoved: [],
    blocklistDefaults: DEFAULTS,
    stopShortcut: DEFAULT_KEY,
    ...overrides,
  }
}

const LABEL = "Apps that are never shared"

/** Type an entry and add it to the list. */
function addEntry(box: HTMLElement, entry: string) {
  fireEvent.change(box, { target: { value: entry } })
  fireEvent.click(screen.getByRole("button", { name: "Add" }))
}

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
  mockGet.mockResolvedValue(record())
  mockSet.mockImplementation(async (prefs) =>
    record({
      grantTtlMinutes: prefs.grantTtlMinutes ?? 30,
      blocklist: prefs.blocklist ?? ["com.example.vault"],
      blocklistRemoved: prefs.blocklistRemoved ?? [],
      stopShortcut: prefs.stopShortcut ?? DEFAULT_KEY,
    })
  )
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
   * when only the blocklist moved — and an entry goes out trimmed. */
  it("saves only the changed field, through the preferences writer", async () => {
    mount()
    const box = await screen.findByLabelText(LABEL)
    await screen.findByText("com.example.vault")
    await waitFor(() => expect(box).not.toBeDisabled())
    addEntry(box, "  keepass.exe  ")
    expect(box).toHaveValue("")
    fireEvent.click(screen.getByRole("button", { name: "Save" }))
    await waitFor(() => expect(mockSet).toHaveBeenCalledTimes(1))
    expect(mockSet.mock.calls[0][0]).toEqual({
      grantTtlMinutes: undefined,
      blocklist: ["com.example.vault", "keepass.exe"],
    })
  })

  /** A default can be taken off, but not a locked one; "restore defaults"
   * takes off what was added and puts back what was removed. Each goes out
   * as the one field it moved. */
  it("takes a default off the list and restores the defaults", async () => {
    mount()
    const box = await screen.findByLabelText(LABEL)
    await waitFor(() => expect(box).not.toBeDisabled())
    expect(screen.getByText("System Settings")).toBeInTheDocument()
    expect(
      screen.queryByRole("button", { name: "Remove System Settings" })
    ).toBeNull()
    fireEvent.click(screen.getByRole("button", { name: "Remove 1Password" }))
    expect(screen.queryByText("1Password")).toBeNull()
    expect(screen.getByText("1 default app removed.")).toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: "Save" }))
    await waitFor(() => expect(mockSet).toHaveBeenCalledTimes(1))
    expect(mockSet.mock.calls[0][0]).toEqual({
      blocklistRemoved: ["1password"],
    })

    await waitFor(() => expect(box).not.toBeDisabled())
    fireEvent.click(screen.getByRole("button", { name: "Restore defaults" }))
    expect(screen.getByText("1Password")).toBeInTheDocument()
    expect(screen.queryByText("com.example.vault")).toBeNull()
    fireEvent.click(screen.getByRole("button", { name: "Save" }))
    await waitFor(() => expect(mockSet).toHaveBeenCalledTimes(2))
    expect(mockSet.mock.calls[1][0]).toEqual({
      blocklist: [],
      blocklistRemoved: [],
    })
  })

  /** An entry already on the list is refused; a default that was taken off
   * is put back when typed again. */
  it("refuses a duplicate and puts a removed default back", async () => {
    mockGet.mockResolvedValue(record({ blocklistRemoved: ["1password"] }))
    mount()
    const box = await screen.findByLabelText(LABEL)
    await waitFor(() => expect(box).not.toBeDisabled())
    addEntry(box, "COM.EXAMPLE.VAULT")
    expect(screen.getByText("Already on the list.")).toBeInTheDocument()
    addEntry(box, "1Password.exe")
    expect(screen.getByText("1Password")).toBeInTheDocument()
    expect(screen.queryByText(/default app removed/)).toBeNull()
    fireEvent.click(screen.getByRole("button", { name: "Save" }))
    await waitFor(() => expect(mockSet).toHaveBeenCalledTimes(1))
    expect(mockSet.mock.calls[0][0]).toEqual({ blocklistRemoved: [] })
  })

  /** Another window's save moves the fields this form has not touched and
   * leaves the one it has; saving then writes only that one. */
  it("merges a save made elsewhere into the fields it did not touch", async () => {
    mount()
    const box = await screen.findByLabelText(LABEL)
    await waitFor(() => expect(box).not.toBeDisabled())
    await waitFor(() =>
      expect(handlers.get("computer-tools-settings://changed")).toBeDefined()
    )
    fireEvent.click(
      screen.getByRole("button", { name: "Remove com.example.vault" })
    )
    addEntry(box, "com.example.mine")
    act(() => {
      handlers.get("computer-tools-settings://changed")!(
        record({
          grantTtlMinutes: 60,
          blocklist: ["com.example.vault", "org.example.theirs"],
        })
      )
    })
    expect(screen.getByText("com.example.mine")).toBeInTheDocument()
    expect(screen.queryByText("org.example.theirs")).toBeNull()
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
    const box = await screen.findByLabelText(LABEL)
    await screen.findByText(/offline/)
    expect(box).toBeDisabled()
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled()
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }))
    await screen.findByText("com.example.vault")
    await waitFor(() => expect(box).not.toBeDisabled())
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
    const box = await screen.findByLabelText(LABEL)
    await waitFor(() => expect(box).not.toBeDisabled())
    addEntry(box, "com.example.new")
    fireEvent.click(screen.getByRole("button", { name: "Save" }))
    await waitFor(() => expect(box).toBeDisabled())
    await act(async () => {
      finish(record({ blocklist: ["com.example.new"] }))
    })
    await waitFor(() => expect(box).not.toBeDisabled())
    expect(screen.getByText("com.example.new")).toBeInTheDocument()
    expect(screen.queryByText("com.example.vault")).toBeNull()
  })

  it("has nothing to save until something changes", async () => {
    mount()
    await screen.findByLabelText(LABEL)
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Save" })).toBeDisabled()
    )
  })

  /** Another window saved the record: an untouched form follows it. */
  it("follows a save made elsewhere", async () => {
    mount()
    await screen.findByLabelText(LABEL)
    await waitFor(() =>
      expect(handlers.get("computer-tools-settings://changed")).toBeDefined()
    )
    act(() => {
      handlers.get("computer-tools-settings://changed")!(
        record({
          grantTtlMinutes: 60,
          blocklist: ["org.example.other"],
          blocklistRemoved: ["1password"],
        })
      )
    })
    await screen.findByText("org.example.other")
    expect(screen.queryByText("1Password")).toBeNull()
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

  /** Until the stored shortcut has been read, the row claims nothing — not
   * even "off". */
  it("says nothing of the shortcut it has not read", async () => {
    mockGet.mockRejectedValueOnce(new Error("offline"))
    mount()
    await screen.findByText(/offline/)
    expect(screen.getByRole("button", { name: "…" })).toBeDisabled()
    expect(screen.queryByRole("button", { name: "Off" })).toBeNull()
    expect(screen.queryByText(/^Off:/)).toBeNull()
  })

  /** A save locks the row and ends recording: keys pressed while it is on
   * its way are not caught, only to be overwritten by its answer. */
  it("stops recording when a save locks the row", async () => {
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
    const box = await screen.findByLabelText(LABEL)
    await waitFor(() => expect(box).not.toBeDisabled())
    fireEvent.click(
      screen.getByRole("button", { name: "Remove com.example.vault" })
    )
    addEntry(box, "com.example.new")
    fireEvent.click(await shortcutButton())
    await screen.findByRole("button", { name: "Press keys…" })
    fireEvent.click(screen.getByRole("button", { name: "Save" }))
    await waitFor(() => expect(box).toBeDisabled())
    press("KeyK", { ctrlKey: true, shiftKey: true })
    expect(screen.queryByRole("button", { name: "Press keys…" })).toBeNull()
    await act(async () => {
      finish(record({ blocklist: ["com.example.new"] }))
    })
    await shortcutButton()
    expect(mockSet.mock.calls[0][0]).toEqual({
      blocklist: ["com.example.new"],
    })
  })

  it("says the shortcut waits for computer use to be switched on", async () => {
    mockGet.mockResolvedValue(record({ enabled: false, blocklist: [] }))
    mockStopKey.mockResolvedValue({})
    mount()
    await screen.findByText("Takes effect while computer use is switched on.")
  })
})
