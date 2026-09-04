import { fireEvent, render, screen } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { TerminalPanel } from "./terminal-panel"

// The panel only decides *whether* the mobile key bar is on; the tab bar and
// the xterm host are stubbed so this stays a test of that decision (and of the
// collapse state it persists), not of xterm.
vi.mock("./terminal-tab-bar", () => ({
  TerminalTabBar: ({
    showKeybarToggle,
    keybarCollapsed,
    onToggleKeybar,
  }: {
    showKeybarToggle?: boolean
    keybarCollapsed?: boolean
    onToggleKeybar?: () => void
  }) => (
    <div>
      <span data-testid="toggle-shown">{String(showKeybarToggle)}</span>
      <span data-testid="collapsed">{String(keybarCollapsed)}</span>
      <button data-testid="toggle" onClick={onToggleKeybar}>
        toggle
      </button>
    </div>
  ),
}))

vi.mock("./terminal-view", () => ({
  TerminalView: ({
    terminalId,
    keybarVisible,
  }: {
    terminalId: string
    keybarVisible?: boolean
  }) => (
    <div
      data-testid={`view-${terminalId}`}
      data-keybar={String(keybarVisible)}
    />
  ),
}))

const terminalContext = {
  isOpen: true,
  tabs: [{ id: "t1", title: "1", workingDir: "/tmp" }],
  activeTabId: "t1",
  markTerminalExited: () => {},
}

vi.mock("@/contexts/terminal-context", () => ({
  useTerminalContext: () => terminalContext,
}))

const STORAGE_KEY = "codeg:term-keybar"

/** Drive `useIsMobile()` — it reads `window.matchMedia(query).matches`. */
function setViewport(mobile: boolean) {
  window.matchMedia = ((query: string) => ({
    matches: mobile && query.includes("max-width"),
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia
}

beforeEach(() => {
  window.localStorage.clear()
})

afterEach(() => {
  // Other suites render at the desktop breakpoint by default (test-setup.ts);
  // don't leak a mobile matchMedia stub into them.
  setViewport(false)
  window.localStorage.clear()
})

describe("<TerminalPanel /> 键栏门控", () => {
  it("桌面端不显示折叠开关，也不给 view 传 keybarVisible", () => {
    setViewport(false)
    render(<TerminalPanel />)
    expect(screen.getByTestId("toggle-shown")).toHaveTextContent("false")
    expect(screen.getByTestId("view-t1")).toHaveAttribute(
      "data-keybar",
      "false"
    )
  })

  it("移动端默认展开键栏并显示折叠开关", () => {
    setViewport(true)
    render(<TerminalPanel />)
    expect(screen.getByTestId("toggle-shown")).toHaveTextContent("true")
    expect(screen.getByTestId("view-t1")).toHaveAttribute("data-keybar", "true")
  })

  it("折叠状态写入 localStorage，并在重新挂载后恢复", () => {
    setViewport(true)
    const { unmount } = render(<TerminalPanel />)

    fireEvent.click(screen.getByTestId("toggle"))
    expect(screen.getByTestId("view-t1")).toHaveAttribute(
      "data-keybar",
      "false"
    )
    expect(window.localStorage.getItem(STORAGE_KEY)).toBe("1")

    unmount()
    render(<TerminalPanel />)
    expect(screen.getByTestId("collapsed")).toHaveTextContent("true")
    expect(screen.getByTestId("view-t1")).toHaveAttribute(
      "data-keybar",
      "false"
    )
  })

  it("折叠态是面板级的：桌面端折叠后切到移动端仍然折叠", () => {
    setViewport(false)
    const { unmount } = render(<TerminalPanel />)
    fireEvent.click(screen.getByTestId("toggle"))
    expect(window.localStorage.getItem(STORAGE_KEY)).toBe("1")
    unmount()

    setViewport(true)
    render(<TerminalPanel />)
    expect(screen.getByTestId("view-t1")).toHaveAttribute(
      "data-keybar",
      "false"
    )
  })
})
