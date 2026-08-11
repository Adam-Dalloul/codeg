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

function conn(
  blocks: LiveContentBlock[],
  messageId = "live-1"
): ConnectionState {
  return {
    connectionId: "c1",
    contextKey: "tab1",
    agentType: "codex",
    workingDir: null,
    status: "prompting",
    liveMessage: {
      id: messageId,
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

/** The rendered reading, or `null` when the badge is hidden. */
function reading(): number | null {
  const node = screen.queryByText(/tok\/s/)
  return node ? Number.parseFloat(node.textContent ?? "") : null
}

let fakeNow = 0

afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
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

  it("opens near the real rate under the store's real notification order", () => {
    // The store notifies once per wire envelope before the batched content
    // delta lands, so most callbacks see unchanged content. The badge must not
    // open at 0.0 and crawl upward.
    vi.spyOn(performance, "now").mockImplementation(() => fakeNow)
    fakeNow = 1000
    let chars = 80
    mock.setConn(conn([{ type: "text", text: "a".repeat(chars) }]))
    renderBadge()

    // 4 latin chars per 16ms batch = 250 chars/s = 62.5 tok/s.
    for (let step = 4; step <= 1200; step += 4) {
      fakeNow = 1000 + step
      if (step % 16 === 0) {
        chars += 4
        mock.setConn(conn([{ type: "text", text: "a".repeat(chars) }]))
      }
      act(() => mock.emit())
      if (reading() != null) break
    }

    const first = reading()
    expect(first).not.toBeNull()
    expect(first as number).toBeGreaterThan(62.5 * 0.85)
    expect(first as number).toBeLessThan(62.5 * 1.15)
  })

  it("hides again when the turn ends", () => {
    fakeNow = 1000
    vi.spyOn(performance, "now").mockImplementation(() => fakeNow)
    mock.setConn(conn([{ type: "text", text: "a".repeat(80) }]))
    renderBadge()
    fakeNow = 2000
    mock.setConn(conn([{ type: "text", text: "a".repeat(480) }]))
    act(() => mock.emit())
    expect(reading()).toBeCloseTo(100)

    const done = conn([{ type: "text", text: "a".repeat(480) }])
    done.status = "connected"
    mock.setConn(done)
    act(() => mock.emit())
    expect(reading()).toBeNull()
  })

  it("throttles repaints to one per interval", () => {
    fakeNow = 1000
    vi.spyOn(performance, "now").mockImplementation(() => fakeNow)
    mock.setConn(conn([{ type: "text", text: "a".repeat(80) }]))
    renderBadge()
    fakeNow = 2000
    mock.setConn(conn([{ type: "text", text: "a".repeat(480) }]))
    act(() => mock.emit())
    expect(reading()).toBeCloseTo(100)

    // Well inside the throttle window, and a big jump in output: still frozen.
    fakeNow = 2100
    mock.setConn(conn([{ type: "text", text: "a".repeat(4000) }]))
    act(() => mock.emit())
    expect(reading()).toBeCloseTo(100)

    // Past the window: the reading catches up.
    fakeNow = 2600
    mock.setConn(conn([{ type: "text", text: "a".repeat(8000) }]))
    act(() => mock.emit())
    expect(reading() as number).toBeGreaterThan(100)
  })

  it("re-seats when a snapshot hydration replaces the live message", () => {
    // Hydration swaps `liveMessage` out wholesale instead of appending, so the
    // accumulator's cached per-block prefixes can describe unrelated text. The
    // replacement here is longer than what was cached but shares no prefix — if
    // the badge trusted the cache it would measure only the length difference
    // and report a far too small rate.
    vi.spyOn(performance, "now").mockImplementation(() => fakeNow)
    fakeNow = 1000
    mock.setConn(conn([{ type: "text", text: "a".repeat(400) }], "live-1"))
    renderBadge()

    fakeNow = 2000
    mock.setConn(conn([{ type: "text", text: "b".repeat(800) }], "live-2"))
    act(() => mock.emit())
    // The re-seat drops the baseline, so this sample only seeds.
    expect(reading()).toBeNull()

    // 800 → 1200 chars of the hydrated message = 100 new tokens in one second.
    fakeNow = 3000
    mock.setConn(conn([{ type: "text", text: "b".repeat(1200) }], "live-2"))
    act(() => mock.emit())
    expect(reading()).toBeCloseTo(100)
  })

  it("decays through a silent gap instead of freezing the reading", () => {
    // No wire events at all — a quiet long-running tool, a retry backoff, or a
    // permission prompt blocking the turn. Only the component's own heartbeat
    // runs, and the reading has to fall.
    vi.useFakeTimers()
    vi.spyOn(performance, "now").mockImplementation(() => fakeNow)
    fakeNow = 1000
    mock.setConn(conn([{ type: "text", text: "a".repeat(80) }]))
    renderBadge()
    fakeNow = 2000
    mock.setConn(conn([{ type: "text", text: "a".repeat(480) }]))
    act(() => mock.emit())
    expect(reading()).toBeCloseTo(100)

    for (let i = 0; i < 20; i++) {
      fakeNow += 500
      act(() => {
        vi.advanceTimersByTime(500)
      })
    }
    expect(reading() as number).toBeLessThan(5)
  })
})
