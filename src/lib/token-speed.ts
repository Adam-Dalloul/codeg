/**
 * Pure helpers behind the live token-output-speed badge. Everything here is a
 * function of its arguments — no clock, no DOM — so the heuristic and the
 * smoothing are exactly testable.
 *
 * The char→token ratios are deliberately rough ("大差不差"): CJK text
 * tokenizes denser than Latin, so we count CJK (ideographs + fullwidth forms)
 * at ~1.8 chars/token and every other visible character at ~4 chars/token.
 * Whitespace is skipped entirely.
 * ponytail: fixed ratios; calibrate per model from reported turn usage if
 * accuracy ever matters more than the live gauge.
 */

const CJK_RE = /[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF\uFF00-\uFFEF]/g

export function estimateTokens(text: string): number {
  if (!text) return 0
  const cjk = text.match(CJK_RE)?.length ?? 0
  const other = text.replace(/\s/g, "").length - cjk
  return cjk / 1.8 + other / 4
}

/**
 * First-order low-pass over instantaneous token rates. Time-constant based
 * (rather than per-event alpha) so a bursty thinking stream followed by a tool
 * pause decays toward zero instead of pinning the old reading.
 */
export class TokenSpeedTracker {
  private static readonly TAU_MS = 1500

  private lastTime: number | null = null
  private lastTokens = 0
  private ewma: number | null = null

  reset(): void {
    this.lastTime = null
    this.lastTokens = 0
    this.ewma = null
  }

  /** Feed the cumulative estimated token count at `nowMs`; returns smoothed
   *  tok/s, or `null` while seeding / when the observation can't be used. */
  observe(totalTokens: number, nowMs: number): number | null {
    if (this.lastTime == null) {
      this.lastTime = nowMs
      this.lastTokens = totalTokens
      return null
    }
    const dt = nowMs - this.lastTime
    if (dt <= 0) return this.ewma
    const instant = (totalTokens - this.lastTokens) / (dt / 1000)
    this.lastTime = nowMs
    this.lastTokens = totalTokens
    const alpha = 1 - Math.exp(-dt / TokenSpeedTracker.TAU_MS)
    this.ewma =
      this.ewma == null ? instant : this.ewma * (1 - alpha) + instant * alpha
    return this.ewma
  }
}
