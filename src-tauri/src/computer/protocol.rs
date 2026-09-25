//! Frames between codeg and `codeg-computer-helper`.
//!
//! One private channel per helper: the socketpair codeg created and handed to
//! the helper as its stdin/stdout on macOS, plain pipes elsewhere. Frames are
//! the broker's length-prefixed JSON ([`write_frame`] / [`read_frame`]), with
//! the broker's 16 MiB cap — which is also the most the broker can hand an
//! agent in one answer, so a capture too large for this channel could not
//! have been delivered anyway.
//!
//! **The helper speaks first**, with [`HelperMessage::Ready`]. That ordering is
//! load-bearing on macOS: codeg created both ends of the socketpair, so until
//! the helper has written to its end the kernel still reports codeg itself as
//! the peer, and a signature check of "the peer" would check codeg. codeg
//! verifies the helper only after the first frame arrives.
//!
//! The ops are a closed list. The driver behind the helper advertises dozens
//! of tools — launching and killing applications, rewriting its own
//! configuration, replaying recorded input — and none of them is reachable
//! from here: the helper translates each op below into fixed driver calls,
//! and there is no op that carries a tool name. The one op that changes a
//! window, [`HelperOp::Act`], carries a closed [`WindowAction`] whose every
//! field the helper rebuilds into the driver's arguments itself.

use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use serde_json::Value;

pub use crate::acp::delegation::transport::{read_frame, write_frame, MAX_FRAME_BYTES};

use super::keys::Chord;
use super::types::{
    ActEffect, ActRoute, PointerButton, PredicateResult, Rect, ScrollDirection, ScrollUnit,
    VerifyRequest, VerifyStatus,
};

/// Bumped whenever a frame changes shape. The helper ships in the same bundle
/// as codeg, so a mismatch means a broken install (a helper left behind by a
/// partial update), and codeg refuses to talk to it rather than guess.
pub const PROTOCOL_VERSION: u32 = 2;

/// codeg → helper.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HelperRequest {
    pub id: u64,
    pub op: HelperOp,
}

/// What codeg may ask the helper for.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum HelperOp {
    /// Where the driver is, and which release it should be. Nothing that
    /// needs the driver is served before this; the helper checks the file
    /// against the pins compiled into it, not against anything said here.
    #[serde(rename_all = "camelCase")]
    Configure {
        driver_path: String,
        driver_version: String,
    },
    /// The helper's own OS permissions. Read-only: never raises a dialog.
    Permissions,
    /// Raise the system's request for one permission, charged to the helper.
    /// Only ever sent because a person pressed a button in codeg's permission
    /// guide.
    #[serde(rename_all = "camelCase")]
    RequestPermission {
        permission: OsPermission,
    },
    ListApps,
    /// Every normal window, or only `pid`'s.
    #[serde(rename_all = "camelCase")]
    ListWindows {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pid: Option<u32>,
    },
    /// When `pid` started, if it is running — the other half of a process's
    /// identity, since pids are reused.
    #[serde(rename_all = "camelCase")]
    ProcessStart {
        pid: u32,
    },
    #[serde(rename_all = "camelCase")]
    Capture {
        pid: u32,
        window_id: u64,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        max_dimension: Option<u32>,
    },
    #[serde(rename_all = "camelCase")]
    Snapshot {
        pid: u32,
        window_id: u64,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        max_depth: Option<u32>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        max_elements: Option<u32>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        query: Option<String>,
    },
    #[serde(rename_all = "camelCase")]
    Verify {
        pid: u32,
        window_id: u64,
        request: VerifyRequest,
    },
    /// Act on one window. codeg has checked the grant, the addressing and the
    /// keys; the helper checks again what only it can see at the moment of
    /// delivery — that the pid is still the process the window was shared
    /// from, that the session is not locked, that nothing has been stopped —
    /// and refuses secret fields itself.
    #[serde(rename_all = "camelCase")]
    Act {
        pid: u32,
        window_id: u64,
        /// The process start time the grant is held against.
        started_at: u64,
        /// The application's key (bundle identifier or path), for the driver
        /// paths that differ by application.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        app_key: Option<String>,
        action: WindowAction,
    },
    /// The person pressed Stop: kill the driver now — whatever it is in the
    /// middle of — and refuse everything that needs one until [`Resume`].
    ///
    /// [`Resume`]: HelperOp::Resume
    Halt,
    /// Undo a [`HelperOp::Halt`]. The next call starts a fresh driver.
    Resume,
}

/// An element of a snapshot the helper took, by the driver's snapshot id and
/// the element's index in it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ElementRef {
    pub snapshot_id: String,
    pub index: u32,
}

