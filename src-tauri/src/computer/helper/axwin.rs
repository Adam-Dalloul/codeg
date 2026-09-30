//! What the helper asks of Accessibility itself, rather than of the driver:
//! which windows are minimized — and the one change it makes to a window on
//! its own, putting a minimized one back on the screen.
//!
//! The driver's window list does not say which windows are minimized. To it a
//! minimized window is only off screen and still on its Space — as are the
//! hidden windows every application keeps (a main window closed to the menu
//! bar, a panel made ahead of time), which nobody means to share and codeg
//! leaves out of its lists. The application's accessibility interface tells
//! them apart: it lists the windows a person can bring up, minimized ones
//! among them, each saying whether it is (`AXMinimized`); ordered-out windows
//! are not in it at all. Nor has the driver a call that restores a window.
//!
//! Only asked once a process started for the purpose has found Accessibility
//! granted to the helper (see `HelperState::permissions`): a process keeps
//! the first "not granted" it hears for the rest of its life, and this one
//! would go on hearing it after the person had said yes. Every question goes
//! to another application and waits for its answer, so each is bounded
//! ([`TIMEOUT`]) and asked off the async runtime.

use std::collections::{BTreeSet, HashMap};
use std::sync::OnceLock;

use core_foundation::array::CFArray;
use core_foundation::base::{CFGetTypeID, CFType, CFTypeID, CFTypeRef, TCFType};
use core_foundation::boolean::CFBoolean;
use core_foundation::number::CFNumber;
use core_foundation::string::{CFString, CFStringRef};

type AXError = i32;
const AX_SUCCESS: AXError = 0;
const AX_FAILURE: AXError = -25200;
const AX_NO_VALUE: AXError = -25212;

/// How long one question to an application may take before it counts as no
/// answer. A busy application answers well within it; a hung one would
/// otherwise hold each question for the system's six seconds.
const TIMEOUT: f32 = 0.5;

#[link(name = "ApplicationServices", kind = "framework")]
extern "C" {
    fn AXUIElementCreateApplication(pid: libc::pid_t) -> CFTypeRef;
    fn AXUIElementCopyAttributeValue(
        element: CFTypeRef,
        attribute: CFStringRef,
        value: *mut CFTypeRef,
    ) -> AXError;
    fn AXUIElementSetAttributeValue(
        element: CFTypeRef,
        attribute: CFStringRef,
        value: CFTypeRef,
    ) -> AXError;
    fn AXUIElementSetMessagingTimeout(element: CFTypeRef, seconds: f32) -> AXError;
    fn AXUIElementGetTypeID() -> CFTypeID;
}

/// Whether each window Accessibility lists for each of `pids` is minimized,
/// by window id — `None` for a window that would not say. An application
/// that would not answer (quit, hung, not an application) is left out.
pub async fn minimized(pids: BTreeSet<u32>) -> HashMap<u32, HashMap<u64, Option<bool>>> {
    tokio::task::spawn_blocking(move || {
        pids.into_iter()
            .filter_map(|pid| Some((pid, minimized_now(pid)?)))
            .collect()
    })
    .await
    .unwrap_or_default()
}

/// Whether `pid`'s window `window_id` is minimized; `None` when that cannot
/// be told.
pub async fn is_minimized(pid: u32, window_id: u64) -> Option<bool> {
    tokio::task::spawn_blocking(move || minimized_now(pid)?.get(&window_id).copied().flatten())
        .await
        .ok()
        .flatten()
}

/// What asking for a window back came to.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Restore {
    /// It was minimized, and its application took the request.
    Asked,
    /// It is not minimized: there was nothing to do.
    NotMinimized,
    /// Its application is hidden (⌘H): brought back, the window would still
    /// not show.
    AppHidden,
    /// Accessibility does not list it: on another desktop, or not a window a
    /// person can bring up.
    Unlisted,
    /// The application would not answer, or refused; the error it gave.
    Failed(i32),
}

/// Put `pid`'s window `window_id` back on the screen if it is minimized — as
/// clicking it in the Dock would, except that its application is not brought
/// to the front. `ready` is asked on the same thread just before the one
/// change is made, once everything read to decide on it has been read; what
/// it refuses is not done, and its error comes back as it is.
pub async fn restore<E: Send + 'static>(
    pid: u32,
    window_id: u64,
    ready: impl FnOnce() -> Result<(), E> + Send + 'static,
) -> Result<Restore, E> {
    tokio::task::spawn_blocking(move || restore_now(pid, window_id, ready))
        .await
        .unwrap_or(Ok(Restore::Failed(AX_FAILURE)))
}

fn minimized_now(pid: u32) -> Option<HashMap<u64, Option<bool>>> {
    let app = application(pid)?;
    let windows = windows(&app).ok()?;
    Some(
        windows
            .iter()
            .filter_map(|w| Some((window_number(w)?, flag(w, "AXMinimized"))))
            .collect(),
    )
}

