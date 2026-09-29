//! codeg's side of the helper: find it, launch it as its own TCC principal,
//! check that it is our helper, and talk to it.
//!
//! **Launch.** On macOS the helper is spawned with responsibility disclaimed,
//! so it is the TCC principal and codeg is not, over a socketpair duplicated
//! onto its stdin and stdout — the only rendezvous there is, with no path in
//! the filesystem for another process to get to first. Its other descriptors
//! are closed on exec, its environment is a fixed few variables. Elsewhere it
//! is an ordinary child on pipes.
//!
//! **Check.** A release codeg launches the helper under a launch requirement
//! (this build's Team ID and the helper's identifier), so the kernel runs
//! nothing else from that path — the bundle is writable by the user, and a
//! wrapper started in the helper's place could keep a copy of the socket. The
//! helper then speaks first; on macOS codeg asks the kernel who is on the
//! other end of its socket and checks that process against the helper's
//! designated requirement (`CODEG_COMPUTER_HELPER_REQUIREMENT`), and every
//! later frame against the process it verified. A development codeg checks
//! instead that the helper was built from its own sources (the fingerprint
//! `build.rs` compiles into both): `pnpm tauri dev` rebuilds only codeg after
//! an edit — and not the helper at all under `CODEG_SKIP_SIDECAR=1` — and a
//! helper left over would answer with the old code.
//!
//! **Life.** One helper per codeg, started on first use, restarted on the next
//! call after it dies, stopped when computer use is switched off — and not
//! started again until it is switched back on, whatever call was already on
//! its way. It exits on its own when codeg does: its stdin closes.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex as StdMutex};
use std::time::Duration;

use async_trait::async_trait;
use tokio::io::{AsyncBufReadExt, AsyncRead, AsyncWrite, BufReader};
use tokio::sync::{oneshot, watch, Mutex};

use super::backend::{
    ActRefusal, BackendError, BackendState, BackendStatus, ComputerBackend, SnapshotOptions,
};
use super::driver;
use super::protocol::{
    read_frame, write_frame, HelperError, HelperErrorCode, HelperMessage, HelperOp, HelperReply,
    HelperRequest, OsPermission, PeerCheck, PermissionReport, RawAct, RawApp, RawCapture,
    RawSnapshot, RawVerify, RawWindow, WindowAction, PROTOCOL_VERSION, SOURCE_FINGERPRINT,
};
use super::types::VerifyRequest;

/// The helper's designated requirement, compiled into release builds.
pub const HELPER_REQUIREMENT: Option<&str> = option_env!("CODEG_COMPUTER_HELPER_REQUIREMENT");

/// This build's Team ID, compiled into release builds with the requirement:
/// the helper is launched only as a Developer ID build of this team.
pub const HELPER_TEAM_ID: Option<&str> = option_env!("CODEG_COMPUTER_TEAM_ID");

/// The helper's signing identifier (its designated requirement names it too).
pub const HELPER_SIGNING_ID: &str = "codeg-computer-helper";

// A release build pins both or neither: a requirement checked after launch
// without the launch requirement would let a wrapper run first.
const _: () = assert!(
    HELPER_REQUIREMENT.is_some() == HELPER_TEAM_ID.is_some(),
    "CODEG_COMPUTER_HELPER_REQUIREMENT and CODEG_COMPUTER_TEAM_ID are set together"
);

/// How long one request may take to go out. A helper that stops reading is
/// wedged, and half a frame on the socket cannot be taken back.
const WRITE_TIMEOUT: Duration = Duration::from_secs(10);

/// How long a freshly launched helper has to say it is ready.
const READY_TIMEOUT: Duration = Duration::from_secs(15);

/// Why a helper that never said it was ready failed. On macOS a helper
/// macOS has not seen before can be held at launch by a question of the
/// system's own — whether it may read from a removable volume, for one, when
/// codeg lives on another disk — until the person answers it.
const NOT_STARTED: &str = if cfg!(target_os = "macos") {
    "the helper did not start in time — if macOS is asking about \
     codeg-computer-helper, answer it and try again"
} else {
    "the helper did not start in time"
};

/// How long a helper that has been told codeg is done gets to exit on its
/// own: it stops its driver first — one still starting once it has started —
/// within its own bound (`helper::SHUTDOWN_GRACE`, 60 s). Past this it is
/// stopped by signal.
const HELPER_EXIT_GRACE: Duration = Duration::from_secs(65);

/// How long [`LocalBackend::close_now`] waits for the helper to say its
/// driver is gone. A driver that is starting when the `Halt` arrives is
/// stopped as soon as it has started; the helper bounds a start by its
/// permission check (10 s), the driver's handshake (20 s) and its
/// configuration (10 s), and a stop by a couple of seconds more.
const HALT_ANSWER_TIMEOUT: Duration = Duration::from_secs(60);

