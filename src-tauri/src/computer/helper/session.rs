//! Whether the person's session can take input right now.
//!
//! A locked screen, or a session another user has switched to, is a desktop
//! nobody is watching: whatever an agent does there goes unseen until the
//! person is back, and on Windows it would land on the lock screen's own
//! desktop. The helper asks just before each action, and refuses while it is
//! so. The driver does not ask at all.

/// Whether the session is locked, or not the one on the console. When the
/// platform cannot say, it is taken as locked.
#[cfg(target_os = "macos")]
pub fn locked() -> bool {
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
        return true;
    }
    // SAFETY: the +1 dictionary from above, released by the wrapper.
    let session: CFDictionary<CFString, CFType> = unsafe { CFDictionary::wrap_under_create_rule(raw) };
    let flag = |key: &'static str| {
        session
            .find(CFString::from_static_string(key))
            .and_then(|v| v.downcast::<CFBoolean>())
            .map(bool::from)
    };
    flag("CGSSessionScreenIsLocked") == Some(true) || flag("kCGSSessionOnConsoleKey") == Some(false)
}

/// Whether the input desktop is anything but the user's own `Default` one —
/// the lock screen and the UAC prompt run on the secure desktop, which a
/// user-level process cannot even open.
#[cfg(windows)]
pub fn locked() -> bool {
    use windows_sys::Win32::System::StationsAndDesktops::{
        CloseDesktop, GetUserObjectInformationW, OpenInputDesktop, DESKTOP_READOBJECTS, UOI_NAME,
    };
    // SAFETY: plain Win32 calls with valid arguments; the handle is closed
    // before returning.
    unsafe {
        let desktop = OpenInputDesktop(0, 0, DESKTOP_READOBJECTS);
        if desktop.is_null() {
            return true;
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
            return true;
        }
        let len = name.iter().position(|c| *c == 0).unwrap_or(name.len());
        String::from_utf16_lossy(&name[..len]) != "Default"
    }
}

/// Not asked on Linux: there is no one question every desktop answers.
#[cfg(not(any(target_os = "macos", windows)))]
pub fn locked() -> bool {
    false
}
