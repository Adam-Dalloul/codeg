/**
 * How long a non-zero `background_outstanding` count stays visible / sweep-
 * exempt after the last accounting event.
 *
 * Matches the backend default of `CODEG_ACP_BACKGROUND_KEEPALIVE_MAX_SECS`
 * (3600). The Claude transcript watcher already drops un-settled tasks after
 * that window and emits `outstanding: 0`. Grok background subagents have no
 * equivalent ticker, and a snapshot can hydrate a count whose heartbeat is
 * already dead — without this clock the chip and the frontend idle sweep
 * treat a stranded count as immortal.
 */
export const BACKGROUND_KEEPALIVE_MAX_MS = 3_600_000

/**
 * Count the chip / sweep should honor right now. `activityAtMs` is the last
 * `background_activity` event (or the snapshot's `background_activity_at`).
 * A missing timestamp with a positive count is treated as live so a server
 * that omits the new field does not blank a genuine in-flight task.
 */
export function visibleBackgroundOutstanding(
  outstanding: number,
  activityAtMs: number | null | undefined,
  nowMs: number
): number {
  if (outstanding <= 0) return 0
  if (activityAtMs == null) return outstanding
  if (nowMs - activityAtMs >= BACKGROUND_KEEPALIVE_MAX_MS) return 0
  return outstanding
}

export function parseBackgroundActivityAt(
  raw: string | null | undefined
): number | null {
  if (!raw) return null
  const ms = Date.parse(raw)
  return Number.isFinite(ms) ? ms : null
}
