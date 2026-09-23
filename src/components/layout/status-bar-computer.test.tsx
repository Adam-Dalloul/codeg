import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { beforeEach, describe, expect, it, vi } from "vitest"

import type {
  ComputerStatus,
  ComputerToolsSettings,
} from "@/lib/computer/types"

const api = vi.hoisted(() => ({
  computerAvailable: vi.fn(() => true),
  getComputerToolsSettings: vi.fn(),
  computerStatus: vi.fn<() => Promise<ComputerStatus>>(),
  computerRequestPermission: vi.fn(),
  computerOpenPermissionSettings: vi.fn(),
  computerShareWindow: vi.fn(),
  computerRevokeAll: vi.fn(),
  computerListShareableWindows: vi.fn(),
  computerWindowThumbnail: vi.fn(),
}))
vi.mock("@/lib/computer/computer-api", () => api)
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
import { resetComputerStoreForTest } from "@/lib/computer/computer-store"

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
  })
  api.computerStatus.mockResolvedValue(status())
})

describe("StatusBarComputer", () => {
  it("is not there while computer use is off", async () => {
    api.getComputerToolsSettings.mockResolvedValue({
      enabled: false,
      grantTtlMinutes: 30,
      blocklist: [],
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
      })
    )
    await screen.findByRole("button", { name: "Computer use" })
    await act(async () =>
      finishRead({ enabled: false, grantTtlMinutes: 30, blocklist: [] })
    )
    expect(
      screen.getByRole("button", { name: "Computer use" })
    ).toBeInTheDocument()
  })
})
