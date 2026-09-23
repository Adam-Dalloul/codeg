"use client"

/**
 * Computer use, bottom-right of the workspace: which windows agents may see
 * right now, what they have done with them, and whatever stands in the way.
 *
 * Present only in the desktop runtime and only while computer use is switched
 * on — off, there is nothing to show and nothing to decide. The glyph carries
 * the violet mark the browser uses for "an agent can read this" whenever at
 * least one window is shared, because a shared window is the one fact here a
 * person should be able to see without opening anything.
 *
 * The permission rows name the helper, never codeg: on macOS the grants belong
 * to `codeg-computer-helper`, and one given to codeg would be given to every
 * agent's shell. If codeg itself holds one, that is the first thing shown, in
 * red, because until it is undone the backend refuses to serve.
 */

import { useCallback, useEffect, useRef, useState } from "react"
import { useTranslations } from "next-intl"
import {
  CircleAlert,
  CircleCheck,
  Monitor,
  RotateCw,
  Settings2,
  ShieldAlert,
} from "lucide-react"

import { Button } from "@/components/ui/button"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"
import { ComputerWindowPicker } from "@/components/computer/computer-window-picker"
import { openSettingsWindow } from "@/lib/api"
import { toErrorMessage } from "@/lib/app-error"
import {
  computerAvailable,
  computerOpenPermissionSettings,
  computerRequestPermission,
  computerRevokeAll,
  computerShareWindow,
  computerStatus,
  getComputerToolsSettings,
} from "@/lib/computer/computer-api"
import {
  computerStoreMark,
  setComputerBackendSince,
  setComputerSharedSince,
  useComputerStore,
  type ComputerActivityLine,
} from "@/lib/computer/computer-store"
import {
  COMPUTER_TOOLS_SETTINGS_CHANGED_EVENT,
  type ComputerStatus,
  type ComputerToolsSettings,
  type OsPermission,
} from "@/lib/computer/types"
import { subscribe } from "@/lib/platform"
import { cn } from "@/lib/utils"

const AGENT_MARK = "text-violet-600 dark:text-violet-400"

/** How many activity lines the popover shows; the store keeps more. */
const ACTIVITY_SHOWN = 8

function useComputerEnabled(): boolean {
  const [enabled, setEnabled] = useState(false)
  useEffect(() => {
    if (!computerAvailable()) return
    let disposed = false
    let unsubscribe: (() => void) | undefined
    // A broadcast that lands while the first read is in flight is newer than
    // the read.
    let broadcasts = 0
    getComputerToolsSettings()
      .then((s) => {
        if (!disposed && broadcasts === 0) setEnabled(s.enabled)
      })
      .catch(() => {})
    void subscribe<ComputerToolsSettings>(
      COMPUTER_TOOLS_SETTINGS_CHANGED_EVENT,
      (s) => {
        broadcasts += 1
        setEnabled(s.enabled)
      }
    )
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
  return enabled
}

function formatTime(at: number): string {
  return new Date(at).toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
  })
}

export function StatusBarComputer() {
  const enabled = useComputerEnabled()
  if (!enabled) return null
  return <ComputerPopover />
}

