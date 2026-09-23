//! Each helper op, as exactly one driver call and a translation of its answer.
//!
//! This is the whitelist. The driver advertises several dozen tools; the five
//! named here (`list_apps`, `list_windows`, `get_window_state`,
//! `verify_state`, and nothing that writes) are the only ones the helper
//! ever calls, with arguments built here from typed fields — never a tool
//! name or an argument object that came from codeg as-is.

use std::collections::HashMap;
use std::time::Duration;

use serde_json::{json, Map, Value};

use super::driver_proc::DriverProc;
use super::mcp::ToolCallResult;
use crate::computer::procinfo::process_start;
use crate::computer::protocol::{
    HelperError, HelperErrorCode, OsPermission, RawApp, RawCapture, RawSnapshot, RawVerify,
    RawWindow,
};
use crate::computer::types::{
    PredicateResult, Rect, VerifyPredicate, VerifyRequest, VerifyStatus, MAX_VERIFY_PREDICATES,
};

const LIST_TIMEOUT: Duration = Duration::from_secs(30);
/// The driver bounds its own accessibility walk at 20 s; the rest is the
/// capture and the encode.
const WINDOW_STATE_TIMEOUT: Duration = Duration::from_secs(60);
/// Added to the caller's own `timeoutMs` for `verify_state`.
const VERIFY_OVERHEAD: Duration = Duration::from_secs(30);
/// The driver's own bounds on a verify.
const MAX_VERIFY_TIMEOUT_MS: u32 = 10_000;
const MAX_STABLE_SAMPLES: u32 = 5;

/// Turn a refused driver call into the helper's error, by the driver's own
/// refusal code where it gave one.
pub fn tool_error(tool: &str, result: &ToolCallResult) -> HelperError {
    let structured = result.structured.as_ref();
    let code = structured
        .and_then(|s| s.get("code").and_then(Value::as_str))
        .or_else(|| structured.and_then(|s| s.pointer("/refusal/code").and_then(Value::as_str)))
        .unwrap_or("");
    let text = result.text();
    let words = if text.is_empty() {
        format!("{tool} failed")
    } else {
        text
    };
    match code {
        "screen_recording_permission_denied" => {
            HelperError::permission_missing(OsPermission::ScreenRecording)
        }
        "permission_denied" | "accessibility_permission_denied" | "tcc_permission_denied" => {
            HelperError::permission_missing(OsPermission::Accessibility)
        }
        "window_id_not_found" | "window_owner_pid_mismatch" => {
            HelperError::new(HelperErrorCode::NoSuchWindow, words)
        }
        _ => HelperError::failed(words),
    }
}

async fn call(
    driver: &DriverProc,
    tool: &str,
    arguments: Value,
    timeout: Duration,
) -> Result<ToolCallResult, HelperError> {
    let result = driver.call(tool, arguments, timeout).await?;
    if result.is_error {
        return Err(tool_error(tool, &result));
    }
    Ok(result)
}

fn structured<'a>(tool: &str, result: &'a ToolCallResult) -> Result<&'a Value, HelperError> {
    result
        .structured
        .as_ref()
        .ok_or_else(|| HelperError::failed(format!("{tool} answered without structured content")))
}

fn rect(value: &Value) -> Option<Rect> {
    Some(Rect {
        x: value.get("x")?.as_f64()?,
        y: value.get("y")?.as_f64()?,
        width: value.get("width")?.as_f64()?,
        height: value.get("height")?.as_f64()?,
    })
}

fn string(value: &Value, key: &str) -> Option<String> {
    value
        .get(key)
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}

/// Running applications, each stamped with its start time.
pub async fn list_apps(driver: &DriverProc) -> Result<Vec<RawApp>, HelperError> {
    let result = call(driver, "list_apps", json!({}), LIST_TIMEOUT).await?;
    parse_apps(structured("list_apps", &result)?)
}

/// The array `key` of a successful answer. Missing is a malformed answer, not
/// an empty one: an application list read as empty would leave every window
/// without the application that names it.
fn required_array<'a>(tool: &str, value: &'a Value, key: &str) -> Result<&'a [Value], HelperError> {
    value
        .get(key)
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .ok_or_else(|| HelperError::failed(format!("{tool} answered without `{key}`")))
}

fn parse_apps(value: &Value) -> Result<Vec<RawApp>, HelperError> {
    required_array("list_apps", value, "apps").map(|apps| {
            apps.iter()
                // The driver also lists installed applications that are not
                // running (pid 0); only running ones have windows.
                .filter(|a| a.get("running").and_then(Value::as_bool) == Some(true))
                .filter_map(|a| {
                    let pid = u32::try_from(a.get("pid")?.as_u64()?)
                        .ok()
                        .filter(|p| *p > 0)?;
                    Some(RawApp {
                        pid,
                        name: string(a, "name").unwrap_or_default(),
                        bundle_id: string(a, "bundle_id"),
                        path: string(a, "launch_path"),
                        active: a.get("active").and_then(Value::as_bool).unwrap_or(false),
                        started_at: process_start(pid),
                    })
                })
                .collect()
        })
}