/// A point in the window, in its own pixels — the space of a full-size
/// capture of it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowPoint {
    pub x: f64,
    pub y: f64,
    /// The window's size (its bounds, in the platform's units) when the point
    /// was read off it. The window at another size is laid out otherwise, and
    /// the helper refuses rather than click where the point used to be.
    pub window_width: f64,
    pub window_height: f64,
}

/// Where a pointer action lands, as the helper is told it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", content = "at", rename_all = "camelCase")]
pub enum DriverTarget {
    Element(ElementRef),
    Point(WindowPoint),
}

/// One action on one window: the closed list the helper translates into
/// driver calls. Always delivered in the background.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum WindowAction {
    #[serde(rename_all = "camelCase")]
    Click {
        at: DriverTarget,
        button: PointerButton,
        count: u8,
    },
    #[serde(rename_all = "camelCase")]
    Scroll {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        at: Option<DriverTarget>,
        direction: ScrollDirection,
        amount: u32,
        unit: ScrollUnit,
    },
    #[serde(rename_all = "camelCase")]
    Type {
        element: ElementRef,
        text: String,
        submit: bool,
    },
    #[serde(rename_all = "camelCase")]
    Key {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        element: Option<ElementRef>,
        chord: Chord,
    },
    #[serde(rename_all = "camelCase")]
    SetValue { element: ElementRef, value: String },
}

impl WindowAction {
    /// The element the action names, if it names one.
    pub fn element(&self) -> Option<&ElementRef> {
        match self {
            WindowAction::Click {
                at: DriverTarget::Element(e),
                ..
            }
            | WindowAction::Scroll {
                at: Some(DriverTarget::Element(e)),
                ..
            } => Some(e),
            WindowAction::Type { element, .. } | WindowAction::SetValue { element, .. } => {
                Some(element)
            }
            WindowAction::Key { element, .. } => element.as_ref(),
            _ => None,
        }
    }

    /// The point the action names, if it names one.
    pub fn point(&self) -> Option<&WindowPoint> {
        match self {
            WindowAction::Click {
                at: DriverTarget::Point(p),
                ..
            }
            | WindowAction::Scroll {
                at: Some(DriverTarget::Point(p)),
                ..
            } => Some(p),
            _ => None,
        }
    }

    /// Whether the action puts text into its element: typing, setting a
    /// value, or a character key. Such an action never goes to a secret
    /// field.
    pub fn writes_text(&self) -> bool {
        match self {
            WindowAction::Type { .. } | WindowAction::SetValue { .. } => true,
            WindowAction::Key { chord, .. } => chord.types_text(),
            _ => false,
        }
    }
}

/// What the helper reports of an action that went out.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RawAct {
    pub effect: ActEffect,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub route: Option<ActRoute>,
    /// For typing with `submit`: whether return was pressed after the text.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub submitted: Option<bool>,
}

/// helper → codeg.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum HelperMessage {
    /// The helper's first frame. See the module note for why it goes first.
    Ready(HelperReady),
    Reply(HelperReply),
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HelperReady {
    pub protocol: u32,
    /// The helper's own crate version, which is codeg's.
    pub version: String,
    /// What the helper knows about who it is talking to.
    pub peer: PeerCheck,
}

/// Whether the helper checked codeg's code signature before serving it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PeerCheck {
    /// It did, and codeg passed (macOS release builds).
    Verified,
    /// A development build: no requirement was compiled in to check against.
    /// Said out loud so codeg can show it.
    Development,
    /// No code signature to check on this platform.
    NotApplicable,
}

/// The answer to one [`HelperRequest`]: exactly one of `ok` / `error`.
///
/// `ok` travels as a plain JSON value because codeg knows which op it asked
/// and decodes it into that op's type ([`HelperReply::decode`]); a tagged
/// union here would only repeat the op kind the id already names.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HelperReply {
    pub id: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ok: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<HelperError>,
}

impl HelperReply {
    pub fn ok(id: u64, value: impl Serialize) -> Self {
        match serde_json::to_value(value) {
            Ok(value) => Self {
                id,
                ok: Some(value),
                error: None,
            },
            Err(e) => Self::error(id, HelperError::failed(format!("encode: {e}"))),
        }
    }

    pub fn error(id: u64, error: HelperError) -> Self {
        Self {
            id,
            ok: None,
            error: Some(error),
        }
    }

    /// The answer as the type the op promises, or the helper's error.
    pub fn decode<T: DeserializeOwned>(self) -> Result<T, HelperError> {
        if let Some(error) = self.error {
            return Err(error);
        }
        let value = self.ok.unwrap_or(Value::Null);
        serde_json::from_value(value).map_err(|e| {
            HelperError::failed(format!("the helper answered in an unexpected shape: {e}"))
        })
    }
}

