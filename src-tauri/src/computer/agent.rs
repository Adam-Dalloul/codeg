//! Who may look at a window on an agent's behalf.
//!
//! The rule is the built-in browser's, carried over whole: **nothing is
//! granted automatically.** Not by application, not by which window is in
//! front, not because the agent opened it. The only way an agent reads a
//! window is a person sharing that window. Reading is a grant, not just acting:
//! a screenshot of an unshared window leaks exactly as much as a click on it
//! would do damage, and the windows most worth protecting are the ones a
//! screenshot shows best.
//!
//! The grant lives on the target-table entry for the window
//! (`targets::TargetEntry::grant`), which is why this module is decisions and
//! wire types rather than a store — the same split the browser makes between
//! `browser::agent` and the tab it guards.

use std::path::{Path, PathBuf};
use std::time::Duration;

use serde::{Deserialize, Serialize};

pub use crate::browser::agent::GrantLevel;

use super::keys::Platform;
use super::protocol::RawApp;

/// codeg's own bundle identifier (`tauri.conf.json`), matched on any process
/// so a second codeg — a development build next to the installed one — is as
/// out of reach as this one.
pub const CODEG_BUNDLE_ID: &str = "app.codeg";

/// The file names codeg's executable goes by, matched on any process's path
/// for the same reason, where an application has no bundle identifier to
/// know it by: on Windows, a development build next to the installed one is
/// otherwise just another executable.
pub const CODEG_EXECUTABLES: &[&str] = &["codeg.exe", "codeg"];

/// A grant in force on one window.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ComputerGrant {
    /// Never [`GrantLevel::None`]: a window with no grant carries no
    /// `ComputerGrant` at all, so "level none, but still bound to a window" is
    /// a state that cannot be written down.
    pub level: GrantLevel,
    /// Unix milliseconds.
    pub granted_at: i64,
    /// Unix milliseconds of the last read this grant allowed.
    pub last_used_at: i64,
}

impl ComputerGrant {
    pub fn new(level: GrantLevel, now: i64) -> Self {
        Self {
            level,
            granted_at: now,
            last_used_at: now,
        }
    }

    /// Whether the grant has gone unused for longer than `ttl`.
    ///
    /// Unlike a browser grant, which ends only when the person takes it back
    /// or the page leaves its origin, a window grant also lapses on its own.
    /// A tab shows one site; a shared window is often the user's whole working
    /// context in some application — a mail client, a terminal — and "shared
    /// this morning for one question" should not quietly mean "readable all
    /// week". The clock runs from the last read, not from the grant, so a
    /// window an agent is actively using stays shared. `None` is the person's
    /// own choice of "until I take it back".
    ///
    /// Measured on the wall clock, which is what keeps counting while the
    /// machine sleeps (a monotonic clock here stops, and a grant would outlive
    /// a night asleep). A clock that has gone back by more than
    /// [`MAX_CLOCK_SKEW_MS`] since the last read ends the grant: how long it
    /// has been idle can no longer be told, and the answer that is safe is
    /// "too long".
    pub fn lapsed(&self, now: i64, ttl: Option<Duration>) -> bool {
        let Some(ttl) = ttl else {
            return false;
        };
        let idle_since = self.granted_at.max(self.last_used_at);
        if idle_since.saturating_sub(now) > MAX_CLOCK_SKEW_MS {
            return true;
        }
        let ttl_ms = i64::try_from(ttl.as_millis()).unwrap_or(i64::MAX);
        now.saturating_sub(idle_since) >= ttl_ms
    }
}

/// How far the wall clock may step back under a grant (a time sync, say)
/// before the grant is ended rather than trusted to still be fresh.
pub const MAX_CLOCK_SKEW_MS: i64 = 60_000;

/// The level a window is at, reading the absence of a grant as `None`.
pub fn level_of(grant: Option<&ComputerGrant>) -> GrantLevel {
    grant.map_or(GrantLevel::None, |g| g.level)
}

/// A window's title as an agent may see it: only from [`GrantLevel::Read`]
/// upwards, and never as an empty string (the platform withholds titles it
/// may not show, and "" would read as "this window has no title").
pub fn visible_title(level: GrantLevel, title: &str) -> Option<String> {
    (level.allows(GrantLevel::Read) && !title.is_empty()).then(|| title.to_string())
}

