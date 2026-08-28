use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::process::Stdio;

use crate::app_error::AppCommandError;
use crate::process::std_command;

/// Open a file or directory in Visual Studio Code.
///
/// Resolves the `code` CLI (and well-known install locations) and launches it
/// detached so the editor outlives this call. Works in both desktop and
/// server mode: the host that owns the workspace path is the one that spawns
/// Code.
pub fn open_in_code_core(path: String) -> Result<(), AppCommandError> {
    let target = validate_open_in_code_path(&path)?;
    let launch = resolve_vscode_launch().ok_or_else(|| {
        AppCommandError::dependency_missing(
            "Visual Studio Code was not found. Install it or add the `code` command to PATH.",
        )
    })?;
    spawn_vscode(&launch, &target)
}

#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn open_in_code(path: String) -> Result<(), AppCommandError> {
    open_in_code_core(path)
}

fn validate_open_in_code_path(path: &str) -> Result<PathBuf, AppCommandError> {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return Err(AppCommandError::invalid_input(
            "path is required to open in Code",
        ));
    }
    if trimmed.contains(['\n', '\r', '\0']) {
        return Err(AppCommandError::invalid_input(
            "path must not contain control characters",
        ));
    }
    let target = PathBuf::from(trimmed);
    if !target.exists() {
        return Err(AppCommandError::not_found(format!(
            "path does not exist: {trimmed}"
        )));
    }
    Ok(target)
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct VsCodeLaunch {
    program: PathBuf,
    /// Extra args inserted before the target path (`open -a "Visual Studio Code"`).
    args_prefix: Vec<OsString>,
    /// `.cmd` / `.bat` shims cannot be CreateProcess'd; wrap them in `cmd /C`.
    uses_cmd_wrapper: bool,
}

impl VsCodeLaunch {
    fn from_binary(program: PathBuf) -> Self {
        let program = prefer_gui_binary(program);
        let uses_cmd_wrapper = is_windows_script(&program);
        Self {
            program,
            args_prefix: Vec::new(),
            uses_cmd_wrapper,
        }
    }

    #[cfg(target_os = "macos")]
    fn macos_open_app(app_name: &str) -> Self {
        Self {
            program: PathBuf::from("open"),
            args_prefix: vec![OsString::from("-a"), OsString::from(app_name)],
            uses_cmd_wrapper: false,
        }
    }
}

fn is_windows_script(path: &Path) -> bool {
    matches!(
        path.extension()
            .and_then(|ext| ext.to_str())
            .map(|ext| ext.to_ascii_lowercase())
            .as_deref(),
        Some("cmd" | "bat")
    )
}

/// Prefer `Code.exe` next to a `bin/code.cmd` shim so we spawn a GUI binary
/// instead of a console wrapper.
fn prefer_gui_binary(path: PathBuf) -> PathBuf {
    #[cfg(windows)]
    {
        if let Some(parent) = path.parent() {
            let same_dir = parent.join("Code.exe");
            if same_dir.is_file() {
                return same_dir;
            }
            if let Some(install_dir) = parent.parent() {
                let exe = install_dir.join("Code.exe");
                if exe.is_file() {
                    return exe;
                }
            }
        }
    }
    path
}

fn known_vscode_binaries() -> Vec<PathBuf> {
    let mut paths = Vec::new();

    #[cfg(windows)]
    {
        if let Some(local) = std::env::var_os("LOCALAPPDATA") {
            paths.push(
                PathBuf::from(local)
                    .join("Programs")
                    .join("Microsoft VS Code")
                    .join("Code.exe"),
            );
        }
        if let Some(program_files) = std::env::var_os("ProgramFiles") {
            paths.push(
                PathBuf::from(program_files)
                    .join("Microsoft VS Code")
                    .join("Code.exe"),
            );
        }
        if let Some(program_files_x86) = std::env::var_os("ProgramFiles(x86)") {
            paths.push(
                PathBuf::from(program_files_x86)
                    .join("Microsoft VS Code")
                    .join("Code.exe"),
            );
        }
    }

    #[cfg(target_os = "macos")]
    {
        paths.push(PathBuf::from(
            "/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code",
        ));
        paths.push(PathBuf::from("/usr/local/bin/code"));
        paths.push(PathBuf::from("/opt/homebrew/bin/code"));
        if let Some(home) = dirs::home_dir() {
            paths.push(
                home.join("Applications")
                    .join("Visual Studio Code.app")
                    .join("Contents/Resources/app/bin/code"),
            );
        }
    }

    #[cfg(all(unix, not(target_os = "macos")))]
    {
        paths.push(PathBuf::from("/usr/bin/code"));
        paths.push(PathBuf::from("/usr/share/code/bin/code"));
        paths.push(PathBuf::from("/usr/share/code/code"));
        paths.push(PathBuf::from("/snap/bin/code"));
        if let Some(home) = dirs::home_dir() {
            paths.push(home.join(".local").join("bin").join("code"));
        }
    }

    paths
}

#[cfg(target_os = "macos")]
fn macos_app_candidates() -> Vec<PathBuf> {
    let mut apps = vec![PathBuf::from("/Applications/Visual Studio Code.app")];
    if let Some(home) = dirs::home_dir() {
        apps.push(home.join("Applications").join("Visual Studio Code.app"));
    }
    apps
}

