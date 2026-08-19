use std::ffi::OsString;
use std::fs;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};

use chrono::{DateTime, Utc};
use serde_json::Value;
use walkdir::WalkDir;

use crate::models::{
    AgentType, ContentBlock, ConversationDetail, ConversationSummary, MessageRole,
    TurnUsage, UnifiedMessage,
};
use crate::parsers::{
    backfill_turn_durations, compute_session_stats, folder_name_from_path,
    infer_context_window_max_tokens, latest_turn_total_usage_tokens,
    merge_context_window_stats, relocate_orphaned_tool_results, resolve_patch_line_numbers,
    structurize_read_tool_output, title_from_user_text, AgentParser, ParseError,
};

/// Resolve Qoder's config dir, honoring `QODER_CONFIG_DIR`, else `~/.qoder`
/// (mirrors `resolve_claude_config_dir`; `--config-dir` is the CLI flag form
/// of the same override).
pub(crate) fn resolve_qoder_config_dir() -> PathBuf {
    resolve_qoder_config_dir_from(std::env::var_os("QODER_CONFIG_DIR"), dirs::home_dir())
}

fn resolve_qoder_config_dir_from(
    qoder_config_dir_env: Option<OsString>,
    home_dir: Option<PathBuf>,
) -> PathBuf {
    qoder_config_dir_env
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| home_dir.unwrap_or_default().join(".qoder"))
}

/// Qoder (Alibaba) stores one JSONL transcript per session under
/// `~/.qoder/projects/<encoded-cwd>/<sessionId>.jsonl`, next to a
/// `<sessionId>/` directory whose `state.json` carries session metadata.
/// The transcript uses the Claude-Code-style chunk-log envelope
/// (`type: "user" | "assistant"`, `uuid`/`parentUuid` chain,
/// `message.content` block arrays) plus qoder-specific metadata records
/// (`workspace-directories`, `runtime-config`, `active-leaf`, `last-prompt`)
/// that are interleaved with — and duplicated at the tail of — the content
/// stream.
///
/// The sibling `state.json` holds the authoritative session titles, but
/// ENCRYPTED (an `items` map of AES-GCM `{n: nonce, p: ciphertext, t: tag}`
/// blobs under the machine key from `~/.qoder/security/`), so the parser
/// derives titles from the plaintext transcript (first human prompt) instead.
pub struct QoderParser {
    base_dir: PathBuf,
}

impl QoderParser {
    pub fn new() -> Self {
        Self {
            base_dir: resolve_qoder_config_dir().join("projects"),
        }
    }

    /// Construct a parser pointed at an explicit `projects` directory (test
    /// fixtures).
    #[cfg(any(test, feature = "test-utils"))]
    pub fn with_base_dir(base_dir: PathBuf) -> Self {
        Self { base_dir }
    }

    /// Locate a session's transcript file by id: `<base>/<encoded-cwd>/<id>.jsonl`.
    /// The encoded-cwd segment is unknowable from the id alone, so this scans
    /// the projects tree for a matching file stem — the same shape Claude's
    /// per-project `read_dir` lookup has.
    fn transcript_path_for(&self, conversation_id: &str) -> Option<PathBuf> {
        let expected = format!("{conversation_id}.jsonl");
        WalkDir::new(&self.base_dir)
            .max_depth(2)
            .into_iter()
            .filter_map(|e| e.ok())
            .find(|entry| entry.file_name().to_str() == Some(expected.as_str()))
            .map(|entry| entry.into_path())
    }

