// Thin transport wrappers over the computer-use commands.
//
// Two kinds: the settings record, which both runtimes serve (it is one
// setting in one database), and everything about the screen itself — status,
// permissions, the window list, sharing — which exists in the desktop runtime
// alone. There is no HTTP face for sharing a window: what of this screen an
// agent may see is for the person at this screen to decide.

import { getTransport, isDesktop } from "@/lib/transport"

import type {
  ComputerStatus,
  ComputerToolsSettings,
  OsPermission,
  PermissionReport,
  PickerWindow,
  SharedWindow,
  GrantLevel,
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

/** Move the grant timeout, the blocklist, or both — only what is given; the
 *  rest of the record (the switch included) stays as it is stored. */
export async function setComputerToolsPreferences(preferences: {
  grantTtlMinutes?: number
  blocklist?: string[]
}): Promise<ComputerToolsSettings> {
  return getTransport().call("set_computer_tools_preferences", preferences)
}

/** Whether this runtime can show the screen at all. */
export function computerAvailable(): boolean {
  return isDesktop()
}

export async function computerStatus(): Promise<ComputerStatus> {
  return getTransport().call("computer_status", {})
}

export async function computerRequestPermission(
  permission: OsPermission
): Promise<PermissionReport> {
  return getTransport().call("computer_request_permission", { permission })
}

export async function computerOpenPermissionSettings(
  permission: OsPermission
): Promise<void> {
  return getTransport().call("computer_open_permission_settings", {
    permission,
  })
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

export async function computerRevokeAll(): Promise<void> {
  return getTransport().call("computer_revoke_all", {})
}

/** Stop every agent at once: nothing is read or done on any window, every
 *  window stops being shared, and whatever is in progress is cut off — until
 *  {@link computerResume}. */
export async function computerStop(): Promise<void> {
  return getTransport().call("computer_stop", {})
}

export async function computerResume(): Promise<void> {
  return getTransport().call("computer_resume", {})
}
