//! `codeg-computer-helper`: the process that holds the OS permissions for
//! computer use, and runs the driver as its child.
//!
//! On macOS the helper is launched by codeg as its own TCC responsible
//! process, so Accessibility and Screen Recording are granted to it and not to
//! codeg — where every agent's shell would inherit them. That makes the helper
//! the thing an agent would most like to drive itself: any process can launch
//! a copy of it the same way codeg does. So **before it reads a byte, the
//! helper checks that the process on the other end of its stdin is codeg** —
//! by the audit token the kernel attached to the socket, against codeg's
//! designated requirement compiled into this binary — and exits, having done
//! nothing, if it is not.
//!
//! The requirement is compiled in (`CODEG_COMPUTER_PEER_REQUIREMENT`, set by
//! the release build) rather than read from anywhere at run time: the app
//! bundle both binaries ship in is owned by the user and writable by any of
//! their processes. A build without it is a development build. Development
//! builds skip the peer check and say so in their first frame — tolerable only
//! because such a build is ad-hoc signed, so the permissions granted to it are
//! keyed to that one build's cdhash. **A helper that carries a Team ID and no
//! requirement refuses to start**: that would be a helper matching the release
//! signing identity with no check in front of it, a standing key to whatever
//! the user granted.
//!
//! On Windows and Linux there is no TCC to guard and no code signature to
//! check; the helper serves its stdin, which is the pipe codeg gave it.

pub mod act;
pub mod driver_proc;
pub mod mcp;
pub mod ops;
pub mod session;
pub mod tree;

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use tokio::io::{AsyncRead, AsyncWrite, AsyncWriteExt};
use tokio::sync::{mpsc, Mutex};

use self::act::SnapshotBook;
use self::driver_proc::DriverProc;
use self::ops::AppCache;
use super::driver;
use super::protocol::{
    read_frame, HelperError, HelperErrorCode, HelperMessage, HelperOp, HelperReady, HelperReply,
    HelperRequest, OsPermission, PeerCheck, PermissionReport, RawAct, MAX_FRAME_BYTES,
    PROTOCOL_VERSION, SOURCE_FINGERPRINT,
};

/// Exit codes, for codeg's log: they are all the helper says to a peer it has
/// refused.
pub const EXIT_OK: i32 = 0;
pub const EXIT_FAILED: i32 = 1;
pub const EXIT_PEER_REFUSED: i32 = 2;
pub const EXIT_UNANCHORED: i32 = 3;

/// codeg's designated requirement, compiled into release builds. See the
/// module note.
pub const PEER_REQUIREMENT: Option<&str> = option_env!("CODEG_COMPUTER_PEER_REQUIREMENT");

/// The calls that raise a system permission request. Supplied by the helper
/// binary, so that nothing codeg itself links can ever raise one in codeg's
/// name.
pub trait PermissionPrompts: Send + Sync + 'static {
    fn request(&self, permission: OsPermission);
}

/// The helper's whole life: check the peer, serve it, exit when it goes away.
pub fn run(prompts: impl PermissionPrompts) -> i32 {
    let _ = tracing_subscriber::fmt()
        .with_writer(std::io::stderr)
        .with_ansi(false)
        .with_target(false)
        .try_init();

    let channel = match open_channel() {
        Ok(channel) => channel,
        Err((code, why)) => {
            tracing::error!("refusing to serve: {why}");
            return code;
        }
    };

    // Everything the helper writes lives under its own directory; being there
    // keeps the driver (which inherits the working directory) out of wherever
    // codeg happened to be started. Done before any thread exists, and not
    // optional: a helper that stayed where it was started would hand that
    // directory to the driver.
    if let Some(dir) = driver_proc::helper_data_dir() {
        if let Err(e) = std::fs::create_dir_all(&dir).and_then(|_| std::env::set_current_dir(&dir))
        {
            tracing::error!("could not move to {}: {e}", dir.display());
            return EXIT_FAILED;
        }
    }

    serve_on_own_runtime(
        move || channel.raw.into_tokio(),
        channel.peer,
        channel.guard,
        Arc::new(prompts),
    )
}

/// Build the helper's runtime, open the channel on it (tokio's socket wrapper
/// registers with its reactor) and serve — then leave without waiting on
/// whatever is still running there. A request may be parked in
/// `spawn_blocking` on a permission prompt nobody will answer, and dropping a
/// runtime waits for its blocking tasks; codeg is gone, and the process exits
/// when this returns.
fn serve_on_own_runtime(
    open: impl FnOnce() -> std::io::Result<Halves>,
    peer: PeerCheck,
    guard: Option<PeerGuard>,
    prompts: Arc<dyn PermissionPrompts>,
) -> i32 {
    let runtime = match tokio::runtime::Builder::new_multi_thread()
        .worker_threads(2)
        .enable_all()
        .build()
    {
        Ok(rt) => rt,
        Err(e) => {
            tracing::error!("no runtime: {e}");
            return EXIT_FAILED;
        }
    };
    let code = runtime.block_on(async move {
        let (reader, writer) = match open() {
            Ok(halves) => halves,
            Err(e) => {
                tracing::error!("could not open the channel: {e}");
                return EXIT_FAILED;
            }
        };
        serve(reader, writer, peer, guard, prompts).await
    });
    runtime.shutdown_background();
    code
}

