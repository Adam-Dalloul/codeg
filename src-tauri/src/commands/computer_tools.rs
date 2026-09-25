//! The computer-use settings: whether an agent may see the desktop at all,
//! how long a shared window stays shared unused, which applications can
//! never be shared, and the shortcut that stops every agent at once.
//!
//! Separate from `commands::computer`, which is the desktop feature itself and
//! exists only in the desktop build: these switches are read by the shared
//! codeg-mcp plumbing (injection, the service-status popover), so they compile
//! in server mode too — where computer use is simply never advertised.
//!
//! **Off by default.** It hands an agent a view of the user's screen.
//! Sharing an individual window is a second decision on top of it
//! (`crate::computer::agent`); this switch only decides whether the tools
//! exist. Switching it off ends every grant and stops the helper — that part
//! lives with the desktop's computer service, which watches the runtime
//! config.

use std::time::Duration;

use sea_orm::DatabaseConnection;
use serde::{Deserialize, Serialize};

use crate::acp::computer_tools::{ComputerToolsConfig, ComputerToolsRuntimeConfig};
use crate::app_error::AppCommandError;
use crate::computer::keys::Platform;
use crate::computer::stop_shortcut::StopShortcut;
use crate::db::service::app_metadata_service;
use crate::web::event_bridge::{emit_event, EventEmitter, COMPUTER_TOOLS_SETTINGS_CHANGED_EVENT};

pub const KEY_COMPUTER_TOOLS_ENABLED: &str = "computer_tools.enabled";

/// Minutes a shared window may go unread before its sharing ends; `0` is
/// "until the user takes it back".
pub const KEY_COMPUTER_TOOLS_GRANT_TTL_MINUTES: &str = "computer_tools.grant_ttl_minutes";

/// Applications the user added to the built-in blocklist, as a JSON array of
/// bundle identifiers, paths or executable names.
pub const KEY_COMPUTER_TOOLS_BLOCKLIST: &str = "computer_tools.blocklist";

/// The shortcut that stops every agent at once, spelled as
/// `computer::stop_shortcut` spells it; empty is "none". Absent is the
/// platform's default.
pub const KEY_COMPUTER_TOOLS_STOP_SHORTCUT: &str = "computer_tools.stop_shortcut";

/// The grant timeout when the user has chosen none.
pub const DEFAULT_GRANT_TTL_MINUTES: u32 = 30;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ComputerToolsSettings {
    pub enabled: bool,
    #[serde(default = "default_ttl")]
    pub grant_ttl_minutes: u32,
    #[serde(default)]
    pub blocklist: Vec<String>,
    /// The stop shortcut's spelling; empty when the person switched it off.
    #[serde(default = "default_stop_shortcut")]
    pub stop_shortcut: String,
}

fn default_ttl() -> u32 {
    DEFAULT_GRANT_TTL_MINUTES
}

fn default_stop_shortcut() -> String {
    StopShortcut::default_for(Platform::current()).to_string()
}

impl Default for ComputerToolsSettings {
    fn default() -> Self {
        Self {
            enabled: false,
            grant_ttl_minutes: DEFAULT_GRANT_TTL_MINUTES,
            blocklist: Vec::new(),
            stop_shortcut: default_stop_shortcut(),
        }
    }
}

impl ComputerToolsSettings {
    fn into_runtime_config(self) -> ComputerToolsConfig {
        ComputerToolsConfig {
            enabled: self.enabled,
            grant_ttl: (self.grant_ttl_minutes > 0)
                .then(|| Duration::from_secs(u64::from(self.grant_ttl_minutes) * 60)),
            blocklist: normalize_blocklist(self.blocklist),
            stop_shortcut: StopShortcut::from_setting(&self.stop_shortcut, Platform::current()),
            // Kept by the runtime handle, not by the record.
            switched_off: 0,
        }
    }
}

