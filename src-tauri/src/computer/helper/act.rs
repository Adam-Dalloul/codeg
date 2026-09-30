//! The ops that change a window, as fixed driver calls.
//!
//! Every action codeg sends is a closed [`WindowAction`]; this module builds
//! the driver's arguments from its fields — the tool (`click`,
//! `double_click`, `right_click`, `scroll`, `type_text`, `press_key`,
//! `set_value`), the window, the element or the point, always
//! `delivery_mode: "background"` — and nothing else. What the driver would
//! also accept (a desktop scope, a foreground delivery, a file to write a
//! debug image to, a zoom's coordinates) is never asked for.
//!
//! One action is the helper's own: putting a minimized window back on the
//! screen ([`WindowAction::Restore`]), which the driver has no call for. It
//! goes through Accessibility, to that one window of that one process, and
//! brings nothing to the front (see [`super::axwin`]); the driver is only
//! asked afterwards whether the window is on the screen again.
//!
//! Before a call goes out, what only the helper knows is checked:
//!
//! * **The element.** The driver keeps the latest snapshot of each window and
//!   addresses elements by its id; so does the helper ([`SnapshotBook`]),
//!   with what the tree said of each element. A ref from any other snapshot
//!   is stale, and text never goes into an element the tree judged secret
//!   (see [`super::tree`]).
//! * **The point.** A point is in the window's own pixels, read off a
//!   full-size capture of it at a certain size. The window is measured again
//!   now; at another size its contents are laid out elsewhere, and the point
//!   would land on something the agent never saw.
//!
//! The rest of "is this input still going where it was meant to" is the
//! driver's own background gate on macOS, which re-reads the window's owner,
//! the element's window and the application's other windows at the moment of
//! delivery, and refuses by code; each code comes back to codeg as one of the
//! helper's, in words written here rather than the driver's.

use std::collections::{HashMap, VecDeque};
use std::time::Duration;

use serde_json::{json, Value};

use super::driver_proc::DriverProc;
use super::mcp::ToolCallResult;
use super::Delivery;
use crate::computer::keys::Platform;
use crate::computer::protocol::{
    DriverTarget, ElementRef, HelperError, HelperErrorCode, OsPermission, RawAct, WindowAction,
    WindowPoint,
};
use crate::computer::types::{
    ActEffect, ActRoute, PointerButton, Rect, ScrollDirection, ScrollUnit,
};

/// Everything but typing: one click, one key, one value.
const ACT_TIMEOUT: Duration = Duration::from_secs(30);
/// Typing: the driver budgets up to 100 s of synthesized keystrokes for one
/// call and refuses more before sending any.
const TYPE_TIMEOUT: Duration = Duration::from_secs(130);
/// Measuring a window before a point is clicked in it.
const MEASURE_TIMEOUT: Duration = Duration::from_secs(15);
/// How long a restored window has to be seen on the screen again: the Dock's
/// animation, and an application slow to draw.
#[cfg(target_os = "macos")]
const RESTORE_WAIT: Duration = Duration::from_secs(3);
#[cfg(target_os = "macos")]
const RESTORE_POLL: Duration = Duration::from_millis(100);

/// How many windows' latest snapshots the helper remembers. The driver keeps
/// eight per process; this bounds the helper's memory, not the driver's.
const BOOK_WINDOWS: usize = 64;

/// What the tree said of one element that can be acted on.
#[derive(Debug, Clone, PartialEq)]
pub struct ElementFacts {
    pub role: String,
    pub secret: bool,
    /// Where the element was on the screen when the snapshot was taken, in
    /// the platform's desktop units — for the marker, not for aiming (the
    /// driver aims by the element itself).
    pub frame: Option<Rect>,
}

/// The latest snapshot of one window: the driver's id for it, and its
/// elements.
#[derive(Debug, Clone, PartialEq)]
pub struct SnapshotFacts {
    pub snapshot_id: String,
    pub elements: HashMap<u32, ElementFacts>,
}

/// The latest snapshot the helper took of each window, as the driver keeps
/// them: a new snapshot of a window replaces the one before.
#[derive(Default)]
pub struct SnapshotBook {
    windows: HashMap<(u32, u64), SnapshotFacts>,
    /// Oldest first, for letting go once there are too many.
    order: VecDeque<(u32, u64)>,
}

