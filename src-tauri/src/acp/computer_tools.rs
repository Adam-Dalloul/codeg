//! Listener-facing access for computer use (`computer_list_apps`,
//! `computer_list_windows`, `computer_screenshot`, `computer_snapshot`,
//! `computer_verify`, and the actions `computer_click`, `computer_scroll`,
//! `computer_type`, `computer_press_key`, `computer_set_value`) carried by
//! codeg-mcp.
//!
//! The same split as the browser tools: nothing here decides whether a window
//! may be read. That is `crate::computer::agent` and the target table, and it
//! is enforced inside `commands::computer`, which the production impl calls —
//! so an MCP read passes the same grant check, and leaves the same line on the
//! panel's activity list, as any other.
//!
//! What this module owns is the shape of the answer — a refusal is a value,
//! not a transport error, so the agent can relay "ask the user to share that
//! window" instead of losing its turn — the words of each refusal, each of
//! which says whether trying again can help (a model takes that sentence
//! literally), and the answer where there is no
//! desktop at all ([`NoComputerDesktop`]): server mode, where the group is not
//! advertised in the first place.

use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use tokio::sync::RwLock;

use crate::computer::types::{
    ActReport, AgentAppSummary, AgentWindowSummary, ComputerActRequest, VerifyOutcome,
    VerifyRequest, WindowCapture, WindowSnapshot,
};

/// This build has no desktop to show (server mode), the user has switched
/// computer use off, or it cannot run here right now (the note says which).
pub const ERROR_UNAVAILABLE: &str = "computer_unavailable";

/// The window exists and this agent may not read it: nobody shared it, the
/// sharing ended, or the window went away. One slug for all of them — the
/// instruction is the same, and telling them apart would describe a window
/// the agent has no right to know anything about.
pub const ERROR_GRANT_REQUIRED: &str = "computer_grant_required";

/// No window by that id. Also the answer to a caller whose token does not
/// check out, so an unauthenticated round trip learns nothing about what is
/// on the screen.
pub const ERROR_NO_SUCH_TARGET: &str = "computer_no_such_target";

/// The window can never be shared: codeg's own, or an application on the
/// blocklist. Permanent — asking again changes nothing.
pub const ERROR_BLOCKED: &str = "computer_blocked";

/// The OS has not given codeg's helper a permission the read needs. The user
/// can fix it in System Settings; the agent cannot.
pub const ERROR_PERMISSION_MISSING: &str = "computer_permission_missing";

/// The window was shared and the read still did not produce anything — the
/// driver failed, or the window closed mid-read.
pub const ERROR_READ_FAILED: &str = "computer_read_failed";

/// The window is shared for reading and the agent asked to act on it — or
/// asked for a key a window grant does not reach (one that acts on the whole
/// application or the desktop). Its own slug, like the browser's: the person
/// has a different thing to do than share the window.
pub const ERROR_CONTROL_REQUIRED: &str = "computer_control_required";

/// The ref or point is not from the window's latest snapshot or screenshot as
/// the agent was given it, or the window has changed under it. Not a
/// permission matter: read the window again and use what the new read says.
pub const ERROR_STALE_REF: &str = "computer_stale_ref";

/// The point is outside the image it was read off, or the element is not
/// part of the shared window.
pub const ERROR_OUT_OF_TARGET: &str = "computer_out_of_target";

/// The window cannot take input in the background right now — minimized,
/// hidden, on another desktop, or its application has another window the keys
/// could reach instead.
pub const ERROR_OCCLUDED: &str = "computer_occluded";

/// The application offers no background route for this action, and codeg
/// does not bring windows to the front.
pub const ERROR_BACKGROUND_UNAVAILABLE: &str = "computer_background_unavailable";

/// The action was allowed and did not happen: a disabled control, no such
/// option, more text than one call can type. The note says which.
pub const ERROR_ACTION_FAILED: &str = "computer_action_failed";

/// The person pressed Stop, or the screen is locked. Nothing reaches any
/// window until they resume.
pub const ERROR_PAUSED: &str = "computer_paused";

/// What a `computer_snapshot` asks for when the caller names no cap — the
/// same default as `browser_snapshot`, for the same reason: the caller who
/// names nothing is a model with a context window.
pub const DEFAULT_SNAPSHOT_MAX_CHARS: usize = 40_000;

