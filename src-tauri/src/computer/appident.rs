//! Which application a process is, asked of the process itself.
//!
//! The driver has its own answer — `list_apps` — and on macOS it goes stale.
//! It reads `NSWorkspace.runningApplications`, which only changes while the
//! main run loop runs, and the driver never runs its: an application launched
//! after the driver started is missing from that list for good, and one that
//! quit stays on it — under a pid the system may since have handed to
//! another process, which would then pass for it. So on macOS the helper asks
//! the kernel which executable a process runs (`proc_pidpath`, an ordinary
//! BSD query, not TCC-governed) and reads the application off that.
//!
//! Only the main executable of an application bundle counts
//! (`<name>.app/Contents/MacOS/<exe>`). An XPC service, an app extension or a
//! bare executable draws windows for another application or for nobody in
//! particular — the password AutoFill panel is one — and stays unidentified,
//! which is what the driver's list of regular applications left them as. So
//! do Apple's own agents under `/System` — the login window, the Gatekeeper
//! and keychain prompts, Control Center — except in the places Apple keeps
//! the applications people use.

/// Where Apple keeps the applications people use, under `/System`.
const SYSTEM_APPLICATIONS: &[&str] = &[
    "/System/Applications/",
    "/System/Cryptexes/App/System/Applications/",
    "/System/Library/CoreServices/Applications/",
];

/// The one application Apple keeps among its agents.
const FINDER: &str = "/System/Library/CoreServices/Finder.app";

/// The largest `Info.plist` read: real ones are a few kilobytes, and the
/// helper does not read an unbounded file because a bundle says so.
#[cfg(target_os = "macos")]
const MAX_INFO_PLIST: u64 = 1 << 20;

/// An application, as the process running it shows.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AppIdentity {
    /// The `.app` bundle.
    pub path: String,
    /// `CFBundleIdentifier` from the bundle's `Info.plist`, when it has one.
    pub bundle_id: Option<String>,
}

/// The bundle whose main executable `executable` is, or `None` when it is
/// anything else: an executable nested deeper in a bundle, one outside any, or
/// the main executable of something that is not an application.
pub fn main_app_bundle(executable: &str) -> Option<&str> {
    let (dir, file) = executable.rsplit_once('/')?;
    if file.is_empty() {
        return None;
    }
    let bundle = dir.strip_suffix("/Contents/MacOS")?;
    let name = bundle.rsplit('/').next()?;
    // `.app` is ASCII, so where the name ends with it the four bytes before
    // the end are a character boundary; anywhere else `get` says no.
    let stem = name.len().checked_sub(4).filter(|n| *n > 0)?;
    name.get(stem..)
        .is_some_and(|ext| ext.eq_ignore_ascii_case(".app"))
        .then_some(bundle)
}

/// Whether `bundle` is one of Apple's own agents or panels rather than an
/// application a person uses. See the module note.
pub fn is_system_component(bundle: &str) -> bool {
    bundle.starts_with("/System/")
        && !SYSTEM_APPLICATIONS
            .iter()
            .any(|dir| bundle.starts_with(dir))
        && !bundle.eq_ignore_ascii_case(FINDER)
}

/// The application `pid` runs, when it is one (see the module note). macOS
/// only: elsewhere the driver's own list is read afresh on every call.
#[cfg(target_os = "macos")]
pub fn identify(pid: u32) -> Option<AppIdentity> {
    let executable = executable_path(pid)?;
    let bundle = main_app_bundle(&executable)?;
    if is_system_component(bundle) {
        return None;
    }
    Some(AppIdentity {
        path: bundle.to_string(),
        bundle_id: bundle_identifier(bundle),
    })
}

/// The executable `pid` runs, as the kernel has it.
#[cfg(target_os = "macos")]
fn executable_path(pid: u32) -> Option<String> {
    let pid = libc::c_int::try_from(pid).ok().filter(|p| *p > 0)?;
    let mut buf = vec![0u8; libc::PROC_PIDPATHINFO_MAXSIZE as usize];
    // SAFETY: `buf` is a live buffer of exactly the size passed; the call
    // writes at most that many bytes and returns how many it wrote.
    let written = unsafe { libc::proc_pidpath(pid, buf.as_mut_ptr().cast(), buf.len() as u32) };
    let written = usize::try_from(written).ok().filter(|n| *n > 0)?;
    buf.truncate(written);
    String::from_utf8(buf).ok()
}