impl SnapshotBook {
    /// Remember a snapshot just taken of `(pid, window_id)` — or, with
    /// `None`, that the driver kept none, so nothing from before is current.
    pub fn record(&mut self, pid: u32, window_id: u64, facts: Option<SnapshotFacts>) {
        let key = (pid, window_id);
        // The driver mints ids from one counter: an answer that arrives after
        // a later snapshot's was recorded is not the current one.
        if let (Some(new), Some(held)) = (
            facts.as_ref().and_then(|f| snapshot_number(&f.snapshot_id)),
            self.windows
                .get(&key)
                .and_then(|f| snapshot_number(&f.snapshot_id)),
        ) {
            if new < held {
                return;
            }
        }
        self.order.retain(|k| *k != key);
        match facts {
            Some(facts) => {
                self.windows.insert(key, facts);
                self.order.push_back(key);
                while self.order.len() > BOOK_WINDOWS {
                    if let Some(oldest) = self.order.pop_front() {
                        self.windows.remove(&oldest);
                    }
                }
            }
            None => {
                self.windows.remove(&key);
            }
        }
    }

    /// Forget everything — the driver that took these snapshots is gone.
    pub fn clear(&mut self) {
        self.windows.clear();
        self.order.clear();
    }

    /// Where `element` was on the screen when its snapshot was taken, if that
    /// is still the window's latest snapshot and it said.
    pub fn frame(&self, pid: u32, window_id: u64, element: &ElementRef) -> Option<Rect> {
        self.windows
            .get(&(pid, window_id))
            .filter(|f| f.snapshot_id == element.snapshot_id)?
            .elements
            .get(&element.index)?
            .frame
    }

    /// Check `action`'s element against the latest snapshot of the window:
    /// it is from that snapshot, the snapshot has such an element, and the
    /// element may take what the action does to it.
    pub fn check(
        &self,
        pid: u32,
        window_id: u64,
        action: &WindowAction,
        app_key: Option<&str>,
    ) -> Result<(), HelperError> {
        let Some(element) = action.element() else {
            return Ok(());
        };
        let stale = || {
            HelperError::new(
                HelperErrorCode::StaleRef,
                "That ref is from a snapshot this window has moved past. Take a new \
                 computer_snapshot and use a ref from it.",
            )
        };
        let facts = self
            .windows
            .get(&(pid, window_id))
            .filter(|f| f.snapshot_id == element.snapshot_id)
            .ok_or_else(stale)?;
        let found = facts.elements.get(&element.index).ok_or_else(stale)?;
        if found.secret && action.writes_text() {
            return Err(HelperError::new(
                HelperErrorCode::SecretField,
                "That is a password or other secret field: typing into it, or setting it, is \
                 left to the user. Ask them to fill it in themselves.",
            ));
        }
        // Safari's pop-up menus with no accessible options are set by the
        // driver through AppleScript against Safari's *front* document — any
        // window of it, not necessarily this one — and in the helper's name.
        // With no key to tell the application by, it could be Safari.
        if matches!(action, WindowAction::SetValue { .. })
            && found.role == "AXPopUpButton"
            && app_key.is_none_or(is_safari)
        {
            return Err(HelperError::new(
                HelperErrorCode::ActionFailed,
                "Choosing from a pop-up menu in Safari cannot be done by setting its value. \
                 Click the menu to open it, then click the option.",
            ));
        }
        Ok(())
    }
}

/// The number in a driver snapshot id (`s` and eight hex digits).
fn snapshot_number(id: &str) -> Option<u64> {
    u64::from_str_radix(id.strip_prefix('s')?, 16).ok()
}

fn is_safari(app_key: &str) -> bool {
    let key = app_key.to_ascii_lowercase();
    key.starts_with("com.apple.safari") || key.ends_with("/safari.app")
}

/// Check that a point is still where it was read: the window is the size it
/// was when the capture the point came from was taken. Returns where the
/// window is now, when the driver said — for the marker, not for aiming.
pub async fn check_point(
    driver: &DriverProc,
    pid: u32,
    window_id: u64,
    point: &WindowPoint,
) -> Result<Option<Rect>, HelperError> {
    if !driver.full_size_captures() {
        return Err(HelperError::new(
            HelperErrorCode::ActionFailed,
            "Pointing by coordinates is not available right now. Use a ref from \
             computer_snapshot instead.",
        ));
    }
    let window = listed(driver, pid, window_id).await?;
    let bounds = window
        .get("bounds")
        .ok_or_else(|| HelperError::new(HelperErrorCode::NoSuchWindow, "the window is gone"))?;
    let number = |key: &str| bounds.get(key).and_then(Value::as_f64);
    let (width, height) = (
        number("width").unwrap_or(0.0),
        number("height").unwrap_or(0.0),
    );
    if (width - point.window_width).abs() > 1.0 || (height - point.window_height).abs() > 1.0 {
        return Err(HelperError::new(
            HelperErrorCode::StaleRef,
            "The window has changed size since that screenshot, so its contents are not where \
             they were. Take a new computer_screenshot and use a point from it.",
        ));
    }
    // Where the window is, for the marker: only when the driver said.
    Ok(match (number("x"), number("y")) {
        (Some(x), Some(y)) => Some(Rect {
            x,
            y,
            width,
            height,
        }),
        _ => None,
    })
}

