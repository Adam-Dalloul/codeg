//! Server-mode HTTP surface of the forge workbench — thin wrappers over the
//! `commands::forge` cores, same discipline as `handlers::work_task`.

use std::sync::Arc;

use axum::{extract::Extension, Json};
use serde::Deserialize;

use crate::app_error::AppCommandError;
use crate::app_state::AppState;
use crate::commands::forge as core;
use crate::forge::ForgeTab;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FolderParams {
    pub folder_id: i32,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListIssuesParams {
    pub folder_id: i32,
    pub tab: ForgeTab,
    #[serde(default = "default_state")]
    pub state: String,
    #[serde(default)]
    pub assigned_me: bool,
    #[serde(default)]
    pub cursor: Option<String>,
    #[serde(default)]
    pub account_id: Option<String>,
}

fn default_state() -> String {
    "open".to_string()
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateFromForgeParams {
    pub draft: core::ForgeTaskDraft,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LookupParams {
    pub source_keys: Vec<String>,
}

pub async fn folder_forge_remote(
    Extension(state): Extension<Arc<AppState>>,
    Json(params): Json<FolderParams>,
) -> Result<Json<Option<core::ForgeRemote>>, AppCommandError> {
    Ok(Json(
        core::folder_forge_remote_core(&state.db, params.folder_id).await?,
    ))
}

pub async fn forge_list_issues(
    Extension(state): Extension<Arc<AppState>>,
    Json(params): Json<ListIssuesParams>,
) -> Result<Json<crate::forge::ForgeIssueList>, AppCommandError> {
    Ok(Json(
        core::forge_list_issues_core(
            &state.db,
            params.folder_id,
            params.tab,
            params.state,
            params.assigned_me,
            params.cursor,
            params.account_id,
        )
        .await?,
    ))
}

pub async fn work_task_create_from_forge(
    Extension(state): Extension<Arc<AppState>>,
    Json(params): Json<CreateFromForgeParams>,
) -> Result<Json<core::ForgeCreateResult>, AppCommandError> {
    Ok(Json(
        core::work_task_create_from_forge_core(&state.emitter, &state.db, params.draft).await?,
    ))
}

pub async fn work_task_lookup_by_source(
    Extension(state): Extension<Arc<AppState>>,
    Json(params): Json<LookupParams>,
) -> Result<Json<Vec<core::ForgeTaskLink>>, AppCommandError> {
    Ok(Json(
        core::work_task_lookup_by_source_core(&state.db, params.source_keys).await?,
    ))
}