/// An outer bound on one request, so a helper that stops answering cannot
/// hold a caller forever. Every op already carries a tighter bound of its own
/// inside the helper; this one is only for a helper gone wrong.
const REQUEST_TIMEOUT: Duration = Duration::from_secs(300);

pub fn helper_file_name() -> &'static str {
    if cfg!(windows) {
        "codeg-computer-helper.exe"
    } else {
        "codeg-computer-helper"
    }
}

/// The helper next to the running executable — `Contents/MacOS/` in the app
/// bundle, the install directory elsewhere, `target/<profile>/` in
/// development (the sidecar step copies it there). Deliberately no `PATH`
/// lookup: a helper found somewhere else is not the one that shipped. A debug
/// build also honours `CODEG_COMPUTER_HELPER_BIN`, for running a freshly
/// built helper; a release build ignores it, since the variable can be set
/// for codeg by anything that can set a launch environment.
pub fn locate_helper_binary() -> Option<PathBuf> {
    if cfg!(debug_assertions) {
        if let Some(raw) = std::env::var_os("CODEG_COMPUTER_HELPER_BIN") {
            let path = PathBuf::from(raw);
            if path.is_file() {
                return Some(path);
            }
        }
    }
    let exe = std::env::current_exe().ok()?;
    let candidate = exe.parent()?.join(helper_file_name());
    candidate.is_file().then_some(candidate)
}

type Pending = Arc<StdMutex<HashMap<u64, oneshot::Sender<HelperReply>>>>;

/// One running, checked helper.
struct Connection {
    writer: Mutex<Box<dyn AsyncWrite + Send + Unpin>>,
    pending: Pending,
    next_id: AtomicU64,
    closed: watch::Receiver<bool>,
    /// A write that did not finish: the socket is no longer framed.
    broken: AtomicBool,
    peer: PeerCheck,
    child: HelperChild,
}

enum HelperChild {
    #[cfg(target_os = "macos")]
    Mac(super::spawn::Child),
    #[cfg(not(target_os = "macos"))]
    Tokio(Mutex<tokio::process::Child>),
}

impl HelperChild {
    /// Whether the helper exits by itself within `grace`.
    async fn exits_within(&self, grace: Duration) -> bool {
        match self {
            #[cfg(target_os = "macos")]
            HelperChild::Mac(child) => tokio::time::timeout(grace, child.wait()).await.is_ok(),
            #[cfg(not(target_os = "macos"))]
            HelperChild::Tokio(child) => {
                let mut child = child.lock().await;
                tokio::time::timeout(grace, child.wait()).await.is_ok()
            }
        }
    }

    async fn stop(&self) {
        match self {
            #[cfg(target_os = "macos")]
            HelperChild::Mac(child) => {
                child.terminate();
                if tokio::time::timeout(Duration::from_secs(3), child.wait())
                    .await
                    .is_err()
                {
                    child.kill();
                    let _ = child.wait().await;
                }
            }
            #[cfg(not(target_os = "macos"))]
            HelperChild::Tokio(child) => {
                let mut child = child.lock().await;
                let _ = child.start_kill();
                let _ = child.wait().await;
            }
        }
    }
}

impl Connection {
    fn is_closed(&self) -> bool {
        *self.closed.borrow() || self.broken.load(Ordering::Acquire)
    }

    async fn stop(&self) {
        self.child.stop().await;
    }

    /// End the helper the way codeg quitting does: its input ends, it stops
    /// its driver — one still starting included, once that has started — and
    /// exits. Stopped by signal if it has not within [`HELPER_EXIT_GRACE`].
    async fn shut_down(&self) {
        // The real writer is dropped, which closes the helper's input.
        *self.writer.lock().await = Box::new(tokio::io::sink());
        if !self.child.exits_within(HELPER_EXIT_GRACE).await {
            tracing::warn!("[computer] the helper did not exit on its own; stopping it");
            self.stop().await;
        }
    }

    async fn request(&self, op: HelperOp) -> Result<HelperReply, BackendError> {
        if self.is_closed() {
            return Err(BackendError::Unavailable("the helper exited".into()));
        }
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let (tx, rx) = oneshot::channel();
        self.pending
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .insert(id, tx);
        let sent = tokio::time::timeout(WRITE_TIMEOUT, async {
            let mut writer = self.writer.lock().await;
            write_frame(&mut *writer, &HelperRequest { id, op }).await
        })
        .await;
        let failed = match sent {
            Ok(Ok(())) => None,
            Ok(Err(e)) => Some(format!("the helper went away: {e}")),
            Err(_) => {
                // Stopped reading: stop it, which wakes every caller waiting
                // on it, and the next call starts a fresh one.
                self.broken.store(true, Ordering::Release);
                self.stop().await;
                Some("the helper stopped reading".to_string())
            }
        };
        if let Some(why) = failed {
            self.pending
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .remove(&id);
            return Err(BackendError::Unavailable(why));
        }
        match tokio::time::timeout(REQUEST_TIMEOUT, rx).await {
            Ok(Ok(reply)) => Ok(reply),
            Ok(Err(_)) => Err(BackendError::Unavailable("the helper exited".into())),
            Err(_) => {
                self.pending
                    .lock()
                    .unwrap_or_else(|p| p.into_inner())
                    .remove(&id);
                Err(BackendError::Failed("the helper did not answer".into()))
            }
        }
    }
}