enum RawChannel {
    /// macOS: the socketpair end codeg handed over as both stdin and stdout.
    #[cfg(target_os = "macos")]
    Socket(std::os::unix::net::UnixStream),
    Stdio,
}

type Halves = (
    Box<dyn AsyncRead + Send + Unpin>,
    Box<dyn AsyncWrite + Send + Unpin>,
);

impl RawChannel {
    /// Needs a runtime: tokio's socket wrapper registers with its reactor.
    fn into_tokio(self) -> std::io::Result<Halves> {
        match self {
            #[cfg(target_os = "macos")]
            RawChannel::Socket(socket) => {
                socket.set_nonblocking(true)?;
                let (r, w) = tokio::net::UnixStream::from_std(socket)?.into_split();
                Ok((Box::new(r), Box::new(w)))
            }
            RawChannel::Stdio => Ok((Box::new(tokio::io::stdin()), Box::new(tokio::io::stdout()))),
        }
    }
}

struct Channel {
    raw: RawChannel,
    peer: PeerCheck,
    guard: Option<PeerGuard>,
}

/// The codeg that was checked, for checking every request against.
///
/// The kernel's peer token names the last process to have used the other end
/// of the socket, not the one that created it — so a single check at start
/// would vouch for whoever wrote next. Each request is held to the process
/// that passed the check: same pid, same incarnation of it.
pub struct PeerGuard {
    #[cfg(target_os = "macos")]
    token: super::codesign::AuditToken,
}

impl PeerGuard {
    fn still_peer(&self) -> bool {
        #[cfg(target_os = "macos")]
        {
            super::codesign::peer_audit_token(0).is_ok_and(|now| {
                now.pid() == self.token.pid() && now.pid_version() == self.token.pid_version()
            })
        }
        #[cfg(not(target_os = "macos"))]
        {
            true
        }
    }
}

/// Decide who is on the other end of stdin, before anything is read from it.
#[cfg(target_os = "macos")]
fn open_channel() -> Result<Channel, (i32, String)> {
    use super::codesign::{check_guest, peer_audit_token, self_info, Guest};

    let requirement = PEER_REQUIREMENT.filter(|r| !r.trim().is_empty());
    if requirement.is_none() {
        // A helper that cannot tell whether it is a release build is treated
        // as one.
        let me = self_info()
            .map_err(|e| (EXIT_UNANCHORED, format!("cannot read my own signature: {e}")))?;
        if me.team_id.is_some() {
            return Err((
                EXIT_UNANCHORED,
                "this helper is signed with a Team ID but was built without codeg's \
                 designated requirement; it would serve any caller"
                    .into(),
            ));
        }
    }

    if !is_socket(0) {
        return match requirement {
            Some(_) => Err((EXIT_PEER_REFUSED, "stdin is not a socket".into())),
            None => {
                tracing::warn!("development build: serving plain stdio without a peer check");
                Ok(Channel {
                    raw: RawChannel::Stdio,
                    peer: PeerCheck::Development,
                    guard: None,
                })
            }
        };
    }
    let (peer, guard) = match requirement {
        Some(requirement) => {
            // Replies go back down the socket the requests came in on, never
            // to a descriptor someone else wired up as stdout.
            if !same_file(0, 1) {
                return Err((EXIT_PEER_REFUSED, "stdout is not the stdin socket".into()));
            }
            let token = peer_audit_token(0)
                .map_err(|e| (EXIT_PEER_REFUSED, format!("no peer token: {e}")))?;
            // The codeg this helper serves is the one that launched it: the
            // peer must be this process's parent. Otherwise a process could
            // get a genuine codeg to write once into a socket of its own
            // making and start the helper on the other end — the token would
            // name that codeg, and the helper would serve whoever started it.
            // SAFETY: getppid cannot fail.
            let parent = unsafe { libc::getppid() };
            if i64::from(token.pid()) != i64::from(parent) {
                return Err((
                    EXIT_PEER_REFUSED,
                    format!(
                        "the peer (pid {}) is not the process that launched this helper \
                         (pid {parent})",
                        token.pid()
                    ),
                ));
            }
            let info = check_guest(Guest::Audit(token), requirement)
                .map_err(|e| (EXIT_PEER_REFUSED, format!("the peer is not codeg: {e}")))?;
            info.entitlements_clean().map_err(|e| {
                (
                    EXIT_PEER_REFUSED,
                    format!("the peer is not a codeg this helper serves: {e}"),
                )
            })?;
            (PeerCheck::Verified, Some(PeerGuard { token }))
        }
        None => {
            tracing::warn!("development build: serving without checking the peer's signature");
            (PeerCheck::Development, None)
        }
    };
    // SAFETY: fd 0 is a socket (checked above) that this process owns for its
    // whole life; nothing else in the helper touches descriptor 0.
    let socket = unsafe {
        use std::os::fd::FromRawFd;
        std::os::unix::net::UnixStream::from_raw_fd(0)
    };
    Ok(Channel {
        raw: RawChannel::Socket(socket),
        peer,
        guard,
    })
}

#[cfg(not(target_os = "macos"))]
fn open_channel() -> Result<Channel, (i32, String)> {
    Ok(Channel {
        raw: RawChannel::Stdio,
        peer: PeerCheck::NotApplicable,
        guard: None,
    })
}