/// The driver's listing of one window now, as it gave it.
async fn listed(driver: &DriverProc, pid: u32, window_id: u64) -> Result<Value, HelperError> {
    let result = driver
        .call(
            "list_windows",
            json!({ "pid": pid, "on_screen_only": false }),
            MEASURE_TIMEOUT,
        )
        .await?;
    if result.is_error {
        return Err(super::ops::tool_error("list_windows", &result));
    }
    result
        .structured
        .as_ref()
        .and_then(|s| s.get("windows"))
        .and_then(Value::as_array)
        .and_then(|windows| {
            windows
                .iter()
                .find(|w| w.get("window_id").and_then(Value::as_u64) == Some(window_id))
        })
        .cloned()
        .ok_or_else(|| HelperError::new(HelperErrorCode::NoSuchWindow, "the window is gone"))
}

/// Put the window back on the screen if it is minimized, then watch for it
/// there: confirmed once the driver lists it on screen, unverifiable if it
/// has not by the time [`RESTORE_WAIT`] has passed (a look already asked is
/// answered first, however long the driver takes). A window that is not
/// minimized is already as the action would leave it. Nothing is brought to
/// the front. `deliverable` is asked again on the thread that makes the
/// change, just before it: reading the application's windows first can take
/// long enough for the person to press Stop.
#[cfg(target_os = "macos")]
async fn restore(
    driver: &DriverProc,
    pid: u32,
    window_id: u64,
    deliverable: &Delivery,
) -> Result<RawAct, HelperError> {
    use super::axwin::Restore;
    let effect = |effect| RawAct {
        effect,
        route: None,
        submitted: None,
        element_frame: None,
        window_frame: None,
    };
    let ready = deliverable.clone();
    match super::axwin::restore(pid, window_id, move || ready.check()).await? {
        Restore::Asked => {}
        Restore::NotMinimized => return Ok(effect(ActEffect::Confirmed)),
        Restore::AppHidden => {
            return Err(HelperError::new(
                HelperErrorCode::Occluded,
                "Its application is hidden, so the window would not show even restored. Ask the \
                 user to show the application.",
            ))
        }
        Restore::Unlisted => {
            return Err(HelperError::new(
                HelperErrorCode::Occluded,
                "The window cannot be reached to restore it: it may be on another desktop \
                 (Space). Ask the user to bring it back.",
            ))
        }
        Restore::Failed(code) => {
            return Err(HelperError::new(
                HelperErrorCode::ActionFailed,
                format!(
                    "The window's application did not restore it (Accessibility error {code}). \
                     Ask the user to restore it."
                ),
            ))
        }
    }
    let deadline = tokio::time::Instant::now() + RESTORE_WAIT;
    loop {
        let window = listed(driver, pid, window_id).await?;
        if window.get("is_on_screen").and_then(Value::as_bool) == Some(true) {
            return Ok(effect(ActEffect::Confirmed));
        }
        if tokio::time::Instant::now() >= deadline {
            return Ok(effect(ActEffect::Unverifiable));
        }
        tokio::time::sleep(RESTORE_POLL).await;
    }
}

/// Not done elsewhere yet: the drivers have no call for it, and nothing here
/// stands in for one.
#[cfg(not(target_os = "macos"))]
async fn restore(
    _driver: &DriverProc,
    _pid: u32,
    _window_id: u64,
    _deliverable: &Delivery,
) -> Result<RawAct, HelperError> {
    Err(HelperError::new(
        HelperErrorCode::ActionFailed,
        "Restoring a minimized window is not available on this platform. Ask the user to \
         restore it.",
    ))
}

/// The permissions an action needs of the OS: every action reaches the
/// window through Accessibility, and a point is placed by capturing the
/// window again to measure it.
pub fn permissions_for(action: &WindowAction) -> &'static [OsPermission] {
    if action.point().is_some() {
        &[OsPermission::Accessibility, OsPermission::ScreenRecording]
    } else {
        &[OsPermission::Accessibility]
    }
}

