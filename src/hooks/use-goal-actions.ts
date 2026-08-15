"use client"

/**
 * The goal-control action vocabulary a connection's adapter ADVERTISED,
 * recovered from the session snapshot (`goal_actions` — launch-latched, same
 * snapshot-read pattern as the steering availability in
 * `use-session-feedback`).
 *
 * Fail-closed contract: until the snapshot for EXACTLY this `connectionId`
 * resolves, and whenever the fetch fails, the hook returns `NO_GOAL_ACTIONS`
 * — the goal card then offers no Pause/Clear at all. Offering a wrong
 * affordance is worse than briefly offering none: claude's advertised
 * vocabulary has no "pause", so a legacy-default window would let the user
 * fire a request the adapter rejects. A resolved snapshot MISSING the
 * `goal_actions` field (older server) maps to the legacy `["pause","clear"]`
 * for backward compatibility. Keying the loaded value by connection id also
 * guarantees a reconnect/re-spawn (new id, possibly a different binary)
 * never inherits the previous process's vocabulary.
 */

import { useEffect, useState } from "react"

import { acpGetSessionSnapshot } from "@/lib/api"
import {
  LEGACY_GOAL_ACTIONS,
  NO_GOAL_ACTIONS,
} from "@/components/message/goal-control-context"

export function useAdvertisedGoalActions(
  connectionId: string | null
): readonly string[] {
  const [loaded, setLoaded] = useState<{
    id: string
    actions: readonly string[]
  } | null>(null)

  useEffect(() => {
    if (!connectionId) return
    let stale = false
    acpGetSessionSnapshot(connectionId)
      .then((snap) => {
        // A nullish snapshot means NOTHING was learned (connection already
        // gone) — stay fail-closed. Only an EXISTING snapshot from an older
        // server that predates the field maps to the legacy vocabulary.
        if (stale || !snap) return
        setLoaded({
          id: connectionId,
          actions: snap.goal_actions ?? LEGACY_GOAL_ACTIONS,
        })
      })
      .catch(() => {
        // Unknown vocabulary stays unknown — the mismatch below keeps
        // rendering "no controls" rather than guessing.
      })
    return () => {
      stale = true
    }
  }, [connectionId])

  return loaded && loaded.id === connectionId ? loaded.actions : NO_GOAL_ACTIONS
}