    /// The per-line summary scan. Content records (`user`/`assistant`) drive
    /// timestamps and counts; metadata records contribute what only they carry
    /// (`runtime-config.model`). `sidechain` entries (qoder runs sub-agents
    /// inline in the same file with `isSidechain: true`) are excluded — they
    /// are a sub-agent's internal execution, not this conversation's turns.
    fn parse_summary(&self, path: &Path) -> Option<ConversationSummary> {
        let reader = BufReader::new(fs::File::open(path).ok()?);

        let mut first_ts: Option<DateTime<Utc>> = None;
        let mut last_ts: Option<DateTime<Utc>> = None;
        let mut first_user_text: Option<String> = None;
        let mut model: Option<String> = None;
        let mut cwd: Option<String> = None;
        let mut git_branch: Option<String> = None;
        let mut session_id: Option<String> = None;
        let mut message_count: u32 = 0;

        for line in reader.lines() {
            let Ok(line) = line else { continue };
            if line.trim().is_empty() {
                continue;
            }
            let Ok(value) = serde_json::from_str::<Value>(&line) else {
                continue;
            };

            let record_type = value.get("type").and_then(|t| t.as_str()).unwrap_or("");
            let is_sidechain = value
                .get("isSidechain")
                .and_then(|s| s.as_bool())
                .unwrap_or(false);

            if session_id.is_none() {
                session_id = value
                    .get("sessionId")
                    .and_then(|s| s.as_str())
                    .map(String::from);
            }
            if cwd.is_none() {
                cwd = value
                    .get("cwd")
                    .and_then(|c| c.as_str())
                    .map(String::from);
            }
            if git_branch.is_none() {
                git_branch = value
                    .get("gitBranch")
                    .and_then(|g| g.as_str())
                    .map(String::from);
            }
            // `runtime-config` records the launch-time model; an assistant
            // record's `message.model` is the live per-message truth, so only
            // fall back to this when no assistant record has spoken yet.
            if model.is_none() && record_type == "runtime-config" && !is_sidechain {
                model = value
                    .get("model")
                    .and_then(|m| m.as_str())
                    .map(String::from);
            }

            if !is_content_record(record_type) || is_sidechain {
                continue;
            }
            if let Some(ts) = record_timestamp(&value) {
                first_ts.get_or_insert(ts);
                last_ts = Some(ts);
            }

            match record_type {
                "user" => {
                    message_count += 1;
                    if first_user_text.is_none() {
                        if let Some(text) = human_user_text(&value) {
                            if !text.trim().is_empty() {
                                first_user_text =
                                    Some(title_from_user_text(text.trim()));
                            }
                        }
                    }
                }
                "assistant" => {
                    message_count += 1;
                    if model.is_none() {
                        model = value
                            .get("message")
                            .and_then(|m| m.get("model"))
                            .and_then(|m| m.as_str())
                            .map(String::from);
                    }
                }
                _ => {}
            }
        }

        let started_at = first_ts?;
        let id = session_id.unwrap_or_else(|| {
            path.file_stem()
                .unwrap_or_default()
                .to_string_lossy()
                .into_owned()
        });
        let folder_name = cwd.as_deref().map(folder_name_from_path);

        Some(ConversationSummary {
            id,
            agent_type: AgentType::Qoder,
            folder_path: cwd,
            folder_name,
            title: first_user_text,
            started_at,
            ended_at: last_ts,
            message_count,
            model,
            git_branch,
            parent_id: None,
            parent_tool_use_id: None,
            delegation_call_id: None,
        })
    }

