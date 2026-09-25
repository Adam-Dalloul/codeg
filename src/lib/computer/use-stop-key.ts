"use client"

// Whether the stop shortcut is in force, for every place that offers Stop:
// asked once when the window loads, then kept by `computer://stop-key`. A
// broadcast that lands while the first answer is on its way is the newer of
// the two.

import { useEffect, useState } from "react"

import { subscribe } from "@/lib/platform"

import { computerAvailable, computerStopKeyStatus } from "./computer-api"
import { COMPUTER_STOP_KEY_EVENT, type StopKeyStatus } from "./types"

export function useComputerStopKey(): StopKeyStatus | null {
  const [status, setStatus] = useState<StopKeyStatus | null>(null)
  useEffect(() => {
    if (!computerAvailable()) return
    let disposed = false
    let broadcasts = 0
    let unsubscribe: (() => void) | undefined
    computerStopKeyStatus()
      .then((s) => {
        if (!disposed && broadcasts === 0) setStatus(s)
      })
      .catch(() => {})
    void subscribe<StopKeyStatus>(COMPUTER_STOP_KEY_EVENT, (s) => {
      broadcasts += 1
      setStatus(s)
    })
      .then((fn) => {
        if (disposed) fn()
        else unsubscribe = fn
      })
      .catch(() => {})
    return () => {
      disposed = true
      unsubscribe?.()
    }
  }, [])
  return status
}
