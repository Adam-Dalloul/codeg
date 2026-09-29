"use client"

// cua-driver as Settings shows it: read once, then followed through
// `computer://driver`, which every install, removal and progress step — and a
// starting helper fetching the driver for itself — sends. Subscribed before
// the first read, so nothing that happens in between is missed; a broadcast
// that lands while that read is in flight is newer than it.

import { useCallback, useEffect, useState } from "react"

import { toErrorMessage } from "@/lib/app-error"
import { subscribe } from "@/lib/platform"

import {
  computerAvailable,
  computerDriverInfo,
  computerDriverInstall,
  computerDriverUninstall,
} from "./computer-api"
import { COMPUTER_DRIVER_EVENT, type DriverInfo } from "./types"

export function useComputerDriver() {
  const [info, setInfo] = useState<DriverInfo | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!computerAvailable()) return
    let disposed = false
    let unsubscribe: (() => void) | undefined
    let broadcasts = 0
    const ask = () => {
      computerDriverInfo()
        .then((read) => {
          if (!disposed && broadcasts === 0) setInfo(read)
        })
        .catch((e) => {
          if (!disposed) setError(toErrorMessage(e))
        })
    }
    subscribe<DriverInfo>(COMPUTER_DRIVER_EVENT, (next) => {
      broadcasts += 1
      setInfo(next)
    })
      .then((fn) => {
        if (disposed) fn()
        else unsubscribe = fn
      })
      .catch(() => {})
      .finally(ask)
    return () => {
      disposed = true
      unsubscribe?.()
    }
  }, [])

  const run = useCallback(async (action: () => Promise<DriverInfo>) => {
    setError(null)
    try {
      setInfo(await action())
      return true
    } catch (e) {
      setError(toErrorMessage(e))
      return false
    }
  }, [])

  const install = useCallback(() => run(computerDriverInstall), [run])
  const uninstall = useCallback(() => run(computerDriverUninstall), [run])

  return { info, error, install, uninstall }
}