    fn parse_detail(
        &self,
        path: &Path,
        conversation_id: &str,
    ) -> Result<ConversationDetail, ParseError> {
        // Read the file fully up front so `transcript_watermark` is EXACTLY the
        // byte length this parse consumed — see the same contract in
        // `parsers::claude`. An over-claiming watermark (e.g. from a stat
        // around the read) would make the frontend retire background-overlay
        // turns whose content this detail does not include.
        let bytes = fs::read(path)?;
        let transcript_watermark = bytes.len() as u64;

        let mut messages: Vec<UnifiedMessage> = Vec::new();
        // `message.id` of the assistant message currently being accumulated
        // (see the assistant arm); `None` while the last record was not an
        // assistant fragment.
        let mut pending_assistant_chat_id: Option<String> = None;
        let mut first_ts: Option<DateTime<Utc>> = None;
        let mut last_ts: Option<DateTime<Utc>> = None;
        let mut first_user_text: Option<String> = None;
        let mut model: Option<String> = None;
        let mut cwd: Option<String> = None;
        let mut git_branch: Option<String> = None;
        let mut message_count: u32 = 0;

        for chunk in bytes.split(|b| *b == b'\n') {
            let Ok(line) = std::str::from_utf8(chunk) else {
                continue;
            };
            if line.trim().is_empty() {
                continue;
            }
            let Ok(value) = serde_json::from_str::<Value>(line) else {
                continue;
            };

            let record_type = value.get("type").and_then(|t| t.as_str()).unwrap_or("");
            let is_sidechain = value
                .get("isSidechain")
                .and_then(|s| s.as_bool())
                .unwrap_or(false);

            if cwd.is_none() {
                cwd = value
                    .get("cwd")
                    .and_then(|c| c.as_str())
                    .map(String::from);
            }
            if git_branch.is_none() {
                git_branch = value
                    .get("gitBranch")
                    .and_then(|g| g.as_str())
                    .map(String::from);
            }
            if model.is_none() && record_type == "runtime-config" && !is_sidechain {
                model = value
                    .get("model")
                    .and_then(|m| m.as_str())
                    .map(String::from);
            }

            if !is_content_record(record_type) || is_sidechain {
                continue;
            }
            let Some(ts) = record_timestamp(&value).or(last_ts) else {
                continue;
            };
            first_ts.get_or_insert(ts);
            last_ts = Some(ts);

            let uuid = value
                .get("uuid")
                .and_then(|u| u.as_str())
                .map(String::from);

            match record_type {
                "user" => {
                    message_count += 1;
                    if let Some(text) = human_user_text(&value) {
                        if first_user_text.is_none() && !text.trim().is_empty() {
                            first_user_text =
                                Some(title_from_user_text(text.trim()));
                        }
                        if !text.trim().is_empty() {
                            messages.push(UnifiedMessage {
                                id: uuid.unwrap_or_else(|| format!("q-user-{}", messages.len())),
                                role: MessageRole::User,
                                content: vec![ContentBlock::Text { text }],
                                timestamp: ts,
                                usage: None,
                                duration_ms: None,
                                model: None,
                                completed_at: Some(ts),
                            });
                        }
                    } else {
                        // A user record whose content is a block array is a
                        // tool-result delivery (Claude envelope semantics).
                        // Empty content lists nothing; a synthetic user turn
                        // with zero blocks would only pollute the transcript.
                        let blocks = tool_result_blocks(&value);
                        if !blocks.is_empty() {
                            messages.push(UnifiedMessage {
                                id: uuid
                                    .unwrap_or_else(|| format!("q-toolresult-{}", messages.len())),
                                role: MessageRole::User,
                                content: blocks,
                                timestamp: ts,
                                usage: None,
                                duration_ms: None,
                                model: None,
                                completed_at: Some(ts),
                            });
                        }
                    }
                }
                "assistant" => {
                    message_count += 1;
                    let blocks = assistant_blocks(&value);
                    if blocks.is_empty() {
                        continue;
                    }
                    let entry_model = value
                        .get("message")
                        .and_then(|m| m.get("model"))
                        .and_then(|m| m.as_str())
                        .map(String::from);
                    model.get_or_insert_with(|| entry_model.clone().unwrap_or_default());
                    if model.as_deref() == Some("") {
                        model = entry_model.clone();
                    }
                    // One API response streams as SEVERAL assistant records
                    // (thinking, tool_use, final text) sharing one
                    // `message.id`; they must merge into a single message or
                    // every fragment becomes its own turn. A record whose id
                    // differs from the pending message's (or carries none)
                    // starts a new one — the same accumulation shape as the
                    // Claude parser.
                    let message_id = value
                        .get("message")
                        .and_then(|m| m.get("id"))
                        .and_then(|m| m.as_str())
                        .map(String::from);
                    let pending_same_id = match (&messages.last(), &message_id) {
                        (
                            Some(UnifiedMessage {
                                role: MessageRole::Assistant,
                                ..
                            }),
                            Some(id),
                        ) => pending_assistant_chat_id.as_deref() == Some(id.as_str()),
                        _ => false,
                    };
                    if pending_same_id {
                        let last = messages.last_mut().expect("checked non-empty");
                        last.content.extend(blocks);
                        last.completed_at = Some(ts);
                        // Later fragments carry the settled usage (the
                        // end-turn record) and the fuller model name.
                        if let Some(usage) = usage_from_record(&value) {
                            last.usage = Some(usage);
                        }
                        if let Some(m) = entry_model {
                            last.model = Some(m);
                        }
                    } else {
                        messages.push(UnifiedMessage {
                            id: uuid
                                .unwrap_or_else(|| format!("q-assistant-{}", messages.len())),
                            role: MessageRole::Assistant,
                            content: blocks,
                            timestamp: ts,
                            usage: usage_from_record(&value),
                            duration_ms: None,
                            model: entry_model,
                            completed_at: Some(ts),
                        });
                    }
                    pending_assistant_chat_id = message_id;
                }
                _ => {}
            }
        }

        let mut turns = crate::parsers::claude::group_into_turns(messages);
        relocate_orphaned_tool_results(&mut turns);
        structurize_read_tool_output(&mut turns);
        resolve_patch_line_numbers(&mut turns, cwd.as_deref());
        backfill_turn_durations(&mut turns, &[]);

        let used_tokens = latest_turn_total_usage_tokens(&turns);
        let max_tokens = infer_context_window_max_tokens(model.as_deref());
        let session_stats =
            merge_context_window_stats(compute_session_stats(&turns), used_tokens, max_tokens);

        let folder_name = cwd.as_deref().map(folder_name_from_path);
        let summary = ConversationSummary {
            id: conversation_id.to_string(),
            agent_type: AgentType::Qoder,
            folder_path: cwd,
            folder_name,
            // Same precedence as `parse_summary` — the two paths MUST agree, or
            // the auto-title backfill would oscillate between them.
            title: first_user_text,
            started_at: first_ts.unwrap_or_else(Utc::now),
            ended_at: last_ts,
            message_count,
            model,
            git_branch,
            parent_id: None,
            parent_tool_use_id: None,
            delegation_call_id: None,
        };

        Ok(ConversationDetail {
            summary,
            turns,
            session_stats,
            transcript_watermark: Some(transcript_watermark),
        })
    }
}

