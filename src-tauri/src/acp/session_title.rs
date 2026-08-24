//! Live ACP session titles.
//!
//! Agents publish a session name through `session_info_update.title`. Codeg
//! used to ignore that field and only adopt a title the next time the
//! conversation was loaded from disk. These helpers extract a usable title
//! from the live notification so the lifecycle worker can write it immediately.
//!
//! Not every agent can push. Claude Code's adapter has no wire event for its
//! generated title — it reads the name back out of the session file at
//! turn-end — so `acp::background_watch` reads the same `ai-title` /
//! `custom-title` records off the transcript it is already tailing and hands
//! them to [`publish_native_title`], which is the one place that decides
//! whether a title reaches the lifecycle worker.

use std::sync::Arc;

use tokio::sync::RwLock;

use crate::acp::session_state::SessionState;
use crate::acp::types::AcpEvent;
use crate::web::event_bridge::{emit_with_state, EventEmitter};

/// Pull a usable session title out of ACP `session_info_update.title`.
///
/// `Undefined` (passed in as `None`) means the update did not touch the title
/// and is ignored. The schema also uses `Null` to mean "clear"; we treat that
/// the same as absent on purpose so an explicit clear cannot wipe the row
/// back to Untitled. Whitespace-only strings are ignored for the same reason.
pub(crate) fn native_title_from_session_info(title: Option<&str>) -> Option<String> {
    let t = title?.trim();
    if t.is_empty() {
        None
    } else {
        Some(crate::parsers::truncate_str(t, 100))
    }
}

/// Emit `title` as this connection's live session title, unless it is a repeat
/// of the last one emitted here.
///
/// Test and set under ONE write lock. Nothing can interleave here today — a
/// session's notifications are handled serially, and the only other writer of
/// `last_native_title` is the `ConversationLinked` arm, which is emitted ONLY
/// while the row is still unbound and therefore can never race a title this
/// admits. That safety would otherwise rest on two guards in different files
/// agreeing; keeping the halves in one critical section makes it hold by
/// construction instead.
///
/// A title published before the first prompt binds the row has nowhere to land
/// and is dropped WITHOUT being remembered, so the same string is still
/// accepted once the row exists.
///
/// The emitted `NativeSessionTitle` reaches `acp::lifecycle`, whose
/// `refresh_auto_title` write is itself a no-op on a user-renamed
/// (`title_locked`) row and on an unchanged value — so repeats that do get
/// past the skip-cache still cost nothing and can never overwrite a name the
/// user chose.
pub(crate) async fn publish_native_title(
    state: &Arc<RwLock<SessionState>>,
    emitter: &EventEmitter,
    title: String,
) {
    let admit = {
        let mut s = state.write().await;
        let admit = s.conversation_id.is_some()
            && s.last_native_title.as_deref() != Some(title.as_str());
        if admit {
            s.last_native_title = Some(title.clone());
        }
        admit
    };
    if admit {
        emit_with_state(state, emitter, AcpEvent::NativeSessionTitle { title }).await;
    }
}

#[cfg(test)]
mod tests {
    use super::native_title_from_session_info;

    #[test]
    fn rejects_missing_and_blank() {
        assert_eq!(native_title_from_session_info(None), None);
        assert_eq!(native_title_from_session_info(Some("")), None);
        assert_eq!(native_title_from_session_info(Some("   ")), None);
        assert_eq!(native_title_from_session_info(Some("\n\t")), None);
    }

    #[test]
    fn trims_and_keeps_a_real_title() {
        assert_eq!(
            native_title_from_session_info(Some("  Fix login flow  ")).as_deref(),
            Some("Fix login flow")
        );
    }

    #[test]
    fn caps_at_parser_title_length() {
        let long = "a".repeat(150);
        let got = native_title_from_session_info(Some(&long)).unwrap();
        assert_eq!(got, crate::parsers::truncate_str(&long, 100));
        assert!(got.ends_with("..."));
    }
}
