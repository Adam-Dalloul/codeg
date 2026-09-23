// The panel's view of computer use: which windows are shared, what the helper
// is doing, and what agents did. Fed by the backend's `computer://*` events
// for the life of the window rather than by the popover, which unmounts when
// it closes — an agent reading a window while the popover is shut is exactly
// the line the person should find when they open it.
//
// The activity list collapses runs of the same (window, action, outcome) into
// one line with a count, for the reason the browser's strip does: an agent
// working through a window reads it dozens of times, and forty identical
// lines hide the one that says something else.

import { useSyncExternalStore } from "react"

import { subscribe } from "@/lib/platform"

import { computerAvailable } from "./computer-api"
import {
  COMPUTER_ACTIVITY_EVENT,
  COMPUTER_BACKEND_STATUS_EVENT,
  COMPUTER_STATE_EVENT,
  type ActivityOutcome,
  type BackendStatus,
  type ComputerAction,
  type ComputerActivityPayload,
  type SharedWindow,
} from "./types"

export interface ComputerActivityLine {
  targetId: string
  action: ComputerAction
  outcome: ActivityOutcome
  /** Unix milliseconds of the most recent one. */
  at: number
  /** How many identical attempts this line stands for. */
  count: number
}

export interface ComputerStoreState {
  shared: readonly SharedWindow[]
  backend: BackendStatus | null
  activity: readonly ComputerActivityLine[]
}

const ACTIVITY_LIMIT = 50

let state: ComputerStoreState = { shared: [], backend: null, activity: [] }
const listeners = new Set<() => void>()
let started = false

function emit(next: ComputerStoreState) {
  state = next
  for (const listener of listeners) listener()
}

export function setComputerShared(shared: readonly SharedWindow[]): void {
  emit({ ...state, shared })
}

export function setComputerBackend(backend: BackendStatus): void {
  emit({ ...state, backend })
}

export function recordComputerActivity(payload: ComputerActivityPayload): void {
  const head = state.activity[0]
  const activity =
    head &&
    head.targetId === payload.targetId &&
    head.action === payload.action &&
    head.outcome === payload.outcome
      ? [
          { ...head, at: payload.at, count: head.count + 1 },
          ...state.activity.slice(1),
        ]
      : [
          { ...payload, count: 1 },
          ...state.activity.slice(0, ACTIVITY_LIMIT - 1),
        ]
  emit({ ...state, activity })
}

/** Start listening, once per window. A no-op outside the desktop runtime. */
function ensureStarted() {
  if (started || !computerAvailable()) return
  started = true
  void subscribe<{ shared: SharedWindow[] }>(COMPUTER_STATE_EVENT, (p) =>
    setComputerShared(p.shared)
  ).catch(() => {})
  void subscribe<ComputerActivityPayload>(
    COMPUTER_ACTIVITY_EVENT,
    recordComputerActivity
  ).catch(() => {})
  void subscribe<BackendStatus>(
    COMPUTER_BACKEND_STATUS_EVENT,
    setComputerBackend
  ).catch(() => {})
}

function subscribeStore(listener: () => void): () => void {
  ensureStarted()
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function useComputerStore(): ComputerStoreState {
  return useSyncExternalStore(
    subscribeStore,
    () => state,
    () => state
  )
}

/** Test-only: back to the initial state, listeners kept. */
export function resetComputerStoreForTest(): void {
  state = { shared: [], backend: null, activity: [] }
}