/// The long edge of a screenshot when the caller names none: the driver's own
/// default, and the size every current model accepts without resizing.
pub const DEFAULT_MAX_DIMENSION: u32 = 1568;

/// Said to an agent in a runtime with no desktop, and to one whose user has
/// switched the group off.
pub const NO_DESKTOP_NOTE: &str =
    "Computer use is not available in this session: there are no windows to read.";

/// How to share a window, for every refusal that ends in "ask the user".
const SHARE_HOW: &str = "Ask the user to share it: in codeg's status bar they open Computer use \
                         and press \"Share a window…\". Sharing is theirs to give — there is no \
                         way to take it, and no point retrying until they have.";

/// What `computer_list_apps` answers.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ComputerAppsOutcome {
    pub apps: Vec<AgentAppSummary>,
    /// One of the slugs above when the list is empty for a reason.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
}

impl ComputerAppsOutcome {
    pub fn refused(error: &str, note: impl Into<String>) -> Self {
        Self {
            apps: Vec::new(),
            error: Some(error.to_string()),
            note: Some(note.into()),
        }
    }
}

/// What `computer_list_windows` answers.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ComputerWindowsOutcome {
    pub windows: Vec<AgentWindowSummary>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
}

impl ComputerWindowsOutcome {
    pub fn refused(error: &str, note: impl Into<String>) -> Self {
        Self {
            windows: Vec::new(),
            error: Some(error.to_string()),
            note: Some(note.into()),
        }
    }
}

/// A refusal about one window, shared by the three per-window reads.
///
/// The words are the same whichever read was refused, so a refusal cannot be
/// used to learn which gate a window stops at.
pub fn grant_required_note(target_id: &str) -> String {
    format!(
        "Window {target_id} is not shared with agents, or no longer is (sharing ends when the \
         window closes, when its application quits, after a while unused, or when the user takes \
         it back). {SHARE_HOW} If the window may have closed, call computer_list_windows first."
    )
}

pub fn no_such_target_note(target_id: &str) -> String {
    format!(
        "There is no window {target_id}. Call computer_list_windows for the windows that exist \
         now, and use a targetId from it."
    )
}

pub fn blocked_note(target_id: &str, why: &str) -> String {
    format!("Window {target_id} is {why} Do not ask the user to share it; it cannot be done.")
}

pub fn permission_missing_note(permission: &str) -> String {
    format!(
        "codeg-computer-helper has not been granted {permission} by macOS. Ask the user to grant \
         it: in codeg's status bar they open Computer use and follow the permission guide \
         (System Settings → Privacy & Security → {permission}). Only they can, and retrying will \
         not help until they have."
    )
}

pub fn control_required_note(target_id: &str) -> String {
    format!(
        "Window {target_id} is shared with you for reading only. Ask the user to allow control \
         of it: in codeg's status bar they open Computer use and set that window to \"Read and \
         control\". Only they can; retrying will not change it. You can still read the window."
    )
}

/// A key that reaches past the window — the application's or the desktop's.
pub fn chord_beyond_note() -> String {
    format!(
        "That key acts on the whole application or on the desktop, which a shared window does \
         not reach, so it was not pressed; retrying will not change it. {} For anything else, \
         act on an element: computer_click by ref, or computer_set_value.",
        crate::computer::keys::window_chords_note(crate::computer::keys::Platform::current())
    )
}

pub const PASTE_NOTE: &str = "Pasting is not available: the clipboard is the user's own, and \
     what is on it may not come from any window you may read. Type the text with computer_type \
     instead.";

pub const NEEDS_ELEMENT_NOTE: &str = "A key that types a character goes only into an element you \
     name: pass its ref from computer_snapshot, or type the text with computer_type.";

pub const SECRET_FIELD_NOTE: &str = "That is a password or other secret field: typing into it, or \
     setting it, is left to the user. Ask them to fill it in themselves; retrying will not change \
     it.";

pub fn stale_snapshot_note(target_id: &str) -> String {
    format!(
        "That ref is not from the latest computer_snapshot of window {target_id} — every new \
         snapshot replaces the refs of the one before. Take a new computer_snapshot and use a ref \
         from it."
    )
}

pub fn not_actionable_note(target_id: &str) -> String {
    format!(
        "Nothing in that snapshot of window {target_id} can be acted on: its accessibility tree \
         could not be matched to the window. Take a new computer_snapshot; if it says the same, \
         use a point from computer_screenshot instead."
    )
}

