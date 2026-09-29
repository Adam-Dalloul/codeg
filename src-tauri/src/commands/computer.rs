//! Computer use on the desktop: the service that owns the helper and the
//! window table, the agent-facing reads behind the `computer_*` tools, and
//! the commands behind codeg's own Computer use panel.
//!
//! Every agent read goes through the same five steps, in this order, because
//! a read cannot be taken back:
//!
//! 1. **Switch.** The group is on (re-read now, not at injection), and the
//!    person has not pressed Stop.
//! 2. **Grant.** The window is one codeg named, it is shared, the grant has
//!    not lapsed, and its application is not (or no longer) blocklisted.
//! 3. **Identity.** The process that owned the window when it was shared is
//!    still the one running under that pid — a relaunched application is a
//!    different process whose windows nobody shared. Asked of the kernel by
//!    codeg itself (a process's start time is not TCC-governed), not of the
//!    helper.
//! 4. **Read, then check again.** The helper reads; then everything above is
//!    checked once more — the grant under the same epoch, the switch (not
//!    switched off, not even off and on again, while the read was in flight),
//!    the blocklist as it is now, and the identity — because the person may
//!    have taken the window back while the read was in flight, and the read
//!    holds exactly what they took back.
//! 5. **Audit.** Every attempt — done, refused or failed — leaves a line on
//!    the panel's activity list.
//!
//! An action goes through the same steps with one difference: it cannot be
//! withheld once done, so everything is checked before it goes out and
//! nothing after. The grant must be for control; the keys must stay inside
//! the window; every ref and point is resolved against what the agent last
//! read of the window (`targets::TargetTable::begin_act`); the helper checks
//! again at the moment of delivery what only it can see.
//!
//! **One driver call at a time, in codeg.** The driver answers one call at a
//! time anyway; the queue is kept here so that an action's checks run when its
//! turn has come, not before it waited behind a twenty-second snapshot —
//! time in which the person could have taken the window back.
//!
//! **Stop.** The person's Stop pauses everything (every call answers
//! `computer_paused` until they resume), ends every grant, and has the helper
//! kill the driver mid-action. It does not wait for the queue.
//!
//! Sharing and unsharing are Tauri commands only. There is no HTTP face for
//! them: deciding what of this screen an agent may see is for the person at
//! this screen.

use std::collections::BTreeSet;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

use crate::acp::computer_tools::{
    blocked_note, chord_beyond_note, control_required_note, cut_away_note, grant_required_note,
    no_pointing_note, no_such_ref_note, no_such_target_note, not_actionable_note,
    permission_missing_note, stale_capture_note, stale_snapshot_note, ComputerActOutcome,
    ComputerAppsOutcome, ComputerCaptureOutcome, ComputerSnapshotOutcome, ComputerToolAccess,
    ComputerToolsConfig, ComputerToolsRuntimeConfig, ComputerVerifyOutcome, ComputerWindowsOutcome,
    SnapshotRequest, DEFAULT_MAX_DIMENSION, DEFAULT_SNAPSHOT_MAX_CHARS, ERROR_ACTION_FAILED,
    ERROR_BACKGROUND_UNAVAILABLE, ERROR_BLOCKED, ERROR_CONTROL_REQUIRED, ERROR_GRANT_REQUIRED,
    ERROR_NO_SUCH_TARGET, ERROR_OCCLUDED, ERROR_OUT_OF_TARGET, ERROR_PAUSED,
    ERROR_PERMISSION_MISSING, ERROR_READ_FAILED, ERROR_STALE_REF, ERROR_UNAVAILABLE,
    NEEDS_ELEMENT_NOTE, NO_DESKTOP_NOTE, OUT_OF_IMAGE_NOTE, PASTE_NOTE, SECRET_FIELD_NOTE,
    STOPPED_NOTE,
};
use crate::app_error::AppCommandError;
use crate::computer::agent::{
    grantable, visible_title, ActivityOutcome, Blocklist, ComputerAction, ComputerActivityPayload,
    ComputerGrantPayload, GrantChange, GrantLevel, NotGrantable, SelfIdentity,
};
use crate::computer::backend::{
    ActRefusal, BackendError, BackendStatus, ComputerBackend, SnapshotOptions,
};
use crate::computer::driver_admin::{DriverAdmin, DriverInfo, DriverTask};
use crate::computer::events;
use crate::computer::indicator::{Indicator, Strip};
use crate::computer::local::LocalBackend;
use crate::computer::marker::Marker;
use crate::computer::procinfo::process_start;
use crate::computer::protocol::{OsPermission, PermissionReport, RawAct};
use crate::computer::stop_key::{StopKey, StopKeyStatus};
use crate::computer::targets::{
    ActDenied, Aim, ReadMark, ReadRefusal, ReadTicket, ShareError, SharedWindow, Staleness,
    TargetTable, WindowIdentity,
};
use crate::computer::types::{
    ActDelivery, ActReport, AgentAppRef, AgentAppSummary, ComputerActRequest, Rect,
    VerifyOutcome, VerifyRequest, WindowCapture, WindowSnapshot, MAX_KEY_REPEAT,
};

/// How often lapsed grants are swept, so the panel shows a window as no
/// longer shared when its time runs out rather than at the next read.
const EXPIRY_SWEEP: Duration = Duration::from_secs(30);

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| i64::try_from(d.as_millis()).unwrap_or(i64::MAX))
        .unwrap_or(0)
}

/// What codeg knows about its own TCC standing (macOS only). Shown to the
/// person, never acted on: a permission codeg itself holds is one every
/// agent's shell holds too, outside anything computer use decides — refusing
/// to run would not take it back.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CodegTccStatus {
    pub accessibility: bool,
    pub screen_recording: bool,
    /// Whether codeg is its own responsible process. When it is not (a
    /// development build run from a terminal), the two flags above are the
    /// terminal's, which every process in that terminal already has.
    pub self_responsible: bool,
}

impl CodegTccStatus {
    /// codeg itself has been granted a permission that every agent's shell
    /// inherits.
    pub fn is_leaking(&self) -> bool {
        self.self_responsible && (self.accessibility || self.screen_recording)
    }
}

#[cfg(target_os = "macos")]
fn codeg_tcc() -> Option<CodegTccStatus> {
    use crate::computer::tcc;
    let me = std::process::id();
    Some(CodegTccStatus {
        accessibility: tcc::accessibility_granted(),
        screen_recording: tcc::screen_recording_granted(),
        self_responsible: tcc::responsible_pid(me) == Some(me),
    })
}

#[cfg(not(target_os = "macos"))]
fn codeg_tcc() -> Option<CodegTccStatus> {
    None
}

/// Cut `tree` to at most `max_chars` characters, on a line boundary. `0` is
/// no cap. Returns the tree and whether anything was cut.
fn cut_tree(tree: &str, max_chars: usize) -> (String, bool) {
    if max_chars == 0 || tree.chars().count() <= max_chars {
        return (tree.to_string(), false);
    }
    let mut out = String::new();
    let mut used = 0usize;
    for line in tree.split_inclusive('\n') {
        let len = line.chars().count();
        if used + len > max_chars {
            break;
        }
        out.push_str(line);
        used += len;
    }
    (out, true)
}

