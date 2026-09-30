//! codeg's table of the windows it has named to an agent, with the grant on
//! each.
//!
//! A browser tab is an object codeg owns, so its grant can live on the tab. A
//! native window is not — it belongs to another process and codeg only ever
//! sees it through the helper — so this table is the object the grant lives
//! on: one entry per window codeg has handed out a `targetId` for, keyed by
//! the window's identity, with the grant, the grant epoch and the read counter
//! under the same lock. "Is this still the window that was shared" and "is it
//! still shared" are then one question asked in one place.
//!
//! **Identity is `(pid, process start time, window id)`.** A pid alone is
//! reused; an application relaunched is a new process whose windows were never
//! shared, even when they look the same. A window whose identity no longer
//! turns up in a listing is gone, and so is its grant.

use std::collections::{BTreeSet, HashMap};
use std::sync::Mutex;
use std::time::Duration;

use serde::{Deserialize, Serialize};

use super::agent::{
    generation, grantable, level_of, visible_title, Blocklist, ComputerGrant, ComputerGrantPayload,
    GrantChange, GrantLevel, NotGrantable, SelfIdentity,
};
use super::keys::{classify, Chord, ChordClass, Platform};
use super::protocol::{
    DriverTarget, ElementRef, RawAct, RawApp, RawWindow, WindowAction, WindowPoint,
};
use super::types::{
    AgentAppRef, AgentTarget, AgentWindowSummary, ComputerActRequest, ElementTarget, PointTarget,
    Rect,
};

/// Which window, exactly. See the module note.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowIdentity {
    pub pid: u32,
    /// `None` when the platform would not say; such a window is still
    /// listed, and matched on the other two fields alone.
    pub started_at: Option<u64>,
    pub window_id: u64,
}

impl WindowIdentity {
    fn of(window: &RawWindow) -> Self {
        Self {
            pid: window.pid,
            started_at: window.app.started_at,
            window_id: window.window_id,
        }
    }
}

/// One window codeg has named.
#[derive(Debug, Clone, PartialEq)]
pub struct TargetEntry {
    pub target_id: String,
    pub identity: WindowIdentity,
    pub app: RawApp,
    /// The title as last seen. Handed to an agent only through
    /// [`visible_title`]; shown to the person in codeg's own UI.
    pub title: String,
    pub bounds: Rect,
    pub on_screen: bool,
    pub minimized: Option<bool>,
    pub on_current_space: Option<bool>,
    pub grant: Option<ComputerGrant>,
    /// Moves on every transition into or out of a grant, so a generation
    /// minted under one grant never names a read made under another.
    pub epoch: u64,
    /// Reads completed under the current epoch.
    pub reads: u64,
    /// The latest snapshot read under the current grant: what a ref is
    /// resolved against.
    pub snapshot_mark: Option<SnapshotMark>,
    /// The latest screenshot read under the current grant: what a point is
    /// read in.
    pub capture_mark: Option<CaptureMark>,
    /// The window stopped turning up while it was shared. Kept, grant-less,
    /// so a later call on its id is told "not shared" — the same answer as a
    /// window nobody shared, as the browser answers for a tab that navigated
    /// away — rather than "no such window", which would make an id that was
    /// once valid look like one the agent invented.
    pub gone: bool,
}

impl TargetEntry {
    /// Whether this window belongs in a listing: on screen, minimized, on
    /// another Space, or shared. What that leaves out is the invisible
    /// furniture every desktop is full of — an application's hidden helper
    /// windows, the Finder's off-screen desktop strips — which nobody means to
    /// share and a picker full of would hide the ones they do. A shared window
    /// stays listed whatever its visibility (its application may just be
    /// hidden), so that its sharing is never out of sight.
    pub fn worth_listing(&self) -> bool {
        self.on_screen
            || self.minimized == Some(true)
            || self.on_current_space == Some(false)
            || self.grant.is_some()
    }

    /// The window as an agent may see it.
    pub fn agent_summary(&self, me: &SelfIdentity, blocklist: &Blocklist) -> AgentWindowSummary {
        let level = level_of(self.grant.as_ref());
        AgentWindowSummary {
            target_id: self.target_id.clone(),
            app: AgentAppRef {
                key: self.app.key().unwrap_or_default().to_string(),
                name: self.app.name.clone(),
                pid: self.app.pid,
            },
            bounds: self.bounds,
            on_screen: self.on_screen,
            minimized: self.minimized,
            level,
            title: visible_title(level, &self.title),
            note: grantable(&self.app, me, blocklist)
                .err()
                .map(|why| why.note().to_string()),
        }
    }
}

/// A shared window, for codeg's own UI.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SharedWindow {
    pub target_id: String,
    pub app_name: String,
    pub app_key: String,
    pub title: String,
    pub level: GrantLevel,
    pub granted_at: i64,
    pub last_used_at: i64,
}

/// The latest snapshot an agent read of a window: the generation that named
/// it, and which of its elements the agent may now act on.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SnapshotMark {
    pub generation: String,
    /// The driver's id for the snapshot; `None` when it kept none, and
    /// nothing in the tree can be acted on.
    pub snapshot_id: Option<String>,
    /// The refs whose lines the agent was given.
    pub shown: BTreeSet<u32>,
    /// The refs the tree had and the agent's copy was cut short of
    /// (`maxChars`): told apart from refs that never were, so the refusal can
    /// say which.
    pub cut: BTreeSet<u32>,
    /// The refs of secret fields.
    pub secret: BTreeSet<u32>,
}

/// The latest screenshot an agent read of a window: the generation that
/// named it, and the geometry a point read off it is mapped back through.
#[derive(Debug, Clone, PartialEq)]
pub struct CaptureMark {
    pub generation: String,
    /// The image as the agent got it.
    pub width: u32,
    pub height: u32,
    /// The window's own pixels, which the image was shrunk from.
    pub native_width: u32,
    pub native_height: u32,
    /// Whether the native size is known to be the window's full size (see
    /// `RawCapture::full_size`). Points need it.
    pub full_size: bool,
    pub window_bounds: Rect,
}

/// What a read leaves behind for later actions, before it has a generation.
#[derive(Debug, Clone, PartialEq)]
pub enum ReadMark {
    Snapshot {
        snapshot_id: Option<String>,
        shown: BTreeSet<u32>,
        cut: BTreeSet<u32>,
        secret: BTreeSet<u32>,
    },
    Capture {
        width: u32,
        height: u32,
        native_width: u32,
        native_height: u32,
        full_size: bool,
        window_bounds: Rect,
    },
}

/// Why a read may not go ahead.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ReadRefusal {
    /// codeg never named a window by this id.
    NoSuchTarget,
    /// The window is not shared — never was, no longer is, or has gone.
    GrantRequired,
    /// The window can never be shared.
    NotGrantable(NotGrantable),
}

/// Permission for one read, taken before the read and checked again after.
#[derive(Debug, Clone, PartialEq)]
pub struct ReadTicket {
    pub target_id: String,
    pub identity: WindowIdentity,
    pub epoch: u64,
    pub app: RawApp,
    pub bounds: Rect,
}