/// A stop shortcut as the record keeps it: off (empty), or a shortcut this
/// platform accepts, written in the one order. Anything else is refused on
/// the way in; on the way out of the database it reads as whatever
/// [`StopShortcut::from_setting`] makes of it, so the record shows the
/// shortcut in force.
fn checked_stop_shortcut(spelling: &str) -> Result<String, AppCommandError> {
    if spelling.is_empty() {
        return Ok(String::new());
    }
    StopShortcut::parse(spelling, Platform::current())
        .map(|shortcut| shortcut.to_string())
        .map_err(|e| AppCommandError::configuration_invalid(format!("stop shortcut: {e}")))
}

fn stored_stop_shortcut(spelling: &str) -> String {
    StopShortcut::from_setting(spelling, Platform::current())
        .map(|shortcut| shortcut.to_string())
        .unwrap_or_default()
}

/// Trimmed, non-empty, de-duplicated entries in the order they were given.
fn normalize_blocklist(entries: Vec<String>) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for entry in entries {
        let entry = entry.trim().to_string();
        if !entry.is_empty() && !out.iter().any(|e| e.eq_ignore_ascii_case(&entry)) {
            out.push(entry);
        }
    }
    out
}

/// Read the persisted keys, falling back to the defaults for a missing or
/// malformed value. Never errors hard.
pub async fn load_computer_tools_settings(conn: &DatabaseConnection) -> ComputerToolsSettings {
    let mut settings = ComputerToolsSettings::default();
    let get = |key: &'static str| async move {
        app_metadata_service::get_value(conn, key)
            .await
            .ok()
            .flatten()
    };
    if let Some(v) = get(KEY_COMPUTER_TOOLS_ENABLED)
        .await
        .and_then(|r| r.parse().ok())
    {
        settings.enabled = v;
    }
    if let Some(v) = get(KEY_COMPUTER_TOOLS_GRANT_TTL_MINUTES)
        .await
        .and_then(|r| r.parse().ok())
    {
        settings.grant_ttl_minutes = v;
    }
    if let Some(v) = get(KEY_COMPUTER_TOOLS_BLOCKLIST)
        .await
        .and_then(|r| serde_json::from_str::<Vec<String>>(&r).ok())
    {
        settings.blocklist = normalize_blocklist(v);
    }
    if let Some(v) = get(KEY_COMPUTER_TOOLS_STOP_SHORTCUT).await {
        settings.stop_shortcut = stored_stop_shortcut(&v);
    }
    settings
}

/// Pull settings from the DB onto the shared runtime handle. Idempotent — safe
/// on startup or after any save.
pub async fn apply_persisted_computer_tools_config(
    conn: &DatabaseConnection,
    config: &ComputerToolsRuntimeConfig,
) {
    let settings = load_computer_tools_settings(conn).await;
    config.set(settings.into_runtime_config()).await;
}

/// Serializes every write of this record — the whole-record writer and the
/// group switch — for the reason the browser's lock exists: the keys are
/// upserted separately, and the status popover and the settings form are two
/// writers one click apart.
static COMPUTER_TOOLS_WRITE_LOCK: std::sync::LazyLock<tokio::sync::Mutex<()>> =
    std::sync::LazyLock::new(|| tokio::sync::Mutex::new(()));

/// Move only the group switch, leaving the rest at whatever the database says
/// at the moment of the write. For the status popover.
pub async fn set_computer_tools_enabled_core(
    conn: &DatabaseConnection,
    config: &ComputerToolsRuntimeConfig,
    emitter: &EventEmitter,
    enabled: bool,
) -> Result<ComputerToolsSettings, AppCommandError> {
    let _guard = COMPUTER_TOOLS_WRITE_LOCK.lock().await;
    app_metadata_service::upsert_value(conn, KEY_COMPUTER_TOOLS_ENABLED, &enabled.to_string())
        .await
        .map_err(AppCommandError::from)?;
    let settings = load_computer_tools_settings(conn).await;
    config.set(settings.clone().into_runtime_config()).await;
    emit_event(emitter, COMPUTER_TOOLS_SETTINGS_CHANGED_EVENT, &settings);
    Ok(settings)
}

