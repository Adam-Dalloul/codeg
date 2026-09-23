//! `codeg-computer-helper`: the executor behind codeg's `computer_*` tools.
//!
//! Everything it does lives in `codeg_lib::computer::helper`; this file holds
//! only the one thing that must not be linked into codeg itself — the calls
//! that *ask* macOS for a permission. Raised from here, the request names the
//! helper; raised from codeg, it would name codeg, and a person who clicked
//! "Allow" would have handed the permission to every agent's shell.

use codeg_lib::computer::helper::{run, PermissionPrompts};
use codeg_lib::computer::protocol::OsPermission;

struct SystemPrompts;

impl PermissionPrompts for SystemPrompts {
    fn request(&self, permission: OsPermission) {
        #[cfg(target_os = "macos")]
        macos::request(permission);
        #[cfg(not(target_os = "macos"))]
        let _ = permission;
    }
}

#[cfg(target_os = "macos")]
mod macos {
    use codeg_lib::computer::protocol::OsPermission;
    use core_foundation::base::TCFType;
    use core_foundation::boolean::CFBoolean;
    use core_foundation::dictionary::CFDictionary;
    use core_foundation::string::CFString;
    use core_foundation_sys::dictionary::CFDictionaryRef;
    use core_foundation_sys::string::CFStringRef;

    #[link(name = "ApplicationServices", kind = "framework")]
    extern "C" {
        static kAXTrustedCheckOptionPrompt: CFStringRef;
        fn AXIsProcessTrustedWithOptions(options: CFDictionaryRef) -> u8;
    }

    pub fn request(permission: OsPermission) {
        match permission {
            OsPermission::Accessibility => {
                // SAFETY: the option key is a CFString constant for the life
                // of the process; the dictionary outlives the call.
                unsafe {
                    let options = CFDictionary::from_CFType_pairs(&[(
                        CFString::wrap_under_get_rule(kAXTrustedCheckOptionPrompt),
                        CFBoolean::true_value(),
                    )]);
                    AXIsProcessTrustedWithOptions(options.as_concrete_TypeRef());
                }
            }
            OsPermission::ScreenRecording => {
                // macOS 10.15+, so looked up rather than linked.
                type Request = unsafe extern "C" fn() -> u8;
                static NAME: &[u8] = b"CGRequestScreenCaptureAccess\0";
                // SAFETY: RTLD_DEFAULT lookup of a NUL-terminated name; the
                // symbol has exactly this signature.
                unsafe {
                    let sym = libc::dlsym(libc::RTLD_DEFAULT, NAME.as_ptr().cast());
                    if !sym.is_null() {
                        let request: Request =
                            std::mem::transmute::<*mut libc::c_void, Request>(sym);
                        request();
                    }
                }
            }
        }
    }
}

fn main() {
    std::process::exit(run(SystemPrompts));
}