/// Why an action may not go ahead, before anything is sent.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ActDenied {
    /// codeg never named a window by this id.
    NoSuchTarget,
    /// Not shared — never was, no longer is, or gone.
    GrantRequired,
    /// Shared for reading only.
    ControlRequired,
    /// The window can never be shared.
    NotGrantable(NotGrantable),
    /// A ref or point that is not from the window's latest snapshot or
    /// screenshot, or not in it.
    Stale(Staleness),
    /// A point outside the image it was read off.
    OutOfImage,
    /// Text into a secret field.
    Secret,
    /// A key a window grant does not reach — it acts on the application or
    /// the desktop.
    ChordBeyond,
    /// A paste: the clipboard is the user's, and its source is not tracked.
    Paste,
    /// A character key with no element named to type it into.
    NeedsElement,
    /// The screenshot the point came from cannot be mapped back to the
    /// window's pixels.
    NoPointing,
}

/// How a ref or point is out of date.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Staleness {
    /// No snapshot has been read under the current sharing.
    NoSnapshot,
    /// The generation is not the latest snapshot's.
    OldSnapshot,
    /// The driver kept no snapshot of the window: nothing in the tree can be
    /// acted on.
    NotActionable,
    /// The ref was in the tree, past where the agent's copy was cut.
    CutAway(u32),
    /// The latest snapshot has no such ref.
    NoSuchRef(u32),
    /// No screenshot has been read under the current sharing.
    NoCapture,
    /// The generation is not the latest screenshot's.
    OldCapture,
}

/// Permission for one action, with the action as the helper is to carry it
/// out: every ref and point resolved against what the agent last read.
#[derive(Debug, Clone, PartialEq)]
pub struct ActTicket {
    pub target_id: String,
    pub identity: WindowIdentity,
    pub app: RawApp,
    pub action: WindowAction,
    pub aim: Aim,
}

/// Where on the screen an action lands, as far as codeg can place it once
/// the helper says where it aimed. For the marker that shows the person
/// where an agent acted; nothing is decided by it.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Aim {
    /// Wherever the window's focus is: a key with no element, a scroll with
    /// no target.
    Focus,
    /// At the element, where its snapshot found it.
    Element,
    /// This far from the window's top-left corner, in desktop units.
    Offset { x: f64, y: f64 },
}

impl Aim {
    /// Where `action` lands, from what the agent last read of the window:
    /// for a point, the screenshot's pixels scaled to the window's units.
    fn of(entry: &TargetEntry, action: &WindowAction) -> Aim {
        if action.element().is_some() {
            return Aim::Element;
        }
        match (action.point(), entry.capture_mark.as_ref()) {
            (Some(point), Some(mark)) if mark.native_width > 0 && mark.native_height > 0 => {
                Aim::Offset {
                    x: point.x * point.window_width / f64::from(mark.native_width),
                    y: point.y * point.window_height / f64::from(mark.native_height),
                }
            }
            _ => Aim::Focus,
        }
    }

    /// The point on the screen, in desktop units, from what the helper
    /// reported of the action: the middle of the element's frame, or the
    /// offset from where the window was measured to be.
    pub fn landing(&self, act: &RawAct) -> Option<(f64, f64)> {
        let placed = |r: &Rect| !r.is_empty() && r.x.is_finite() && r.y.is_finite();
        match *self {
            Aim::Focus => None,
            Aim::Element => act
                .element_frame
                .filter(placed)
                .map(|f| (f.x + f.width / 2.0, f.y + f.height / 2.0)),
            Aim::Offset { x, y } => act.window_frame.filter(placed).map(|w| (w.x + x, w.y + y)),
        }
    }
}

/// Why a share did not happen.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ShareError {
    NoSuchTarget,
    Gone,
    NotGrantable(NotGrantable),
}

#[derive(Default)]
struct Inner {
    next_id: u64,
    entries: HashMap<String, TargetEntry>,
    by_identity: HashMap<WindowIdentity, String>,
}

/// See the module note.
#[derive(Default)]
pub struct TargetTable {
    inner: Mutex<Inner>,
}