fn resolve_vscode_launch() -> Option<VsCodeLaunch> {
    if let Some(path) = crate::commands::acp::resolve_command_on_path("code") {
        return Some(VsCodeLaunch::from_binary(path));
    }
    for candidate in known_vscode_binaries() {
        if candidate.is_file() {
            return Some(VsCodeLaunch::from_binary(candidate));
        }
    }
    #[cfg(target_os = "macos")]
    {
        if macos_app_candidates().iter().any(|app| app.is_dir()) {
            return Some(VsCodeLaunch::macos_open_app("Visual Studio Code"));
        }
    }
    None
}

fn spawn_vscode(launch: &VsCodeLaunch, target: &Path) -> Result<(), AppCommandError> {
    let mut command = if launch.uses_cmd_wrapper {
        let mut cmd = std_command("cmd");
        cmd.arg("/C").arg(&launch.program);
        cmd
    } else {
        std_command(&launch.program)
    };
    for arg in &launch.args_prefix {
        command.arg(arg);
    }
    command
        .arg(target)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());

    command.spawn().map(|_| ()).map_err(|err| {
        AppCommandError::external_command(
            "Failed to launch Visual Studio Code",
            format!("{}: {err}", launch.program.display()),
        )
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::time::{Duration, Instant};

    #[cfg(unix)]
    use std::os::unix::fs::PermissionsExt;

    fn write_stub_recorder(dir: &Path, marker: &Path) -> PathBuf {
        #[cfg(windows)]
        {
            let stub = dir.join("code.cmd");
            fs::write(
                &stub,
                format!("@echo off\r\necho %1>\"{}\"\r\n", marker.display()),
            )
            .expect("write stub");
            stub
        }
        #[cfg(not(windows))]
        {
            let stub = dir.join("code");
            fs::write(
                &stub,
                format!(
                    "#!/bin/sh\nprintf '%s\\n' \"$1\" > \"{}\"\n",
                    marker.display()
                ),
            )
            .expect("write stub");
            let mut perms = fs::metadata(&stub).expect("stat stub").permissions();
            perms.set_mode(0o755);
            fs::set_permissions(&stub, perms).expect("chmod stub");
            stub
        }
    }

    fn wait_for_marker(marker: &Path) -> String {
        let deadline = Instant::now() + Duration::from_secs(3);
        loop {
            if let Ok(contents) = fs::read_to_string(marker) {
                let trimmed = contents.trim().to_string();
                if !trimmed.is_empty() {
                    return trimmed;
                }
            }
            if Instant::now() >= deadline {
                panic!("stub did not write marker at {}", marker.display());
            }
            std::thread::sleep(Duration::from_millis(20));
        }
    }

    #[test]
    fn validate_rejects_empty_path() {
        let err = validate_open_in_code_path("  ").expect_err("empty");
        assert!(err.message.contains("required"), "{err:?}");
    }

    #[test]
    fn validate_rejects_control_characters() {
        let err = validate_open_in_code_path("/tmp/foo\nbar").expect_err("newline");
        assert!(err.message.contains("control"), "{err:?}");
    }

    #[test]
    fn validate_rejects_missing_path() {
        let err = validate_open_in_code_path("/definitely/not/a/codeg/path").expect_err("missing");
        assert!(err.message.contains("does not exist"), "{err:?}");
    }

    #[test]
    fn validate_accepts_existing_directory() {
        let dir = tempfile::tempdir().expect("tempdir");
        let resolved =
            validate_open_in_code_path(dir.path().to_str().expect("utf8")).expect("existing dir");
        assert_eq!(resolved, dir.path());
    }

    #[test]
    fn from_binary_marks_cmd_wrapper_on_scripts() {
        let launch = VsCodeLaunch::from_binary(PathBuf::from("C:/tools/code.cmd"));
        assert!(launch.uses_cmd_wrapper);
        let exe = VsCodeLaunch::from_binary(PathBuf::from("C:/tools/Code.exe"));
        assert!(!exe.uses_cmd_wrapper);
    }

    #[test]
    fn known_binaries_include_platform_install_locations() {
        let paths = known_vscode_binaries();
        #[cfg(windows)]
        {
            assert!(
                paths
                    .iter()
                    .any(|p| p.ends_with("Microsoft VS Code\\Code.exe")
                        || p.ends_with("Microsoft VS Code/Code.exe")),
                "{paths:?}"
            );
        }
        #[cfg(target_os = "macos")]
        {
            assert!(
                paths
                    .iter()
                    .any(|p| p.to_string_lossy().contains("Visual Studio Code.app")),
                "{paths:?}"
            );
        }
        #[cfg(all(unix, not(target_os = "macos")))]
        {
            assert!(
                paths.iter().any(|p| p == Path::new("/usr/bin/code")),
                "{paths:?}"
            );
        }
    }

    #[test]
    fn spawn_runs_stub_with_target_path() {
        let dir = tempfile::tempdir().expect("tempdir");
        let target = dir.path().join("workspace");
        fs::create_dir(&target).expect("mkdir target");
        let marker = dir.path().join("marker.txt");
        let stub = write_stub_recorder(dir.path(), &marker);
        let launch = VsCodeLaunch::from_binary(stub);
        spawn_vscode(&launch, &target).expect("spawn stub");
        let recorded = wait_for_marker(&marker);
        let expected = target.to_string_lossy();
        assert!(
            recorded.contains(expected.as_ref()),
            "stub recorded {recorded:?}, expected to contain {expected:?}"
        );
    }

    #[test]
    fn open_in_code_core_errors_when_path_missing() {
        let err = open_in_code_core("/no/such/codeg/open-in-code-target".into())
            .expect_err("missing path");
        assert!(err.message.contains("does not exist"), "{err:?}");
    }
}
