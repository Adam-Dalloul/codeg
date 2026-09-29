"use client"

/**
 * Where a person hands one window to agents — and takes it back.
 *
 * Every normal window on the desktop, with its application, its title and a
 * small picture of it: this is the person's own screen, shown to them, so it
 * is shown in full. What an *agent* is told about an unshared window is far
 * less (no title, no picture) and is decided on the backend.
 *
 * Pictures are fetched one window at a time as the list renders, through the
 * helper — codeg itself never captures the screen. A window that can never be
 * shared (codeg's, a credential manager, one whose application cannot be
 * told) is kept out of the grid, in a folded list at the bottom with the
 * reason, and gets no picture.
 *
 * Titles and pictures both need the helper to hold Screen Recording (macOS).
 * Without it the picker says so, with the way to grant it; it reads the
 * helper's permissions as it opens and again whenever this window comes back
 * to the front, and once Screen Recording has arrived it lists the windows
 * and fetches their pictures again. Refresh fetches the pictures again too.
 *
 * Two levels are offered, as two entries of one menu — the browser's pair:
 * reading a window cannot change it, acting on it can, and they are
 * different decisions. A shared window moves between them without being
 * taken back first. The same two, and "stop sharing", are offered for every
 * shareable window in the list at once.
 */

import { useCallback, useEffect, useRef, useState } from "react"
import { useTranslations } from "next-intl"
import {
  AppWindow,
  ChevronDown,
  ChevronRight,
  Eye,
  Layers,
  Loader2,
  MousePointerClick,
  RotateCw,
  ShieldOff,
} from "lucide-react"

import { Button } from "@/components/ui/button"
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { ScrollArea } from "@/components/ui/scroll-area"
import { toErrorMessage } from "@/lib/app-error"
import {
  computerAvailable,
  computerListShareableWindows,
  computerRevokeAll,
  computerShareWindow,
  computerShareWindows,
  computerWindowThumbnail,
} from "@/lib/computer/computer-api"
import {
  computerStoreMark,
  setComputerSharedSince,
  useComputerStore,
} from "@/lib/computer/computer-store"
import type {
  GrantLevel,
  NotGrantable,
  PickerWindow,
} from "@/lib/computer/types"
import { useComputerStatus } from "@/lib/computer/use-computer-status"
import { cn } from "@/lib/utils"

function ThumbnailFrame({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex aspect-video w-full items-center justify-center overflow-hidden rounded-md border bg-muted/40">
      {children}
    </div>
  )
}

/** A picture of one shareable window, fetched once. Keyed by the caller on
 *  the target id and on the picker's picture round, so a different window —
 *  or the same one asked for again — is a fresh component. */
function Thumbnail({ targetId }: { targetId: string }) {
  const [src, setSrc] = useState<string | null | undefined>(undefined)
  useEffect(() => {
    let cancelled = false
    computerWindowThumbnail(targetId)
      .then((url) => {
        if (!cancelled) setSrc(url)
      })
      .catch(() => {
        if (!cancelled) setSrc(null)
      })
    return () => {
      cancelled = true
    }
  }, [targetId])

  return (
    <ThumbnailFrame>
      {src === undefined ? (
        <Loader2 className="size-4 animate-spin text-muted-foreground" />
      ) : src ? (
        // eslint-disable-next-line @next/next/no-img-element -- a data: URL from the helper, not a route next/image could optimise
        <img src={src} alt="" className="size-full object-contain" />
      ) : (
        <AppWindow className="size-5 text-muted-foreground/60" />
      )}
    </ThumbnailFrame>
  )
}