/// Carry out `action` on the window: one driver call, or two for typing that
/// ends with return. `deliverable` is asked just before each call goes out —
/// whatever must still hold at the moment of delivery (nothing stopped, the
/// same process, an unlocked session) — and a call it refuses is not made.
pub async fn act(
    driver: &DriverProc,
    pid: u32,
    window_id: u64,
    action: &WindowAction,
    deliverable: &Delivery,
) -> Result<RawAct, HelperError> {
    let platform = Platform::current();
    let mut args = json!({
        "pid": pid,
        "window_id": window_id,
        "delivery_mode": "background",
    });
    match action {
        WindowAction::Click { at, button, count } => {
            let tool = match (button, count) {
                (PointerButton::Left, 1) | (PointerButton::Middle, 1) => "click",
                (PointerButton::Left, 2) => "double_click",
                (PointerButton::Right, 1) => "right_click",
                _ => {
                    return Err(HelperError::new(
                        HelperErrorCode::BadRequest,
                        "a click is one or two presses of the left button, or one of another",
                    ))
                }
            };
            if *button == PointerButton::Middle {
                args["button"] = json!("middle");
            }
            put_target(&mut args, at);
            deliverable.check()?;
            one(driver, tool, args, ACT_TIMEOUT).await
        }
        WindowAction::Scroll {
            at,
            direction,
            amount,
            unit,
        } => {
            args["direction"] = json!(match direction {
                ScrollDirection::Up => "up",
                ScrollDirection::Down => "down",
                ScrollDirection::Left => "left",
                ScrollDirection::Right => "right",
            });
            args["amount"] = json!((*amount).clamp(1, crate::computer::types::MAX_SCROLL_AMOUNT));
            args["by"] = json!(match unit {
                ScrollUnit::Line => "line",
                ScrollUnit::Page => "page",
            });
            if let Some(at) = at {
                put_target(&mut args, at);
            }
            deliverable.check()?;
            one(driver, "scroll", args, ACT_TIMEOUT).await
        }
        WindowAction::Type {
            element,
            text,
            submit,
        } => {
            put_element(&mut args, element);
            let mut key = args.clone();
            args["text"] = json!(text);
            deliverable.check()?;
            let typed = one(driver, "type_text", args, TYPE_TIMEOUT).await?;
            if !*submit {
                return Ok(typed);
            }
            key["key"] = json!("return");
            // Typing can take a while: the second call is held to the same
            // conditions as the first, at its own moment.
            let pressed = match deliverable.check() {
                Ok(()) => one(driver, "press_key", key, ACT_TIMEOUT).await,
                Err(e) => Err(e),
            };
            Ok(match pressed {
                // Both went out: the whole is as sure as its less sure half.
                Ok(pressed) => RawAct {
                    effect: weaker(typed.effect, pressed.effect),
                    submitted: Some(true),
                    ..typed
                },
                // The text went in; return did not. Said as such.
                Err(_) => RawAct {
                    submitted: Some(false),
                    ..typed
                },
            })
        }
        WindowAction::Key { element, chord } => {
            args["key"] = json!(chord.key.driver_name(platform));
            let modifiers = chord.modifiers.driver_names(platform);
            if !modifiers.is_empty() {
                args["modifiers"] = json!(modifiers);
            }
            if let Some(element) = element {
                put_element(&mut args, element);
            }
            deliverable.check()?;
            one(driver, "press_key", args, ACT_TIMEOUT).await
        }
        WindowAction::SetValue { element, value } => {
            put_element(&mut args, element);
            args["value"] = json!(value);
            deliverable.check()?;
            one(driver, "set_value", args, ACT_TIMEOUT).await
        }
        WindowAction::Restore => {
            deliverable.check()?;
            restore(driver, pid, window_id, deliverable).await
        }
    }
}

/// The less certain of two effects: confirmed, then unverifiable, then
/// partial, then suspected no-op.
fn weaker(a: ActEffect, b: ActEffect) -> ActEffect {
    let rank = |e: ActEffect| match e {
        ActEffect::Confirmed => 3,
        ActEffect::Unverifiable => 2,
        ActEffect::Partial => 1,
        ActEffect::SuspectedNoop => 0,
    };
    if rank(a) <= rank(b) {
        a
    } else {
        b
    }
}

fn put_element(args: &mut Value, element: &ElementRef) {
    args["snapshot_id"] = json!(element.snapshot_id);
    args["element_index"] = json!(element.index);
}

fn put_target(args: &mut Value, at: &DriverTarget) {
    match at {
        DriverTarget::Element(element) => put_element(args, element),
        DriverTarget::Point(point) => {
            args["x"] = json!(point.x);
            args["y"] = json!(point.y);
        }
    }
}

/// One driver call, and what it did.
async fn one(
    driver: &DriverProc,
    tool: &str,
    args: Value,
    timeout: Duration,
) -> Result<RawAct, HelperError> {
    let result = driver.call(tool, args, timeout).await?;
    if result.is_error {
        return Err(act_error(tool, &result));
    }
    action_result(tool, &result)
}

