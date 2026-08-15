/**
 * AIR typed session-failure projection helpers.
 *
 * The wire (`session_failure` events / the snapshot's `session_failures`
 * table) carries UPSERTS ONLY — see `SessionFailureRecord` in `lib/types`.
 * These helpers implement the client half of the contract, shared by the
 * connections reducer (live events + snapshot hydrate) so it matches the
 * backend's `SessionState::apply_event` byte for byte:
 *
 * - monotonic per-id merge: a record is accepted only when its revision is
 *   STRICTLY greater than the stored one (equal = verbatim replay, e.g.
 *   claude re-publishing still-active failures on session/load). Accepted
 *   upserts re-arm `resolved` — id reuse with a bumped revision is how codex
 *   escalates a retry warning into the turn's terminal error, and how a
 *   settled incident legitimately recurs.
 * - inferred resolution: adapters never publish resolve/tombstone, so the
 *   client settles records itself — severity-"warning" ones at the turn
 *   boundary (mirroring the retry banner's clear-at-turn-end), and EVERYTHING
 *   when the user starts a new prompt (acting past an error acknowledges it;
 *   a still-real failure comes back with a higher revision).
 *
 * Entries are retained after resolution — each doubles as its id's revision
 * watermark, so a delayed stale upsert can never resurrect a settled record.
 * Kept dependency-free for unit testing without the context harness.
 */

import type { SessionFailureRecord } from "@/lib/types"

/** Merge one incoming upsert; returns the SAME array reference when rejected. */
export function upsertSessionFailure(
  current: SessionFailureRecord[],
  record: SessionFailureRecord
): SessionFailureRecord[] {
  return mergeSessionFailures(current, [record])
}

/**
 * Merge a batch of upserts (snapshot hydrate) into the current table by the
 * monotonic per-id rule. Returns the same array reference when nothing
 * changed, so reducer consumers can cheaply detect no-ops.
 */
export function mergeSessionFailures(
  current: SessionFailureRecord[],
  incoming: SessionFailureRecord[] | null | undefined
): SessionFailureRecord[] {
  if (!incoming || incoming.length === 0) return current
  let next: SessionFailureRecord[] | null = null
  for (const record of incoming) {
    if (!record.id || !(record.revision >= 1)) continue
    const target = next ?? current
    const index = target.findIndex((f) => f.id === record.id)
    if (index >= 0 && record.revision <= target[index].revision) continue
    next ??= [...current]
    const accepted: SessionFailureRecord = {
      ...record,
      resolved: record.resolved ?? false,
    }
    const nextIndex = next.findIndex((f) => f.id === record.id)
    if (nextIndex >= 0) next[nextIndex] = accepted
    else next.push(accepted)
  }
  return next ?? current
}

/**
 * Settle records in place at a lifecycle boundary: `"warnings"` at turn end
 * (errors must survive — codex deliberately keeps terminal records active),
 * `"all"` when the user starts a new prompt. Returns the same array reference
 * when nothing needed settling.
 */
export function settleSessionFailures(
  failures: SessionFailureRecord[],
  scope: "warnings" | "all"
): SessionFailureRecord[] {
  const settles = (f: SessionFailureRecord) =>
    !f.resolved && (scope === "all" || f.severity === "warning")
  if (!failures.some(settles)) return failures
  return failures.map((f) => (settles(f) ? { ...f, resolved: true } : f))
}

/** Unresolved records, for the banner's active section. */
export function activeSessionFailures(
  failures: SessionFailureRecord[]
): SessionFailureRecord[] {
  return failures.filter((f) => !f.resolved)
}

/** Resolved records, for the banner's collapsed "recovered" rows. */
export function resolvedSessionFailures(
  failures: SessionFailureRecord[]
): SessionFailureRecord[] {
  return failures.filter((f) => f.resolved)
}

/** The AIR action vocabulary the banner knows how to wire. */
export const KNOWN_SESSION_FAILURE_ACTIONS = [
  "retry",
  "login",
  "new_session",
] as const

export type SessionFailureAction =
  (typeof KNOWN_SESSION_FAILURE_ACTIONS)[number]

/** The record's suggested actions filtered to the renderable vocabulary. */
export function knownSessionFailureActions(
  record: SessionFailureRecord
): SessionFailureAction[] {
  const actions = record.actions ?? []
  return KNOWN_SESSION_FAILURE_ACTIONS.filter((a) => actions.includes(a))
}