/// A refusal before or during a read, as the slug and the words.
struct Refusal {
    slug: &'static str,
    note: String,
    /// What the activity line records.
    outcome: ActivityOutcome,
    /// An action that failed after it was sent: it may have happened.
    maybe_done: bool,
}

impl Refusal {
    fn refused(slug: &'static str, note: String) -> Self {
        Self {
            slug,
            note,
            outcome: ActivityOutcome::Refused,
            maybe_done: false,
        }
    }

    fn failed(slug: &'static str, note: String) -> Self {
        Self {
            slug,
            note,
            outcome: ActivityOutcome::Failed,
            maybe_done: false,
        }
    }

    fn maybe_done(self) -> Self {
        Self {
            maybe_done: true,
            ..self
        }
    }
}

/// An action the helper refused, or that did not happen, in the helper's
/// words (which say what to do next).
fn refused_act(kind: ActRefusal, words: String) -> Refusal {
    match kind {
        ActRefusal::Paused => Refusal::refused(
            ERROR_PAUSED,
            format!("{words} Nothing reaches any window until then; try again later."),
        ),
        ActRefusal::StaleRef => Refusal::failed(ERROR_STALE_REF, words),
        ActRefusal::OutOfTarget => Refusal::failed(ERROR_OUT_OF_TARGET, words),
        ActRefusal::Occluded => Refusal::failed(ERROR_OCCLUDED, words),
        ActRefusal::BackgroundUnavailable => Refusal::failed(ERROR_BACKGROUND_UNAVAILABLE, words),
        ActRefusal::SecretField => Refusal::refused(ERROR_BLOCKED, words),
        ActRefusal::Failed => Refusal::failed(ERROR_ACTION_FAILED, words),
    }
}

/// An action refused before anything was sent, in words.
fn denied(target_id: &str, why: ActDenied) -> Refusal {
    match why {
        ActDenied::NoSuchTarget => {
            Refusal::refused(ERROR_NO_SUCH_TARGET, no_such_target_note(target_id))
        }
        ActDenied::GrantRequired => {
            Refusal::refused(ERROR_GRANT_REQUIRED, grant_required_note(target_id))
        }
        ActDenied::ControlRequired => {
            Refusal::refused(ERROR_CONTROL_REQUIRED, control_required_note(target_id))
        }
        ActDenied::NotGrantable(why) => {
            Refusal::refused(ERROR_BLOCKED, blocked_note(target_id, why.note()))
        }
        ActDenied::Stale(staleness) => Refusal::failed(
            ERROR_STALE_REF,
            match staleness {
                Staleness::NoSnapshot | Staleness::OldSnapshot => stale_snapshot_note(target_id),
                Staleness::NotActionable => not_actionable_note(target_id),
                Staleness::CutAway(index) => cut_away_note(index),
                Staleness::NoSuchRef(index) => no_such_ref_note(target_id, index),
                Staleness::NoCapture | Staleness::OldCapture => stale_capture_note(target_id),
            },
        ),
        ActDenied::OutOfImage => Refusal::failed(ERROR_OUT_OF_TARGET, OUT_OF_IMAGE_NOTE.into()),
        ActDenied::Secret => Refusal::refused(ERROR_BLOCKED, SECRET_FIELD_NOTE.into()),
        ActDenied::ChordBeyond => Refusal::refused(ERROR_CONTROL_REQUIRED, chord_beyond_note()),
        // The source of what is on the clipboard is what a paste would need
        // a grant for; codeg does not know it.
        ActDenied::Paste => Refusal::refused(ERROR_GRANT_REQUIRED, PASTE_NOTE.into()),
        ActDenied::NeedsElement => Refusal::failed(ERROR_ACTION_FAILED, NEEDS_ELEMENT_NOTE.into()),
        ActDenied::NoPointing => Refusal::failed(ERROR_ACTION_FAILED, no_pointing_note(target_id)),
    }
}

fn permission_name(permission: OsPermission) -> &'static str {
    match permission {
        OsPermission::Accessibility => "Accessibility",
        OsPermission::ScreenRecording => "Screen Recording",
    }
}

/// What a share is decided by: see `ComputerService::policy`.
struct SharingPolicy {
    enabled: bool,
    blocklist: Blocklist,
}

impl SharingPolicy {
    fn of(config: &ComputerToolsConfig) -> Self {
        Self {
            enabled: config.enabled,
            blocklist: Blocklist::new(&config.blocklist),
        }
    }
}

/// A read that passed steps 1–3, and what step 4 checks it against.
struct Admitted {
    ticket: ReadTicket,
    /// The switch-off count when the read was admitted.
    switched_off: u64,
}

/// The desktop's computer-use service. One per app, managed as Tauri state.
pub struct ComputerService {
    app: AppHandle,
    backend: Arc<LocalBackend>,
    targets: TargetTable,
    config: ComputerToolsRuntimeConfig,
    me: SelfIdentity,
    /// Held for every call that reaches the driver. See the module note.
    turn: tokio::sync::Mutex<()>,
    /// The person pressed Stop and has not resumed.
    paused: AtomicBool,
    /// Held while the helper is told of a Stop or a Resume, so it hears them
    /// in the order the person pressed them — a Resume overtaking the Stop
    /// before it would leave the helper stopped under a panel that says it
    /// is not.
    pausing: tokio::sync::Mutex<()>,
    /// Moved by every Stop: a Resume that was already on its way when a Stop
    /// came does not undo it.
    stops: AtomicU64,
    /// Held across "is it stopped?" and the share that follows, across a
    /// Stop's "stopped" and the revocation that follows, and across a
    /// Resume's "no Stop since?" and its "not stopped" — so a share cannot
    /// slip in between a Stop and its revocation and outlive it, and a Stop
    /// cannot slip in between a Resume's check and its write and be undone.
    /// The same holds for a settings change and what it takes away: see
    /// `policy`.
    grant_gate: std::sync::Mutex<()>,
    /// The switch and the blocklist as the last settings change left them,
    /// written under `grant_gate` by the change hook, which revokes under it
    /// too. A share decides by these, under the same lock: it lands either
    /// before a switch-off (and is revoked with the rest) or after it (and is
    /// refused) — never after the revocation and still standing.
    policy: std::sync::Mutex<SharingPolicy>,
    /// The stop shortcut, held with the OS while computer use is on.
    stop_key: StopKey,
    /// The strip above every window while anything is shared.
    indicator: Indicator,
    /// The mark an action leaves where it landed.
    marker: Marker,
    /// Held across reading the state and telling everyone of it, so two
    /// changes told at once are told in the order they were read — the
    /// older never lands last.
    state_gate: std::sync::Mutex<()>,
    /// The driver as Settings manages it.
    drivers: Arc<DriverAdmin>,
}