impl Default for QoderParser {
    fn default() -> Self {
        Self::new()
    }
}

/// Content records — the two record types that carry conversation turns. The
/// metadata records (`workspace-directories`, `runtime-config`, `active-leaf`,
/// `last-prompt`) interleave with these and repeat at the file tail; none of
/// them advance timestamps or counts. Their integer-epoch `timestamp` fields
/// (content records use ISO strings) are the tell that they are not content.
fn is_content_record(record_type: &str) -> bool {
    matches!(record_type, "user" | "assistant")
}

/// ISO-8601 `timestamp` string on a content record.
fn record_timestamp(value: &Value) -> Option<DateTime<Utc>> {
    value
        .get("timestamp")
        .and_then(|t| t.as_str())
        .and_then(|t| DateTime::parse_from_rfc3339(t).ok())
        .map(|t| t.with_timezone(&Utc))
}

/// The human prompt behind a user record, when it is one. A user record whose
/// `message.content` is a block array is a tool-result delivery (or a
/// sidechain-visible synthetic prompt) — returning `None` routes it to the
/// tool-result path instead of rendering internals as a user bubble.
fn human_user_text(value: &Value) -> Option<String> {
    // Only genuine human input becomes a user bubble: qoder marks the real
    // prompts with `origin.kind == "human"` (tool results and synthetic
    // continuation records do not carry it).
    let is_human = value
        .get("origin")
        .and_then(|o| o.get("kind"))
        .and_then(|k| k.as_str())
        .map(|k| k == "human")
        .unwrap_or(false);
    if !is_human {
        return None;
    }
    value
        .get("message")
        .and_then(|m| m.get("content"))
        .and_then(|c| c.as_str())
        .map(String::from)
}

