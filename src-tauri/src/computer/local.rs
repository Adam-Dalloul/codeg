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
//! **Check.** The helper speaks first. On macOS codeg then asks the kernel who
//! is on the other end of its socket and checks that process against the
//! helper's designated requirement, compiled into release builds
//! (`CODEG_COMPUTER_HELPER_REQUIREMENT`). The file at the helper's path is
//! never what is checked — the bundle is writable by the user — the process
//! that answered is.
//!
//! **Life.** One helper per codeg, started on first use, restarted on the next
//! call after it dies, stopped when computer use is switched off. It exits on
//! its own when codeg does: its stdin closes.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex as StdMutex};
use std::time::Duration;

use async_trait::async_trait;
use tokio::io::{AsyncBufReadExt, AsyncRead, AsyncWrite, BufReader};
use tokio::sync::{oneshot, watch, Mutex};

use super::backend::{BackendError, BackendState, BackendStatus, ComputerBackend, SnapshotOptions};
use super::driver;
use super::protocol::{
    read_frame, write_frame, HelperError, HelperErrorCode, HelperMessage, HelperOp, HelperReply,
    HelperRequest, OsPermission, PeerCheck, PermissionReport, RawApp, RawCapture, RawSnapshot,
    RawVerify, RawWindow, PROTOCOL_VERSION,
};
use super::types::VerifyRequest;

/// The helper's designated requirement, compiled into release builds.
pub const HELPER_REQUIREMENT: Option<&str> = option_env!("CODEG_COMPUTER_HELPER_REQUIREMENT");

/// How long a freshly launched helper has to say it is ready.
const READY_TIMEOUT: Duration = Duration::from_secs(15);

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
        *self.closed.borrow()
    }

    async fn stop(&self) {
        self.child.stop().await;
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
        let sent = {
            let mut writer = self.writer.lock().await;
            write_frame(&mut *writer, &HelperRequest { id, op }).await
        };
        if let Err(e) = sent {
            self.pending
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .remove(&id);
            return Err(BackendError::Unavailable(format!(
                "the helper went away: {e}"
            )));
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

/// The helper backend. See the module note.
pub struct LocalBackend {
    connection: Mutex<Option<Arc<Connection>>>,
    status: StdMutex<BackendStatus>,
    on_status: Box<dyn Fn(&BackendStatus) + Send + Sync>,
    /// Set after the cached driver was thrown away once for failing its
    /// checks, so a download that keeps failing them is reported rather than
    /// fetched again on every call.
    redownloaded: AtomicBool,
}

impl LocalBackend {
    /// `on_status` is told every status change, for the panel.
    pub fn new(on_status: impl Fn(&BackendStatus) + Send + Sync + 'static) -> Self {
        Self {
            connection: Mutex::new(None),
            status: StdMutex::new(BackendStatus {
                state: BackendState::Idle,
                detail: None,
                driver_version: driver::DRIVER_VERSION.to_string(),
                peer: None,
            }),
            on_status: Box::new(on_status),
            redownloaded: AtomicBool::new(false),
        }
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

    /// Stop the helper, if one is running. The next call starts a new one.
    pub async fn shutdown(&self) {
        let connection = self.connection.lock().await.take();
        if let Some(connection) = connection {
            connection.stop().await;
        }
        self.set_status(BackendState::Idle, None, None);
    }

    /// The running helper, launching (and first fetching the driver for) one
    /// if there is none.
    async fn connection(&self) -> Result<Arc<Connection>, BackendError> {
        let mut slot = self.connection.lock().await;
        if let Some(connection) = slot.as_ref().filter(|c| !c.is_closed()) {
            return Ok(connection.clone());
        }
        if let Some(dead) = slot.take() {
            dead.stop().await;
        }
        match self.connect().await {
            Ok(connection) => {
                self.set_status(BackendState::Ready, None, Some(connection.peer));
                *slot = Some(connection.clone());
                Ok(connection)
            }
            Err(e) => {
                self.set_status(BackendState::Failed, Some(e.to_string()), None);
                Err(e)
            }
        }
    }

    async fn connect(&self) -> Result<Arc<Connection>, BackendError> {
        self.set_status(BackendState::Downloading, None, None);
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
    async fn call<T: serde::de::DeserializeOwned>(&self, op: HelperOp) -> Result<T, BackendError> {
        let connection = self.connection().await?;
        let reply = match connection.request(op.clone()).await {
            Err(BackendError::Unavailable(_)) if connection.is_closed() => {
                // Died between calls. One fresh start, then whatever it says.
                self.connection().await?.request(op).await?
            }
            other => other?,
        };
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
            if let Some(connection) = self.connection.lock().await.take() {
                connection.stop().await;
            }
            if let Err(clear) = driver::forget_cached_driver() {
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
        Err(_) => return Err(abandon(child, "the helper did not start in time").await),
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
    if let Err(why) = check_helper(peer_fd, ready.peer) {
        return Err(abandon(child, &why).await);
    }

    let pending: Pending = Arc::new(StdMutex::new(HashMap::new()));
    let (closed_tx, closed_rx) = watch::channel(false);
    let reader_pending = pending.clone();
    tokio::spawn(async move {
        loop {
            match read_frame::<_, HelperMessage>(&mut reader).await {
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
        peer: ready.peer,
        child,
    }))
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
    // `peer_fd` stays valid for as long as the split halves live, which is as
    // long as the connection does; it is only read before `launch` returns.
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

/// Check the process that sent the first frame is our helper.
#[cfg(target_os = "macos")]
fn check_helper(peer_fd: PeerFd, peer: PeerCheck) -> Result<(), String> {
    use super::codesign::{check_guest, peer_audit_token, Guest};
    let Some(requirement) = HELPER_REQUIREMENT.filter(|r| !r.trim().is_empty()) else {
        tracing::warn!("[computer] development build: not checking the helper's signature");
        return Ok(());
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
        .map_err(|e| format!("the helper is not one codeg trusts: {e}"))
}

#[cfg(not(target_os = "macos"))]
fn check_helper(_peer_fd: PeerFd, _peer: PeerCheck) -> Result<(), String> {
    Ok(())
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
        backend.shutdown().await;
        assert!(states.lock().unwrap().contains(&BackendState::Starting));
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