/// Remembers which application each running process is, so listing windows
/// does not re-list every installed application each time. Keyed by pid AND
/// start time: a reused pid is a cache miss, never a stale hit.
#[derive(Default)]
pub struct AppCache {
    apps: HashMap<(u32, Option<u64>), RawApp>,
}

impl AppCache {
    fn lookup(&self, pid: u32, started_at: Option<u64>) -> Option<&RawApp> {
        self.apps.get(&(pid, started_at))
    }

    fn refill(&mut self, apps: Vec<RawApp>) {
        self.apps = apps
            .into_iter()
            .map(|app| ((app.pid, app.started_at), app))
            .collect();
    }
}

/// Normal windows, each joined with its application.
pub async fn list_windows(
    driver: &DriverProc,
    cache: &tokio::sync::Mutex<AppCache>,
    pid: Option<u32>,
) -> Result<Vec<RawWindow>, HelperError> {
    let mut args = json!({ "on_screen_only": false });
    if let Some(pid) = pid {
        args["pid"] = json!(pid);
    }
    let result = call(driver, "list_windows", args, LIST_TIMEOUT).await?;
    let windows = parse_windows(structured("list_windows", &result)?)?;

    let mut cache = cache.lock().await;
    let stamps: Vec<Option<u64>> = windows.iter().map(|w| process_start(w.pid)).collect();
    let missing = windows
        .iter()
        .zip(&stamps)
        .any(|(w, started)| cache.lookup(w.pid, *started).is_none());
    if missing {
        cache.refill(list_apps(driver).await?);
        // A process the application list does not know — a background
        // helper, an agent's own window — keeps the name the window list gave
        // it and has no key a blocklist could match. Remembered like any
        // other, so it does not send every later listing back to the slow
        // application list.
        for (window, started_at) in windows.iter().zip(&stamps) {
            cache
                .apps
                .entry((window.pid, *started_at))
                .or_insert_with(|| RawApp {
                    started_at: *started_at,
                    ..window.app.clone()
                });
        }
    }
    Ok(windows
        .into_iter()
        .zip(stamps)
        .map(|(mut window, started_at)| {
            if let Some(app) = cache.lookup(window.pid, started_at) {
                window.app = app.clone();
            }
            window.app.started_at = started_at;
            window
        })
        .collect())
}

/// The windows in a `list_windows` answer that could be someone's window at
/// all: the normal layer, with an area. Visible or not — whether a window is
/// worth *showing* is codeg's call, made after it has matched the listing
/// against the windows it has already named. A shared window whose
/// application is hidden (⌘H) is off screen and still the same window, and a
/// listing that dropped it would read as the window closing and end the
/// grant.
fn parse_windows(value: &Value) -> Result<Vec<RawWindow>, HelperError> {
    let flag = |w: &Value, key: &str| w.get(key).and_then(Value::as_bool);
    required_array("list_windows", value, "windows").map(|windows| {
            windows
                .iter()
                .filter(|w| w.get("layer").and_then(Value::as_i64).unwrap_or(0) == 0)
                .filter_map(|w| {
                    let bounds = rect(w.get("bounds")?)?;
                    if bounds.is_empty() {
                        return None;
                    }
                    let pid = u32::try_from(w.get("pid")?.as_u64()?).ok()?;
                    Some(RawWindow {
                        window_id: w.get("window_id")?.as_u64()?,
                        pid,
                        title: string(w, "title").unwrap_or_default(),
                        bounds,
                        on_screen: flag(w, "is_on_screen").unwrap_or(false),
                        minimized: flag(w, "minimized"),
                        on_current_space: flag(w, "on_current_space"),
                        z_index: w.get("z_index").and_then(Value::as_i64),
                        app: RawApp {
                            pid,
                            name: string(w, "app_name").unwrap_or_default(),
                            bundle_id: None,
                            path: None,
                            active: false,
                            started_at: None,
                        },
                    })
                })
                .collect()
        })
}

