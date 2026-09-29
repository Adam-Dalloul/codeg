import { act, fireEvent, render, screen } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { beforeEach, describe, expect, it, vi } from "vitest"

import type {
  ComputerStatus,
  PickerWindow,
  ShareManyResult,
} from "@/lib/computer/types"

const api = vi.hoisted(() => ({
  computerAvailable: vi.fn(() => false),
  computerListShareableWindows: vi.fn<() => Promise<PickerWindow[]>>(),
  computerShareWindow: vi.fn(),
  computerShareWindows:
    vi.fn<(ids: string[], level: string) => Promise<ShareManyResult>>(),
  computerRevokeAll: vi.fn(async () => {}),
  computerWindowThumbnail: vi.fn(async () => null),
  computerStatus: vi.fn<() => Promise<ComputerStatus>>(),
  computerRequestPermission: vi.fn(async () => ({})),
  computerOpenPermissionSettings: vi.fn(async () => {}),
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

function window(
  level: PickerWindow["level"],
  overrides: Partial<PickerWindow> = {}
): PickerWindow {
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
    ...overrides,
  }
}

function mount() {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <ComputerWindowPicker open onOpenChange={() => {}} />
    </NextIntlClientProvider>
  )
}

function status(screenRecording: boolean): ComputerStatus {
  return {
    enabled: true,
    platform: "macos",
    verifiedPlatform: false,
    backend: { state: "ready", driverVersion: "0.28.2", peer: "verified" },
    permissions: { required: true, accessibility: true, screenRecording },
    shared: [],
    paused: false,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  resetComputerStoreForTest()
  api.computerAvailable.mockReturnValue(false)
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

  /** "All" is every window that can be shared — what the grid shows — and
   * never one of the windows kept out of it. */
  it("shares every shareable window at once", async () => {
    api.computerListShareableWindows.mockResolvedValue([
      window("none"),
      window("read", { targetId: "w2", appName: "Notes", title: "todo" }),
      window("none", {
        targetId: "w3",
        appName: "codeg",
        title: "codeg",
        notGrantable: "codeg",
      }),
    ])
    api.computerShareWindows.mockResolvedValue({ shared: [], skipped: 0 })
    mount()
    await openMenu(await screen.findByRole("button", { name: /Share all/ }))
    await act(async () => {
      fireEvent.click(
        screen.getByRole("menuitem", {
          name: "Let agents read and act on all of them",
        })
      )
      await Promise.resolve()
    })
    expect(api.computerShareWindows).toHaveBeenCalledWith(
      ["w1", "w2"],
      "control"
    )
  })

  /** A window that closed between the list and the share is reported, and
   * the list read again. */
  it("says how many could not be shared", async () => {
    api.computerListShareableWindows.mockResolvedValue([window("none")])
    api.computerShareWindows.mockResolvedValue({ shared: [], skipped: 1 })
    mount()
    await openMenu(await screen.findByRole("button", { name: /Share all/ }))
    await act(async () => {
      fireEvent.click(
        screen.getByRole("menuitem", { name: "Let agents read all of them" })
      )
      await Promise.resolve()
    })
    expect(
      await screen.findByText(
        "1 window could not be shared; it may have closed."
      )
    ).toBeInTheDocument()
    expect(api.computerListShareableWindows).toHaveBeenCalledTimes(2)
  })

  /** One change at a time: "stop sharing all" waits for a share still on
   *  its way, which would otherwise land after it and undo it. */
  it("takes one change at a time", async () => {
    api.computerListShareableWindows.mockResolvedValue([
      window("read"),
      window("none", { targetId: "w2", appName: "Notes", title: "todo" }),
    ])
    api.computerShareWindow.mockReturnValue(new Promise(() => {}))
    mount()
    const stopAll = await screen.findByRole("button", {
      name: "Stop sharing all",
    })
    await openMenu(await screen.findByRole("button", { name: "Share" }))
    await act(async () => {
      fireEvent.click(
        screen.getByRole("menuitem", { name: "Let agents read and act on it" })
      )
      await Promise.resolve()
    })
    expect(stopAll).toBeDisabled()
    expect(screen.getByRole("button", { name: /Share all/ })).toBeDisabled()
  })

  /** Stopping every sharing is there once anything is shared. */
  it("stops sharing every window at once", async () => {
    api.computerListShareableWindows.mockResolvedValue([window("read")])
    mount()
    fireEvent.click(
      await screen.findByRole("button", { name: "Stop sharing all" })
    )
    await act(async () => {
      await Promise.resolve()
    })
    expect(api.computerRevokeAll).toHaveBeenCalled()
  })

  /** Without Screen Recording there are no titles and no pictures: the
   *  picker says so and offers to grant it. */
  it("says Screen Recording is missing and offers it", async () => {
    api.computerAvailable.mockReturnValue(true)
    api.computerStatus.mockResolvedValue(status(false))
    api.computerListShareableWindows.mockResolvedValue([
      window("none", { title: "" }),
    ])
    mount()
    expect(
      await screen.findByText(/doesn't have Screen Recording yet/)
    ).toBeInTheDocument()
    expect(screen.getByText("Untitled window")).toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: "Request" }))
    await act(async () => {
      await Promise.resolve()
    })
    expect(api.computerRequestPermission).toHaveBeenCalledWith(
      "screenRecording"
    )
  })

  /** Back from System Settings with Screen Recording granted, the windows
   *  are listed again and their pictures fetched again — and the notice is
   *  gone. */
  it("reads the windows again once Screen Recording arrives", async () => {
    api.computerAvailable.mockReturnValue(true)
    api.computerStatus.mockResolvedValue(status(false))
    api.computerListShareableWindows.mockResolvedValue([window("none")])
    mount()
    await screen.findByText(/doesn't have Screen Recording yet/)
    await screen.findByRole("button", { name: "Share" })
    expect(api.computerListShareableWindows).toHaveBeenCalledTimes(1)
    expect(api.computerWindowThumbnail).toHaveBeenCalledTimes(1)

    api.computerStatus.mockResolvedValue(status(true))
    await act(async () => {
      globalThis.window.dispatchEvent(new Event("focus"))
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    expect(screen.queryByText(/doesn't have Screen Recording yet/)).toBeNull()
    expect(api.computerListShareableWindows).toHaveBeenCalledTimes(2)
    expect(api.computerWindowThumbnail).toHaveBeenCalledTimes(2)
  })

  /** Refresh fetches the pictures again, not only the list. */
  it("fetches the pictures again on refresh", async () => {
    api.computerListShareableWindows.mockResolvedValue([window("none")])
    mount()
    await screen.findByRole("button", { name: "Share" })
    expect(api.computerWindowThumbnail).toHaveBeenCalledTimes(1)
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Refresh" }))
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    expect(api.computerWindowThumbnail).toHaveBeenCalledTimes(2)
  })

  /** Windows that can never be shared are kept out of the grid, folded
   * away with their reasons — codeg's with why. */
  it("folds the windows that cannot be shared away, with the reason", async () => {
    api.computerListShareableWindows.mockResolvedValue([
      window("none"),
      window("none", {
        targetId: "w3",
        appName: "codeg",
        title: "Settings",
        notGrantable: "codeg",
      }),
    ])
    mount()
    await screen.findByRole("button", { name: "Share" })
    expect(screen.queryByText("codeg's window")).toBeNull()
    fireEvent.click(
      screen.getByRole("button", { name: "1 window can't be shared" })
    )
    expect(await screen.findByText("codeg's window")).toBeInTheDocument()
    expect(
      screen.getByText(/could approve its own requests/)
    ).toBeInTheDocument()
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
