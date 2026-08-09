"use client"

import { useEffect, useRef, useState } from "react"
import { Zap } from "lucide-react"
import { useTranslations } from "next-intl"
import { useConnectionStore } from "@/contexts/acp-connections-context"
import { estimateTokens, TokenSpeedTracker } from "@/lib/token-speed"

const THROTTLE_MS = 500
const MAX_TPS = 999.9

/**
 * Live token-output-speed badge for one conversation tab, rendered in the
 * status row below the composer (before the context-window circle). Shows only
 * while the tab's agent is prompting; the reading is a local estimate from the
 * streamed `text` + `thinking` blocks (root agent only, no sub-agent content).
 * ponytail: root-agent only; give sub-agent cards their own badge if cross-
 * agent delegation speed becomes something users ask about.
 */
export function TokenOutputSpeed({ tabId }: { tabId: string | null }) {
  const t = useTranslations("Folder.statusBar.tokens")
  const store = useConnectionStore()
  const [tps, setTps] = useState<number | null>(null)
  const lastRenderRef = useRef(0)

  useEffect(() => {
    if (!tabId) return
    const tracker = new TokenSpeedTracker()
    lastRenderRef.current = 0

    // Mid-turn attach (refresh / reconnect): seed the baseline from whatever
    // has already streamed so the first delta after mount measures a real
    // rate instead of the whole accumulated text.
    const conn = store.getConnection(tabId)
    const content =
      conn?.status === "prompting" && conn.liveMessage
        ? conn.liveMessage.content
        : null
    if (content && content.length > 0) {
      let total = 0
      for (const block of content) {
        if (
          (block.type === "text" || block.type === "thinking") &&
          block.parentToolUseId == null
        ) {
          total += estimateTokens(block.text)
        }
      }
      tracker.observe(total, performance.now())
    }

    return store.subscribeKey(tabId, () => {
      const next = store.getConnection(tabId)
      const nextContent =
        next?.status === "prompting" && next.liveMessage
          ? next.liveMessage.content
          : null
      // Turn ended, or a fresh turn started with empty content (STATUS_CHANGED
      // to prompting rebuilds liveMessage) — reset the baseline and hide.
      if (!nextContent || nextContent.length === 0) {
        tracker.reset()
        lastRenderRef.current = 0
        setTps(null)
        return
      }
      let total = 0
      for (const block of nextContent) {
        if (
          (block.type === "text" || block.type === "thinking") &&
          block.parentToolUseId == null
        ) {
          total += estimateTokens(block.text)
        }
      }
      const now = performance.now()
      const rate = tracker.observe(total, now)
      if (rate == null) return
      if (now - lastRenderRef.current >= THROTTLE_MS) {
        lastRenderRef.current = now
        setTps(Math.min(Math.max(rate, 0), MAX_TPS))
      }
    })
  }, [store, tabId])

  if (tps == null) return null

  return (
    <span
      aria-label={t("outputSpeedAria")}
      className="flex items-center gap-1"
      title={t("outputSpeedTooltip")}
    >
      <Zap className="size-3.5" />
      {tps.toFixed(1)} tok/s
    </span>
  )
}