/// Move the grant timeout, the user's blocklist, the stop shortcut — only
/// the ones given — leaving everything else at whatever the database says.
/// For the Computer use settings section, which edits these and not the
/// switch (that one lives with the other tool groups, and in the status
/// popover), and which sends only what the person changed: a form that
/// loaded before another window added a blocklist entry must not take it out
/// again by saving a new timeout.
pub async fn set_computer_tools_preferences_core(
    conn: &DatabaseConnection,
    config: &ComputerToolsRuntimeConfig,
    emitter: &EventEmitter,
    grant_ttl_minutes: Option<u32>,
    blocklist: Option<Vec<String>>,
    stop_shortcut: Option<String>,
) -> Result<ComputerToolsSettings, AppCommandError> {
    let blocklist = blocklist
        .map(|list| serde_json::to_string(&normalize_blocklist(list)))
        .transpose()
        .map_err(|e| AppCommandError::configuration_invalid(e.to_string()))?;
    let stop_shortcut = stop_shortcut
        .as_deref()
        .map(checked_stop_shortcut)
        .transpose()?;
    let writes: Vec<(&str, String)> = [
        grant_ttl_minutes.map(|m| (KEY_COMPUTER_TOOLS_GRANT_TTL_MINUTES, m.to_string())),
        blocklist.map(|list| (KEY_COMPUTER_TOOLS_BLOCKLIST, list)),
        stop_shortcut.map(|s| (KEY_COMPUTER_TOOLS_STOP_SHORTCUT, s)),
    ]
    .into_iter()
    .flatten()
    .collect();
    let _guard = COMPUTER_TOOLS_WRITE_LOCK.lock().await;
    if writes.is_empty() {
        return Ok(load_computer_tools_settings(conn).await);
    }
    for (key, value) in writes {
        app_metadata_service::upsert_value(conn, key, &value)
            .await
            .map_err(AppCommandError::from)?;
    }
    let settings = load_computer_tools_settings(conn).await;
    config.set(settings.clone().into_runtime_config()).await;
    emit_event(emitter, COMPUTER_TOOLS_SETTINGS_CHANGED_EVENT, &settings);
    Ok(settings)
}

/// Persist + apply + broadcast the whole record. Shared by the Tauri command
/// and the HTTP handler.
pub async fn set_computer_tools_settings_core(
    conn: &DatabaseConnection,
    config: &ComputerToolsRuntimeConfig,
    emitter: &EventEmitter,
    desired: ComputerToolsSettings,
) -> Result<ComputerToolsSettings, AppCommandError> {
    let desired = ComputerToolsSettings {
        blocklist: normalize_blocklist(desired.blocklist),
        stop_shortcut: checked_stop_shortcut(&desired.stop_shortcut)?,
        ..desired
    };
    let _guard = COMPUTER_TOOLS_WRITE_LOCK.lock().await;
    let blocklist = serde_json::to_string(&desired.blocklist)
        .map_err(|e| AppCommandError::configuration_invalid(e.to_string()))?;
    for (key, value) in [
        (KEY_COMPUTER_TOOLS_ENABLED, desired.enabled.to_string()),
        (
            KEY_COMPUTER_TOOLS_GRANT_TTL_MINUTES,
            desired.grant_ttl_minutes.to_string(),
        ),
        (KEY_COMPUTER_TOOLS_BLOCKLIST, blocklist),
        (
            KEY_COMPUTER_TOOLS_STOP_SHORTCUT,
            desired.stop_shortcut.clone(),
        ),
    ] {
        app_metadata_service::upsert_value(conn, key, &value)
            .await
            .map_err(AppCommandError::from)?;
    }
    config.set(desired.clone().into_runtime_config()).await;
    emit_event(emitter, COMPUTER_TOOLS_SETTINGS_CHANGED_EVENT, &desired);
    Ok(desired)
}

// -------- Tauri commands -----------------------------------------------------

#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn get_computer_tools_settings(
    #[cfg(feature = "tauri-runtime")] db: tauri::State<'_, crate::db::AppDatabase>,
) -> Result<ComputerToolsSettings, AppCommandError> {
    #[cfg(feature = "tauri-runtime")]
    {
        Ok(load_computer_tools_settings(&db.conn).await)
    }
    #[cfg(not(feature = "tauri-runtime"))]
    {
        Err(AppCommandError::configuration_invalid("tauri-only command"))
    }
}

