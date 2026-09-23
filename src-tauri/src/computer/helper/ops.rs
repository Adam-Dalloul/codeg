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
    Ok(parse_apps(structured("list_apps", &result)?))
}

fn parse_apps(value: &Value) -> Vec<RawApp> {
    value
        .get("apps")
        .and_then(Value::as_array)
        .map(|apps| {
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
        .unwrap_or_default()
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
    let windows = parse_windows(structured("list_windows", &result)?);

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
fn parse_windows(value: &Value) -> Vec<RawWindow> {
    let flag = |w: &Value, key: &str| w.get(key).and_then(Value::as_bool);
    value
        .get("windows")
        .and_then(Value::as_array)
        .map(|windows| {
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
        .unwrap_or_default()
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
        .unwrap_or_default();
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

/// Take the value out of every tree line that describes a secret.
///
/// The platforms already refuse to hand a secure field's text to an
/// accessibility client — macOS answers bullets for a secure text field,
/// Windows refuses a password edit's value to other processes — so this is
/// the second line, not the first: a line whose role names a password
/// control, or whose label says it is one, keeps its role and label and loses
/// its `= "value"`. The driver's tree does not carry macOS subroles, so a
/// secure field is recognised here by its words; recognising it by subrole
/// needs the driver to report one.
pub fn redact_secrets(tree: &str) -> String {
    let mut out = String::with_capacity(tree.len());
    for line in tree.split_inclusive('\n') {
        out.push_str(&redact_line(line));
    }
    out
}

fn redact_line(line: &str) -> String {
    let Some(start) = line.find(" = \"") else {
        return line.to_string();
    };
    let lower = line.to_lowercase();
    let role_is_secret = lower.contains("securetextfield") || lower.contains("password text");
    let label_is_secret = SECRET_WORDS.iter().any(|w| lower.contains(w));
    if !(role_is_secret || label_is_secret) {
        return line.to_string();
    }
    // Everything after the ` = "` goes, not just the value: the driver writes
    // values unescaped, so a value can contain `" (` or `" [` and there is no
    // telling where it ends. What stays — the index, the role and the title —
    // is what names the field.
    let newline = if line.ends_with('\n') { "\n" } else { "" };
    format!("{} = \"[redacted]\"{newline}", &line[..start])
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
        ]}));
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
        ]}));
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
        let tree = "- [0] AXWindow \"Sign in\"\n  - [1] AXTextField \"Email\" = \"me@example.com\" [actions=[confirm]]\n  - [2] AXTextField \"Password\" = \"hunter2\" [id=pw actions=[confirm]]\n  - [3] AXTextField (密码) = \"秘密\"\n  - [4] password text = \"abc\" (x)\" (Passcode) [id=q]\n  - [5] AXStaticText = \"Forgot your password?\"\n";
        let out = redact_secrets(tree);
        assert!(
            out.contains("\"Email\" = \"me@example.com\" [actions=[confirm]]"),
            "{out}"
        );
        assert!(
            out.contains("- [2] AXTextField \"Password\" = \"[redacted]\"\n"),
            "{out}"
        );
        assert!(
            out.contains("- [3] AXTextField (密码) = \"[redacted]\"\n"),
            "{out}"
        );
        // A value with a quote in it is cut at its start, not guessed at.
        assert!(
            out.contains("- [4] password text = \"[redacted]\"\n"),
            "{out}"
        );
        assert!(
            !out.contains("hunter2") && !out.contains("秘密") && !out.contains("(x)"),
            "{out}"
        );
        // A line that merely mentions the word loses its value too — the cost
        // of reading words rather than roles, paid in the safe direction.
        assert!(out.contains("AXStaticText = \"[redacted]\""), "{out}");
        assert_eq!(out.lines().count(), tree.lines().count());
        assert!(out.starts_with("- [0] AXWindow \"Sign in\"\n"));
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