/// The running helper, and whether one may be started.
struct Slot {
    connection: Option<Arc<Connection>>,
    /// Closed while computer use is switched off: no helper is started, so a
    /// read that was admitted just before the switch cannot bring one back.
    open: bool,
}

/// The helper backend. See the module note.
pub struct LocalBackend {
    slot: Mutex<Slot>,
    status: StdMutex<BackendStatus>,
    on_status: Box<dyn Fn(&BackendStatus) + Send + Sync>,
    /// Set after the cached driver was thrown away once for failing its
    /// checks, so a download that keeps failing them is reported rather than
    /// fetched again on every call.
    redownloaded: AtomicBool,
    /// The person pressed Stop. Kept here as well as in the helper, because
    /// the helper that heard it may not be the one an action reaches: with no
    /// helper running, the Stop reached nobody, and an action already past
    /// codeg's checks would start a fresh one.
    halted: AtomicBool,
    /// Held for the whole of a [`close`](Self::close) or
    /// [`close_now`](Self::close_now), so that one returning means the helper
    /// another was already taking down is gone too.
    closing: Mutex<()>,
    /// The settings, when this backend follows them (see [`with_switch`]).
    ///
    /// [`with_switch`]: Self::with_switch
    switch: Option<crate::acp::computer_tools::ComputerToolsRuntimeConfig>,
}

impl LocalBackend {
    /// `on_status` is told every status change, for the panel.
    pub fn new(on_status: impl Fn(&BackendStatus) + Send + Sync + 'static) -> Self {
        Self {
            slot: Mutex::new(Slot {
                connection: None,
                open: false,
            }),
            status: StdMutex::new(BackendStatus {
                state: BackendState::Idle,
                detail: None,
                driver_version: driver::DRIVER_VERSION.to_string(),
                peer: None,
            }),
            on_status: Box::new(on_status),
            redownloaded: AtomicBool::new(false),
            halted: AtomicBool::new(false),
            closing: Mutex::new(()),
            switch: None,
        }
    }

    /// Start no helper unless `config` says computer use is on at that
    /// moment. [`open`](Self::open) is told by a watcher of the settings, which
    /// may be a change behind: one still acting on an earlier "on" must not
    /// start a helper — and fetch a driver just removed — after the switch
    /// has gone off.
    pub fn with_switch(
        mut self,
        config: crate::acp::computer_tools::ComputerToolsRuntimeConfig,
    ) -> Self {
        self.switch = Some(config);
        self
    }

    fn set_status(&self, state: BackendState, detail: Option<String>, peer: Option<PeerCheck>) {
        let snapshot = {
            let mut status = self.status.lock().unwrap_or_else(|p| p.into_inner());
            status.state = state;
            status.detail = detail;
            status.peer = peer;
            status.clone()
        };
        (self.on_status)(&snapshot);
    }

    /// Allow a helper to be started (computer use is on). Starts none.
    pub async fn open(&self) {
        self.slot.lock().await.open = true;
    }

    /// Stop the helper, if one is running, and start none until [`open`] —
    /// computer use was switched off. Taken under the same lock a start is
    /// made under, so once this returns no helper runs and none will. The
    /// helper is let go as when codeg quits, so its driver — even one still
    /// starting — is gone with it.
    ///
    /// [`open`]: Self::open
    pub async fn close(&self) {
        let _closing = self.closing.lock().await;
        self.close_locked().await;
    }

    async fn close_locked(&self) {
        let connection = {
            let mut slot = self.slot.lock().await;
            slot.open = false;
            slot.connection.take()
        };
        if let Some(connection) = connection {
            connection.shut_down().await;
        }
        self.set_status(BackendState::Idle, None, None);
    }

    /// [`close`](Self::close), killing the driver first — whatever it is in the
    /// middle of — rather than letting it finish its call. For removing the
    /// driver: nothing of it may still be running after this returns, which is
    /// also why it waits for a close already under way.
    ///
    /// The helper answers a `Halt` once no driver runs: at once, or — when one
    /// is still starting — once that one has started and been stopped for the
    /// Stop it met, which the helper's own bounds on a start keep under
    /// [`HALT_ANSWER_TIMEOUT`]. Only a helper gone wrong is not waited for
    /// past that.
    pub async fn close_now(&self) {
        let _closing = self.closing.lock().await;
        let connection = self.slot.lock().await.connection.clone();
        if let Some(connection) = connection.filter(|c| !c.is_closed()) {
            let halted =
                tokio::time::timeout(HALT_ANSWER_TIMEOUT, connection.request(HelperOp::Halt)).await;
            if !matches!(halted, Ok(Ok(_))) {
                tracing::warn!("[computer] the helper did not confirm killing the driver");
            }
        }
        self.close_locked().await;
    }

