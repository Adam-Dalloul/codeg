/**
 * Remaining-subscription inventory.
 *
 * ACP `usage_update` is context occupancy `{used, size}`, not plan remaining.
 * Official CLIs (claude /usage, chatgpt, grok, gemini, opencode) do not
 * publish a stable remaining-quota JSON that Codeg can read. This module is
 * the single gate: a remaining-subscription number is emitted only when a
 * recorded official payload actually contains one.
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

/**
 * Read remaining subscription from a recorded official payload.
 * Production Codeg never invents this object. Return null unless the
 * payload is the documented official shape for that family.
 */
export function remainingFromOfficialPayload(
  family: IsolatableFamily,
  payload: unknown
): { remaining: number; limit: number; source: string } | null {
  if (!payload || typeof payload !== "object") return null
  const rec = payload as Record<string, unknown>
  // No family currently publishes this object. Accept only an explicit
  // official envelope so a future CLI JSON can land without inventing
  // numbers today.
  if (rec.codegQuotaKind !== "remaining-subscription") return null
  if (rec.family !== family) return null
  if (typeof rec.remaining !== "number" || typeof rec.limit !== "number") {
    return null
  }
  if (!Number.isFinite(rec.remaining) || !Number.isFinite(rec.limit)) {
    return null
  }
  if (typeof rec.source !== "string" || !rec.source.trim()) return null
  return {
    remaining: rec.remaining,
    limit: rec.limit,
    source: rec.source.trim(),
  }
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
