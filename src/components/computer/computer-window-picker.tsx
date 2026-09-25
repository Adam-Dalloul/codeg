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
 * shared (codeg's own, a credential manager) gets no picture and no button,
 * only the reason.
 *
 * Two levels are offered, as two entries of one menu — the browser's pair:
 * reading a window cannot change it, acting on it can, and they are
 * different decisions. A shared window moves between them without being
 * taken back first.
 */

import { useCallback, useEffect, useRef, useState } from "react"
import { useTranslations } from "next-intl"
import {
  AppWindow,
  ChevronDown,
  Eye,
  Loader2,
  MousePointerClick,
  RotateCw,
  ShieldOff,
} from "lucide-react"

import { Button } from "@/components/ui/button"
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
  computerListShareableWindows,
  computerShareWindow,
  computerWindowThumbnail,
} from "@/lib/computer/computer-api"
import {
  computerStoreMark,
  setComputerSharedSince,
  useComputerStore,
} from "@/lib/computer/computer-store"
import type { GrantLevel, PickerWindow } from "@/lib/computer/types"
import { cn } from "@/lib/utils"

function ThumbnailFrame({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex aspect-video w-full items-center justify-center overflow-hidden rounded-md border bg-muted/40">
      {children}
    </div>
  )
}

/** A picture of one shareable window, fetched once. Keyed by the caller on
 *  the target id, so a different window is a fresh component. */
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
  // Whether a window is shared is read from the live store, not from the list
  // as it was fetched: a grant can end (it lapses, another window stops it)
  // while the picker is open. Until the store has heard anything, the list's
  // own word is the only one there is.
  const { shared, sharedKnown } = useComputerStore()
  const levelOf = (w: PickerWindow): GrantLevel =>
    sharedKnown
      ? (shared.find((s) => s.targetId === w.targetId)?.level ?? "none")
      : w.level
  const [windows, setWindows] = useState<PickerWindow[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  /** The latest load; an older one that answers late is dropped. */
  const loadSeqRef = useRef(0)

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
      void load()
    }
  }, [open, load])

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
            {windows ? t("count", { count: windows.length }) : t("loading")}
          </p>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => void load()}
            disabled={windows === null}
          >
            <RotateCw className="size-3.5" />
            {t("refresh")}
          </Button>
        </div>

        {error && (
          <div className="rounded-md border border-red-500/30 bg-red-500/5 px-2 py-1.5 text-xs break-words text-red-500">
            {error}
          </div>
        )}

        <ScrollArea className="max-h-[60vh]">
          {windows === null ? (
            <div className="flex h-40 items-center justify-center">
              <Loader2 className="size-5 animate-spin text-muted-foreground" />
            </div>
          ) : windows.length === 0 ? (
            <p className="py-10 text-center text-sm text-muted-foreground">
              {t("empty")}
            </p>
          ) : (
            <div className="grid grid-cols-2 gap-3 pr-3 sm:grid-cols-3">
              {windows.map((w) => {
                const level = levelOf(w)
                const on = level !== "none"
                return (
                  <div
                    key={w.targetId}
                    className={cn(
                      "flex flex-col gap-2 rounded-lg border p-2",
                      on && "border-violet-500/60 bg-violet-500/5",
                      w.notGrantable && "opacity-60"
                    )}
                  >
                    {w.notGrantable ? (
                      <ThumbnailFrame>
                        <ShieldOff className="size-5 text-muted-foreground/60" />
                      </ThumbnailFrame>
                    ) : (
                      <Thumbnail key={w.targetId} targetId={w.targetId} />
                    )}
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
                    {w.notGrantable ? (
                      <p className="flex items-center gap-1 text-2xs text-muted-foreground">
                        <ShieldOff className="size-3 shrink-0" />
                        {t(`notGrantable.${w.notGrantable}`)}
                      </p>
                    ) : (
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button
                            size="sm"
                            variant={on ? "outline" : "default"}
                            disabled={busy === w.targetId}
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
                        <DropdownMenuContent align="start" className="min-w-56">
                          <DropdownMenuItem
                            disabled={level === "read"}
                            onSelect={() => void setLevel(w, "read")}
                          >
                            <Eye className="size-3.5" />
                            {t("shareRead")}
                          </DropdownMenuItem>
                          <DropdownMenuItem
                            disabled={level === "control"}
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
                    )}
                  </div>
                )
              })}
            </div>
          )}
        </ScrollArea>
      </DialogContent>
    </Dialog>
  )
}
