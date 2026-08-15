import { act, renderHook, waitFor } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"

import type { LiveSessionSnapshot } from "@/lib/types"

vi.mock("@/lib/api", () => ({
  acpGetSessionSnapshot: vi.fn(),
}))

import { acpGetSessionSnapshot } from "@/lib/api"
import { useAdvertisedGoalActions } from "./use-goal-actions"

const mockedFetch = vi.mocked(acpGetSessionSnapshot)

function snapshotWith(goalActions: string[] | undefined): LiveSessionSnapshot {
  return { goal_actions: goalActions } as unknown as LiveSessionSnapshot
}

/** A pending promise whose resolution the test controls. */
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

beforeEach(() => {
  mockedFetch.mockReset()
})

describe("useAdvertisedGoalActions", () => {
  it("exposes NO controls until the snapshot resolves, then the advertised list", async () => {
    const gate = deferred<LiveSessionSnapshot>()
    mockedFetch.mockReturnValue(gate.promise)
    const { result } = renderHook(() => useAdvertisedGoalActions("c1"))
    // Fail-closed window: a claude card must never flash a Pause it would
    // reject — unknown vocabulary renders as none.
    expect(result.current).toEqual([])
    act(() => gate.resolve(snapshotWith(["set", "clear"])))
    await waitFor(() => expect(result.current).toEqual(["set", "clear"]))
  })

  it("maps a snapshot MISSING goal_actions to the legacy vocabulary", async () => {
    mockedFetch.mockResolvedValue(snapshotWith(undefined))
    const { result } = renderHook(() => useAdvertisedGoalActions("c1"))
    await waitFor(() => expect(result.current).toEqual(["pause", "clear"]))
  })

  it("stays at NO controls when the snapshot fetch fails", async () => {
    mockedFetch.mockRejectedValue(new Error("gone"))
    const { result } = renderHook(() => useAdvertisedGoalActions("c1"))
    // Give the rejection a tick to (not) apply.
    await act(async () => {})
    expect(result.current).toEqual([])
  })

  it("stays at NO controls for a nullish snapshot (connection already gone)", async () => {
    // Nothing was LEARNED — only an existing snapshot missing the field maps
    // to the legacy vocabulary; a null one must not resurrect Pause.
    mockedFetch.mockResolvedValue(null as unknown as LiveSessionSnapshot)
    const { result } = renderHook(() => useAdvertisedGoalActions("c1"))
    await act(async () => {})
    expect(result.current).toEqual([])
  })

  it("never leaks the previous connection's vocabulary across a switch", async () => {
    const second = deferred<LiveSessionSnapshot>()
    mockedFetch.mockImplementation((id: string) =>
      id === "c1"
        ? Promise.resolve(snapshotWith(["pause", "clear"]))
        : second.promise
    )
    const { result, rerender } = renderHook(
      ({ id }: { id: string | null }) => useAdvertisedGoalActions(id),
      { initialProps: { id: "c1" as string | null } }
    )
    await waitFor(() => expect(result.current).toEqual(["pause", "clear"]))
    // Reconnect/re-spawn: new id — the old vocabulary must vanish
    // IMMEDIATELY, not linger until the new fetch lands.
    rerender({ id: "c2" })
    expect(result.current).toEqual([])
    act(() => second.resolve(snapshotWith(["set", "clear"])))
    await waitFor(() => expect(result.current).toEqual(["set", "clear"]))
    // And a null id (no live connection) exposes none.
    rerender({ id: null })
    expect(result.current).toEqual([])
  })

  it("drops a stale response that resolves after the connection switched", async () => {
    const slow = deferred<LiveSessionSnapshot>()
    mockedFetch.mockImplementation((id: string) =>
      id === "old"
        ? slow.promise
        : Promise.resolve(snapshotWith(["set", "clear"]))
    )
    const { result, rerender } = renderHook(
      ({ id }: { id: string | null }) => useAdvertisedGoalActions(id),
      { initialProps: { id: "old" as string | null } }
    )
    rerender({ id: "new" })
    await waitFor(() => expect(result.current).toEqual(["set", "clear"]))
    // The old connection's late response must not overwrite the new one.
    act(() => slow.resolve(snapshotWith(["pause", "clear"])))
    await act(async () => {})
    expect(result.current).toEqual(["set", "clear"])
  })
})
