//! Official remaining-subscription reads.
//!
//! Codex publishes remaining plan quota through the documented app-server
//! JSON-RPC method `account/rateLimits/read`. This module talks to that
//! method over `codex app-server --stdio` and returns the official `result`
//! object. It never invents a remaining number.
//!
//! Claude / Grok / Gemini / OpenCode have no matching official remaining
//! payload on this host (verified against the live CLIs). Those families
//! stay unavailable at the TypeScript inventory layer.

use std::process::Stdio;
use std::time::Duration;

use serde::Serialize;
use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::time::timeout;

use crate::app_error::{AppCommandError, AppErrorCode};

const READ_DEADLINE: Duration = Duration::from_secs(12);
const INIT_ID: u64 = 1;
const LIMITS_ID: u64 = 2;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OfficialQuotaRead {
    pub family: &'static str,
    /// Official JSON from the CLI, or `null` when that CLI did not publish
    /// a remaining-quota payload. Missing CLI is not an error.
    pub payload: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub unavailable_reason: Option<String>,
}

pub fn extract_rate_limits_result(messages: &[Value]) -> Option<Value> {
    for message in messages {
        let Some(obj) = message.as_object() else {
            continue;
        };
        if obj.get("id").and_then(Value::as_u64) != Some(LIMITS_ID) {
            continue;
        }
        if obj.contains_key("error") {
            return None;
        }
        if let Some(result) = obj.get("result") {
            if result.get("rateLimits").is_some() {
                return Some(result.clone());
            }
        }
    }
    None
}

fn initialize_request() -> Value {
    json!({
        "jsonrpc": "2.0",
        "id": INIT_ID,
        "method": "initialize",
        "params": {
            "clientInfo": {
                "name": "codeg",
                "version": env!("CARGO_PKG_VERSION")
            },
            "capabilities": {}
        }
    })
}

fn rate_limits_request() -> Value {
    json!({
        "jsonrpc": "2.0",
        "id": LIMITS_ID,
        "method": "account/rateLimits/read",
        "params": {}
    })
}

async fn read_codex_rate_limits_from_child() -> Result<Option<Value>, AppCommandError> {
    let mut child = crate::process::tokio_command("codex")
        .args(["app-server", "--stdio"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .map_err(|err| {
            AppCommandError::new(
                AppErrorCode::DependencyMissing,
                "Codex CLI is not available",
            )
            .with_detail(err.to_string())
        })?;

    let mut stdin = child.stdin.take().ok_or_else(|| {
        AppCommandError::new(AppErrorCode::ExternalCommandFailed, "Codex stdin missing")
    })?;
    let stdout = child.stdout.take().ok_or_else(|| {
        AppCommandError::new(AppErrorCode::ExternalCommandFailed, "Codex stdout missing")
    })?;

    let write = async {
        for request in [initialize_request(), rate_limits_request()] {
            let mut line = serde_json::to_vec(&request).map_err(|err| {
                AppCommandError::new(AppErrorCode::ExternalCommandFailed, "encode RPC")
                    .with_detail(err.to_string())
            })?;
            line.push(b'\n');
            stdin.write_all(&line).await.map_err(|err| {
                AppCommandError::new(AppErrorCode::ExternalCommandFailed, "write RPC")
                    .with_detail(err.to_string())
            })?;
        }
        stdin.flush().await.map_err(|err| {
            AppCommandError::new(AppErrorCode::ExternalCommandFailed, "flush RPC")
                .with_detail(err.to_string())
        })?;
        Ok::<(), AppCommandError>(())
    };

    let collect = async {
        let mut reader = BufReader::new(stdout);
        let mut messages = Vec::new();
        let mut line = String::new();
        loop {
            line.clear();
            let n = reader.read_line(&mut line).await.map_err(|err| {
                AppCommandError::new(AppErrorCode::ExternalCommandFailed, "read RPC")
                    .with_detail(err.to_string())
            })?;
            if n == 0 {
                break;
            }
            let trimmed = line.trim();
            if trimmed.is_empty() {
                continue;
            }
            if let Ok(value) = serde_json::from_str::<Value>(trimmed) {
                let got_limits = value.get("id").and_then(Value::as_u64) == Some(LIMITS_ID);
                messages.push(value);
                if got_limits {
                    break;
                }
            }
        }
        Ok::<Vec<Value>, AppCommandError>(messages)
    };

    let result = timeout(READ_DEADLINE, async {
        write.await?;
        collect.await
    })
    .await;

    let _ = child.kill().await;

    match result {
        Ok(Ok(messages)) => Ok(extract_rate_limits_result(&messages)),
        Ok(Err(err)) => Err(err),
        Err(_) => Err(AppCommandError::new(
            AppErrorCode::ExternalCommandFailed,
            "Codex app-server timed out",
        )),
    }
}

pub async fn read_codex_subscription_quota_core() -> OfficialQuotaRead {
    match read_codex_rate_limits_from_child().await {
        Ok(Some(payload)) => OfficialQuotaRead {
            family: "codex",
            payload: Some(payload),
            unavailable_reason: None,
        },
        Ok(None) => OfficialQuotaRead {
            family: "codex",
            payload: None,
            unavailable_reason: Some("codex app-server did not return rateLimits".into()),
        },
        Err(err) => OfficialQuotaRead {
            family: "codex",
            payload: None,
            unavailable_reason: Some(err.message),
        },
    }
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn subscription_quota_codex() -> Result<OfficialQuotaRead, AppCommandError> {
    Ok(read_codex_subscription_quota_core().await)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extracts_live_account_rate_limits_read_shape() {
        let messages = vec![
            json!({"id": 1, "result": {"userAgent": "Codex Desktop"}}),
            json!({
                "id": 2,
                "result": {
                    "rateLimits": {
                        "limitId": "codex",
                        "primary": {
                            "usedPercent": 100,
                            "windowDurationMins": 10080,
                            "resetsAt": 1787196797
                        },
                        "secondary": null,
                        "credits": {
                            "hasCredits": false,
                            "unlimited": false,
                            "balance": "0"
                        },
                        "planType": "pro",
                        "rateLimitReachedType": "rate_limit_reached"
                    },
                    "rateLimitsByLimitId": {
                        "codex": {
                            "limitId": "codex",
                            "primary": { "usedPercent": 100 }
                        },
                        "codex_spark": {
                            "limitId": "codex_spark",
                            "limitName": "GPT-5.3-Codex-Spark",
                            "primary": { "usedPercent": 0 }
                        }
                    }
                }
            }),
        ];
        let result = extract_rate_limits_result(&messages).expect("result");
        assert_eq!(
            result["rateLimits"]["primary"]["usedPercent"],
            json!(100)
        );
        assert_eq!(
            result["rateLimitsByLimitId"]["codex_spark"]["primary"]["usedPercent"],
            json!(0)
        );
    }

    #[test]
    fn ignores_rpc_error_and_missing_id() {
        let messages = vec![
            json!({"id": 2, "error": {"message": "unauthorized"}}),
            json!({"method": "remoteControl/status/changed", "params": {}}),
        ];
        assert!(extract_rate_limits_result(&messages).is_none());
    }
}