    /// The running helper, launching (and first fetching the driver for) one
    /// if there is none.
    async fn connection(&self) -> Result<Arc<Connection>, BackendError> {
        let mut slot = self.slot.lock().await;
        let switched_on = match &self.switch {
            Some(config) => config.is_enabled().await,
            None => true,
        };
        if !slot.open || !switched_on {
            return Err(BackendError::Unavailable(
                "computer use is switched off".into(),
            ));
        }
        if let Some(connection) = slot.connection.as_ref().filter(|c| !c.is_closed()) {
            return Ok(connection.clone());
        }
        if let Some(dead) = slot.connection.take() {
            dead.stop().await;
        }
        match self.connect().await {
            Ok(connection) => {
                self.set_status(BackendState::Ready, None, Some(connection.peer));
                slot.connection = Some(connection.clone());
                Ok(connection)
            }
            Err(e) => {
                self.set_status(BackendState::Failed, Some(e.to_string()), None);
                Err(e)
            }
        }
    }

    async fn connect(&self) -> Result<Arc<Connection>, BackendError> {
        // Said only when there is something to fetch: the settings page shows
        // this as an install.
        if driver::cached_driver_path().is_none() {
            self.set_status(BackendState::Downloading, None, None);
        }
        let driver_path = driver::ensure_driver(|_| {})
            .await
            .map_err(|e| BackendError::Unavailable(format!("could not fetch cua-driver: {e}")))?;
        self.set_status(BackendState::Starting, None, None);
        let helper = locate_helper_binary().ok_or_else(|| {
            BackendError::Unavailable(format!(
                "{} is missing from this installation",
                helper_file_name()
            ))
        })?;
        let connection = launch(&helper).await?;
        let configured = connection
            .request(HelperOp::Configure {
                driver_path: driver_path.to_string_lossy().to_string(),
                driver_version: driver::DRIVER_VERSION.to_string(),
            })
            .await?
            .decode::<()>();
        if let Err(e) = configured {
            connection.stop().await;
            return Err(e.into());
        }
        Ok(connection)
    }

    /// Send one op and decode its answer, restarting the helper once if it
    /// turns out to have died since the last call.
    ///
    /// Never for an action: a helper that died with the request on its way
    /// may have died after delivering it, and a second send would do it
    /// twice. Actions are sent once (see `act`).
    async fn call<T: serde::de::DeserializeOwned>(&self, op: HelperOp) -> Result<T, BackendError> {
        let connection = self.connection().await?;
        let reply = match connection.request(op.clone()).await {
            Err(BackendError::Unavailable(_)) if connection.is_closed() => {
                // Died between calls. One fresh start, then whatever it says.
                self.connection().await?.request(op).await?
            }
            other => other?,
        };
        self.decode(reply).await
    }

    async fn decode<T: serde::de::DeserializeOwned>(
        &self,
        reply: HelperReply,
    ) -> Result<T, BackendError> {
        match reply.decode::<T>() {
            Err(e) if e.code == HelperErrorCode::DriverRejected => {
                Err(self.driver_rejected(e).await)
            }
            other => other.map_err(BackendError::from),
        }
    }

    /// The cached driver failed the helper's checks: a damaged download, or a
    /// replaced one. Throw it away once so the next call fetches a clean copy;
    /// a second failure is reported as it is.
    async fn driver_rejected(&self, e: HelperError) -> BackendError {
        tracing::error!(
            "[computer] the helper rejected the cached cua-driver: {}",
            e.message
        );
        if !self.redownloaded.swap(true, Ordering::AcqRel) {
            let connection = self.slot.lock().await.connection.take();
            if let Some(connection) = connection {
                connection.stop().await;
            }
            if let Err(clear) = driver::forget_cached_driver().await {
                tracing::warn!("[computer] could not clear the cached cua-driver: {clear}");
            }
        }
        BackendError::Rejected(e.message)
    }
}

#[async_trait]
impl ComputerBackend for LocalBackend {
    async fn status(&self) -> BackendStatus {
        self.status
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .clone()
    }

    async fn permissions(&self) -> Result<PermissionReport, BackendError> {
        self.call(HelperOp::Permissions).await
    }

    async fn request_permission(
        &self,
        permission: OsPermission,
    ) -> Result<PermissionReport, BackendError> {
        self.call(HelperOp::RequestPermission { permission }).await
    }

