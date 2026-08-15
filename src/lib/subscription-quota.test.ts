import { describe, expect, it } from "vitest"
import {
  emitsRemainingSubscription,
  familyQuota,
  inventory,
  remainingFromOfficialPayload,
} from "./subscription-quota"

describe("subscription quota inventory", () => {
  it("does not invent remaining-subscription numbers when no official payload exists", () => {
    for (const row of inventory()) {
      expect(emitsRemainingSubscription(row)).toBe(false)
      expect(row.kind).toBe("unavailable")
      if (row.kind === "unavailable") {
        expect(row.providerUsageUrl.startsWith("https://")).toBe(true)
      }
    }
  })

  it("treats ACP usage_update as context occupancy, not plan remaining", () => {
    const row = familyQuota("claude", undefined, { used: 1200, size: 8000 })
    expect(row.kind).toBe("acp-context")
    expect(emitsRemainingSubscription(row)).toBe(false)
    if (row.kind === "acp-context") {
      expect(row.used).toBe(1200)
      expect(row.size).toBe(8000)
    }
  })

  it("reads Codex remaining from documented account/rateLimits/read", () => {
    const payload = {
      rateLimits: {
        primary: { usedPercent: 42, resetsAt: 1_775_000_000 },
        secondary: { usedPercent: 10, resetsAt: 1_775_500_000 },
      },
    }
    const parsed = remainingFromOfficialPayload("codex", payload)
    expect(parsed).toEqual({
      remaining: 58,
      limit: 100,
      source: "codex account/rateLimits/read",
    })
    expect(familyQuota("codex", payload).kind).toBe("remaining-subscription")
  })

  it("reads Claude remaining from the /usage HUD payload", () => {
    const payload = {
      five_hour: { utilization: 0.42, resets_at: "2026-02-28T17:00:00Z" },
      seven_day: { utilization: 0.61, resets_at: "2026-03-07T08:00:00Z" },
    }
    const parsed = remainingFromOfficialPayload("claude", payload)
    expect(parsed?.source).toBe("claude /usage")
    expect(parsed?.remaining).toBeCloseTo(58)
    expect(familyQuota("claude", payload).kind).toBe("remaining-subscription")
  })

  it("rejects a payload that is not the official family shape", () => {
    expect(
      remainingFromOfficialPayload("claude", { remaining: 1, limit: 2 })
    ).toBeNull()
    expect(
      remainingFromOfficialPayload("grok", {
        rateLimits: { primary: { usedPercent: 10 } },
      })
    ).toBeNull()
  })
})
