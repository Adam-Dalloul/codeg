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

pub mod driver_proc;
pub mod mcp;
pub mod ops;

use std::path::PathBuf;
use std::sync::Arc;

use tokio::io::{AsyncRead, AsyncWrite, AsyncWriteExt};
use tokio::sync::{mpsc, Mutex};

use self::driver_proc::DriverProc;
use self::ops::AppCache;
use super::driver;
use super::protocol::{
    read_frame, HelperError, HelperErrorCode, HelperMessage, HelperOp, HelperReady, HelperReply,
    HelperRequest, OsPermission, PeerCheck, PermissionReport, MAX_FRAME_BYTES, PROTOCOL_VERSION,
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
    // codeg happened to be started. Done before any thread exists.
    if let Some(dir) = driver_proc::helper_data_dir() {
        if std::fs::create_dir_all(&dir).is_ok() {
            let _ = std::env::set_current_dir(&dir);
        }
    }

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
    runtime.block_on(async move {
        let (reader, writer) = match channel.raw.into_tokio() {
            Ok(halves) => halves,
            Err(e) => {
                tracing::error!("could not open the channel: {e}");
                return EXIT_FAILED;
            }
        };
        serve(reader, writer, channel.peer, Arc::new(prompts)).await
    })
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
}

/// Decide who is on the other end of stdin, before anything is read from it.
#[cfg(target_os = "macos")]
fn open_channel() -> Result<Channel, (i32, String)> {
    use super::codesign::{check_guest, peer_audit_token, self_info, Guest};

    let requirement = PEER_REQUIREMENT.filter(|r| !r.trim().is_empty());
    if requirement.is_none() {
        if let Ok(me) = self_info() {
            if me.team_id.is_some() {
                return Err((
                    EXIT_UNANCHORED,
                    "this helper is signed with a Team ID but was built without codeg's \
                     designated requirement; it would serve any caller"
                        .into(),
                ));
            }
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
                })
            }
        };
    }
    let peer = match requirement {
        Some(requirement) => {
            // Replies go back down the socket the requests came in on, never
            // to a descriptor someone else wired up as stdout.
            if !same_file(0, 1) {
                return Err((EXIT_PEER_REFUSED, "stdout is not the stdin socket".into()));
            }
            let token = peer_audit_token(0)
                .map_err(|e| (EXIT_PEER_REFUSED, format!("no peer token: {e}")))?;
            let info = check_guest(Guest::Audit(token), requirement)
                .map_err(|e| (EXIT_PEER_REFUSED, format!("the peer is not codeg: {e}")))?;
            info.entitlements_clean().map_err(|e| {
                (
                    EXIT_PEER_REFUSED,
                    format!("the peer is not a codeg this helper serves: {e}"),
                )
            })?;
            PeerCheck::Verified
        }
        None => {
            tracing::warn!("development build: serving without checking the peer's signature");
            PeerCheck::Development
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
    })
}

#[cfg(not(target_os = "macos"))]
fn open_channel() -> Result<Channel, (i32, String)> {
    Ok(Channel {
        raw: RawChannel::Stdio,
        peer: PeerCheck::NotApplicable,
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

/// What the running helper holds between requests.
struct HelperState {
    prompts: Arc<dyn PermissionPrompts>,
    /// Set by `Configure`.
    driver_path: Mutex<Option<PathBuf>>,
    /// The running driver, started on first use and again after it exits.
    driver: Mutex<Option<Arc<DriverProc>>>,
    apps: Mutex<AppCache>,
}

impl HelperState {
    /// The running driver, starting it if there is none.
    async fn driver(&self) -> Result<Arc<DriverProc>, HelperError> {
        let mut slot = self.driver.lock().await;
        if let Some(driver) = slot.as_ref().filter(|d| d.alive()) {
            return Ok(driver.clone());
        }
        if let Some(dead) = slot.take() {
            dead.shutdown().await;
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
        let launched = Arc::new(DriverProc::launch(&path, artifact).await?);
        *slot = Some(launched.clone());
        Ok(launched)
    }

    async fn shutdown(&self) {
        if let Some(driver) = self.driver.lock().await.take() {
            driver.shutdown().await;
        }
    }
}

fn permission_report() -> PermissionReport {
    #[cfg(target_os = "macos")]
    {
        PermissionReport {
            required: true,
            accessibility: super::tcc::accessibility_granted(),
            screen_recording: super::tcc::screen_recording_granted(),
        }
    }
    #[cfg(not(target_os = "macos"))]
    {
        PermissionReport {
            required: false,
            accessibility: true,
            screen_recording: true,
        }
    }
}

/// Refuse an op up front when the helper lacks the permission it needs, so the
/// answer names the permission instead of being whatever the driver makes of
/// a failed system call.
fn require(permission: OsPermission) -> Result<(), HelperError> {
    let report = permission_report();
    let granted = match permission {
        OsPermission::Accessibility => report.accessibility,
        OsPermission::ScreenRecording => report.screen_recording,
    };
    if granted {
        Ok(())
    } else {
        Err(HelperError::permission_missing(permission))
    }
}

async fn handle(state: &HelperState, op: HelperOp) -> Result<serde_json::Value, HelperError> {
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
        HelperOp::Permissions => value(permission_report()),
        HelperOp::RequestPermission { permission } => {
            let prompts = state.prompts.clone();
            let _ = tokio::task::spawn_blocking(move || prompts.request(permission)).await;
            value(permission_report())
        }
        HelperOp::ListApps => value(ops::list_apps(&*state.driver().await?).await?),
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
            require(OsPermission::ScreenRecording)?;
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
            require(OsPermission::Accessibility)?;
            let driver = state.driver().await?;
            value(ops::snapshot(&driver, pid, window_id, max_depth, max_elements, query).await?)
        }
        HelperOp::Verify {
            pid,
            window_id,
            request,
        } => {
            if request.expect.iter().any(|p| p.element.is_some()) {
                require(OsPermission::Accessibility)?;
            }
            let driver = state.driver().await?;
            value(ops::verify(&driver, pid, window_id, &request).await?)
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

/// Serve requests until codeg closes its end. Returns the exit code.
pub async fn serve(
    mut reader: Box<dyn AsyncRead + Send + Unpin>,
    mut writer: Box<dyn AsyncWrite + Send + Unpin>,
    peer: PeerCheck,
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
    }));

    let state = Arc::new(HelperState {
        prompts,
        driver_path: Mutex::new(None),
        driver: Mutex::new(None),
        apps: Mutex::new(AppCache::default()),
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
    state.shutdown().await;
    drop(tx);
    let _ = writer_task.await;
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
                ..
            })
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
}
