"use client"

// Whether computer use is switched on, followed live: the settings record
// has several writers (the in-conversation tools panel, the Computer use
// settings page, the status-bar popover), and each tells the others through
// `computer-tools-settings://changed`.
//
// Subscribed before the first read, so nothing that lands in between is
// missed; a broadcast that lands while that read is in flight is newer than
// it. `null` until one or the other has answered.

import { useCallback, useEffect, useState } from "react"

import { subscribe } from "@/lib/platform"

import { computerAvailable, getComputerToolsSettings } from "./computer-api"
import {
  COMPUTER_TOOLS_SETTINGS_CHANGED_EVENT,
  type ComputerToolsSettings,
} from "./types"

export function useComputerEnabled({
  desktopOnly,
}: {
  /** Never asks outside the desktop runtime (answers `null` there): for
   *  what only exists on the desktop, like the status-bar popover. */
  desktopOnly: boolean
}) {
  const [enabled, setEnabled] = useState<boolean | null>(null)
  const [broadcasts, setBroadcasts] = useState(0)

  useEffect(() => {
    if (desktopOnly && !computerAvailable()) return
    let disposed = false
    let unsubscribe: (() => void) | undefined
    let heard = 0
    const ask = () => {
      getComputerToolsSettings()
        .then((s) => {
          if (!disposed && heard === 0) setEnabled(s.enabled)
        })
        .catch(() => {})
    }
    subscribe<ComputerToolsSettings>(
      COMPUTER_TOOLS_SETTINGS_CHANGED_EVENT,
      (s) => {
        heard += 1
        setEnabled(s.enabled)
        setBroadcasts((n) => n + 1)
      }
    )
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
  }, [desktopOnly])

  /** A record a write of this window's answered with. */
  const apply = useCallback((settings: ComputerToolsSettings) => {
    setEnabled(settings.enabled)
  }, [])

  return { enabled, apply, broadcasts }
}