impl ComputerService {
    /// Build the service and start its duties: following the settings
    /// (switching off ends every grant and stops the helper; a longer
    /// blocklist or a shorter timeout ends what they now forbid), and ending
    /// grants whose time runs out.
    pub fn start(app: AppHandle, config: ComputerToolsRuntimeConfig) -> Arc<Self> {
        let status_app = app.clone();
        let drivers = Arc::new(DriverAdmin::new(app.clone()));
        let status_drivers = drivers.clone();
        let backend = Arc::new(
            LocalBackend::new(move |status: &BackendStatus| {
                events::emit_backend_status(&status_app, status);
                status_drivers.backend_moved(status);
            })
            .with_switch(config.clone()),
        );
        let indicator = Indicator::start(app.clone());
        let marker = Marker::start(app.clone());
        let policy = SharingPolicy::of(&config.subscribe().borrow());
        let service = Arc::new(Self {
            app,
            backend,
            targets: TargetTable::new(),
            config: config.clone(),
            me: SelfIdentity::current(),
            turn: tokio::sync::Mutex::new(()),
            paused: AtomicBool::new(false),
            pausing: tokio::sync::Mutex::new(()),
            stops: AtomicU64::new(0),
            grant_gate: std::sync::Mutex::new(()),
            policy: std::sync::Mutex::new(policy),
            stop_key: StopKey::new(),
            indicator,
            marker,
            state_gate: std::sync::Mutex::new(()),
            drivers,
        });

        // What a change takes away is taken before the write that made it
        // returns (see `ComputerToolsRuntimeConfig::on_change`).
        let hook = Arc::downgrade(&service);
        config.on_change(move |before, after| {
            if let Some(service) = hook.upgrade() {
                service.policy_changed(before, after);
            }
        });

        let watcher = Arc::downgrade(&service);
        let mut changes = config.subscribe();
        tauri::async_runtime::spawn(async move {
            // The settings as they stand, then every change to them. A watch
            // channel keeps only the latest value, so an off-and-on-again is
            // told apart by the switch-off count, not by `enabled`.
            let mut seen = changes.borrow_and_update().clone();
            if let Some(service) = watcher.upgrade() {
                service.follow(&seen, false).await;
            }
            while changes.changed().await.is_ok() {
                let next = changes.borrow_and_update().clone();
                let Some(service) = watcher.upgrade() else {
                    break;
                };
                service
                    .follow(&next, next.switched_off != seen.switched_off)
                    .await;
                seen = next;
            }
        });

        let sweeper = Arc::downgrade(&service);
        tauri::async_runtime::spawn(async move {
            let mut tick = tokio::time::interval(EXPIRY_SWEEP);
            loop {
                tick.tick().await;
                let Some(service) = sweeper.upgrade() else {
                    break;
                };
                service.sweep().await;
            }
        });
        service
    }

    /// The settings just changed, from `before` to `after`: end the grants
    /// the change takes away. Runs inside the write, once per change, so an
    /// entry added to the blocklist and taken off again straight after still
    /// ended the grants it named, and no read admitted after the write can
    /// use a grant the write ended.
    fn policy_changed(&self, before: &ComputerToolsConfig, after: &ComputerToolsConfig) {
        let ended = {
            let _gate = self.grant_gate.lock().unwrap_or_else(|p| p.into_inner());
            *self.policy.lock().unwrap_or_else(|p| p.into_inner()) = SharingPolicy::of(after);
            if before.enabled && !after.enabled {
                self.targets.revoke_all(GrantChange::Disabled)
            } else {
                self.targets.sweep(
                    now_ms(),
                    after.grant_ttl,
                    &self.me,
                    &Blocklist::new(&after.blocklist),
                )
            }
        };
        self.announce(&ended);
    }

    /// Bring the helper and the stop shortcut in line with `config`.
    /// `went_off`: the switch was off at some point since the last call, even
    /// if it is on again now — the helper (and the driver under it) stops,
    /// and is not started again while the switch is off.
    async fn follow(self: &Arc<Self>, config: &ComputerToolsConfig, went_off: bool) {
        self.follow_stop_key(config);
        if went_off || !config.enabled {
            self.backend.close().await;
        }
        if config.enabled {
            self.backend.open().await;
        }
    }

    /// Hold the chosen stop shortcut with the OS while computer use is on —
    /// off, there is nothing for it to stop, and it would only take the keys
    /// from every other application.
    fn follow_stop_key(self: &Arc<Self>, config: &ComputerToolsConfig) {
        let wanted = config
            .enabled
            .then_some(config.stop_shortcut.as_ref())
            .flatten();
        let service = Arc::downgrade(self);
        let on_press = move || {
            if let Some(service) = service.upgrade() {
                tauri::async_runtime::spawn(async move { service.stop().await });
            }
        };
        if let Some(status) = self.stop_key.sync(&self.app, wanted, on_press) {
            events::emit_stop_key(&self.app, &status);
        }
    }

    pub fn stop_key_status(&self) -> StopKeyStatus {
        self.stop_key.status()
    }

    /// End the grants the settings as they are now no longer allow: lapsed,
    /// or on an application that has joined the blocklist.
    async fn sweep(&self) {
        let config = self.config.snapshot().await;
        let ended = self.targets.sweep(
            now_ms(),
            config.grant_ttl,
            &self.me,
            &Blocklist::new(&config.blocklist),
        );
        self.announce(&ended);
    }

    /// Tell the panel about grant changes: each transition, then the state.
    fn announce(&self, changes: &[ComputerGrantPayload]) {
        if changes.is_empty() {
            return;
        }
        for change in changes {
            events::emit_grant(&self.app, change);
        }
        self.emit_state();
    }

    /// Tell the panels, and bring the strip and the marker in line: the
    /// strip is up while anything is shared (and a moment after a Stop), the
    /// marker ready while anything is shared for control.
    fn emit_state(&self) {
        let _told = self.state_gate.lock().unwrap_or_else(|p| p.into_inner());
        let shared = self.targets.shared();
        let paused = self.paused.load(Ordering::Acquire);
        events::emit_state(&self.app, &shared, paused);
        self.indicator.set(Strip::of(!shared.is_empty(), paused));
        self.marker
            .arm(shared.iter().any(|w| w.level == GrantLevel::Control));
    }

    /// The person pressed Stop: from now on every call is refused, every
    /// grant ends, and the helper kills the driver — mid-action if it is in
    /// one. In that order, so that nothing admitted after this call can go
    /// out, and nothing already out outlives the driver.
    pub async fn stop(&self) {
        // Refused and ended at once, before anything is waited on.
        let ended = {
            let _gate = self.grant_gate.lock().unwrap_or_else(|p| p.into_inner());
            self.stops.fetch_add(1, Ordering::AcqRel);
            self.paused.store(true, Ordering::Release);
            self.targets.revoke_all(GrantChange::Stopped)
        };
        for change in &ended {
            events::emit_grant(&self.app, change);
        }
        self.emit_state();
        let _order = self.pausing.lock().await;
        // A Resume pressed after this Stop, and heard first, has already put
        // things back; stopping the helper now would leave it stopped under
        // a panel that says it is not.
        if !self.paused.load(Ordering::Acquire) {
            return;
        }
        if let Err(e) = self.backend.halt().await {
            tracing::warn!("[computer] the helper did not confirm the stop: {e}");
        }
    }