    async fn list_apps(&self) -> Result<Vec<RawApp>, BackendError> {
        self.call(HelperOp::ListApps).await
    }

    async fn list_windows(&self, pid: Option<u32>) -> Result<Vec<RawWindow>, BackendError> {
        self.call(HelperOp::ListWindows { pid }).await
    }

    async fn process_start(&self, pid: u32) -> Result<Option<u64>, BackendError> {
        self.call(HelperOp::ProcessStart { pid }).await
    }

    async fn capture(
        &self,
        pid: u32,
        window_id: u64,
        max_dimension: Option<u32>,
    ) -> Result<RawCapture, BackendError> {
        self.call(HelperOp::Capture {
            pid,
            window_id,
            max_dimension,
        })
        .await
    }

    async fn snapshot(
        &self,
        pid: u32,
        window_id: u64,
        options: SnapshotOptions,
    ) -> Result<RawSnapshot, BackendError> {
        self.call(HelperOp::Snapshot {
            pid,
            window_id,
            max_depth: options.max_depth,
            max_elements: options.max_elements,
            query: options.query,
        })
        .await
    }

    async fn verify(
        &self,
        pid: u32,
        window_id: u64,
        request: VerifyRequest,
    ) -> Result<RawVerify, BackendError> {
        self.call(HelperOp::Verify {
            pid,
            window_id,
            request,
        })
        .await
    }

    async fn act(
        &self,
        pid: u32,
        window_id: u64,
        started_at: u64,
        app_key: Option<String>,
        action: WindowAction,
    ) -> Result<RawAct, BackendError> {
        let stopped = || {
            BackendError::Refused(
                ActRefusal::Paused,
                "The user pressed Stop in codeg's Computer use panel.".into(),
            )
        };
        // Before a helper is started for it, and again with the helper in
        // hand, as late as codeg can: a Stop that came while one was being
        // started stops this action too.
        if self.halted.load(Ordering::Acquire) {
            return Err(stopped());
        }
        let connection = self.connection().await?;
        if self.halted.load(Ordering::Acquire) {
            return Err(stopped());
        }
        let reply = connection
            .request(HelperOp::Act {
                pid,
                window_id,
                started_at,
                app_key,
                action,
            })
            .await?;
        self.decode(reply).await
    }

    /// Stop: no action goes out through this backend from now on, and a
    /// running helper kills its driver. With no helper running there is
    /// nothing to kill, and none is started for it.
    async fn halt(&self) -> Result<(), BackendError> {
        self.halted.store(true, Ordering::Release);
        self.to_running(HelperOp::Halt).await
    }

    async fn resume(&self) -> Result<(), BackendError> {
        let told = self.to_running(HelperOp::Resume).await;
        self.halted.store(false, Ordering::Release);
        told
    }
}

impl LocalBackend {
    /// Send `op` to the helper if one is running; with none, there is no one
    /// to tell (a helper started later starts un-halted).
    async fn to_running(&self, op: HelperOp) -> Result<(), BackendError> {
        let connection = self.slot.lock().await.connection.clone();
        match connection.filter(|c| !c.is_closed()) {
            Some(connection) => connection
                .request(op)
                .await?
                .decode::<()>()
                .map_err(BackendError::from),
            None => Ok(()),
        }
    }
}

type Io = (
    Box<dyn AsyncRead + Send + Unpin>,
    Box<dyn AsyncWrite + Send + Unpin>,
    Box<dyn AsyncRead + Send + Unpin>,
);

