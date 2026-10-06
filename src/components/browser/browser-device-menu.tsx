"use client"

import { Monitor, Smartphone, Tablet, type LucideIcon } from "lucide-react"
import { useTranslations } from "next-intl"

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  useOptionalWorkspaceActions,
  type BrowserWorkspaceTab,
} from "@/contexts/workspace-context"
import {
  BROWSER_DEVICES,
  browserTabDevice,
  deviceViewport,
  isBrowserDevice,
  type BrowserDevice,
} from "@/lib/browser/browser-device"
import { cn } from "@/lib/utils"

import { ICON_BTN } from "./browser-toolbar-buttons"

export const BROWSER_DEVICE_ICONS: Readonly<Record<BrowserDevice, LucideIcon>> =
  {
    desktop: Monitor,
    tablet: Tablet,
    phone: Smartphone,
  }

const DEVICE_NAME_KEYS = {
  desktop: "deviceDesktop",
  tablet: "deviceTablet",
  phone: "devicePhone",
} as const satisfies Record<BrowserDevice, string>

/** `390 × 844`. Digits and the sign read the same in every language, and are
 *  kept left-to-right where they are shown inside right-to-left text. */
export function viewportLabel(viewport: { width: number; height: number }) {
  return `${viewport.width} × ${viewport.height}`
}

/**
 * The device control beside the address field: which device the tab shows
 * its page as, and a menu to pick another — the desktop (the page fills the
 * pane, as a tab always has), a tablet or a phone (the page is laid out in
 * that device's viewport, in a frame of its proportions; see
 * `BrowserDeviceStage`). The glyph is the device's own, so the row says which
 * one is on without opening anything, and it is tinted while a device is
 * being emulated: the page under it is not the size it would be anywhere else.
 */
export function BrowserDeviceMenu({ tab }: { tab: BrowserWorkspaceTab }) {
  const t = useTranslations("Browser.toolbar")
  const setDevice = useOptionalWorkspaceActions()?.setBrowserTabDevice ?? null
  const device = browserTabDevice(tab.browser)
  const Icon = BROWSER_DEVICE_ICONS[device]
  const label = t("device", { name: t(DEVICE_NAME_KEYS[device]) })
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className={cn(
            ICON_BTN,
            device !== "desktop" && "bg-primary/8 text-foreground"
          )}
          title={label}
          aria-label={label}
          data-browser-device={device}
          disabled={!setDevice}
        >
          <Icon className="h-3.5 w-3.5" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-52">
        <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">
          {t("deviceMenuLabel")}
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuRadioGroup
          value={device}
          onValueChange={(next) => {
            if (!isBrowserDevice(next) || next === device) return
            setDevice?.(tab.id, next)
          }}
        >
          {BROWSER_DEVICES.map((id) => {
            const ItemIcon = BROWSER_DEVICE_ICONS[id]
            const viewport = deviceViewport(id)
            return (
              <DropdownMenuRadioItem key={id} value={id}>
                <ItemIcon />
                <span className="truncate">{t(DEVICE_NAME_KEYS[id])}</span>
                <span
                  dir={viewport ? "ltr" : undefined}
                  className="ml-auto pl-4 text-xs text-muted-foreground tabular-nums"
                >
                  {viewport ? viewportLabel(viewport) : t("deviceFill")}
                </span>
              </DropdownMenuRadioItem>
            )
          })}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