/// Read the driver's closed action result: how far it can vouch for the
/// action, and the route it took.
fn action_result(tool: &str, result: &ToolCallResult) -> Result<RawAct, HelperError> {
    let structured = result.structured.as_ref();
    let effect = structured
        .and_then(|s| s.get("effect"))
        .and_then(Value::as_str);
    let effect = match effect {
        Some("confirmed") => ActEffect::Confirmed,
        Some("partial") => ActEffect::Partial,
        Some("suspected_noop") => ActEffect::SuspectedNoop,
        Some("refused") => {
            return Err(HelperError::new(
                HelperErrorCode::ActionFailed,
                format!("The application refused the {tool}."),
            ))
        }
        // Delivered, and nothing said what came of it.
        _ => ActEffect::Unverifiable,
    };
    let route = structured
        .and_then(|s| s.get("route"))
        .cloned()
        .and_then(|r| serde_json::from_value::<ActRoute>(r).ok());
    Ok(RawAct {
        effect,
        route,
        submitted: None,
        element_frame: None,
        window_frame: None,
    })
}

/// The window class Chromium gives its windows on Windows
/// (`Chrome_WidgetWin_1`), as the driver names a refused target's.
const CHROMIUM_WINDOW_CLASS: &str = "Chrome_WidgetWin_";

/// What the agent is told when the driver would not send the input in the
/// background. A key or text is refused for the application as a whole —
/// aimed at an element by ref as much as at the window, and every time — so
/// the words say what still reaches it, rather than suggest a ref. On Windows
/// the commonest such application is one built on Chromium, which drops every
/// key that does not come from the front; the driver names it by its window
/// class.
fn background_refusal(tool: &str, result: &ToolCallResult) -> String {
    if !matches!(tool, "press_key" | "type_text") {
        return "This application does not take that kind of input in the background, and codeg \
                does not bring windows to the front. Try an element by ref, or computer_set_value."
            .to_string();
    }
    let mut words = "This application takes no key presses or typing while it is in the \
                     background, and codeg does not bring windows to the front, so nothing was \
                     sent — and trying again, by ref or not, will not change that. Fill a field \
                     with computer_set_value instead, and click by ref what the key would have \
                     done (a search or submit button, in place of return), or ask the user to \
                     press it."
        .to_string();
    let chromium = result
        .structured
        .as_ref()
        .and_then(|s| s.get("target_class"))
        .and_then(Value::as_str)
        .is_some_and(|class| class.starts_with(CHROMIUM_WINDOW_CLASS));
    if chromium {
        words.push_str(
            " On Windows no application built on Chromium takes keys in the background: Edge, \
             Chrome, VS Code and other Electron apps. For a web page, codeg's own browser (the \
             browser_* tools) does.",
        );
    }
    words
}

