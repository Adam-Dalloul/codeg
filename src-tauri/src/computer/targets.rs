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

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::Duration;

use serde::{Deserialize, Serialize};

use super::agent::{
    generation, grantable, level_of, visible_title, Blocklist, ComputerGrant, ComputerGrantPayload,
    GrantChange, GrantLevel, NotGrantable, SelfIdentity,
};
use super::protocol::{RawApp, RawWindow};
use super::types::{AgentAppRef, AgentWindowSummary, Rect};

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
    fn retire(
        inner: &mut Inner,
        target_id: &str,
        change: GrantChange,
    ) -> Option<ComputerGrantPayload> {
        let entry = inner.entries.get_mut(target_id)?;
        let identity = entry.identity;
        inner.by_identity.remove(&identity);
        if entry.grant.is_some() {
            entry.grant = None;
            entry.gone = true;
            entry.epoch += 1;
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

    /// End the grants that have gone unused for `ttl`.
    pub fn expire(&self, now: i64, ttl: Option<Duration>) -> Vec<ComputerGrantPayload> {
        let mut inner = self.lock();
        inner
            .entries
            .values_mut()
            .filter(|e| e.grant.as_ref().is_some_and(|g| g.lapsed(now, ttl)))
            .filter_map(|entry| Self::revoke_entry(entry, GrantChange::Expired))
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
    /// still in force on the same window. The person may have taken it back
    /// while the capture was in flight, and what the capture holds is exactly
    /// what they took back.
    ///
    /// Returns the generation that names this read.
    pub fn finish_read(&self, ticket: &ReadTicket) -> Result<String, ReadRefusal> {
        let mut inner = self.lock();
        let Some(entry) = inner.entries.get_mut(&ticket.target_id) else {
            return Err(ReadRefusal::GrantRequired);
        };
        let still = entry.identity == ticket.identity
            && entry.epoch == ticket.epoch
            && level_of(entry.grant.as_ref()).allows(GrantLevel::Read);
        if !still {
            return Err(ReadRefusal::GrantRequired);
        }
        entry.reads += 1;
        Ok(generation(entry.epoch, entry.reads))
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
        table.finish_read(&ticket)
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
        assert_eq!(table.finish_read(&ticket), Err(ReadRefusal::GrantRequired));

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
        assert_eq!(table.finish_read(&ticket), Err(ReadRefusal::GrantRequired));
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
        let swept = table.expire(1_000 + 1_000, ttl);
        assert_eq!(swept.len(), 1);
        assert!(table.shared().is_empty());
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
}