    /// Share a window, unless computer use is off or a Stop is in force —
    /// decided under the same lock a Stop and a settings change take to
    /// revoke, so no share lands between either and its revocation.
    fn share_unless_stopped(
        &self,
        target_id: &str,
        level: GrantLevel,
    ) -> Result<Option<ComputerGrantPayload>, AppCommandError> {
        let _gate = self.grant_gate.lock().unwrap_or_else(|p| p.into_inner());
        let policy = self.policy.lock().unwrap_or_else(|p| p.into_inner());
        if level != GrantLevel::None {
            if !policy.enabled {
                return Err(AppCommandError::configuration_invalid(
                    "computer use is switched off",
                ));
            }
            if self.paused.load(Ordering::Acquire) {
                return Err(AppCommandError::configuration_invalid(
                    "computer use is stopped; resume it first",
                ));
            }
        }
        match self
            .targets
            .share(target_id, level, now_ms(), &self.me, &policy.blocklist)
        {
            Ok(change) => Ok(change),
            Err(ShareError::NoSuchTarget) | Err(ShareError::Gone) => Err(
                AppCommandError::configuration_invalid("that window is gone; open the list again"),
            ),
            Err(ShareError::NotGrantable(why)) => {
                Err(AppCommandError::configuration_invalid(why.note()))
            }
        }
    }

    /// Whether anything may be shared at all right now: computer use on, and
    /// no Stop in force.
    fn sharing_open(&self) -> bool {
        let _gate = self.grant_gate.lock().unwrap_or_else(|p| p.into_inner());
        self.policy
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .enabled
            && !self.paused.load(Ordering::Acquire)
    }

    /// Remove cua-driver, as the person asked from Settings: switch computer
    /// use off — through the settings writer, so every panel hears of it —
    /// then kill the driver (mid-call if it is in one) and stop the helper
    /// now, rather than whenever the switch is followed, before the files go.
    /// No helper starts again meanwhile: the backend asks the switch itself
    /// before starting one. Then every cached release, and the homes dead
    /// drivers left behind. Switching back on fetches the pinned release
    /// again.
    async fn uninstall_driver(
        &self,
        conn: &sea_orm::DatabaseConnection,
    ) -> Result<DriverInfo, AppCommandError> {
        self.drivers
            .begin(DriverTask::Uninstalling)
            .map_err(AppCommandError::configuration_invalid)?;
        let result = async {
            if self.config.snapshot().await.enabled {
                crate::commands::computer_tools::set_computer_tools_enabled_core(
                    conn,
                    &self.config,
                    &crate::web::event_bridge::EventEmitter::Tauri(self.app.clone()),
                    false,
                )
                .await
                .map_err(|e| e.to_string())?;
            }
            self.backend.close_now().await;
            crate::computer::driver::forget_cached_driver()
                .await
                .map_err(|e| e.to_string())?;
            crate::computer::helper::driver_proc::sweep_dead_runs();
            Ok::<(), String>(())
        }
        .await;
        self.drivers.finish(result.as_ref().err().cloned());
        result
            .map(|()| self.drivers.info())
            .map_err(AppCommandError::configuration_invalid)
    }

    /// The person resumed. No grant comes back: what they stopped sharing
    /// they share again, window by window.
    pub async fn resume(&self) {
        let stops = self.stops.load(Ordering::Acquire);
        let _order = self.pausing.lock().await;
        if let Err(e) = self.backend.resume().await {
            tracing::warn!("[computer] the helper did not confirm the resume: {e}");
        }
        // A Stop pressed while this was on its way stands — decided under the
        // lock a Stop takes to set `paused`, so none lands between the check
        // and the write and is undone by it.
        {
            let _gate = self.grant_gate.lock().unwrap_or_else(|p| p.into_inner());
            if self.stops.load(Ordering::Acquire) == stops {
                self.paused.store(false, Ordering::Release);
            }
        }
        self.emit_state();
    }

    fn record(&self, target_id: &str, action: ComputerAction, outcome: ActivityOutcome) {
        events::emit_activity(
            &self.app,
            &ComputerActivityPayload {
                target_id: target_id.to_string(),
                action,
                outcome,
                at: now_ms(),
            },
        );
    }

    /// Step 1: the switch, re-read now, and the person's Stop.
    async fn usable(&self) -> Result<ComputerToolsConfig, Refusal> {
        if self.paused.load(Ordering::Acquire) {
            return Err(Refusal::refused(ERROR_PAUSED, STOPPED_NOTE.to_string()));
        }
        let config = self.config.snapshot().await;
        if !config.enabled {
            return Err(Refusal::refused(
                ERROR_UNAVAILABLE,
                NO_DESKTOP_NOTE.to_string(),
            ));
        }
        Ok(config)
    }

    fn backend_refusal(&self, target_id: Option<&str>, e: BackendError) -> Refusal {
        match e {
            BackendError::PermissionMissing(p) => Refusal::failed(
                ERROR_PERMISSION_MISSING,
                permission_missing_note(permission_name(p)),
            ),
            BackendError::NoSuchWindow => {
                if let Some(id) = target_id {
                    let ended: Vec<_> = self.targets.target_changed(id).into_iter().collect();
                    self.announce(&ended);
                    Refusal::failed(ERROR_GRANT_REQUIRED, grant_required_note(id))
                } else {
                    Refusal::failed(ERROR_READ_FAILED, "The window is gone.".to_string())
                }
            }
            BackendError::Unavailable(why) | BackendError::Rejected(why) => Refusal::failed(
                ERROR_UNAVAILABLE,
                format!(
                    "Computer use cannot run right now: {why}. It may be worth trying again later."
                ),
            ),
            BackendError::Failed(why) => Refusal::failed(
                ERROR_READ_FAILED,
                format!("The window could not be read: {why}. It may be worth trying again."),
            ),
            BackendError::Refused(kind, words) => refused_act(kind, words),
        }
    }

    /// A backend error on an action. What differs from a read: an action
    /// that failed or lost its helper on the way may have happened anyway,
    /// and the words say so; and a helper that went away because the person
    /// pressed Stop is reported as the Stop.
    fn backend_act_refusal(&self, target_id: &str, e: BackendError) -> Refusal {
        match e {
            BackendError::Unavailable(_) if self.paused.load(Ordering::Acquire) => {
                Refusal::refused(
                    ERROR_PAUSED,
                    format!(
                        "The user pressed Stop while this action was on its way: it may or may \
                         not have happened. {STOPPED_NOTE}"
                    ),
                )
                .maybe_done()
            }
            BackendError::Unavailable(why) => Refusal::failed(
                ERROR_UNAVAILABLE,
                format!(
                    "Computer use stopped working during the action ({why}); it may or may not \
                     have happened. Read the window again before going on."
                ),
            )
            .maybe_done(),
            BackendError::Failed(why) => Refusal::failed(
                ERROR_ACTION_FAILED,
                format!(
                    "The action did not complete ({why}); it may or may not have happened. Read \
                     the window again before going on."
                ),
            )
            .maybe_done(),
            other => self.backend_refusal(Some(target_id), other),
        }
    }

