//! When a process started — the half of a process's identity a pid does not
//! carry.
//!
//! Pids are reused. A window grant bound to "pid 4312" would pass, after that
//! application quits, to whatever the system hands 4312 next; bound to "pid
//! 4312 that started at T" it cannot. The value is opaque and only ever
//! compared for equality, so each platform reports whatever it has most
//! cheaply: microseconds since the epoch on macOS, clock ticks since boot on
//! Linux, a FILETIME on Windows.
//!
//! None of this is TCC-governed on macOS: `proc_pidinfo` on another user
//! process of the same user is an ordinary BSD query.

/// `pid`'s start stamp, or `None` when it is not running (or the platform
/// will not say).
pub fn process_start(pid: u32) -> Option<u64> {
    if pid == 0 {
        return None;
    }
    imp::process_start(pid)
}

#[cfg(target_os = "macos")]
mod imp {
    pub fn process_start(pid: u32) -> Option<u64> {
        let pid = libc::c_int::try_from(pid).ok()?;
        let mut info = std::mem::MaybeUninit::<libc::proc_bsdinfo>::zeroed();
        let size = std::mem::size_of::<libc::proc_bsdinfo>() as libc::c_int;
        // SAFETY: `info` is a zeroed buffer of exactly `size` bytes, which is
        // what `proc_pidinfo` fills for PROC_PIDTBSDINFO; it returns the byte
        // count written, and anything short of the whole struct is treated as
        // failure before the buffer is read.
        let written = unsafe {
            libc::proc_pidinfo(
                pid,
                libc::PROC_PIDTBSDINFO,
                0,
                info.as_mut_ptr().cast(),
                size,
            )
        };
        if written != size {
            return None;
        }
        // SAFETY: fully written, checked above.
        let info = unsafe { info.assume_init() };
        Some(
            info.pbi_start_tvsec
                .saturating_mul(1_000_000)
                .saturating_add(info.pbi_start_tvusec),
        )
    }
}

#[cfg(target_os = "linux")]
mod imp {
    pub fn process_start(pid: u32) -> Option<u64> {
        let stat = std::fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
        parse_stat_start(&stat)
    }

    /// Field 22 of `/proc/<pid>/stat` (`starttime`). The second field is the
    /// command name in parentheses and may itself contain spaces and
    /// parentheses, so fields are counted from the LAST `)`.
    pub(super) fn parse_stat_start(stat: &str) -> Option<u64> {
        let after_comm = &stat[stat.rfind(')')? + 1..];
        // After the comm come field 3 (state) onward; starttime is field 22,
        // i.e. the 20th whitespace-separated token from here.
        after_comm.split_whitespace().nth(19)?.parse().ok()
    }
}

#[cfg(windows)]
mod imp {
    use windows_sys::Win32::Foundation::{CloseHandle, FILETIME};
    use windows_sys::Win32::System::Threading::{
        GetProcessTimes, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION,
    };

    pub fn process_start(pid: u32) -> Option<u64> {
        // SAFETY: OpenProcess returns a handle we own or null; it is closed on
        // every path below.
        let handle = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) };
        if handle.is_null() {
            return None;
        }
        let zero = FILETIME {
            dwLowDateTime: 0,
            dwHighDateTime: 0,
        };
        let (mut created, mut exited, mut kernel, mut user) = (zero, zero, zero, zero);
        // SAFETY: four valid out-pointers and a live handle.
        let ok =
            unsafe { GetProcessTimes(handle, &mut created, &mut exited, &mut kernel, &mut user) };
        // SAFETY: closing the handle opened above, exactly once.
        unsafe { CloseHandle(handle) };
        (ok != 0)
            .then(|| (u64::from(created.dwHighDateTime) << 32) | u64::from(created.dwLowDateTime))
    }
}

#[cfg(not(any(target_os = "macos", target_os = "linux", windows)))]
mod imp {
    pub fn process_start(_pid: u32) -> Option<u64> {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// This process has a start stamp, it does not change between two asks,
    /// and pid 0 has none.
    #[test]
    fn a_running_process_has_a_stable_start() {
        let me = std::process::id();
        let first = process_start(me);
        assert!(first.is_some());
        assert_eq!(first, process_start(me));
        assert_eq!(process_start(0), None);
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn a_command_name_with_parentheses_does_not_shift_the_fields() {
        let stat = "123 (a (weird) name) S 1 123 123 0 -1 4194560 100 0 0 0 1 2 0 0 20 0 1 0 \
                    987654 1000 50 18446744073709551615";
        assert_eq!(imp::parse_stat_start(stat), Some(987654));
    }
}