pub fn cut_away_note(index: u32) -> String {
    format!(
        "Ref {index} was past where the snapshot you were given was cut (maxChars). Take a new \
         computer_snapshot with a larger maxChars, or a query that keeps its line, and use the \
         ref from that."
    )
}

pub fn no_such_ref_note(target_id: &str, index: u32) -> String {
    format!(
        "The latest snapshot of window {target_id} has no ref {index}. Use a ref that is in it."
    )
}

pub fn stale_capture_note(target_id: &str) -> String {
    format!(
        "Those coordinates are not from the latest computer_screenshot of window {target_id}: a \
         point means something only in the image it was read off. Take a new computer_screenshot \
         and use a point from it."
    )
}

pub const OUT_OF_IMAGE_NOTE: &str = "That point is outside the screenshot it names. Use a point \
     inside the image, measured in its pixels from its top-left corner.";

pub fn no_pointing_note(target_id: &str) -> String {
    format!(
        "Points cannot be used on that screenshot of window {target_id}. Use a ref from \
         computer_snapshot instead."
    )
}

pub const STOPPED_NOTE: &str = "The user pressed Stop in codeg's Computer use panel: nothing \
     reaches any window, and nothing is read, until they resume it. Do not retry on your own — \
     tell the user, and wait for them to say go on.";

/// What an action tool answers: what the action did, or why it did not
/// happen.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ComputerActOutcome {
    pub target_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub action: Option<ActReport>,
    /// One of the slugs above. `None` exactly when `action` is `Some`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
}

impl ComputerActOutcome {
    pub fn done(target_id: &str, report: ActReport) -> Self {
        Self {
            target_id: target_id.to_string(),
            action: Some(report),
            error: None,
            note: None,
        }
    }

    pub fn refused(target_id: &str, error: &str, note: impl Into<String>) -> Self {
        Self {
            target_id: target_id.to_string(),
            action: None,
            error: Some(error.to_string()),
            note: Some(note.into()),
        }
    }
}

/// What `computer_screenshot` answers.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ComputerCaptureOutcome {
    pub target_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub capture: Option<WindowCapture>,
    /// `None` exactly when `capture` is `Some`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
}

impl ComputerCaptureOutcome {
    pub fn image(target_id: &str, capture: WindowCapture) -> Self {
        Self {
            target_id: target_id.to_string(),
            capture: Some(capture),
            error: None,
            note: None,
        }
    }

    pub fn refused(target_id: &str, error: &str, note: impl Into<String>) -> Self {
        Self {
            target_id: target_id.to_string(),
            capture: None,
            error: Some(error.to_string()),
            note: Some(note.into()),
        }
    }
}

/// What `computer_snapshot` asks for.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SnapshotRequest {
    /// Cap on the returned tree in characters. `None` →
    /// [`DEFAULT_SNAPSHOT_MAX_CHARS`]; `Some(0)` → no cap.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_chars: Option<usize>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_depth: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_elements: Option<u32>,
    /// Keep only the lines mentioning this (and their ancestors).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub query: Option<String>,
}

/// What `computer_snapshot` answers.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ComputerSnapshotOutcome {
    pub target_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub snapshot: Option<WindowSnapshot>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
}

impl ComputerSnapshotOutcome {
    pub fn tree(target_id: &str, snapshot: WindowSnapshot) -> Self {
        Self {
            target_id: target_id.to_string(),
            snapshot: Some(snapshot),
            error: None,
            note: None,
        }
    }

    pub fn refused(target_id: &str, error: &str, note: impl Into<String>) -> Self {
        Self {
            target_id: target_id.to_string(),
            snapshot: None,
            error: Some(error.to_string()),
            note: Some(note.into()),
        }
    }
}

/// What `computer_verify` answers.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ComputerVerifyOutcome {
    pub target_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub verify: Option<VerifyOutcome>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
}

impl ComputerVerifyOutcome {
    pub fn verdict(target_id: &str, verify: VerifyOutcome) -> Self {
        Self {
            target_id: target_id.to_string(),
            verify: Some(verify),
            error: None,
            note: None,
        }
    }

    pub fn refused(target_id: &str, error: &str, note: impl Into<String>) -> Self {
        Self {
            target_id: target_id.to_string(),
            verify: None,
            error: Some(error.to_string()),
            note: Some(note.into()),
        }
    }
}