    /// Steps 1–3: everything that has to hold before the helper is asked.
    async fn begin(&self, target_id: &str) -> Result<Admitted, Refusal> {
        let config = self.usable().await?;
        let blocklist = Blocklist::new(&config.blocklist);
        let ticket = match self.targets.begin_read(
            target_id,
            now_ms(),
            config.grant_ttl,
            &self.me,
            &blocklist,
        ) {
            Ok(ticket) => ticket,
            Err((why, ended)) => {
                self.announce(&ended.into_iter().collect::<Vec<_>>());
                return Err(match why {
                    ReadRefusal::NoSuchTarget => {
                        Refusal::refused(ERROR_NO_SUCH_TARGET, no_such_target_note(target_id))
                    }
                    ReadRefusal::GrantRequired => {
                        Refusal::refused(ERROR_GRANT_REQUIRED, grant_required_note(target_id))
                    }
                    ReadRefusal::NotGrantable(why) => {
                        Refusal::refused(ERROR_BLOCKED, blocked_note(target_id, why.note()))
                    }
                });
            }
        };
        self.check_identity(&ticket.target_id, &ticket.identity)?;
        Ok(Admitted {
            ticket,
            switched_off: config.switched_off,
        })
    }

    /// Step 3. A pid that no longer answers with the start time it had when
    /// the window was shared is a different process. A window without a start
    /// time cannot have been shared at all (`NotGrantable::Unidentified`).
    /// Returns the start time the grant is held against.
    fn check_identity(&self, target_id: &str, identity: &WindowIdentity) -> Result<u64, Refusal> {
        let Some(started_at) = identity.started_at else {
            return Err(Refusal::refused(
                ERROR_BLOCKED,
                blocked_note(target_id, NotGrantable::Unidentified.note()),
            ));
        };
        if process_start(identity.pid) != Some(started_at) {
            let ended: Vec<_> = self.targets.target_changed(target_id).into_iter().collect();
            self.announce(&ended);
            return Err(Refusal::failed(
                ERROR_GRANT_REQUIRED,
                grant_required_note(target_id),
            ));
        }
        Ok(started_at)
    }

    /// Step 4's second half: steps 1–3 again, against what the read began
    /// under. `mark` is what the read leaves for later actions.
    async fn finish(&self, admitted: &Admitted, mark: Option<ReadMark>) -> Result<String, Refusal> {
        let ticket = &admitted.ticket;
        let refused =
            || Refusal::refused(ERROR_GRANT_REQUIRED, grant_required_note(&ticket.target_id));
        let config = self.usable().await?;
        if config.switched_off != admitted.switched_off {
            return Err(refused());
        }
        // Whatever process holds the pid now is the one the helper just read:
        // if it is not the one the window was shared from, neither is what
        // was read.
        self.check_identity(&ticket.target_id, &ticket.identity)?;
        let blocklist = Blocklist::new(&config.blocklist);
        match self.targets.finish_read(ticket, &self.me, &blocklist, mark) {
            Ok(generation) => Ok(generation),
            Err((why, ended)) => {
                self.announce(&ended.into_iter().collect::<Vec<_>>());
                Err(match why {
                    ReadRefusal::NotGrantable(why) => Refusal::refused(
                        ERROR_BLOCKED,
                        blocked_note(&ticket.target_id, why.note()),
                    ),
                    ReadRefusal::NoSuchTarget | ReadRefusal::GrantRequired => refused(),
                })
            }
        }
    }

    /// The window's title as the agent may see it now.
    fn title_for(&self, target_id: &str, raw: Option<String>) -> Option<String> {
        let entry = self.targets.get(target_id)?;
        let level = entry.grant.as_ref().map_or(GrantLevel::None, |g| g.level);
        let title = raw.filter(|t| !t.is_empty()).unwrap_or(entry.title);
        visible_title(level, &title)
    }

    pub async fn agent_list_apps(&self) -> ComputerAppsOutcome {
        let _turn = self.turn.lock().await;
        let config = match self.usable().await {
            Ok(config) => config,
            Err(r) => return ComputerAppsOutcome::refused(r.slug, r.note),
        };
        let blocklist = Blocklist::new(&config.blocklist);
        let listed = self.backend.list_apps().await;
        // A Stop that came while the helper was listing refuses this too.
        if self.paused.load(Ordering::Acquire) {
            return ComputerAppsOutcome::refused(ERROR_PAUSED, STOPPED_NOTE);
        }
        match listed {
            Ok(apps) => ComputerAppsOutcome {
                apps: apps
                    .into_iter()
                    .map(|app| AgentAppSummary {
                        note: grantable(&app, &self.me, &blocklist)
                            .err()
                            .map(|why| why.note().to_string()),
                        app: AgentAppRef {
                            key: app.key().unwrap_or_default().to_string(),
                            name: app.name.clone(),
                            pid: app.pid,
                        },
                        active: app.active,
                    })
                    .collect(),
                error: None,
                note: None,
            },
            Err(e) => {
                let r = self.backend_refusal(None, e);
                ComputerAppsOutcome::refused(r.slug, r.note)
            }
        }
    }

    pub async fn agent_list_windows(&self, pid: Option<u32>) -> ComputerWindowsOutcome {
        let _turn = self.turn.lock().await;
        let config = match self.usable().await {
            Ok(config) => config,
            Err(r) => return ComputerWindowsOutcome::refused(r.slug, r.note),
        };
        let blocklist = Blocklist::new(&config.blocklist);
        let listed = self.backend.list_windows(pid).await;
        // Grants that have already ended by the rules as they are now must
        // not show — neither as a level nor as a title.
        self.sweep().await;
        // A Stop that came while the helper was listing, or since, refuses
        // this too; nothing below waits on anything.
        if self.paused.load(Ordering::Acquire) {
            return ComputerWindowsOutcome::refused(ERROR_PAUSED, STOPPED_NOTE);
        }
        match listed {
            Ok(windows) => {
                let (entries, ended) = self.targets.observe(&windows, pid);
                self.announce(&ended);
                ComputerWindowsOutcome {
                    windows: entries
                        .iter()
                        .filter(|e| e.worth_listing())
                        .map(|e| e.agent_summary(&self.me, &blocklist))
                        .collect(),
                    error: None,
                    note: None,
                }
            }
            Err(e) => {
                let r = self.backend_refusal(None, e);
                ComputerWindowsOutcome::refused(r.slug, r.note)
            }
        }
    }

    async fn capture_inner(
        &self,
        target_id: &str,
        max_dimension: Option<u32>,
    ) -> Result<WindowCapture, Refusal> {
        let _turn = self.turn.lock().await;
        let admitted = self.begin(target_id).await?;
        let ticket = &admitted.ticket;
        let max = max_dimension
            .unwrap_or(DEFAULT_MAX_DIMENSION)
            .clamp(1, DEFAULT_MAX_DIMENSION);
        let raw = self
            .backend
            .capture(ticket.identity.pid, ticket.identity.window_id, Some(max))
            .await
            .map_err(|e| self.backend_refusal(Some(target_id), e))?;
        let window_bounds = if raw.window_bounds.is_empty() {
            ticket.bounds
        } else {
            raw.window_bounds
        };
        let mark = ReadMark::Capture {
            width: raw.width,
            height: raw.height,
            native_width: raw.native_width,
            native_height: raw.native_height,
            // Only the helper's own measure of the window says whether the
            // capture is its full size; bounds codeg fills in from the
            // listing are not that.
            full_size: raw.full_size && !raw.window_bounds.is_empty(),
            window_bounds: raw.window_bounds,
        };
        let generation = self.finish(&admitted, Some(mark)).await?;
        Ok(WindowCapture {
            target_id: target_id.to_string(),
            generation,
            mime: "image/png".to_string(),
            data: raw.png_base64,
            width: raw.width,
            height: raw.height,
            window_bounds,
            title: self.title_for(target_id, raw.title),
        })
    }

