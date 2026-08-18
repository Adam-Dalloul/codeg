import { describe, expect, it } from "vitest"

import {
  BACKGROUND_KEEPALIVE_MAX_MS,
  parseBackgroundActivityAt,
  visibleBackgroundOutstanding,
} from "./background-activity"

describe("visibleBackgroundOutstanding", () => {
  it("hides a zero count", () => {
    expect(visibleBackgroundOutstanding(0, Date.now(), Date.now())).toBe(0)
  })

  it("keeps a fresh positive count", () => {
    const now = 1_700_000_000_000
    expect(visibleBackgroundOutstanding(2, now - 60_000, now)).toBe(2)
  })

  it("drops a count whose heartbeat is older than the keepalive window", () => {
    const now = 1_700_000_000_000
    expect(
      visibleBackgroundOutstanding(
        2,
        now - BACKGROUND_KEEPALIVE_MAX_MS - 1,
        now
      )
    ).toBe(0)
  })

  it("treats a missing timestamp as live so older servers stay honest", () => {
    expect(visibleBackgroundOutstanding(2, null, Date.now())).toBe(2)
  })
})

describe("parseBackgroundActivityAt", () => {
  it("parses an RFC3339 snapshot timestamp", () => {
    expect(parseBackgroundActivityAt("2026-08-17T12:00:00.000Z")).toBe(
      Date.parse("2026-08-17T12:00:00.000Z")
    )
  })

  it("returns null for missing or junk values", () => {
    expect(parseBackgroundActivityAt(null)).toBeNull()
    expect(parseBackgroundActivityAt("")).toBeNull()
    expect(parseBackgroundActivityAt("not-a-date")).toBeNull()
  })
})
