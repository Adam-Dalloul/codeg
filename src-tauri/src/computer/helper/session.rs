//! Whether the person's session can take input right now.
//!
//! A locked screen, or a session another user has switched to, is a desktop
//! nobody is watching: whatever an agent does there goes unseen until the
//! person is back, and on Windows it would land on the lock screen's own
//! desktop. The helper asks just before each action's driver call, and does
//! not act unless the answer is an affirmative "unlocked". The driver does
//! not ask at all.

/// What the platform says about the session.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SessionState {
    /// Unlocked, and the one on the console.
    Unlocked,
    /// Locked, or another user's session is on the console.
    Locked,
    /// The platform gave no answer this code can read. Treated as "do not
    /// act": an action nobody can be sure someone is watching is not one to
    /// take.
    Unknown,
}

/// The session as macOS describes it: on the console (`kCGSessionOnConsoleKey`
/// true) and not showing the lock screen (`CGSSessionScreenIsLocked` absent or
/// false — the key is only there while the screen is locked).
#[cfg(target_os = "macos")]
pub fn state() -> SessionState {
    use core_foundation::base::{CFType, TCFType};
    use core_foundation::boolean::CFBoolean;
    use core_foundation::dictionary::CFDictionary;
    use core_foundation::string::CFString;
    use core_foundation_sys::dictionary::CFDictionaryRef;

    #[link(name = "CoreGraphics", kind = "framework")]
    extern "C" {
        fn CGSessionCopyCurrentDictionary() -> CFDictionaryRef;
    }

    // SAFETY: no arguments; returns a +1 dictionary, or null outside a GUI
    // session.
    let raw = unsafe { CGSessionCopyCurrentDictionary() };
    if raw.is_null() {
        return SessionState::Unknown;
    }
    // SAFETY: the +1 dictionary from above, released by the wrapper.
    let session: CFDictionary<CFString, CFType> = unsafe { CFDictionary::wrap_under_create_rule(raw) };
    let flag = |key: &'static str| {
        session
            .find(CFString::from_static_string(key))
            .and_then(|v| v.downcast::<CFBoolean>())
            .map(bool::from)
    };
    match (
        flag("kCGSSessionOnConsoleKey"),
        flag("CGSSessionScreenIsLocked"),
    ) {
        (_, Some(true)) | (Some(false), _) => SessionState::Locked,
        (Some(true), _) => SessionState::Unlocked,
        (None, _) => SessionState::Unknown,
    }
}

/// The input desktop is the user's own `Default` one — the lock screen and
/// the UAC prompt run on the secure desktop, which a user-level process
/// cannot even open.
#[cfg(windows)]
pub fn state() -> SessionState {
    use windows_sys::Win32::System::StationsAndDesktops::{
        CloseDesktop, GetUserObjectInformationW, OpenInputDesktop, DESKTOP_READOBJECTS, UOI_NAME,
    };
    // SAFETY: plain Win32 calls with valid arguments; the handle is closed
    // before returning.
    unsafe {
        let desktop = OpenInputDesktop(0, 0, DESKTOP_READOBJECTS);
        if desktop.is_null() {
            return SessionState::Locked;
        }
        let mut name = [0u16; 64];
        let mut needed = 0u32;
        let ok = GetUserObjectInformationW(
            desktop,
            UOI_NAME,
            name.as_mut_ptr().cast(),
            (name.len() * 2) as u32,
            &mut needed,
        );
        CloseDesktop(desktop);
        if ok == 0 {
            return SessionState::Unknown;
        }
        let len = name.iter().position(|c| *c == 0).unwrap_or(name.len());
        if String::from_utf16_lossy(&name[..len]) == "Default" {
            SessionState::Unlocked
        } else {
            SessionState::Locked
        }
    }
}

/// No one question every Linux desktop answers — so no action is taken there
/// in this version.
#[cfg(not(any(target_os = "macos", windows)))]
pub fn state() -> SessionState {
    SessionState::Unknown
}
