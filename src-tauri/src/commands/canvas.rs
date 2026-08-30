//! Conversation canvas: persisted regions / pinned cards / notes, shared by
//! every window and client of one workspace backend.
//!
//! The `*_core` fns are mode-agnostic (plain references, no `tauri::State`) and
//! emit `CANVAS_CHANGED_EVENT` after commit so both the Tauri command wrappers
//! and the Axum handlers share one code path. Ordering protocol: every
//! committed mutation is exactly one event carrying a dense server revision
//! (see `canvas_service`); clients apply events in revision order, treat a gap
//! as "refetch the snapshot", and never advance their revision from a command
//! response — so response/event arrival order cannot lose state.

use serde::{Deserialize, Serialize};
use std::sync::OnceLock;
use tokio::sync::Mutex;

use crate::app_error::AppCommandError;
use crate::db::entities::canvas_node::CanvasNodeKind;
use crate::db::error::DbError;
use crate::db::service::canvas_service;
use crate::db::AppDatabase;
use crate::models::canvas::{CanvasMutation, CanvasNode, CanvasSnapshot};
use crate::web::event_bridge::{emit_event, EventEmitter};

/// Serializes each mutation's `commit → broadcast` PAIR. The service's
/// revision lock only orders the commits; without this outer lock two commands
/// could commit as revisions N and N+1 but broadcast in the opposite order,
/// and every client would burn a snapshot refetch on a phantom gap. Outer lock
/// here, inner lock in the service — always acquired in that order, so the
/// pair cannot deadlock, and service fns stay directly callable (funnel,
/// tests) under their own serialization.
fn event_order_lock() -> &'static Mutex<()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
}

/// Broadcast on every committed canvas mutation, to every window / web client /
/// remote session of this backend.
pub const CANVAS_CHANGED_EVENT: &str = "canvas://changed";

/// One committed mutation. Payloads are full-state and idempotent so every
/// client — including the originator — applies them identically; `revision` is
/// the dense total order (exactly one event per bump).
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum CanvasChange {
    Upsert {
        node: Box<CanvasNode>,
        revision: i64,
    },
    Moved {
        moves: Vec<CanvasNodeMovePayload>,
        revision: i64,
    },
    Deleted {
        id: i32,
        revision: i64,
    },
    /// A member card dragged out of a region: membership removal (custom
    /// regions only) and pin creation in one transaction, hence one event.
    Detached {
        removed_from: Option<i32>,
        node: Box<CanvasNode>,
        revision: i64,
    },
    /// Deletion-funnel cleanup after conversations were removed: pinned nodes
    /// dropped and custom regions scrubbed, as one batch event.
    Pruned {
        deleted_ids: Vec<i32>,
        updated: Vec<CanvasNode>,
        revision: i64,
    },
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
pub struct CanvasNodeMovePayload {
    pub id: i32,
    pub x: f64,
    pub y: f64,
}

/// Request shape for `canvas_create_node`. camelCase like every other request
/// struct (`FolderLinkRequest` precedent); binding columns are validated
/// kind-specifically at the service chokepoint.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateCanvasNode {
    pub kind: CanvasNodeKind,
    #[serde(default)]
    pub folder_id: Option<i32>,
    #[serde(default)]
    pub agent_type: Option<String>,
    #[serde(default)]
    pub conversation_id: Option<i32>,
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub content: Option<String>,
    #[serde(default)]
    pub color: Option<String>,
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

/// Field-by-field patch; absent = untouched, empty string clears a nullable
/// text field. `member_add` / `member_remove` are atomic server-side list ops.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CanvasNodePatchInput {
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub content: Option<String>,
    #[serde(default)]
    pub color: Option<String>,
    #[serde(default)]
    pub collapsed: Option<bool>,
    #[serde(default)]
    pub x: Option<f64>,
    #[serde(default)]
    pub y: Option<f64>,
    #[serde(default)]
    pub width: Option<f64>,
    #[serde(default)]
    pub height: Option<f64>,
    #[serde(default)]
    pub member_add: Option<i32>,
    #[serde(default)]
    pub member_remove: Option<i32>,
}