/// `tool_result` blocks inside a user record's content array.
fn tool_result_blocks(value: &Value) -> Vec<ContentBlock> {
    let mut blocks = Vec::new();
    let Some(arr) = value
        .get("message")
        .and_then(|m| m.get("content"))
        .and_then(|c| c.as_array())
    else {
        return blocks;
    };
    for item in arr {
        let block_type = item.get("type").and_then(|t| t.as_str()).unwrap_or("");
        if block_type != "tool_result" {
            continue;
        }
        let tool_use_id = item
            .get("tool_use_id")
            .and_then(|n| n.as_str())
            .map(String::from);
        let output = tool_result_text(item);
        let is_error = item
            .get("is_error")
            .and_then(|e| e.as_bool())
            .unwrap_or(false);
        blocks.push(ContentBlock::ToolResult {
            tool_use_id,
            output_preview: output,
            is_error,
            agent_stats: None,
            images: Vec::new(),
        });
    }
    blocks
}

/// A tool result's `content` is either a plain string or an array of
/// `{type: "text", text}` blocks (Claude envelope allows both).
fn tool_result_text(item: &Value) -> Option<String> {
    match item.get("content") {
        Some(Value::String(s)) => Some(s.clone()),
        Some(Value::Array(arr)) => {
            let texts: Vec<&str> = arr
                .iter()
                .filter_map(|b| b.get("text").and_then(|t| t.as_str()))
                .collect();
            (!texts.is_empty()).then(|| texts.join("\n"))
        }
        _ => None,
    }
}

/// Content blocks of an assistant record: `thinking`, `text`, `tool_use`.
fn assistant_blocks(value: &Value) -> Vec<ContentBlock> {
    let mut blocks = Vec::new();
    let Some(arr) = value
        .get("message")
        .and_then(|m| m.get("content"))
        .and_then(|c| c.as_array())
    else {
        return blocks;
    };
    for item in arr {
        let block_type = item.get("type").and_then(|t| t.as_str()).unwrap_or("");
        match block_type {
            "text" => {
                if let Some(text) = item.get("text").and_then(|t| t.as_str()) {
                    blocks.push(ContentBlock::Text {
                        text: text.to_string(),
                    });
                }
            }
            "thinking" => {
                if let Some(text) = item.get("thinking").and_then(|t| t.as_str()) {
                    blocks.push(ContentBlock::Thinking {
                        text: text.to_string(),
                    });
                }
            }
            "tool_use" => {
                let tool_use_id = item
                    .get("id")
                    .and_then(|n| n.as_str())
                    .map(String::from);
                let tool_name = item
                    .get("name")
                    .and_then(|n| n.as_str())
                    .unwrap_or("unknown")
                    .to_string();
                let input_preview = item.get("input").map(|i| i.to_string());
                blocks.push(ContentBlock::ToolUse {
                    tool_use_id,
                    tool_name,
                    input_preview,
                    status: None,
                    meta: None,
                });
            }
            _ => {}
        }
    }
    blocks
}

/// Token usage off an assistant record's `message.usage`. Qoder meters its
/// subscription in `credits` (present in the same object) — codeg's usage
/// model is token-shaped, so credits are left in the transcript and only the
/// token counters map.
fn usage_from_record(value: &Value) -> Option<TurnUsage> {
    let usage = value.get("message")?.get("usage")?;
    Some(TurnUsage {
        input_tokens: usage
            .get("input_tokens")
            .and_then(|v| v.as_u64())
            .unwrap_or(0),
        output_tokens: usage
            .get("output_tokens")
            .and_then(|v| v.as_u64())
            .unwrap_or(0),
        cache_creation_input_tokens: usage
            .get("cache_creation_input_tokens")
            .and_then(|v| v.as_u64())
            .unwrap_or(0),
        cache_read_input_tokens: usage
            .get("cache_read_input_tokens")
            .and_then(|v| v.as_u64())
            .unwrap_or(0),
    })
}

