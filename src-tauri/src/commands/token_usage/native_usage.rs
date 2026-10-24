//! Usage-only recovery for official Claude adapters with an explicit isolated
//! home. Never changes the conversation renderer, its binding, or its history.

use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};

use crate::acp::custom_registry::{CustomAgentDef, CustomDistributionKind};
use crate::acp::registry::CLAUDE_AGENT_ACP_PACKAGE;
use crate::app_error::AppCommandError;
use crate::db::service::token_usage_service::UsageFact;
use crate::db::service::{agent_setting_service, custom_agent_service, token_usage_service};
use crate::models::conversation::DbConversationSummary;
use crate::models::AgentType;
use crate::parsers::claude::{
    find_session_file_in, resolve_claude_config_dir_for_env, ClaudeParser,
};
use crate::parsers::AgentEnv;

pub(super) const NATIVE_PREFIX: &str = "native-claude:";

pub(crate) enum NativeUsage {
    Unavailable,
    Facts(Vec<UsageFact>),
    KeepRecorded(Vec<UsageFact>),
}

fn key_prefix(session_id: &str) -> String {
    format!(
        "{NATIVE_PREFIX}{:x}:",
        Sha256::digest(session_id.as_bytes())
    )
}

fn same_directory(a: &Path, b: &Path) -> bool {
    let a = a.canonicalize().unwrap_or_else(|_| a.to_path_buf());
    let b = b.canonicalize().unwrap_or_else(|_| b.to_path_buf());
    if cfg!(windows) {
        a.to_string_lossy()
            .eq_ignore_ascii_case(&b.to_string_lossy())
    } else {
        a == b
    }
}

fn isolated_home(
    def: &CustomAgentDef,
    runtime: &AgentEnv,
    builtin_home: &Path,
    default_home: Option<&Path>,
) -> Option<PathBuf> {
    if def.distribution_kind != CustomDistributionKind::Npx {
        return None;
    }
    let spec = def.spec.npx.as_ref()?;
    let suffix = spec.package.strip_prefix(CLAUDE_AGENT_ACP_PACKAGE)?;
    if !suffix.is_empty() && !(suffix.starts_with('@') && suffix.len() > 1) {
        return None;
    }
    if spec
        .cmd
        .as_deref()
        .is_some_and(|cmd| cmd != "claude-agent-acp")
    {
        return None;
    }
    let declared = AgentEnv::from_overrides(spec.env.clone());
    // Overrides only: consulting var_os here would silently read Default's
    // transcript when the custom agent has no isolated home. An explicit
    // empty runtime value removes the spec value, just as spawning does.
    let value = runtime
        .override_for("CLAUDE_CONFIG_DIR")
        .or_else(|| declared.override_for("CLAUDE_CONFIG_DIR"))?;
    let home = PathBuf::from(value);
    if !home.is_absolute()
        || same_directory(&home, builtin_home)
        || default_home.is_some_and(|default| same_directory(&home, default))
    {
        return None;
    }
    Some(home)
}