impl From<CanvasNodePatchInput> for canvas_service::CanvasNodePatch {
    fn from(p: CanvasNodePatchInput) -> Self {
        canvas_service::CanvasNodePatch {
            title: p.title,
            content: p.content,
            color: p.color,
            collapsed: p.collapsed,
            x: p.x,
            y: p.y,
            width: p.width,
            height: p.height,
            member_add: p.member_add,
            member_remove: p.member_remove,
        }
    }
}

/// Map service errors onto user-facing codes: liveness/shape rejections are the
/// caller's mistake (`invalid_input`), missing rows are `not_found` — the
/// blanket `From<DbError>` would flatten both into an opaque `database_error`.
fn map_db(e: DbError) -> AppCommandError {
    match e {
        DbError::NotFound(msg) => AppCommandError::not_found(msg),
        DbError::Validation(msg) => AppCommandError::invalid_input(msg),
        other => AppCommandError::from(other),
    }
}

// ---------------------------------------------------------------------------
// Core (mode-agnostic)
// ---------------------------------------------------------------------------

pub async fn canvas_list_nodes_core(db: &AppDatabase) -> Result<CanvasSnapshot, AppCommandError> {
    let (rows, revision) = canvas_service::snapshot(&db.conn).await.map_err(map_db)?;
    Ok(CanvasSnapshot {
        nodes: rows.into_iter().map(CanvasNode::from).collect(),
        revision,
    })
}

pub async fn canvas_create_node_core(
    emitter: &EventEmitter,
    db: &AppDatabase,
    input: CreateCanvasNode,
) -> Result<CanvasMutation<CanvasNode>, AppCommandError> {
    let _order = event_order_lock().lock().await;
    let (row, revision) = canvas_service::create_node(
        &db.conn,
        canvas_service::NewCanvasNode {
            kind: input.kind,
            folder_id: input.folder_id,
            agent_type: input.agent_type,
            conversation_id: input.conversation_id,
            title: input.title,
            content: input.content,
            color: input.color,
            x: input.x,
            y: input.y,
            width: input.width,
            height: input.height,
        },
    )
    .await
    .map_err(map_db)?;
    let node = CanvasNode::from(row);
    emit_event(
        emitter,
        CANVAS_CHANGED_EVENT,
        CanvasChange::Upsert {
            node: Box::new(node.clone()),
            revision,
        },
    );
    Ok(CanvasMutation {
        value: node,
        revision,
    })
}

pub async fn canvas_update_node_core(
    emitter: &EventEmitter,
    db: &AppDatabase,
    node_id: i32,
    patch: CanvasNodePatchInput,
) -> Result<CanvasMutation<CanvasNode>, AppCommandError> {
    let _order = event_order_lock().lock().await;
    let (row, revision) = canvas_service::update_node(&db.conn, node_id, patch.into())
        .await
        .map_err(map_db)?;
    let node = CanvasNode::from(row);
    emit_event(
        emitter,
        CANVAS_CHANGED_EVENT,
        CanvasChange::Upsert {
            node: Box::new(node.clone()),
            revision,
        },
    );
    Ok(CanvasMutation {
        value: node,
        revision,
    })
}

