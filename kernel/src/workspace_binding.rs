//! H-31 workspace identity: bind authority to `(root, device, inode)`, not a
//! path string alone (docs/03 H-31; ruling 623).
//!
//! A symlink swap or remount that preserves the path text but changes the
//! underlying directory identity MUST NOT inherit the launch-time binding.

use std::fs;
use std::path::{Path, PathBuf};

use serde_json::{json, Value};

#[cfg(unix)]
use std::os::unix::fs::MetadataExt;

use crate::guard;

/// Launch-time workspace identity used by a bound kernel.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorkspaceBinding {
    /// Lexically resolved absolute root captured at launch.
    pub root: PathBuf,
    pub device: u64,
    pub inode: u64,
}

impl WorkspaceBinding {
    /// Resolve `path` and capture its directory `(device, inode)`.
    pub fn capture(path: &Path) -> Result<Self, String> {
        let resolved = guard::lexical_resolve(path).ok_or_else(|| {
            format!(
                "HZ_PRECONDITION_FAILED: workspace binding could not resolve {}",
                path.display()
            )
        })?;
        let meta = fs::metadata(&resolved).map_err(|e| {
            format!(
                "HZ_PRECONDITION_FAILED: workspace binding could not stat {}: {e}",
                resolved.display()
            )
        })?;
        if !meta.is_dir() {
            return Err(format!(
                "HZ_PRECONDITION_FAILED: workspace binding root is not a directory: {}",
                resolved.display()
            ));
        }
        let (device, inode) = capture_identity(&resolved, &meta)?;
        Ok(Self {
            root: resolved,
            device,
            inode,
        })
    }

    /// True when `path` resolves to the same directory identity as this binding.
    #[allow(dead_code)] // public helper; unit tests + future Guard digest callers
    pub fn matches_path(&self, path: &Path) -> Result<bool, String> {
        self.check_path(path).map(|_| true).or_else(|err| {
            if err.contains("device,inode") || err.contains("does not equal") {
                Ok(false)
            } else {
                Err(err)
            }
        })
    }

    /// Enforce path + `(device, inode)` against the launch-time binding.
    /// Distinct errors preserve widen-vs-swap diagnostics for callers/tests.
    pub fn check_path(&self, path: &Path) -> Result<(), String> {
        let live = Self::capture(path)?;
        if live.root != self.root {
            return Err(
                "HZ_PRECONDITION_FAILED: effect.execute sandboxRoot does not equal kernel-bound workspace root"
                    .into(),
            );
        }
        if live.device != self.device || live.inode != self.inode {
            return Err(
                "HZ_PRECONDITION_FAILED: effect.execute sandboxRoot identity (device,inode) does not match kernel-bound workspace"
                    .into(),
            );
        }
        Ok(())
    }

    /// Wire shape for ping / doctor (no secrets).
    pub fn to_json(&self) -> Value {
        json!({
            "root": self.root.to_string_lossy(),
            "device": self.device,
            "inode": self.inode,
        })
    }
}

#[cfg(unix)]
fn capture_identity(_resolved: &Path, meta: &fs::Metadata) -> Result<(u64, u64), String> {
    Ok((meta.dev(), meta.ino()))
}

#[cfg(windows)]
fn capture_identity(resolved: &Path, _meta: &fs::Metadata) -> Result<(u64, u64), String> {
    use std::os::windows::fs::OpenOptionsExt;
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::Foundation::HANDLE;
    use windows_sys::Win32::Storage::FileSystem::{
        GetFileInformationByHandle, BY_HANDLE_FILE_INFORMATION, FILE_FLAG_BACKUP_SEMANTICS,
        FILE_READ_ATTRIBUTES,
    };

    let dir_handle = fs::OpenOptions::new()
        .access_mode(FILE_READ_ATTRIBUTES)
        .custom_flags(FILE_FLAG_BACKUP_SEMANTICS)
        .open(resolved)
        .map_err(|e| {
            format!(
                "HZ_PRECONDITION_FAILED: workspace binding could not open directory {}: {e}",
                resolved.display()
            )
        })?;
    let mut info: BY_HANDLE_FILE_INFORMATION = unsafe { std::mem::zeroed() };
    let ok =
        unsafe { GetFileInformationByHandle(dir_handle.as_raw_handle() as HANDLE, &mut info) };
    if ok == 0 {
        let err = std::io::Error::last_os_error();
        return Err(format!(
            "HZ_PRECONDITION_FAILED: workspace binding could not query directory identity for {}: {err}",
            resolved.display()
        ));
    }
    let device = info.dwVolumeSerialNumber as u64;
    let inode = ((info.nFileIndexHigh as u64) << 32) | (info.nFileIndexLow as u64);
    Ok((device, inode))
}

#[cfg(not(any(unix, windows)))]
fn capture_identity(_resolved: &Path, _meta: &fs::Metadata) -> Result<(u64, u64), String> {
    Err("HZ_PRECONDITION_FAILED: workspace binding identity unsupported on this OS".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn scratch(tag: &str) -> PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("hz-ws-bind-{tag}-{nanos}"));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn capture_round_trips_same_directory() {
        let dir = scratch("ok");
        let a = WorkspaceBinding::capture(&dir).unwrap();
        let b = WorkspaceBinding::capture(&dir).unwrap();
        assert_eq!(a, b);
        assert!(a.matches_path(&dir).unwrap());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn replaced_directory_inode_does_not_match() {
        let parent = scratch("parent");
        let bound_path = parent.join("ws");
        let decoy = parent.join("decoy");
        fs::create_dir_all(&bound_path).unwrap();
        fs::create_dir_all(&decoy).unwrap();
        let binding = WorkspaceBinding::capture(&bound_path).unwrap();

        // Rename-swap: rmdir+mkdir often reuses the same inode on Linux/tmpfs.
        fs::rename(&bound_path, parent.join("ws.old")).unwrap();
        fs::rename(&decoy, &bound_path).unwrap();
        assert!(!binding.matches_path(&bound_path).unwrap());
        let err = binding.check_path(&bound_path).unwrap_err();
        assert!(
            err.contains("device,inode") || err.contains("identity"),
            "{err}"
        );
        let _ = fs::remove_dir_all(&parent);
    }
}
