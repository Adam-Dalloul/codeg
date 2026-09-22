"use client"

import { useRef } from "react"
import {
  useAcpEvent,
  useConnectionStore,
} from "@/contexts/acp-connections-context"
import {
  hasTranscriptOverlay,
  isOutOfTurnContentEvent,
} from "@/lib/background-agent"
import { useConversationRuntimeActions } from "@/stores/conversation-runtime-store"

/** Offer transcript recovery for autonomous work, excluding a stopped reply's
 * trailing text. Stop completes the turn before the agent acknowledges cancel,
 * so already-buffered chunks can still arrive while the connection is idle. */
export function useOutOfTurnContentNotice(
  contextKey: string,
  conversationId: number
): void {
  const store = useConnectionStore()
  const { markOutOfTurnContent } = useConversationRuntimeActions()
  const cancelledConnection = useRef<string | null>(null)

  useAcpEvent((envelope) => {
    // Read identity AND status from the authoritative store at event time.
    // A render-captured connection can be stale across a reconnect or rekey.
    const connection = store.getConnection(contextKey)
    if (!connection || envelope.connection_id !== connection.connectionId)
      return

    if (envelope.type === "turn_complete") {
      cancelledConnection.current =
        envelope.stop_reason === "cancelled" ? envelope.connection_id : null
      return
    }
    if (envelope.type === "status_changed" && envelope.status === "prompting") {
      cancelledConnection.current = null
      return
    }
    if (
      connection.status !== "connected" ||
      hasTranscriptOverlay(connection.agentType) ||
      !isOutOfTurnContentEvent(envelope)
    ) {
      return
    }

    if (cancelledConnection.current === envelope.connection_id) {
      // A new tool starts independently observable work; text alone immediately
      // following Stop is continuation of the reply the user just interrupted.
      if (envelope.type !== "tool_call") return
      // Re-announcing an interrupted tool is also a continuation, not new work.
      if (
        connection.liveMessage?.content.some(
          (block) =>
            block.type === "tool_call" &&
            block.info.tool_call_id === envelope.tool_call_id
        )
      ) {
        return
      }
      cancelledConnection.current = null
    }

    markOutOfTurnContent(conversationId)
  })
}