/// Returns the moves as actually written (clamped, ghosts dropped) — the same
/// payload the broadcast carries, so optimistic client state can't diverge
/// from the database.
pub async fn canvas_move_nodes_core(
    emitter: &EventEmitter,
    db: &AppDatabase,
    moves: Vec<CanvasNodeMovePayload>,
) -> Result<CanvasMutation<Vec<CanvasNodeMovePayload>>, AppCommandError> {
    let _order = event_order_lock().lock().await;
    let service_moves: Vec<canvas_service::CanvasNodeMove> = moves
        .iter()
        .map(|m| canvas_service::CanvasNodeMove {
            id: m.id,
            x: m.x,
            y: m.y,
        })
        .collect();
    match canvas_service::move_nodes(&db.conn, &service_moves)
        .await
        .map_err(map_db)?
    {
        Some((applied, revision)) => {
            let applied: Vec<CanvasNodeMovePayload> = applied
                .into_iter()
                .map(|m| CanvasNodeMovePayload {
                    id: m.id,
                    x: m.x,
                    y: m.y,
                })
                .collect();
            emit_event(
                emitter,
                CANVAS_CHANGED_EVENT,
                CanvasChange::Moved {
                    moves: applied.clone(),
                    revision,
                },
            );
            Ok(CanvasMutation {
                value: applied,
                revision,
            })
        }
        // Nothing was written (empty batch / every id raced a delete): no
        // bump, no event — report the current revision for coherence.
        None => {
            let revision = canvas_service::get_revision(&db.conn)
                .await
                .map_err(map_db)?;
            Ok(CanvasMutation {
                value: Vec::new(),
                revision,
            })
        }
    }
}

pub async fn canvas_detach_member_core(
    emitter: &EventEmitter,
    db: &AppDatabase,
    region_id: i32,
    conversation_id: i32,
    x: f64,
    y: f64,
) -> Result<CanvasMutation<CanvasNode>, AppCommandError> {
    let _order = event_order_lock().lock().await;
    let outcome = canvas_service::detach_member(&db.conn, region_id, conversation_id, x, y)
        .await
        .map_err(map_db)?;
    let node = CanvasNode::from(outcome.node);
    emit_event(
        emitter,
        CANVAS_CHANGED_EVENT,
        CanvasChange::Detached {
            removed_from: outcome.removed_from,
            node: Box::new(node.clone()),
            revision: outcome.revision,
        },
    );
    Ok(CanvasMutation {
        value: node,
        revision: outcome.revision,
    })
}

pub async fn canvas_delete_node_core(
    emitter: &EventEmitter,
    db: &AppDatabase,
    node_id: i32,
) -> Result<CanvasMutation<()>, AppCommandError> {
    let _order = event_order_lock().lock().await;
    match canvas_service::delete_node(&db.conn, node_id)
        .await
        .map_err(map_db)?
    {
        Some(revision) => {
            emit_event(
                emitter,
                CANVAS_CHANGED_EVENT,
                CanvasChange::Deleted {
                    id: node_id,
                    revision,
                },
            );
            Ok(CanvasMutation {
                value: (),
                revision,
            })
        }
        // Already gone: nothing changed, no bump, no event — report the current
        // revision so the response stays coherent for the caller.
        None => {
            let revision = canvas_service::get_revision(&db.conn)
                .await
                .map_err(map_db)?;
            Ok(CanvasMutation {
                value: (),
                revision,
            })
        }
    }
}

/// Deletion-funnel hook, called from `delete_conversation_with_cleanup_core`
/// right next to the tab cleanup (same reasoning: conversation deletion is
/// soft, so no FK cascade will ever scrub the references). Best-effort at this
/// layer — the prune itself is transactional, and if it fails the references
/// stay behind as visible "unresolved" cards the user can remove by hand; the
/// liveness write-barrier guarantees no NEW reference to the dead conversation
/// can ever be minted, so the damage cannot grow.
pub(crate) async fn cleanup_canvas_for_deleted_conversation(
    emitter: &EventEmitter,
    conn: &sea_orm::DatabaseConnection,
    conversation_id: i32,
) {
    let _order = event_order_lock().lock().await;
    match canvas_service::prune_for_conversations(conn, &[conversation_id]).await {
        Ok(Some(outcome)) => {
            emit_event(
                emitter,
                CANVAS_CHANGED_EVENT,
                CanvasChange::Pruned {
                    deleted_ids: outcome.deleted_ids,
                    updated: outcome.updated.into_iter().map(CanvasNode::from).collect(),
                    revision: outcome.revision,
                },
            );
        }
        Ok(None) => {}
        Err(e) => tracing::error!(
            "[canvas] prune failed after deleting conversation {conversation_id}: {e}"
        ),
    }
}