impl AgentParser for QoderParser {
    fn list_conversations(&self) -> Result<Vec<ConversationSummary>, ParseError> {
        let mut conversations = Vec::new();
        if !self.base_dir.exists() {
            return Ok(conversations);
        }

        for entry in WalkDir::new(&self.base_dir)
            .max_depth(2)
            .into_iter()
            .filter_map(|e| e.ok())
        {
            let path = entry.path();
            if !entry.file_type().is_file()
                || path.extension().and_then(|e| e.to_str()) != Some("jsonl")
            {
                continue;
            }
            if let Ok(Some(summary)) = super::summary_cache::get_or_parse(
                AgentType::Qoder,
                path,
                || Ok(self.parse_summary(path)),
            ) {
                conversations.push(summary);
            }
        }

        conversations.sort_by_key(|c| std::cmp::Reverse(c.started_at));
        Ok(conversations)
    }

    fn get_conversation(&self, conversation_id: &str) -> Result<ConversationDetail, ParseError> {
        let path = self
            .transcript_path_for(conversation_id)
            .ok_or_else(|| ParseError::ConversationNotFound(conversation_id.to_string()))?;
        self.parse_detail(&path, conversation_id)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parser_in(tmp: &std::path::Path) -> QoderParser {
        QoderParser::with_base_dir(tmp.join("projects"))
    }

    fn write_session(tmp: &std::path::Path, id: &str, lines: &[&str]) -> PathBuf {
        let dir = tmp.join("projects").join("-private-tmp-probe");
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join(format!("{id}.jsonl"));
        std::fs::write(&path, lines.join("\n") + "\n").unwrap();
        path
    }

    // Lines captured verbatim from a real qoder 1.1.23 session (paths and ids
    // trimmed to the essentials the parser reads).
    const RUNTIME_CONFIG: &str = r#"{"type":"runtime-config","sessionId":"s1","model":"qmodel_38max","reasoningEffort":null,"contextWindow":null,"generation":null,"timestamp":1786895127277}"#;
    const USER_LINE: &str = r#"{"type":"user","uuid":"u1","timestamp":"2026-08-16T15:45:27.384Z","message":{"role":"user","content":"read NOTES.md and reply"},"permissionMode":"default","origin":{"kind":"human"},"promptId":"s1","humanInput":{"text":"read NOTES.md and reply","mode":"prompt"},"parentUuid":null,"isSidechain":false,"cwd":"/private/tmp/probe","sessionId":"s1","userType":"external","entrypoint":"cli","version":"1.1.23","gitBranch":"main"}"#;
    const THINKING_LINE: &str = r#"{"type":"assistant","uuid":"a1","timestamp":"2026-08-16T15:45:33.089Z","message":{"id":"chatcmpl-1","type":"message","role":"assistant","model":"qmodel_38max","stop_reason":null,"content":[{"type":"thinking","thinking":"Need to read the file.","signature":""}]},"parentUuid":"u1","isSidechain":false,"cwd":"/private/tmp/probe","sessionId":"s1","userType":"external","entrypoint":"cli","version":"1.1.23","gitBranch":"main"}"#;
    const TOOL_USE_LINE: &str = r#"{"type":"assistant","uuid":"a2","timestamp":"2026-08-16T15:45:33.100Z","message":{"id":"chatcmpl-1","type":"message","role":"assistant","model":"qmodel_38max","stop_reason":"tool_use","content":[{"type":"tool_use","id":"call_1","name":"Read","input":{"file_path":"/private/tmp/probe/NOTES.md"}}]},"parentUuid":"a1","isSidechain":false,"cwd":"/private/tmp/probe","sessionId":"s1","userType":"external","entrypoint":"cli","version":"1.1.23","gitBranch":"main"}"#;
    const TOOL_RESULT_LINE: &str = r#"{"type":"user","uuid":"u2","timestamp":"2026-08-16T15:45:33.200Z","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"call_1","content":"1\tthe secret number is 42\n2\t"}]},"sourceToolAssistantUUID":"a2","promptId":"s1","toolUseResult":{"type":"text","file":{"filePath":"NOTES.md","content":"the secret number is 42\n","numLines":2,"startLine":1,"totalLines":2}},"parentUuid":"a2","isSidechain":false,"cwd":"/private/tmp/probe","sessionId":"s1","userType":"external","entrypoint":"cli","version":"1.1.23","gitBranch":"main"}"#;
    const ANSWER_LINE: &str = r#"{"type":"assistant","uuid":"a3","timestamp":"2026-08-16T15:45:34.000Z","message":{"id":"chatcmpl-1","type":"message","role":"assistant","model":"qmodel_38max","stop_reason":"end_turn","content":[{"type":"text","text":"42","citations":null}],"usage":{"input_tokens":10,"cache_creation_input_tokens":0,"cache_read_input_tokens":5,"output_tokens":2,"server_tool_use":{"web_search_requests":0,"web_fetch_requests":0}}},"parentUuid":"u2","isSidechain":false,"cwd":"/private/tmp/probe","sessionId":"s1","userType":"external","entrypoint":"cli","version":"1.1.23","gitBranch":"main"}"#;
    const ACTIVE_LEAF_LINE: &str = r#"{"type":"active-leaf","sessionId":"s1","leafUuid":"a3","explicit":false,"timestamp":1786895133089}"#;
    const LAST_PROMPT_LINE: &str = r#"{"type":"last-prompt","sessionId":"s1","lastPrompt":"read NOTES.md and reply"}"#;
    const SIDECHAIN_LINE: &str = r#"{"type":"assistant","uuid":"sc1","timestamp":"2026-08-16T15:45:35.000Z","message":{"role":"assistant","model":"qmodel_38max","content":[{"type":"text","text":"sub-agent internal output"}]},"parentUuid":null,"isSidechain":true,"cwd":"/private/tmp/probe","sessionId":"s1","userType":"external","entrypoint":"cli","version":"1.1.23","gitBranch":"main"}"#;

    #[test]
    fn summary_reads_real_layout() {
        let tmp = tempfile::tempdir().unwrap();
        write_session(
            tmp.path(),
            "s1",
            &[
                RUNTIME_CONFIG,
                USER_LINE,
                THINKING_LINE,
                TOOL_USE_LINE,
                TOOL_RESULT_LINE,
                ANSWER_LINE,
                ACTIVE_LEAF_LINE,
                LAST_PROMPT_LINE,
                // The tail repeats metadata records verbatim; none may move
                // the timestamps or counts.
                RUNTIME_CONFIG,
                ACTIVE_LEAF_LINE,
            ],
        );

        let summaries = parser_in(tmp.path()).list_conversations().unwrap();
        assert_eq!(summaries.len(), 1);
        let s = &summaries[0];
        assert_eq!(s.id, "s1");
        assert_eq!(s.agent_type, AgentType::Qoder);
        assert_eq!(s.title.as_deref(), Some("read NOTES.md and reply"));
        assert_eq!(s.folder_path.as_deref(), Some("/private/tmp/probe"));
        assert_eq!(s.folder_name.as_deref(), Some("probe"));
        assert_eq!(s.model.as_deref(), Some("qmodel_38max"));
        assert_eq!(s.git_branch.as_deref(), Some("main"));
        // 2 user + 3 assistant content records; metadata records don't count.
        assert_eq!(s.message_count, 5);
        assert_eq!(
            s.started_at.to_rfc3339(),
            "2026-08-16T15:45:27.384+00:00"
        );
        assert_eq!(s.ended_at.as_ref().map(|t| t.to_rfc3339()), Some("2026-08-16T15:45:34+00:00".to_string()));
    }

    #[test]
    fn detail_builds_turns_with_tool_pairing() {
        let tmp = tempfile::tempdir().unwrap();
        let path = write_session(
            tmp.path(),
            "s1",
            &[
                RUNTIME_CONFIG,
                USER_LINE,
                THINKING_LINE,
                TOOL_USE_LINE,
                TOOL_RESULT_LINE,
                ANSWER_LINE,
            ],
        );

        let detail = parser_in(tmp.path()).get_conversation("s1").unwrap();
        assert_eq!(detail.summary.id, "s1");
        assert_eq!(detail.transcript_watermark, Some(std::fs::metadata(&path).unwrap().len()));

        // One user turn, then TWO assistant turns: the thinking + tool_use
        // fragments share a `message.id` and merge into one message whose
        // paired tool result is absorbed, and the end-turn answer (a fresh
        // `message.id`) forms the next turn.
        assert_eq!(detail.turns.len(), 3);
        assert!(matches!(detail.turns[0].role, crate::models::TurnRole::User));
        assert!(matches!(detail.turns[1].role, crate::models::TurnRole::Assistant));
        assert!(matches!(detail.turns[2].role, crate::models::TurnRole::Assistant));

        let assistant = &detail.turns[1];
        let tool_use = assistant
            .blocks
            .iter()
            .find_map(|b| match b {
                ContentBlock::ToolUse { tool_use_id, tool_name, .. } => {
                    Some((tool_use_id.clone(), tool_name.clone()))
                }
                _ => None,
            })
            .expect("tool_use block");
        assert_eq!(
            tool_use,
            (Some("call_1".to_string()), "Read".to_string())
        );
        let tool_result = assistant
            .blocks
            .iter()
            .find_map(|b| match b {
                ContentBlock::ToolResult { tool_use_id, output_preview, .. } => {
                    Some((tool_use_id.clone(), output_preview.clone()))
                }
                _ => None,
            })
            .expect("tool_result block paired into the turn");
        assert_eq!(tool_result.0.as_deref(), Some("call_1"));
        assert!(tool_result.1.as_deref().unwrap().contains("42"));
        assert!(assistant
            .blocks
            .iter()
            .any(|b| matches!(b, ContentBlock::Thinking { text } if text.contains("read the file"))));
        assert!(assistant
            .blocks
            .iter()
            .all(|b| !matches!(b, ContentBlock::Text { text } if text == "42")));
        let answer = &detail.turns[2];
        assert!(answer
            .blocks
            .iter()
            .any(|b| matches!(b, ContentBlock::Text { text } if text == "42")));
        assert_eq!(answer.usage.as_ref().map(|u| u.output_tokens), Some(2));
    }

    #[test]
    fn sidechain_entries_are_excluded() {
        let tmp = tempfile::tempdir().unwrap();
        write_session(
            tmp.path(),
            "s1",
            &[USER_LINE, ANSWER_LINE, SIDECHAIN_LINE],
        );

        let detail = parser_in(tmp.path()).get_conversation("s1").unwrap();
        assert_eq!(detail.summary.message_count, 2);
        assert!(detail.turns.iter().all(|t| t
            .blocks
            .iter()
            .all(|b| !matches!(b, ContentBlock::Text { text } if text.contains("sub-agent")))));
    }

    #[test]
    fn tail_metadata_records_do_not_extend_timestamps() {
        let tmp = tempfile::tempdir().unwrap();
        write_session(
            tmp.path(),
            "s1",
            &[USER_LINE, ANSWER_LINE, ACTIVE_LEAF_LINE, RUNTIME_CONFIG],
        );

        let summaries = parser_in(tmp.path()).list_conversations().unwrap();
        // `active-leaf` carries a LATER epoch than any content record; it must
        // not leak into `ended_at`.
        assert_eq!(
            summaries[0].ended_at.as_ref().map(|t| t.to_rfc3339()),
            Some("2026-08-16T15:45:34+00:00".to_string())
        );
    }

    #[test]
    fn missing_session_is_not_found() {
        let tmp = tempfile::tempdir().unwrap();
        let err = parser_in(tmp.path()).get_conversation("nope").unwrap_err();
        assert!(matches!(err, ParseError::ConversationNotFound(_)));
    }

    #[test]
    fn config_dir_env_overrides_user_home() {
        let resolved = resolve_qoder_config_dir_from(
            Some("/tmp/qoder-home".into()),
            Some("/Users/default".into()),
        );
        assert_eq!(resolved, PathBuf::from("/tmp/qoder-home"));
        // An empty override falls back to `~/.qoder`, not an empty path.
        let resolved = resolve_qoder_config_dir_from(Some("".into()), Some("/Users/default".into()));
        assert_eq!(resolved, PathBuf::from("/Users/default/.qoder"));
        let resolved = resolve_qoder_config_dir_from(None, Some("/Users/default".into()));
        assert_eq!(resolved, PathBuf::from("/Users/default/.qoder"));
    }
}
