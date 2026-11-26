//! H-30 / CB-6 / rulings 635+638+724 — exclusive supervisor lease for live `hz-kernel`.
//!
//! Exactly one live `hz-kernel` owner per state dir (stdio **or** `--socket`): a
//! non-blocking cross-process file lock on `<state>/hzk.supervisor.lock`. A second
//! live owner fails closed with `supervisor.lease_held` (includes held epoch/pid when
//! known). Process death releases the lock so a successor can acquire.
//! Host-wide (cross-state-dir) lease is `host_supervisor_lease` (ruling **703**).

use std::fs;
use std::path::{Path, PathBuf};

use crate::os_file_lock::ExclusiveOsFileLock;
use crate::supervisor_epoch;

/// Held exclusive supervisor lease. Dropping unlocks (process exit also unlocks).
#[derive(Debug)]
pub struct SupervisorLease {
    lock: Option<ExclusiveOsFileLock>,
    #[allow(dead_code)]
    pub path: PathBuf,
}

impl SupervisorLease {
    /// Acquire exclusive non-blocking lock on `hzk.supervisor.lock`.
    ///
    /// Set `HZ_SUPERVISOR_LEASE=0` to skip (integration tests that still prove
    /// cross-process event-log flock under a multi-owner topology). Product
    /// default remains exclusive lease on.
    pub fn try_acquire(state_dir: &Path) -> Result<Self, String> {
        if supervisor_lease_disabled() {
            let path = state_dir.join("hzk.supervisor.lock");
            let _ = fs::create_dir_all(state_dir);
            let _placeholder = fs::OpenOptions::new()
                .read(true)
                .write(true)
                .create(true)
                .truncate(false)
                .open(&path)
                .map_err(|e| {
                    format!("HZ_PRECONDITION_FAILED: supervisor lease unavailable: {e}")
                })?;
            return Ok(Self { lock: None, path });
        }
        let _ = fs::create_dir_all(state_dir);
        let path = state_dir.join("hzk.supervisor.lock");
        #[cfg(not(any(unix, windows)))]
        {
            let _ = path;
            return Err(
                "HZ_PRECONDITION_FAILED: supervisor.lease_held unsupported on this OS".into(),
            );
        }
        #[cfg(any(unix, windows))]
        {
            match ExclusiveOsFileLock::try_acquire(&path) {
                Ok(lock) => {
                    let _ = lock.write_pid(std::process::id());
                    Ok(Self {
                        lock: Some(lock),
                        path,
                    })
                }
                Err(()) => {
                    let held_epoch = supervisor_epoch::read_supervisor_epoch(state_dir);
                    let held_pid = read_pid_file(state_dir);
                    Err(format!(
                        "HZ_PRECONDITION_FAILED: supervisor.lease_held (epoch={} pid={})",
                        held_epoch
                            .map(|e| e.to_string())
                            .unwrap_or_else(|| "unknown".into()),
                        held_pid
                            .map(|p| p.to_string())
                            .unwrap_or_else(|| "unknown".into()),
                    ))
                }
            }
        }
    }
}

fn supervisor_lease_disabled() -> bool {
    match std::env::var("HZ_SUPERVISOR_LEASE") {
        Ok(raw) => {
            let v = raw.trim().to_ascii_lowercase();
            v == "0" || v == "false" || v == "off" || v == "no"
        }
        Err(_) => false,
    }
}

fn read_pid_file(state_dir: &Path) -> Option<u32> {
    let raw = fs::read_to_string(state_dir.join("hzk.pid")).ok()?;
    raw.trim().parse::<u32>().ok().filter(|p| *p > 0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn exclusive_supervisor_lease_blocks_second_holder() {
        let dir = std::env::temp_dir().join(format!("hz-sup-lease-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let first = SupervisorLease::try_acquire(&dir).expect("first acquire");
        let second = SupervisorLease::try_acquire(&dir);
        assert!(second.is_err(), "{second:?}");
        let err = second.unwrap_err();
        assert!(err.contains("supervisor.lease_held"), "{err}");
        drop(first);
        let third = SupervisorLease::try_acquire(&dir).expect("after release");
        drop(third);
        let _ = fs::remove_dir_all(&dir);
    }
}