    pub async fn agent_capture(
        &self,
        target_id: &str,
        max_dimension: Option<u32>,
    ) -> ComputerCaptureOutcome {
        match self.capture_inner(target_id, max_dimension).await {
            Ok(capture) => {
                self.record(target_id, ComputerAction::Capture, ActivityOutcome::Done);
                ComputerCaptureOutcome::image(target_id, capture)
            }
            Err(r) => {
                self.record(target_id, ComputerAction::Capture, r.outcome);
                ComputerCaptureOutcome::refused(target_id, r.slug, r.note)
            }
        }
    }

    async fn snapshot_inner(
        &self,
        target_id: &str,
        request: SnapshotRequest,
    ) -> Result<WindowSnapshot, Refusal> {
        let _turn = self.turn.lock().await;
        let admitted = self.begin(target_id).await?;
        let ticket = &admitted.ticket;
        let raw = self
            .backend
            .snapshot(
                ticket.identity.pid,
                ticket.identity.window_id,
                SnapshotOptions {
                    max_depth: request.max_depth,
                    max_elements: request.max_elements,
                    query: request.query,
                },
            )
            .await
            .map_err(|e| self.backend_refusal(Some(target_id), e))?;
        let (tree, cut) = cut_tree(
            &raw.tree,
            request.max_chars.unwrap_or(DEFAULT_SNAPSHOT_MAX_CHARS),
        );
        // A ref is usable when its line is in what the agent is given: the
        // tree is cut between lines, so a line that starts before the cut
        // is there.
        let kept = tree.len();
        let mut mark_shown = BTreeSet::new();
        let mut mark_cut = BTreeSet::new();
        let mut mark_secret = BTreeSet::new();
        for r in &raw.refs {
            if (r.offset as usize) < kept {
                mark_shown.insert(r.index);
            } else {
                mark_cut.insert(r.index);
            }
            if r.secret {
                mark_secret.insert(r.index);
            }
        }
        let mark = ReadMark::Snapshot {
            snapshot_id: raw.snapshot_id.clone(),
            shown: mark_shown,
            cut: mark_cut,
            secret: mark_secret,
        };
        let generation = self.finish(&admitted, Some(mark)).await?;
        Ok(WindowSnapshot {
            target_id: target_id.to_string(),
            generation,
            title: self.title_for(target_id, raw.title),
            window_bounds: raw.window_bounds.filter(|b: &Rect| !b.is_empty()),
            tree,
            element_count: raw.element_count,
            truncated: cut || raw.truncated,
            degraded: raw.degraded,
        })
    }

    pub async fn agent_snapshot(
        &self,
        target_id: &str,
        request: SnapshotRequest,
    ) -> ComputerSnapshotOutcome {
        match self.snapshot_inner(target_id, request).await {
            Ok(snapshot) => {
                self.record(target_id, ComputerAction::Snapshot, ActivityOutcome::Done);
                ComputerSnapshotOutcome::tree(target_id, snapshot)
            }
            Err(r) => {
                self.record(target_id, ComputerAction::Snapshot, r.outcome);
                ComputerSnapshotOutcome::refused(target_id, r.slug, r.note)
            }
        }
    }

    async fn verify_inner(
        &self,
        target_id: &str,
        request: VerifyRequest,
    ) -> Result<VerifyOutcome, Refusal> {
        let _turn = self.turn.lock().await;
        let admitted = self.begin(target_id).await?;
        let ticket = &admitted.ticket;
        let raw = self
            .backend
            .verify(ticket.identity.pid, ticket.identity.window_id, request)
            .await
            .map_err(|e| self.backend_refusal(Some(target_id), e))?;
        self.finish(&admitted, None).await?;
        Ok(VerifyOutcome {
            target_id: target_id.to_string(),
            status: raw.status,
            stable: raw.stable,
            samples: raw.samples,
            elapsed_ms: raw.elapsed_ms,
            predicates: raw.predicates,
        })
    }

    pub async fn agent_verify(
        &self,
        target_id: &str,
        request: VerifyRequest,
    ) -> ComputerVerifyOutcome {
        match self.verify_inner(target_id, request).await {
            Ok(verify) => {
                self.record(target_id, ComputerAction::Verify, ActivityOutcome::Done);
                ComputerVerifyOutcome::verdict(target_id, verify)
            }
            Err(r) => {
                self.record(target_id, ComputerAction::Verify, r.outcome);
                ComputerVerifyOutcome::refused(target_id, r.slug, r.note)
            }
        }
    }

    /// One action, checked from the top: its turn at the driver first, then
    /// the switch and Stop, the grant and the action against what the agent
    /// last read, the process — and then the helper, which checks again what
    /// only it can see.
    async fn act_once(
        &self,
        target_id: &str,
        request: &ComputerActRequest,
    ) -> Result<(RawAct, Aim), Refusal> {
        let _turn = self.turn.lock().await;
        let config = self.usable().await?;
        let blocklist = Blocklist::new(&config.blocklist);
        let ticket = match self.targets.begin_act(
            target_id,
            now_ms(),
            config.grant_ttl,
            &self.me,
            &blocklist,
            request,
        ) {
            Ok(ticket) => ticket,
            Err((why, ended)) => {
                self.announce(&ended.into_iter().collect::<Vec<_>>());
                return Err(denied(target_id, why));
            }
        };
        let started_at = self.check_identity(target_id, &ticket.identity)?;
        let aim = ticket.aim;
        self.backend
            .act(
                ticket.identity.pid,
                ticket.identity.window_id,
                started_at,
                ticket.app.key().map(str::to_string),
                ticket.action,
            )
            .await
            .map(|raw| (raw, aim))
            .map_err(|e| self.backend_act_refusal(target_id, e))
    }

