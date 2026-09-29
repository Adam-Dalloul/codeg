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
//! (`<bundle>/Contents/MacOS/<exe>`), where the bundle is an application:
//! named `<name>.app`, or saying so itself (`CFBundlePackageType` `APPL`).
//! The second is how Chromium browsers run — from a clone of their bundle,
//! `<name>.app.bundle` in a temporary folder, made at launch so that an update
//! replacing the installed copy leaves the running code its signature. Such a
//! clone is on a blocklist by its bundle identifier or by the file name it was
//! cloned from, not by the installed copy's full path, which it does not
//! carry. An XPC service, an app extension or a bare executable draws windows
//! for another application or for nobody in particular — the password
//! AutoFill panel is one — and stays unidentified, which is what the driver's
//! list of regular applications left them as. So do Apple's own agents under
//! `/System` — the login window, the Gatekeeper and keychain prompts, Control
//! Center — except in the places Apple keeps the applications people use.
//!
//! A helper application inside another (`Foo.app/…/Foo Helper.app`) is the
//! application it sits in: its windows are that application's, and so is its
//! place on a blocklist — the Passwords menu-bar helper is Passwords. And an
//! application is known by its bundle identifier: one whose `Info.plist`
//! cannot be read is not told apart by its path instead, since the blocklist
//! names password managers by identifier.
//!
//! **Names.** An application is called what the Finder calls it: its file
//! name — Visual Studio Code, which calls itself `Code` — unless it calls
//! itself something else in the person's language: the Finder is 访达 in
//! Chinese, and WPS Office's file is `wpsoffice.app`. That name is the one
//! the window list carries for each window's owner, so a name there that the
//! bundle's own (untranslated) `Info.plist` does not have is taken as a
//! translation. The Finder's own translated name is not to be had here: a
//! process with no bundle of its own is answered in the development language.

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
    /// The application bundle.
    pub path: String,
    /// `CFBundleIdentifier` from the bundle's `Info.plist`.
    pub bundle_id: String,
    /// What the bundle's `Info.plist` calls the application, untranslated
    /// (`CFBundleDisplayName`, `CFBundleName`).
    pub plist_names: Vec<String>,
    /// The process runs a helper inside the application, not the application
    /// itself.
    pub nested: bool,
}

impl AppIdentity {
    /// What to call the application, given the name the window list gives the
    /// process that owns a window (`owner`). See the module note.
    pub fn name(&self, owner: &str) -> String {
        let owner = owner.trim();
        // A helper's own name is not the application's.
        if self.nested || owner.is_empty() {
            return file_name(&self.path);
        }
        // A bundle not named `.app` is a Chromium clone, named after the
        // installed bundle rather than by it.
        if !has_app_extension(&self.path) || !self.plist_names.iter().any(|n| n == owner) {
            return owner.to_string();
        }
        file_name(&self.path)
    }
}

/// The bundle's file name, as the Finder shows it: without `.app` — or, for a
/// Chromium clone, without `.app.bundle`.
fn file_name(bundle: &str) -> String {
    let file = bundle.rsplit('/').next().unwrap_or(bundle);
    let file = strip_suffix_ignore_case(file, ".bundle");
    strip_suffix_ignore_case(file, ".app").to_string()
}

/// `name` without `suffix` (ASCII, in any case), unless nothing would be left.
fn strip_suffix_ignore_case<'a>(name: &'a str, suffix: &str) -> &'a str {
    // `suffix` is ASCII, so where the name ends with it the bytes before it
    // end on a character boundary; anywhere else `get` says no.
    match name.len().checked_sub(suffix.len()).filter(|n| *n > 0) {
        Some(stem)
            if name
                .get(stem..)
                .is_some_and(|end| end.eq_ignore_ascii_case(suffix)) =>
        {
            &name[..stem]
        }
        _ => name,
    }
}

/// Whether `bundle` is named `<name>.app`.
pub fn has_app_extension(bundle: &str) -> bool {
    let name = bundle.rsplit('/').next().unwrap_or(bundle);
    strip_suffix_ignore_case(name, ".app").len() < name.len()
}