export function ComputerWindowPicker({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const t = useTranslations("ComputerUse.picker")
  const tComputer = useTranslations("ComputerUse")
  // Whether a window is shared is read from the live store, not from the list
  // as it was fetched: a grant can end (it lapses, another window stops it)
  // while the picker is open. Until the store has heard anything, the list's
  // own word is the only one there is.
  // Stopped — here or in another codeg window — nothing is shared until the
  // person resumes; only taking a window back stays on offer.
  const { shared, sharedKnown, paused } = useComputerStore()
  const levelOf = (w: PickerWindow): GrantLevel =>
    sharedKnown
      ? (shared.find((s) => s.targetId === w.targetId)?.level ?? "none")
      : w.level
  const [windows, setWindows] = useState<PickerWindow[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  /** A change to every window at once is on its way. */
  const [bulk, setBulk] = useState(false)
  /** One change at a time: a "stop sharing all" that lands before a share
   *  still on its way would be undone by it, and the other way round. */
  const changing = bulk || busy !== null
  const [showUnshareable, setShowUnshareable] = useState(false)
  /** Bumped to fetch every picture again: each is fetched once per value. */
  const [pictures, setPictures] = useState(0)
  /** The latest load; an older one that answers late is dropped. */
  const loadSeqRef = useRef(0)
  const { status, request, openPermissionSettings } = useComputerStatus(
    open && computerAvailable()
  )
  const permissions = status?.permissions
  const screenRecording = permissions?.required
    ? permissions.screenRecording
    : undefined
  const development = status?.backend.peer === "development"

  const load = useCallback(async () => {
    const seq = ++loadSeqRef.current
    setError(null)
    try {
      const listed = await computerListShareableWindows()
      if (seq === loadSeqRef.current) setWindows(listed)
    } catch (e) {
      if (seq !== loadSeqRef.current) return
      setError(toErrorMessage(e))
      setWindows([])
    }
  }, [])

  useEffect(() => {
    if (open) {
      setWindows(null)
      setNotice(null)
      void load()
    }
  }, [open, load])

  /** The list again, and every picture in it. */
  const reload = useCallback(() => {
    setPictures((n) => n + 1)
    return load()
  }, [load])

  /** Screen Recording was missing and is here now: the titles and pictures
   *  it withheld can be had. */
  const missedRef = useRef(false)
  useEffect(() => {
    if (screenRecording === false) {
      missedRef.current = true
    } else if (screenRecording && missedRef.current) {
      missedRef.current = false
      void reload()
    }
  }, [screenRecording, reload])

  const shareable = windows?.filter((w) => !w.notGrantable) ?? []
  const unshareable =
    windows?.filter(
      (w): w is PickerWindow & { notGrantable: NotGrantable } =>
        !!w.notGrantable
    ) ?? []
  const anyShared = shareable.some((w) => levelOf(w) !== "none")

  /** Every shareable window in the list, at one level — as each window's own
   *  menu would do it, one after the other. */
  const shareAll = async (next: GrantLevel) => {
    const mark = computerStoreMark()
    setBulk(true)
    setError(null)
    setNotice(null)
    try {
      const result = await computerShareWindows(
        shareable.map((w) => w.targetId),
        next
      )
      setComputerSharedSince(result.shared, mark)
      if (result.skipped > 0) {
        setNotice(t("skipped", { count: result.skipped }))
        // Some have closed since the list was read.
        void load()
      }
    } catch (e) {
      setError(toErrorMessage(e))
      void load()
    } finally {
      setBulk(false)
    }
  }

  const stopAll = async () => {
    const mark = computerStoreMark()
    setBulk(true)
    setError(null)
    setNotice(null)
    try {
      await computerRevokeAll()
      setComputerSharedSince([], mark)
    } catch (e) {
      setError(toErrorMessage(e))
    } finally {
      setBulk(false)
    }
  }

  const setLevel = async (item: PickerWindow, next: GrantLevel) => {
    const mark = computerStoreMark()
    setBusy(item.targetId)
    setError(null)
    try {
      setComputerSharedSince(
        await computerShareWindow(item.targetId, next),
        mark
      )
    } catch (e) {
      setError(toErrorMessage(e))
      // The window may have closed; the list says what is there now.
      void load()
    } finally {
      setBusy(null)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>{t("title")}</DialogTitle>
          <DialogDescription>{t("description")}</DialogDescription>
        </DialogHeader>

        <div className="flex items-center justify-between gap-2">
          <p className="text-xs text-muted-foreground">
            {windows ? t("count", { count: shareable.length }) : t("loading")}
          </p>
          <div className="flex items-center gap-1">
            {anyShared && (
              <Button
                size="sm"
                variant="ghost"
                onClick={() => void stopAll()}
                disabled={changing}
              >
                {t("stopSharingAll")}
              </Button>
            )}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={changing || paused || shareable.length === 0}
                >
                  {bulk ? (
                    <Loader2 className="size-3.5 animate-spin" />
                  ) : (
                    <Layers className="size-3.5" />
                  )}
                  {t("shareAll")}
                  <ChevronDown className="size-3" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="min-w-56">
                <DropdownMenuItem onSelect={() => void shareAll("read")}>
                  <Eye className="size-3.5" />
                  {t("shareAllRead")}
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => void shareAll("control")}>
                  <MousePointerClick className="size-3.5" />
                  {t("shareAllControl")}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => void reload()}
              disabled={windows === null}
            >
              <RotateCw className="size-3.5" />
              {t("refresh")}
            </Button>
          </div>
        </div>

        {paused && (
          <div className="rounded-md border border-amber-500/30 bg-amber-500/5 px-2 py-1.5 text-xs text-amber-600 dark:text-amber-400">
            {tComputer("stopped")}
          </div>
        )}

        {screenRecording === false && (
          <div className="space-y-1.5 rounded-md border border-amber-500/30 bg-amber-500/5 px-2 py-1.5">
            <p className="text-xs text-amber-600 dark:text-amber-400">
              {t("noScreenRecording")}
            </p>
            <p className="text-2xs leading-snug text-muted-foreground">
              {tComputer(
                development ? "permissions.whyDev" : "permissions.why"
              )}
            </p>
            <div className="flex gap-1">
              <Button
                size="xs"
                variant="outline"
                onClick={() => void request("screenRecording")}
              >
                {tComputer("permissions.request")}
              </Button>
              <Button
                size="xs"
                variant="ghost"
                onClick={() => openPermissionSettings("screenRecording")}
              >
                {tComputer("permissions.openSettings")}
              </Button>
            </div>
          </div>
        )}

        {error && (
          <div className="rounded-md border border-red-500/30 bg-red-500/5 px-2 py-1.5 text-xs break-words text-red-500">
            {error}
          </div>
        )}

        {notice && (
          <div className="rounded-md border px-2 py-1.5 text-xs text-muted-foreground">
            {notice}
          </div>
        )}

        <ScrollArea className="max-h-[60vh]">
          {windows === null ? (
            <div className="flex h-40 items-center justify-center">
              <Loader2 className="size-5 animate-spin text-muted-foreground" />
            </div>
          ) : (
            <div className="space-y-3 pr-3">
              {shareable.length === 0 ? (
                <p className="py-10 text-center text-sm text-muted-foreground">
                  {t(windows.length === 0 ? "empty" : "noneShareable")}
                </p>
              ) : (
                <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
                  {shareable.map((w) => {
                    const level = levelOf(w)
                    const on = level !== "none"
                    return (
                      <div
                        key={w.targetId}
                        className={cn(
                          "flex flex-col gap-2 rounded-lg border p-2",
                          on && "border-violet-500/60 bg-violet-500/5"
                        )}
                      >
                        <Thumbnail
                          key={`${w.targetId}:${pictures}`}
                          targetId={w.targetId}
                        />
                        <div className="min-w-0">
                          <p className="truncate text-xs font-medium">
                            {w.appName || t("unnamedApp")}
                          </p>
                          <p
                            className="truncate text-2xs text-muted-foreground"
                            title={w.title}
                          >
                            {w.title || t("untitled")}
                            {w.minimized ? ` · ${t("minimized")}` : ""}
                          </p>
                        </div>
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button
                              size="sm"
                              variant={on ? "outline" : "default"}
                              disabled={changing}
                              className={cn(
                                level === "control" &&
                                  "text-red-600 dark:text-red-400"
                              )}
                            >
                              {busy === w.targetId ? (
                                <Loader2 className="size-3.5 animate-spin" />
                              ) : level === "control" ? (
                                <MousePointerClick className="size-3.5" />
                              ) : (
                                <Eye className="size-3.5" />
                              )}
                              {level === "none"
                                ? t("share")
                                : t(
                                    level === "control"
                                      ? "sharedControl"
                                      : "sharedRead"
                                  )}
                              <ChevronDown className="size-3" />
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent
                            align="start"
                            className="min-w-56"
                          >
                            <DropdownMenuItem
                              disabled={paused || level === "read"}
                              onSelect={() => void setLevel(w, "read")}
                            >
                              <Eye className="size-3.5" />
                              {t("shareRead")}
                            </DropdownMenuItem>
                            <DropdownMenuItem
                              disabled={paused || level === "control"}
                              onSelect={() => void setLevel(w, "control")}
                            >
                              <MousePointerClick className="size-3.5" />
                              {t("shareControl")}
                            </DropdownMenuItem>
                            {on && (
                              <>
                                <DropdownMenuSeparator />
                                <DropdownMenuItem
                                  onSelect={() => void setLevel(w, "none")}
                                >
                                  {t("stopSharing")}
                                </DropdownMenuItem>
                              </>
                            )}
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </div>
                    )
                  })}
                </div>
              )}

              {unshareable.length > 0 && (
                <Collapsible
                  open={showUnshareable}
                  onOpenChange={setShowUnshareable}
                >
                  <CollapsibleTrigger asChild>
                    <button
                      type="button"
                      className="flex items-center gap-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
                    >
                      <ChevronRight
                        className={cn(
                          "size-3.5 transition-transform",
                          showUnshareable && "rotate-90"
                        )}
                      />
                      {t("unshareable", { count: unshareable.length })}
                    </button>
                  </CollapsibleTrigger>
                  <CollapsibleContent>
                    <ul className="mt-2 divide-y overflow-hidden rounded-md border">
                      {unshareable.map((w) => (
                        <li
                          key={w.targetId}
                          className="flex items-center gap-2 px-2 py-1.5"
                        >
                          <ShieldOff className="size-3.5 shrink-0 text-muted-foreground" />
                          <span className="min-w-0 flex-1">
                            <span className="block truncate text-xs font-medium">
                              {w.appName || t("unnamedApp")}
                            </span>
                            <span
                              className="block truncate text-2xs text-muted-foreground"
                              title={w.title}
                            >
                              {w.title || t("untitled")}
                            </span>
                          </span>
                          <span className="shrink-0 text-2xs text-muted-foreground">
                            {t(`notGrantable.${w.notGrantable}`)}
                          </span>
                        </li>
                      ))}
                    </ul>
                    {unshareable.some((w) => w.notGrantable === "codeg") && (
                      <p className="mt-2 text-2xs leading-snug text-muted-foreground">
                        {t("codegWhy")}
                      </p>
                    )}
                  </CollapsibleContent>
                </Collapsible>
              )}
            </div>
          )}
        </ScrollArea>
      </DialogContent>
    </Dialog>
  )
}