/// Listener-facing access to computer use. The production impl
/// (`crate::commands::computer::McpComputerTools`) exists only in the desktop
/// build; server mode and tests use [`NoComputerDesktop`].
#[async_trait]
pub trait ComputerToolAccess: Send + Sync {
    /// The running applications.
    async fn list_apps(&self) -> ComputerAppsOutcome;

    /// Every normal window, or `pid`'s only.
    async fn list_windows(&self, pid: Option<u32>) -> ComputerWindowsOutcome;

    /// A screenshot of one shared window.
    async fn capture(&self, target_id: &str, max_dimension: Option<u32>) -> ComputerCaptureOutcome;

    /// The accessibility tree of one shared window.
    async fn snapshot(&self, target_id: &str, request: SnapshotRequest) -> ComputerSnapshotOutcome;

    /// Check predicates against one shared window.
    async fn verify(&self, target_id: &str, request: VerifyRequest) -> ComputerVerifyOutcome;

    /// Act on one window shared for control.
    async fn act(&self, target_id: &str, request: ComputerActRequest) -> ComputerActOutcome;
}

/// The answer where there is no desktop: server mode, and the stub in every
/// test that does not care about one.
pub struct NoComputerDesktop;

#[async_trait]
impl ComputerToolAccess for NoComputerDesktop {
    async fn list_apps(&self) -> ComputerAppsOutcome {
        ComputerAppsOutcome::refused(ERROR_UNAVAILABLE, NO_DESKTOP_NOTE)
    }

    async fn list_windows(&self, _pid: Option<u32>) -> ComputerWindowsOutcome {
        ComputerWindowsOutcome::refused(ERROR_UNAVAILABLE, NO_DESKTOP_NOTE)
    }

    async fn capture(&self, target_id: &str, _max: Option<u32>) -> ComputerCaptureOutcome {
        ComputerCaptureOutcome::refused(target_id, ERROR_UNAVAILABLE, NO_DESKTOP_NOTE)
    }

    async fn snapshot(
        &self,
        target_id: &str,
        _request: SnapshotRequest,
    ) -> ComputerSnapshotOutcome {
        ComputerSnapshotOutcome::refused(target_id, ERROR_UNAVAILABLE, NO_DESKTOP_NOTE)
    }

    async fn verify(&self, target_id: &str, _request: VerifyRequest) -> ComputerVerifyOutcome {
        ComputerVerifyOutcome::refused(target_id, ERROR_UNAVAILABLE, NO_DESKTOP_NOTE)
    }

    async fn act(&self, target_id: &str, _request: ComputerActRequest) -> ComputerActOutcome {
        ComputerActOutcome::refused(target_id, ERROR_UNAVAILABLE, NO_DESKTOP_NOTE)
    }
}

/// The computer-use settings as the tool surface reads them, at injection and
/// again at call time — like the browser group, because switching it off
/// should stop the agent that is already running, not only the next one.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ComputerToolsConfig {
    pub enabled: bool,
    /// How long a shared window may go unread before its sharing ends. `None`
    /// is "until the user takes it back".
    pub grant_ttl: Option<Duration>,
    /// Applications the user added to the built-in blocklist.
    pub blocklist: Vec<String>,
    /// How many times the group has been switched off since codeg started.
    /// Kept by [`ComputerToolsRuntimeConfig::set`], never persisted: it is
    /// what lets a watcher that only sees the latest value — a quick off and
    /// on again arrives as one change — still see that there was an off, and
    /// a read in flight see that one happened while it was.
    pub switched_off: u64,
}

/// Shared, hot-swappable handle to [`ComputerToolsConfig`]. Cloned into
/// `DelegationInjection` (read at injection), into the access impl (read at
/// call time) and into `AppState` (updated on save).
///
/// Unlike the browser's handle it can also be watched: switching computer use
/// off ends every grant and stops the helper, and whoever owns those — the
/// desktop's computer service — learns of the switch here, whichever of the
/// three writers (settings form, status popover, web settings) moved it.
///
/// Two ways to learn of it, for two kinds of consequence. What a change takes
/// away — grants — goes through [`on_change`](Self::on_change): run inside
/// [`set`](Self::set), once per change, with the settings before and after,
/// so it is done before the write returns and no change is ever merged into
/// the next. What can wait for a task to be scheduled — stopping and starting
/// the helper — goes through [`subscribe`](Self::subscribe), which sees only
/// the latest value (hence `switched_off`).
#[derive(Clone)]
pub struct ComputerToolsRuntimeConfig {
    inner: Arc<RwLock<ComputerToolsConfig>>,
    changes: Arc<tokio::sync::watch::Sender<ComputerToolsConfig>>,
    hook: Arc<std::sync::RwLock<Option<ChangeHook>>>,
}