/// Names one read of one grant: `<epoch>.<read number>`. The epoch moves every
/// time the grant on the window changes hands (shared, revoked, re-shared), so
/// a generation from before a revoke never names a read made after it.
pub fn generation(epoch: u64, seq: u64) -> String {
    format!("{epoch}.{seq}")
}

/// Why a window cannot be shared at all.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum NotGrantable {
    /// One of codeg's own windows. Not a setting: an agent that could read
    /// codeg's windows could read the grant dialog and the stop button, and
    /// the only thing keeping a person in charge of what an agent may see is
    /// that those are out of its reach.
    Codeg,
    /// The application is on the person's never-share list — one of the
    /// defaults they kept (credential managers, the system settings), or one
    /// they added.
    Blocklisted,
    /// codeg cannot tell which application this is, or which run of it: the
    /// platform gave no start time for its process (so a later process under
    /// the same pid could not be told apart), or nothing a blocklist could
    /// match (no bundle identifier, no path).
    Unidentified,
}

impl NotGrantable {
    /// Said to an agent next to such a window in a listing, and as the reason
    /// a read of one is refused.
    pub fn note(self) -> &'static str {
        match self {
            NotGrantable::Codeg => {
                "codeg's own window: it can never be shared with an agent. For web pages use \
                 the browser_* tools."
            }
            NotGrantable::Blocklisted => {
                "on the user's list of applications never shared with agents: it cannot be \
                 shared unless they take it off that list in codeg's settings."
            }
            NotGrantable::Unidentified => {
                "codeg cannot tell which application owns this window, so it cannot be shared \
                 with an agent."
            }
        }
    }
}

/// One application on the default blocklist, as every platform names it.
#[derive(Debug, Clone, Copy)]
pub struct DefaultBlock {
    /// Stable across releases: what a person's "take this one off" is
    /// remembered by, so a name added to an entry later is off with it.
    pub key: &'static str,
    /// Its product name. The few that are the system's own are named by the
    /// interface, in the person's language, by `key`.
    pub name: &'static str,
    /// Bundle identifiers.
    pub macos: &'static [&'static str],
    /// Executable file names.
    pub windows: &'static [&'static str],
    /// Executable file names.
    pub linux: &'static [&'static str],
}

impl DefaultBlock {
    fn names_on(&self, platform: Platform) -> &'static [&'static str] {
        match platform {
            Platform::Mac => self.macos,
            Platform::Windows => self.windows,
            Platform::Linux => self.linux,
        }
    }

    fn all_names(&self) -> impl Iterator<Item = &'static str> {
        self.macos
            .iter()
            .chain(self.windows)
            .chain(self.linux)
            .copied()
    }
}

