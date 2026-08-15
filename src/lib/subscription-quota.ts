/**
 * Remaining-subscription inventory.
 *
 * ACP `usage_update` is context occupancy `{used, size}`, not plan remaining.
 *
 * Official remaining-quota sources, verified against live CLIs:
 *   Codex: documented app-server `account/rateLimits/read`.
 *     Live result (2026-08-15) is `{ rateLimits.primary.usedPercent,
 *     windowDurationMins, resetsAt, planType, rateLimitsByLimitId }`.
 *     `primary` is the current window (here a 10080-minute week), not a
 *     guaranteed 5-hour window.
 *   Claude: `claude auth status` returns subscription type only.
 *     `claude -p /usage` returns a prose sentence, not `five_hour`.
 *     The `/usage` HUD parser is kept for that payload if one arrives;
 *     Codeg does not scrape undocumented Anthropic HTTP endpoints.
 * Gemini / Grok / OpenCode: no remaining-quota command. OpenCode `stats`
 * is historical token/cost, not plan remaining.
 */

export type IsolatableFamily = "claude" | "codex" | "grok" | "gemini" | "opencode"

export type QuotaKind = "remaining-subscription" | "acp-context" | "unavailable"

export type QuotaWindow = {
  remaining: number
  usedPercent: number
  windowDurationMins?: number
  resetsAt?: number
  label?: string
}

export type FamilyQuota =
  | {
      family: IsolatableFamily
      kind: "remaining-subscription"
      remaining: number
      limit: number
      source: string
      planType?: string
      rateLimitReached?: boolean
      extras?: QuotaWindow[]
      resetsAt?: number
      windowDurationMins?: number
    }
  | {
      family: IsolatableFamily
      kind: "acp-context"
      used: number
      size: number
    }
  | {
      family: IsolatableFamily
      kind: "unavailable"
      providerUsageUrl: string
    }

export const PROVIDER_USAGE_URLS: Record<IsolatableFamily, string> = {
  claude: "https://claude.ai/settings/usage",
  codex: "https://chatgpt.com/#settings",
  grok: "https://accounts.x.ai/",
  gemini: "https://aistudio.google.com/",
  opencode: "https://opencode.ai/",
}

const FAMILIES: IsolatableFamily[] = [
  "claude",
  "codex",
  "grok",
  "gemini",
  "opencode",
]

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function percentRemaining(usedPercent: unknown): number | null {
  if (typeof usedPercent !== "number" || !Number.isFinite(usedPercent)) {
    return null
  }
  return Math.max(0, Math.min(100, 100 - usedPercent))
}

function utilizationRemaining(utilization: unknown): number | null {
  if (typeof utilization !== "number" || !Number.isFinite(utilization)) {
    return null
  }
  return Math.max(0, Math.min(100, (1 - utilization) * 100))
}

function windowFromLimit(limit: Record<string, unknown>): QuotaWindow | null {
  const primary = asRecord(limit.primary)
  const remaining = percentRemaining(primary?.usedPercent)
  if (remaining == null || typeof primary?.usedPercent !== "number") return null
  const windowDurationMins =
    typeof primary.windowDurationMins === "number"
      ? primary.windowDurationMins
      : undefined
  const resetsAt =
    typeof primary.resetsAt === "number" ? primary.resetsAt : undefined
  const label =
    typeof limit.limitName === "string"
      ? limit.limitName
      : typeof limit.limitId === "string"
        ? limit.limitId
        : undefined
  return { remaining, usedPercent: primary.usedPercent, windowDurationMins, resetsAt, label }
}

/** Documented Codex app-server `account/rateLimits/read` result. */
export function remainingFromCodexAppServer(
  payload: unknown
): {
  remaining: number
  limit: number
  source: string
  planType?: string
  rateLimitReached?: boolean
  extras?: QuotaWindow[]
  resetsAt?: number
  windowDurationMins?: number
} | null {
  const rec = asRecord(payload)
  if (!rec) return null
  const result = asRecord(rec.result) ?? rec
  const limits = asRecord(result.rateLimits)
  if (!limits) return null
  const primary = windowFromLimit(limits)
  if (!primary) return null
  const extras: QuotaWindow[] = []
  const byId = asRecord(result.rateLimitsByLimitId)
  const primaryId = typeof limits.limitId === "string" ? limits.limitId : null
  if (byId) {
    for (const [id, value] of Object.entries(byId)) {
      if (primaryId && id === primaryId) continue
      const extra = asRecord(value)
      if (!extra) continue
      const parsed = windowFromLimit(extra)
      if (parsed) extras.push(parsed)
    }
  }
  return {
    remaining: primary.remaining,
    limit: 100,
    source: "codex account/rateLimits/read",
    planType: typeof limits.planType === "string" ? limits.planType : undefined,
    rateLimitReached: limits.rateLimitReachedType === "rate_limit_reached",
    extras: extras.length ? extras : undefined,
    resetsAt: primary.resetsAt,
    windowDurationMins: primary.windowDurationMins,
  }
}

/** Claude `/usage` HUD payload (`five_hour.utilization`). */
export function remainingFromClaudeUsageHud(
  payload: unknown
): { remaining: number; limit: number; source: string } | null {
  const rec = asRecord(payload)
  if (!rec) return null
  const five = asRecord(rec.five_hour)
  const remaining = utilizationRemaining(five?.utilization)
  if (remaining == null) return null
  return {
    remaining,
    limit: 100,
    source: "claude /usage",
  }
}

/**
 * Read remaining subscription from a recorded official payload.
 * Production Codeg never invents this object.
 */
export type OfficialRemaining = {
  remaining: number
  limit: number
  source: string
  planType?: string
  rateLimitReached?: boolean
  extras?: QuotaWindow[]
  resetsAt?: number
  windowDurationMins?: number
}

export function remainingFromOfficialPayload(
  family: IsolatableFamily,
  payload: unknown
): OfficialRemaining | null {
  if (family === "codex") return remainingFromCodexAppServer(payload)
  if (family === "claude") return remainingFromClaudeUsageHud(payload)
  return null
}

export function acpContextFromPayload(
  payload: unknown
): { used: number; size: number } | null {
  if (!payload || typeof payload !== "object") return null
  const rec = payload as Record<string, unknown>
  if (typeof rec.used !== "number" || typeof rec.size !== "number") return null
  if (!Number.isFinite(rec.used) || !Number.isFinite(rec.size)) return null
  return { used: rec.used, size: rec.size }
}

export function familyQuota(
  family: IsolatableFamily,
  officialPayload?: unknown,
  acpUsage?: unknown
): FamilyQuota {
  const remaining = remainingFromOfficialPayload(family, officialPayload)
  if (remaining) {
    return { family, kind: "remaining-subscription", ...remaining }
  }
  const context = acpContextFromPayload(acpUsage)
  if (context) {
    return { family, kind: "acp-context", ...context }
  }
  return {
    family,
    kind: "unavailable",
    providerUsageUrl: PROVIDER_USAGE_URLS[family],
  }
}

export function inventory(
  officialByFamily: Partial<Record<IsolatableFamily, unknown>> = {},
  acpByFamily: Partial<Record<IsolatableFamily, unknown>> = {}
): FamilyQuota[] {
  return FAMILIES.map((family) =>
    familyQuota(family, officialByFamily[family], acpByFamily[family])
  )
}

export function emitsRemainingSubscription(row: FamilyQuota): boolean {
  return row.kind === "remaining-subscription"
}