/// A screenshot of one window, and nothing around it: the driver captures the
/// window's own pixels, so nothing of the windows beside or under it can end
/// up in the image.
pub async fn capture(
    driver: &DriverProc,
    pid: u32,
    window_id: u64,
    max_dimension: Option<u32>,
) -> Result<RawCapture, HelperError> {
    let mut args = json!({
        "pid": pid,
        "window_id": window_id,
        "include_screenshot": true,
        "include_accessibility_tree": false,
    });
    if let Some(max) = max_dimension.filter(|m| *m > 0) {
        args["max_dimension"] = json!(max);
    }
    let result = call(driver, "get_window_state", args, WINDOW_STATE_TIMEOUT).await?;
    let meta = structured("get_window_state", &result)?;
    let Some((data, mime)) = result.image() else {
        // The capture half failed and the driver said why beside an
        // otherwise successful answer.
        let why = meta
            .pointer("/screenshot_error/reason")
            .or_else(|| meta.get("screenshot_error"))
            .map(|e| e.to_string())
            .unwrap_or_else(|| "no image came back".to_string());
        return Err(HelperError::failed(format!(
            "the window could not be captured: {why}"
        )));
    };
    if mime != "image/png" {
        return Err(HelperError::failed(format!(
            "the capture came back as {mime}"
        )));
    }
    Ok(RawCapture {
        png_base64: data.to_string(),
        width: meta
            .get("screenshot_width")
            .and_then(Value::as_u64)
            .and_then(|v| u32::try_from(v).ok())
            .unwrap_or(0),
        height: meta
            .get("screenshot_height")
            .and_then(Value::as_u64)
            .and_then(|v| u32::try_from(v).ok())
            .unwrap_or(0),
        window_bounds: meta.get("window_bounds").and_then(rect).unwrap_or_default(),
        title: string(meta, "window_title"),
    })
}

/// A window's accessibility tree, with the values of anything that looks like
/// a secret taken out.
pub async fn snapshot(
    driver: &DriverProc,
    pid: u32,
    window_id: u64,
    max_depth: Option<u32>,
    max_elements: Option<u32>,
    query: Option<String>,
) -> Result<RawSnapshot, HelperError> {
    let mut args = json!({
        "pid": pid,
        "window_id": window_id,
        "include_screenshot": false,
        "include_accessibility_tree": true,
    });
    if let Some(depth) = max_depth.filter(|d| *d > 0) {
        args["max_depth"] = json!(depth);
    }
    if let Some(elements) = max_elements.filter(|e| *e > 0) {
        args["max_elements"] = json!(elements);
    }
    if let Some(query) = query.filter(|q| !q.trim().is_empty()) {
        args["query"] = json!(query);
    }
    let result = call(driver, "get_window_state", args, WINDOW_STATE_TIMEOUT).await?;
    let meta = structured("get_window_state", &result)?;
    let tree = meta
        .get("tree_markdown")
        .and_then(Value::as_str)
        .ok_or_else(|| HelperError::failed("get_window_state answered without a tree"))?;
    Ok(RawSnapshot {
        tree: redact_secrets(tree),
        element_count: meta
            .get("element_count")
            .and_then(Value::as_u64)
            .unwrap_or(0),
        truncated: meta
            .get("truncated")
            .and_then(Value::as_bool)
            .unwrap_or(false)
            || tree.contains("AX tree truncated"),
        degraded: string(meta, "degraded_reason"),
        window_bounds: meta.get("window_bounds").and_then(rect),
        title: string(meta, "window_title"),
    })
}

/// Words that mark a field as a secret, in the languages codeg ships in.
const SECRET_WORDS: &[&str] = &[
    "password",
    "passwd",
    "passcode",
    "passphrase",
    "secret",
    "pin code",
    "密码",
    "密碼",
    "口令",
    "パスワード",
    "비밀번호",
    "contraseña",
    "mot de passe",
    "passwort",
    "senha",
    "كلمة المرور",
];

/// Take the value out of every tree node that describes a secret.
///
/// The platforms already refuse to hand a secure field's text to an
/// accessibility client — macOS answers bullets for a secure text field,
/// Windows refuses a password edit's value to other processes — so this is
/// the second line, not the first: a node whose role names a password
/// control, or whose label says it is one, keeps its role and label and loses
/// its value. The driver's tree does not carry macOS subroles, so a secure
/// field is recognised here by its words; recognising it by subrole needs the
/// driver to report one.
///
/// The driver writes values unescaped, newlines included, so a node is not a
/// line: it runs from a line that starts one (see [`Dialect::starts_node`])
/// to the next, and a secret's value goes with every line of it.
pub fn redact_secrets(tree: &str) -> String {
    redact_tree(tree, Dialect::current())
}

/// The shape of a node line in the driver's tree on each platform.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Dialect {
    /// `- [3] AXTextField "Title" = "value" (description) [attrs]`
    Mac,
    /// `- [3] Edit "Name" [value="…" id=… actions=[…]]`, and `- Text "Name" = "…"`
    Windows,
    /// `- [3] password text "name" value="…" [actions=[…]]`, and `- label = "name"`
    Linux,
}

impl Dialect {
    fn current() -> Self {
        if cfg!(target_os = "macos") {
            Dialect::Mac
        } else if cfg!(windows) {
            Dialect::Windows
        } else {
            Dialect::Linux
        }
    }