/// A refused action, by the driver's code, in words for the agent. Only where
/// the driver's own text is the useful part (an action that was tried and
/// failed) is it passed on, shortened.
fn act_error(tool: &str, result: &ToolCallResult) -> HelperError {
    let code = result.code().unwrap_or("");
    let error = |code: HelperErrorCode, words: &str| HelperError::new(code, words);
    match code {
        "stale_element_token"
        | "invalid_element_token"
        | "generation_mismatch"
        | "invalid_snapshot_id"
        | "snapshot_id_required"
        | "element_index_required"
        | "conflicting_element_target" => error(
            HelperErrorCode::StaleRef,
            "That ref is from a snapshot this window has moved past. Take a new \
             computer_snapshot and use a ref from it.",
        ),
        "px_frame_mismatch" => error(
            HelperErrorCode::StaleRef,
            "The window changed while the point was being placed. Take a new \
             computer_screenshot and use a point from it.",
        ),
        "window_not_found"
        | "window_target_not_found"
        | "window_id_not_found"
        | "owner_pid_mismatch"
        | "window_owner_pid_mismatch"
        | "window_target_mismatch"
        | "px_window_not_found" => error(HelperErrorCode::NoSuchWindow, "the window is gone"),
        "element_outside_target_window" => error(
            HelperErrorCode::OutOfTarget,
            "That element is not part of this window — a menu or panel of the application's \
             own, perhaps. Only what is inside the shared window can be acted on.",
        ),
        "off_space_or_ax_unresolved" => error(
            HelperErrorCode::Occluded,
            "The window is on another desktop (Space), or its contents cannot be reached right \
             now. Ask the user to bring it onto the current desktop.",
        ),
        "minimized_or_hidden_window" | "window_minimized" | "element_not_visible" => error(
            HelperErrorCode::Occluded,
            if cfg!(target_os = "macos") {
                "The window is minimized or its application is hidden, so pointer and key input \
                 cannot reach it. A minimized window (computer_list_windows marks it) comes back \
                 with computer_restore — the user will see it — and then this can be tried \
                 again; a hidden application has to be shown by the user. A click on an element \
                 by ref, or computer_set_value, may work as it is."
            } else {
                "The window is minimized or its application is hidden, so pointer and key input \
                 cannot reach it. Ask the user to show it — or use computer_set_value, or a click \
                 on an element by ref, which may still work."
            },
        ),
        "same_pid_keyboard_ambiguity" => error(
            HelperErrorCode::Occluded,
            "Its application has other windows open that the keys could reach instead, so no \
             keys are sent in the background. Use computer_set_value on the field, or a click \
             on an element by ref — or ask the user to close the application's other windows.",
        ),
        "background_unavailable"
        | "background_occluded"
        | "background_uipi_blocked"
        | "input_delivery_unavailable" => error(
            HelperErrorCode::BackgroundUnavailable,
            &background_refusal(tool, result),
        ),
        "type_text_synthesis_budget_exceeded" => {
            let chunk = result
                .structured
                .as_ref()
                .and_then(|s| s.get("max_chunk_chars"))
                .and_then(Value::as_u64);
            error(
                HelperErrorCode::ActionFailed,
                &match chunk {
                    Some(n) => format!(
                        "That is more text than can be typed in one call here; nothing was typed. \
                         Send at most {n} characters at a time."
                    ),
                    None => "That is more text than can be typed in one call here; nothing was \
                             typed. Send it in smaller pieces."
                        .to_string(),
                },
            )
        }
        "type_text_incomplete" => error(
            HelperErrorCode::ActionFailed,
            "Only part of the text was typed. Take a new computer_snapshot to see what \
             arrived before typing the rest.",
        ),
        "input_busy" => error(
            HelperErrorCode::ActionFailed,
            "The window is busy with other input. Try again in a moment.",
        ),
        "screen_recording_permission_denied" => {
            HelperError::permission_missing(OsPermission::ScreenRecording)
        }
        "permission_denied" | "accessibility_permission_denied" | "tcc_permission_denied" => {
            HelperError::permission_missing(OsPermission::Accessibility)
        }
        _ => {
            let text = result.text();
            let text: String = text.chars().take(300).collect();
            error(
                HelperErrorCode::ActionFailed,
                &if text.trim().is_empty() {
                    format!("The {tool} did not happen.")
                } else {
                    format!("The {tool} did not happen: {}", text.trim())
                },
            )
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::computer::keys::{Chord, Key, Modifiers};

    fn facts(id: &str, elements: &[(u32, &str, bool)]) -> SnapshotFacts {
        SnapshotFacts {
            snapshot_id: id.into(),
            elements: elements
                .iter()
                .map(|(i, role, secret)| {
                    (
                        *i,
                        ElementFacts {
                            role: role.to_string(),
                            secret: *secret,
                            frame: None,
                        },
                    )
                })
                .collect(),
        }
    }

    fn element(id: &str, index: u32) -> ElementRef {
        ElementRef {
            snapshot_id: id.into(),
            index,
        }
    }

    /// An element's frame is told only from the snapshot the ref names, and
    /// only while that is still the window's latest.
    #[test]
    fn an_element_is_placed_by_its_own_snapshot() {
        let mut book = SnapshotBook::default();
        let mut first = facts("s00000001", &[(3, "AXButton", false)]);
        let frame = Rect {
            x: 10.0,
            y: 20.0,
            width: 30.0,
            height: 40.0,
        };
        first.elements.get_mut(&3).unwrap().frame = Some(frame);
        book.record(1, 10, Some(first));
        assert_eq!(book.frame(1, 10, &element("s00000001", 3)), Some(frame));
        assert_eq!(book.frame(1, 10, &element("s00000001", 4)), None);
        assert_eq!(book.frame(1, 11, &element("s00000001", 3)), None);
        book.record(1, 10, Some(facts("s00000002", &[(3, "AXButton", false)])));
        assert_eq!(book.frame(1, 10, &element("s00000001", 3)), None);
        assert_eq!(book.frame(1, 10, &element("s00000002", 3)), None);
    }

    /// A ref is good only against the window's latest snapshot, and only for
    /// an element that snapshot has; a newer snapshot, or none at all,
    /// makes it stale.
    #[test]
    fn a_ref_is_good_only_against_the_latest_snapshot() {
        let mut book = SnapshotBook::default();
        book.record(1, 10, Some(facts("s00000001", &[(3, "AXButton", false)])));
        let click = |e| WindowAction::Click {
            at: DriverTarget::Element(e),
            button: PointerButton::Left,
            count: 1,
        };
        assert!(book.check(1, 10, &click(element("s00000001", 3)), None).is_ok());
        let code = |r: Result<(), HelperError>| r.unwrap_err().code;
        assert_eq!(
            code(book.check(1, 10, &click(element("s00000001", 4)), None)),
            HelperErrorCode::StaleRef
        );
        // The same id on another window is not that window's snapshot.
        assert_eq!(
            code(book.check(1, 11, &click(element("s00000001", 3)), None)),
            HelperErrorCode::StaleRef
        );
        book.record(1, 10, Some(facts("s00000002", &[(3, "AXButton", false)])));
        assert_eq!(
            code(book.check(1, 10, &click(element("s00000001", 3)), None)),
            HelperErrorCode::StaleRef
        );
        book.record(1, 10, None);
        assert_eq!(
            code(book.check(1, 10, &click(element("s00000002", 3)), None)),
            HelperErrorCode::StaleRef
        );
    }

    /// Text never goes into a secret field — by typing, by setting its value
    /// or by a character key — though it may be clicked, and a key that types
    /// nothing may be pressed on it.
    #[test]
    fn nothing_is_typed_into_a_secret_field() {
        let mut book = SnapshotBook::default();
        book.record(1, 10, Some(facts("s00000001", &[(2, "AXTextField", true)])));
        let pw = || element("s00000001", 2);
        for writes in [
            WindowAction::Type {
                element: pw(),
                text: "hunter2".into(),
                submit: false,
            },
            WindowAction::SetValue {
                element: pw(),
                value: "hunter2".into(),
            },
            WindowAction::Key {
                element: Some(pw()),
                chord: Chord {
                    key: Key::Char('h'),
                    modifiers: Modifiers::default(),
                },
            },
        ] {
            assert_eq!(
                book.check(1, 10, &writes, None).unwrap_err().code,
                HelperErrorCode::SecretField,
                "{writes:?}"
            );
        }
        for fine in [
            WindowAction::Click {
                at: DriverTarget::Element(pw()),
                button: PointerButton::Left,
                count: 1,
            },
            WindowAction::Key {
                element: Some(pw()),
                chord: Chord {
                    key: Key::Tab,
                    modifiers: Modifiers::default(),
                },
            },
        ] {
            assert!(book.check(1, 10, &fine, None).is_ok(), "{fine:?}");
        }
    }

    /// Safari's pop-up menus are not set by value — that path acts on
    /// Safari's front document, whichever window that is.
    #[test]
    fn a_safari_pop_up_is_not_set_by_value() {
        let mut book = SnapshotBook::default();
        book.record(1, 10, Some(facts("s00000001", &[(5, "AXPopUpButton", false)])));
        let set = WindowAction::SetValue {
            element: element("s00000001", 5),
            value: "Large".into(),
        };
        assert_eq!(
            book.check(1, 10, &set, Some("com.apple.Safari"))
                .unwrap_err()
                .code,
            HelperErrorCode::ActionFailed
        );
        assert!(book.check(1, 10, &set, Some("com.apple.TextEdit")).is_ok());
        // An application codeg cannot name could be Safari.
        assert_eq!(
            book.check(1, 10, &set, None).unwrap_err().code,
            HelperErrorCode::ActionFailed
        );
    }

    /// Two halves of one action are only as certain as the less certain.
    #[test]
    fn a_pair_of_calls_is_as_sure_as_its_weaker_half() {
        use ActEffect::*;
        assert_eq!(weaker(Confirmed, Unverifiable), Unverifiable);
        assert_eq!(weaker(Confirmed, Confirmed), Confirmed);
        assert_eq!(weaker(Partial, Confirmed), Partial);
        assert_eq!(weaker(Unverifiable, SuspectedNoop), SuspectedNoop);
    }

    /// The book lets go of the oldest windows past its bound.
    #[test]
    fn the_book_is_bounded() {
        let mut book = SnapshotBook::default();
        for w in 0..(BOOK_WINDOWS as u64 + 5) {
            book.record(1, w, Some(facts("s00000001", &[])));
        }
        assert_eq!(book.windows.len(), BOOK_WINDOWS);
        assert!(!book.windows.contains_key(&(1, 0)));
        assert!(book.windows.contains_key(&(1, BOOK_WINDOWS as u64 + 4)));
    }

    /// The driver's result is read into the closed effect and route; a
    /// result that says nothing is "unverifiable", never "confirmed".
    #[test]
    fn a_result_says_no_more_than_the_driver_can_vouch_for() {
        let ok = |structured: Value| ToolCallResult {
            is_error: false,
            content: Vec::new(),
            structured: Some(structured),
        };
        let act = action_result(
            "click",
            &ok(json!({"effect": "confirmed", "route": "accessibility",
                        "delivery": {"mode": "background"}, "evidence": [{"kind": "value_readback"}]})),
        )
        .unwrap();
        assert_eq!(act.effect, ActEffect::Confirmed);
        assert_eq!(act.route, Some(ActRoute::Accessibility));
        let vague = action_result("click", &ToolCallResult::default()).unwrap();
        assert_eq!(vague.effect, ActEffect::Unverifiable);
        let novel = action_result("click", &ok(json!({"effect": "unverifiable", "route": "telepathy"})))
            .unwrap();
        assert_eq!(novel.route, Some(ActRoute::Other));
        assert!(action_result("click", &ok(json!({"effect": "refused"}))).is_err());
    }

    /// The driver's refusals come back as the helper's codes, in the
    /// helper's words.
    #[test]
    fn refusals_are_read_by_code() {
        let refused = |structured: Value, text: &str| ToolCallResult {
            is_error: true,
            content: vec![json!({"type": "text", "text": text})],
            structured: Some(structured),
        };
        let cases = [
            (
                json!({"status": "refused", "refusal": {"code": "stale_element_token"}}),
                HelperErrorCode::StaleRef,
            ),
            (
                json!({"code": "same_pid_keyboard_ambiguity", "effect": "refused"}),
                HelperErrorCode::Occluded,
            ),
            (
                json!({"code": "element_outside_target_window", "effect": "refused"}),
                HelperErrorCode::OutOfTarget,
            ),
            (
                json!({"code": "background_unavailable", "effect": "refused"}),
                HelperErrorCode::BackgroundUnavailable,
            ),
            (
                json!({"code": "owner_pid_mismatch", "effect": "refused"}),
                HelperErrorCode::NoSuchWindow,
            ),
        ];
        for (structured, want) in cases {
            let e = act_error("click", &refused(structured.clone(), "driver words"));
            assert_eq!(e.code, want, "{structured}");
            assert!(!e.message.contains("driver words"), "{}", e.message);
        }
        // Keys and typing refused in the background: a ref would not help,
        // so what still reaches the application is named instead — and a
        // Chromium window, by its class, is said to be one. A click is still
        // pointed at a ref.
        let background = |tool: &str, class: &str| {
            let refusal = json!({"code": "background_unavailable", "target_class": class});
            let e = act_error(tool, &refused(refusal, "driver words"));
            assert_eq!(e.code, HelperErrorCode::BackgroundUnavailable);
            assert!(!e.message.contains("driver words"), "{}", e.message);
            e.message
        };
        for tool in ["press_key", "type_text"] {
            let edge = background(tool, "Chrome_WidgetWin_1");
            assert!(edge.contains("computer_set_value"), "{edge}");
            assert!(edge.contains("Chromium"), "{edge}");
            let other = background(tool, "HwndWrapper[App;;1]");
            assert!(other.contains("computer_set_value"), "{other}");
            assert!(!other.contains("Chromium"), "{other}");
        }
        let click = background("click", "Chrome_WidgetWin_1");
        assert!(click.contains("element by ref"), "{click}");
        assert!(!click.contains("Chromium"), "{click}");
        // A minimized window points at the way back where there is one.
        let minimized = act_error(
            "type_text",
            &refused(
                json!({"code": "minimized_or_hidden_window", "effect": "refused"}),
                "",
            ),
        );
        assert_eq!(minimized.code, HelperErrorCode::Occluded);
        assert_eq!(
            minimized.message.contains("computer_restore"),
            cfg!(target_os = "macos")
        );
        let budget = act_error(
            "type_text",
            &refused(
                json!({"code": "type_text_synthesis_budget_exceeded", "max_chunk_chars": 2578}),
                "",
            ),
        );
        assert_eq!(budget.code, HelperErrorCode::ActionFailed);
        assert!(budget.message.contains("2578"));
        let other = act_error(
            "set_value",
            &refused(json!({"code": "tool_invocation_failed"}), "element is disabled"),
        );
        assert_eq!(other.code, HelperErrorCode::ActionFailed);
        assert!(other.message.contains("element is disabled"));
    }

    /// Only a point needs the window measured — and Screen Recording, to
    /// measure it by.
    #[test]
    fn a_point_needs_screen_recording_and_an_element_does_not() {
        let at_point = WindowAction::Click {
            at: DriverTarget::Point(WindowPoint {
                x: 1.0,
                y: 2.0,
                window_width: 100.0,
                window_height: 100.0,
            }),
            button: PointerButton::Left,
            count: 1,
        };
        assert!(permissions_for(&at_point).contains(&OsPermission::ScreenRecording));
        let at_element = WindowAction::SetValue {
            element: element("s00000001", 1),
            value: "x".into(),
        };
        assert_eq!(permissions_for(&at_element), &[OsPermission::Accessibility]);
    }
}