    /// Act on a window shared for control. A key pressed more than once is
    /// that many actions, each checked on its own: taking the window back
    /// between two presses stops the rest.
    pub async fn agent_act(
        &self,
        target_id: &str,
        request: ComputerActRequest,
    ) -> ComputerActOutcome {
        let action = ComputerAction::of(&request);
        let presses = match &request {
            ComputerActRequest::Key { repeat, .. } => (*repeat).clamp(1, MAX_KEY_REPEAT),
            _ => 1,
        };
        let mut done: Option<RawAct> = None;
        for pressed in 0..presses {
            match self.act_once(target_id, &request).await {
                Ok((raw, aim)) => {
                    if let Some(at) = aim.landing(&raw) {
                        self.marker.mark(at, action);
                    }
                    done = Some(raw);
                }
                Err(r) => {
                    self.record(target_id, action, r.outcome);
                    let note = match (pressed, r.maybe_done) {
                        (0, _) => r.note,
                        (_, false) => format!(
                            "The key was pressed {pressed} of {presses} times, then stopped: {}",
                            r.note
                        ),
                        (_, true) => format!(
                            "The key was pressed {pressed} of {presses} times; the press after \
                             that may or may not have gone out: {}",
                            r.note
                        ),
                    };
                    return ComputerActOutcome::refused(target_id, r.slug, note);
                }
            }
        }
        self.record(target_id, action, ActivityOutcome::Done);
        let Some(raw) = done else {
            return ComputerActOutcome::refused(
                target_id,
                ERROR_ACTION_FAILED,
                "Nothing was done.",
            );
        };
        ComputerActOutcome::done(
            target_id,
            ActReport {
                target_id: target_id.to_string(),
                effect: raw.effect,
                route: raw.route,
                delivery: ActDelivery::Background,
                presses: (presses > 1).then_some(presses),
                submitted: raw.submitted,
            },
        )
    }
}

/// The `computer_*` tools' access impl: the service, from the listener.
pub struct McpComputerTools {
    service: Arc<ComputerService>,
}

impl McpComputerTools {
    pub fn new(service: Arc<ComputerService>) -> Self {
        Self { service }
    }
}

#[async_trait::async_trait]
impl ComputerToolAccess for McpComputerTools {
    async fn list_apps(&self) -> ComputerAppsOutcome {
        self.service.agent_list_apps().await
    }

    async fn list_windows(&self, pid: Option<u32>) -> ComputerWindowsOutcome {
        self.service.agent_list_windows(pid).await
    }

    async fn capture(&self, target_id: &str, max_dimension: Option<u32>) -> ComputerCaptureOutcome {
        self.service.agent_capture(target_id, max_dimension).await
    }

    async fn snapshot(&self, target_id: &str, request: SnapshotRequest) -> ComputerSnapshotOutcome {
        self.service.agent_snapshot(target_id, request).await
    }

    async fn verify(&self, target_id: &str, request: VerifyRequest) -> ComputerVerifyOutcome {
        self.service.agent_verify(target_id, request).await
    }

    async fn act(&self, target_id: &str, request: ComputerActRequest) -> ComputerActOutcome {
        self.service.agent_act(target_id, request).await
    }
}

// -------- The person's side: codeg's Computer use panel ----------------------

/// Everything the panel shows at a glance.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ComputerStatus {
    pub enabled: bool,
    /// `macos` / `windows` / `linux`.
    pub platform: &'static str,
    /// Whether this platform's driver has passed codeg's release matrix.
    /// `false` everywhere until it has; the panel says "preview".
    pub verified_platform: bool,
    pub backend: BackendStatus,
    /// The helper's own permissions, when the helper could be asked.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub permissions: Option<PermissionReport>,
    /// codeg's own TCC standing (macOS only).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub codeg: Option<CodegTccStatus>,
    pub shared: Vec<SharedWindow>,
    /// The person pressed Stop and has not resumed.
    pub paused: bool,
}

/// One window, as the share picker shows it to the person — title and all:
/// it is their own screen.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PickerWindow {
    pub target_id: String,
    pub app_name: String,
    pub app_key: String,
    pub pid: u32,
    pub title: String,
    pub bounds: Rect,
    pub on_screen: bool,
    pub minimized: bool,
    pub level: GrantLevel,
    /// Why it can never be shared, when that is so.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub not_grantable: Option<NotGrantable>,
}

fn platform_name() -> &'static str {
    if cfg!(target_os = "macos") {
        "macos"
    } else if cfg!(windows) {
        "windows"
    } else {
        "linux"
    }
}

fn service(app: &AppHandle) -> Result<Arc<ComputerService>, AppCommandError> {
    app.try_state::<Arc<ComputerService>>()
        .map(|s| s.inner().clone())
        .ok_or_else(|| AppCommandError::configuration_invalid("computer use is not initialised"))
}

fn backend_error(e: BackendError) -> AppCommandError {
    AppCommandError::configuration_invalid(e.to_string())
}

#[tauri::command]
pub async fn computer_status(app: AppHandle) -> Result<ComputerStatus, AppCommandError> {
    let service = service(&app)?;
    let config = service.config.snapshot().await;
    // Asking for the helper's permissions starts the helper, which fetches
    // the driver on first use; only worth doing once the person has switched
    // computer use on.
    let permissions = if config.enabled {
        service.backend.permissions().await.ok()
    } else {
        None
    };
    Ok(ComputerStatus {
        enabled: config.enabled,
        platform: platform_name(),
        verified_platform: false,
        backend: service.backend.status().await,
        permissions,
        codeg: codeg_tcc(),
        shared: service.targets.shared(),
        paused: service.paused.load(Ordering::Acquire),
    })
}

/// Raise the system's request for one permission, charged to the helper.
#[tauri::command]
pub async fn computer_request_permission(
    app: AppHandle,
    permission: OsPermission,
) -> Result<PermissionReport, AppCommandError> {
    service(&app)?
        .backend
        .request_permission(permission)
        .await
        .map_err(backend_error)
}

/// Open System Settings at the pane for one permission.
#[tauri::command]
pub async fn computer_open_permission_settings(
    app: AppHandle,
    permission: OsPermission,
) -> Result<(), AppCommandError> {
    if !cfg!(target_os = "macos") {
        return Ok(());
    }
    let pane = match permission {
        OsPermission::Accessibility => "Privacy_Accessibility",
        OsPermission::ScreenRecording => "Privacy_ScreenCapture",
    };
    let url = format!("x-apple.systempreferences:com.apple.preference.security?{pane}");
    use tauri_plugin_opener::OpenerExt;
    app.opener()
        .open_url(url, None::<&str>)
        .map_err(|e| AppCommandError::configuration_invalid(e.to_string()))
}

/// Every window, for the share picker.
#[tauri::command]
pub async fn computer_list_shareable_windows(
    app: AppHandle,
) -> Result<Vec<PickerWindow>, AppCommandError> {
    let service = service(&app)?;
    let config = service.config.snapshot().await;
    if !config.enabled {
        return Ok(Vec::new());
    }
    let blocklist = Blocklist::new(&config.blocklist);
    let _turn = service.turn.lock().await;
    let windows = service
        .backend
        .list_windows(None)
        .await
        .map_err(backend_error)?;
    service.sweep().await;
    let (entries, ended) = service.targets.observe(&windows, None);
    service.announce(&ended);
    Ok(entries
        .into_iter()
        .filter(|e| e.worth_listing())
        .map(|e| PickerWindow {
            not_grantable: grantable(&e.app, &service.me, &blocklist).err(),
            level: e.grant.as_ref().map_or(GrantLevel::None, |g| g.level),
            app_name: e.app.name.clone(),
            app_key: e.app.key().unwrap_or_default().to_string(),
            pid: e.app.pid,
            title: e.title,
            bounds: e.bounds,
            on_screen: e.on_screen,
            minimized: e.minimized.unwrap_or(false),
            target_id: e.target_id,
        })
        .collect())
}

