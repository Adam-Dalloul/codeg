import { describe, expect, it } from "vitest"

import {
  activeSessionFailures,
  knownSessionFailureActions,
  lastUserPromptText,
  mergeSessionFailures,
  resolvedSessionFailures,
  settleSessionFailures,
  upsertSessionFailure,
} from "./session-failures"
import type { MessageTurn, SessionFailureRecord } from "@/lib/types"

function record(
  id: string,
  revision: number,
  overrides: Partial<SessionFailureRecord> = {}
): SessionFailureRecord {
  return {
    id,
    revision,
    category: "limit",
    severity: "warning",
    title: `${id}@${revision}`,
    actions: ["retry"],
    resolved: false,
    ...overrides,
  }
}

describe("upsertSessionFailure / mergeSessionFailures", () => {
  it("accepts fresh ids and strictly higher revisions, in place", () => {
    let table = upsertSessionFailure([], record("a", 1))
    table = upsertSessionFailure(table, record("b", 1))
    table = upsertSessionFailure(table, record("a", 2, { title: "revised" }))
    expect(table).toHaveLength(2)
    expect(table.find((f) => f.id === "a")?.title).toBe("revised")
  })

  it("rejects equal and lower revisions by reference (replay-safe)", () => {
    const table = upsertSessionFailure([], record("a", 2))
    // Equal revision = verbatim replay (claude re-publishes still-active
    // failures on session/load) — must be a no-op, same reference.
    expect(upsertSessionFailure(table, record("a", 2))).toBe(table)
    expect(upsertSessionFailure(table, record("a", 1))).toBe(table)
  })

  it("keeps the watermark on resolved entries — stale upserts cannot resurrect", () => {
    // upsert rev2 → settle (tombstone-equivalent) → delayed rev2 replay must
    // be rejected: the resolved entry retains the revision watermark.
    let table = upsertSessionFailure([], record("a", 2))
    table = settleSessionFailures(table, "all")
    expect(table[0].resolved).toBe(true)
    expect(upsertSessionFailure(table, record("a", 2))).toBe(table)
    expect(upsertSessionFailure(table, record("a", 1))).toBe(table)
    // A genuinely newer revision re-arms it.
    const rearmed = upsertSessionFailure(table, record("a", 3))
    expect(rearmed[0].resolved).toBe(false)
    expect(rearmed[0].revision).toBe(3)
  })

  it("re-arms resolved on escalation via id reuse (warning → error)", () => {
    let table = upsertSessionFailure([], record("t1:error", 1))
    table = settleSessionFailures(table, "warnings")
    table = upsertSessionFailure(
      table,
      record("t1:error", 2, { severity: "error", title: "gave up" })
    )
    expect(table).toHaveLength(1)
    expect(table[0].severity).toBe("error")
    expect(table[0].resolved).toBe(false)
  })

  it("merges snapshot batches monotonically and reports no-ops by reference", () => {
    const live = [record("a", 3), record("b", 1)]
    // Snapshot older for a, newer for b, plus an unseen c.
    const merged = mergeSessionFailures(live, [
      record("a", 2),
      record("b", 2),
      record("c", 1),
    ])
    expect(merged.find((f) => f.id === "a")?.revision).toBe(3)
    expect(merged.find((f) => f.id === "b")?.revision).toBe(2)
    expect(merged.find((f) => f.id === "c")).toBeDefined()
    // Entirely stale batch → same reference.
    expect(mergeSessionFailures(merged, [record("a", 1)])).toBe(merged)
    expect(mergeSessionFailures(merged, [])).toBe(merged)
    expect(mergeSessionFailures(merged, null)).toBe(merged)
    // Records without usable identity are skipped, not crashed on.
    expect(mergeSessionFailures(merged, [record("", 1), record("d", 0)])).toBe(
      merged
    )
  })
})

describe("settleSessionFailures", () => {
  it("settles warnings only at turn boundaries; errors survive", () => {
    const table = [record("w", 1), record("e", 1, { severity: "error" })]
    const settled = settleSessionFailures(table, "warnings")
    expect(settled.find((f) => f.id === "w")?.resolved).toBe(true)
    expect(settled.find((f) => f.id === "e")?.resolved).toBe(false)
    // New prompt settles everything.
    const all = settleSessionFailures(settled, "all")
    expect(all.every((f) => f.resolved)).toBe(true)
  })

  it("is a reference-preserving no-op when nothing needs settling", () => {
    const table = settleSessionFailures([record("w", 1)], "all")
    expect(settleSessionFailures(table, "all")).toBe(table)
    expect(settleSessionFailures([], "warnings")).toEqual([])
  })
})

describe("lastUserPromptText", () => {
  function turn(
    role: MessageTurn["role"],
    blocks: MessageTurn["blocks"]
  ): MessageTurn {
    return { id: `${role}-${Math.random()}`, role, blocks, timestamp: "" }
  }
  const text = (t: string) => ({ type: "text", text: t }) as const
  const image = {
    type: "image",
    data: "aGk=",
    mime_type: "image/png",
    uri: null,
  } as const

  it("returns the MOST RECENT user turn's joined text", () => {
    const turns = [
      turn("user", [text("first prompt")]),
      turn("assistant", [text("reply")]),
      turn("user", [text("line one"), image, text("line two")]),
      turn("assistant", [text("failed mid-way")]),
    ]
    expect(lastUserPromptText(turns)).toBe("line one\nline two")
  })

  it("skips image-only and blank user turns, and handles no-user/undefined", () => {
    // The retry action must resend something MEANINGFUL: an image-only or
    // whitespace user turn yields nothing, so the scan continues backwards.
    const turns = [
      turn("user", [text("real prompt")]),
      turn("user", [image]),
      turn("user", [text("   ")]),
    ]
    expect(lastUserPromptText(turns)).toBe("real prompt")
    expect(lastUserPromptText([turn("assistant", [text("only agent")])])).toBe(
      null
    )
    expect(lastUserPromptText([])).toBe(null)
    expect(lastUserPromptText(undefined)).toBe(null)
  })
})

describe("selectors", () => {
  it("splits active from resolved and filters renderable actions", () => {
    const table = [
      record("w", 1, { resolved: true }),
      record("e", 1, {
        severity: "error",
        actions: ["login", "sing", "retry"],
      }),
    ]
    expect(activeSessionFailures(table).map((f) => f.id)).toEqual(["e"])
    expect(resolvedSessionFailures(table).map((f) => f.id)).toEqual(["w"])
    // Order follows the known vocabulary, unknown entries dropped.
    expect(knownSessionFailureActions(table[1])).toEqual(["retry", "login"])
    expect(
      knownSessionFailureActions(record("x", 1, { actions: undefined }))
    ).toEqual([])
  })
})
