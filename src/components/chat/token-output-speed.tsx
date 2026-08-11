"use client"

import { useEffect, useState } from "react"
import { Zap } from "lucide-react"
import { useTranslations } from "next-intl"
import {
  useConnectionStore,
  type LiveContentBlock,
  type LiveMessage,
} from "@/contexts/acp-connections-context"
import { TokenCountAccumulator, TokenSpeedTracker } from "@/lib/token-speed"

/** Repaint cadence. The badge is a gauge, not a counter — 2 Hz reads calmly. */
const THROTTLE_MS = 500
/**
 * Idle tick. The store only notifies on wire activity, so without a clock of our
 * own the reading would freeze rather than decay through a silent gap — a quiet
 * long-running tool, a retry backoff, or a permission / question prompt blocking
 * the turn. Runs only while a turn is streaming.
 */
const HEARTBEAT_MS = 500
const MAX_TPS = 999.9

/**
 * Live token-output-speed badge for one conversation tab, rendered in the
 * status row below the composer (before the context-window circle). Shows only
 * while the tab's agent is prompting; the reading is a local estimate from the
 * streamed `text` + `thinking` blocks (root agent only, no sub-agent content).
 * TODO: root-agent only; give sub-agent cards their own badge if cross-agent
 * delegation speed becomes something users ask about.
 */
export function TokenOutputSpeed({ tabId }: { tabId: string | null }) {
  const t = useTranslations("Folder.statusBar.tokens")
  const store = useConnectionStore()
  const [tps, setTps] = useState<number | null>(null)

  useEffect(() => {
    if (!tabId) return
    const tracker = new TokenSpeedTracker()
    const counts = new TokenCountAccumulator()
    let messageId: string | null = null
    let total = 0
    let lastRender = 0
    let heartbeat: ReturnType<typeof setInterval> | null = null

    const stopHeartbeat = () => {
      if (heartbeat == null) return
      clearInterval(heartbeat)
      heartbeat = null
    }

    /** The tab's in-flight assistant message, or `null` when no turn is running. */
    const liveMessage = (): LiveMessage | null => {
      const conn = store.getConnection(tabId)
      return conn?.status === "prompting" ? (conn.liveMessage ?? null) : null
    }

    /**
     * The accumulator caches each block's consumed length, which only holds while
     * the turn appends to its blocks. A snapshot hydration swaps `liveMessage`
     * out wholesale, so those cached prefixes may describe entirely different
     * text — re-seat whenever the message identity changes.
     */
    const reseatIfReplaced = (live: LiveMessage) => {
      if (live.id === messageId) return
      messageId = live.id
      counts.reset()
      tracker.reset()
      lastRender = 0
    }

    /** Re-measure the root agent's output. Only appended text is scanned. */
    const measure = (content: LiveContentBlock[]): number => {
      counts.beginPass()
      for (const block of content) {
        // Sub-agent text/thinking (`parentToolUseId`) is another agent's output
        // and belongs to its capsule, not to this tab's rate.
        if (
          (block.type === "text" || block.type === "thinking") &&
          block.parentToolUseId == null
        ) {
          counts.push(block.text)
        }
      }
      return counts.endPass()
    }

    const publish = (rate: number | null, now: number) => {
      if (rate == null) return
      if (now - lastRender < THROTTLE_MS) return
      lastRender = now
      setTps(Math.min(Math.max(rate, 0), MAX_TPS))
    }

    /** Idle tick — no new tokens, so the rate decays instead of freezing. */
    const beat = () => {
      const now = performance.now()
      publish(tracker.observe(total, now), now)
    }

    const startHeartbeat = () => {
      if (heartbeat == null) heartbeat = setInterval(beat, HEARTBEAT_MS)
    }

    const onChange = () => {
      const live = liveMessage()
      // Turn ended, or a fresh turn started with empty content (STATUS_CHANGED
      // to prompting rebuilds liveMessage) — drop the baseline and hide.
      if (!live || live.content.length === 0) {
        stopHeartbeat()
        tracker.reset()
        counts.reset()
        messageId = null
        total = 0
        lastRender = 0
        setTps(null)
        return
      }
      reseatIfReplaced(live)
      total = measure(live.content)
      const now = performance.now()
      publish(tracker.observe(total, now), now)
      startHeartbeat()
    }

    // Mid-turn attach (refresh / reconnect): seed the baseline from whatever has
    // already streamed so the first delta measures a real rate instead of the
    // whole accumulated turn. Deliberately doesn't publish — `observe` only
    // seeds on its first call, and setting state inside an effect body is a
    // lint error besides.
    const initial = liveMessage()
    if (initial && initial.content.length > 0) {
      messageId = initial.id
      total = measure(initial.content)
      tracker.observe(total, performance.now())
      startHeartbeat()
    }

    const unsubscribe = store.subscribeKey(tabId, onChange)
    return () => {
      unsubscribe()
      stopHeartbeat()
    }
  }, [store, tabId])

  if (tps == null) return null

  return (
    <span
      className="flex items-center gap-1 tabular-nums"
      title={t("outputSpeedTooltip")}
    >
      {/* Name hangs off the icon, matching `ComposerContextUsage` — `aria-label`
          on the bare wrapper span carries no role and isn't reliably exposed. */}
      <Zap aria-label={t("outputSpeedAria")} className="size-3.5" />
      {tps.toFixed(1)} tok/s
    </span>
  )
}
