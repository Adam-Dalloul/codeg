use axum::Json;

use crate::app_error::AppCommandError;
use crate::commands::subscription_quota::{
    read_codex_subscription_quota_core, OfficialQuotaRead,
};

pub async fn subscription_quota_codex() -> Result<Json<OfficialQuotaRead>, AppCommandError> {
    Ok(Json(read_codex_subscription_quota_core().await))
}