/// See [`ComputerToolsRuntimeConfig::on_change`].
type ChangeHook = Box<dyn Fn(&ComputerToolsConfig, &ComputerToolsConfig) + Send + Sync>;

impl Default for ComputerToolsRuntimeConfig {
    fn default() -> Self {
        Self {
            inner: Arc::new(RwLock::new(ComputerToolsConfig::default())),
            changes: Arc::new(tokio::sync::watch::channel(ComputerToolsConfig::default()).0),
            hook: Arc::new(std::sync::RwLock::new(None)),
        }
    }
}

impl ComputerToolsRuntimeConfig {
    pub fn new() -> Self {
        Self::default()
    }

    pub async fn snapshot(&self) -> ComputerToolsConfig {
        self.inner.read().await.clone()
    }

    pub async fn set(&self, mut cfg: ComputerToolsConfig) {
        let mut inner = self.inner.write().await;
        cfg.switched_off = inner.switched_off + u64::from(inner.enabled && !cfg.enabled);
        let before = std::mem::replace(&mut *inner, cfg.clone());
        // Under the write lock: no reader sees the new settings before the
        // hook has acted on them.
        if let Some(hook) = self.hook.read().unwrap_or_else(|p| p.into_inner()).as_ref() {
            hook(&before, &cfg);
        }
        // Published under the write lock, so watchers see changes in the order
        // they were made.
        self.changes.send_replace(cfg);
    }

    /// Run `hook` on every change, inside [`set`](Self::set) and before it
    /// returns, with the settings before and after. For what a change takes
    /// away, which must not wait for a watcher to be scheduled — nor be merged
    /// away when a second change follows before it is. It runs under the
    /// settings' write lock: it must not read them back through this handle.
    /// One hook; a second replaces the first.
    pub fn on_change(
        &self,
        hook: impl Fn(&ComputerToolsConfig, &ComputerToolsConfig) + Send + Sync + 'static,
    ) {
        *self.hook.write().unwrap_or_else(|p| p.into_inner()) = Some(Box::new(hook));
    }

    pub async fn is_enabled(&self) -> bool {
        self.inner.read().await.enabled
    }

