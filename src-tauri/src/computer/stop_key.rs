//! The stop shortcut as the OS holds it: registered while computer use is on
//! and a shortcut is chosen, gone otherwise, and — because another
//! application may already hold the same keys — a status the panel can show,
//! so nobody counts on a shortcut that does nothing.
//!
//! The keys come from [`StopShortcut`], which never names one that would take
//! a permission to watch (see its module note).

use std::sync::Mutex;

use serde::Serialize;
use tauri::{AppHandle, Manager, Wry};
use tauri_plugin_global_shortcut::{GlobalShortcut, Shortcut, ShortcutState};

use super::stop_shortcut::StopShortcut;

/// Where the stop shortcut stands.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StopKeyStatus {
    /// The shortcut in force, spelled as the settings spell it.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub active: Option<String>,
    /// The shortcut the settings name that the OS would not take — most
    /// likely another application holds it — and what the OS said.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub failed: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

#[derive(Default)]
struct Inner {
    registered: Option<(StopShortcut, Shortcut)>,
    status: StopKeyStatus,
}

/// See the module note.
#[derive(Default)]
pub struct StopKey {
    inner: Mutex<Inner>,
}

impl StopKey {
    pub fn new() -> Self {
        Self::default()
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Inner> {
        self.inner.lock().unwrap_or_else(|p| p.into_inner())
    }

    pub fn status(&self) -> StopKeyStatus {
        self.lock().status.clone()
    }

    /// Hold `wanted` with the OS, and nothing else; `on_press` is what
    /// pressing it does. Returns the status when it changed.
    ///
    /// Blocks until the main thread has registered the keys, so it is called
    /// from a task, never from the main thread's own event handling.
    pub fn sync(
        &self,
        app: &AppHandle,
        wanted: Option<&StopShortcut>,
        on_press: impl Fn() + Send + Sync + 'static,
    ) -> Option<StopKeyStatus> {
        let plugin = app.try_state::<GlobalShortcut<Wry>>()?;
        let mut inner = self.lock();
        if inner.registered.as_ref().map(|(held, _)| held) == wanted {
            return None;
        }
        if let Some((held, hotkey)) = inner.registered.take() {
            if let Err(e) = plugin.unregister(hotkey) {
                tracing::warn!("[computer] could not release the stop shortcut {held}: {e}");
            }
        }
        let mut status = StopKeyStatus::default();
        if let Some(wanted) = wanted {
            let registered = match wanted.hotkey() {
                Some(hotkey) => plugin
                    .on_shortcut(hotkey, move |_, _, event| {
                        if event.state() == ShortcutState::Pressed {
                            on_press();
                        }
                    })
                    .map(|()| hotkey)
                    .map_err(|e| e.to_string()),
                None => Err("not a key the stop shortcut can be on".to_string()),
            };
            match registered {
                Ok(hotkey) => {
                    inner.registered = Some((wanted.clone(), hotkey));
                    status.active = Some(wanted.to_string());
                }
                Err(detail) => {
                    tracing::warn!(
                        "[computer] the stop shortcut {wanted} is not in force: {detail}"
                    );
                    status.failed = Some(wanted.to_string());
                    status.detail = Some(detail);
                }
            }
        }
        if inner.status == status {
            return None;
        }
        inner.status = status.clone();
        Some(status)
    }
}
