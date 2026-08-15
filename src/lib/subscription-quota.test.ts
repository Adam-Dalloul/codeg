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

  it("reads remaining only from a recorded official remaining-subscription envelope", () => {
    const payload = {
      codegQuotaKind: "remaining-subscription",
      family: "codex",
      remaining: 42,
      limit: 100,
      source: "recorded-official-fixture",
    }
    const parsed = remainingFromOfficialPayload("codex", payload)
    expect(parsed).toEqual({
      remaining: 42,
      limit: 100,
      source: "recorded-official-fixture",
    })
    const row = familyQuota("codex", payload)
    expect(row.kind).toBe("remaining-subscription")
    if (row.kind === "remaining-subscription") {
      expect(row.remaining).toBe(42)
    }
  })

  it("rejects a payload that is not the official envelope", () => {
    expect(
      remainingFromOfficialPayload("claude", { remaining: 1, limit: 2 })
    ).toBeNull()
    expect(
      remainingFromOfficialPayload("claude", {
        codegQuotaKind: "remaining-subscription",
        family: "codex",
        remaining: 1,
        limit: 2,
        source: "wrong-family",
      })
    ).toBeNull()
  })
})