/// A permission the helper may need from the OS.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum OsPermission {
    /// macOS Accessibility: reading the element tree.
    Accessibility,
    /// macOS Screen Recording: screenshots, and other applications' window
    /// titles.
    ScreenRecording,
}

/// The helper's OS permissions, as the helper itself sees them.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PermissionReport {
    /// Whether this platform has per-application permissions at all. `false`
    /// on Windows and X11, where both flags below are reported `true`.
    pub required: bool,
    pub accessibility: bool,
    pub screen_recording: bool,
}

/// One running application, as the driver reports it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RawApp {
    pub pid: u32,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bundle_id: Option<String>,
    /// The application's path on disk (its `.app` bundle on macOS, its
    /// executable elsewhere), when the platform says.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    pub active: bool,
    /// An opaque, platform-specific stamp of when the process started. Only
    /// ever compared for equality.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub started_at: Option<u64>,
}

impl RawApp {
    /// The stable name of the application: its bundle identifier where it has
    /// one, its path otherwise. `None` for a process the platform describes
    /// by neither, which can be listed but never matched by a blocklist.
    pub fn key(&self) -> Option<&str> {
        self.bundle_id
            .as_deref()
            .filter(|s| !s.is_empty())
            .or(self.path.as_deref().filter(|s| !s.is_empty()))
    }
}

/// One normal window, as the driver reports it, joined with its application.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RawWindow {
    pub window_id: u64,
    pub pid: u32,
    /// Empty when the platform withholds it — on macOS, whenever the helper
    /// lacks Screen Recording.
    #[serde(default)]
    pub title: String,
    pub bounds: Rect,
    pub on_screen: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub minimized: Option<bool>,
    /// `false` for a window on another Space (desktop); `None` when the
    /// platform cannot say.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub on_current_space: Option<bool>,
    /// Higher is closer to the front; `None` when the platform cannot say.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub z_index: Option<i64>,
    pub app: RawApp,
}

/// A window screenshot.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RawCapture {
    /// PNG, base64.
    pub png_base64: String,
    /// The image's size, after the helper shrank it to the size asked for.
    pub width: u32,
    pub height: u32,
    /// The capture's size before it was shrunk: the window's own pixels. A
    /// point read off the image is scaled by `native / delivered` to reach
    /// the pixel the driver will act on.
    pub native_width: u32,
    pub native_height: u32,
    /// Whether `native_*` are known to be the window's pixels at full size —
    /// the driver runs with no ceiling on a capture, and the capture is the
    /// size of the window. Pointing by coordinates needs it.
    #[serde(default)]
    pub full_size: bool,
    pub window_bounds: Rect,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
}

/// A window's accessibility tree.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RawSnapshot {
    pub tree: String,
    pub element_count: u64,
    #[serde(default)]
    pub truncated: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub degraded: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub window_bounds: Option<Rect>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    /// The driver's id for this snapshot, which its elements are addressed
    /// by. `None` when the driver kept none (it could not match the window's
    /// accessibility surface): nothing in this tree can be acted on.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub snapshot_id: Option<String>,
    /// Every element that can be acted on, in tree order.
    #[serde(default)]
    pub refs: Vec<SnapshotRef>,
}

/// One element of a snapshot that can be acted on: the `[N]` in its line.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SnapshotRef {
    pub index: u32,
    /// Where the element's line starts in `tree`, in bytes — so whoever cuts
    /// the tree short knows which refs the reader was shown.
    pub offset: u32,
    /// A password or other secret field: its value was taken out of the
    /// tree, and nothing is typed into it.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub secret: bool,
}

/// The driver's verdict on a set of predicates.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RawVerify {
    pub status: VerifyStatus,
    pub stable: bool,
    pub samples: u64,
    pub elapsed_ms: u64,
    pub predicates: Vec<PredicateResult>,
}