pub(crate) async fn read(
    conn: &sea_orm::DatabaseConnection,
    summary: &DbConversationSummary,
) -> Result<NativeUsage, AppCommandError> {
    let AgentType::Custom(id) = summary.agent_type else {
        return Ok(NativeUsage::Unavailable);
    };
    let Some(external_id) = summary.external_id.as_ref().filter(|id| !id.is_empty()) else {
        return Ok(NativeUsage::Unavailable);
    };
    let retained = token_usage_service::facts_with_key_prefix(conn, summary.id, NATIVE_PREFIX)
        .await
        .map_err(AppCommandError::from)?;
    let def = custom_agent_service::get(conn, id)
        .await
        .map_err(AppCommandError::from)?
        .as_ref()
        .and_then(custom_agent_service::def_from_model);
    let home = if let Some(def) = def {
        let runtime = agent_setting_service::load_agent_env(conn, summary.agent_type).await;
        let builtin = agent_setting_service::load_agent_env(conn, AgentType::ClaudeCode).await;
        let default = dirs::home_dir().map(|home| home.join(".claude"));
        isolated_home(
            &def,
            &runtime,
            &resolve_claude_config_dir_for_env(&builtin),
            default.as_deref(),
        )
    } else {
        None
    };
    if home.is_none() && retained.is_empty() {
        return Ok(NativeUsage::Unavailable);
    }
    let current_id = external_id.clone();
    let current_model = summary.model.clone();
    tokio::task::spawn_blocking(move || {
        // These are explicit links written by Codeg, with cycle/depth guards.
        // Never discover unrelated sessions or follow Claude /clear rollovers.
        let mut ids = crate::acp_transcript::continuation_ancestors(id, &current_id);
        ids.reverse();
        ids.push(current_id.clone());
        let mut facts = Vec::new();
        let mut native_source = false;
        let mut fresh_source = false;
        for session_id in ids {
            let prefix = key_prefix(&session_id);
            let saved: Vec<_> = retained
                .iter()
                .filter(|fact| fact.turn_key.starts_with(&prefix))
                .cloned()
                .collect();
            let native = match home.as_ref().map(|home| home.join("projects")) {
                Some(base) => match find_session_file_in(&base, &session_id) {
                    Some(path) => match ClaudeParser::with_base_dir(base)
                        .parse_conversation_detail(&path, &session_id)
                    {
                        Ok(detail) if detail.summary.id == session_id => {
                            super::facts_from_turns(&detail.turns, detail.summary.model.as_deref())
                        }
                        Ok(_) => Vec::new(),
                        Err(error) if saved.is_empty() => {
                            return Err(AppCommandError::io_error(error.to_string()))
                        }
                        Err(_) => Vec::new(),
                    },
                    None => Vec::new(),
                },
                None => Vec::new(),
            };
            if !native.is_empty() {
                native_source = true;
                fresh_source = true;
                facts.extend(native.into_iter().map(|mut fact| {
                    fact.turn_key = format!("{prefix}{}", fact.turn_key);
                    fact
                }));
            } else if !saved.is_empty() {
                native_source = true;
                facts.extend(saved);
            } else {
                // Only this session's ACP records, never the concatenated
                // chain: another link may already be covered by native facts.
                let transcript = crate::acp_transcript::read_transcript(id, &session_id);
                let turns = crate::parsers::acp_native::project_turns(&transcript.entries);
                let model = if session_id == current_id {
                    current_model.as_deref()
                } else {
                    None
                };
                let mut acp = super::facts_from_turns(&turns, model);
                fresh_source |= !acp.is_empty();
                let acp_prefix = prefix.replacen(NATIVE_PREFIX, "acp-usage:", 1);
                for fact in &mut acp {
                    fact.turn_key = format!("{acp_prefix}{}", fact.turn_key);
                }
                facts.extend(acp);
            }
        }
        Ok(if !native_source {
            NativeUsage::Unavailable
        } else if fresh_source {
            NativeUsage::Facts(facts)
        } else {
            NativeUsage::KeepRecorded(facts)
        })
    })
    .await
    .map_err(|error| AppCommandError::io_error(error.to_string()))?
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::token_usage::{
        token_usage_report_core, token_usage_sync_core, TokenUsageSyncMode,
    };
    use crate::db::service::{app_metadata_service, conversation_service};
    use crate::db::test_helpers::{fresh_in_memory_db, seed_conversation, seed_folder};
    use crate::models::token_usage::TokenUsageFilter;
    use crate::web::event_bridge::EventEmitter;
    use serde_json::json;

    fn definition(home: &Path) -> CustomAgentDef {
        serde_json::from_value(json!({
            "registry_id":"usage-history-fixture", "name":"Review account", "version":"1",
            "distribution_kind":"npx", "spec":{"npx":{
                "package":format!("{CLAUDE_AGENT_ACP_PACKAGE}@0.81.2"),
                "env":{"CLAUDE_CONFIG_DIR":home.to_string_lossy()}
            }}
        }))
        .unwrap()
    }

    #[test]
    fn native_usage_requires_the_official_adapter_and_an_explicit_isolated_home() {
        let temp = tempfile::tempdir().unwrap();
        let home = temp.path().join("account");
        let builtin = temp.path().join("builtin");
        let default = temp.path().join("default");
        let mut def = definition(&home);
        let env = AgentEnv::inherited();
        let resolve = |def: &CustomAgentDef, env: &AgentEnv| {
            isolated_home(def, env, &builtin, Some(&default))
        };
        assert_eq!(resolve(&def, &env), Some(home.clone()));
        for kind in [CustomDistributionKind::Binary, CustomDistributionKind::Uvx] {
            def.distribution_kind = kind;
            assert!(resolve(&def, &env).is_none());
        }
        def.distribution_kind = CustomDistributionKind::Npx;
        for package in [
            format!("{CLAUDE_AGENT_ACP_PACKAGE}-fork"),
            "another-agent".into(),
            format!("{CLAUDE_AGENT_ACP_PACKAGE}@"),
        ] {
            def.spec.npx.as_mut().unwrap().package = package;
            assert!(resolve(&def, &env).is_none());
        }
        def = definition(&home);
        def.spec.npx.as_mut().unwrap().cmd = Some("another-command".into());
        assert!(resolve(&def, &env).is_none());
        def = definition(&home);
        let override_home = temp.path().join("override");
        let runtime =
            AgentEnv::with_overrides(&[("CLAUDE_CONFIG_DIR", override_home.to_str().unwrap())]);
        assert_eq!(resolve(&def, &runtime), Some(override_home));
        assert!(resolve(
            &def,
            &AgentEnv::with_overrides(&[("CLAUDE_CONFIG_DIR", "")])
        )
        .is_none());
        assert!(resolve(&definition(&builtin), &env).is_none());
        assert!(resolve(&definition(&default), &env).is_none());
        assert!(resolve(&definition(Path::new("relative-profile")), &env).is_none());
        def.spec.npx.as_mut().unwrap().env.clear();
        temp_env::with_var("CLAUDE_CONFIG_DIR", Some(home.as_os_str()), || {
            assert!(resolve(&def, &AgentEnv::inherited()).is_none());
        });
    }

    #[cfg(windows)]
    #[test]
    fn windows_runtime_override_uses_the_last_case_insensitive_spelling() {
        let temp = tempfile::tempdir().unwrap();
        let home = temp.path().join("account");
        let override_home = temp.path().join("override");
        let runtime = AgentEnv::with_overrides(&[
            ("CLAUDE_CONFIG_DIR", home.to_str().unwrap()),
            ("claude_config_dir", override_home.to_str().unwrap()),
        ]);
        assert_eq!(
            isolated_home(
                &definition(&home),
                &runtime,
                &temp.path().join("builtin"),
                None
            ),
            Some(override_home)
        );
    }

    #[cfg(unix)]
    #[test]
    fn an_alias_of_the_builtin_home_is_not_an_isolated_source() {
        let temp = tempfile::tempdir().unwrap();
        let builtin = temp.path().join("builtin");
        std::fs::create_dir(&builtin).unwrap();
        let alias = temp.path().join("alias");
        std::os::unix::fs::symlink(&builtin, &alias).unwrap();
        assert!(
            isolated_home(&definition(&alias), &AgentEnv::inherited(), &builtin, None).is_none()
        );
    }

    fn write_jsonl(path: &Path, values: &[serde_json::Value]) {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(
            path,
            values.iter().map(|v| format!("{v}\n")).collect::<String>(),
        )
        .unwrap();
    }

    #[tokio::test]
    async fn custom_claude_usage_rebuild_recovers_once_keeps_identity_and_survives_source_cleanup()
    {
        let _serial = super::super::tests::SYNC_TESTS_SERIAL.lock().await;
        let temp = tempfile::tempdir().unwrap();
        let codeg_home = temp.path().join("codeg");
        let home = temp.path().join("account");
        let home_str = codeg_home.to_string_lossy().into_owned();
        temp_env::async_with_vars([("CODEG_HOME", Some(home_str.as_str()))], async {
            let db = fresh_in_memory_db().await;
            let folder = seed_folder(&db, "/fixture-project").await;
            let agent = AgentType::Custom("usage-history-fixture");
            let id = seed_conversation(&db, folder, agent).await;
            conversation_service::bind_external_id(&db.conn, id, "s1", &[]).await.unwrap();
            custom_agent_service::upsert(&db.conn, &definition(&home)).await.unwrap();
            let summary = conversation_service::get_by_id(&db.conn, id).await.unwrap();
            token_usage_service::replace_conversation_facts(&db.conn, id, summary.updated_at, &[]).await.unwrap();
            app_metadata_service::upsert_value(&db.conn, "token_usage_fact_schema_version", "6").await.unwrap();
            assert_eq!(super::super::token_usage_status_core(&db.conn).await.unwrap().stale_conversations, 1);
            let acp_path = crate::paths::codeg_acp_transcripts_root().join("usage-history-fixture/s1.jsonl");
            write_jsonl(&acp_path, &[
                json!({"v":1,"kind":"header","agent":"custom:usage-history-fixture","session_id":"s1","cwd":"/fixture-project","started_at_ms":1792836000000u64}),
                json!({"t":1792836000000u64,"k":"prompt","p":[{"type":"text","text":"visible prompt"}]}),
                json!({"t":1792836000100u64,"k":"update","p":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"visible ACP reply"}}}),
                json!({"t":1792836000200u64,"k":"turn_end","p":{"stopReason":"end_turn","model":"claude-fixture","usage":{"inputTokens":900,"outputTokens":100,"totalTokens":1000}}}),
            ]);
            let native = home.join("projects/project/s1.jsonl");
            write_jsonl(&native, &[
                json!({"type":"user","sessionId":"s1","cwd":"/fixture-project","timestamp":"2026-10-24T10:00:00Z","uuid":"u1","message":{"role":"user","content":"native prompt"}}),
                json!({"type":"assistant","sessionId":"s1","timestamp":"2026-10-24T10:00:01Z","uuid":"a1","parentUuid":"u1","message":{"id":"request-1","role":"assistant","model":"claude-fixture","content":[{"type":"text","text":"native reply"}],"usage":{"input_tokens":100,"output_tokens":20,"cache_read_input_tokens":70,"cache_creation_input_tokens":10}}}),
                // Another content block from the same API call repeats usage.
                json!({"type":"assistant","sessionId":"s1","timestamp":"2026-10-24T10:00:02Z","uuid":"a2","parentUuid":"a1","message":{"id":"request-1","role":"assistant","model":"claude-fixture","content":[{"type":"text","text":"second block"}],"usage":{"input_tokens":100,"output_tokens":20,"cache_read_input_tokens":70,"cache_creation_input_tokens":10}}}),
            ]);
            let before = crate::commands::conversations::get_folder_conversation_core(&db.conn, id).await.unwrap().0;
            let first = token_usage_sync_core(&db.conn, &EventEmitter::Noop, TokenUsageSyncMode::Incremental).await.unwrap();
            assert_eq!(first.failed, 0);
            assert_eq!(first.tokens_written, 200, "native replaces ACP and deduplicates API-call blocks");
            let report = token_usage_report_core(&db.conn, TokenUsageFilter::default()).await.unwrap();
            assert_eq!(report.totals.total_tokens, 200);
            assert_eq!(report.by_agent[0].key, "custom:usage-history-fixture");
            assert_eq!(token_usage_service::facet_agents(&db.conn).await.unwrap(), vec!["custom:usage-history-fixture"]);
            let after = crate::commands::conversations::get_folder_conversation_core(&db.conn, id).await.unwrap().0;
            assert_eq!(serde_json::to_value(before).unwrap(), serde_json::to_value(after).unwrap());
            let second = token_usage_sync_core(&db.conn, &EventEmitter::Noop, TokenUsageSyncMode::Full).await.unwrap();
            assert_eq!(second.tokens_written, 200);
            // The ACP transcript still exists and reports 1,000. Losing the
            // native source must retain the recovered 200, never replace it.
            std::fs::remove_file(native).unwrap();
            let lost = token_usage_sync_core(&db.conn, &EventEmitter::Noop, TokenUsageSyncMode::Full).await.unwrap();
            assert_eq!(lost.lost, 1);
            assert_eq!(lost.failed, 0);
            let mut another_session = summary.clone();
            another_session.external_id = Some("different-session".into());
            assert!(matches!(read(&db.conn, &another_session).await.unwrap(), NativeUsage::Unavailable));
            assert_eq!(token_usage_report_core(&db.conn, TokenUsageFilter::default()).await.unwrap().totals.total_tokens, 200);
            // Rebind the SAME row through Codeg's recorded continuation link.
            // The old native file is still absent, and the new session has only
            // ACP usage at first. Neither old native totals nor new spend may vanish.
            let acp_next = crate::paths::codeg_acp_transcripts_root().join("usage-history-fixture/s2.jsonl");
            write_jsonl(&acp_next, &[
                json!({"v":1,"kind":"header","agent":"custom:usage-history-fixture","session_id":"s2","continues_from":"s1","cwd":"/fixture-project","started_at_ms":1792837000000u64}),
                json!({"t":1792837000000u64,"k":"prompt","p":[{"type":"text","text":"continued prompt"}]}),
                json!({"t":1792837000100u64,"k":"update","p":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"continued reply"}}}),
                json!({"t":1792837000200u64,"k":"turn_end","p":{"stopReason":"end_turn","model":"acp-second","usage":{"inputTokens":30,"outputTokens":5,"totalTokens":35}}}),
            ]);
            conversation_service::bind_external_id(&db.conn, id, "s2", &["s1".to_string()]).await.unwrap();
            let continued = token_usage_sync_core(&db.conn, &EventEmitter::Noop, TokenUsageSyncMode::Full).await.unwrap();
            assert_eq!(continued.failed,0);
            let report = token_usage_report_core(&db.conn, TokenUsageFilter::default()).await.unwrap();
            assert_eq!(report.totals.total_tokens,235);
            assert_eq!(report.totals.conversation_count,1);
            let native_next = home.join("projects/project/s2.jsonl");
            write_jsonl(&native_next, &[
                json!({"type":"user","sessionId":"s2","cwd":"/fixture-project","timestamp":"2026-10-24T10:20:00Z","uuid":"u2","message":{"role":"user","content":"native continued prompt"}}),
                json!({"type":"assistant","sessionId":"s2","timestamp":"2026-10-24T10:20:01Z","uuid":"a3","parentUuid":"u2","message":{"id":"request-2","role":"assistant","model":"native-second","content":[{"type":"text","text":"native continued reply"}],"usage":{"input_tokens":50,"output_tokens":10,"cache_read_input_tokens":20}}}),
            ]);
            token_usage_sync_core(&db.conn, &EventEmitter::Noop, TokenUsageSyncMode::Full).await.unwrap();
            let report = token_usage_report_core(&db.conn, TokenUsageFilter::default()).await.unwrap();
            assert_eq!(report.totals.total_tokens,280);
            assert!(report.by_model.iter().any(|row| row.key == "native-second" && row.total_tokens == 80));
            assert!(!report.by_model.iter().any(|row| row.key == "acp-second"));
            std::fs::remove_file(native_next).unwrap();
            let kept = token_usage_sync_core(&db.conn, &EventEmitter::Noop, TokenUsageSyncMode::Full).await.unwrap();
            assert_eq!(kept.lost,1);
            assert_eq!(token_usage_report_core(&db.conn, TokenUsageFilter::default()).await.unwrap().totals.total_tokens,280);
            assert_eq!(app_metadata_service::get_value(&db.conn, "token_usage_fact_schema_version").await.unwrap().as_deref(), Some("8"));
        }).await;
    }
}