/// A small picture of one window for the picker, as a `data:` URL. Never for
/// a window that can never be shared — there is no decision to make about it.
#[tauri::command]
pub async fn computer_window_thumbnail(
    app: AppHandle,
    target_id: String,
) -> Result<Option<String>, AppCommandError> {
    let service = service(&app)?;
    let config = service.config.snapshot().await;
    let Some(entry) = service.targets.get(&target_id) else {
        return Ok(None);
    };
    if !config.enabled
        || entry.gone
        || grantable(&entry.app, &service.me, &Blocklist::new(&config.blocklist)).is_err()
    {
        return Ok(None);
    }
    let _turn = service.turn.lock().await;
    match service
        .backend
        .capture(entry.identity.pid, entry.identity.window_id, Some(480))
        .await
    {
        Ok(raw) => Ok(Some(format!("data:image/png;base64,{}", raw.png_base64))),
        Err(BackendError::PermissionMissing(_)) | Err(BackendError::NoSuchWindow) => Ok(None),
        Err(e) => Err(backend_error(e)),
    }
}

/// Share one window at `level`, or stop sharing it at `none`.
#[tauri::command]
pub async fn computer_share_window(
    app: AppHandle,
    target_id: String,
    level: GrantLevel,
) -> Result<Vec<SharedWindow>, AppCommandError> {
    let service = service(&app)?;
    let change = service.share_unless_stopped(&target_id, level)?;
    service.announce(&change.into_iter().collect::<Vec<_>>());
    Ok(service.targets.shared())
}

/// What sharing several windows at once did.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShareManyResult {
    pub shared: Vec<SharedWindow>,
    /// How many of the windows named were not shared: closed since the list
    /// was read, or never shareable.
    pub skipped: u32,
}

/// Share every window named at one level — the picker's "all" — each exactly
/// as [`computer_share_window`] would share it, one after another, skipping
/// the ones that cannot be. A Stop or a switch-off that lands part way
/// through is decided window by window, under the lock it revokes under:
/// nothing is shared after it. Refused outright when the first window
/// already could not be shared for that reason.
#[tauri::command]
pub async fn computer_share_windows(
    app: AppHandle,
    target_ids: Vec<String>,
    level: GrantLevel,
) -> Result<ShareManyResult, AppCommandError> {
    let service = service(&app)?;
    let mut skipped = 0u32;
    for (i, target_id) in target_ids.iter().enumerate() {
        match service.share_unless_stopped(target_id, level) {
            // Told as it happens, so a Stop's revocations are never told
            // before a share they undid.
            Ok(change) => service.announce(&change.into_iter().collect::<Vec<_>>()),
            Err(e) if i == 0 && level != GrantLevel::None && !service.sharing_open() => {
                return Err(e)
            }
            Err(_) => skipped += 1,
        }
    }
    Ok(ShareManyResult {
        shared: service.targets.shared(),
        skipped,
    })
}

/// The shared windows and whether Stop is in force — codeg's own state, with
/// no helper to start, for a window that has just loaded.
#[tauri::command]
pub async fn computer_shared_state(app: AppHandle) -> Result<SharedState, AppCommandError> {
    let service = service(&app)?;
    Ok(SharedState {
        shared: service.targets.shared(),
        paused: service.paused.load(Ordering::Acquire),
    })
}

/// What `computer_shared_state` answers: the same pair `computer://state`
/// carries.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SharedState {
    pub shared: Vec<SharedWindow>,
    pub paused: bool,
}

/// Stop sharing every window.
#[tauri::command]
pub async fn computer_revoke_all(app: AppHandle) -> Result<(), AppCommandError> {
    let service = service(&app)?;
    let ended = service.targets.revoke_all(GrantChange::Revoked);
    service.announce(&ended);
    Ok(())
}

/// Stop: every agent call refused, every grant ended, the driver killed
/// mid-action. Answers once all three are done.
#[tauri::command]
pub async fn computer_stop(app: AppHandle) -> Result<(), AppCommandError> {
    service(&app)?.stop().await;
    Ok(())
}

/// Resume after a Stop. Nothing is shared again by it.
#[tauri::command]
pub async fn computer_resume(app: AppHandle) -> Result<(), AppCommandError> {
    service(&app)?.resume().await;
    Ok(())
}

/// Whether the stop shortcut is in force — the same status
/// `computer://stop-key` carries when it changes.
#[tauri::command]
pub async fn computer_stop_key_status(app: AppHandle) -> Result<StopKeyStatus, AppCommandError> {
    Ok(service(&app)?.stop_key_status())
}

/// cua-driver as Settings shows it: the release this codeg runs, what the
/// cache holds, and anything under way.
#[tauri::command]
pub async fn computer_driver_info(app: AppHandle) -> Result<DriverInfo, AppCommandError> {
    Ok(service(&app)?.drivers.info())
}

/// Fetch the release this codeg runs, and clear older ones. Progress travels
/// on `computer://driver`.
#[tauri::command]
pub async fn computer_driver_install(app: AppHandle) -> Result<DriverInfo, AppCommandError> {
    service(&app)?
        .drivers
        .install()
        .await
        .map_err(AppCommandError::configuration_invalid)
}

/// Remove cua-driver: computer use goes off, the helper stops, every cached
/// release goes.
#[tauri::command]
pub async fn computer_driver_uninstall(
    app: AppHandle,
    db: tauri::State<'_, crate::db::AppDatabase>,
) -> Result<DriverInfo, AppCommandError> {
    service(&app)?.uninstall_driver(&db.conn).await
}

/// The strip's page, telling how large it drew itself (logical pixels).
#[tauri::command]
pub async fn computer_indicator_fit(app: AppHandle, width: f64, height: f64) {
    crate::computer::indicator::fit(&app, width, height);
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A tree is cut on a line boundary, never mid-line, and a cap of 0 or
    /// one the tree fits under leaves it whole.
    #[test]
    fn trees_are_cut_between_lines() {
        let tree = "- [0] AXWindow\n  - [1] AXButton \"Save\"\n  - [2] AXButton \"Cancel\"\n";
        assert_eq!(cut_tree(tree, 0), (tree.to_string(), false));
        assert_eq!(cut_tree(tree, 10_000), (tree.to_string(), false));
        let (cut, truncated) = cut_tree(tree, 40);
        assert!(truncated);
        assert_eq!(cut, "- [0] AXWindow\n  - [1] AXButton \"Save\"\n");
        // Characters, not bytes: a line of CJK is not cut short by its UTF-8
        // length.
        let wide = "- 保存\n- 取消\n";
        assert_eq!(cut_tree(wide, 5), ("- 保存\n".to_string(), true));
    }

    /// Only a codeg that is its own responsible process can leak a grant to
    /// its agents; a development build under a terminal reports the
    /// terminal's grants, which the agents already have.
    #[test]
    fn only_a_self_responsible_codeg_leaks() {
        let status = |a, s, own| CodegTccStatus {
            accessibility: a,
            screen_recording: s,
            self_responsible: own,
        };
        assert!(status(true, false, true).is_leaking());
        assert!(status(false, true, true).is_leaking());
        assert!(!status(false, false, true).is_leaking());
        assert!(!status(true, true, false).is_leaking());
    }
}