/// Why the helper could not do what it was asked.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HelperError {
    pub code: HelperErrorCode,
    pub message: String,
    /// Which permission is missing, for [`HelperErrorCode::PermissionMissing`].
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub permission: Option<OsPermission>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum HelperErrorCode {
    /// The helper lacks an OS permission this op needs.
    PermissionMissing,
    /// No such window, or it no longer belongs to the process named.
    NoSuchWindow,
    /// The driver is not there, would not start, or died.
    DriverUnavailable,
    /// The driver file is not the pinned release: its signature, cdhash,
    /// runtime flag, entitlements or digest did not match. Not retried — the
    /// same file will fail the same way.
    DriverRejected,
    /// An op that needs the driver arrived before `Configure`.
    NotConfigured,
    /// The op itself was malformed.
    BadRequest,
    /// Anything else, in words.
    Failed,
    /// No input goes anywhere right now: the person pressed Stop, or the
    /// session is locked.
    Paused,
    /// The element or point is from a snapshot or capture the window has
    /// moved past — a newer snapshot replaced it, the window changed size.
    StaleRef,
    /// The element or point is not in the window.
    OutOfTarget,
    /// The window cannot take input in the background right now: minimized,
    /// hidden, on another desktop, or its application has another window the
    /// keys could reach instead.
    Occluded,
    /// The application offers no route for this action in the background.
    BackgroundUnavailable,
    /// The element is a password or other secret field.
    SecretField,
    /// The action was allowed and did not happen: a disabled control, no such
    /// option, more text than one call can type.
    ActionFailed,
}

impl HelperError {
    pub fn new(code: HelperErrorCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
            permission: None,
        }
    }

    pub fn failed(message: impl Into<String>) -> Self {
        Self::new(HelperErrorCode::Failed, message)
    }

    pub fn permission_missing(permission: OsPermission) -> Self {
        let what = match permission {
            OsPermission::Accessibility => "Accessibility",
            OsPermission::ScreenRecording => "Screen Recording",
        };
        Self {
            code: HelperErrorCode::PermissionMissing,
            message: format!("codeg-computer-helper has not been granted {what}"),
            permission: Some(permission),
        }
    }
}

impl std::fmt::Display for HelperError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for HelperError {}

#[cfg(test)]
mod tests {
    use super::*;

    /// Ops are tagged by `kind` in camelCase — the one spelling both ends
    /// agree on — and an op the helper does not know is a parse error rather
    /// than something it could be tricked into forwarding.
    #[test]
    fn ops_round_trip_and_unknown_ops_do_not_parse() {
        let op = HelperOp::Capture {
            pid: 42,
            window_id: 7,
            max_dimension: Some(800),
        };
        let wire = serde_json::to_value(&op).unwrap();
        assert_eq!(wire["kind"], "capture");
        assert_eq!(wire["windowId"], 7);
        assert_eq!(serde_json::from_value::<HelperOp>(wire).unwrap(), op);

        assert!(serde_json::from_value::<HelperOp>(serde_json::json!({
            "kind": "callTool",
            "name": "launch_app",
        }))
        .is_err());
    }

    /// A reply carries exactly one of its two halves, and decoding it into
    /// the wrong shape is an error rather than a default.
    #[test]
    fn a_reply_decodes_into_the_op_type_or_says_why_not() {
        let report = PermissionReport {
            required: true,
            accessibility: true,
            screen_recording: false,
        };
        let reply = HelperReply::ok(3, report);
        let wire = serde_json::to_value(&reply).unwrap();
        assert!(wire.get("error").is_none());
        let back: HelperReply = serde_json::from_value(wire).unwrap();
        assert_eq!(back.clone().decode::<PermissionReport>().unwrap(), report);
        assert!(back.decode::<RawCapture>().is_err());

        let refused = HelperReply::error(
            4,
            HelperError::permission_missing(OsPermission::ScreenRecording),
        );
        let err = refused.decode::<RawCapture>().unwrap_err();
        assert_eq!(err.code, HelperErrorCode::PermissionMissing);
        assert_eq!(err.permission, Some(OsPermission::ScreenRecording));
    }

    #[test]
    fn the_ready_frame_is_tagged() {
        let ready = HelperMessage::Ready(HelperReady {
            protocol: PROTOCOL_VERSION,
            version: "0.0.0".into(),
            peer: PeerCheck::Development,
        });
        let wire = serde_json::to_value(&ready).unwrap();
        assert_eq!(wire["kind"], "ready");
        assert_eq!(wire["peer"], "development");
        assert_eq!(
            serde_json::from_value::<HelperMessage>(wire).unwrap(),
            ready
        );
    }

    #[test]
    fn an_application_is_keyed_by_bundle_then_path() {
        let mut app = RawApp {
            pid: 1,
            name: "Mail".into(),
            bundle_id: Some("com.apple.mail".into()),
            path: Some("/System/Applications/Mail.app".into()),
            active: false,
            started_at: None,
        };
        assert_eq!(app.key(), Some("com.apple.mail"));
        app.bundle_id = Some(String::new());
        assert_eq!(app.key(), Some("/System/Applications/Mail.app"));
        app.path = None;
        assert_eq!(app.key(), None);
    }
}