/// The default blocklist: applications whose windows are credentials, and the
/// switches that decide who else may read the screen. Matched against a
/// bundle identifier, a full path, or an executable's file name, without
/// regard to case, on whichever platform names them.
///
/// Every entry is the person's to take off: none is beyond an agent's reach
/// for want of a way — a window of any of them can be read and operated like
/// any other — only for what it holds, and the person decides that.
pub const DEFAULT_BLOCKLIST: &[DefaultBlock] = &[
    // System Settings holds the Privacy & Security pane that decides who may
    // record the screen, this helper included.
    DefaultBlock {
        key: "system-settings",
        name: "System Settings",
        macos: &["com.apple.systempreferences", "com.apple.Settings"],
        windows: &["systemsettings.exe"],
        linux: &[],
    },
    // The system's own prompts for a password (an administrator password
    // typed into one is exactly what must not reach a screenshot) and for
    // elevation.
    DefaultBlock {
        key: "credential-prompts",
        name: "Password prompts",
        macos: &[
            "com.apple.SecurityAgent",
            "com.apple.LocalAuthentication.UIAgent",
        ],
        windows: &["credentialuibroker.exe", "consent.exe"],
        linux: &[],
    },
    DefaultBlock {
        key: "keychain",
        name: "Keychain Access",
        macos: &["com.apple.keychainaccess"],
        windows: &[],
        linux: &[],
    },
    DefaultBlock {
        key: "seahorse",
        name: "Passwords and Keys",
        macos: &[],
        windows: &[],
        linux: &["seahorse"],
    },
    DefaultBlock {
        key: "kwallet",
        name: "KWallet Manager",
        macos: &[],
        windows: &[],
        linux: &["kwalletmanager5"],
    },
    DefaultBlock {
        key: "passwords",
        name: "Passwords",
        macos: &["com.apple.Passwords"],
        windows: &[],
        linux: &[],
    },
    DefaultBlock {
        key: "1password",
        name: "1Password",
        macos: &["com.1password.1password", "com.agilebits.onepassword7"],
        windows: &["1password.exe"],
        linux: &["1password"],
    },
    DefaultBlock {
        key: "bitwarden",
        name: "Bitwarden",
        macos: &["com.bitwarden.desktop"],
        windows: &["bitwarden.exe"],
        linux: &["bitwarden"],
    },
    DefaultBlock {
        key: "keepass",
        name: "KeePass",
        macos: &[],
        windows: &["keepass.exe"],
        linux: &[],
    },
    DefaultBlock {
        key: "keepassxc",
        name: "KeePassXC",
        macos: &["org.keepassxc.keepassxc"],
        windows: &["keepassxc.exe"],
        linux: &["keepassxc"],
    },
    DefaultBlock {
        key: "lastpass",
        name: "LastPass",
        macos: &["com.lastpass.LastPass"],
        windows: &[],
        linux: &[],
    },
    DefaultBlock {
        key: "enpass",
        name: "Enpass",
        macos: &["in.sinew.Enpass-Desktop"],
        windows: &["enpass.exe"],
        linux: &[],
    },
    DefaultBlock {
        key: "proton-pass",
        name: "Proton Pass",
        macos: &["me.proton.pass.electron"],
        windows: &["proton pass.exe"],
        linux: &[],
    },
    DefaultBlock {
        key: "dashlane",
        name: "Dashlane",
        macos: &["com.dashlane.dashlanephonefinal"],
        windows: &["dashlane.exe"],
        linux: &[],
    },
];

/// One default entry as the settings show it on this platform.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DefaultBlockView {
    pub key: String,
    pub name: String,
    /// How this platform names it.
    pub names: Vec<String>,
}

/// The default entries this platform has a name for, in list order.
pub fn default_blocklist(platform: Platform) -> Vec<DefaultBlockView> {
    DEFAULT_BLOCKLIST
        .iter()
        .filter(|block| !block.names_on(platform).is_empty())
        .map(|block| DefaultBlockView {
            key: block.key.to_string(),
            name: block.name.to_string(),
            names: block
                .names_on(platform)
                .iter()
                .map(|name| name.to_string())
                .collect(),
        })
        .collect()
}

/// Whether `key` names a default entry — one a person may take off the list.
pub fn is_default_key(key: &str) -> bool {
    DEFAULT_BLOCKLIST.iter().any(|block| block.key == key)
}

/// The applications whose windows can never be shared: the default list,
/// less the entries the person took off it, plus whatever they added.
///
/// A person may take a default off — theirs to decide, from the settings. An
/// agent that edits those settings behind them could do the same; what it
/// cannot do is share a window: that still takes the person, in the picker.
#[derive(Debug, Clone, Default)]
pub struct Blocklist {
    /// Lowercased.
    entries: Vec<String>,
}

impl Blocklist {
    /// Every default entry, plus `user_entries`.
    pub fn new(user_entries: &[String]) -> Self {
        Self::configured(user_entries, &[])
    }

    /// The default entries but those whose keys are in `removed`, plus
    /// `user_entries`.
    pub fn configured(user_entries: &[String], removed: &[String]) -> Self {
        let mut entries: Vec<String> = DEFAULT_BLOCKLIST
            .iter()
            .filter(|block| !removed.iter().any(|key| key == block.key))
            .flat_map(DefaultBlock::all_names)
            .map(str::to_lowercase)
            .chain(
                user_entries
                    .iter()
                    .map(|s| s.trim().to_lowercase())
                    .filter(|s| !s.is_empty()),
            )
            .collect();
        entries.sort();
        entries.dedup();
        Self { entries }
    }