    /// Whether `line` starts a node rather than continuing the value of the
    /// one above it: indentation in whole steps, `- `, an optional
    /// `[index] `, then a role as this platform's tree spells one — an `AX`
    /// role on macOS, one of UI Automation's control types on Windows, an
    /// AT-SPI role name followed by the quoted name every Linux node carries.
    /// A value's own lines are the user's text; the stricter this is, the
    /// less of that text can pass for a node and escape its node's redaction.
    fn starts_node(self, line: &str) -> bool {
        let line = line.trim_end_matches('\n');
        let rest = line.trim_start_matches(' ');
        if !(line.len() - rest.len()).is_multiple_of(2) {
            return false;
        }
        let Some(mut rest) = rest.strip_prefix("- ") else {
            return false;
        };
        let mut indexed = false;
        if let Some(inner) = rest.strip_prefix('[') {
            let Some(close) = inner.find("] ") else {
                return false;
            };
            if close == 0 || !inner[..close].bytes().all(|b| b.is_ascii_digit()) {
                return false;
            }
            rest = &inner[close + 2..];
            indexed = true;
        }
        // What may follow a role in a node line: nothing, a quoted title or
        // name, a value, a description, an attribute block.
        let follows = |after: &str, allowed: &[&str]| {
            after.is_empty() || allowed.iter().any(|a| after.starts_with(a))
        };
        match self {
            Dialect::Mac => {
                let end = rest
                    .bytes()
                    .position(|b| !b.is_ascii_alphanumeric())
                    .unwrap_or(rest.len());
                rest.starts_with("AX")
                    && end > 2
                    && follows(&rest[end..], &[" \"", " = \"", " (", " ["])
            }
            Dialect::Windows => {
                let end = rest
                    .bytes()
                    .position(|b| !b.is_ascii_alphabetic())
                    .unwrap_or(rest.len());
                UIA_CONTROL_TYPES.contains(&&rest[..end])
                    && follows(&rest[end..], &[" \"", " = \"", " ["])
            }
            Dialect::Linux => {
                // `- [3] push button "name" …` and `- label = "name"`: an
                // AT-SPI node always carries its name, quoted.
                let end = rest
                    .bytes()
                    .position(|b| !(b.is_ascii_lowercase() || b == b' '))
                    .unwrap_or(rest.len());
                let role = rest[..end].trim_end();
                let after = &rest[role.len()..];
                !role.is_empty()
                    && after.starts_with(if indexed { " \"" } else { " = \"" })
            }
        }
    }
}

/// UI Automation's control types, as cua-driver names them in its Windows
/// tree.
const UIA_CONTROL_TYPES: &[&str] = &[
    "AppBar", "Button", "Calendar", "CheckBox", "ComboBox", "Custom", "DataGrid", "DataItem",
    "Document", "Edit", "Group", "Header", "HeaderItem", "Hyperlink", "Image", "List",
    "ListItem", "Menu", "MenuBar", "MenuItem", "Pane", "ProgressBar", "RadioButton",
    "ScrollBar", "SemanticZoom", "Separator", "Slider", "Spinner", "SplitButton", "StatusBar",
    "Tab", "TabItem", "Table", "Text", "Thumb", "TitleBar", "ToolBar", "ToolTip", "Tree",
    "TreeItem", "Unknown", "Window",
];

fn redact_tree(tree: &str, dialect: Dialect) -> String {
    let mut out = String::with_capacity(tree.len());
    let mut node = String::new();
    for line in tree.split_inclusive('\n') {
        if !node.is_empty() && dialect.starts_node(line) {
            out.push_str(&redact_node(&node));
            node.clear();
        }
        node.push_str(line);
    }
    out.push_str(&redact_node(&node));
    out
}

/// Where a node's value starts: ` = "` in every tree, and `value="` on the
/// addressable elements of the Windows (`[value="`) and Linux (` value="`)
/// ones.
const VALUE_MARKERS: &[&str] = &[" = \"", " value=\"", "[value=\""];

/// What can only follow the quote that closes a value: a description, an
/// attribute block, one of the attributes, or the end of the node.
const AFTER_VALUE: &[&str] = &["\" (", "\" [", "\" id=", "\" help=", "\" actions=", "\"]"];

fn redact_node(node: &str) -> String {
    let Some((start, marker)) = VALUE_MARKERS
        .iter()
        .filter_map(|m| node.find(m).map(|i| (i, *m)))
        .min_by_key(|(i, _)| *i)
    else {
        return node.to_string();
    };
    // Judged on what names the node — its role and title before the value,
    // its description and attributes after it — never on the value itself: a
    // document that mentions a password is not a password field, and a
    // field's secret is not what says it is one.
    let label = format!("{}{}", &node[..start], &node[after_value(node, start + marker.len())..]);
    let lower = label.to_lowercase();
    let role_is_secret = lower.contains("securetextfield") || lower.contains("password text");
    let label_is_secret = SECRET_WORDS.iter().any(|w| lower.contains(w));
    if !(role_is_secret || label_is_secret) {
        return node.to_string();
    }
    // Everything from the value on goes, not just the value: the driver writes
    // values unescaped, so a value can contain `" (` or `" [` or a newline and
    // there is no telling where it ends. What stays — the index, the role and
    // the title — is what names the field.
    let newline = if node.ends_with('\n') { "\n" } else { "" };
    format!(
        "{} = \"[redacted]\"{newline}",
        node[..start].trim_end_matches([' ', '['])
    )
}

