// Mirrors of the Rust computer-use wire types (`src-tauri/src/computer/`,
// `commands/computer.rs`, `commands/computer_tools.rs`). The spellings are the
// Rust side's serde renames, which differ per type — kebab-case for the enums
// shared with the browser, camelCase for the rest — so each is written out
// rather than derived.

/** Same enum, same spelling, as the browser's grant level. */
export type GrantLevel = "none" | "read" | "control"

/** A macOS permission the helper may need. */
export type OsPermission = "accessibility" | "screenRecording"

/** The helper's own OS permissions — never codeg's. */
export interface PermissionReport {
  /** Whether this platform has per-application permissions at all. */
  required: boolean
  accessibility: boolean
  screenRecording: boolean
}

export type BackendState =
  | "idle"
  | "downloading"
  | "starting"
  | "ready"
  | "failed"

/** Whether the running helper checked codeg's code signature. */
export type PeerCheck = "verified" | "development" | "notApplicable"

export interface BackendStatus {
  state: BackendState
  detail?: string
  driverVersion: string
  peer?: PeerCheck
}

/** codeg's own TCC standing (macOS only). */
export interface CodegTccStatus {
  accessibility: boolean
  screenRecording: boolean
  /** When false, the two flags are the launching terminal's. */
  selfResponsible: boolean
}

/** A window with a grant in force. */
export interface SharedWindow {
  targetId: string
  appName: string
  appKey: string
  title: string
  level: GrantLevel
  grantedAt: number
  lastUsedAt: number
}

export interface ComputerStatus {
  enabled: boolean
  platform: "macos" | "windows" | "linux"
  verifiedPlatform: boolean
  backend: BackendStatus
  permissions?: PermissionReport
  codeg?: CodegTccStatus
  shared: SharedWindow[]
  /** The person pressed Stop and has not resumed. */
  paused: boolean
}

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

/** Why a window can never be shared. */
export type NotGrantable = "codeg" | "blocklisted" | "unidentified"

/** One window as the share picker shows it. */
export interface PickerWindow {
  targetId: string
  appName: string
  appKey: string
  pid: number
  title: string
  bounds: Rect
  onScreen: boolean
  minimized: boolean
  level: GrantLevel
  notGrantable?: NotGrantable
}

export type GrantChange =
  | "granted"
  | "revoked"
  | "target-changed"
  | "expired"
  | "disabled"
  | "stopped"

/** `computer://agent-grant` */
export interface ComputerGrantPayload {
  targetId: string
  change: GrantChange
  level: GrantLevel
}

export type ComputerAction =
  | "capture"
  | "snapshot"
  | "verify"
  | "click"
  | "scroll"
  | "type"
  | "key"
  | "set-value"
export type ActivityOutcome = "done" | "refused" | "failed"

/** `computer://agent-activity` */
export interface ComputerActivityPayload {
  targetId: string
  action: ComputerAction
  outcome: ActivityOutcome
  /** Unix milliseconds. */
  at: number
}

/** One entry of the default blocklist, as this platform names it. Mirror of
 *  Rust `DefaultBlockView`. */
export interface DefaultBlock {
  /** Stable: what taking it off the list is remembered by. */
  key: string
  /** Its product name; the system's own entries are named by the interface. */
  name: string
  /** Guards computer use itself: it cannot be taken off. */
  locked: boolean
  /** Bundle identifiers or executable names. */
  names: string[]
}

/** Mirror of Rust `ComputerToolsSettings`. */
export interface ComputerToolsSettings {
  enabled: boolean
  /** 0 is "until I take it back". */
  grantTtlMinutes: number
  /** Applications added to the default blocklist. */
  blocklist: string[]
  /** Keys of the default entries taken off it. */
  blocklistRemoved: string[]
  /** The default list, for showing; never sent back. */
  blocklistDefaults: DefaultBlock[]
  /** The shortcut that stops every agent at once, spelled as
   *  `stop-shortcut.ts` spells it; empty when switched off. */
  stopShortcut: string
}

/** `computer://stop-key`: whether the stop shortcut is in force. */
export interface StopKeyStatus {
  /** The shortcut in force, spelled as the settings spell it. */
  active?: string
  /** The shortcut the settings name that the OS would not take — most
   *  likely another application holds it — and what the OS said. */
  failed?: string
  detail?: string
}

/** `computer://marker`, told to the marker window alone: play the mark for
 *  this action. */
export interface ComputerMarkerPayload {
  id: number
  action: ComputerAction
}

/** What sharing several windows at once did. */
export interface ShareManyResult {
  shared: SharedWindow[]
  /** How many of the windows named were not shared: closed since the list
   *  was read, or never shareable. */
  skipped: number
}

/** What is being done to cua-driver right now. */
export type DriverTask =
  | {
      kind: "installing"
      /** Megabytes so far, and in all, once the download has said. */
      downloadedMb?: number
      totalMb?: number
    }
  | { kind: "uninstalling" }

/** cua-driver as Settings shows it (`computer_driver_info`). Desktop only. */
export interface DriverInfo {
  /** The release this codeg runs — the only one it will run. */
  version: string
  /** Whether that release has a build for this platform. */
  supported: boolean
  /** The releases in the cache, newest first. */
  installed: string[]
  /** Where the pinned release's executable is, once it is in the cache. */
  path?: string
  task?: DriverTask
  /** How the last install or removal failed, until the next one. */
  error?: string
}

/** `computer://state`: every shared window, and whether the person has
 *  pressed Stop. */
export interface ComputerStatePayload {
  shared: SharedWindow[]
  paused: boolean
}

/** Every shared window, whenever any grant changes. Desktop only. */
export const COMPUTER_STATE_EVENT = "computer://state"
export const COMPUTER_GRANT_EVENT = "computer://agent-grant"
export const COMPUTER_ACTIVITY_EVENT = "computer://agent-activity"
export const COMPUTER_BACKEND_STATUS_EVENT = "computer://backend-status"
export const COMPUTER_STOP_KEY_EVENT = "computer://stop-key"
export const COMPUTER_MARKER_EVENT = "computer://marker"
/** {@link DriverInfo}, whenever it changes or an install moves. */
export const COMPUTER_DRIVER_EVENT = "computer://driver"
/** The settings record, after any of its writers saved it. */
export const COMPUTER_TOOLS_SETTINGS_CHANGED_EVENT =
  "computer-tools-settings://changed"