/// Start the helper at `path`, wait for its first frame, check who sent it,
/// and start reading its replies.
async fn launch(path: &std::path::Path) -> Result<Arc<Connection>, BackendError> {
    let (child, (mut reader, writer, stderr), peer_fd) = spawn_helper(path)?;
    tokio::spawn(forward_stderr(stderr));

    let first =
        tokio::time::timeout(READY_TIMEOUT, read_frame::<_, HelperMessage>(&mut reader)).await;
    let ready = match first {
        Ok(Ok(HelperMessage::Ready(ready))) => ready,
        Ok(Ok(_)) => return Err(abandon(child, "the helper did not introduce itself").await),
        Ok(Err(e)) => {
            // Almost always the helper refusing its peer and exiting, which it
            // does without a word on the socket; its stderr says why.
            return Err(abandon(child, &format!("the helper closed the channel: {e}")).await);
        }
        Err(_) => return Err(abandon(child, NOT_STARTED).await),
    };
    if ready.protocol != PROTOCOL_VERSION {
        return Err(abandon(
            child,
            &format!(
                "the helper speaks protocol {}, this codeg {PROTOCOL_VERSION} — reinstall codeg",
                ready.protocol
            ),
        )
        .await);
    }
    if let Some(why) = stale_development_helper(ready.source.as_deref()) {
        return Err(abandon(child, why).await);
    }
    let verified = match check_helper(peer_fd, ready.peer) {
        Ok(verified) => verified,
        Err(why) => return Err(abandon(child, &why).await),
    };

    let pending: Pending = Arc::new(StdMutex::new(HashMap::new()));
    let (closed_tx, closed_rx) = watch::channel(false);
    let reader_pending = pending.clone();
    tokio::spawn(async move {
        loop {
            let frame = read_frame::<_, HelperMessage>(&mut reader).await;
            // Whoever wrote to the helper's end last must still be the helper
            // that was checked. Anyone else holding that end — a process the
            // helper was never meant to share it with — is a forger.
            if let Some(verified) = &verified {
                if !verified.still_peer() {
                    tracing::error!(
                        "[computer] a process other than the checked helper wrote to its \
                         socket; dropping the connection"
                    );
                    break;
                }
            }
            match frame {
                Ok(HelperMessage::Reply(reply)) => {
                    let tx = reader_pending
                        .lock()
                        .unwrap_or_else(|p| p.into_inner())
                        .remove(&reply.id);
                    if let Some(tx) = tx {
                        let _ = tx.send(reply);
                    }
                }
                Ok(HelperMessage::Ready(_)) => {}
                Err(_) => break,
            }
        }
        let _ = closed_tx.send(true);
        // Dropping the senders wakes every waiting caller with "exited".
        reader_pending
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .clear();
    });
    Ok(Arc::new(Connection {
        writer: Mutex::new(writer),
        pending,
        next_id: AtomicU64::new(1),
        closed: closed_rx,
        broken: AtomicBool::new(false),
        peer: ready.peer,
        child,
    }))
}

/// Why a development codeg will not use a helper built from other sources
/// than its own — which is what `pnpm tauri dev` leaves running after an edit:
/// it builds the helper once, as it starts (never, under
/// `CODEG_SKIP_SIDECAR=1`), and only codeg after that, and a stale helper
/// answers with code that is no longer there. The words name the step that
/// rebuilds it. A release codeg ships with its own helper and does not ask.
fn stale_development_helper(source: Option<&str>) -> Option<&'static str> {
    (cfg!(debug_assertions) && source != Some(SOURCE_FINGERPRINT)).then_some(
        "this development build's helper was built from other sources — run \
         `pnpm tauri:prepare-sidecars` (which `pnpm tauri dev` skips under \
         CODEG_SKIP_SIDECAR=1), then restart `pnpm tauri dev`",
    )
}

async fn abandon(child: HelperChild, why: &str) -> BackendError {
    child.stop().await;
    tracing::error!("[computer] {why}");
    BackendError::Unavailable(why.to_string())
}

/// The socket descriptor codeg keeps, for asking the kernel who is on the
/// other end. `None` off macOS.
type PeerFd = Option<i32>;

#[cfg(target_os = "macos")]
fn spawn_helper(path: &std::path::Path) -> Result<(HelperChild, Io, PeerFd), BackendError> {
    use super::spawn::{spawn, ChildFd, SpawnSpec};
    use std::os::fd::AsRawFd;
    use std::os::unix::net::UnixStream;

    let unavailable =
        |what: &str, e: std::io::Error| BackendError::Unavailable(format!("{what}: {e}"));
    let (ours, theirs) = UnixStream::pair().map_err(|e| unavailable("socketpair", e))?;
    let (err_ours, err_theirs) = UnixStream::pair().map_err(|e| unavailable("socketpair", e))?;
    // The helper reads nothing from its environment that decides anything;
    // these are here so the few system calls that look at them are not
    // surprised.
    let env = vec![(
        "PATH".to_string(),
        "/usr/bin:/bin:/usr/sbin:/sbin".to_string(),
    )];
    let requirement = HELPER_TEAM_ID
        .filter(|team| !team.trim().is_empty())
        .map(|team| super::launch_req::signed_by(team, HELPER_SIGNING_ID));
    let child = spawn(&SpawnSpec {
        program: path,
        args: &[],
        env: &env,
        stdio: [
            ChildFd::Inherit(theirs.as_raw_fd()),
            ChildFd::Inherit(theirs.as_raw_fd()),
            ChildFd::Inherit(err_theirs.as_raw_fd()),
        ],
        disclaim: true,
        suspended: false,
        launch_requirement: requirement.as_deref(),
    })
    .map_err(|e| unavailable("could not start the helper", e))?;
    drop(theirs);
    drop(err_theirs);
    let peer_fd = ours.as_raw_fd();
    let to_tokio = |s: UnixStream| -> Result<tokio::net::UnixStream, BackendError> {
        s.set_nonblocking(true)
            .and_then(|_| tokio::net::UnixStream::from_std(s))
            .map_err(|e| unavailable("socket", e))
    };
    let (reader, writer) = to_tokio(ours)?.into_split();
    let (err_reader, _) = to_tokio(err_ours)?.into_split();
    // `peer_fd` stays valid for as long as the split halves live: the read
    // half is owned by the reader task, the only place it is read after
    // `launch` returns.
    Ok((
        HelperChild::Mac(child),
        (Box::new(reader), Box::new(writer), Box::new(err_reader)),
        Some(peer_fd),
    ))
}