    /// Whether `app` is on the list, by bundle identifier, by full path, or by
    /// the file name at the end of its path — for a Chromium browser running
    /// from its clone (`Foo.app.bundle`, see `appident`), also by the file
    /// name of the bundle it was cloned from (`Foo.app`).
    pub fn matches(&self, app: &RawApp) -> bool {
        let mut names: Vec<String> = Vec::with_capacity(4);
        if let Some(bundle) = app.bundle_id.as_deref().filter(|s| !s.is_empty()) {
            names.push(bundle.to_lowercase());
        }
        if let Some(path) = app.path.as_deref().filter(|s| !s.is_empty()) {
            names.push(path.to_lowercase());
            // Split on both separators, not `Path::file_name`: a Windows path
            // is still a Windows path when the list is checked in a test on
            // another platform, and a path from the driver is only ever one
            // platform's spelling anyway.
            if let Some(file) = path.rsplit(['/', '\\']).find(|part| !part.is_empty()) {
                let file = file.to_lowercase();
                if let Some(cloned) = file.strip_suffix(".bundle").filter(|f| f.ends_with(".app")) {
                    names.push(cloned.to_string());
                }
                names.push(file);
            }
        }
        names
            .iter()
            .any(|name| self.entries.binary_search(name).is_ok())
    }
}

/// Enough about this codeg process to recognise its windows in a listing.
#[derive(Debug, Clone, Default)]
pub struct SelfIdentity {
    pub pid: u32,
    /// The running executable.
    pub exe: Option<PathBuf>,
    /// The `.app` bundle the executable is in, on macOS — the path the
    /// platform reports for an application.
    pub bundle: Option<PathBuf>,
}

impl SelfIdentity {
    pub fn current() -> Self {
        let exe = std::env::current_exe().ok();
        let bundle = exe.as_deref().and_then(enclosing_app_bundle);
        Self {
            pid: std::process::id(),
            exe,
            bundle,
        }
    }

    /// Whether `app` is codeg: this process, any process calling itself
    /// codeg's bundle, any executable named as codeg's is, or anything run
    /// from this codeg's executable or bundle.
    pub fn owns(&self, app: &RawApp) -> bool {
        if app.pid == self.pid {
            return true;
        }
        if app
            .bundle_id
            .as_deref()
            .is_some_and(|b| b.eq_ignore_ascii_case(CODEG_BUNDLE_ID))
        {
            return true;
        }
        let Some(path) = app.path.as_deref().filter(|s| !s.is_empty()) else {
            return false;
        };
        // Split on both separators, as the blocklist does: a Windows path is
        // still one when checked in a test on another platform.
        if path
            .rsplit(['/', '\\'])
            .find(|part| !part.is_empty())
            .is_some_and(|file| {
                CODEG_EXECUTABLES
                    .iter()
                    .any(|name| file.eq_ignore_ascii_case(name))
            })
        {
            return true;
        }
        let path = Path::new(path);
        [self.exe.as_deref(), self.bundle.as_deref()]
            .into_iter()
            .flatten()
            .any(|mine| same_path(mine, path))
    }
}

/// `…/Foo.app` for an executable at `…/Foo.app/Contents/MacOS/foo`.
fn enclosing_app_bundle(exe: &Path) -> Option<PathBuf> {
    exe.ancestors()
        .find(|p| {
            p.extension()
                .and_then(|e| e.to_str())
                .is_some_and(|e| e.eq_ignore_ascii_case("app"))
        })
        .map(Path::to_path_buf)
}

fn same_path(a: &Path, b: &Path) -> bool {
    if cfg!(any(windows, target_os = "macos")) {
        // Both filesystems are case-insensitive by default, and the platform
        // does not promise to report a path in the case it was launched with.
        a.to_string_lossy()
            .eq_ignore_ascii_case(&b.to_string_lossy())
    } else {
        a == b
    }
}

/// Whether `app`'s windows may be shared at all.
pub fn grantable(
    app: &RawApp,
    me: &SelfIdentity,
    blocklist: &Blocklist,
) -> Result<(), NotGrantable> {
    if me.owns(app) {
        return Err(NotGrantable::Codeg);
    }
    if blocklist.matches(app) {
        return Err(NotGrantable::Blocklisted);
    }
    // A grant is bound to (pid, start time, window): without the start time
    // it would pass to whatever the system hands that pid next, and without a
    // key the blocklist above could not have matched it.
    if app.started_at.is_none() || app.key().is_none() {
        return Err(NotGrantable::Unidentified);
    }
    Ok(())
}

