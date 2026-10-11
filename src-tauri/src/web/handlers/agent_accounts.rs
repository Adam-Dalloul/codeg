use axum::{extract::Extension, Json};
use serde::Deserialize;
use std::sync::Arc;

use crate::app_error::AppCommandError;
use crate::app_state::AppState;
use crate::commands::agent_accounts as commands;
use crate::db::entities::agent_account;
use crate::models::AgentType;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentParams {
    agent_type: AgentType,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateParams {
    agent_type: AgentType,
    name: String,
    home_dir: Option<String>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RenameParams {
    account_id: String,
    name: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IdParams {
    account_id: String,
}

fn error(e: crate::acp::error::AcpError) -> AppCommandError {
    AppCommandError::task_execution_failed(e.to_string())
}

#[derive(Deserialize)]
pub struct SwitchParams {
    request: crate::commands::account_switch::SwitchAccountRequest,
}

pub async fn switch_conversation(
    Extension(state): Extension<Arc<AppState>>,
    Json(p): Json<SwitchParams>,
) -> Result<Json<crate::commands::account_switch::SwitchAccountResult>, AppCommandError> {
    crate::commands::account_switch::switch_core(
        &state.db, &state.connection_manager, &state.emitter, &state.data_dir,
        "web".into(), p.request,
    ).await.map(Json).map_err(error)
}

pub async fn list(
    Extension(state): Extension<Arc<AppState>>,
    Json(p): Json<AgentParams>,
) -> Result<Json<commands::AccountsResult>, AppCommandError> {
    commands::list_core(&state.db, p.agent_type)
        .await
        .map(Json)
        .map_err(error)
}
pub async fn create(
    Extension(state): Extension<Arc<AppState>>,
    Json(p): Json<CreateParams>,
) -> Result<Json<agent_account::Model>, AppCommandError> {
    commands::create_core(
        &state.db,
        &state.data_dir,
        p.agent_type,
        &p.name,
        p.home_dir.as_deref(),
        &state.emitter,
    )
    .await
    .map(Json)
    .map_err(error)
}
pub async fn rename(
    Extension(state): Extension<Arc<AppState>>,
    Json(p): Json<RenameParams>,
) -> Result<Json<()>, AppCommandError> {
    commands::rename_core(&state.db, &p.account_id, &p.name, &state.emitter)
        .await
        .map(Json)
        .map_err(error)
}
pub async fn remove(
    Extension(state): Extension<Arc<AppState>>,
    Json(p): Json<IdParams>,
) -> Result<Json<()>, AppCommandError> {
    commands::remove_core(&state.db, &p.account_id, &state.emitter)
        .await
        .map(Json)
        .map_err(error)
}

pub async fn login(
    Extension(state): Extension<Arc<AppState>>,
    Json(p): Json<IdParams>,
) -> Result<Json<crate::commands::custom_agents::ExtraSlotLoginResult>, AppCommandError> {
    commands::login_core(&state.db, &p.account_id)
        .await
        .map(Json)
        .map_err(error)
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum_test::TestServer;
    use serde_json::{json, Value};

    #[tokio::test]
    async fn native_account_http_lifecycle_preserves_the_conversation_binding_and_files() {
        let data = tempfile::tempdir().unwrap();
        let static_dir = tempfile::tempdir().unwrap();
        let adopted = tempfile::tempdir().unwrap();
        std::fs::write(adopted.path().join("auth.json"), "account-auth-sentinel").unwrap();
        let db = crate::db::test_helpers::fresh_in_memory_db().await;
        let folder =
            crate::db::test_helpers::seed_folder(&db, &data.path().display().to_string()).await;
        let state = Arc::new(AppState::new_for_test(db, data.path().to_path_buf()));
        let server = TestServer::new(crate::web::router::build_router(
            state.clone(),
            "account-test-token".into(),
            static_dir.path().into(),
            Arc::new(crate::web::shutdown::ShutdownSignal::new()),
        ))
        .unwrap();
        server
            .post("/api/acp_create_agent_account")
            .json(&json!({"agentType":"codex", "name":"Work"}))
            .await
            .assert_status_unauthorized();
        let created = server.post("/api/acp_create_agent_account").add_header("authorization", "Bearer account-test-token")
            .json(&json!({"agentType":"codex", "name":"Work", "homeDir":adopted.path().display().to_string()})).await;
        created.assert_status_ok();
        let account: Value = created.json();
        let id = account["id"].as_str().unwrap();
        assert_eq!(account["agentType"], "codex");
        let login = server
            .post("/api/acp_login_agent_account")
            .add_header("authorization", "Bearer account-test-token")
            .json(&json!({"accountId":id}))
            .await;
        login.assert_status_ok();
        let plan: Value = login.json();
        assert_eq!(plan["launched"], false);
        assert_eq!(plan["isolatorKey"], "CODEX_HOME");
        assert!(!plan["command"].as_str().unwrap().is_empty());
        let conversation = server
            .post("/api/create_conversation")
            .add_header("authorization", "Bearer account-test-token")
            .json(&json!({"agentType":"codex", "folderId":folder, "agentAccountId":id}))
            .await;
        conversation.assert_status_ok();
        let conversation_id: i32 = conversation.json();
        server
            .post("/api/acp_rename_agent_account")
            .add_header("authorization", "Bearer account-test-token")
            .json(&json!({"accountId":id, "name":"Renamed"}))
            .await
            .assert_status_ok();
        server
            .post("/api/acp_remove_agent_account")
            .add_header("authorization", "Bearer account-test-token")
            .json(&json!({"accountId":id}))
            .await
            .assert_status_ok();
        let listed = server
            .post("/api/acp_list_agent_accounts")
            .add_header("authorization", "Bearer account-test-token")
            .json(&json!({"agentType":"codex"}))
            .await;
        listed.assert_status_ok();
        let rows: Value = listed.json();
        assert_eq!(rows["accounts"][0]["name"], "Renamed");
        assert_eq!(rows["accounts"][0]["removed"], true);
        let refused = server
            .post("/api/acp_login_agent_account")
            .add_header("authorization", "Bearer account-test-token")
            .json(&json!({"accountId":id}))
            .await;
        assert!(!refused.status_code().is_success());
        assert_eq!(
            crate::db::service::agent_account_service::connection_account(
                &state.db.conn,
                AgentType::Codex,
                None,
                Some(conversation_id)
            )
            .await
            .unwrap()
            .as_deref(),
            Some(id)
        );
        assert_eq!(
            std::fs::read_to_string(adopted.path().join("auth.json")).unwrap(),
            "account-auth-sentinel"
        );
    }
}