impl TargetTable {
    pub fn new() -> Self {
        Self::default()
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Inner> {
        // A panic while holding this lock cannot leave a half-written entry
        // (every mutation is a field store), so a poisoned lock is still a
        // consistent table.
        self.inner.lock().unwrap_or_else(|p| p.into_inner())
    }

    /// Take in a fresh listing: name every window in it, update what codeg
    /// knows about the ones it had named, and let go of the rest.
    ///
    /// `scope_pid` is the filter the listing was made with. Only windows in
    /// that scope can be judged missing from it — a listing of one
    /// application's windows says nothing about anyone else's.
    ///
    /// Returns the entries for the listed windows, in listing order, and the
    /// grants that ended because their window is gone.
    pub fn observe(
        &self,
        windows: &[RawWindow],
        scope_pid: Option<u32>,
    ) -> (Vec<TargetEntry>, Vec<ComputerGrantPayload>) {
        let mut inner = self.lock();
        let mut seen: Vec<String> = Vec::with_capacity(windows.len());
        for window in windows {
            let identity = WindowIdentity::of(window);
            let target_id = match inner.by_identity.get(&identity) {
                Some(id) => id.clone(),
                None => {
                    inner.next_id += 1;
                    let id = format!("w{}", inner.next_id);
                    inner.by_identity.insert(identity, id.clone());
                    inner.entries.insert(
                        id.clone(),
                        TargetEntry {
                            target_id: id.clone(),
                            identity,
                            app: window.app.clone(),
                            title: String::new(),
                            bounds: Rect::default(),
                            on_screen: false,
                            minimized: None,
                            on_current_space: None,
                            grant: None,
                            epoch: 0,
                            reads: 0,
                            snapshot_mark: None,
                            capture_mark: None,
                            gone: false,
                        },
                    );
                    id
                }
            };
            if let Some(entry) = inner.entries.get_mut(&target_id) {
                entry.app = window.app.clone();
                // An empty title is the platform withholding it (no Screen
                // Recording yet), not the window losing its name: keep the
                // last one the person could have seen.
                if !window.title.is_empty() {
                    entry.title = window.title.clone();
                }
                entry.bounds = window.bounds;
                entry.on_screen = window.on_screen;
                entry.minimized = window.minimized;
                entry.on_current_space = window.on_current_space;
            }
            seen.push(target_id);
        }

        let in_scope = |entry: &TargetEntry| scope_pid.is_none_or(|pid| entry.identity.pid == pid);
        let missing: Vec<String> = inner
            .entries
            .values()
            .filter(|e| !e.gone && in_scope(e) && !seen.contains(&e.target_id))
            .map(|e| e.target_id.clone())
            .collect();
        let mut ended = Vec::new();
        for id in missing {
            if let Some(payload) = Self::retire(&mut inner, &id, GrantChange::TargetChanged) {
                ended.push(payload);
            }
        }

        let entries = seen
            .iter()
            .filter_map(|id| inner.entries.get(id).cloned())
            .collect();
        (entries, ended)
    }

    /// A window is gone. A shared one keeps a grant-less entry (see
    /// [`TargetEntry::gone`]); an unshared one is forgotten.
    ///
    /// Idempotent, and it touches only what is this entry's own: a late
    /// "window gone" for an id that has already been retired — an operation
    /// that started before a listing retired it — leaves the entry, and the
    /// identity now named by a newer id, alone.
    fn retire(
        inner: &mut Inner,
        target_id: &str,
        change: GrantChange,
    ) -> Option<ComputerGrantPayload> {
        let entry = inner.entries.get_mut(target_id)?;
        if entry.gone {
            return None;
        }
        let identity = entry.identity;
        if inner.by_identity.get(&identity).map(String::as_str) == Some(target_id) {
            inner.by_identity.remove(&identity);
        }
        let entry = inner.entries.get_mut(target_id)?;
        if entry.grant.is_some() {
            entry.grant = None;
            entry.gone = true;
            entry.epoch += 1;
            entry.snapshot_mark = None;
            entry.capture_mark = None;
            Some(ComputerGrantPayload {
                target_id: target_id.to_string(),
                change,
                level: GrantLevel::None,
            })
        } else {
            inner.entries.remove(target_id);
            None
        }
    }

    /// The window a target id names, if codeg named one.
    pub fn get(&self, target_id: &str) -> Option<TargetEntry> {
        self.lock().entries.get(target_id).cloned()
    }

    /// Share a window at `level`, or stop sharing it at [`GrantLevel::None`].
    ///
    /// `Ok(None)` when nothing changed — the window was already at that level
    /// — so the caller neither emits an event nor restarts the idle clock.
    pub fn share(
        &self,
        target_id: &str,
        level: GrantLevel,
        now: i64,
        me: &SelfIdentity,
        blocklist: &Blocklist,
    ) -> Result<Option<ComputerGrantPayload>, ShareError> {
        let mut inner = self.lock();
        let entry = inner
            .entries
            .get_mut(target_id)
            .ok_or(ShareError::NoSuchTarget)?;
        if level == GrantLevel::None {
            return Ok(Self::revoke_entry(entry, GrantChange::Revoked));
        }
        if entry.gone {
            return Err(ShareError::Gone);
        }
        grantable(&entry.app, me, blocklist).map_err(ShareError::NotGrantable)?;
        if level_of(entry.grant.as_ref()) == level {
            return Ok(None);
        }
        match entry.grant.as_mut() {
            // A change of level on a live grant is the same grant: the reads
            // already made under it stay valid, and the clock keeps running
            // from the last one.
            Some(grant) => grant.level = level,
            None => {
                entry.grant = Some(ComputerGrant::new(level, now));
                entry.epoch += 1;
                entry.reads = 0;
                entry.snapshot_mark = None;
                entry.capture_mark = None;
            }
        }
        Ok(Some(ComputerGrantPayload {
            target_id: target_id.to_string(),
            change: GrantChange::Granted,
            level,
        }))
    }

    fn revoke_entry(entry: &mut TargetEntry, change: GrantChange) -> Option<ComputerGrantPayload> {
        entry.grant.take()?;
        entry.epoch += 1;
        entry.snapshot_mark = None;
        entry.capture_mark = None;
        Some(ComputerGrantPayload {
            target_id: entry.target_id.clone(),
            change,
            level: GrantLevel::None,
        })
    }

    /// End every grant, for one reason. Used when the user switches computer
    /// use off, which is a statement about every window at once.
    pub fn revoke_all(&self, change: GrantChange) -> Vec<ComputerGrantPayload> {
        let mut inner = self.lock();
        inner
            .entries
            .values_mut()
            .filter_map(|entry| Self::revoke_entry(entry, change))
            .collect()
    }

    /// The window is not the one that was shared any more (it closed, or its
    /// process is gone). Ends its grant, if it had one.
    pub fn target_changed(&self, target_id: &str) -> Option<ComputerGrantPayload> {
        let mut inner = self.lock();
        Self::retire(&mut inner, target_id, GrantChange::TargetChanged)
    }

    /// End every grant that no longer holds by the rules as they are now: gone
    /// unused for `ttl`, or on a window that can no longer be shared (its
    /// application joined the blocklist). Run before anything is listed, when
    /// the settings change and on a timer, so what an agent sees of a window
    /// never reflects a grant that has already ended.
    pub fn sweep(
        &self,
        now: i64,
        ttl: Option<Duration>,
        me: &SelfIdentity,
        blocklist: &Blocklist,
    ) -> Vec<ComputerGrantPayload> {
        let mut inner = self.lock();
        inner
            .entries
            .values_mut()
            .filter_map(|entry| {
                let grant = entry.grant.as_ref()?;
                if grantable(&entry.app, me, blocklist).is_err() {
                    Self::revoke_entry(entry, GrantChange::Revoked)
                } else if grant.lapsed(now, ttl) {
                    Self::revoke_entry(entry, GrantChange::Expired)
                } else {
                    None
                }
            })
            .collect()
    }

    /// Check a read may start: the window is one codeg named, it is shared,
    /// and the grant has not lapsed. A lapsed grant is ended here and its
    /// payload returned alongside the refusal, because the caller is the one
    /// holding an emitter.
    pub fn begin_read(
        &self,
        target_id: &str,
        now: i64,
        ttl: Option<Duration>,
        me: &SelfIdentity,
        blocklist: &Blocklist,
    ) -> Result<ReadTicket, (ReadRefusal, Option<ComputerGrantPayload>)> {
        let mut inner = self.lock();
        let Some(entry) = inner.entries.get_mut(target_id) else {
            return Err((ReadRefusal::NoSuchTarget, None));
        };
        // Checked even for a window that holds a grant: the blocklist can grow
        // while a window is shared, and the list is what the user said last.
        if let Err(why) = grantable(&entry.app, me, blocklist) {
            let ended = Self::revoke_entry(entry, GrantChange::Revoked);
            return Err((ReadRefusal::NotGrantable(why), ended));
        }
        let Some(grant) = entry.grant.as_mut() else {
            return Err((ReadRefusal::GrantRequired, None));
        };
        if grant.lapsed(now, ttl) {
            let ended = Self::revoke_entry(entry, GrantChange::Expired);
            return Err((ReadRefusal::GrantRequired, ended));
        }
        if !grant.level.allows(GrantLevel::Read) {
            return Err((ReadRefusal::GrantRequired, None));
        }
        grant.last_used_at = now;
        Ok(ReadTicket {
            target_id: entry.target_id.clone(),
            identity: entry.identity,
            epoch: entry.epoch,
            app: entry.app.clone(),
            bounds: entry.bounds,
        })
    }

    /// Check a read that has finished may be handed over: the same grant is
    /// still in force on the same window, and the window may still be shared
    /// by the rules as they are now. The person may have taken the grant back,
    /// or put the application on the blocklist, while the capture was in
    /// flight, and what the capture holds is exactly what they took back. A
    /// grant the blocklist now forbids is ended here, its payload returned for
    /// the caller to announce.
    ///
    /// Returns the generation that names this read. `mark`, when the read
    /// leaves one, becomes the window's latest snapshot or screenshot under
    /// that generation — what later actions resolve refs and points against.
    pub fn finish_read(
        &self,
        ticket: &ReadTicket,
        me: &SelfIdentity,
        blocklist: &Blocklist,
        mark: Option<ReadMark>,
    ) -> Result<String, (ReadRefusal, Option<ComputerGrantPayload>)> {
        let mut inner = self.lock();
        let Some(entry) = inner.entries.get_mut(&ticket.target_id) else {
            return Err((ReadRefusal::GrantRequired, None));
        };
        let still = entry.identity == ticket.identity
            && entry.epoch == ticket.epoch
            && level_of(entry.grant.as_ref()).allows(GrantLevel::Read);
        if !still {
            return Err((ReadRefusal::GrantRequired, None));
        }
        if let Err(why) = grantable(&entry.app, me, blocklist) {
            let ended = Self::revoke_entry(entry, GrantChange::Revoked);
            return Err((ReadRefusal::NotGrantable(why), ended));
        }
        entry.reads += 1;
        let generation = generation(entry.epoch, entry.reads);
        match mark {
            Some(ReadMark::Snapshot {
                snapshot_id,
                shown,
                cut,
                secret,
            }) => {
                entry.snapshot_mark = Some(SnapshotMark {
                    generation: generation.clone(),
                    snapshot_id,
                    shown,
                    cut,
                    secret,
                })
            }
            Some(ReadMark::Capture {
                width,
                height,
                native_width,
                native_height,
                full_size,
                window_bounds,
            }) => {
                entry.capture_mark = Some(CaptureMark {
                    generation: generation.clone(),
                    width,
                    height,
                    native_width,
                    native_height,
                    full_size,
                    window_bounds,
                })
            }
            None => {}
        }
        Ok(generation)
    }

    /// Check an action may go ahead, and resolve it for the helper.
    ///
    /// In this order, each answered before the next is asked: the window is
    /// one codeg named; it may still be shared at all; it is shared; the grant
    /// has not lapsed; it is shared for control — and only then anything about
    /// the action itself: keys a window grant does not reach, then every ref
    /// against the window's latest snapshot and every point against its
    /// latest screenshot, as the agent was given them. A refusal therefore
    /// never says more about a window than the agent was allowed to know.
    ///
    /// Counts as use of the grant, like a read.
    pub fn begin_act(
        &self,
        target_id: &str,
        now: i64,
        ttl: Option<Duration>,
        me: &SelfIdentity,
        blocklist: &Blocklist,
        request: &ComputerActRequest,
    ) -> Result<ActTicket, (ActDenied, Option<ComputerGrantPayload>)> {
        let mut inner = self.lock();
        let Some(entry) = inner.entries.get_mut(target_id) else {
            return Err((ActDenied::NoSuchTarget, None));
        };
        if let Err(why) = grantable(&entry.app, me, blocklist) {
            let ended = Self::revoke_entry(entry, GrantChange::Revoked);
            return Err((ActDenied::NotGrantable(why), ended));
        }
        let Some(grant) = entry.grant.as_mut() else {
            return Err((ActDenied::GrantRequired, None));
        };
        if grant.lapsed(now, ttl) {
            let ended = Self::revoke_entry(entry, GrantChange::Expired);
            return Err((ActDenied::GrantRequired, ended));
        }
        if !grant.level.allows(GrantLevel::Read) {
            return Err((ActDenied::GrantRequired, None));
        }
        if !grant.level.allows(GrantLevel::Control) {
            return Err((ActDenied::ControlRequired, None));
        }
        let action = resolve(entry, request).map_err(|why| (why, None))?;
        if let Some(grant) = entry.grant.as_mut() {
            grant.last_used_at = now;
        }
        Ok(ActTicket {
            target_id: entry.target_id.clone(),
            identity: entry.identity,
            app: entry.app.clone(),
            aim: Aim::of(entry, &action),
            action,
        })
    }

    /// Every window with a grant in force, oldest grant first.
    pub fn shared(&self) -> Vec<SharedWindow> {
        let inner = self.lock();
        let mut out: Vec<SharedWindow> = inner
            .entries
            .values()
            .filter_map(|e| {
                let grant = e.grant.as_ref()?;
                Some(SharedWindow {
                    target_id: e.target_id.clone(),
                    app_name: e.app.name.clone(),
                    app_key: e.app.key().unwrap_or_default().to_string(),
                    title: e.title.clone(),
                    level: grant.level,
                    granted_at: grant.granted_at,
                    last_used_at: grant.last_used_at,
                })
            })
            .collect();
        out.sort_by(|a, b| {
            a.granted_at
                .cmp(&b.granted_at)
                .then(a.target_id.cmp(&b.target_id))
        });
        out
    }
}

/// The action as the helper carries it out: keys judged for a window grant,
/// refs and points resolved against what the agent last read of the window.
fn resolve(entry: &TargetEntry, request: &ComputerActRequest) -> Result<WindowAction, ActDenied> {
    Ok(match request {
        ComputerActRequest::Click {
            target,
            button,
            count,
        } => WindowAction::Click {
            at: resolve_target(entry, target)?,
            button: *button,
            count: *count,
        },
        ComputerActRequest::Scroll {
            target,
            direction,
            amount,
            unit,
        } => WindowAction::Scroll {
            at: target
                .as_ref()
                .map(|t| resolve_target(entry, t))
                .transpose()?,
            direction: *direction,
            amount: *amount,
            unit: *unit,
        },
        ComputerActRequest::Type {
            target,
            text,
            submit,
        } => WindowAction::Type {
            element: resolve_element(entry, target, true)?,
            text: text.clone(),
            submit: *submit,
        },
        ComputerActRequest::Key { target, chord, .. } => {
            check_chord(chord, target.is_some())?;
            WindowAction::Key {
                element: target
                    .as_ref()
                    .map(|t| resolve_element(entry, t, chord.types_text()))
                    .transpose()?,
                chord: *chord,
            }
        }
        ComputerActRequest::SetValue { target, value } => WindowAction::SetValue {
            element: resolve_element(entry, target, true)?,
            value: value.clone(),
        },
        ComputerActRequest::Restore => WindowAction::Restore,
    })
}

/// Whether a window grant reaches `chord` — and, for a key that types a
/// character, that it is aimed at a named element.
fn check_chord(chord: &Chord, names_element: bool) -> Result<(), ActDenied> {
    match classify(chord, Platform::current()) {
        ChordClass::Beyond => Err(ActDenied::ChordBeyond),
        ChordClass::Paste => Err(ActDenied::Paste),
        ChordClass::Window if chord.types_text() && !names_element => Err(ActDenied::NeedsElement),
        ChordClass::Window => Ok(()),
    }
}

fn resolve_target(entry: &TargetEntry, target: &AgentTarget) -> Result<DriverTarget, ActDenied> {
    Ok(match target {
        AgentTarget::Element(e) => DriverTarget::Element(resolve_element(entry, e, false)?),
        AgentTarget::Point(p) => DriverTarget::Point(resolve_point(entry, p)?),
    })
}

/// A ref, against the window's latest snapshot as the agent was given it.
/// `writes`: the action puts text into the element, which a secret field
/// never takes.
fn resolve_element(
    entry: &TargetEntry,
    target: &ElementTarget,
    writes: bool,
) -> Result<ElementRef, ActDenied> {
    let mark = entry
        .snapshot_mark
        .as_ref()
        .ok_or(ActDenied::Stale(Staleness::NoSnapshot))?;
    if mark.generation != target.generation {
        return Err(ActDenied::Stale(Staleness::OldSnapshot));
    }
    let snapshot_id = mark
        .snapshot_id
        .clone()
        .ok_or(ActDenied::Stale(Staleness::NotActionable))?;
    if !mark.shown.contains(&target.index) {
        return Err(ActDenied::Stale(if mark.cut.contains(&target.index) {
            Staleness::CutAway(target.index)
        } else {
            Staleness::NoSuchRef(target.index)
        }));
    }
    if writes && mark.secret.contains(&target.index) {
        return Err(ActDenied::Secret);
    }
    Ok(ElementRef {
        snapshot_id,
        index: target.index,
    })
}

/// A point, in the pixels of the window's latest screenshot, mapped back to
/// the window's own pixels.
fn resolve_point(entry: &TargetEntry, target: &PointTarget) -> Result<WindowPoint, ActDenied> {
    let mark = entry
        .capture_mark
        .as_ref()
        .ok_or(ActDenied::Stale(Staleness::NoCapture))?;
    if mark.generation != target.generation {
        return Err(ActDenied::Stale(Staleness::OldCapture));
    }
    if !mark.full_size || mark.width == 0 || mark.height == 0 || mark.window_bounds.is_empty() {
        return Err(ActDenied::NoPointing);
    }
    let (x, y) = (target.x, target.y);
    let inside = x.is_finite()
        && y.is_finite()
        && x >= 0.0
        && y >= 0.0
        && x < f64::from(mark.width)
        && y < f64::from(mark.height);
    if !inside {
        return Err(ActDenied::OutOfImage);
    }
    Ok(WindowPoint {
        x: x * f64::from(mark.native_width) / f64::from(mark.width),
        y: y * f64::from(mark.native_height) / f64::from(mark.height),
        window_width: mark.window_bounds.width,
        window_height: mark.window_bounds.height,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn raw_app(pid: u32, started_at: u64, bundle: &str) -> RawApp {
        RawApp {
            pid,
            name: bundle.rsplit('.').next().unwrap_or(bundle).to_string(),
            bundle_id: Some(bundle.to_string()),
            path: None,
            active: false,
            started_at: Some(started_at),
        }
    }

    fn window(pid: u32, started_at: u64, window_id: u64, title: &str) -> RawWindow {
        RawWindow {
            window_id,
            pid,
            title: title.to_string(),
            bounds: Rect {
                x: 0.0,
                y: 0.0,
                width: 800.0,
                height: 600.0,
            },
            on_screen: true,
            minimized: Some(false),
            on_current_space: Some(true),
            z_index: None,
            app: raw_app(pid, started_at, "com.apple.TextEdit"),
        }
    }

    fn me() -> SelfIdentity {
        SelfIdentity {
            pid: 1,
            exe: None,
            bundle: None,
        }
    }

    fn share(table: &TargetTable, id: &str, level: GrantLevel) -> Option<ComputerGrantPayload> {
        table
            .share(id, level, 1_000, &me(), &Blocklist::new(&[]))
            .expect("shareable")
    }

    fn read(table: &TargetTable, id: &str) -> Result<String, ReadRefusal> {
        let ticket = table
            .begin_read(id, 2_000, None, &me(), &Blocklist::new(&[]))
            .map_err(|(why, _)| why)?;
        finish(table, &ticket)
    }

    fn finish(table: &TargetTable, ticket: &ReadTicket) -> Result<String, ReadRefusal> {
        table
            .finish_read(ticket, &me(), &Blocklist::new(&[]), None)
            .map_err(|(why, _)| why)
    }

    /// The same window keeps its id across listings; the same window id under
    /// a relaunched process is a different window with a different id.
    #[test]
    fn a_window_keeps_its_id_until_its_process_changes() {
        let table = TargetTable::new();
        let (first, _) = table.observe(&[window(10, 111, 5, "a")], None);
        let (again, _) = table.observe(&[window(10, 111, 5, "a")], None);
        assert_eq!(first[0].target_id, again[0].target_id);

        let (relaunched, _) = table.observe(&[window(10, 222, 5, "a")], None);
        assert_ne!(relaunched[0].target_id, first[0].target_id);
        // And the old id no longer resolves: it was never shared, so it is
        // simply forgotten.
        assert!(table.get(&first[0].target_id).is_none());
    }

    /// A shared window that stops turning up takes its grant with it, and its
    /// id answers "not shared" from then on — never "no such target".
    #[test]
    fn a_shared_window_that_goes_away_ends_its_grant() {
        let table = TargetTable::new();
        let (listed, _) = table.observe(&[window(10, 111, 5, "Inbox")], None);
        let id = listed[0].target_id.clone();
        share(&table, &id, GrantLevel::Read);
        assert!(read(&table, &id).is_ok());

        let (_, ended) = table.observe(&[], None);
        assert_eq!(ended.len(), 1);
        assert_eq!(ended[0].change, GrantChange::TargetChanged);
        assert_eq!(read(&table, &id), Err(ReadRefusal::GrantRequired));
        assert!(table.shared().is_empty());
        // Re-sharing a gone window is refused rather than resurrecting it.
        assert_eq!(
            table.share(&id, GrantLevel::Read, 3_000, &me(), &Blocklist::new(&[])),
            Err(ShareError::Gone)
        );
    }

    /// A listing scoped to one process says nothing about another's windows.
    #[test]
    fn a_scoped_listing_only_judges_its_own_scope() {
        let table = TargetTable::new();
        let (listed, _) = table.observe(&[window(10, 111, 5, "a"), window(20, 222, 6, "b")], None);
        let other = listed[1].target_id.clone();
        share(&table, &other, GrantLevel::Read);
        let (_, ended) = table.observe(&[window(10, 111, 5, "a")], Some(10));
        assert!(ended.is_empty());
        assert!(read(&table, &other).is_ok());
    }

    /// Unshared ids are refused, unknown ids are told apart from them, and a
    /// read's generation moves with every read and every re-share.
    #[test]
    fn reads_need_a_grant_and_are_numbered() {
        let table = TargetTable::new();
        let (listed, _) = table.observe(&[window(10, 111, 5, "a")], None);
        let id = listed[0].target_id.clone();
        assert_eq!(read(&table, &id), Err(ReadRefusal::GrantRequired));
        assert_eq!(read(&table, "w999"), Err(ReadRefusal::NoSuchTarget));

        share(&table, &id, GrantLevel::Read);
        assert_eq!(read(&table, &id).as_deref(), Ok("1.1"));
        assert_eq!(read(&table, &id).as_deref(), Ok("1.2"));

        // Raising the level keeps the grant, and its numbering.
        assert!(share(&table, &id, GrantLevel::Control).is_some());
        assert_eq!(read(&table, &id).as_deref(), Ok("1.3"));
        // Sharing at the level it already has is not a change.
        assert!(share(&table, &id, GrantLevel::Control).is_none());

        share(&table, &id, GrantLevel::None);
        share(&table, &id, GrantLevel::Read);
        assert_eq!(read(&table, &id).as_deref(), Ok("3.1"));
    }

    /// The re-check after a read catches a revoke that landed during it — the
    /// case the second check exists for.
    #[test]
    fn a_revoke_during_a_read_voids_the_read() {
        let table = TargetTable::new();
        let (listed, _) = table.observe(&[window(10, 111, 5, "a")], None);
        let id = listed[0].target_id.clone();
        share(&table, &id, GrantLevel::Read);
        let ticket = table
            .begin_read(&id, 2_000, None, &me(), &Blocklist::new(&[]))
            .unwrap();
        share(&table, &id, GrantLevel::None);
        assert_eq!(finish(&table, &ticket), Err(ReadRefusal::GrantRequired));

        // Even when it was shared straight back: a different grant.
        let refused = table
            .begin_read(&id, 2_000, None, &me(), &Blocklist::new(&[]))
            .unwrap_err();
        assert_eq!(refused.0, ReadRefusal::GrantRequired);
        share(&table, &id, GrantLevel::Read);
        let ticket = table
            .begin_read(&id, 2_000, None, &me(), &Blocklist::new(&[]))
            .unwrap();
        share(&table, &id, GrantLevel::None);
        share(&table, &id, GrantLevel::Read);
        assert_eq!(finish(&table, &ticket), Err(ReadRefusal::GrantRequired));
    }

    /// An idle grant lapses at the next read, and the sweep ends it without
    /// one.
    #[test]
    fn idle_grants_lapse() {
        let ttl = Some(Duration::from_secs(1));
        let table = TargetTable::new();
        let (listed, _) = table.observe(&[window(10, 111, 5, "a")], None);
        let id = listed[0].target_id.clone();
        share(&table, &id, GrantLevel::Read);
        let refused = table
            .begin_read(&id, 1_000 + 1_000, ttl, &me(), &Blocklist::new(&[]))
            .unwrap_err();
        assert_eq!(refused.0, ReadRefusal::GrantRequired);
        assert_eq!(refused.1.map(|p| p.change), Some(GrantChange::Expired));

        share(&table, &id, GrantLevel::Read);
        let swept = table.sweep(1_000 + 1_000, ttl, &me(), &Blocklist::new(&[]));
        assert_eq!(swept.len(), 1);
        assert_eq!(swept[0].change, GrantChange::Expired);
        assert!(table.shared().is_empty());
    }

    /// A blocklist entry added while a window is shared ends its grant at the
    /// next sweep — before the next listing could show its title — and at the
    /// end of a read that was already in flight, which is then not handed
    /// over.
    #[test]
    fn a_grant_the_blocklist_now_forbids_ends() {
        let table = TargetTable::new();
        let grown = Blocklist::new(&["com.apple.TextEdit".to_string()]);
        let (listed, _) = table.observe(&[window(10, 111, 5, "Draft")], None);
        let id = listed[0].target_id.clone();

        share(&table, &id, GrantLevel::Read);
        let swept = table.sweep(2_000, None, &me(), &grown);
        assert_eq!(swept.len(), 1);
        assert_eq!(swept[0].change, GrantChange::Revoked);
        let (listed, _) = table.observe(&[window(10, 111, 5, "Draft")], None);
        assert_eq!(listed[0].agent_summary(&me(), &grown).title, None);

        let (listed, _) = table.observe(&[window(10, 111, 5, "Draft")], None);
        let id = listed[0].target_id.clone();
        share(&table, &id, GrantLevel::Read);
        let ticket = table
            .begin_read(&id, 2_000, None, &me(), &Blocklist::new(&[]))
            .unwrap();
        let (why, ended) = table
            .finish_read(&ticket, &me(), &grown, None)
            .unwrap_err();
        assert_eq!(why, ReadRefusal::NotGrantable(NotGrantable::Blocklisted));
        assert_eq!(ended.map(|p| p.change), Some(GrantChange::Revoked));
        assert!(table.shared().is_empty());
    }

    /// A late "window gone" for an id a listing already retired touches
    /// neither its tombstone nor the newer id the same window was given when
    /// it came back — which keeps its id, and its grant, from then on.
    #[test]
    fn a_late_retirement_leaves_the_newer_id_alone() {
        let table = TargetTable::new();
        let (listed, _) = table.observe(&[window(10, 111, 5, "a")], None);
        let old = listed[0].target_id.clone();
        share(&table, &old, GrantLevel::Read);
        // A listing that misses the window retires it...
        let (_, ended) = table.observe(&[], None);
        assert_eq!(ended.len(), 1);
        // ...it comes back under a new id, which is shared again...
        let (listed, _) = table.observe(&[window(10, 111, 5, "a")], None);
        let new = listed[0].target_id.clone();
        assert_ne!(new, old);
        share(&table, &new, GrantLevel::Read);
        // ...and then an operation from before reports the old id gone.
        assert!(table.target_changed(&old).is_none());
        assert_eq!(read(&table, &old), Err(ReadRefusal::GrantRequired));
        for _ in 0..3 {
            let (listed, ended) = table.observe(&[window(10, 111, 5, "a")], None);
            assert_eq!(listed[0].target_id, new);
            assert!(ended.is_empty());
        }
        assert!(read(&table, &new).is_ok());
    }

    /// codeg's own windows and blocklisted applications are listed, carry a
    /// note, and can be neither shared nor read — even when a blocklist entry
    /// arrives after the window was shared.
    #[test]
    fn unshareable_windows_are_listed_with_the_reason_and_stay_unreadable() {
        let table = TargetTable::new();
        let mut vault = window(30, 333, 9, "Vault");
        vault.app = raw_app(30, 333, "com.1password.1password");
        let mut own = window(1, 444, 10, "codeg");
        own.app = raw_app(1, 444, "app.codeg");
        let (listed, _) = table.observe(&[vault, own, window(10, 111, 5, "a")], None);

        let blocklist = Blocklist::new(&[]);
        for entry in &listed[..2] {
            assert!(entry.agent_summary(&me(), &blocklist).note.is_some());
            assert!(matches!(
                table.share(&entry.target_id, GrantLevel::Read, 1, &me(), &blocklist),
                Err(ShareError::NotGrantable(_))
            ));
        }

        let editor = listed[2].target_id.clone();
        share(&table, &editor, GrantLevel::Read);
        let grown = Blocklist::new(&["com.apple.TextEdit".to_string()]);
        let refused = table
            .begin_read(&editor, 2_000, None, &me(), &grown)
            .unwrap_err();
        assert_eq!(
            refused.0,
            ReadRefusal::NotGrantable(NotGrantable::Blocklisted)
        );
        assert_eq!(refused.1.map(|p| p.change), Some(GrantChange::Revoked));
    }

    /// The title a listing hands an agent follows the grant; the person's own
    /// view of a shared window keeps the last title the platform showed.
    #[test]
    fn titles_are_withheld_until_shared_and_kept_when_the_platform_blanks_them() {
        let table = TargetTable::new();
        let (listed, _) = table.observe(&[window(10, 111, 5, "Re: offer")], None);
        let id = listed[0].target_id.clone();
        let blocklist = Blocklist::new(&[]);
        assert_eq!(listed[0].agent_summary(&me(), &blocklist).title, None);

        share(&table, &id, GrantLevel::Read);
        let (listed, _) = table.observe(&[window(10, 111, 5, "")], None);
        assert_eq!(
            listed[0].agent_summary(&me(), &blocklist).title.as_deref(),
            Some("Re: offer")
        );
        assert_eq!(table.shared()[0].title, "Re: offer");
    }

    /// An invisible window is tracked but not listed — unless it is shared,
    /// which is exactly when a hidden application must not lose its window
    /// from sight or its grant.
    #[test]
    fn a_hidden_shared_window_stays_listed_and_shared() {
        let table = TargetTable::new();
        let mut hidden = window(10, 111, 5, "Draft");
        hidden.on_screen = false;
        let (listed, _) = table.observe(&[hidden.clone()], None);
        assert!(!listed[0].worth_listing());

        let (listed, _) = table.observe(&[window(10, 111, 5, "Draft")], None);
        let id = listed[0].target_id.clone();
        share(&table, &id, GrantLevel::Read);
        // The user hides the application: still the same window, still shared.
        let (listed, ended) = table.observe(&[hidden], None);
        assert!(ended.is_empty());
        assert!(listed[0].worth_listing());
        assert_eq!(read(&table, &id).as_deref(), Ok("1.1"));
    }

    #[test]
    fn switching_the_group_off_ends_every_grant() {
        let table = TargetTable::new();
        let (listed, _) = table.observe(&[window(10, 111, 5, "a"), window(20, 222, 6, "b")], None);
        for entry in &listed {
            share(&table, &entry.target_id, GrantLevel::Read);
        }
        let ended = table.revoke_all(GrantChange::Disabled);
        assert_eq!(ended.len(), 2);
        assert!(ended.iter().all(|p| p.change == GrantChange::Disabled));
        assert!(table.shared().is_empty());
    }

    // ── acting ─────────────────────────────────────────────────────────────

    use crate::computer::keys::{Chord, Key, Modifiers};
    use crate::computer::types::{PointerButton, ScrollDirection, ScrollUnit};

    /// A shared window with one snapshot read (refs 1–4 given, 5 cut, 2
    /// secret) and one screenshot read (a 1000×500 image of a 2000×1000
    /// capture of a 1000×500-point window). Returns the id and the two
    /// generations.
    fn shared_and_read(table: &TargetTable, level: GrantLevel) -> (String, String, String) {
        let (listed, _) = table.observe(&[window(10, 111, 5, "Form")], None);
        let id = listed[0].target_id.clone();
        share(table, &id, level);
        let ticket = table
            .begin_read(&id, 2_000, None, &me(), &Blocklist::new(&[]))
            .unwrap();
        let snapshot = table
            .finish_read(
                &ticket,
                &me(),
                &Blocklist::new(&[]),
                Some(ReadMark::Snapshot {
                    snapshot_id: Some("s0000000a".into()),
                    shown: [1, 2, 3, 4].into_iter().collect(),
                    cut: [5].into_iter().collect(),
                    secret: [2].into_iter().collect(),
                }),
            )
            .unwrap();
        let capture = table
            .finish_read(
                &ticket,
                &me(),
                &Blocklist::new(&[]),
                Some(ReadMark::Capture {
                    width: 1000,
                    height: 500,
                    native_width: 2000,
                    native_height: 1000,
                    full_size: true,
                    window_bounds: Rect {
                        x: 0.0,
                        y: 0.0,
                        width: 1000.0,
                        height: 500.0,
                    },
                }),
            )
            .unwrap();
        (id, snapshot, capture)
    }

    fn act(
        table: &TargetTable,
        id: &str,
        request: &ComputerActRequest,
    ) -> Result<WindowAction, ActDenied> {
        table
            .begin_act(id, 3_000, None, &me(), &Blocklist::new(&[]), request)
            .map(|t| t.action)
            .map_err(|(why, _)| why)
    }

    fn click_ref(generation: &str, index: u32) -> ComputerActRequest {
        ComputerActRequest::Click {
            target: AgentTarget::Element(ElementTarget {
                generation: generation.into(),
                index,
            }),
            button: PointerButton::Left,
            count: 1,
        }
    }

    fn click_at(generation: &str, x: f64, y: f64) -> ComputerActRequest {
        ComputerActRequest::Click {
            target: AgentTarget::Point(PointTarget {
                generation: generation.into(),
                x,
                y,
            }),
            button: PointerButton::Left,
            count: 1,
        }
    }

    /// Acting needs a grant for control: an unknown id, an unshared window
    /// and a window shared for reading are each refused as such, before
    /// anything about the action is looked at.
    #[test]
    fn acting_needs_a_grant_for_control() {
        let table = TargetTable::new();
        let (id, snapshot, _) = shared_and_read(&table, GrantLevel::Read);
        assert_eq!(
            act(&table, "w999", &click_ref(&snapshot, 1)),
            Err(ActDenied::NoSuchTarget)
        );
        assert_eq!(
            act(&table, &id, &click_ref(&snapshot, 1)),
            Err(ActDenied::ControlRequired)
        );
        // Even a key no grant allows is answered as "read only" first.
        let quit = ComputerActRequest::Key {
            target: None,
            chord: Chord {
                key: Key::Char('q'),
                modifiers: Modifiers {
                    meta: true,
                    control: true,
                    ..Modifiers::default()
                },
            },
            repeat: 1,
        };
        assert_eq!(act(&table, &id, &quit), Err(ActDenied::ControlRequired));
        // Putting a minimized window back changes what is on the screen: an
        // action like any other.
        assert_eq!(
            act(&table, &id, &ComputerActRequest::Restore),
            Err(ActDenied::ControlRequired)
        );
        share(&table, &id, GrantLevel::Control);
        assert_eq!(
            act(&table, &id, &ComputerActRequest::Restore),
            Ok(WindowAction::Restore)
        );
        share(&table, &id, GrantLevel::None);
        assert_eq!(
            act(&table, &id, &click_ref(&snapshot, 1)),
            Err(ActDenied::GrantRequired)
        );
    }

    /// A ref resolves against the latest snapshot as the agent was given it:
    /// cut and missing refs are told apart, an older generation is stale, and
    /// a secret field takes a click but no text.
    #[test]
    fn refs_resolve_against_the_latest_snapshot_as_given() {
        let table = TargetTable::new();
        let (id, snapshot, capture) = shared_and_read(&table, GrantLevel::Control);
        assert_eq!(
            act(&table, &id, &click_ref(&snapshot, 3)),
            Ok(WindowAction::Click {
                at: DriverTarget::Element(ElementRef {
                    snapshot_id: "s0000000a".into(),
                    index: 3
                }),
                button: PointerButton::Left,
                count: 1,
            })
        );
        assert_eq!(
            act(&table, &id, &click_ref(&snapshot, 5)),
            Err(ActDenied::Stale(Staleness::CutAway(5)))
        );
        assert_eq!(
            act(&table, &id, &click_ref(&snapshot, 9)),
            Err(ActDenied::Stale(Staleness::NoSuchRef(9)))
        );
        // The screenshot's generation is not a snapshot's.
        assert_eq!(
            act(&table, &id, &click_ref(&capture, 3)),
            Err(ActDenied::Stale(Staleness::OldSnapshot))
        );
        // The secret field: clickable, and nothing typed or set into it.
        assert!(act(&table, &id, &click_ref(&snapshot, 2)).is_ok());
        let pw = ElementTarget {
            generation: snapshot.clone(),
            index: 2,
        };
        for writes in [
            ComputerActRequest::Type {
                target: pw.clone(),
                text: "hunter2".into(),
                submit: false,
            },
            ComputerActRequest::SetValue {
                target: pw.clone(),
                value: "hunter2".into(),
            },
            ComputerActRequest::Key {
                target: Some(pw.clone()),
                chord: Chord {
                    key: Key::Char('h'),
                    modifiers: Modifiers::default(),
                },
                repeat: 1,
            },
        ] {
            assert_eq!(act(&table, &id, &writes), Err(ActDenied::Secret), "{writes:?}");
        }
    }

    /// A point is read in the latest screenshot's pixels and mapped back to
    /// the window's own; one outside the image, or from another screenshot,
    /// is refused.
    #[test]
    fn points_resolve_against_the_latest_screenshot() {
        let table = TargetTable::new();
        let (id, _, capture) = shared_and_read(&table, GrantLevel::Control);
        assert_eq!(
            act(&table, &id, &click_at(&capture, 100.0, 50.5)),
            Ok(WindowAction::Click {
                at: DriverTarget::Point(WindowPoint {
                    x: 200.0,
                    y: 101.0,
                    window_width: 1000.0,
                    window_height: 500.0,
                }),
                button: PointerButton::Left,
                count: 1,
            })
        );
        for (x, y) in [(1000.0, 10.0), (10.0, 500.0), (-1.0, 3.0), (f64::NAN, 3.0)] {
            assert_eq!(
                act(&table, &id, &click_at(&capture, x, y)),
                Err(ActDenied::OutOfImage),
                "{x},{y}"
            );
        }
        assert_eq!(
            act(&table, &id, &click_at("1.1", 1.0, 1.0)),
            Err(ActDenied::Stale(Staleness::OldCapture))
        );
        // A screenshot codeg cannot map back to the window's pixels cannot
        // be pointed into.
        let ticket = table
            .begin_read(&id, 2_000, None, &me(), &Blocklist::new(&[]))
            .unwrap();
        let unmapped = table
            .finish_read(
                &ticket,
                &me(),
                &Blocklist::new(&[]),
                Some(ReadMark::Capture {
                    width: 1000,
                    height: 500,
                    native_width: 1000,
                    native_height: 500,
                    full_size: false,
                    window_bounds: Rect::default(),
                }),
            )
            .unwrap();
        assert_eq!(
            act(&table, &id, &click_at(&unmapped, 1.0, 1.0)),
            Err(ActDenied::NoPointing)
        );
    }

    /// An action is placed on the screen from where the helper says it
    /// aimed: an element at the middle of its frame, a point at its offset in
    /// the window's units from where the window was measured to be — and an
    /// action on the focus, or a report without the frame, nowhere.
    #[test]
    fn an_action_is_placed_where_it_landed() {
        use crate::computer::types::ActEffect;
        let table = TargetTable::new();
        let (id, snapshot, capture) = shared_and_read(&table, GrantLevel::Control);
        let aim = |request: &ComputerActRequest| {
            table
                .begin_act(&id, 3_000, None, &me(), &Blocklist::new(&[]), request)
                .unwrap()
                .aim
        };
        let frame = |x, y, width, height| Rect {
            x,
            y,
            width,
            height,
        };
        let report = |element_frame, window_frame| RawAct {
            effect: ActEffect::Confirmed,
            route: None,
            submitted: None,
            element_frame,
            window_frame,
        };

        // The screenshot is 1000×500 of a 1000×500-unit window drawn at
        // 2000×1000 pixels: (100, 50.5) in it is (100, 50.5) units in.
        let point = aim(&click_at(&capture, 100.0, 50.5));
        assert_eq!(point, Aim::Offset { x: 100.0, y: 50.5 });
        let moved = report(None, Some(frame(300.0, 40.0, 1000.0, 500.0)));
        assert_eq!(point.landing(&moved), Some((400.0, 90.5)));
        assert_eq!(point.landing(&report(None, None)), None);

        let element = aim(&click_ref(&snapshot, 3));
        assert_eq!(element, Aim::Element);
        let placed = report(Some(frame(10.0, 20.0, 30.0, 40.0)), None);
        assert_eq!(element.landing(&placed), Some((25.0, 40.0)));
        assert_eq!(
            element.landing(&report(Some(frame(10.0, 20.0, 0.0, 40.0)), None)),
            None
        );

        let focus = aim(&ComputerActRequest::Key {
            target: None,
            chord: Chord {
                key: Key::Return,
                modifiers: Default::default(),
            },
            repeat: 1,
        });
        assert_eq!(focus, Aim::Focus);
        assert_eq!(focus.landing(&placed), None);
    }

    /// Taking the window back and sharing it again is a new grant: nothing
    /// read under the old one can be acted on.
    #[test]
    fn a_new_grant_forgets_what_was_read_under_the_old() {
        let table = TargetTable::new();
        let (id, snapshot, capture) = shared_and_read(&table, GrantLevel::Control);
        share(&table, &id, GrantLevel::None);
        share(&table, &id, GrantLevel::Control);
        assert_eq!(
            act(&table, &id, &click_ref(&snapshot, 3)),
            Err(ActDenied::Stale(Staleness::NoSnapshot))
        );
        assert_eq!(
            act(&table, &id, &click_at(&capture, 1.0, 1.0)),
            Err(ActDenied::Stale(Staleness::NoCapture))
        );
        // A change of level keeps the grant, and what was read under it.
        let table = TargetTable::new();
        let (id, snapshot, _) = shared_and_read(&table, GrantLevel::Read);
        share(&table, &id, GrantLevel::Control);
        assert!(act(&table, &id, &click_ref(&snapshot, 3)).is_ok());
    }

    /// Keys: the window's own chords go through; a paste, a chord that
    /// reaches the application or the desktop, and a character key with no
    /// element are refused, each as itself.
    #[test]
    fn keys_are_judged_for_a_window_grant() {
        let table = TargetTable::new();
        let (id, snapshot, _) = shared_and_read(&table, GrantLevel::Control);
        let primary = if cfg!(target_os = "macos") {
            Modifiers {
                meta: true,
                ..Modifiers::default()
            }
        } else {
            Modifiers {
                control: true,
                ..Modifiers::default()
            }
        };
        let key = |key: Key, modifiers: Modifiers, target: Option<ElementTarget>| {
            ComputerActRequest::Key {
                target,
                chord: Chord { key, modifiers },
                repeat: 1,
            }
        };
        assert!(act(&table, &id, &key(Key::Return, Modifiers::default(), None)).is_ok());
        assert!(act(&table, &id, &key(Key::Char('a'), primary, None)).is_ok());
        assert_eq!(
            act(&table, &id, &key(Key::Char('v'), primary, None)),
            Err(ActDenied::Paste)
        );
        assert_eq!(
            act(&table, &id, &key(Key::Char('q'), primary, None)),
            Err(ActDenied::ChordBeyond)
        );
        assert_eq!(
            act(&table, &id, &key(Key::Char('x'), Modifiers::default(), None)),
            Err(ActDenied::NeedsElement)
        );
        let field = ElementTarget {
            generation: snapshot,
            index: 3,
        };
        assert!(act(
            &table,
            &id,
            &key(Key::Char('x'), Modifiers::default(), Some(field))
        )
        .is_ok());
        let scroll = ComputerActRequest::Scroll {
            target: None,
            direction: ScrollDirection::Down,
            amount: 3,
            unit: ScrollUnit::Line,
        };
        assert!(act(&table, &id, &scroll).is_ok());
    }

    /// An action keeps the grant in use, like a read; a lapsed grant ends at
    /// the action, which is refused.
    #[test]
    fn an_action_uses_the_grant_and_a_lapsed_one_ends() {
        let ttl = Some(Duration::from_secs(10));
        let table = TargetTable::new();
        let (id, snapshot, _) = shared_and_read(&table, GrantLevel::Control);
        table
            .begin_act(&id, 9_000, ttl, &me(), &Blocklist::new(&[]), &click_ref(&snapshot, 1))
            .unwrap();
        assert_eq!(table.shared()[0].last_used_at, 9_000);
        let (why, ended) = table
            .begin_act(&id, 30_000, ttl, &me(), &Blocklist::new(&[]), &click_ref(&snapshot, 1))
            .unwrap_err();
        assert_eq!(why, ActDenied::GrantRequired);
        assert_eq!(ended.map(|p| p.change), Some(GrantChange::Expired));
    }
}