/// Why a window's grant changed.
///
/// The current level travels on `computer://state` with the rest of the shared
/// window, so this is not a second source of truth for it. It carries what the
/// state cannot: that a change was not the user's doing, and what happened
/// instead.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum GrantChange {
    /// The user shared the window, or changed the level.
    Granted,
    /// The user took it back.
    Revoked,
    /// The window closed, or the process that owned it is gone — including a
    /// relaunch, which is a different process and not the one that was
    /// shared.
    TargetChanged,
    /// Unused for longer than the grant timeout.
    Expired,
    /// The user switched computer use off, which ends every grant.
    Disabled,
    /// The user pressed Stop, which ends every grant at once.
    Stopped,
}

/// `computer://agent-grant`: a transition, with its reason. Current state:
/// `computer://state`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ComputerGrantPayload {
    pub target_id: String,
    pub change: GrantChange,
    pub level: GrantLevel,
}

pub const AGENT_GRANT_EVENT: &str = "computer://agent-grant";

/// What an agent did to a window, for the person watching.
///
/// One variant per kind of touch, as on the browser's strip: the list
/// collapses runs of the same line, and forty clicks should not swallow the
/// one keystroke among them.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ComputerAction {
    /// Took a screenshot.
    Capture,
    /// Read the accessibility tree.
    Snapshot,
    /// Checked predicates against it.
    Verify,
    Click,
    /// Dragged from one point to another.
    Drag,
    Scroll,
    /// Typed text into an element.
    Type,
    /// Pressed a key.
    Key,
    /// Held a key down.
    HoldKey,
    /// Set an element's value outright.
    SetValue,
    /// Put a minimized window back on the screen.
    Restore,
}

impl ComputerAction {
    /// The line an action request leaves.
    pub fn of(request: &super::types::ComputerActRequest) -> Self {
        use super::types::ComputerActRequest as R;
        match request {
            R::Click { .. } => ComputerAction::Click,
            R::Drag { .. } => ComputerAction::Drag,
            R::Scroll { .. } => ComputerAction::Scroll,
            R::Type { .. } => ComputerAction::Type,
            R::Key { .. } => ComputerAction::Key,
            R::HoldKey { .. } => ComputerAction::HoldKey,
            R::SetValue { .. } => ComputerAction::SetValue,
            R::Restore => ComputerAction::Restore,
        }
    }
}

/// How an attempt ended.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ActivityOutcome {
    Done,
    /// No grant covered the window. The agent was told to ask.
    Refused,
    /// The grant was there and the read did not work — a missing OS
    /// permission, a window that closed mid-read. Reported so that "nothing
    /// on the strip" keeps meaning "nothing reached this window" rather than
    /// "nothing worked".
    Failed,
}

/// `computer://agent-activity`: one agent's one attempt on one window.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ComputerActivityPayload {
    pub target_id: String,
    pub action: ComputerAction,
    pub outcome: ActivityOutcome,
    /// Unix milliseconds.
    pub at: i64,
}

pub const AGENT_ACTIVITY_EVENT: &str = "computer://agent-activity";

#[cfg(test)]
mod tests {
    use super::*;

    fn app(pid: u32, bundle: Option<&str>, path: Option<&str>) -> RawApp {
        RawApp {
            pid,
            name: "x".into(),
            bundle_id: bundle.map(str::to_string),
            path: path.map(str::to_string),
            active: false,
            started_at: Some(1),
        }
    }

