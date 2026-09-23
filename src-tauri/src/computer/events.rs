//! What the frontend is told about computer use — on the desktop webview only.
//!
//! Deliberately not `web::event_bridge::emit_event`, which also fans every
//! event out to the web service's clients. What these carry — the titles of
//! the windows a person shared, which of their applications an agent just
//! looked at — is about this machine's screen, and a browser connected to
//! the web service is somewhere else. Sharing a window is a desktop-only
//! action, and so is watching it.

use serde::Serialize;
use tauri::{AppHandle, Emitter};

use super::agent::{
    ComputerActivityPayload, ComputerGrantPayload, AGENT_ACTIVITY_EVENT, AGENT_GRANT_EVENT,
};
use super::backend::BackendStatus;
use super::targets::SharedWindow;

/// Every window with a grant in force — the source of truth for the panel.
pub const STATE_EVENT: &str = "computer://state";

/// The helper's state, for the panel's status line.
pub const BACKEND_STATUS_EVENT: &str = "computer://backend-status";

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct StatePayload<'a> {
    shared: &'a [SharedWindow],
}

pub fn emit_state(app: &AppHandle, shared: &[SharedWindow]) {
    let _ = app.emit(STATE_EVENT, StatePayload { shared });
}

pub fn emit_grant(app: &AppHandle, payload: &ComputerGrantPayload) {
    let _ = app.emit(AGENT_GRANT_EVENT, payload);
}

pub fn emit_activity(app: &AppHandle, payload: &ComputerActivityPayload) {
    let _ = app.emit(AGENT_ACTIVITY_EVENT, payload);
}

pub fn emit_backend_status(app: &AppHandle, status: &BackendStatus) {
    let _ = app.emit(BACKEND_STATUS_EVENT, status);
}
