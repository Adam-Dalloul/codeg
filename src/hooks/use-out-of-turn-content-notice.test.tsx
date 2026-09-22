import { act, cleanup, renderHook } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { ConnectionState } from "@/contexts/acp-connections-context"
import type { EventEnvelope } from "@/lib/types"
import { useOutOfTurnContentNotice } from "./use-out-of-turn-content-notice"

const h = vi.hoisted(() => ({
  handler: null as ((event: EventEnvelope) => void) | null,
  connection: undefined as ConnectionState | undefined,
  mark: vi.fn(),
}))

vi.mock("@/contexts/acp-connections-context", () => ({
  useAcpEvent: (handler: (event: EventEnvelope) => void) => {
    h.handler = handler
  },
  useConnectionStore: () => ({ getConnection: () => h.connection }),
}))

vi.mock("@/stores/conversation-runtime-store", () => ({
  useConversationRuntimeActions: () => ({ markOutOfTurnContent: h.mark }),
}))

let seq = 0
function emit(event: Record<string, unknown>) {
  act(() => {
    // The real subscriber runs after the connection reducer, before a React
    // render is guaranteed. Keep that ordering, without rerendering the hook.
    if (h.connection && event.type === "status_changed") {
      h.connection = {
        ...h.connection,
        status: event.status as ConnectionState["status"],
      }
    }
    if (h.connection && event.type === "turn_complete") {
      h.connection = { ...h.connection, status: "connected" }
    }
    h.handler!({
      connection_id: "conn-1",
      seq: ++seq,
      ...event,
    } as EventEnvelope)
  })
}

beforeEach(() => {
  h.mark.mockClear()
  seq = 0
  h.connection = {
    connectionId: "conn-1",
    agentType: "codex",
    status: "connected",
    liveMessage: null,
  } as ConnectionState
})
afterEach(cleanup)

describe("out-of-turn content notice", () => {
  it("does not advertise the final Codex chunk after Stop as background work", () => {
    renderHook(() => useOutOfTurnContentNotice("tab", 42))
    // Captured order: prompting, content, TurnComplete(cancelled), connected,
    // one more content_delta. The latter is a stopped foreground reply's tail.
    emit({ type: "status_changed", status: "prompting" })
    emit({ type: "content_delta", text: "1\n2" })
    emit({ type: "turn_complete", stop_reason: "cancelled" })
    emit({ type: "status_changed", status: "connected" })
    emit({ type: "content_delta", text: "\n" })
    emit({ type: "thinking", text: "late reasoning" })
    expect(h.mark).not.toHaveBeenCalled()
  })

  it("keeps recovery for autonomous work after a normal turn", () => {
    renderHook(() => useOutOfTurnContentNotice("tab", 42))
    emit({ type: "status_changed", status: "prompting" })
    emit({ type: "content_delta", text: "reply" })
    expect(h.mark).not.toHaveBeenCalled()
    emit({ type: "turn_complete", stop_reason: "end_turn" })
    emit({ type: "content_delta", text: "background result" })
    expect(h.mark).toHaveBeenCalledWith(42)
  })

  it("resets the cancellation boundary on the next prompt without a render", () => {
    renderHook(() => useOutOfTurnContentNotice("tab", 42))
    emit({ type: "turn_complete", stop_reason: "cancelled" })
    emit({ type: "status_changed", status: "prompting" })
    emit({ type: "content_delta", text: "next reply" })
    emit({ type: "turn_complete", stop_reason: "end_turn" })
    emit({ type: "content_delta", text: "new background result" })
    expect(h.mark).toHaveBeenCalledTimes(1)
  })

  it("retains recovery for a new background tool after Stop", () => {
    renderHook(() => useOutOfTurnContentNotice("tab", 42))
    emit({ type: "turn_complete", stop_reason: "cancelled" })
    emit({ type: "tool_call", tool_call_id: "background-tool" })
    expect(h.mark).toHaveBeenCalledWith(42)
    h.mark.mockClear()
    emit({ type: "content_delta", text: "its result" })
    expect(h.mark).toHaveBeenCalledWith(42)
  })

  it("does not mistake a re-announced interrupted tool for new work", () => {
    h.connection!.liveMessage = {
      id: "live-1",
      role: "assistant",
      startedAt: 1,
      content: [{ type: "tool_call", info: { tool_call_id: "old-tool" } }],
    } as ConnectionState["liveMessage"]
    renderHook(() => useOutOfTurnContentNotice("tab", 42))
    emit({ type: "turn_complete", stop_reason: "cancelled" })
    emit({ type: "tool_call", tool_call_id: "old-tool", status: "failed" })
    emit({ type: "tool_call_update", tool_call_id: "old-tool" })
    expect(h.mark).not.toHaveBeenCalled()
  })

  it("scopes a cancellation to its connection across reconnects", () => {
    renderHook(() => useOutOfTurnContentNotice("tab", 42))
    emit({ type: "turn_complete", stop_reason: "cancelled" })
    h.connection = { ...h.connection!, connectionId: "conn-2" }
    emit({ type: "content_delta", text: "old residue" })
    expect(h.mark).not.toHaveBeenCalled()
    emit({ connection_id: "conn-2", type: "content_delta", text: "new work" })
    expect(h.mark).toHaveBeenCalledWith(42)
  })

  it.each(["connecting", "disconnected", "error"] as const)(
    "does not advertise connection setup or teardown content while %s",
    (status) => {
      h.connection = { ...h.connection!, status }
      renderHook(() => useOutOfTurnContentNotice("tab", 42))
      emit({ type: "content_delta", text: "replayed content" })
      expect(h.mark).not.toHaveBeenCalled()
    }
  )

  it("ignores unmapped connections, empty text and Claude's existing overlay", () => {
    renderHook(() => useOutOfTurnContentNotice("tab", 42))
    emit({ type: "content_delta", text: "" })
    emit({ type: "content_delta", text: "other tab", connection_id: "other" })
    h.connection = { ...h.connection!, agentType: "claude_code" }
    emit({ type: "content_delta", text: "handled by overlay" })
    h.connection = undefined
    emit({ type: "content_delta", text: "after removal" })
    expect(h.mark).not.toHaveBeenCalled()
  })
})
