//! H-30 / CB-6 / ruling **703** + **724** — host-wide exclusive supervisor lease.
//!
//! Exactly one live `hz-kernel` per UID: a non-blocking cross-process lock on
//! `$XDG_RUNTIME_DIR/horizon/hzk.host.lock` (Unix fallback
//! `~/.local/share/horizon/hzk.host.lock`; Windows `%LOCALAPPDATA%\\horizon\\hzk.host.lock`).
//! Complements per-state-dir `supervisor_lease` so two workspaces cannot each
//! own a live kernel. Does **not** cover Windows `--socket` peer lease (H-29).

use std::fs::{self, OpenOptions};
use std::path::{Path, PathBuf};

use serde_json::{json, Value};

use crate::os_file_lock::ExclusiveOsFileLock;

/// Held host-wide lease. Dropping unlocks (process exit also unlocks).
#[derive(Debug)]
pub struct HostSupervisorLease {
    #[allow(dead_code)]
    lock: Option<ExclusiveOsFileLock>,
    pub path: PathBuf,
}

/// Resolved lock path for doctor / `ping` honesty (no lock taken).
pub fn host_lock_path() -> PathBuf {
    #[cfg(windows)]
    {
        if let Ok(local) = std::env::var("LOCALAPPDATA") {
            let trimmed = local.trim();
            if !trimmed.is_empty() {
                return PathBuf::from(trimmed).join("horizon").join("hzk.host.lock");
            }
        }
        if let Ok(home) = std::env::var("USERPROFILE") {
            let trimmed = home.trim();
            if !trimmed.is_empty() {
                return PathBuf::from(trimmed)
                    .join("AppData")
                    .join("Local")
                    .join("horizon")
                    .join("hzk.host.lock");
            }
        }
        return PathBuf::from("horizon").join("hzk.host.lock");
    }
    #[cfg(not(windows))]
    {
        if let Ok(dir) = std::env::var("XDG_RUNTIME_DIR") {
            let trimmed = dir.trim();
            if !trimmed.is_empty() {
                return PathBuf::from(trimmed).join("horizon").join("hzk.host.lock");
            }
        }
        if let Ok(home) = std::env::var("HOME") {
            let trimmed = home.trim();
            if !trimmed.is_empty() {
                return PathBuf::from(trimmed)
                    .join(".local")
                    .join("share")
                    .join("horizon")
                    .join("hzk.host.lock");
            }
        }
        PathBuf::from(".local/share/horizon/hzk.host.lock")
    }
}

/// Additive `ping.hostSupervisorLease` wire (no secrets).
pub fn host_supervisor_lease_json() -> Value {
    json!({
        "path": host_lock_path().display().to_string(),
        "unixFlock": cfg!(unix),
        "windowsFileLock": cfg!(windows),
        "crossProcessLock": cfg!(any(unix, windows)),
    })
}

fn host_lease_disabled() -> bool {
    match std::env::var("HZ_SUPERVISOR_LEASE") {
        Ok(raw) => {
            let v = raw.trim().to_ascii_lowercase();
            v == "0" || v == "false" || v == "off" || v == "no"
        }
        Err(_) => false,
    }
}

impl HostSupervisorLease {
    /// Acquire exclusive non-blocking lock on the host-wide lock file.
    ///
    /// Set `HZ_SUPERVISOR_LEASE=0` to skip (same escape as per-state lease
    /// for multi-owner integration topology).
    pub fn try_acquire() -> Result<Self, String> {
        let path = host_lock_path();
        if host_lease_disabled() {
            ensure_parent(&path)?;
            let _placeholder = OpenOptions::new()
                .read(true)
                .write(true)
                .create(true)
                .truncate(false)
                .open(&path)
                .map_err(|e| {
                    format!("HZ_PRECONDITION_FAILED: host supervisor lease unavailable: {e}")
                })?;
            return Ok(Self { lock: None, path });
        }
        #[cfg(not(any(unix, windows)))]
        {
            return Err(
                "HZ_PRECONDITION_FAILED: supervisor.host_lease_held unsupported on this OS".into(),
            );
        }
        #[cfg(any(unix, windows))]
        {
            ensure_parent(&path)?;
            match ExclusiveOsFileLock::try_acquire(&path) {
                Ok(lock) => {
                    let _ = fs::write(&path, format!("{}\n", std::process::id()));
                    Ok(Self { lock: Some(lock), path })
                }
                Err(()) => {
                    let held_pid = read_host_lock_pid(&path);
                    Err(format!(
                        "HZ_PRECONDITION_FAILED: supervisor.host_lease_held (pid={})",
                        held_pid
                            .map(|p| p.to_string())
                            .unwrap_or_else(|| "unknown".into()),
                    ))
                }
            }
        }
    }
}

fn ensure_parent(path: &Path) -> Result<(), String> {
    let parent = path.parent().unwrap_or(Path::new("."));
    fs::create_dir_all(parent).map_err(|e| {
        format!("HZ_PRECONDITION_FAILED: host supervisor lease unavailable: {e}")
    })
}

fn read_host_lock_pid(path: &Path) -> Option<u32> {
    let raw = fs::read_to_string(path).ok()?;
    raw.trim().parse::<u32>().ok().filter(|p| *p > 0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};

    fn isolated_runtime() -> PathBuf {
        static SEQ: AtomicU64 = AtomicU64::new(0);
        let dir = std::env::temp_dir().join(format!(
            "hz-host-lease-{}-{}",
            std::process::id(),
            SEQ.fetch_add(1, Ordering::SeqCst)
        ));
        let _ = fs::create_dir_all(&dir);
        dir
    }

    #[test]
    fn exclusive_host_supervisor_lease_blocks_second_holder() {
        let runtime = isolated_runtime();
        let prev = std::env::var("XDG_RUNTIME_DIR").ok();
        std::env::set_var("XDG_RUNTIME_DIR", &runtime);
        let first = HostSupervisorLease::try_acquire().expect("first host acquire");
        let second = HostSupervisorLease::try_acquire();
        assert!(second.is_err(), "{second:?}");
        let err = second.unwrap_err();
        assert!(err.contains("supervisor.host_lease_held"), "{err}");
        drop(first);
        let third = HostSupervisorLease::try_acquire().expect("after release");
        drop(third);
        match prev {
            Some(v) => std::env::set_var("XDG_RUNTIME_DIR", v),
            None => std::env::remove_var("XDG_RUNTIME_DIR"),
        }
        let _ = fs::remove_dir_all(&runtime);
    }
}