/// `CFBundleIdentifier` from `bundle`'s `Info.plist`, XML or binary.
#[cfg(target_os = "macos")]
fn bundle_identifier(bundle: &str) -> Option<String> {
    use std::io::Read;

    use core_foundation::base::{CFType, TCFType};
    use core_foundation::data::CFData;
    use core_foundation::dictionary::CFDictionary;
    use core_foundation::propertylist::{
        create_with_data, kCFPropertyListImmutable, CFPropertyList,
    };
    use core_foundation::string::CFString;

    let file =
        std::fs::File::open(std::path::Path::new(bundle).join("Contents/Info.plist")).ok()?;
    let mut bytes = Vec::new();
    file.take(MAX_INFO_PLIST + 1).read_to_end(&mut bytes).ok()?;
    if bytes.len() as u64 > MAX_INFO_PLIST {
        return None;
    }
    let (raw, _format) =
        create_with_data(CFData::from_buffer(&bytes), kCFPropertyListImmutable).ok()?;
    // SAFETY: `create_with_data` returned a +1 property list, released by the
    // wrapper.
    let plist = unsafe { CFPropertyList::wrap_under_create_rule(raw) };
    let dict = plist.downcast_into::<CFDictionary>()?;
    // SAFETY: the same dictionary, viewed with the key and value types every
    // property-list dictionary has; retained by the view for its own life.
    let dict: CFDictionary<CFString, CFType> =
        unsafe { CFDictionary::wrap_under_get_rule(dict.as_concrete_TypeRef()) };
    let id = dict
        .find(CFString::from_static_string("CFBundleIdentifier"))?
        .downcast::<CFString>()?
        .to_string();
    (!id.is_empty()).then_some(id)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The main executable of an application bundle names the bundle;
    /// anything else — a helper deeper inside, a service, an extension, a
    /// bare executable — names nothing.
    #[test]
    fn only_an_applications_main_executable_names_it() {
        assert_eq!(
            main_app_bundle("/Applications/Visual Studio Code.app/Contents/MacOS/Code"),
            Some("/Applications/Visual Studio Code.app")
        );
        assert_eq!(
            main_app_bundle("/Applications/企业微信.app/Contents/MacOS/企业微信"),
            Some("/Applications/企业微信.app")
        );
        assert_eq!(
            main_app_bundle(
                "/Applications/Visual Studio Code.app/Contents/Frameworks/Code Helper.app/\
                 Contents/MacOS/Code Helper"
            ),
            Some("/Applications/Visual Studio Code.app/Contents/Frameworks/Code Helper.app")
        );
        for other in [
            "/System/Library/PrivateFrameworks/SafariPlatformSupport.framework/Versions/A/\
             XPCServices/com.apple.SafariPlatformSupport.Helper.xpc/Contents/MacOS/\
             com.apple.SafariPlatformSupport.Helper",
            "/System/Library/ExtensionKit/Extensions/WebThumbnailExtension.appex/Contents/MacOS/\
             WebThumbnailExtension",
            "/Users/me/codeg/src-tauri/target/debug/codeg",
            "/Applications/Foo.app/Contents/Resources/bin/foo",
            "/Applications/Foo.app/Contents/MacOS/",
            "/.app/Contents/MacOS/x",
            "codeg",
        ] {
            assert_eq!(main_app_bundle(other), None, "{other}");
        }
    }

    /// Apple's agents are system components; the applications Apple ships —
    /// in /System/Applications, the Safari cryptex, CoreServices'
    /// Applications folder — and the Finder are not, and nothing outside
    /// /System is.
    #[test]
    fn apples_agents_are_system_components_and_its_applications_are_not() {
        for component in [
            "/System/Library/CoreServices/loginwindow.app",
            "/System/Library/CoreServices/CoreServicesUIAgent.app",
            "/System/Library/CoreServices/ControlCenter.app",
            "/System/Library/CoreServices/WiFiAgent.app",
        ] {
            assert!(is_system_component(component), "{component}");
        }
        for application in [
            "/System/Applications/Notes.app",
            "/System/Applications/Utilities/Terminal.app",
            "/System/Cryptexes/App/System/Applications/Safari.app",
            "/System/Library/CoreServices/Applications/Archive Utility.app",
            "/System/Library/CoreServices/Finder.app",
            "/Applications/Clash Verge.app",
            "/Users/me/Applications/Tool.app",
        ] {
            assert!(!is_system_component(application), "{application}");
        }
    }

    /// This test runner is a bare executable, which is no application; the
    /// Finder, which every logged-in session runs, is one, with its bundle
    /// identifier read from its own Info.plist.
    #[cfg(target_os = "macos")]
    #[test]
    fn a_running_application_is_read_off_its_process() {
        assert_eq!(identify(std::process::id()), None);
        assert_eq!(identify(0), None);
        assert_eq!(
            bundle_identifier(FINDER).as_deref(),
            Some("com.apple.finder")
        );
        assert_eq!(bundle_identifier("/nonexistent/Nothing.app"), None);
    }
}
