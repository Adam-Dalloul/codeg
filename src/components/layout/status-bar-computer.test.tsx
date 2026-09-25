import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { beforeEach, describe, expect, it, vi } from "vitest"

import type {
  ComputerStatePayload,
  ComputerStatus,
  ComputerToolsSettings,
  StopKeyStatus,
} from "@/lib/computer/types"

const api = vi.hoisted(() => ({
  computerAvailable: vi.fn(() => true),
  getComputerToolsSettings: vi.fn(),
  computerStatus: vi.fn<() => Promise<ComputerStatus>>(),
  computerSharedState: vi.fn(
    async (): Promise<ComputerStatePayload> => ({ shared: [], paused: false })
  ),
  computerRequestPermission: vi.fn(),
  computerOpenPermissionSettings: vi.fn(),
  computerShareWindow: vi.fn(),
  computerRevokeAll: vi.fn(),
  computerStop: vi.fn(async () => {}),
  computerResume: vi.fn(async () => {}),
  computerListShareableWindows: vi.fn(),
  computerWindowThumbnail: vi.fn(),
  computerStopKeyStatus: vi.fn(async (): Promise<StopKeyStatus> => ({})),
}))
vi.mock("@/lib/computer/computer-api", () => api)
vi.mock("@/hooks/use-is-mac", () => ({ useIsMac: () => true }))
const handlers = new Map<string, (p: unknown) => void>()
vi.mock("@/lib/platform", () => ({
  subscribe: vi.fn((event: string, handler: (p: unknown) => void) => {
    handlers.set(event, handler)
    return Promise.resolve(() => {})
  }),
}))
vi.mock("@/lib/api", () => ({ openSettingsWindow: vi.fn(async () => {}) }))

import { StatusBarComputer } from "./status-bar-computer"
import enMessages from "@/i18n/messages/en.json"
import {
  resetComputerStoreForTest,
  setComputerShared,
} from "@/lib/computer/computer-store"

function status(overrides: Partial<ComputerStatus> = {}): ComputerStatus {
  return {
    enabled: true,
    platform: "macos",
    verifiedPlatform: false,
    backend: { state: "ready", driverVersion: "0.28.2", peer: "verified" },
    permissions: {
      required: true,
      accessibility: true,
      screenRecording: false,
    },
    codeg: {
      accessibility: false,
      screenRecording: false,
      selfResponsible: true,
    },
    shared: [],
    paused: false,
    ...overrides,
  }
}

function mount() {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <StatusBarComputer />
    </NextIntlClientProvider>
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  handlers.clear()
  resetComputerStoreForTest()
  api.computerAvailable.mockReturnValue(true)
  api.getComputerToolsSettings.mockResolvedValue({
    enabled: true,
    grantTtlMinutes: 30,
    blocklist: [],
    stopShortcut: "Control+Command+Escape",
  })
  api.computerStatus.mockResolvedValue(status())
  api.computerStopKeyStatus.mockResolvedValue({})
  api.computerSharedState.mockResolvedValue({ shared: [], paused: false })
})