/// Where the text after a node's value begins, as near as can be told: the
/// driver does not escape the quote that closes a value, so this is the
/// earliest quote on the node's last line (a value ends on the line its node
/// does) that is followed by what only comes after one. Earlier is the safe
/// side — more of the node is read as label.
fn after_value(node: &str, value_from: usize) -> usize {
    let body = node.trim_end_matches('\n');
    let last_line = body.rfind('\n').map_or(0, |i| i + 1);
    let from = last_line.max(value_from).min(body.len());
    let tail = &body[from..];
    AFTER_VALUE
        .iter()
        .filter_map(|m| tail.find(m))
        .chain(tail.ends_with('"').then(|| tail.len() - 1))
        .min()
        .map_or(body.len(), |i| from + i)
}

/// Rebuild the caller's predicates in the driver's vocabulary. Every field is
/// copied by name from the closed types in `computer::types`, so nothing the
/// agent wrote reaches the driver unexamined.
pub fn driver_predicates(expect: &[VerifyPredicate]) -> Result<Vec<Value>, HelperError> {
    if expect.is_empty() || expect.len() > MAX_VERIFY_PREDICATES {
        return Err(HelperError::new(
            HelperErrorCode::BadRequest,
            format!("verify takes 1 to {MAX_VERIFY_PREDICATES} predicates"),
        ));
    }
    expect
        .iter()
        .map(|p| {
            let mut out = Map::new();
            if let Some(window) = &p.window {
                let mut w = Map::new();
                if let Some(exists) = window.exists {
                    w.insert("exists".into(), json!(exists));
                }
                if let Some(b) = &window.bounds {
                    let mut bounds = json!({ "x": b.x, "y": b.y, "width": b.width, "height": b.height });
                    if let Some(t) = b.tolerance_px {
                        bounds["tolerance_px"] = json!(t.clamp(0.0, 100.0));
                    }
                    w.insert("bounds".into(), bounds);
                }
                out.insert("window".into(), Value::Object(w));
            }
            if let Some(element) = &p.element {
                if element.exists == Some(false) {
                    return Err(HelperError::new(
                        HelperErrorCode::BadRequest,
                        "an element's absence cannot be proven; check `exists: true` or leave it out",
                    ));
                }
                let mut selector = Map::new();
                if let Some(role) = element.selector.role.as_deref().filter(|s| !s.is_empty()) {
                    selector.insert("role".into(), json!(role));
                }
                if let Some(label) = element.selector.label_contains.as_deref().filter(|s| !s.is_empty()) {
                    selector.insert("label_contains".into(), json!(label));
                }
                let mut e = Map::new();
                e.insert("selector".into(), Value::Object(selector));
                for (key, value) in [
                    ("exists", element.exists),
                    ("enabled", element.enabled),
                    ("selected", element.selected),
                ] {
                    if let Some(v) = value {
                        e.insert(key.into(), json!(v));
                    }
                }
                out.insert("element".into(), Value::Object(e));
            }
            if out.is_empty() {
                return Err(HelperError::new(
                    HelperErrorCode::BadRequest,
                    "every predicate needs a `window` or an `element` part",
                ));
            }
            Ok(Value::Object(out))
        })
        .collect()
}

fn verify_status(value: Option<&Value>) -> VerifyStatus {
    match value.and_then(Value::as_str) {
        Some("satisfied") => VerifyStatus::Satisfied,
        Some("unsatisfied") => VerifyStatus::Unsatisfied,
        _ => VerifyStatus::Unknown,
    }
}

pub async fn verify(
    driver: &DriverProc,
    pid: u32,
    window_id: u64,
    request: &VerifyRequest,
) -> Result<RawVerify, HelperError> {
    let expect = driver_predicates(&request.expect)?;
    let timeout_ms = request
        .timeout_ms
        .unwrap_or(5_000)
        .min(MAX_VERIFY_TIMEOUT_MS);
    let mut args = json!({
        "pid": pid,
        "window_id": window_id,
        "expect": expect,
        "timeout_ms": timeout_ms,
        "include_screenshot": false,
    });
    if let Some(samples) = request.stable_samples {
        args["stable_samples"] = json!(samples.clamp(1, MAX_STABLE_SAMPLES));
    }
    let budget = Duration::from_millis(u64::from(timeout_ms)) + VERIFY_OVERHEAD;
    let result = call(driver, "verify_state", args, budget).await?;
    let meta = structured("verify_state", &result)?;
    Ok(parse_verify(meta))
}

