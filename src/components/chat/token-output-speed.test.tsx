import { act, render, screen } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { afterEach, describe, expect, it, vi } from "vitest"

import { TokenOutputSpeed } from "./token-output-speed"
import enMessages from "@/i18n/messages/en.json"
import type {
  ConnectionState,
  LiveContentBlock,
} from "@/contexts/acp-connections-context"

const mock = vi.hoisted(() => {
  const state: {
    conn: ConnectionState | undefined
    listener: (() => void) | null
  } = {
    conn: undefined,
    listener: null,
  }
  return {
    subscribeKey: (_key: string, cb: () => void) => {
      state.listener = cb
      return () => {
        if (state.listener === cb) state.listener = null
      }
    },
    getConnection: () => state.conn,
    emit: () => state.listener?.(),
    setConn: (conn: ConnectionState | undefined) => {
      state.conn = conn
    },
  }
})

vi.mock("@/contexts/acp-connections-context", () => ({
  useConnectionStore: () => ({
    subscribeKey: mock.subscribeKey,
    getConnection: mock.getConnection,
  }),
}))

function conn(blocks: LiveContentBlock[]): ConnectionState {
  return {
    connectionId: "c1",
    contextKey: "tab1",
    agentType: "codex",
    workingDir: null,
    status: "prompting",
    liveMessage: {
      id: "live-1",
      role: "assistant",
      content: blocks,
      startedAt: 0,
    },
  } as unknown as ConnectionState
}

function renderBadge() {
  return render(
    <NextIntlClientProvider messages={enMessages} locale="en">
      <TokenOutputSpeed tabId="tab1" />
    </NextIntlClientProvider>
  )
}

let fakeNow = 0

afterEach(() => {
  vi.restoreAllMocks()
  fakeNow = 0
})

describe("TokenOutputSpeed", () => {
  it("shows an estimated tok/s while prompting", () => {
    fakeNow = 1000
    vi.spyOn(performance, "now").mockImplementation(() => fakeNow)
    mock.setConn(conn([{ type: "text", text: "a".repeat(80) }]))
    renderBadge()
    expect(screen.queryByText(/\d+\.\d tok\/s/)).toBeNull()

    fakeNow = 2000
    mock.setConn(conn([{ type: "text", text: "a".repeat(480) }]))
    act(() => mock.emit())
    expect(screen.getByText(/100\.0 tok\/s/)).toBeTruthy()
  })

  it("counts thinking blocks and skips sub-agent blocks", () => {
    fakeNow = 1000
    vi.spyOn(performance, "now").mockImplementation(() => fakeNow)
    mock.setConn(
      conn([
        { type: "text", text: "a".repeat(80) },
        { type: "thinking", text: "a".repeat(80) },
        { type: "text", text: "a".repeat(800), parentToolUseId: "pt-1" },
      ])
    )
    renderBadge()

    fakeNow = 2000
    mock.setConn(
      conn([
        { type: "text", text: "a".repeat(160) },
        { type: "thinking", text: "a".repeat(160) },
        { type: "text", text: "a".repeat(900), parentToolUseId: "pt-1" },
      ])
    )
    act(() => mock.emit())
    // 160 visible root chars → 40 tokens in the second second (plus the
    // first second's 40 seeded as baseline): expect 40.0 tok/s.
    expect(screen.getByText(/40\.0 tok\/s/)).toBeTruthy()
  })

  it("hides when the connection is not prompting", () => {
    const idle = conn([])
    idle.status = "connected"
    mock.setConn(idle)
    renderBadge()
    expect(screen.queryByText(/\d+\.\d tok\/s/)).toBeNull()
  })

  it("hides when there is no live message", () => {
    const noLive = conn([])
    noLive.liveMessage = null
    mock.setConn(noLive)
    renderBadge()
    expect(screen.queryByText(/\d+\.\d tok\/s/)).toBeNull()
  })
})