    /// codeg is recognised by pid, by its bundle identifier on any pid, and
    /// by its executable or bundle path — the last is what a development build
    /// (which has no bundle identifier) is recognised by. A path in another
    /// case is codeg's only where the filesystem ignores case: on Linux it
    /// names another file.
    #[test]
    fn codeg_is_never_grantable_however_it_is_described() {
        let me = SelfIdentity {
            pid: 100,
            exe: Some(PathBuf::from(
                "/Applications/codeg.app/Contents/MacOS/codeg",
            )),
            bundle: Some(PathBuf::from("/Applications/codeg.app")),
        };
        let list = Blocklist::new(&[]);
        for codeg in [
            app(100, None, None),
            app(200, Some("app.codeg"), None),
            app(200, Some("APP.CODEG"), None),
            app(300, None, Some("/Applications/codeg.app")),
            app(
                300,
                None,
                Some("/Applications/codeg.app/Contents/MacOS/codeg"),
            ),
            // Any other codeg, wherever it runs from, by its executable's
            // name: Windows gives no bundle identifier to know it by.
            app(
                400,
                None,
                Some(r"C:\Users\me\codeg\src-tauri\target\debug\codeg.exe"),
            ),
            app(400, None, Some(r"C:\Program Files\codeg\CODEG.EXE")),
            app(400, None, Some("/usr/bin/codeg")),
        ] {
            assert_eq!(
                grantable(&codeg, &me, &list),
                Err(NotGrantable::Codeg),
                "{codeg:?}"
            );
        }
        assert_eq!(
            grantable(&app(300, None, Some("/applications/CODEG.app")), &me, &list),
            if cfg!(any(windows, target_os = "macos")) {
                Err(NotGrantable::Codeg)
            } else {
                Ok(())
            }
        );
        assert_eq!(
            grantable(&app(300, Some("com.apple.TextEdit"), None), &me, &list),
            Ok(())
        );
        for other in [
            r"C:\Tools\codegen.exe",
            r"C:\codeg\WindowsTerminal.exe",
            r"C:\Tools\codeg.exe.old",
        ] {
            assert_eq!(
                grantable(&app(400, None, Some(other)), &me, &list),
                Ok(()),
                "{other}"
            );
        }
    }

    /// The blocklist matches bundle ids, full paths and executable names, in
    /// any case, and a user entry can only add to it.
    #[test]
    fn the_blocklist_matches_every_name_an_application_goes_by() {
        let me = SelfIdentity::default();
        let list = Blocklist::new(&[
            "  com.example.Vault ".to_string(),
            String::new(),
            "Vault Browser.app".to_string(),
        ]);
        for blocked in [
            app(1, Some("com.1password.1password"), None),
            app(1, Some("COM.APPLE.KEYCHAINACCESS"), None),
            app(1, None, Some("C:\\Program Files\\Bitwarden\\Bitwarden.exe")),
            app(
                1,
                None,
                Some("C:\\Windows\\ImmersiveControlPanel\\SystemSettings.exe"),
            ),
            app(1, None, Some("/usr/bin/keepassxc")),
            app(1, Some("com.example.vault"), None),
            // A clone of a bundle named on the list by its file name.
            app(
                1,
                Some("com.example.browser"),
                Some("/private/var/folders/xy/X/c/Vault Browser.app.bundle"),
            ),
        ] {
            assert_eq!(
                grantable(&blocked, &me, &list),
                Err(NotGrantable::Blocklisted),
                "{blocked:?}"
            );
        }
        assert_eq!(
            grantable(&app(1, Some("com.apple.Safari"), None), &me, &list),
            Ok(())
        );
        // An empty user entry is not a wildcard.
        assert!(!list.matches(&app(1, None, None)));
    }

    /// A default the person took off no longer blocks — by any of its names,
    /// System Settings as much as any other; the rest stay.
    #[test]
    fn a_default_taken_off_the_list_no_longer_blocks() {
        let list = Blocklist::configured(
            &["com.example.vault".to_string()],
            &[
                "1password".to_string(),
                "system-settings".to_string(),
                "no-such-entry".to_string(),
            ],
        );
        assert!(!list.matches(&app(1, Some("com.1password.1password"), None)));
        assert!(!list.matches(&app(1, Some("com.agilebits.onepassword7"), None)));
        assert!(!list.matches(&app(1, None, Some("C:\\Apps\\1Password.exe"))));
        assert!(!list.matches(&app(1, Some("com.apple.systempreferences"), None)));
        assert!(!list.matches(&app(1, Some("com.apple.Settings"), None)));
        assert!(list.matches(&app(1, Some("com.apple.SecurityAgent"), None)));
        assert!(list.matches(&app(1, Some("com.bitwarden.desktop"), None)));
        assert!(list.matches(&app(1, Some("com.example.vault"), None)));
        assert!(is_default_key("1password"));
        assert!(is_default_key("system-settings"));
        assert!(!is_default_key("no-such-entry"));
    }