/// The verdicts, without the observed values the driver reports beside them.
fn parse_verify(meta: &Value) -> RawVerify {
    RawVerify {
        status: verify_status(meta.get("status")),
        stable: meta.get("stable").and_then(Value::as_bool).unwrap_or(false),
        samples: meta.get("samples").and_then(Value::as_u64).unwrap_or(0),
        elapsed_ms: meta.get("elapsed_ms").and_then(Value::as_u64).unwrap_or(0),
        predicates: meta
            .get("predicates")
            .and_then(Value::as_array)
            .map(|items| {
                items
                    .iter()
                    .map(|p| PredicateResult {
                        index: p
                            .get("index")
                            .and_then(Value::as_u64)
                            .and_then(|v| u32::try_from(v).ok())
                            .unwrap_or(0),
                        status: verify_status(p.get("status")),
                        unknown_reason: string(p, "unknown_reason"),
                    })
                    .collect()
            })
            .unwrap_or_default(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::computer::types::{ElementPredicate, ElementSelector, WindowPredicate};

    /// The driver's two refusal shapes both map by code, and a code the helper
    /// does not know keeps the driver's own words.
    #[test]
    fn refusals_are_read_by_their_code() {
        let refused = |structured: Value, text: &str| ToolCallResult {
            is_error: true,
            content: vec![json!({"type": "text", "text": text})],
            structured: Some(structured),
        };
        let e = tool_error(
            "get_window_state",
            &refused(json!({"code": "window_id_not_found"}), "gone"),
        );
        assert_eq!(e.code, HelperErrorCode::NoSuchWindow);
        let e = tool_error(
            "get_window_state",
            &refused(
                json!({"status": "refused", "refusal": {"code": "screen_recording_permission_denied"}}),
                "",
            ),
        );
        assert_eq!(e.permission, Some(OsPermission::ScreenRecording));
        let e = tool_error(
            "list_windows",
            &refused(json!({"code": "tool_invocation_failed"}), "boom"),
        );
        assert_eq!(e.code, HelperErrorCode::Failed);
        assert_eq!(e.message, "boom");
    }

    /// Only running, pid-bearing applications are kept.
    #[test]
    fn installed_but_not_running_apps_are_dropped() {
        let apps = parse_apps(&json!({"apps": [
            {"pid": 758, "name": "Finder", "bundle_id": "com.apple.finder", "running": true, "active": false},
            {"pid": 0, "name": "Xcode", "bundle_id": "com.apple.dt.Xcode", "running": false, "active": false,
             "launch_path": "/Applications/Xcode.app"},
        ]}))
        .unwrap();
        assert_eq!(apps.len(), 1);
        assert_eq!(apps[0].bundle_id.as_deref(), Some("com.apple.finder"));
        assert_eq!(apps[0].path, None);
    }

    /// Menus, overlays and zero-sized windows are not anyone's window; an
    /// invisible one still is, and comes back with what the driver said
    /// about where it is.
    #[test]
    fn every_normal_window_with_an_area_is_listed() {
        let windows = parse_windows(&json!({"windows": [
            {"window_id": 1, "pid": 5, "app_name": "A", "title": "",
             "bounds": {"x": 0, "y": 0, "width": 100, "height": 100}, "is_on_screen": true, "layer": 0, "z_index": 2},
            {"window_id": 2, "pid": 5, "app_name": "A", "title": "menu",
             "bounds": {"x": 0, "y": 0, "width": 100, "height": 20}, "is_on_screen": true, "layer": 24},
            {"window_id": 3, "pid": 5, "app_name": "A", "title": "",
             "bounds": {"x": 0, "y": 0, "width": 0, "height": 0}, "is_on_screen": true, "layer": 0},
            {"window_id": 4, "pid": 6, "app_name": "B", "title": "",
             "bounds": {"x": 0, "y": 0, "width": 800, "height": 600}, "is_on_screen": false,
             "on_current_space": true, "minimized": false, "layer": 0},
        ]}))
        .unwrap();
        let ids: Vec<u64> = windows.iter().map(|w| w.window_id).collect();
        assert_eq!(ids, vec![1, 4]);
        assert_eq!(windows[0].z_index, Some(2));
        assert_eq!(windows[0].app.name, "A");
        assert_eq!(windows[1].on_current_space, Some(true));
        assert_eq!(windows[1].minimized, Some(false));
    }

    /// A secret's value goes; its role and label, and every other line, stay.
    #[test]
    fn secret_values_are_redacted_and_nothing_else_is() {
        let tree = "- [0] AXWindow \"Sign in\"\n  - [1] AXTextField \"Email\" = \"me@example.com\" [actions=[confirm]]\n  - [2] AXTextField \"Password\" = \"hunter2\" [id=pw actions=[confirm]]\n  - [3] AXTextField = \"秘密\" (密码)\n  - [4] AXSecureTextField = \"abc\" (x)\" (Code) [id=q]\n  - [5] AXStaticText = \"Forgot your password?\"\n";
        let out = redact_tree(tree, Dialect::Mac);
        assert!(
            out.contains("\"Email\" = \"me@example.com\" [actions=[confirm]]"),
            "{out}"
        );
        assert!(
            out.contains("- [2] AXTextField \"Password\" = \"[redacted]\"\n"),
            "{out}"
        );
        // A label after the value counts too.
        assert!(out.contains("- [3] AXTextField = \"[redacted]\"\n"), "{out}");
        // A value with a quote in it is cut at its start, not guessed at.
        assert!(
            out.contains("- [4] AXSecureTextField = \"[redacted]\"\n"),
            "{out}"
        );
        assert!(
            !out.contains("hunter2") && !out.contains("秘密") && !out.contains("(x)"),
            "{out}"
        );
        // Text that merely mentions the word is not a secret field.
        assert!(
            out.contains("AXStaticText = \"Forgot your password?\""),
            "{out}"
        );
        assert_eq!(out.lines().count(), tree.lines().count());
        assert!(out.starts_with("- [0] AXWindow \"Sign in\"\n"));
    }

    /// Values are written unescaped, so a secret can run over several lines;
    /// all of them go. A long value that is not a secret — a document that
    /// mentions a password in passing, even on its last line — keeps every
    /// line; a label that names a secret on a line of its own still counts.
    #[test]
    fn a_secret_that_spans_lines_goes_whole() {
        let tree = "- [0] AXWindow \"Keys\"\n  - [1] AXTextArea \"Secret key\" = \"-----BEGIN KEY-----\nMIIEabc\n- not a node\n-----END KEY-----\" [id=k]\n  - [2] AXTextArea = \"line one\nthe password is elsewhere\nline three\"\n  - [3] AXButton \"Copy\"\n";
        let out = redact_tree(tree, Dialect::Mac);
        assert!(
            out.contains("  - [1] AXTextArea \"Secret key\" = \"[redacted]\"\n  - [2]"),
            "{out}"
        );
        for leaked in ["MIIEabc", "not a node", "END KEY"] {
            assert!(!out.contains(leaked), "{leaked}: {out}");
        }
        assert!(
            out.contains("\"line one\nthe password is elsewhere\nline three\"\n"),
            "{out}"
        );
        assert!(out.ends_with("  - [3] AXButton \"Copy\"\n"), "{out}");

        let tree = "- [0] AXTextArea = \"notes\nremember: the password is in the vault\"\n- [1] AXTextField \"Enter your\npassword\nhere\" = \"hunter2\" [id=pw]\n- [2] AXTextField = \"s3cr3t\" (Account password) [help=\"x\" actions=[confirm]]\n";
        let out = redact_tree(tree, Dialect::Mac);
        assert!(out.contains("remember: the password is in the vault\"\n"), "{out}");
        assert!(
            out.contains("- [1] AXTextField \"Enter your\npassword\nhere\" = \"[redacted]\"\n"),
            "{out}"
        );
        assert!(out.ends_with("- [2] AXTextField = \"[redacted]\"\n"), "{out}");
        assert!(!out.contains("hunter2") && !out.contains("s3cr3t"), "{out}");
    }

    /// Windows and Linux trees put an addressable element's value in
    /// `value="…"`, not after ` = `; it goes all the same.
    #[test]
    fn values_are_found_in_every_platforms_tree() {
        let windows = "- [0] Window \"Sign in\"\n  - [1] Edit \"Password\" [value=\"hunter2\" id=pw actions=[invoke]]\n  - [2] Edit \"User\" [value=\"me\"]\n  - Text \"PIN code\" = \"1234\"\n  - [3] Edit [value=\"one\n- Recovery code: 5678\n  - Button two\" help=\"Enter the password\"]\n  - [4] Button \"OK\"\n";
        let out = redact_tree(windows, Dialect::Windows);
        assert!(out.contains("  - [1] Edit \"Password\" = \"[redacted]\"\n"), "{out}");
        assert!(out.contains("  - [2] Edit \"User\" [value=\"me\"]\n"), "{out}");
        assert!(out.contains("  - Text \"PIN code\" = \"[redacted]\"\n"), "{out}");
        // A line of the value that looks like a list item is not a node.
        assert!(out.contains("  - [3] Edit = \"[redacted]\"\n  - [4] Button"), "{out}");
        for leaked in ["hunter2", "1234", "5678", "Button two"] {
            assert!(!out.contains(leaked), "{leaked}: {out}");
        }

        let linux = "- [0] frame \"Login\" [actions=[]]\n  - [1] password text \"\" value=\"s3cr3t\nmore\" [actions=[activate]]\n  - [2] push button \"OK\" [actions=[click]]\n";
        let out = redact_tree(linux, Dialect::Linux);
        assert!(
            out.contains("  - [1] password text \"\" = \"[redacted]\"\n  - [2] push button"),
            "{out}"
        );
        assert!(!out.contains("s3cr3t") && !out.contains("more"), "{out}");
    }

    /// What starts a node, per platform.
    #[test]
    fn node_lines_are_told_from_continuations() {
        assert!(Dialect::Mac.starts_node("  - [12] AXButton \"OK\"\n"));
        assert!(Dialect::Mac.starts_node("- AXGroup\n"));
        assert!(!Dialect::Mac.starts_node("- item\n"));
        assert!(!Dialect::Mac.starts_node("- AX\n"));
        assert!(!Dialect::Mac.starts_node("   - [1] AXButton\n"));
        assert!(!Dialect::Mac.starts_node("  - [x] AXButton\n"));
        assert!(Dialect::Windows.starts_node("  - [3] Edit \"a\"\n"));
        assert!(Dialect::Windows.starts_node("- Pane\n"));
        assert!(!Dialect::Windows.starts_node("  - edit\n"));
        assert!(!Dialect::Windows.starts_node("- Recovery code: 1234\n"));
        assert!(!Dialect::Windows.starts_node("- Editor notes\n"));
        assert!(!Dialect::Windows.starts_node("  - Button two\n"));
        assert!(Dialect::Windows.starts_node("  - [5] Button [actions=[invoke]]\n"));
        assert!(!Dialect::Mac.starts_node("- AXE is great\n"));
        assert!(Dialect::Linux.starts_node("  - [3] push button \"a\" [actions=[click]]\n"));
        assert!(Dialect::Linux.starts_node("  - label = \"Name\"\n"));
        assert!(!Dialect::Linux.starts_node("- recovery code: 1234\n"));
        assert!(!Dialect::Linux.starts_node("  - [3] push button\n"));
        assert!(!Dialect::Linux.starts_node("MIIEabc\n"));
    }

    /// An answer without the array it exists to carry is an error, not an
    /// empty list.
    #[test]
    fn a_listing_without_its_list_is_malformed() {
        assert!(parse_apps(&json!({})).is_err());
        assert!(parse_windows(&json!({"windows": null})).is_err());
        assert!(parse_windows(&json!({"windows": []})).unwrap().is_empty());
    }

    /// Predicates are rebuilt field by field in the driver's spelling, and the
    /// shapes the driver cannot answer are refused here in words.
    #[test]
    fn predicates_are_rebuilt_not_forwarded() {
        let expect = vec![
            VerifyPredicate {
                window: Some(WindowPredicate {
                    exists: Some(true),
                    bounds: None,
                }),
                element: None,
            },
            VerifyPredicate {
                window: None,
                element: Some(ElementPredicate {
                    selector: ElementSelector {
                        role: Some("AXButton".into()),
                        label_contains: Some("Save".into()),
                    },
                    exists: Some(true),
                    enabled: Some(true),
                    selected: None,
                }),
            },
        ];
        let out = driver_predicates(&expect).unwrap();
        assert_eq!(out[0], json!({"window": {"exists": true}}));
        assert_eq!(
            out[1],
            json!({"element": {"selector": {"role": "AXButton", "label_contains": "Save"},
                               "exists": true, "enabled": true}})
        );

        assert!(driver_predicates(&[]).is_err());
        assert!(driver_predicates(&[VerifyPredicate::default()]).is_err());
        let absent = VerifyPredicate {
            element: Some(ElementPredicate {
                exists: Some(false),
                ..ElementPredicate::default()
            }),
            ..VerifyPredicate::default()
        };
        assert!(driver_predicates(&[absent]).is_err());
        assert!(driver_predicates(&vec![expect[0].clone(); MAX_VERIFY_PREDICATES + 1]).is_err());
    }

    /// The verdict keeps statuses and reasons and drops what was observed.
    #[test]
    fn a_verdict_carries_no_observed_values() {
        let raw = parse_verify(&json!({
            "status": "unsatisfied", "stable": false, "samples": 3, "elapsed_ms": 812,
            "predicates": [
                {"index": 0, "status": "unsatisfied", "unknown_reason": null,
                 "observed_json": "{\"value\":\"hunter2\"}"},
                {"index": 1, "status": "unknown", "unknown_reason": "target_missing", "observed_json": null}
            ]
        }));
        assert_eq!(raw.status, VerifyStatus::Unsatisfied);
        assert_eq!(
            raw.predicates[1].unknown_reason.as_deref(),
            Some("target_missing")
        );
        let wire = serde_json::to_string(&raw).unwrap();
        assert!(!wire.contains("hunter2"));
    }
}