    /// Every change from here on.
    pub fn subscribe(&self) -> tokio::sync::watch::Receiver<ComputerToolsConfig> {
        self.changes.subscribe()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::computer::types::GrantLevel;

    /// Every per-window refusal names the window, carries a slug the model
    /// can branch on, and says whether trying again is worth anything.
    #[test]
    fn refusals_name_the_window_and_the_next_step() {
        let note = grant_required_note("w7");
        assert!(note.contains("w7"));
        assert!(note.contains("Share a window"));
        assert!(note.contains("no point retrying"));

        let note = no_such_target_note("w9");
        assert!(note.contains("computer_list_windows"));

        let note = blocked_note("w3", "codeg's own window: it can never be shared.");
        assert!(note.contains("cannot be done"));

        let note = permission_missing_note("Screen Recording");
        assert!(note.contains("Privacy & Security → Screen Recording"));
        assert!(note.contains("retrying will not help"));
    }

    /// The payload and the refusal are exclusive on the wire, and the absent
    /// one is absent rather than null: the companion branches on which key
    /// is there.
    #[test]
    fn the_wire_carries_one_of_the_answer_and_the_refusal() {
        let refused = serde_json::to_value(ComputerCaptureOutcome::refused(
            "w1",
            ERROR_GRANT_REQUIRED,
            grant_required_note("w1"),
        ))
        .unwrap();
        assert_eq!(refused["targetId"], "w1");
        assert_eq!(refused["error"], ERROR_GRANT_REQUIRED);
        assert!(refused.get("capture").is_none());

        let listed = serde_json::to_value(ComputerWindowsOutcome {
            windows: vec![AgentWindowSummary {
                target_id: "w2".into(),
                app: crate::computer::types::AgentAppRef {
                    key: "com.apple.TextEdit".into(),
                    name: "TextEdit".into(),
                    pid: 42,
                },
                bounds: Default::default(),
                on_screen: true,
                minimized: None,
                level: GrantLevel::None,
                title: None,
                note: None,
            }],
            error: None,
            note: None,
        })
        .unwrap();
        assert_eq!(listed["windows"][0]["targetId"], "w2");
        assert_eq!(listed["windows"][0]["level"], "none");
        assert!(listed["windows"][0].get("title").is_none());
        assert!(listed.get("error").is_none());
    }

    #[tokio::test]
    async fn no_desktop_answers_unavailable_everywhere() {
        let none = NoComputerDesktop;
        assert_eq!(
            none.list_apps().await.error.as_deref(),
            Some(ERROR_UNAVAILABLE)
        );
        assert_eq!(
            none.list_windows(None).await.error.as_deref(),
            Some(ERROR_UNAVAILABLE)
        );
        assert_eq!(
            none.capture("w1", None).await.error.as_deref(),
            Some(ERROR_UNAVAILABLE)
        );
        assert_eq!(
            none.snapshot("w1", SnapshotRequest::default())
                .await
                .error
                .as_deref(),
            Some(ERROR_UNAVAILABLE)
        );
        assert_eq!(
            none.verify("w1", VerifyRequest::default())
                .await
                .error
                .as_deref(),
            Some(ERROR_UNAVAILABLE)
        );
    }

    #[tokio::test]
    async fn runtime_config_round_trips_and_announces_changes() {
        let cfg = ComputerToolsRuntimeConfig::new();
        let mut watcher = cfg.subscribe();
        assert!(!cfg.is_enabled().await);
        let on = ComputerToolsConfig {
            enabled: true,
            grant_ttl: Some(Duration::from_secs(1800)),
            blocklist: vec!["com.example.vault".into()],
            switched_off: 0,
        };
        cfg.set(on.clone()).await;
        assert!(cfg.is_enabled().await);
        assert_eq!(cfg.snapshot().await, on);
        watcher.changed().await.unwrap();
        assert_eq!(*watcher.borrow_and_update(), on);
    }

    /// Off and straight back on reaches a watcher as one change — and the off
    /// in it is still visible, because the count moved.
    #[tokio::test]
    async fn a_quick_off_and_on_still_counts_as_an_off() {
        let cfg = ComputerToolsRuntimeConfig::new();
        let on = ComputerToolsConfig {
            enabled: true,
            ..Default::default()
        };
        cfg.set(on.clone()).await;
        let mut watcher = cfg.subscribe();
        let before = watcher.borrow_and_update().switched_off;
        cfg.set(ComputerToolsConfig::default()).await;
        cfg.set(on.clone()).await;
        watcher.changed().await.unwrap();
        let seen = watcher.borrow_and_update().clone();
        assert!(seen.enabled);
        assert_eq!(seen.switched_off, before + 1);
        // Setting it off again while off is not another off.
        cfg.set(ComputerToolsConfig::default()).await;
        cfg.set(ComputerToolsConfig::default()).await;
        assert_eq!(cfg.snapshot().await.switched_off, before + 2);
    }

    /// The hook sees every change, one at a time and before `set` returns —
    /// including an add-then-remove that a watcher would only see the end of.
    #[tokio::test]
    async fn the_change_hook_sees_every_change_before_set_returns() {
        let cfg = ComputerToolsRuntimeConfig::new();
        let seen = Arc::new(std::sync::Mutex::new(Vec::new()));
        let log = seen.clone();
        cfg.on_change(move |before, after| {
            log.lock()
                .unwrap()
                .push((before.blocklist.clone(), after.blocklist.clone()));
        });
        let with = |blocklist: Vec<String>| ComputerToolsConfig {
            enabled: true,
            blocklist,
            ..Default::default()
        };
        cfg.set(with(vec!["com.example.vault".into()])).await;
        assert_eq!(seen.lock().unwrap().len(), 1);
        cfg.set(with(vec![])).await;
        assert_eq!(
            *seen.lock().unwrap(),
            vec![
                (vec![], vec!["com.example.vault".to_string()]),
                (vec!["com.example.vault".to_string()], vec![]),
            ]
        );
    }
}
