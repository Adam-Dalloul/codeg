/**
 * Remaining-subscription inventory.
 *
 * ACP `usage_update` is context occupancy `{used, size}`, not plan remaining.
 * Official remaining-quota sources we parse:
 *   Codex: documented app-server `account/rateLimits/read`
 *     (primary = 5-hour window, secondary = weekly).
 *   Claude: the `/usage` HUD payload (`five_hour` / `seven_day` utilization).
 * Gemini / Grok / OpenCode still have no machine-readable remaining quota.
 */

export type IsolatableFamily = "claude" | "codex" | "grok" | "gemini" | "opencode"

export type QuotaKind = "remaining-subscription" | "acp-context" | "unavailable"

export type FamilyQuota =
  | {
      family: IsolatableFamily
      kind: "remaining-subscription"
      remaining: number
      limit: number
      source: string
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

/** Documented Codex app-server `account/rateLimits/read` result. */
export function remainingFromCodexAppServer(
  payload: unknown
): { remaining: number; limit: number; source: string } | null {
  const rec = asRecord(payload)
  if (!rec) return null
  const result = asRecord(rec.result) ?? rec
  const limits = asRecord(result.rateLimits)
  if (!limits) return null
  const primary = asRecord(limits.primary)
  const remaining = percentRemaining(primary?.usedPercent)
  if (remaining == null) return null
  return {
    remaining,
    limit: 100,
    source: "codex account/rateLimits/read",
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
export function remainingFromOfficialPayload(
  family: IsolatableFamily,
  payload: unknown
): { remaining: number; limit: number; source: string } | null {
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
