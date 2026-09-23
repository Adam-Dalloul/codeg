//! Computer use on the desktop: the service that owns the helper and the
//! window table, the agent-facing reads behind the `computer_*` tools, and
//! the commands behind codeg's own Computer use panel.
//!
//! Every agent read goes through the same five steps, in this order, because
//! a read cannot be taken back:
//!
//! 1. **Switch and self-check.** The group is on (re-read now, not at
//!    injection), and codeg itself holds neither Accessibility nor Screen
//!    Recording — if it does, every agent's shell has them too, and computer
//!    use refuses to run until that is undone.
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
//! Sharing and unsharing are Tauri commands only. There is no HTTP face for
//! them: deciding what of this screen an agent may see is for the person at
//! this screen.

use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

use crate::acp::computer_tools::{
    blocked_note, grant_required_note, no_such_target_note, permission_missing_note,
    ComputerAppsOutcome, ComputerCaptureOutcome, ComputerSnapshotOutcome, ComputerToolAccess,
    ComputerToolsConfig, ComputerToolsRuntimeConfig, ComputerVerifyOutcome, ComputerWindowsOutcome,
    SnapshotRequest, DEFAULT_MAX_DIMENSION, DEFAULT_SNAPSHOT_MAX_CHARS, ERROR_BLOCKED,
    ERROR_GRANT_REQUIRED, ERROR_NO_SUCH_TARGET, ERROR_PERMISSION_MISSING, ERROR_READ_FAILED,
    ERROR_UNAVAILABLE, NO_DESKTOP_NOTE,
};
use crate::app_error::AppCommandError;
use crate::computer::agent::{
    grantable, visible_title, ActivityOutcome, Blocklist, ComputerAction, ComputerActivityPayload,
    ComputerGrantPayload, GrantChange, GrantLevel, NotGrantable, SelfIdentity,
};
use crate::computer::backend::{BackendError, BackendStatus, ComputerBackend, SnapshotOptions};
use crate::computer::events;
use crate::computer::local::LocalBackend;
use crate::computer::protocol::{OsPermission, PermissionReport};
use crate::computer::procinfo::process_start;
use crate::computer::targets::{ReadRefusal, ReadTicket, ShareError, SharedWindow, TargetTable};
use crate::computer::types::{
    AgentAppRef, AgentAppSummary, Rect, VerifyOutcome, VerifyRequest, WindowCapture, WindowSnapshot,
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

/// What codeg knows about its own TCC standing (macOS only).
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

const CODEG_TCC_NOTE: &str = "Computer use is switched off on this Mac because codeg itself has \
    been granted Accessibility or Screen Recording — and every agent's shell inherits whatever \
    codeg has. Ask the user to remove codeg from System Settings → Privacy & Security → \
    Accessibility and Screen Recording (the permissions belong to codeg-computer-helper). It \
    cannot work until they have.";

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
}

impl Refusal {
    fn refused(slug: &'static str, note: String) -> Self {
        Self {
            slug,
            note,
            outcome: ActivityOutcome::Refused,
        }
    }

    fn failed(slug: &'static str, note: String) -> Self {
        Self {
            slug,
            note,
            outcome: ActivityOutcome::Failed,
        }
    }
}

fn permission_name(permission: OsPermission) -> &'static str {
    match permission {
        OsPermission::Accessibility => "Accessibility",
        OsPermission::ScreenRecording => "Screen Recording",
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
}