#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn set_computer_tools_settings(
    #[cfg(feature = "tauri-runtime")] app: tauri::AppHandle,
    #[cfg(feature = "tauri-runtime")] db: tauri::State<'_, crate::db::AppDatabase>,
    #[cfg(feature = "tauri-runtime")] config: tauri::State<'_, ComputerToolsRuntimeConfig>,
    settings: ComputerToolsSettings,
) -> Result<ComputerToolsSettings, AppCommandError> {
    #[cfg(feature = "tauri-runtime")]
    {
        let emitter = EventEmitter::Tauri(app);
        set_computer_tools_settings_core(&db.conn, &config, &emitter, settings).await
    }
    #[cfg(not(feature = "tauri-runtime"))]
    {
        let _ = settings;
        Err(AppCommandError::configuration_invalid("tauri-only command"))
    }
}

#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn set_computer_tools_enabled(
    #[cfg(feature = "tauri-runtime")] app: tauri::AppHandle,
    #[cfg(feature = "tauri-runtime")] db: tauri::State<'_, crate::db::AppDatabase>,
    #[cfg(feature = "tauri-runtime")] config: tauri::State<'_, ComputerToolsRuntimeConfig>,
    enabled: bool,
) -> Result<ComputerToolsSettings, AppCommandError> {
    #[cfg(feature = "tauri-runtime")]
    {
        let emitter = EventEmitter::Tauri(app);
        set_computer_tools_enabled_core(&db.conn, &config, &emitter, enabled).await
    }
    #[cfg(not(feature = "tauri-runtime"))]
    {
        let _ = enabled;
        Err(AppCommandError::configuration_invalid("tauri-only command"))
    }
}