    /// The settings show each platform only the entries it has a name for,
    /// in list order, by the names that platform uses.
    #[test]
    fn each_platform_is_shown_the_defaults_it_names() {
        let mac = default_blocklist(Platform::Mac);
        assert_eq!(mac[0].key, "system-settings");
        assert_eq!(
            mac[0].names,
            vec!["com.apple.systempreferences", "com.apple.Settings"]
        );
        assert!(mac.iter().any(|b| b.key == "passwords"));
        assert!(!mac
            .iter()
            .any(|b| b.key == "keepass" || b.key == "seahorse"));
        let windows = default_blocklist(Platform::Windows);
        assert!(windows.iter().any(|b| b.key == "keepass"));
        assert!(!windows.iter().any(|b| b.key == "passwords"));
        let linux = default_blocklist(Platform::Linux);
        assert!(linux.iter().any(|b| b.key == "seahorse"));
        assert!(!linux.iter().any(|b| b.key == "system-settings"));
        // Keys are unique: a removal names exactly one entry.
        let mut keys: Vec<&str> = DEFAULT_BLOCKLIST.iter().map(|b| b.key).collect();
        keys.sort_unstable();
        keys.dedup();
        assert_eq!(keys.len(), DEFAULT_BLOCKLIST.len());
    }

    /// A window whose process has no start time, or whose application has no
    /// name a blocklist could match, cannot be shared: the grant could not be
    /// held to it.
    #[test]
    fn an_application_codeg_cannot_identify_is_not_grantable() {
        let me = SelfIdentity::default();
        let list = Blocklist::new(&[]);
        let mut no_start = app(1, Some("com.apple.TextEdit"), None);
        no_start.started_at = None;
        assert_eq!(
            grantable(&no_start, &me, &list),
            Err(NotGrantable::Unidentified)
        );
        assert_eq!(
            grantable(&app(1, None, None), &me, &list),
            Err(NotGrantable::Unidentified)
        );
        assert_eq!(
            grantable(&app(1, None, Some("/Applications/TextEdit.app")), &me, &list),
            Ok(())
        );
    }

    /// A title shows from Read up, and never as an empty string.
    #[test]
    fn titles_follow_the_grant() {
        assert_eq!(visible_title(GrantLevel::None, "Inbox — Mail"), None);
        assert_eq!(
            visible_title(GrantLevel::Read, "Inbox — Mail").as_deref(),
            Some("Inbox — Mail")
        );
        assert_eq!(
            visible_title(GrantLevel::Control, "Inbox — Mail").as_deref(),
            Some("Inbox — Mail")
        );
        assert_eq!(visible_title(GrantLevel::Read, ""), None);
    }

    /// The idle clock runs from the last read, and "no timeout" never lapses.
    #[test]
    fn a_grant_lapses_only_after_going_unused_for_the_timeout() {
        let ttl = Some(Duration::from_secs(60));
        let mut grant = ComputerGrant::new(GrantLevel::Read, 1_000);
        assert!(!grant.lapsed(1_000 + 59_999, ttl));
        assert!(grant.lapsed(1_000 + 60_000, ttl));
        grant.last_used_at = 50_000;
        assert!(!grant.lapsed(1_000 + 60_000, ttl));
        assert!(grant.lapsed(50_000 + 60_000, ttl));
        assert!(!grant.lapsed(i64::MAX, None));
    }

    /// A clock that steps back a little does not end a grant; one that steps
    /// back far does, rather than stretching the timeout by the jump.
    #[test]
    fn a_clock_that_went_back_far_ends_the_grant() {
        let ttl = Some(Duration::from_secs(30 * 60));
        let grant = ComputerGrant::new(GrantLevel::Read, 10_000_000);
        assert!(!grant.lapsed(10_000_000 - 1_000, ttl));
        assert!(grant.lapsed(10_000_000 - MAX_CLOCK_SKEW_MS - 1, ttl));
        // "Until I take it back" is not a clock question.
        assert!(!grant.lapsed(0, None));
    }

    #[test]
    fn generations_name_the_epoch_and_the_read() {
        assert_eq!(generation(3, 17), "3.17");
    }
}
