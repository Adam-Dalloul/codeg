import { describe, expect, it } from "vitest"
import { estimateTokens, TokenSpeedTracker } from "./token-speed"

describe("estimateTokens", () => {
  it("counts latin at 4 chars per token", () => {
    expect(estimateTokens("hello world")).toBeCloseTo(10 / 4)
  })

  it("counts cjk at 1.8 chars per token", () => {
    expect(estimateTokens("你好世界")).toBeCloseTo(4 / 1.8)
  })

  it("skips whitespace", () => {
    expect(estimateTokens("  a b  ")).toBeCloseTo(2 / 4)
  })

  it("mixes cjk and latin", () => {
    expect(estimateTokens("你好 world")).toBeCloseTo(2 / 1.8 + 5 / 4)
  })

  it("counts fullwidth punctuation as cjk", () => {
    expect(estimateTokens("你好，世界！")).toBeCloseTo(6 / 1.8)
  })

  it("returns 0 for empty or whitespace-only text", () => {
    expect(estimateTokens("")).toBe(0)
    expect(estimateTokens("   ")).toBe(0)
  })
})

describe("TokenSpeedTracker", () => {
  it("seeds the baseline on the first observation", () => {
    const tracker = new TokenSpeedTracker()
    expect(tracker.observe(0, 0)).toBeNull()
  })

  it("computes a constant rate", () => {
    const tracker = new TokenSpeedTracker()
    tracker.observe(0, 0)
    expect(tracker.observe(100, 1000)).toBeCloseTo(100)
  })

  it("smooths a burst followed by silence", () => {
    const tracker = new TokenSpeedTracker()
    tracker.observe(0, 0)
    tracker.observe(200, 1000)
    const rate = tracker.observe(200, 2000)
    expect(rate).toBeGreaterThan(0)
    expect(rate).toBeLessThan(200)
  })

  it("decays toward zero over a long pause", () => {
    const tracker = new TokenSpeedTracker()
    tracker.observe(0, 0)
    tracker.observe(100, 1000)
    expect(tracker.observe(100, 10_000)).toBeLessThan(1)
  })

  it("ignores non-positive time deltas", () => {
    const tracker = new TokenSpeedTracker()
    tracker.observe(0, 1000)
    expect(tracker.observe(50, 1000)).toBeNull()
    expect(tracker.observe(100, 500)).toBeNull()
  })

  it("resets to a fresh baseline", () => {
    const tracker = new TokenSpeedTracker()
    tracker.observe(0, 0)
    tracker.observe(100, 1000)
    tracker.reset()
    expect(tracker.observe(0, 2000)).toBeNull()
  })
})
