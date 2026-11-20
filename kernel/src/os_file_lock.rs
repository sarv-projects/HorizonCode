//! Cross-process exclusive byte-range file lock for supervisor leases.
//!
//! Unix: non-blocking POSIX `flock(LOCK_EX|LOCK_NB)`.
//! Windows: non-blocking `LockFileEx` (`LOCKFILE_EXCLUSIVE_LOCK|FAIL_IMMEDIATELY`).
//! Other targets: unsupported (caller fails closed).

use std::fs::{File, OpenOptions};
use std::path::Path;

/// Held exclusive OS file lock. Dropping unlocks (process exit also releases).
#[derive(Debug)]
pub struct ExclusiveOsFileLock {
    file: File,
    #[cfg(windows)]
    overlapped: Box<windows_sys::Win32::System::IO::OVERLAPPED>,
}

impl ExclusiveOsFileLock {
    /// Open `path` (creating parent dirs) and take a non-blocking exclusive lock.
    pub fn try_acquire(path: &Path) -> Result<Self, ()> {
        if let Some(parent) = path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        let file = open_lock_file(path)?;
        Self::try_lock(file)
    }

    #[cfg(unix)]
    fn try_lock(file: File) -> Result<Self, ()> {
        use std::os::fd::AsRawFd;
        let rc = unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) };
        if rc != 0 {
            return Err(());
        }
        Ok(Self { file })
    }

    #[cfg(windows)]
    fn try_lock(file: File) -> Result<Self, ()> {
        use std::os::windows::io::AsRawHandle;
        use windows_sys::Win32::Foundation::HANDLE;
        use windows_sys::Win32::Storage::FileSystem::{
            LockFileEx, LOCKFILE_EXCLUSIVE_LOCK, LOCKFILE_FAIL_IMMEDIATELY,
        };
        let mut overlapped = Box::new(unsafe { std::mem::zeroed() });
        let handle = file.as_raw_handle() as HANDLE;
        let ok = unsafe {
            LockFileEx(
                handle,
                LOCKFILE_EXCLUSIVE_LOCK | LOCKFILE_FAIL_IMMEDIATELY,
                0,
                u32::MAX,
                u32::MAX,
                overlapped.as_mut(),
            )
        };
        if ok == 0 {
            return Err(());
        }
        Ok(Self { file, overlapped })
    }

    #[cfg(not(any(unix, windows)))]
    fn try_lock(_file: File) -> Result<Self, ()> {
        Err(())
    }

    pub fn file(&self) -> &File {
        &self.file
    }
}

impl Drop for ExclusiveOsFileLock {
    fn drop(&mut self) {
        #[cfg(unix)]
        {
            use std::os::fd::AsRawFd;
            unsafe {
                libc::flock(self.file.as_raw_fd(), libc::LOCK_UN);
            }
        }
        #[cfg(windows)]
        {
            use std::os::windows::io::AsRawHandle;
            use windows_sys::Win32::Foundation::HANDLE;
            use windows_sys::Win32::Storage::FileSystem::UnlockFileEx;
            let handle = self.file.as_raw_handle() as HANDLE;
            unsafe {
                let _ = UnlockFileEx(
                    handle,
                    0,
                    u32::MAX,
                    u32::MAX,
                    self.overlapped.as_mut(),
                );
            }
        }
    }
}

fn open_lock_file(path: &Path) -> Result<File, ()> {
    let mut opts = OpenOptions::new();
    opts.read(true).write(true).create(true).truncate(false);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.mode(0o600)
            .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC);
    }
    opts.open(path).map_err(|_| ())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::sync::atomic::{AtomicU64, Ordering};

    fn isolated_lock_path(name: &str) -> std::path::PathBuf {
        static SEQ: AtomicU64 = AtomicU64::new(0);
        std::env::temp_dir().join(format!(
            "hz-os-lock-{}-{}-{}",
            name,
            std::process::id(),
            SEQ.fetch_add(1, Ordering::SeqCst)
        ))
    }

    #[test]
    fn exclusive_os_file_lock_blocks_second_holder() {
        let path = isolated_lock_path("exclusive");
        let first = ExclusiveOsFileLock::try_acquire(&path).expect("first acquire");
        let second = ExclusiveOsFileLock::try_acquire(&path);
        assert!(second.is_err(), "{second:?}");
        drop(first);
        let third = ExclusiveOsFileLock::try_acquire(&path).expect("after release");
        drop(third);
        let _ = fs::remove_file(&path);
    }
}