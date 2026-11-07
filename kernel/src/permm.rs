//! Filesystem hardening: owner-only state directories and state files.
//!
//! The kernel state dir holds event payloads, receipts and leases — nothing in
//! it is meant to be world-readable. New directories are created 0700 and new
//! files 0600 on unix; existing files keep whatever mode they already have. On
//! other platforms every function here is a no-op.

use std::fs::OpenOptions;
use std::path::Path;

/// Restrict a directory to its owner (0700 on unix).
pub fn private_dir(path: &Path) {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700));
    }
    #[cfg(not(unix))]
    {
        let _ = path;
    }
}

/// Open options for append-only state files: create if absent, append, 0600.
pub fn append_options() -> OpenOptions {
    let mut options = OpenOptions::new();
    options.create(true).append(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    options
}

/// Create or replace a state file, owner-only (0600 on unix).
pub fn write_new(path: &Path, contents: &[u8]) -> std::io::Result<()> {
    use std::io::Write;
    let mut options = OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(path)?;
    file.write_all(contents)?;
    file.flush()
}