#[cfg(target_os = "macos")]
fn fstat(fd: i32) -> Option<libc::stat> {
    let mut st: libc::stat = unsafe { std::mem::zeroed() };
    // SAFETY: fstat on a descriptor number with a valid out-parameter.
    (unsafe { libc::fstat(fd, &mut st) } == 0).then_some(st)
}

#[cfg(target_os = "macos")]
fn is_socket(fd: i32) -> bool {
    fstat(fd).is_some_and(|st| (st.st_mode & libc::S_IFMT) == libc::S_IFSOCK)
}

#[cfg(target_os = "macos")]
fn same_file(a: i32, b: i32) -> bool {
    match (fstat(a), fstat(b)) {
        (Some(x), Some(y)) => x.st_dev == y.st_dev && x.st_ino == y.st_ino,
        _ => false,
    }
}

/// How long an answer that a permission is missing stands before the helper
/// asks the system again. Asking starts a process; an agent retrying a
/// screenshot in a loop should not start one per try.
#[cfg(any(test, target_os = "macos"))]
const RECHECK_MISSING: Duration = Duration::from_secs(2);

/// What the running helper holds between requests.
struct HelperState {
    prompts: Arc<dyn PermissionPrompts>,
    /// Set by `Configure`.
    driver_path: Mutex<Option<PathBuf>>,
    /// The running driver, started on first use and again after it exits.
    driver: Mutex<Option<Arc<DriverProc>>>,
    apps: Mutex<AppCache>,
    /// The latest snapshot of each window, as the running driver keeps them.
    snapshots: std::sync::Mutex<SnapshotBook>,
    /// The person pressed Stop: no driver runs until codeg says `Resume`.
    halted: AtomicBool,
    /// The helper's permissions as the system last answered, and when. Never
    /// asked in this process on macOS: a process keeps the first "not
    /// granted" it hears for the rest of its life (see [`permissions`]).
    ///
    /// [`permissions`]: Self::permissions
    permissions: Mutex<Option<(PermissionReport, Instant)>>,
    /// The permissions in force when the running driver started, while one
    /// runs.
    driver_saw: std::sync::Mutex<Option<PermissionReport>>,
    /// A permission is in force that the running driver started without. The
    /// driver may still hold the system's earlier "no" — for Screen Recording
    /// macOS keeps it until the process ends — so the next call that needs
    /// the driver starts a fresh one.
    driver_stale: AtomicBool,
}