#[cfg(not(target_os = "macos"))]
fn spawn_helper(path: &std::path::Path) -> Result<(HelperChild, Io, PeerFd), BackendError> {
    let mut command = tokio::process::Command::new(path);
    command
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true);
    #[cfg(windows)]
    {
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    let mut child = command
        .spawn()
        .map_err(|e| BackendError::Unavailable(format!("could not start the helper: {e}")))?;
    let missing = || BackendError::Unavailable("the helper has no stdio".into());
    let stdin = child.stdin.take().ok_or_else(missing)?;
    let stdout = child.stdout.take().ok_or_else(missing)?;
    let stderr = child.stderr.take().ok_or_else(missing)?;
    Ok((
        HelperChild::Tokio(Mutex::new(child)),
        (Box::new(stdout), Box::new(stdin), Box::new(stderr)),
        None,
    ))
}

/// The helper as checked: the process on the other end of the socket when
/// its first frame arrived.
struct VerifiedPeer {
    #[cfg(target_os = "macos")]
    fd: i32,
    #[cfg(target_os = "macos")]
    token: super::codesign::AuditToken,
}

impl VerifiedPeer {
    /// Whether the last process to use the helper's end of the socket is
    /// still the one that was checked (same pid, same incarnation of it).
    fn still_peer(&self) -> bool {
        #[cfg(target_os = "macos")]
        {
            super::codesign::peer_audit_token(self.fd).is_ok_and(|now| {
                now.pid() == self.token.pid() && now.pid_version() == self.token.pid_version()
            })
        }
        #[cfg(not(target_os = "macos"))]
        {
            true
        }
    }
}

/// Check the process that sent the first frame is our helper. `None` for a
/// development build, which checks nothing.
#[cfg(target_os = "macos")]
fn check_helper(peer_fd: PeerFd, peer: PeerCheck) -> Result<Option<VerifiedPeer>, String> {
    use super::codesign::{check_guest, peer_audit_token, Guest};
    let Some(requirement) = HELPER_REQUIREMENT.filter(|r| !r.trim().is_empty()) else {
        tracing::warn!("[computer] development build: not checking the helper's signature");
        return Ok(None);
    };
    // A release codeg only ever launches a release helper, which checks
    // codeg in turn; one that did not is not the helper that shipped.
    if peer != PeerCheck::Verified {
        return Err(
            "the helper did not check codeg's signature; it is not the release helper".into(),
        );
    }
    let fd = peer_fd.ok_or("no socket to check")?;
    let token = peer_audit_token(fd).map_err(|e| format!("no peer token for the helper: {e}"))?;
    let info = check_guest(Guest::Audit(token), requirement)
        .map_err(|e| format!("the helper is not codeg's: {e}"))?;
    info.entitlements_clean()
        .map_err(|e| format!("the helper is not one codeg trusts: {e}"))?;
    Ok(Some(VerifiedPeer { fd, token }))
}

#[cfg(not(target_os = "macos"))]
fn check_helper(_peer_fd: PeerFd, _peer: PeerCheck) -> Result<Option<VerifiedPeer>, String> {
    Ok(None)
}