#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn set_computer_tools_preferences(
    #[cfg(feature = "tauri-runtime")] app: tauri::AppHandle,
    #[cfg(feature = "tauri-runtime")] db: tauri::State<'_, crate::db::AppDatabase>,
    #[cfg(feature = "tauri-runtime")] config: tauri::State<'_, ComputerToolsRuntimeConfig>,
    grant_ttl_minutes: Option<u32>,
    blocklist: Option<Vec<String>>,
    stop_shortcut: Option<String>,
) -> Result<ComputerToolsSettings, AppCommandError> {
    #[cfg(feature = "tauri-runtime")]
    {
        let emitter = EventEmitter::Tauri(app);
        set_computer_tools_preferences_core(
            &db.conn,
            &config,
            &emitter,
            grant_ttl_minutes,
            blocklist,
            stop_shortcut,
        )
        .await
    }
    #[cfg(not(feature = "tauri-runtime"))]
    {
        let _ = (grant_ttl_minutes, blocklist, stop_shortcut);
        Err(AppCommandError::configuration_invalid("tauri-only command"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A user who never opens the switch has not handed anyone their screen.
    #[test]
    fn agents_cannot_see_the_desktop_until_someone_says_so() {
        let defaults = ComputerToolsSettings::default();
        assert!(!defaults.enabled);
        assert_eq!(defaults.grant_ttl_minutes, DEFAULT_GRANT_TTL_MINUTES);
        assert!(defaults.blocklist.is_empty());
        // Stop, though, is there from the start.
        assert_eq!(
            defaults.into_runtime_config().stop_shortcut,
            Some(StopShortcut::default_for(Platform::current()))
        );
    }

    /// Zero minutes is "no timeout", and blocklist entries are tidied without
    /// losing any.
    #[test]
    fn the_runtime_config_reads_the_record() {
        let cfg = ComputerToolsSettings {
            enabled: true,
            grant_ttl_minutes: 0,
            blocklist: vec![
                " com.example.Vault ".into(),
                String::new(),
                "COM.EXAMPLE.VAULT".into(),
                "keepass.exe".into(),
            ],
            stop_shortcut: String::new(),
        }
        .into_runtime_config();
        assert_eq!(cfg.grant_ttl, None);
        assert_eq!(cfg.blocklist, vec!["com.example.Vault", "keepass.exe"]);
        assert_eq!(cfg.stop_shortcut, None);

        let cfg = ComputerToolsSettings::default().into_runtime_config();
        assert_eq!(cfg.grant_ttl, Some(Duration::from_secs(30 * 60)));
    }

    /// Saving one preference leaves the other as another writer left it — a
    /// timeout saved from a form that loaded before a blocklist entry was
    /// added does not take the entry out again.
    #[tokio::test]
    async fn a_preference_write_touches_only_what_it_names() {
        let db = crate::db::test_helpers::fresh_in_memory_db().await;
        let config = ComputerToolsRuntimeConfig::new();
        let emitter = EventEmitter::Noop;
        set_computer_tools_preferences_core(
            &db.conn,
            &config,
            &emitter,
            None,
            Some(vec!["com.example.Vault".into()]),
            None,
        )
        .await
        .unwrap();
        let saved =
            set_computer_tools_preferences_core(&db.conn, &config, &emitter, Some(10), None, None)
                .await
                .unwrap();
        assert_eq!(saved.grant_ttl_minutes, 10);
        assert_eq!(saved.blocklist, vec!["com.example.Vault"]);
        assert_eq!(config.snapshot().await.blocklist, vec!["com.example.Vault"]);
        let untouched =
            set_computer_tools_preferences_core(&db.conn, &config, &emitter, None, None, None)
                .await
                .unwrap();
        assert_eq!(untouched, saved);
    }

    /// The stop shortcut is saved as the one spelling, switched off as empty,
    /// and a spelling that is no shortcut here is refused without touching
    /// what is stored.
    #[tokio::test]
    async fn the_stop_shortcut_is_checked_on_the_way_in() {
        let db = crate::db::test_helpers::fresh_in_memory_db().await;
        let config = ComputerToolsRuntimeConfig::new();
        let emitter = EventEmitter::Noop;
        let set = |spelling: &str| {
            set_computer_tools_preferences_core(
                &db.conn,
                &config,
                &emitter,
                None,
                None,
                Some(spelling.to_string()),
            )
        };
        let saved = set("Shift+Control+KeyK").await.unwrap();
        assert_eq!(saved.stop_shortcut, "Control+Shift+KeyK");
        assert_eq!(
            config.snapshot().await.stop_shortcut.map(|s| s.to_string()),
            Some("Control+Shift+KeyK".to_string())
        );
        for bad in [
            "Control+KeyK",
            "Control+Alt+MediaPlayPause",
            "Ctrl+Alt+KeyK",
        ] {
            assert!(set(bad).await.is_err(), "{bad} saved");
        }
        assert_eq!(
            load_computer_tools_settings(&db.conn).await.stop_shortcut,
            "Control+Shift+KeyK"
        );
        let off = set("").await.unwrap();
        assert_eq!(off.stop_shortcut, "");
        assert_eq!(config.snapshot().await.stop_shortcut, None);
    }

    /// A stored spelling this platform cannot register — a database carried
    /// over from another platform's codeg — reads as the default: the record
    /// shows the shortcut in force.
    #[tokio::test]
    async fn a_foreign_stored_shortcut_reads_as_the_default() {
        let db = crate::db::test_helpers::fresh_in_memory_db().await;
        app_metadata_service::upsert_value(
            &db.conn,
            KEY_COMPUTER_TOOLS_STOP_SHORTCUT,
            "Control+Alt+MediaPlayPause",
        )
        .await
        .unwrap();
        assert_eq!(
            load_computer_tools_settings(&db.conn).await.stop_shortcut,
            StopShortcut::default_for(Platform::current()).to_string()
        );
    }

    /// A record from before the timeout and blocklist existed still loads.
    #[test]
    fn an_older_record_takes_the_defaults() {
        let parsed: ComputerToolsSettings =
            serde_json::from_value(serde_json::json!({ "enabled": true })).unwrap();
        assert!(parsed.enabled);
        assert_eq!(parsed.grant_ttl_minutes, DEFAULT_GRANT_TTL_MINUTES);
        assert_eq!(parsed.stop_shortcut, default_stop_shortcut());
    }
}
