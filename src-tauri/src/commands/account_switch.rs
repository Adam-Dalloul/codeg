//! Explicit, cancellation-shielded account changes. Ordinary connect/prompt
//! admission continues to reject a mismatched saved account.

use std::collections::BTreeMap;
use std::path::Path;

use sea_orm::{ColumnTrait, ConnectionTrait, DbBackend, EntityTrait, QueryFilter, Statement};
use serde::{Deserialize, Serialize};

use crate::acp::types::ConnectionStatus;
use crate::acp::{account_transfer, agent_accounts, error::AcpError, manager::ConnectionManager};
use crate::db::{
    entities::conversation,
    service::{agent_account_service, folder_service},
    AppDatabase,
};
use crate::models::AgentType;
use crate::web::event_bridge::EventEmitter;

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SwitchAccountRequest {
    pub conversation_id: i32,
    pub source_account_id: Option<String>,
    pub target_account_id: Option<String>,
    #[serde(default)]
    pub preferred_mode_id: Option<String>,
    #[serde(default)]
    pub preferred_config_values: BTreeMap<String, String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SwitchAccountResult {
    pub conversation_id: i32,
    pub agent_account_id: Option<String>,
    pub connection_id: String,
    pub external_id: String,
}

fn failure(e: impl std::fmt::Display) -> AcpError {
    AcpError::protocol(e.to_string())
}

pub async fn switch_core(
    db: &AppDatabase,
    manager: &ConnectionManager,
    emitter: &EventEmitter,
    data_dir: &Path,
    owner_window_label: String,
    request: SwitchAccountRequest,
) -> Result<SwitchAccountResult, AcpError> {
    let db = AppDatabase {
        conn: db.conn.clone(),
    };
    let manager = manager.clone_ref();
    let emitter = emitter.clone();
    let data = data_dir.to_path_buf();
    // Once files are touched a disconnected HTTP client cannot interrupt the
    // verification/commit or rollback sequence. The source always stays intact.
    tokio::spawn(async move {
        switch_inner(&db, &manager, &emitter, &data, owner_window_label, request).await
    })
    .await
    .map_err(failure)?
}

async fn switch_inner(
    db: &AppDatabase,
    manager: &ConnectionManager,
    emitter: &EventEmitter,
    data_dir: &Path,
    owner_window_label: String,
    request: SwitchAccountRequest,
) -> Result<SwitchAccountResult, AcpError> {
    // Shares the existing restore barrier: no UI, automation, custom alias or
    // delegation can reopen either transcript during the copy/load window.
    let barrier = manager.lock_out_new_connections().await;
    let row = conversation::Entity::find_by_id(request.conversation_id)
        .one(&db.conn)
        .await
        .map_err(failure)?
        .filter(|r| r.deleted_at.is_none())
        .ok_or_else(|| failure("Conversation not found."))?;
    if row.agent_type != AgentType::ClaudeCode.as_wire() || row.parent_id.is_some() {
        return Err(failure(
            "Account switching is available for Claude conversations.",
        ));
    }
    if row.agent_account_id != request.source_account_id {
        return Err(failure(
            "The conversation's account changed. Reload it before switching.",
        ));
    }
    if row.agent_account_id == request.target_account_id {
        return Err(failure("This conversation already uses that account."));
    }
    let sid = row
        .external_id
        .clone()
        .filter(|s| !s.is_empty())
        .ok_or_else(|| failure("Send a message before switching accounts."))?;
    // Imported sessions have origin_cwd; ordinary conversations use the folder.
    let folder = folder_service::get_folder_by_id(&db.conn, row.folder_id)
        .await
        .map_err(failure)?;
    let cwd = row
        .origin_cwd
        .clone()
        .or_else(|| folder.map(|f| f.path))
        .ok_or_else(|| failure("Conversation folder not found."))?;
    let source_env = if let Some(id) = &row.agent_account_id {
        // Removed accounts remain readable and can be recovered by switching.
        let account = agent_account_service::get(&db.conn, id)
            .await
            .map_err(failure)?;
        if account.agent_type != row.agent_type {
            return Err(failure("Invalid source account."));
        }
        agent_accounts::isolation_env(AgentType::ClaudeCode, Path::new(&account.home_dir))
            .map_err(failure)?
    } else {
        super::acp::build_account_session_runtime_env(
            db,
            AgentType::ClaudeCode,
            Some(&sid),
            data_dir,
            None,
        )
        .await?
    };
    let target_env = super::acp::build_account_session_runtime_env(
        db,
        AgentType::ClaudeCode,
        Some(&sid),
        data_dir,
        request.target_account_id.as_deref(),
    )
    .await?;
    super::acp::verify_agent_installed(AgentType::ClaudeCode).await?;
    let source = agent_accounts::storage_identity(AgentType::ClaudeCode, &source_env)
        .ok_or_else(|| failure("Source session folder not found."))?
        .1;
    let target = agent_accounts::storage_identity(AgentType::ClaudeCode, &target_env)
        .ok_or_else(|| failure("Target session folder not found."))?
        .1;
    // Do not take over another conversation even if its transcript is an old
    // copy of this one. Include soft-deleted rows, which can still be restored.
    let mut conflict = conversation::Entity::find()
        .filter(conversation::Column::AgentType.eq(row.agent_type.clone()))
        .filter(conversation::Column::ExternalId.eq(sid.clone()))
        .filter(conversation::Column::Id.ne(row.id));
    conflict = match &request.target_account_id {
        Some(id) => conflict.filter(conversation::Column::AgentAccountId.eq(id)),
        None => conflict.filter(conversation::Column::AgentAccountId.is_null()),
    };
    if conflict.one(&db.conn).await.map_err(failure)?.is_some() {
        return Err(failure(
            "The target account already has a saved conversation for this session.",
        ));
    }
    if conversation::Entity::find()
        .filter(conversation::Column::ParentId.eq(row.id))
        .filter(conversation::Column::Status.eq(conversation::ConversationStatus::InProgress))
        .one(&db.conn)
        .await
        .map_err(failure)?
        .is_some()
    {
        return Err(AcpError::TurnInProgress);
    }
    let _prompt_guards = manager
        .quiesce_account_session(&barrier, &source, &target, &sid)
        .await?;
    let transfer =
        account_transfer::copy_claude_session(&source, &target, &sid).map_err(failure)?;
    let connection_id = match manager
        .spawn_agent_during_account_switch(
            &barrier,
            cwd,
            sid.clone(),
            target_env,
            owner_window_label,
            emitter.clone(),
            request.preferred_mode_id,
            request.preferred_config_values,
        )
        .await
    {
        Ok(id) => id,
        Err(e) => {
            transfer.rollback().map_err(failure)?;
            return Err(e);
        }
    };
    let loaded = if let Some(state) = manager.get_state(&connection_id).await {
        let state = state.read().await;
        state.external_id.as_deref() == Some(&sid)
            && state.status == ConnectionStatus::Connected
            && state.agent_account_id == request.target_account_id
    } else {
        false
    };
    if !loaded {
        manager
            .disconnect_and_wait_for_account_switch(&connection_id)
            .await?;
        transfer.rollback().map_err(failure)?;
        return Err(failure("The selected account could not load this conversation. The original account and history were kept."));
    }
    // One conditional write changes only the binding, preserving title, pin,
    // tags, folder and history. A stale client, deletion, account removal or
    // competing import cannot silently replace a newer binding.
    let committed = commit_binding(&db.conn, &row, request.target_account_id.as_deref()).await;
    if let Err(e) = committed {
        manager
            .disconnect_and_wait_for_account_switch(&connection_id)
            .await?;
        transfer.rollback().map_err(failure)?;
        return Err(e);
    }
    if let Some(state) = manager.get_state(&connection_id).await {
        let mut state = state.write().await;
        state.conversation_id = Some(row.id);
        state.folder_id = Some(row.folder_id);
    }
    super::conversations::emit_conversation_upsert(emitter, &db.conn, row.id).await;
    Ok(SwitchAccountResult {
        conversation_id: row.id,
        agent_account_id: request.target_account_id,
        connection_id,
        external_id: sid,
    })
}

async fn commit_binding(
    conn: &impl ConnectionTrait,
    source: &conversation::Model,
    target: Option<&str>,
) -> Result<(), AcpError> {
    let updated = conn
        .execute(Statement::from_sql_and_values(
            DbBackend::Sqlite,
            "UPDATE conversation SET agent_account_id = ?, updated_at = ? \
         WHERE id = ? AND agent_type = ? AND external_id = ? \
         AND agent_account_id IS ? AND deleted_at IS NULL \
         AND (? IS NULL OR EXISTS (SELECT 1 FROM agent_account \
             WHERE id = ? AND removed = 0 AND agent_type = ?))",
            vec![
                target.map(str::to_owned).into(),
                chrono::Utc::now().into(),
                source.id.into(),
                source.agent_type.clone().into(),
                source.external_id.clone().into(),
                source.agent_account_id.clone().into(),
                target.map(str::to_owned).into(),
                target.map(str::to_owned).into(),
                source.agent_type.clone().into(),
            ],
        ))
        .await
        .map_err(failure)?;
    if updated.rows_affected() != 1 {
        return Err(failure(
            "The conversation or account changed during the switch. Reload and try again.",
        ));
    }
    Ok(())
}

#[cfg(feature = "tauri-runtime")]
#[tauri::command]
pub async fn acp_switch_conversation_account(
    request: SwitchAccountRequest,
    db: tauri::State<'_, AppDatabase>,
    manager: tauri::State<'_, ConnectionManager>,
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
) -> Result<SwitchAccountResult, AcpError> {
    use tauri::Manager;
    let data = app
        .path()
        .app_data_dir()
        .map(|p| crate::paths::resolve_effective_data_dir(&p))
        .map_err(failure)?;
    switch_core(
        &db,
        &manager,
        &EventEmitter::Tauri(app),
        &data,
        window.label().into(),
        request,
    )
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::{service::conversation_service, test_helpers};

    #[tokio::test]
    async fn binding_commit_preserves_identity_and_rejects_stale_or_removed_targets() {
        let db = test_helpers::fresh_in_memory_db().await;
        let dir = tempfile::tempdir().unwrap();
        let folder = test_helpers::seed_folder(&db, "/test").await;
        let account = agent_account_service::create(
            &db.conn,
            dir.path(),
            AgentType::ClaudeCode,
            "Work",
            None,
        )
        .await
        .unwrap();
        let id = conversation_service::create(
            &db.conn,
            folder,
            AgentType::ClaudeCode,
            Some("Keep this title".into()),
            None,
        )
        .await
        .unwrap()
        .id;
        conversation_service::bind_external_id(&db.conn, id, "sid", &[])
            .await
            .unwrap();
        let row = conversation::Entity::find_by_id(id)
            .one(&db.conn)
            .await
            .unwrap()
            .unwrap();
        commit_binding(&db.conn, &row, Some(&account.id))
            .await
            .unwrap();
        assert!(commit_binding(&db.conn, &row, Some(&account.id))
            .await
            .is_err());
        let switched = conversation::Entity::find_by_id(id)
            .one(&db.conn)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(switched.external_id, row.external_id);
        assert_eq!(switched.folder_id, row.folder_id);
        assert_eq!(switched.title, row.title);
        commit_binding(&db.conn, &switched, None).await.unwrap();
        agent_account_service::remove(&db.conn, &account.id)
            .await
            .unwrap();
        assert!(commit_binding(&db.conn, &row, Some(&account.id))
            .await
            .is_err());
    }
}