fn restore_now<E>(
    pid: u32,
    window_id: u64,
    ready: impl FnOnce() -> Result<(), E>,
) -> Result<Restore, E> {
    let Some(app) = application(pid) else {
        return Ok(Restore::Failed(AX_FAILURE));
    };
    if flag(&app, "AXHidden") == Some(true) {
        return Ok(Restore::AppHidden);
    }
    let windows = match windows(&app) {
        Ok(windows) => windows,
        Err(e) => return Ok(Restore::Failed(e)),
    };
    let Some(window) = windows
        .into_iter()
        .find(|w| window_number(w) == Some(window_id))
    else {
        return Ok(Restore::Unlisted);
    };
    if flag(&window, "AXMinimized") == Some(false) {
        return Ok(Restore::NotMinimized);
    }
    ready()?;
    let name = CFString::from_static_string("AXMinimized");
    // SAFETY: a live window element, a valid attribute name and a CFBoolean
    // that outlives the call.
    let err = unsafe {
        AXUIElementSetAttributeValue(
            window.as_CFTypeRef(),
            name.as_concrete_TypeRef(),
            CFBoolean::false_value().as_CFTypeRef(),
        )
    };
    Ok(if err == AX_SUCCESS {
        Restore::Asked
    } else {
        Restore::Failed(err)
    })
}

/// `pid`'s application, as Accessibility sees it.
fn application(pid: u32) -> Option<CFType> {
    let pid = libc::pid_t::try_from(pid).ok()?;
    // SAFETY: returns a +1 element, or null.
    let raw = unsafe { AXUIElementCreateApplication(pid) };
    if raw.is_null() {
        return None;
    }
    // SAFETY: the +1 element from above, released by the wrapper.
    let app = unsafe { CFType::wrap_under_create_rule(raw) };
    bound(&app);
    Some(app)
}

/// Hold every question to `element` to [`TIMEOUT`]. Set on each element
/// asked: the bound is the element's own, not its application's.
fn bound(element: &CFType) {
    // SAFETY: a live element; this only sets a number on it.
    unsafe { AXUIElementSetMessagingTimeout(element.as_CFTypeRef(), TIMEOUT) };
}

/// One attribute's value, or the error the application answered with.
fn attribute(element: &CFType, name: &'static str) -> Result<CFType, AXError> {
    let name = CFString::from_static_string(name);
    let mut value: CFTypeRef = std::ptr::null();
    // SAFETY: a live element, a valid attribute name, and an out pointer that
    // receives a +1 value on success.
    let err = unsafe {
        AXUIElementCopyAttributeValue(
            element.as_CFTypeRef(),
            name.as_concrete_TypeRef(),
            &mut value,
        )
    };
    if err != AX_SUCCESS {
        return Err(err);
    }
    if value.is_null() {
        return Err(AX_NO_VALUE);
    }
    // SAFETY: the +1 value from above, released by the wrapper.
    Ok(unsafe { CFType::wrap_under_create_rule(value) })
}

/// A yes-or-no attribute. Some applications answer with a number.
fn flag(element: &CFType, name: &'static str) -> Option<bool> {
    let value = attribute(element, name).ok()?;
    if let Some(yes) = value.downcast::<CFBoolean>() {
        return Some(yes.into());
    }
    value
        .downcast::<CFNumber>()
        .and_then(|n| n.to_i64())
        .map(|n| n != 0)
}

/// The application's windows, as Accessibility lists them.
fn windows(app: &CFType) -> Result<Vec<CFType>, AXError> {
    let list = attribute(app, "AXWindows")?
        .downcast_into::<CFArray>()
        .ok_or(AX_NO_VALUE)?;
    // SAFETY: a pure query.
    let element_type = unsafe { AXUIElementGetTypeID() };
    Ok(list
        .iter()
        .map(|item| *item)
        // SAFETY: a non-null object the array holds.
        .filter(|item| !item.is_null() && unsafe { CFGetTypeID(*item) } == element_type)
        .map(|item| {
            // SAFETY: an element the array holds, retained for the wrapper.
            let window = unsafe { CFType::wrap_under_get_rule(item) };
            bound(&window);
            window
        })
        .collect())
}

/// The window server's number for an accessibility window: what the
/// driver's listing names windows by. Private (`_AXUIElementGetWindow`), and
/// what every window manager and the driver itself map windows with; looked
/// up at run time, so a macOS without it costs the helper this module, not
/// its start.
fn window_number(window: &CFType) -> Option<u64> {
    type GetWindow = unsafe extern "C" fn(CFTypeRef, *mut u32) -> AXError;
    static GET_WINDOW: OnceLock<Option<GetWindow>> = OnceLock::new();
    let get = (*GET_WINDOW.get_or_init(|| {
        static NAME: &[u8] = b"_AXUIElementGetWindow\0";
        // SAFETY: RTLD_DEFAULT lookup of a NUL-terminated name; this module
        // links ApplicationServices, which carries it.
        let sym = unsafe { libc::dlsym(libc::RTLD_DEFAULT, NAME.as_ptr().cast()) };
        // SAFETY: the symbol has exactly this signature.
        (!sym.is_null())
            .then(|| unsafe { std::mem::transmute::<*mut libc::c_void, GetWindow>(sym) })
    }))?;
    let mut number = 0u32;
    // SAFETY: a live window element and an out pointer for the number.
    let err = unsafe { get(window.as_CFTypeRef(), &mut number) };
    (err == AX_SUCCESS && number != 0).then_some(u64::from(number))
}