impl HelperState {
    fn snapshots(&self) -> std::sync::MutexGuard<'_, SnapshotBook> {
        // Every change to the book is a single insert or removal, so a
        // poisoned lock still guards a consistent book.
        self.snapshots.lock().unwrap_or_else(|p| p.into_inner())
    }

    fn check_not_halted(&self) -> Result<(), HelperError> {
        if self.halted.load(Ordering::Acquire) {
            return Err(HelperError::new(
                HelperErrorCode::Paused,
                "The user pressed Stop in codeg's Computer use panel.",
            ));
        }
        Ok(())
    }

    /// What must hold at the moment an action's driver call goes out:
    /// nothing has been stopped, `pid` is still the process the window was
    /// shared from (a relaunch under a reused pid is another process, whose
    /// windows nobody shared), and the session is affirmatively unlocked and
    /// on this console.
    fn deliverable(&self, pid: u32, started_at: u64) -> Result<(), HelperError> {
        self.check_not_halted()?;
        if super::procinfo::process_start(pid) != Some(started_at) {
            return Err(HelperError::new(
                HelperErrorCode::NoSuchWindow,
                "the window's process is gone",
            ));
        }
        match session::state() {
            session::SessionState::Unlocked => Ok(()),
            session::SessionState::Locked => Err(HelperError::new(
                HelperErrorCode::Paused,
                "The screen is locked, or another user's session is active.",
            )),
            session::SessionState::Unknown => Err(HelperError::new(
                HelperErrorCode::ActionFailed,
                "codeg cannot tell whether this desktop's session is locked, so it does not act \
                 on windows here; retrying will not change that. Reading windows still works.",
            )),
        }
    }

    /// The running driver, starting it if there is none — or if the one
    /// running started before a permission it now has (`driver_stale`).
    async fn driver(&self) -> Result<Arc<DriverProc>, HelperError> {
        self.check_not_halted()?;
        let mut slot = self.driver.lock().await;
        let stale = self.driver_stale.swap(false, Ordering::AcqRel);
        if !stale {
            if let Some(driver) = slot.as_ref().filter(|d| d.alive()) {
                return Ok(driver.clone());
            }
        }
        if let Some(old) = slot.take() {
            self.forget_driver_saw();
            old.shutdown().await;
        }
        let path = self.driver_path.lock().await.clone().ok_or_else(|| {
            HelperError::new(
                HelperErrorCode::NotConfigured,
                "the helper has not been told where the driver is",
            )
        })?;
        let artifact = driver::artifact_for_current_platform().ok_or_else(|| {
            HelperError::new(
                HelperErrorCode::DriverUnavailable,
                "no driver release for this platform",
            )
        })?;
        // What the new driver starts with, so a permission granted later is
        // told apart from one it had all along.
        let seen = self.permissions(false).await;
        let launched =
            Arc::new(DriverProc::launch(&path, artifact, || self.check_not_halted()).await?);
        // A Stop that arrived while this one was starting stops it too.
        if let Err(halted) = self.check_not_halted() {
            launched.shutdown().await;
            return Err(halted);
        }
        // A fresh driver has taken no snapshots.
        self.snapshots().clear();
        *self.driver_saw.lock().unwrap_or_else(|p| p.into_inner()) = Some(seen);
        // A check that ran while this one was starting, and found more than
        // it started with, compared itself with no driver: compare now.
        if self
            .permissions
            .lock()
            .await
            .as_ref()
            .is_some_and(|(last, _)| gained(&seen, last))
        {
            self.driver_stale.store(true, Ordering::Release);
        }
        *slot = Some(launched.clone());
        Ok(launched)
    }

    fn forget_driver_saw(&self) {
        *self.driver_saw.lock().unwrap_or_else(|p| p.into_inner()) = None;
    }

    async fn shutdown(&self) {
        let driver = self.driver.lock().await.take();
        self.snapshots().clear();
        self.forget_driver_saw();
        if let Some(driver) = driver {
            driver.shutdown().await;
        }
    }

    /// The helper's own OS permissions. `fresh` asks the system now;
    /// otherwise a recent answer stands — one that both are granted until a
    /// driver call says otherwise (see [`handle`]), one that something is
    /// missing for [`RECHECK_MISSING`].
    ///
    /// On macOS the system is asked in a process started for the purpose
    /// (`driver_proc::probe_permissions`), never in this one: macOS keeps a
    /// process's first "not granted" for its whole life, and a helper that
    /// asked itself would go on reporting a permission missing after the
    /// person had granted it. A permission that has appeared since the running
    /// driver started marks that driver stale.
    async fn permissions(&self, fresh: bool) -> PermissionReport {
        #[cfg(not(target_os = "macos"))]
        {
            let _ = fresh;
            PermissionReport {
                required: false,
                accessibility: true,
                screen_recording: true,
            }
        }
        #[cfg(target_os = "macos")]
        {
            let mut last = self.permissions.lock().await;
            if !fresh {
                if let Some((report, at)) = last.as_ref() {
                    if answer_stands(report, at.elapsed()) {
                        return *report;
                    }
                }
            }
            let report = self.ask_system().await;
            if self
                .driver_saw
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .as_ref()
                .is_some_and(|saw| gained(saw, &report))
            {
                self.driver_stale.store(true, Ordering::Release);
            }
            *last = Some((report, Instant::now()));
            report
        }
    }

    /// Ask macOS, in a fresh process. Where that cannot be done — no driver
    /// configured yet, or one that would not start — ask here, and live with
    /// an answer this process may keep.
    #[cfg(target_os = "macos")]
    async fn ask_system(&self) -> PermissionReport {
        let path = self.driver_path.lock().await.clone();
        if let Some(path) = path {
            match driver_proc::probe_permissions(&path).await {
                Ok(report) => return report,
                Err(e) => tracing::warn!(
                    "could not check permissions in a fresh process, asking here: {}",
                    e.message
                ),
            }
        }
        PermissionReport {
            required: true,
            accessibility: super::tcc::accessibility_granted(),
            screen_recording: super::tcc::screen_recording_granted(),
        }
    }

    /// Refuse an op up front when the helper lacks the permission it needs,
    /// so the answer names the permission instead of being whatever the
    /// driver makes of a failed system call.
    async fn require(&self, permission: OsPermission) -> Result<(), HelperError> {
        if self.permissions(false).await.has(permission) {
            Ok(())
        } else {
            Err(HelperError::permission_missing(permission))
        }
    }

    /// Kill the driver now, whatever it is doing — unlike [`shutdown`], it
    /// is given no time to finish what it is in the middle of. Every call
    /// waiting on it fails at once. A driver still starting cannot be in the
    /// middle of anything; it stops itself when it finishes starting (see
    /// [`driver`](Self::driver)).
    ///
    /// [`shutdown`]: Self::shutdown
    async fn halt(&self) {
        self.halted.store(true, Ordering::Release);
        let driver = self.driver.lock().await.take();
        self.snapshots().clear();
        self.forget_driver_saw();
        if let Some(driver) = driver {
            driver.kill().await;
        }
    }
}

/// Whether a remembered answer still stands: one that both permissions are
/// granted does until a driver call says otherwise; one that something is
/// missing, for [`RECHECK_MISSING`].
#[cfg(any(test, target_os = "macos"))]
fn answer_stands(report: &PermissionReport, age: Duration) -> bool {
    (report.accessibility && report.screen_recording) || age < RECHECK_MISSING
}

/// Whether `now` grants something `before` did not.
fn gained(before: &PermissionReport, now: &PermissionReport) -> bool {
    (now.accessibility && !before.accessibility)
        || (now.screen_recording && !before.screen_recording)
}

/// Serve one op. A driver call that turns out to lack a permission the
/// remembered answer says is granted clears that answer, so the next call
/// asks the system again rather than going on believing it. (A refusal that
/// came from the remembered answer itself leaves it be: it is asked again on
/// its own schedule.)
async fn handle(state: &HelperState, op: HelperOp) -> Result<serde_json::Value, HelperError> {
    let result = handle_op(state, op).await;
    if let Err(HelperError {
        code: HelperErrorCode::PermissionMissing,
        permission: Some(permission),
        ..
    }) = &result
    {
        let mut last = state.permissions.lock().await;
        if last
            .as_ref()
            .is_some_and(|(report, _)| report.has(*permission))
        {
            last.take();
        }
    }
    result
}