impl ComputerService {
    /// Build the service and start the two background duties it has:
    /// following the settings (switching off ends every grant and stops the
    /// helper; a longer blocklist or a shorter timeout ends what they now
    /// forbid), and ending grants whose time runs out.
    pub fn start(app: AppHandle, config: ComputerToolsRuntimeConfig) -> Arc<Self> {
        let status_app = app.clone();
        let backend = Arc::new(LocalBackend::new(move |status: &BackendStatus| {
            events::emit_backend_status(&status_app, status);
        }));
        let service = Arc::new(Self {
            app,
            backend,
            targets: TargetTable::new(),
            config: config.clone(),
            me: SelfIdentity::current(),
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

    /// Bring the grants and the helper in line with `config`. `went_off`: the
    /// switch was off at some point since the last call, even if it is on
    /// again now.
    async fn follow(&self, config: &ComputerToolsConfig, went_off: bool) {
        if went_off || !config.enabled {
            // Every grant ends, and the helper (and the driver under it)
            // stops and is not started again while the switch is off.
            let ended = self.targets.revoke_all(GrantChange::Disabled);
            self.announce(&ended);
            self.backend.close().await;
        }
        if config.enabled {
            self.sweep().await;
            self.backend.open().await;
        }
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
        events::emit_state(&self.app, &self.targets.shared());
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

    /// Step 1: the switch, re-read now, and codeg's own TCC standing.
    async fn usable(&self) -> Result<ComputerToolsConfig, Refusal> {
        let config = self.config.snapshot().await;
        if !config.enabled {
            return Err(Refusal::refused(
                ERROR_UNAVAILABLE,
                NO_DESKTOP_NOTE.to_string(),
            ));
        }
        if codeg_tcc().is_some_and(|s| s.is_leaking()) {
            return Err(Refusal::refused(
                ERROR_UNAVAILABLE,
                CODEG_TCC_NOTE.to_string(),
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
        self.check_identity(&ticket)?;
        Ok(Admitted {
            ticket,
            switched_off: config.switched_off,
        })
    }

    /// Step 3. A pid that no longer answers with the start time it had when
    /// the window was shared is a different process. A window without a start
    /// time cannot have been shared at all (`NotGrantable::Unidentified`).
    fn check_identity(&self, ticket: &ReadTicket) -> Result<(), Refusal> {
        let target_id = &ticket.target_id;
        let Some(started_at) = ticket.identity.started_at else {
            return Err(Refusal::refused(
                ERROR_BLOCKED,
                blocked_note(target_id, NotGrantable::Unidentified.note()),
            ));
        };
        if process_start(ticket.identity.pid) != Some(started_at) {
            let ended: Vec<_> = self.targets.target_changed(target_id).into_iter().collect();
            self.announce(&ended);
            return Err(Refusal::failed(
                ERROR_GRANT_REQUIRED,
                grant_required_note(target_id),
            ));
        }
        Ok(())
    }

    /// Step 4's second half: steps 1–3 again, against what the read began
    /// under.
    async fn finish(&self, admitted: &Admitted) -> Result<String, Refusal> {
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
        self.check_identity(ticket)?;
        let blocklist = Blocklist::new(&config.blocklist);
        match self.targets.finish_read(ticket, &self.me, &blocklist) {
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
        let config = match self.usable().await {
            Ok(config) => config,
            Err(r) => return ComputerAppsOutcome::refused(r.slug, r.note),
        };
        let blocklist = Blocklist::new(&config.blocklist);
        match self.backend.list_apps().await {
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
        let config = match self.usable().await {
            Ok(config) => config,
            Err(r) => return ComputerWindowsOutcome::refused(r.slug, r.note),
        };
        let blocklist = Blocklist::new(&config.blocklist);
        match self.backend.list_windows(pid).await {
            Ok(windows) => {
                // Grants that have already ended by the rules as they are now
                // must not show — neither as a level nor as a title.
                self.sweep().await;
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
        let generation = self.finish(&admitted).await?;
        Ok(WindowCapture {
            target_id: target_id.to_string(),
            generation,
            mime: "image/png".to_string(),
            data: raw.png_base64,
            width: raw.width,
            height: raw.height,
            window_bounds: if raw.window_bounds.is_empty() {
                ticket.bounds
            } else {
                raw.window_bounds
            },
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
        let generation = self.finish(&admitted).await?;
        let (tree, cut) = cut_tree(
            &raw.tree,
            request.max_chars.unwrap_or(DEFAULT_SNAPSHOT_MAX_CHARS),
        );
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
        let admitted = self.begin(target_id).await?;
        let ticket = &admitted.ticket;
        let raw = self
            .backend
            .verify(ticket.identity.pid, ticket.identity.window_id, request)
            .await
            .map_err(|e| self.backend_refusal(Some(target_id), e))?;
        self.finish(&admitted).await?;
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
    let config = service.config.snapshot().await;
    if !config.enabled && level != GrantLevel::None {
        return Err(AppCommandError::configuration_invalid(
            "computer use is switched off",
        ));
    }
    let blocklist = Blocklist::new(&config.blocklist);
    match service
        .targets
        .share(&target_id, level, now_ms(), &service.me, &blocklist)
    {
        Ok(change) => {
            service.announce(&change.into_iter().collect::<Vec<_>>());
            Ok(service.targets.shared())
        }
        Err(ShareError::NoSuchTarget) | Err(ShareError::Gone) => Err(
            AppCommandError::configuration_invalid("that window is gone; open the list again"),
        ),
        Err(ShareError::NotGrantable(why)) => {
            Err(AppCommandError::configuration_invalid(why.note()))
        }
    }
}

/// Stop sharing every window.
#[tauri::command]
pub async fn computer_revoke_all(app: AppHandle) -> Result<(), AppCommandError> {
    let service = service(&app)?;
    let ended = service.targets.revoke_all(GrantChange::Revoked);
    service.announce(&ended);
    Ok(())
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