describe("StatusBarComputer", () => {
  it("is not there while computer use is off", async () => {
    api.getComputerToolsSettings.mockResolvedValue({
      enabled: false,
      grantTtlMinutes: 30,
      blocklist: [],
      stopShortcut: "",
    })
    const { container } = mount()
    await waitFor(() => expect(api.getComputerToolsSettings).toHaveBeenCalled())
    expect(container).toBeEmptyDOMElement()
  })

  /** A missing permission is named, with a way to ask for it — for the
   * helper, which is what gets the grant. */
  it("offers to request a missing permission", async () => {
    mount()
    fireEvent.click(await screen.findByRole("button", { name: "Computer use" }))
    await screen.findByText("Screen Recording")
    expect(screen.getByText("Granted")).toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: "Request" }))
    await waitFor(() =>
      expect(api.computerRequestPermission).toHaveBeenCalledWith(
        "screenRecording"
      )
    )
  })

  /** codeg holding a permission itself is the first thing said, and sharing
   * is not offered while it lasts. */
  it("warns when codeg itself holds a permission", async () => {
    api.computerStatus.mockResolvedValue(
      status({
        codeg: {
          accessibility: true,
          screenRecording: false,
          selfResponsible: true,
        },
      })
    )
    mount()
    fireEvent.click(await screen.findByRole("button", { name: "Computer use" }))
    await screen.findByText(/codeg itself has been granted/)
    expect(
      screen.getByRole("button", { name: "Share a window…" })
    ).toBeDisabled()
  })

  it("lists shared windows and stops one", async () => {
    api.computerStatus.mockResolvedValue(
      status({
        shared: [
          {
            targetId: "w4",
            appName: "TextEdit",
            appKey: "com.apple.TextEdit",
            title: "notes.txt",
            level: "read",
            grantedAt: 1,
            lastUsedAt: 1,
          },
        ],
      })
    )
    api.computerShareWindow.mockResolvedValue([])
    mount()
    fireEvent.click(await screen.findByRole("button", { name: "Computer use" }))
    await screen.findByText("notes.txt")
    fireEvent.click(screen.getByRole("button", { name: "Stop" }))
    await waitFor(() =>
      expect(api.computerShareWindow).toHaveBeenCalledWith("w4", "none")
    )
  })

  /** While a window is shared for control, Stop is beside the glyph, one
   * click away, without opening anything. */
  it("puts Stop beside the glyph while agents can act", async () => {
    mount()
    await screen.findByRole("button", { name: "Computer use" })
    expect(screen.queryByRole("button", { name: "Stop agents" })).toBeNull()
    act(() =>
      setComputerShared([
        {
          targetId: "w4",
          appName: "TextEdit",
          appKey: "com.apple.TextEdit",
          title: "notes.txt",
          level: "control",
          grantedAt: 1,
          lastUsedAt: 1,
        },
      ])
    )
    fireEvent.click(await screen.findByRole("button", { name: "Stop agents" }))
    await waitFor(() => expect(api.computerStop).toHaveBeenCalled())
  })

  /** A window that loads after something was shared for control learns of
   * it at once, and shows Stop without anyone opening the popover. */
  it("shows Stop in a window that loaded after the sharing", async () => {
    api.computerSharedState.mockResolvedValue({
      shared: [
        {
          targetId: "w4",
          appName: "TextEdit",
          appKey: "com.apple.TextEdit",
          title: "notes.txt",
          level: "control",
          grantedAt: 1,
          lastUsedAt: 1,
        },
      ],
      paused: false,
    })
    mount()
    expect(
      await screen.findByRole("button", { name: "Stop agents" })
    ).toBeInTheDocument()
    expect(api.computerStatus).not.toHaveBeenCalled()
  })

  /** Where the stop shortcut is in force, both Stop buttons name it — and
   * only then: a shortcut the OS would not take is not offered. */
  it("names the stop shortcut where it is in force", async () => {
    const controlled = {
      targetId: "w4",
      appName: "TextEdit",
      appKey: "com.apple.TextEdit",
      title: "notes.txt",
      level: "control" as const,
      grantedAt: 1,
      lastUsedAt: 1,
    }
    api.computerSharedState.mockResolvedValue({
      shared: [controlled],
      paused: false,
    })
    // Asked only once the listener is in place, so no change can fall
    // between the answer and the first broadcast.
    let listening: boolean | undefined
    api.computerStopKeyStatus.mockImplementation(async () => {
      listening = handlers.has("computer://stop-key")
      return { failed: "Control+Command+Escape", detail: "taken" }
    })
    mount()
    const stop = await screen.findByRole("button", { name: "Stop agents" })
    await waitFor(() => expect(listening).toBe(true))
    expect(stop.title).not.toContain("⌃⌘Esc")
    await waitFor(() =>
      expect(handlers.get("computer://stop-key")).toBeDefined()
    )
    act(() =>
      handlers.get("computer://stop-key")!({ active: "Control+Command+Escape" })
    )
    await waitFor(() => expect(stop.title).toContain("⌃⌘Esc"))
  })

  /** Stopped, the panel says so and offers only Resume — sharing waits. */
  it("offers Resume while stopped, and nothing to share", async () => {
    api.computerStatus.mockResolvedValue(status({ paused: true }))
    mount()
    fireEvent.click(await screen.findByRole("button", { name: "Computer use" }))
    await screen.findByText(/No agent can read or act/)
    expect(
      screen.getByRole("button", { name: "Share a window…" })
    ).toBeDisabled()
    fireEvent.click(screen.getByRole("button", { name: "Resume" }))
    await waitFor(() => expect(api.computerResume).toHaveBeenCalled())
  })

  /** The switch flipped on elsewhere while the first read was in flight: the
   * read is older, and must not hide the item again. */
  it("keeps a broadcast over the older first read", async () => {
    let finishRead: (v: ComputerToolsSettings) => void = () => {}
    api.getComputerToolsSettings.mockReturnValue(
      new Promise((resolve) => {
        finishRead = resolve
      })
    )
    mount()
    await waitFor(() =>
      expect(handlers.get("computer-tools-settings://changed")).toBeDefined()
    )
    act(() =>
      handlers.get("computer-tools-settings://changed")!({
        enabled: true,
        grantTtlMinutes: 30,
        blocklist: [],
        stopShortcut: "",
      })
    )
    await screen.findByRole("button", { name: "Computer use" })
    await act(async () =>
      finishRead({
        enabled: false,
        grantTtlMinutes: 30,
        blocklist: [],
        stopShortcut: "",
      })
    )
    expect(
      screen.getByRole("button", { name: "Computer use" })
    ).toBeInTheDocument()
  })
})
