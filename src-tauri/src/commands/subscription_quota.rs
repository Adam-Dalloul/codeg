//! Official remaining-subscription reads.
//!
//! Codex publishes remaining plan quota through the documented app-server
//! JSON-RPC method `account/rateLimits/read`. This module talks to that
//! method over `codex app-server --stdio` and returns the official `result`
//! object. It never invents a remaining number.
//!
//! Claude has no `usage` CLI. The `/usage` HUD reads
//! `GET https://api.anthropic.com/api/oauth/usage` with the local Claude
//! Code OAuth token (`~/.claude/.credentials.json`). That is the same
//! endpoint community monitors use. Grok / Gemini / OpenCode still have
//! no remaining-quota command.

use std::fs;
use std::path::Path;
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

pub fn claude_oauth_access_token_from_credentials(text: &str) -> Option<String> {
    let value: Value = serde_json::from_str(text).ok()?;
    value
        .get("claudeAiOauth")
        .and_then(|oauth| oauth.get("accessToken"))
        .and_then(Value::as_str)
        .filter(|token| !token.is_empty())
        .map(str::to_string)
}

fn claude_credentials_path() -> Option<std::path::PathBuf> {
    dirs::home_dir().map(|home| home.join(".claude").join(".credentials.json"))
}

fn read_claude_oauth_access_token(path: &Path) -> Option<String> {
    let text = fs::read_to_string(path).ok()?;
    claude_oauth_access_token_from_credentials(&text)
}

async fn fetch_claude_oauth_usage(token: &str) -> Result<Value, AppCommandError> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .build()
        .map_err(|err| {
            AppCommandError::new(AppErrorCode::NetworkError, "HTTP client")
                .with_detail(err.to_string())
        })?;
    let response = client
        .get("https://api.anthropic.com/api/oauth/usage")
        .header("Authorization", format!("Bearer {token}"))
        .header("anthropic-beta", "oauth-2025-04-20")
        .header("User-Agent", "codeg")
        .header("Accept", "application/json")
        .send()
        .await
        .map_err(|err| {
            AppCommandError::new(AppErrorCode::NetworkError, "Claude usage request failed")
                .with_detail(err.to_string())
        })?;
    let status = response.status();
    if !status.is_success() {
        return Err(AppCommandError::new(
            AppErrorCode::ExternalCommandFailed,
            format!("Claude usage HTTP {status}"),
        ));
    }
    response.json::<Value>().await.map_err(|err| {
        AppCommandError::new(AppErrorCode::ExternalCommandFailed, "Claude usage JSON")
            .with_detail(err.to_string())
    })
}

pub async fn read_claude_subscription_quota_core() -> OfficialQuotaRead {
    let Some(path) = claude_credentials_path() else {
        return OfficialQuotaRead {
            family: "claude",
            payload: None,
            unavailable_reason: Some("home directory unavailable".into()),
        };
    };
    let Some(token) = read_claude_oauth_access_token(&path) else {
        return OfficialQuotaRead {
            family: "claude",
            payload: None,
            unavailable_reason: Some("Claude Code is not signed in".into()),
        };
    };
    match fetch_claude_oauth_usage(&token).await {
        Ok(payload) if payload.get("five_hour").is_some() || payload.get("seven_day").is_some() => {
            OfficialQuotaRead {
                family: "claude",
                payload: Some(payload),
                unavailable_reason: None,
            }
        }
        Ok(_) => OfficialQuotaRead {
            family: "claude",
            payload: None,
            unavailable_reason: Some("Claude usage payload missing five_hour/seven_day".into()),
        },
        Err(err) => OfficialQuotaRead {
            family: "claude",
            payload: None,
            unavailable_reason: Some(err.message),
        },
    }
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn subscription_quota_claude() -> Result<OfficialQuotaRead, AppCommandError> {
    Ok(read_claude_subscription_quota_core().await)
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

    #[test]
    fn reads_claude_oauth_access_token_without_logging_it() {
        let text = r#"{
            "claudeAiOauth": { "accessToken": "tok_test_value", "subscriptionType": "max" }
        }"#;
        assert_eq!(
            claude_oauth_access_token_from_credentials(text).as_deref(),
            Some("tok_test_value")
        );
        assert!(claude_oauth_access_token_from_credentials("{}").is_none());
    }
}