async fn handle_op(state: &HelperState, op: HelperOp) -> Result<serde_json::Value, HelperError> {
    fn value(v: impl serde::Serialize) -> Result<serde_json::Value, HelperError> {
        serde_json::to_value(v).map_err(|e| HelperError::failed(format!("encode: {e}")))
    }
    match op {
        HelperOp::Configure {
            driver_path,
            driver_version,
        } => {
            if driver_version != driver::DRIVER_VERSION {
                return Err(HelperError::new(
                    HelperErrorCode::BadRequest,
                    format!(
                        "this helper runs cua-driver {}, not {driver_version}",
                        driver::DRIVER_VERSION
                    ),
                ));
            }
            let path = PathBuf::from(driver_path);
            let mut current = state.driver_path.lock().await;
            if current.as_ref() != Some(&path) {
                *current = Some(path);
                drop(current);
                // A driver started from another path is not the one codeg now
                // names; stop it, and the next call starts the right one.
                state.shutdown().await;
            }
            value(())
        }
        HelperOp::Permissions => value(state.permissions(true).await),
        HelperOp::RequestPermission { permission } => {
            let prompts = state.prompts.clone();
            let _ = tokio::task::spawn_blocking(move || prompts.request(permission)).await;
            value(state.permissions(true).await)
        }
        HelperOp::ListApps => {
            let driver = state.driver().await?;
            value(ops::list_apps(&driver, &state.apps).await?)
        }
        HelperOp::ListWindows { pid } => {
            let driver = state.driver().await?;
            value(ops::list_windows(&driver, &state.apps, pid).await?)
        }
        HelperOp::ProcessStart { pid } => value(super::procinfo::process_start(pid)),
        HelperOp::Capture {
            pid,
            window_id,
            max_dimension,
        } => {
            state.require(OsPermission::ScreenRecording).await?;
            let driver = state.driver().await?;
            value(ops::capture(&driver, pid, window_id, max_dimension).await?)
        }
        HelperOp::Snapshot {
            pid,
            window_id,
            max_depth,
            max_elements,
            query,
        } => {
            state.require(OsPermission::Accessibility).await?;
            let driver = state.driver().await?;
            let (raw, facts) =
                ops::snapshot(&driver, pid, window_id, max_depth, max_elements, query).await?;
            state.snapshots().record(pid, window_id, facts);
            value(raw)
        }
        HelperOp::Verify {
            pid,
            window_id,
            request,
        } => {
            if request.expect.iter().any(|p| p.element.is_some()) {
                state.require(OsPermission::Accessibility).await?;
            }
            let driver = state.driver().await?;
            value(ops::verify(&driver, pid, window_id, &request).await?)
        }
        HelperOp::Act {
            pid,
            window_id,
            started_at,
            app_key,
            action,
        } => {
            // Asked first so a doomed action does not start a driver, and
            // again (inside `act`) just before each driver call goes out —
            // starting the driver and measuring the window take time in which
            // the screen can lock or the application quit.
            state.deliverable(pid, started_at)?;
            for permission in act::permissions_for(&action) {
                state.require(*permission).await?;
            }
            let driver = state.driver().await?;
            let element_frame = {
                let book = state.snapshots();
                book.check(pid, window_id, &action, app_key.as_deref())?;
                action
                    .element()
                    .and_then(|element| book.frame(pid, window_id, element))
            };
            let window_frame = match action.point() {
                Some(point) => act::check_point(&driver, pid, window_id, point).await?,
                None => None,
            };
            let deliverable = || state.deliverable(pid, started_at);
            let done = act::act(&driver, pid, window_id, &action, &deliverable).await?;
            value(RawAct {
                element_frame,
                window_frame,
                ..done
            })
        }
        HelperOp::Halt => {
            state.halt().await;
            value(())
        }
        HelperOp::Resume => {
            state.halted.store(false, Ordering::Release);
            value(())
        }
    }
}

/// Encode one message, or — for a reply too large for the channel — the
/// refusal that says so, so an oversized capture costs the caller one answer
/// rather than the connection.
fn encode(message: &HelperMessage) -> Vec<u8> {
    let bytes = serde_json::to_vec(message).unwrap_or_default();
    if bytes.len() <= MAX_FRAME_BYTES {
        return bytes;
    }
    let id = match message {
        HelperMessage::Reply(reply) => reply.id,
        HelperMessage::Ready(_) => 0,
    };
    serde_json::to_vec(&HelperMessage::Reply(HelperReply::error(
        id,
        HelperError::failed(format!(
            "the answer was {} bytes, more than the {MAX_FRAME_BYTES} a reply can carry; ask for a \
             smaller image",
            bytes.len()
        )),
    )))
    .unwrap_or_default()
}

/// How long, once codeg has gone, the helper waits for its driver to stop
/// before it exits anyway (the driver then sees its stdin close and exits on
/// its own). Long enough for a driver still starting to finish starting and
/// be stopped: past the file hash (after which a launch that meets a Stop
/// spawns nothing — see `DriverProc::launch`), a start is bounded by the
/// driver's handshake and configuration; one already running stops in
/// seconds.
const SHUTDOWN_GRACE: Duration = Duration::from_secs(60);