// ---------------------------------------------------------------------------
// Tauri command wrappers
// ---------------------------------------------------------------------------

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn canvas_list_nodes(
    db: tauri::State<'_, AppDatabase>,
) -> Result<CanvasSnapshot, AppCommandError> {
    canvas_list_nodes_core(&db).await
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn canvas_create_node(
    app: tauri::AppHandle,
    db: tauri::State<'_, AppDatabase>,
    input: CreateCanvasNode,
) -> Result<CanvasMutation<CanvasNode>, AppCommandError> {
    canvas_create_node_core(&EventEmitter::Tauri(app), &db, input).await
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn canvas_update_node(
    app: tauri::AppHandle,
    db: tauri::State<'_, AppDatabase>,
    node_id: i32,
    patch: CanvasNodePatchInput,
) -> Result<CanvasMutation<CanvasNode>, AppCommandError> {
    canvas_update_node_core(&EventEmitter::Tauri(app), &db, node_id, patch).await
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn canvas_move_nodes(
    app: tauri::AppHandle,
    db: tauri::State<'_, AppDatabase>,
    moves: Vec<CanvasNodeMovePayload>,
) -> Result<CanvasMutation<Vec<CanvasNodeMovePayload>>, AppCommandError> {
    canvas_move_nodes_core(&EventEmitter::Tauri(app), &db, moves).await
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn canvas_detach_member(
    app: tauri::AppHandle,
    db: tauri::State<'_, AppDatabase>,
    region_id: i32,
    conversation_id: i32,
    x: f64,
    y: f64,
) -> Result<CanvasMutation<CanvasNode>, AppCommandError> {
    canvas_detach_member_core(&EventEmitter::Tauri(app), &db, region_id, conversation_id, x, y)
        .await
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn canvas_delete_node(
    app: tauri::AppHandle,
    db: tauri::State<'_, AppDatabase>,
    node_id: i32,
) -> Result<CanvasMutation<()>, AppCommandError> {
    canvas_delete_node_core(&EventEmitter::Tauri(app), &db, node_id).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::test_helpers::{fresh_in_memory_db, seed_conversation, seed_folder};
    use crate::models::AgentType;

    fn emitter() -> EventEmitter {
        EventEmitter::Noop
    }

    fn region_input(kind: CanvasNodeKind) -> CreateCanvasNode {
        CreateCanvasNode {
            kind,
            folder_id: None,
            agent_type: None,
            conversation_id: None,
            title: None,
            content: None,
            color: None,
            x: 100.0,
            y: 80.0,
            width: 480.0,
            height: 320.0,
        }
    }

    #[tokio::test]
    async fn create_list_roundtrip_advances_the_revision_once_per_mutation() {
        let db = fresh_in_memory_db().await;
        let folder_id = seed_folder(&db, "/tmp/canvas-a").await;

        let first = canvas_create_node_core(
            &emitter(),
            &db,
            CreateCanvasNode {
                folder_id: Some(folder_id),
                ..region_input(CanvasNodeKind::Folder)
            },
        )
        .await
        .expect("create folder region");
        assert_eq!(first.revision, 1);
        assert_eq!(first.value.folder_id, Some(folder_id));

        let second = canvas_create_node_core(
            &emitter(),
            &db,
            CreateCanvasNode {
                agent_type: Some("claude_code".into()),
                ..region_input(CanvasNodeKind::Agent)
            },
        )
        .await
        .expect("create agent region");
        assert_eq!(second.revision, 2);

        let snapshot = canvas_list_nodes_core(&db).await.expect("snapshot");
        assert_eq!(snapshot.revision, 2);
        assert_eq!(snapshot.nodes.len(), 2);
    }

    #[tokio::test]
    async fn create_rejects_missing_bindings_and_dead_conversations() {
        let db = fresh_in_memory_db().await;
        let folder_id = seed_folder(&db, "/tmp/canvas-b").await;

        let no_folder =
            canvas_create_node_core(&emitter(), &db, region_input(CanvasNodeKind::Folder)).await;
        assert!(no_folder.is_err(), "folder region without folder_id");

        let ghost_folder = canvas_create_node_core(
            &emitter(),
            &db,
            CreateCanvasNode {
                folder_id: Some(9999),
                ..region_input(CanvasNodeKind::Folder)
            },
        )
        .await;
        assert!(ghost_folder.is_err(), "folder region for a missing folder");

        // A conversation node must reference a LIVE conversation: the liveness
        // check is the write barrier that keeps a delayed create from
        // resurrecting a deleted reference after the prune ran.
        let conv = seed_conversation(&db, folder_id, AgentType::ClaudeCode).await;
        crate::db::service::conversation_service::soft_delete(&db.conn, conv)
            .await
            .expect("soft delete");
        let dead = canvas_create_node_core(
            &emitter(),
            &db,
            CreateCanvasNode {
                conversation_id: Some(conv),
                ..region_input(CanvasNodeKind::Conversation)
            },
        )
        .await;
        assert!(dead.is_err(), "conversation node for a deleted conversation");
    }

    #[tokio::test]
    async fn member_add_is_validated_deduplicated_and_scrubbed_by_the_prune() {
        let db = fresh_in_memory_db().await;
        let folder_id = seed_folder(&db, "/tmp/canvas-c").await;
        let conv = seed_conversation(&db, folder_id, AgentType::ClaudeCode).await;

        let region = canvas_create_node_core(&emitter(), &db, region_input(CanvasNodeKind::Custom))
            .await
            .expect("custom region")
            .value;

        let patch = CanvasNodePatchInput {
            member_add: Some(conv),
            ..Default::default()
        };
        let updated = canvas_update_node_core(&emitter(), &db, region.id, patch.clone())
            .await
            .expect("member add");
        assert_eq!(updated.value.member_ids, vec![conv]);

        // Adding the same conversation again must not duplicate it.
        let again = canvas_update_node_core(&emitter(), &db, region.id, patch)
            .await
            .expect("idempotent add");
        assert_eq!(again.value.member_ids, vec![conv]);

        // Also pin it as a standalone card so the prune has both shapes to scrub.
        let pin = canvas_create_node_core(
            &emitter(),
            &db,
            CreateCanvasNode {
                conversation_id: Some(conv),
                ..region_input(CanvasNodeKind::Conversation)
            },
        )
        .await
        .expect("pin")
        .value;

        crate::db::service::conversation_service::soft_delete(&db.conn, conv)
            .await
            .expect("soft delete");
        let outcome = canvas_service::prune_for_conversations(&db.conn, &[conv])
            .await
            .expect("prune")
            .expect("something referenced the conversation");
        assert_eq!(outcome.deleted_ids, vec![pin.id]);
        assert_eq!(outcome.updated.len(), 1);
        assert!(
            canvas_service::parse_member_ids(outcome.updated[0].member_ids.as_deref()).is_empty()
        );

        // Post-prune, a stale member_add for the dead conversation is rejected
        // (the liveness half of the barrier).
        let stale = canvas_update_node_core(
            &emitter(),
            &db,
            region.id,
            CanvasNodePatchInput {
                member_add: Some(conv),
                ..Default::default()
            },
        )
        .await;
        assert!(stale.is_err(), "member_add after deletion must be rejected");
    }

    #[tokio::test]
    async fn detach_moves_from_custom_and_copies_from_bindings() {
        let db = fresh_in_memory_db().await;
        let folder_id = seed_folder(&db, "/tmp/canvas-d").await;
        let conv = seed_conversation(&db, folder_id, AgentType::ClaudeCode).await;

        let custom =
            canvas_create_node_core(&emitter(), &db, region_input(CanvasNodeKind::Custom))
                .await
                .expect("custom")
                .value;
        canvas_update_node_core(
            &emitter(),
            &db,
            custom.id,
            CanvasNodePatchInput {
                member_add: Some(conv),
                ..Default::default()
            },
        )
        .await
        .expect("seed member");

        // Custom region: MOVE — membership goes away, a pin appears, one event.
        let moved = canvas_detach_member_core(&emitter(), &db, custom.id, conv, 900.0, 40.0)
            .await
            .expect("detach");
        assert_eq!(moved.value.conversation_id, Some(conv));
        let snapshot = canvas_list_nodes_core(&db).await.expect("snapshot");
        let region_row = snapshot
            .nodes
            .iter()
            .find(|n| n.id == custom.id)
            .expect("region still there");
        assert!(region_row.member_ids.is_empty(), "membership was removed");

        // A stale retry (membership already gone) must NOT mint a second pin.
        let retry = canvas_detach_member_core(&emitter(), &db, custom.id, conv, 900.0, 40.0).await;
        assert!(retry.is_err(), "detach without membership is stale");

        // Folder region: COPY — the binding has no member to remove.
        let folder_region = canvas_create_node_core(
            &emitter(),
            &db,
            CreateCanvasNode {
                folder_id: Some(folder_id),
                ..region_input(CanvasNodeKind::Folder)
            },
        )
        .await
        .expect("folder region")
        .value;
        let copied =
            canvas_detach_member_core(&emitter(), &db, folder_region.id, conv, 12.0, 24.0)
                .await
                .expect("copy detach");
        assert_eq!(copied.value.conversation_id, Some(conv));
    }

    #[tokio::test]
    async fn delete_is_idempotent_and_only_bumps_when_something_was_removed() {
        let db = fresh_in_memory_db().await;
        let node = canvas_create_node_core(&emitter(), &db, region_input(CanvasNodeKind::Note))
            .await
            .expect("note")
            .value;

        let first = canvas_delete_node_core(&emitter(), &db, node.id)
            .await
            .expect("delete");
        assert_eq!(first.revision, 2);

        // Second delete: no-op, revision unchanged (no phantom event/bump).
        let second = canvas_delete_node_core(&emitter(), &db, node.id)
            .await
            .expect("idempotent delete");
        assert_eq!(second.revision, 2);
    }

    #[tokio::test]
    async fn move_nodes_bumps_once_for_the_whole_batch_and_skips_ghosts() {
        let db = fresh_in_memory_db().await;
        let a = canvas_create_node_core(&emitter(), &db, region_input(CanvasNodeKind::Note))
            .await
            .expect("a")
            .value;
        let b = canvas_create_node_core(&emitter(), &db, region_input(CanvasNodeKind::Custom))
            .await
            .expect("b")
            .value;

        let moved = canvas_move_nodes_core(
            &emitter(),
            &db,
            vec![
                CanvasNodeMovePayload {
                    id: a.id,
                    x: 5.0,
                    y: 6.0,
                },
                CanvasNodeMovePayload {
                    id: b.id,
                    x: 7.0,
                    // Out of range: the response/broadcast must carry the
                    // value the database stored, not the caller's raw one.
                    y: 9_999_999.0,
                },
                // Racing a delete: unknown ids are skipped, not fatal.
                CanvasNodeMovePayload {
                    id: 424242,
                    x: 0.0,
                    y: 0.0,
                },
            ],
        )
        .await
        .expect("move batch");
        assert_eq!(moved.revision, 3, "one bump for the whole batch");
        let applied: Vec<(i32, f64, f64)> =
            moved.value.iter().map(|m| (m.id, m.x, m.y)).collect();
        assert_eq!(
            applied,
            vec![(a.id, 5.0, 6.0), (b.id, 7.0, 1_000_000.0)],
            "clamped, ghost dropped"
        );

        let snapshot = canvas_list_nodes_core(&db).await.expect("snapshot");
        let a_row = snapshot.nodes.iter().find(|n| n.id == a.id).unwrap();
        assert_eq!((a_row.x, a_row.y), (5.0, 6.0));

        // Every id a ghost: nothing written → no bump, no phantom revision.
        let noop = canvas_move_nodes_core(
            &emitter(),
            &db,
            vec![CanvasNodeMovePayload {
                id: 424242,
                x: 1.0,
                y: 1.0,
            }],
        )
        .await
        .expect("ghost-only move");
        assert_eq!(noop.revision, 3, "no bump when nothing was written");
        assert!(noop.value.is_empty());
    }

    #[tokio::test]
    async fn color_vocabulary_and_note_only_content_are_enforced() {
        let db = fresh_in_memory_db().await;

        let bad_color = canvas_create_node_core(
            &emitter(),
            &db,
            CreateCanvasNode {
                color: Some("#ff0000".into()),
                ..region_input(CanvasNodeKind::Custom)
            },
        )
        .await;
        assert!(bad_color.is_err(), "hex colors are not preset names");

        let region = canvas_create_node_core(&emitter(), &db, region_input(CanvasNodeKind::Custom))
            .await
            .expect("region")
            .value;
        let good = canvas_update_node_core(
            &emitter(),
            &db,
            region.id,
            CanvasNodePatchInput {
                color: Some("violet".into()),
                ..Default::default()
            },
        )
        .await
        .expect("preset color accepted");
        assert_eq!(good.value.color.as_deref(), Some("violet"));

        let content_on_region = canvas_update_node_core(
            &emitter(),
            &db,
            region.id,
            CanvasNodePatchInput {
                content: Some("smuggled".into()),
                ..Default::default()
            },
        )
        .await;
        assert!(
            content_on_region.is_err(),
            "content is the note body, not region state"
        );
    }

    #[tokio::test]
    async fn snapshot_reads_nodes_and_revision_in_one_transaction() {
        // The pair must come from a single read transaction; the observable
        // contract here is that a snapshot taken after N mutations reports
        // exactly N with the matching node set (no torn pair on the happy
        // path — the transactional read is what extends this to races).
        let db = fresh_in_memory_db().await;
        for _ in 0..3 {
            canvas_create_node_core(&emitter(), &db, region_input(CanvasNodeKind::Note))
                .await
                .expect("create");
        }
        let (nodes, revision) = canvas_service::snapshot(&db.conn).await.expect("snapshot");
        assert_eq!(revision, 3);
        assert_eq!(nodes.len(), 3);
    }
}

/// Event-shape coverage: the funnel prune emits ONE `Pruned` event carrying the
/// scrubbed state, over the same broadcaster the web/tauri bridges consume.
#[cfg(test)]
mod broadcast_tests {
    use super::*;
    use crate::db::test_helpers::{fresh_in_memory_db, seed_conversation, seed_folder};
    use crate::models::AgentType;
    use crate::web::event_bridge::WebEventBroadcaster;
    use std::sync::Arc;

    #[tokio::test]
    async fn prune_broadcasts_a_single_batched_event() {
        let db = fresh_in_memory_db().await;
        let folder_id = seed_folder(&db, "/tmp/canvas-e").await;
        let conv = seed_conversation(&db, folder_id, AgentType::ClaudeCode).await;

        let noop = EventEmitter::Noop;
        canvas_create_node_core(
            &noop,
            &db,
            CreateCanvasNode {
                kind: crate::db::entities::canvas_node::CanvasNodeKind::Conversation,
                folder_id: None,
                agent_type: None,
                conversation_id: Some(conv),
                title: None,
                content: None,
                color: None,
                x: 0.0,
                y: 0.0,
                width: 200.0,
                height: 120.0,
            },
        )
        .await
        .expect("pin");

        crate::db::service::conversation_service::soft_delete(&db.conn, conv)
            .await
            .expect("soft delete");

        let broadcaster = Arc::new(WebEventBroadcaster::new());
        let mut rx = broadcaster.subscribe();
        let emitter = EventEmitter::test_web_only(broadcaster.clone());
        cleanup_canvas_for_deleted_conversation(&emitter, &db.conn, conv).await;

        let event = rx.try_recv().expect("one canvas event");
        assert_eq!(event.channel, CANVAS_CHANGED_EVENT);
        assert_eq!(event.payload["kind"], "pruned");
        assert_eq!(event.payload["revision"], 2);
        assert_eq!(
            event.payload["deleted_ids"].as_array().map(|a| a.len()),
            Some(1)
        );
        assert!(rx.try_recv().is_err(), "exactly one event for the prune");
    }
}
