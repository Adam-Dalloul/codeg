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

/** `computer://agent-grant` */
export interface ComputerGrantPayload {
  targetId: string
  change: GrantChange
  level: GrantLevel
}

export type ComputerAction = "capture" | "snapshot" | "verify"
export type ActivityOutcome = "done" | "refused" | "failed"

/** `computer://agent-activity` */
export interface ComputerActivityPayload {
  targetId: string
  action: ComputerAction
  outcome: ActivityOutcome
  /** Unix milliseconds. */
  at: number
}

/** Mirror of Rust `ComputerToolsSettings`. */
export interface ComputerToolsSettings {
  enabled: boolean
  /** 0 is "until I take it back". */
  grantTtlMinutes: number
  /** Applications added to the built-in blocklist. */
  blocklist: string[]
}

/** Every shared window, whenever any grant changes. Desktop only. */
export const COMPUTER_STATE_EVENT = "computer://state"
export const COMPUTER_GRANT_EVENT = "computer://agent-grant"
export const COMPUTER_ACTIVITY_EVENT = "computer://agent-activity"
export const COMPUTER_BACKEND_STATUS_EVENT = "computer://backend-status"
/** The settings record, after any of its writers saved it. */
export const COMPUTER_TOOLS_SETTINGS_CHANGED_EVENT =
  "computer-tools-settings://changed"