function ComputerPopover() {
  const t = useTranslations("ComputerUse")
  const { shared, backend, activity } = useComputerStore()
  const [open, setOpen] = useState(false)
  const [pickerOpen, setPickerOpen] = useState(false)
  const [status, setStatus] = useState<ComputerStatus | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const aliveRef = useRef(true)
  /** The latest refresh; an older one that answers late is dropped. */
  const refreshSeqRef = useRef(0)
  useEffect(() => {
    aliveRef.current = true
    return () => {
      aliveRef.current = false
    }
  }, [])

  const refresh = useCallback(async () => {
    const seq = ++refreshSeqRef.current
    const mark = computerStoreMark()
    setLoading(true)
    try {
      const next = await computerStatus()
      if (!aliveRef.current || seq !== refreshSeqRef.current) return
      setStatus(next)
      setComputerSharedSince(next.shared, mark)
      setComputerBackendSince(next.backend, mark)
      setError(null)
    } catch (e) {
      if (aliveRef.current && seq === refreshSeqRef.current) {
        setError(toErrorMessage(e))
      }
    } finally {
      if (aliveRef.current && seq === refreshSeqRef.current) setLoading(false)
    }
  }, [])

  const handleOpenChange = (next: boolean) => {
    setOpen(next)
    if (next) void refresh()
  }

  const request = async (permission: OsPermission) => {
    try {
      await computerRequestPermission(permission)
      await refresh()
    } catch (e) {
      setError(toErrorMessage(e))
    }
  }

  const stop = async (targetId: string) => {
    const mark = computerStoreMark()
    try {
      setComputerSharedSince(await computerShareWindow(targetId, "none"), mark)
    } catch (e) {
      setError(toErrorMessage(e))
    }
  }

  const stopAll = async () => {
    const mark = computerStoreMark()
    try {
      await computerRevokeAll()
      setComputerSharedSince([], mark)
    } catch (e) {
      setError(toErrorMessage(e))
    }
  }

  const liveBackend = backend ?? status?.backend ?? null
  const codegLeaks =
    !!status?.codeg?.selfResponsible &&
    (status.codeg.accessibility || status.codeg.screenRecording)
  const permissions = status?.permissions
  const appNameOf = (line: ComputerActivityLine) =>
    shared.find((w) => w.targetId === line.targetId)?.appName ?? line.targetId

  return (
    <>
      <Popover open={open} onOpenChange={handleOpenChange}>
        <PopoverTrigger asChild>
          <button
            aria-label={t("title")}
            title={
              shared.length > 0
                ? t("tooltipShared", { count: shared.length })
                : t("title")
            }
            className="relative flex items-center transition-colors hover:text-foreground"
          >
            <Monitor
              className={cn("size-3.5", shared.length > 0 && AGENT_MARK)}
            />
          </button>
        </PopoverTrigger>
        <PopoverContent side="top" align="end" className="w-88 gap-2 p-2.5">
          <div className="flex items-center justify-between gap-2">
            <span className="flex items-center gap-1.5 truncate text-xs font-medium">
              {t("title")}
              {!status?.verifiedPlatform && (
                <span className="rounded-full bg-muted px-1.5 py-0.5 text-3xs font-medium text-muted-foreground">
                  {t("preview")}
                </span>
              )}
            </span>
            <button
              type="button"
              onClick={() => void refresh()}
              title={t("refresh")}
              aria-label={t("refresh")}
              className="text-muted-foreground transition-colors hover:text-foreground"
            >
              <RotateCw className={cn("h-3 w-3", loading && "animate-spin")} />
            </button>
          </div>

          {codegLeaks && (
            <div className="flex gap-1.5 rounded-md border border-red-500/30 bg-red-500/5 px-2 py-1.5 text-2xs text-red-500">
              <ShieldAlert className="mt-0.5 size-3.5 shrink-0" />
              <span>{t("codegGranted")}</span>
            </div>
          )}

          {liveBackend && (
            <p className="text-2xs text-muted-foreground">
              {t(`backend.${liveBackend.state}`)}
              {" · "}
              {t("driver", { version: liveBackend.driverVersion })}
              {liveBackend.detail ? ` — ${liveBackend.detail}` : ""}
            </p>
          )}
          {liveBackend?.peer === "development" && (
            <p className="text-2xs text-amber-600 dark:text-amber-400">
              {t("devBuild")}
            </p>
          )}

          {permissions?.required && (
            <div className="divide-y overflow-hidden rounded-lg border">
              {(
                [
                  ["accessibility", permissions.accessibility],
                  ["screenRecording", permissions.screenRecording],
                ] as const
              ).map(([permission, granted]) => (
                <div
                  key={permission}
                  className="flex items-center gap-2 px-2 py-1.5"
                >
                  {granted ? (
                    <CircleCheck className="size-3.5 shrink-0 text-emerald-500" />
                  ) : (
                    <CircleAlert className="size-3.5 shrink-0 text-amber-500" />
                  )}
                  <span className="min-w-0 flex-1 truncate text-2xs font-medium">
                    {t(`permissions.${permission}`)}
                  </span>
                  {granted ? (
                    <span className="text-3xs text-muted-foreground">
                      {t("permissions.granted")}
                    </span>
                  ) : (
                    <>
                      <Button
                        size="xs"
                        variant="outline"
                        onClick={() => void request(permission)}
                      >
                        {t("permissions.request")}
                      </Button>
                      <Button
                        size="xs"
                        variant="ghost"
                        onClick={() =>
                          void computerOpenPermissionSettings(permission).catch(
                            (e) => setError(toErrorMessage(e))
                          )
                        }
                      >
                        {t("permissions.openSettings")}
                      </Button>
                    </>
                  )}
                </div>
              ))}
              {!(permissions.accessibility && permissions.screenRecording) && (
                <p className="px-2 py-1.5 text-3xs leading-snug text-muted-foreground">
                  {t("permissions.why")}
                </p>
              )}
            </div>
          )}

          <div className="overflow-hidden rounded-lg border">
            <div className="flex items-center justify-between px-2 py-1.5">
              <span className="text-2xs font-medium">
                {t("shared.title", { count: shared.length })}
              </span>
              {shared.length > 1 && (
                <button
                  type="button"
                  onClick={() => void stopAll()}
                  className="text-3xs text-muted-foreground hover:text-foreground"
                >
                  {t("shared.stopAll")}
                </button>
              )}
            </div>
            {shared.length === 0 ? (
              <p className="border-t px-2 py-1.5 text-3xs text-muted-foreground">
                {t("shared.empty")}
              </p>
            ) : (
              <div className="divide-y border-t">
                {shared.map((w) => (
                  <div
                    key={w.targetId}
                    className="flex items-center gap-2 px-2 py-1.5"
                  >
                    <Monitor className={cn("size-3.5 shrink-0", AGENT_MARK)} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-2xs font-medium">
                        {w.appName}
                      </span>
                      {w.title && (
                        <span className="block truncate text-3xs text-muted-foreground">
                          {w.title}
                        </span>
                      )}
                    </span>
                    <Button
                      size="xs"
                      variant="ghost"
                      onClick={() => void stop(w.targetId)}
                    >
                      {t("shared.stop")}
                    </Button>
                  </div>
                ))}
              </div>
            )}
          </div>

          {activity.length > 0 && (
            <div className="rounded-lg border px-2 py-1.5">
              <p className="mb-1 text-2xs font-medium">{t("activity.title")}</p>
              <ul className="space-y-0.5">
                {activity.slice(0, ACTIVITY_SHOWN).map((line, i) => (
                  <li
                    key={`${line.at}-${i}`}
                    className="flex items-center gap-1.5 text-3xs text-muted-foreground"
                  >
                    <span className="tabular-nums">{formatTime(line.at)}</span>
                    <span className="min-w-0 flex-1 truncate">
                      {t(`activity.${line.action}`)} · {appNameOf(line)}
                      {line.count > 1 ? ` ×${line.count}` : ""}
                    </span>
                    <span
                      className={cn(
                        line.outcome === "done"
                          ? "text-emerald-600 dark:text-emerald-400"
                          : line.outcome === "refused"
                            ? "text-amber-600 dark:text-amber-400"
                            : "text-red-500"
                      )}
                    >
                      {t(`activity.outcome.${line.outcome}`)}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {error && (
            <div className="rounded-md border border-red-500/30 bg-red-500/5 px-2 py-1.5 text-2xs break-words text-red-500">
              {error}
            </div>
          )}

          <Button
            size="sm"
            className="w-full"
            onClick={() => {
              setOpen(false)
              setPickerOpen(true)
            }}
            disabled={codegLeaks}
          >
            <Monitor className="h-3.5 w-3.5" />
            {t("share")}
          </Button>
          <Button
            size="sm"
            variant="outline"
            className="w-full"
            onClick={() => {
              openSettingsWindow("collaboration").catch((err) => {
                console.error(
                  "[StatusBarComputer] failed to open settings:",
                  err
                )
              })
            }}
          >
            <Settings2 className="h-3.5 w-3.5" />
            {t("openSettings")}
          </Button>
        </PopoverContent>
      </Popover>
      <ComputerWindowPicker open={pickerOpen} onOpenChange={setPickerOpen} />
    </>
  )
}