/// Whether `bundle` is an application: by its name, or by the package type
/// its `Info.plist` gives (`package_type`).
pub fn is_application(bundle: &str, package_type: Option<&str>) -> bool {
    has_app_extension(bundle) || package_type == Some("APPL")
}

/// The bundle whose main executable `executable` is, or `None` when it is
/// anything else: an executable nested deeper in a bundle, or one outside any.
/// Whether that bundle is an application is [`is_application`]'s question.
pub fn executable_bundle(executable: &str) -> Option<&str> {
    let (dir, file) = executable.rsplit_once('/')?;
    if file.is_empty() {
        return None;
    }
    let bundle = dir.strip_suffix("/Contents/MacOS")?;
    let name = bundle.rsplit('/').next()?;
    (!name.is_empty()).then_some(bundle)
}

/// The outermost `.app` bundle on `bundle`'s path — `bundle` itself unless it
/// sits inside another application. See the module note.
pub fn outermost_app_bundle(bundle: &str) -> &str {
    let mut end = 0;
    for part in bundle.split('/') {
        end += part.len();
        if has_app_extension(part) {
            return &bundle[..end];
        }
        end += 1;
    }
    bundle
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
    identify_executable(&executable_path(pid)?)
}

/// The application `executable` is the main executable of — or sits inside,
/// when it is the main executable of an application within another.
#[cfg(target_os = "macos")]
fn identify_executable(executable: &str) -> Option<AppIdentity> {
    let own = executable_bundle(executable)?;
    let app = outermost_app_bundle(own);
    if is_system_component(app) {
        return None;
    }
    let info = bundle_info(app)?;
    let own_is_application = if own == app {
        is_application(own, info.package_type.as_deref())
    } else {
        // `app` is named `.app`; the helper inside must be an application of
        // its own too.
        has_app_extension(own)
            || bundle_info(own).is_some_and(|i| is_application(own, i.package_type.as_deref()))
    };
    if !own_is_application {
        return None;
    }
    Some(AppIdentity {
        path: app.to_string(),
        bundle_id: info.id?,
        plist_names: info.names,
        nested: own != app,
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

/// What a bundle's `Info.plist` says of it.
#[cfg(target_os = "macos")]
#[derive(Debug, Default)]
struct BundleInfo {
    /// `CFBundleIdentifier`.
    id: Option<String>,
    /// `CFBundlePackageType`.
    package_type: Option<String>,
    /// `CFBundleDisplayName` and `CFBundleName`, where given.
    names: Vec<String>,
}

/// `bundle`'s `Info.plist`, XML or binary.
#[cfg(target_os = "macos")]
fn bundle_info(bundle: &str) -> Option<BundleInfo> {
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
    let text = |key: &'static str| {
        dict.find(CFString::from_static_string(key))
            .and_then(|value| value.downcast::<CFString>())
            .map(|value| value.to_string())
            .filter(|value| !value.is_empty())
    };
    Some(BundleInfo {
        id: text("CFBundleIdentifier"),
        package_type: text("CFBundlePackageType"),
        names: ["CFBundleDisplayName", "CFBundleName"]
            .into_iter()
            .filter_map(text)
            .collect(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The main executable of a bundle names the bundle, whatever the bundle
    /// is; anything else — an executable deeper inside, a bare one — names
    /// nothing.
    #[test]
    fn a_main_executable_names_its_bundle() {
        assert_eq!(
            executable_bundle("/Applications/Visual Studio Code.app/Contents/MacOS/Code"),
            Some("/Applications/Visual Studio Code.app")
        );
        assert_eq!(
            executable_bundle("/Applications/企业微信.app/Contents/MacOS/企业微信"),
            Some("/Applications/企业微信.app")
        );
        assert_eq!(
            executable_bundle(
                "/Applications/Visual Studio Code.app/Contents/Frameworks/Code Helper.app/\
                 Contents/MacOS/Code Helper"
            ),
            Some("/Applications/Visual Studio Code.app/Contents/Frameworks/Code Helper.app")
        );
        assert_eq!(
            executable_bundle(
                "/private/var/folders/xy/T/X/com.google.Chrome.code_sign_clone/\
                 code_sign_clone.V0opBB/Google Chrome.app.bundle/Contents/MacOS/Google Chrome"
            ),
            Some(
                "/private/var/folders/xy/T/X/com.google.Chrome.code_sign_clone/\
                 code_sign_clone.V0opBB/Google Chrome.app.bundle"
            )
        );
        for other in [
            "/Users/me/codeg/src-tauri/target/debug/codeg",
            "/Applications/Foo.app/Contents/Resources/bin/foo",
            "/Applications/Foo.app/Contents/MacOS/",
            "/Contents/MacOS/x",
            "codeg",
        ] {
            assert_eq!(executable_bundle(other), None, "{other}");
        }
    }

    /// An application is named `.app` or says it is one; a service, an
    /// extension or a framework is neither.
    #[test]
    fn an_application_is_named_so_or_says_so() {
        assert!(is_application("/Applications/Termius.app", None));
        assert!(is_application("/Applications/Termius.APP", Some("XPC!")));
        assert!(is_application(
            "/private/var/folders/xy/X/c/Google Chrome.app.bundle",
            Some("APPL")
        ));
        for (bundle, package_type) in [
            ("/private/var/folders/xy/X/c/Google Chrome.app.bundle", None),
            (
                "/System/Library/PrivateFrameworks/SafariPlatformSupport.framework/Versions/A/\
                 XPCServices/com.apple.SafariPlatformSupport.Helper.xpc",
                Some("XPC!"),
            ),
            (
                "/System/Library/ExtensionKit/Extensions/WebThumbnailExtension.appex",
                Some("XPC!"),
            ),
            ("/Applications/.app", None),
        ] {
            assert!(!is_application(bundle, package_type), "{bundle}");
        }
    }

    /// A helper application is the application it sits in; an application on
    /// its own is itself.
    #[test]
    fn a_nested_helper_is_the_application_it_sits_in() {
        assert_eq!(
            outermost_app_bundle(
                "/System/Applications/Passwords.app/Contents/Library/LoginItems/\
                 PasswordsMenuBarExtra.app"
            ),
            "/System/Applications/Passwords.app"
        );
        assert_eq!(
            outermost_app_bundle(
                "/Applications/Visual Studio Code.app/Contents/Frameworks/Code Helper.app"
            ),
            "/Applications/Visual Studio Code.app"
        );
        assert_eq!(
            outermost_app_bundle("/Applications/企业微信.app"),
            "/Applications/企业微信.app"
        );
        assert_eq!(
            outermost_app_bundle("/Library/Foo.framework/Resources/Helper.app"),
            "/Library/Foo.framework/Resources/Helper.app"
        );
        assert_eq!(
            outermost_app_bundle("/private/var/folders/xy/X/c/Google Chrome.app.bundle"),
            "/private/var/folders/xy/X/c/Google Chrome.app.bundle"
        );
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

    fn identity(path: &str, names: &[&str], nested: bool) -> AppIdentity {
        AppIdentity {
            path: path.into(),
            bundle_id: "com.example".into(),
            plist_names: names.iter().map(|n| n.to_string()).collect(),
            nested,
        }
    }

    /// Named as the Finder names it: by the file name where the application
    /// only calls itself what its Info.plist says, by its own name where that
    /// is a translation, and by the owner's name for a clone, which is not
    /// named by its file.
    #[test]
    fn an_application_is_named_as_the_finder_names_it() {
        let code = identity(
            "/Applications/Visual Studio Code.app",
            &["Code", "Code"],
            false,
        );
        assert_eq!(code.name("Code"), "Visual Studio Code");
        assert_eq!(code.name(""), "Visual Studio Code");
        let finder = identity(FINDER, &["Finder"], false);
        assert_eq!(finder.name("访达"), "访达");
        let wps = identity(
            "/Applications/wpsoffice.app",
            &["wpsoffice", "wpsoffice"],
            false,
        );
        assert_eq!(wps.name("WPS Office"), "WPS Office");
        assert_eq!(wps.name("wpsoffice"), "wpsoffice");
        let chrome = identity(
            "/private/var/folders/xy/X/c/Google Chrome.app.bundle",
            &["Google Chrome", "Chrome"],
            false,
        );
        assert_eq!(chrome.name("Google Chrome"), "Google Chrome");
        assert_eq!(chrome.name(" "), "Google Chrome");
        // A helper inside: the application's file name, not the helper's.
        let helper = identity("/Applications/Google Chrome.app", &["Google Chrome"], true);
        assert_eq!(
            helper.name("Google Chrome Helper (Alerts)"),
            "Google Chrome"
        );
    }

    /// This test runner is a bare executable, which is no application; the
    /// Finder, which every logged-in session runs, is one, with what it says
    /// of itself read from its own Info.plist.
    #[cfg(target_os = "macos")]
    #[test]
    fn a_running_application_is_read_off_its_process() {
        assert_eq!(identify(std::process::id()), None);
        assert_eq!(identify(0), None);
        let finder = bundle_info(FINDER).expect("the Finder's Info.plist");
        assert_eq!(finder.id.as_deref(), Some("com.apple.finder"));
        assert!(finder.names.iter().any(|n| n == "Finder"));
        assert!(bundle_info("/nonexistent/Nothing.app").is_none());
    }

    /// A bundle on disk: an application by name or by its own word, a
    /// service by neither, and a helper application inside one.
    #[cfg(target_os = "macos")]
    #[test]
    fn bundles_on_disk_are_told_apart() {
        let root = tempfile::tempdir().unwrap();
        let bundle = |rel: &str, package_type: Option<&str>, id: &str| {
            let contents = root.path().join(rel).join("Contents");
            std::fs::create_dir_all(contents.join("MacOS")).unwrap();
            let package_type = package_type
                .map(|t| format!("<key>CFBundlePackageType</key><string>{t}</string>"))
                .unwrap_or_default();
            std::fs::write(
                contents.join("Info.plist"),
                format!(
                    "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\
                     <plist version=\"1.0\"><dict>\
                     <key>CFBundleIdentifier</key><string>{id}</string>\
                     <key>CFBundleName</key><string>Short</string>\
                     {package_type}</dict></plist>"
                ),
            )
            .unwrap();
            format!("{}/Contents/MacOS/exe", root.path().join(rel).display())
        };
        let clone = bundle("c/Browser.app.bundle", Some("APPL"), "com.example.browser");
        let service = bundle("s/Service.xpc", Some("XPC!"), "com.example.service");
        let unmarked = bundle("u/Tool.bundle", None, "com.example.tool");
        let app = bundle("Suite.app", Some("APPL"), "com.example.suite");
        let helper = bundle(
            "Suite.app/Contents/Library/Helper.bundle",
            Some("APPL"),
            "h",
        );
        let inner_service = bundle(
            "Suite.app/Contents/XPCServices/Inner.xpc",
            Some("XPC!"),
            "i",
        );

        let clone = identify_executable(&clone).expect("a clone that says it is an application");
        assert_eq!(clone.bundle_id, "com.example.browser");
        assert!(!clone.nested);
        assert_eq!(clone.plist_names, vec!["Short".to_string()]);
        assert_eq!(identify_executable(&service), None);
        assert_eq!(identify_executable(&unmarked), None);
        assert_eq!(
            identify_executable(&app).unwrap().bundle_id,
            "com.example.suite"
        );
        let helper = identify_executable(&helper).expect("a helper application inside");
        assert_eq!(helper.bundle_id, "com.example.suite");
        assert!(helper.nested);
        assert_eq!(identify_executable(&inner_service), None);
    }
}