/// Serve requests until codeg closes its end. Returns the exit code.
///
/// `guard`, when there is one, is asked before each request is acted on;
/// a request from anyone but the codeg that was checked ends the session.
pub async fn serve(
    mut reader: Box<dyn AsyncRead + Send + Unpin>,
    mut writer: Box<dyn AsyncWrite + Send + Unpin>,
    peer: PeerCheck,
    guard: Option<PeerGuard>,
    prompts: Arc<dyn PermissionPrompts>,
) -> i32 {
    let (tx, mut rx) = mpsc::unbounded_channel::<HelperMessage>();
    let writer_task = tokio::spawn(async move {
        while let Some(message) = rx.recv().await {
            let bytes = encode(&message);
            let len = (bytes.len() as u32).to_le_bytes();
            if writer.write_all(&len).await.is_err()
                || writer.write_all(&bytes).await.is_err()
                || writer.flush().await.is_err()
            {
                break;
            }
        }
    });

    let _ = tx.send(HelperMessage::Ready(HelperReady {
        protocol: PROTOCOL_VERSION,
        version: env!("CARGO_PKG_VERSION").to_string(),
        peer,
        source: Some(SOURCE_FINGERPRINT.to_string()),
    }));

    let state = Arc::new(HelperState {
        prompts,
        driver_path: Mutex::new(None),
        driver: Mutex::new(None),
        apps: Mutex::new(AppCache::default()),
        snapshots: std::sync::Mutex::new(SnapshotBook::default()),
        halted: AtomicBool::new(false),
        permissions: Mutex::new(None),
        driver_saw: std::sync::Mutex::new(None),
        driver_stale: AtomicBool::new(false),
    });
    let mut code = EXIT_OK;
    loop {
        let request: HelperRequest = match read_frame(&mut reader).await {
            Ok(request) => request,
            Err(e) if e.kind() == std::io::ErrorKind::UnexpectedEof => break,
            Err(e) => {
                // A frame that does not parse is not a request from the codeg
                // this helper was built with; stop rather than guess.
                tracing::error!("unreadable request: {e}");
                code = EXIT_FAILED;
                break;
            }
        };
        if guard.as_ref().is_some_and(|g| !g.still_peer()) {
            tracing::error!("a request came from a process other than the codeg that was checked");
            code = EXIT_PEER_REFUSED;
            break;
        }
        // A Stop takes hold the moment its frame is read, not when its task
        // is scheduled: an action already on its way meets it at the next
        // check it makes before a driver call.
        if matches!(request.op, HelperOp::Halt) {
            state.halted.store(true, Ordering::Release);
        }
        let state = state.clone();
        let tx = tx.clone();
        tokio::spawn(async move {
            let reply = match handle(&state, request.op).await {
                Ok(value) => HelperReply {
                    id: request.id,
                    ok: Some(value),
                    error: None,
                },
                Err(error) => HelperReply::error(request.id, error),
            };
            let _ = tx.send(HelperMessage::Reply(reply));
        });
    }
    // codeg is gone (or refused): stop the driver, and do not wait on the
    // requests still in flight — one may be parked on a permission prompt
    // the person never answers, and nobody is left to answer anyway. As for
    // a Stop, a driver still starting stops itself once it has started.
    state.halted.store(true, Ordering::Release);
    if tokio::time::timeout(SHUTDOWN_GRACE, state.shutdown())
        .await
        .is_err()
    {
        tracing::warn!("the driver did not stop in time; leaving it to its closed stdin");
    }
    writer_task.abort();
    code
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::computer::protocol::write_frame;

    struct NoPrompts;
    impl PermissionPrompts for NoPrompts {
        fn request(&self, _permission: OsPermission) {}
    }

    async fn start() -> (
        tokio::task::JoinHandle<i32>,
        tokio::io::WriteHalf<tokio::io::DuplexStream>,
        tokio::io::ReadHalf<tokio::io::DuplexStream>,
    ) {
        let (ours, theirs) = tokio::io::duplex(1 << 20);
        let (their_read, their_write) = tokio::io::split(theirs);
        let (our_read, our_write) = tokio::io::split(ours);
        let task = tokio::spawn(serve(
            Box::new(their_read),
            Box::new(their_write),
            PeerCheck::Development,
            None,
            Arc::new(NoPrompts),
        ));
        (task, our_write, our_read)
    }

    /// The helper speaks first, answers by id, refuses an op that needs the
    /// driver before it is told where the driver is, and exits cleanly when
    /// its peer closes.
    #[tokio::test]
    async fn the_helper_greets_first_and_answers_by_id() {
        let (task, mut to_helper, mut from_helper) = start().await;
        let ready: HelperMessage = read_frame(&mut from_helper).await.unwrap();
        assert!(matches!(
            ready,
            HelperMessage::Ready(HelperReady {
                protocol: PROTOCOL_VERSION,
                peer: PeerCheck::Development,
                source: Some(ref source),
                ..
            }) if source == SOURCE_FINGERPRINT
        ));

        write_frame(
            &mut to_helper,
            &HelperRequest {
                id: 7,
                op: HelperOp::ListApps,
            },
        )
        .await
        .unwrap();
        let HelperMessage::Reply(reply) = read_frame(&mut from_helper).await.unwrap() else {
            panic!("expected a reply");
        };
        assert_eq!(reply.id, 7);
        assert_eq!(reply.error.unwrap().code, HelperErrorCode::NotConfigured);

        write_frame(
            &mut to_helper,
            &HelperRequest {
                id: 8,
                op: HelperOp::ProcessStart {
                    pid: std::process::id(),
                },
            },
        )
        .await
        .unwrap();
        let HelperMessage::Reply(reply) = read_frame(&mut from_helper).await.unwrap() else {
            panic!("expected a reply");
        };
        assert_eq!(reply.id, 8);
        assert!(reply.decode::<Option<u64>>().unwrap().is_some());

        // A half of a duplex stream closes the direction only when told to;
        // dropping it while the read half lives would leave the helper
        // waiting on a peer that is still, as far as it can tell, there.
        to_helper.shutdown().await.unwrap();
        assert_eq!(task.await.unwrap(), EXIT_OK);
    }

    /// After a Stop, nothing that needs the driver runs — reads and actions
    /// alike — until codeg resumes; then the next call goes on as before.
    #[tokio::test]
    async fn a_stopped_helper_runs_no_driver_until_resumed() {
        use crate::computer::keys::{Chord, Key, Modifiers};
        use crate::computer::protocol::WindowAction;
        async fn ask(
            to: &mut tokio::io::WriteHalf<tokio::io::DuplexStream>,
            from: &mut tokio::io::ReadHalf<tokio::io::DuplexStream>,
            id: u64,
            op: HelperOp,
        ) -> HelperReply {
            write_frame(to, &HelperRequest { id, op }).await.unwrap();
            let HelperMessage::Reply(reply) = read_frame(from).await.unwrap() else {
                panic!("expected a reply");
            };
            assert_eq!(reply.id, id);
            reply
        }
        let (task, mut to_helper, mut from_helper) = start().await;
        let _ready: HelperMessage = read_frame(&mut from_helper).await.unwrap();
        let (to, from) = (&mut to_helper, &mut from_helper);
        assert!(ask(to, from, 1, HelperOp::Halt).await.error.is_none());
        assert_eq!(
            ask(to, from, 2, HelperOp::ListApps)
                .await
                .error
                .unwrap()
                .code,
            HelperErrorCode::Paused
        );
        let act = HelperOp::Act {
            pid: std::process::id(),
            window_id: 1,
            started_at: crate::computer::procinfo::process_start(std::process::id()).unwrap(),
            app_key: None,
            action: WindowAction::Key {
                element: None,
                chord: Chord {
                    key: Key::Return,
                    modifiers: Modifiers::default(),
                },
            },
        };
        assert_eq!(
            ask(to, from, 3, act).await.error.unwrap().code,
            HelperErrorCode::Paused
        );
        assert!(ask(to, from, 4, HelperOp::Resume).await.error.is_none());
        // Resumed: back to the ordinary answer for a helper with no driver.
        assert_eq!(
            ask(to, from, 5, HelperOp::ListApps)
                .await
                .error
                .unwrap()
                .code,
            HelperErrorCode::NotConfigured
        );
        to_helper.shutdown().await.unwrap();
        assert_eq!(task.await.unwrap(), EXIT_OK);
    }

    /// A remembered "granted" stands; a remembered "missing" is asked again
    /// once it is a moment old. Only a permission that appeared — not one that
    /// went, nor one that was there all along — makes the running driver stale.
    #[test]
    fn a_missing_permission_is_asked_again_and_a_new_one_restarts_the_driver() {
        let report = |accessibility, screen_recording| PermissionReport {
            required: true,
            accessibility,
            screen_recording,
        };
        let long = RECHECK_MISSING + Duration::from_millis(1);
        assert!(answer_stands(&report(true, true), long));
        assert!(answer_stands(&report(true, false), Duration::ZERO));
        assert!(!answer_stands(&report(true, false), long));
        assert!(!answer_stands(&report(false, false), long));

        assert!(gained(&report(true, false), &report(true, true)));
        assert!(gained(&report(false, true), &report(true, true)));
        assert!(!gained(&report(true, true), &report(true, true)));
        assert!(!gained(&report(true, true), &report(false, true)));
        assert!(!gained(&report(false, false), &report(false, false)));
    }

    /// An action for a pid that is not the process the window was shared
    /// from — a relaunch under a reused pid — is refused before anything
    /// else is looked at.
    #[tokio::test]
    async fn an_action_for_another_process_is_refused() {
        use crate::computer::keys::{Chord, Key, Modifiers};
        use crate::computer::protocol::WindowAction;
        let (task, mut to_helper, mut from_helper) = start().await;
        let _ready: HelperMessage = read_frame(&mut from_helper).await.unwrap();
        let started_at = crate::computer::procinfo::process_start(std::process::id()).unwrap();
        write_frame(
            &mut to_helper,
            &HelperRequest {
                id: 1,
                op: HelperOp::Act {
                    pid: std::process::id(),
                    window_id: 1,
                    started_at: started_at.wrapping_add(1),
                    app_key: None,
                    action: WindowAction::Key {
                        element: None,
                        chord: Chord {
                            key: Key::Escape,
                            modifiers: Modifiers::default(),
                        },
                    },
                },
            },
        )
        .await
        .unwrap();
        let HelperMessage::Reply(reply) = read_frame(&mut from_helper).await.unwrap() else {
            panic!("expected a reply");
        };
        assert_eq!(reply.error.unwrap().code, HelperErrorCode::NoSuchWindow);
        to_helper.shutdown().await.unwrap();
        assert_eq!(task.await.unwrap(), EXIT_OK);
    }

    /// A configure for another driver release is refused rather than trusted.
    #[tokio::test]
    async fn a_configure_for_another_release_is_refused() {
        let (task, mut to_helper, mut from_helper) = start().await;
        let _ready: HelperMessage = read_frame(&mut from_helper).await.unwrap();
        write_frame(
            &mut to_helper,
            &HelperRequest {
                id: 1,
                op: HelperOp::Configure {
                    driver_path: "/tmp/cua-driver".into(),
                    driver_version: "0.0.1".into(),
                },
            },
        )
        .await
        .unwrap();
        let HelperMessage::Reply(reply) = read_frame(&mut from_helper).await.unwrap() else {
            panic!("expected a reply");
        };
        assert_eq!(reply.error.unwrap().code, HelperErrorCode::BadRequest);
        // A half of a duplex stream closes the direction only when told to;
        // dropping it while the read half lives would leave the helper
        // waiting on a peer that is still, as far as it can tell, there.
        to_helper.shutdown().await.unwrap();
        assert_eq!(task.await.unwrap(), EXIT_OK);
    }

    /// A reply too large for the channel becomes a refusal that says so,
    /// under the same id.
    #[test]
    fn an_oversized_reply_is_replaced_not_sent() {
        let huge = HelperMessage::Reply(HelperReply::ok(9, "x".repeat(MAX_FRAME_BYTES + 1)));
        let bytes = encode(&huge);
        assert!(bytes.len() < 1024);
        let HelperMessage::Reply(reply) = serde_json::from_slice(&bytes).unwrap() else {
            panic!("expected a reply");
        };
        assert_eq!(reply.id, 9);
        assert!(reply.error.unwrap().message.contains("more than"));
    }

    struct ParkedPrompts(std::sync::Mutex<std::sync::mpsc::Receiver<()>>);
    impl PermissionPrompts for ParkedPrompts {
        fn request(&self, _permission: OsPermission) {
            let _ = self.0.lock().unwrap().recv();
        }
    }

    /// A request that never finishes — a permission prompt nobody answers —
    /// does not keep the helper alive once codeg has gone.
    #[tokio::test]
    async fn the_helper_leaves_with_codeg_even_mid_request() {
        let (release, parked) = std::sync::mpsc::channel::<()>();
        let (ours, theirs) = tokio::io::duplex(1 << 20);
        let (their_read, their_write) = tokio::io::split(theirs);
        let (mut from_helper, mut to_helper) = tokio::io::split(ours);
        let task = tokio::spawn(serve(
            Box::new(their_read),
            Box::new(their_write),
            PeerCheck::Development,
            None,
            Arc::new(ParkedPrompts(std::sync::Mutex::new(parked))),
        ));
        let _ready: HelperMessage = read_frame(&mut from_helper).await.unwrap();
        write_frame(
            &mut to_helper,
            &HelperRequest {
                id: 1,
                op: HelperOp::RequestPermission {
                    permission: OsPermission::Accessibility,
                },
            },
        )
        .await
        .unwrap();
        tokio::time::sleep(Duration::from_millis(50)).await;
        to_helper.shutdown().await.unwrap();
        let code = tokio::time::timeout(Duration::from_secs(10), task)
            .await
            .expect("the helper exits")
            .unwrap();
        assert_eq!(code, EXIT_OK);
        drop(release);
    }

    /// The same, for the helper process as it really runs — on a runtime of
    /// its own, whose drop would otherwise wait for the parked request.
    #[test]
    fn the_helper_process_leaves_with_codeg_even_mid_request() {
        let (release, parked) = std::sync::mpsc::channel::<()>();
        let (ours, theirs) = tokio::io::duplex(1 << 20);
        let helper = std::thread::spawn(move || {
            serve_on_own_runtime(
                move || {
                    let (read, write) = tokio::io::split(theirs);
                    Ok((
                        Box::new(read) as Box<dyn AsyncRead + Send + Unpin>,
                        Box::new(write) as Box<dyn AsyncWrite + Send + Unpin>,
                    ))
                },
                PeerCheck::Development,
                None,
                Arc::new(ParkedPrompts(std::sync::Mutex::new(parked))),
            )
        });
        let codeg = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        codeg.block_on(async {
            let (mut from_helper, mut to_helper) = tokio::io::split(ours);
            let _ready: HelperMessage = read_frame(&mut from_helper).await.unwrap();
            write_frame(
                &mut to_helper,
                &HelperRequest {
                    id: 1,
                    op: HelperOp::RequestPermission {
                        permission: OsPermission::ScreenRecording,
                    },
                },
            )
            .await
            .unwrap();
            tokio::time::sleep(Duration::from_millis(50)).await;
            to_helper.shutdown().await.unwrap();
        });
        let started = std::time::Instant::now();
        while !helper.is_finished() {
            assert!(
                started.elapsed() < Duration::from_secs(10),
                "the helper is still waiting on the parked request"
            );
            std::thread::sleep(Duration::from_millis(20));
        }
        assert_eq!(helper.join().unwrap(), EXIT_OK);
        drop(release);
    }
}
