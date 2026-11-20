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
        Ok(Self {
            root: resolved,
            device: meta_device(&meta),
            inode: meta_inode(&meta),
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
fn meta_device(meta: &fs::Metadata) -> u64 {
    meta.dev()
}

#[cfg(unix)]
fn meta_inode(meta: &fs::Metadata) -> u64 {
    meta.ino()
}

#[cfg(not(unix))]
fn meta_device(_meta: &fs::Metadata) -> u64 {
    0
}

#[cfg(not(unix))]
fn meta_inode(_meta: &fs::Metadata) -> u64 {
    0
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
        assert!(err.contains("device,inode") || err.contains("identity"), "{err}");
        let _ = fs::remove_dir_all(&parent);
    }
}
