// Thin transport wrappers over the computer-use commands.
//
// Two kinds: the settings record, which both runtimes serve (it is one
// setting in one database), and everything about the screen itself — status,
// permissions, the window list, sharing — which exists in the desktop runtime
// alone. There is no HTTP face for sharing a window: what of this screen an
// agent may see is for the person at this screen to decide.

import { isLocalDesktop } from "@/lib/platform"
import { getTransport } from "@/lib/transport"

import type {
  ComputerDelivery,
  ComputerStatePayload,
  ComputerStatus,
  ComputerToolsSettings,
  DriverInfo,
  OsPermission,
  PermissionRequestResult,
  PickerWindow,
  ShareManyResult,
  SharedWindow,
  GrantLevel,
  StopKeyStatus,
} from "./types"

export async function getComputerToolsSettings(): Promise<ComputerToolsSettings> {
  return getTransport().call("get_computer_tools_settings")
}

/** Move only the group switch. */
export async function setComputerToolsEnabled(
  enabled: boolean
): Promise<ComputerToolsSettings> {
  return getTransport().call("set_computer_tools_enabled", { enabled })
}

/** Move the grant timeout, the blocklist, the stop shortcut, the strip,
 *  whether a window may come to the front and how an action goes by
 *  default — only what is given; the rest of the record (the switch
 *  included) stays as it is stored. */
export async function setComputerToolsPreferences(preferences: {
  grantTtlMinutes?: number
  blocklist?: string[]
  /** Keys of the default entries to leave off the list. */
  blocklistRemoved?: string[]
  /** Empty switches the shortcut off. */
  stopShortcut?: string
  showIndicator?: boolean
  allowForeground?: boolean
  defaultDelivery?: ComputerDelivery
}): Promise<ComputerToolsSettings> {
  return getTransport().call("set_computer_tools_preferences", preferences)
}

/** Whether this window is the desktop app on the machine whose screen this
 *  is. A window bound to a remote workspace is a desktop runtime too, but its
 *  calls go to another machine, where none of the screen commands exist. */
export function computerAvailable(): boolean {
  return isLocalDesktop()
}

export async function computerStatus(): Promise<ComputerStatus> {
  return getTransport().call("computer_status", {})
}

/** The shared windows: codeg's own state, with no helper to start — cheap
 *  enough to ask for when a window loads. */
export async function computerSharedState(): Promise<ComputerStatePayload> {
  return getTransport().call("computer_shared_state", {})
}

/** Ask macOS for this one permission, from a helper started for the
 *  purpose, and say where that leaves things. */
export async function computerRequestPermission(
  permission: OsPermission
): Promise<PermissionRequestResult> {
  return getTransport().call("computer_request_permission", { permission })
}

export async function computerOpenPermissionSettings(
  permission: OsPermission
): Promise<void> {
  return getTransport().call("computer_open_permission_settings", {
    permission,
  })
}

/** Show codeg-computer-helper in the Finder, to drag into System Settings. */
export async function computerRevealHelper(): Promise<void> {
  return getTransport().call("computer_reveal_helper", {})
}

export async function computerListShareableWindows(): Promise<PickerWindow[]> {
  return getTransport().call("computer_list_shareable_windows", {})
}

/** A `data:` URL, or null when there is none to show. */
export async function computerWindowThumbnail(
  targetId: string
): Promise<string | null> {
  return getTransport().call("computer_window_thumbnail", { targetId })
}

export async function computerShareWindow(
  targetId: string,
  level: GrantLevel
): Promise<SharedWindow[]> {
  return getTransport().call("computer_share_window", { targetId, level })
}

/** Share every window named at one level — each as
 *  {@link computerShareWindow} would, skipping those that cannot be. */
export async function computerShareWindows(
  targetIds: string[],
  level: GrantLevel
): Promise<ShareManyResult> {
  return getTransport().call("computer_share_windows", { targetIds, level })
}

export async function computerRevokeAll(): Promise<void> {
  return getTransport().call("computer_revoke_all", {})
}

/** Stop sharing, all at once: every window stops being shared and whatever
 *  agents are in the middle of is cut off. Nothing is held after it —
 *  sharing a window again is the next step. */
export async function computerStop(): Promise<void> {
  return getTransport().call("computer_stop", {})
}

/** Whether the stop shortcut is in force; `computer://stop-key` carries the
 *  changes. */
export async function computerStopKeyStatus(): Promise<StopKeyStatus> {
  return getTransport().call("computer_stop_key_status", {})
}

/** The strip telling codeg how large it drew itself, in CSS pixels. */
export async function computerIndicatorFit(
  width: number,
  height: number
): Promise<void> {
  return getTransport().call("computer_indicator_fit", { width, height })
}

/** cua-driver: the release this codeg runs, what the cache holds, anything
 *  under way. `computer://driver` carries the changes. */
export async function computerDriverInfo(): Promise<DriverInfo> {
  return getTransport().call("computer_driver_info", {})
}

/** Fetch the release this codeg runs and clear older ones. Answers once it
 *  is done; the download's progress travels on `computer://driver`. */
export async function computerDriverInstall(): Promise<DriverInfo> {
  return getTransport().call(
    "computer_driver_install",
    {},
    { timeoutMs: 600_000 }
  )
}

/** Remove cua-driver: computer use is switched off and the helper stopped
 *  first. */
export async function computerDriverUninstall(): Promise<DriverInfo> {
  return getTransport().call("computer_driver_uninstall", {})
}