/// The helper's stderr (and, through it, the driver's) into codeg's log.
async fn forward_stderr(stderr: Box<dyn AsyncRead + Send + Unpin>) {
    let mut lines = BufReader::new(stderr).lines();
    while let Ok(Some(line)) = lines.next_line().await {
        tracing::info!(target: "computer_helper", "{line}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The whole codeg side against a real helper and the real pinned
    /// driver: launch disclaimed over a socketpair, the first-frame
    /// handshake, `Configure`, and reads that do and do not need a TCC
    /// permission. Ignored by default because it needs both binaries on disk,
    /// on an internal volume (a new TCC principal started from an external
    /// one blocks in dyld on a "removable volume" consent prompt):
    ///
    /// ```text
    /// CODEG_TEST_HELPER=/tmp/codeg-computer-helper \
    /// CODEG_TEST_DRIVER=/tmp/cua-driver \
    ///   cargo test --features test-utils --lib computer::local -- --ignored
    /// ```
    #[cfg(target_os = "macos")]
    #[tokio::test]
    #[ignore = "needs a built helper and the pinned cua-driver on an internal volume"]
    async fn codeg_drives_a_real_helper_and_driver() {
        let helper = std::env::var("CODEG_TEST_HELPER").expect("CODEG_TEST_HELPER");
        let driver_file = std::env::var("CODEG_TEST_DRIVER").expect("CODEG_TEST_DRIVER");
        let home = tempfile::tempdir().unwrap();
        // Pre-seed the binary cache so `ensure_driver` finds it without a
        // download.
        let cached = home
            .path()
            .join("acp-binaries")
            .join(driver::DRIVER_CACHE_ID)
            .join(driver::DRIVER_VERSION)
            .join(crate::acp::registry::current_platform());
        std::fs::create_dir_all(&cached).unwrap();
        std::fs::copy(&driver_file, cached.join(driver::DRIVER_COMMAND)).unwrap();

        let states = Arc::new(StdMutex::new(Vec::new()));
        let seen = states.clone();
        let backend = LocalBackend::new(move |s: &BackendStatus| {
            seen.lock().unwrap().push(s.state);
        });
        // Closed until computer use is on.
        assert!(matches!(
            backend.permissions().await,
            Err(BackendError::Unavailable(_))
        ));
        backend.open().await;
        temp_env::async_with_vars(
            [
                (
                    "CODEG_HOME",
                    Some(home.path().to_string_lossy().to_string()),
                ),
                ("CODEG_COMPUTER_HELPER_BIN", Some(helper.clone())),
            ],
            async {
                let report = backend.permissions().await.expect("the helper answers");
                assert!(report.required);
                let apps = backend.list_apps().await.expect("apps");
                assert!(apps.iter().any(|a| a.pid == std::process::id()) || !apps.is_empty());
                let windows = backend.list_windows(None).await.expect("windows");
                if let Some(w) = windows.first() {
                    if !report.screen_recording {
                        assert_eq!(
                            backend.capture(w.pid, w.window_id, Some(200)).await,
                            Err(BackendError::PermissionMissing(
                                OsPermission::ScreenRecording
                            ))
                        );
                    }
                }
            },
        )
        .await;
        assert_eq!(backend.status().await.state, BackendState::Ready);
        assert_eq!(backend.status().await.peer, Some(PeerCheck::Development));
        backend.close().await;
        assert!(states.lock().unwrap().contains(&BackendState::Starting));
        // And stays closed: nothing starts a helper again until it is opened.
        assert!(matches!(
            backend.list_apps().await,
            Err(BackendError::Unavailable(_))
        ));
    }

    /// A development codeg (every test build is one) takes only a helper built
    /// from its own sources: not one from other sources, nor one too old to
    /// say.
    #[test]
    fn a_development_codeg_refuses_a_stale_helper() {
        assert_eq!(stale_development_helper(Some(SOURCE_FINGERPRINT)), None);
        assert!(stale_development_helper(Some("0000000000000000")).is_some());
        assert!(stale_development_helper(None)
            .is_some_and(|why| why.contains("pnpm tauri:prepare-sidecars")));
    }

    /// A Stop holds in the backend itself, with no helper running to hear it:
    /// no action goes out — and no helper is started for one — until Resume.
    #[tokio::test]
    async fn a_stop_holds_with_no_helper_to_hear_it() {
        use crate::computer::keys::{Chord, Key, Modifiers};
        let backend = LocalBackend::new(|_: &BackendStatus| {});
        backend.open().await;
        backend.halt().await.unwrap();
        let act = || WindowAction::Key {
            element: None,
            chord: Chord {
                key: Key::Return,
                modifiers: Modifiers::default(),
            },
        };
        assert_eq!(
            backend.act(1, 1, 1, None, act()).await.unwrap_err(),
            BackendError::Refused(
                ActRefusal::Paused,
                "The user pressed Stop in codeg's Computer use panel.".into()
            )
        );
        // Nothing was started for the refused action.
        assert_eq!(backend.status().await.state, BackendState::Idle);
        backend.resume().await.unwrap();
        assert!(!backend.halted.load(Ordering::Acquire));
    }

    /// A debug build takes the helper from `CODEG_COMPUTER_HELPER_BIN` when
    /// it names a file, and otherwise looks only beside the executable.
    #[test]
    fn the_helper_is_looked_for_beside_codeg() {
        assert!(helper_file_name().starts_with("codeg-computer-helper"));
        let dir = tempfile::tempdir().unwrap();
        let fake = dir.path().join(helper_file_name());
        std::fs::write(&fake, b"").unwrap();
        temp_env::with_var("CODEG_COMPUTER_HELPER_BIN", Some(&fake), || {
            assert_eq!(locate_helper_binary().as_deref(), Some(fake.as_path()));
        });
        temp_env::with_var(
            "CODEG_COMPUTER_HELPER_BIN",
            Some(dir.path().join("absent")),
            || {
                let found = locate_helper_binary();
                assert!(
                    found.is_none_or(|p| p.parent() == std::env::current_exe().unwrap().parent())
                );
            },
        );
    }
}
