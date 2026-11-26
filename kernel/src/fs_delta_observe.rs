//! P0-2 In-Kernel `O_NOFOLLOW` FS Primitives & OverlayFS/Snapshot FS-Delta Observer.
//!
//! Closes the post-parent-open TOCTOU race window for `touch`, `rm`, `mv`, and `install`
//! by anchoring every directory traversal and leaf operation to directory file descriptors
//! (`openat`/`fstatat`/`unlinkat`/`renameat`/`fchmod`/`futimens` with `O_NOFOLLOW` on Unix,
//! and reparse-point-refusing verified paths on Windows).
//!
//! Also provides an honest Linux/WSL2 `userns` + `overlayfs` capability probe and a
//! deterministic, symlink-safe `WorkspaceSnapshot` + `compute_fs_delta` observer for
//! recording exact preimage/postimage SHA-256 digests of arbitrary subprocesses.

#![allow(dead_code)]

use std::collections::BTreeMap;
use std::fs;
use std::io::Read;
use std::path::{Component, Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

/// Receipt returned by in-kernel `O_NOFOLLOW` filesystem primitives.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct FsOpReceipt {
    pub op: String,
    pub path: String,
    pub src_path: Option<String>,
    pub pre_sha256: Option<String>,
    pub post_sha256: Option<String>,
    pub src_sha256: Option<String>,
    pub existed_before: bool,
    pub exists_after: bool,
    pub mode: Option<u32>,
}

/// Honest runtime capability probe result for filesystem delta observation.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "backend", rename_all = "snake_case")]
pub enum FsObservationCapability {
    /// Unprivileged user namespaces and OverlayFS are both available on this Linux host.
    OverlayFsUserns,
    /// OverlayFS/userns unavailable or restricted; use deterministic workspace snapshot fallback.
    WorkspaceSnapshotFallback { reason: String },
}

/// File type recorded by `lstat` (never following symlinks).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SnapshotEntryType {
    RegularFile,
    Directory,
    Symlink,
    Other,
}

/// Single entry inside a deterministic `WorkspaceSnapshot`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SnapshotEntry {
    pub entry_type: SnapshotEntryType,
    pub size: u64,
    pub mtime_secs: i64,
    pub mtime_nanos: u32,
    pub sha256: Option<String>,
    pub skipped_oversize: bool,
}

/// Deterministic, symlink-safe snapshot of a workspace directory tree.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct WorkspaceSnapshot {
    pub root: String,
    pub entries: BTreeMap<String, SnapshotEntry>,
    pub truncated: bool,
    pub max_files: usize,
    pub max_file_bytes: u64,
}

/// Single created, modified, or deleted entry in `FsDeltaReport`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct FsDeltaEntry {
    pub path: String,
    pub before_type: Option<SnapshotEntryType>,
    pub after_type: Option<SnapshotEntryType>,
    pub before_size: Option<u64>,
    pub after_size: Option<u64>,
    pub before_sha256: Option<String>,
    pub after_sha256: Option<String>,
}

/// Deterministic delta between two `WorkspaceSnapshot` instances.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct FsDeltaReport {
    pub created: Vec<FsDeltaEntry>,
    pub modified: Vec<FsDeltaEntry>,
    pub deleted: Vec<FsDeltaEntry>,
}

impl FsDeltaReport {
    pub fn is_empty(&self) -> bool {
        self.created.is_empty() && self.modified.is_empty() && self.deleted.is_empty()
    }
}

// ---------------------------------------------------------------------------
// Path normalization & validation (rejects absolute paths, `..`, empty, NUL)
// ---------------------------------------------------------------------------

fn split_safe_rel_path(rel_path: &Path) -> Result<(Vec<String>, String, String), String> {
    if rel_path.as_os_str().is_empty() {
        return Err("relative path must not be empty".to_string());
    }
    if rel_path.is_absolute() {
        return Err(format!(
            "refusing absolute path outside workspace contract: {}",
            rel_path.display()
        ));
    }

    let mut parts: Vec<String> = Vec::new();
    for comp in rel_path.components() {
        match comp {
            Component::CurDir => {}
            Component::Normal(os) => {
                let s = os
                    .to_str()
                    .ok_or_else(|| "path component is not valid UTF-8".to_string())?;
                if s.is_empty() || s == "." || s == ".." || s.contains('\0') {
                    return Err(format!("invalid path component: {:?}", s));
                }
                parts.push(s.to_string());
            }
            Component::ParentDir => {
                return Err(format!(
                    "refusing parent-dir traversal ('..') in relative path: {}",
                    rel_path.display()
                ));
            }
            Component::RootDir | Component::Prefix(_) => {
                return Err(format!(
                    "refusing rooted/prefixed path: {}",
                    rel_path.display()
                ));
            }
        }
    }

    let leaf = parts
        .pop()
        .ok_or_else(|| format!("path has no leaf component: {}", rel_path.display()))?;
    let normalized = if parts.is_empty() {
        leaf.clone()
    } else {
        format!("{}/{}", parts.join("/"), leaf)
    };
    Ok((parts, leaf, normalized))
}

fn sha256_hex_from_reader<R: Read>(mut reader: R) -> Result<String, String> {
    let mut hasher = Sha256::new();
    let mut buf = [0u8; 65536];
    loop {
        let n = reader
            .read(&mut buf)
            .map_err(|e| format!("read error while hashing: {}", e))?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    Ok(hex_encode(&hasher.finalize()))
}

fn hex_encode(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(bytes.len() * 2);
    for &b in bytes {
        out.push(HEX[(b >> 4) as usize] as char);
        out.push(HEX[(b & 0x0f) as usize] as char);
    }
    out
}

fn system_time_to_parts(st: Result<SystemTime, std::io::Error>) -> (i64, u32) {
    match st {
        Ok(t) => match t.duration_since(UNIX_EPOCH) {
            Ok(d) => (d.as_secs() as i64, d.subsec_nanos()),
            Err(e) => {
                let d = e.duration();
                (-(d.as_secs() as i64), d.subsec_nanos())
            }
        },
        Err(_) => (0, 0),
    }
}

// ---------------------------------------------------------------------------
// Unix in-kernel O_NOFOLLOW + openat/unlinkat/renameat/fchmod primitives
// ---------------------------------------------------------------------------

#[cfg(unix)]
mod unix_ops {
    use super::*;
    use std::ffi::CString;
    use std::io::Write;
    use std::os::unix::ffi::OsStrExt;
    use std::os::unix::io::{FromRawFd, RawFd};
    use std::sync::atomic::{AtomicU64, Ordering};

    static TMP_COUNTER: AtomicU64 = AtomicU64::new(1);

    struct OwnedFd(RawFd);

    impl OwnedFd {
        fn raw(&self) -> RawFd {
            self.0
        }

        fn into_raw(self) -> RawFd {
            let fd = self.0;
            std::mem::forget(self);
            fd
        }
    }

    impl Drop for OwnedFd {
        fn drop(&mut self) {
            if self.0 >= 0 {
                unsafe {
                    libc::close(self.0);
                }
            }
        }
    }

    fn path_to_cstring(p: &Path) -> Result<CString, String> {
        CString::new(p.as_os_str().as_bytes())
            .map_err(|_| format!("path contains interior NUL byte: {}", p.display()))
    }

    fn str_to_cstring(s: &str) -> Result<CString, String> {
        CString::new(s.as_bytes())
            .map_err(|_| format!("component contains interior NUL byte: {:?}", s))
    }

    fn fstat_fd(fd: RawFd) -> Result<libc::stat, String> {
        let mut st: libc::stat = unsafe { std::mem::zeroed() };
        let rc = unsafe { libc::fstat(fd, &mut st) };
        if rc != 0 {
            return Err(format!("fstat failed: {}", std::io::Error::last_os_error()));
        }
        Ok(st)
    }

    fn fstatat_nofollow(dir_fd: RawFd, leaf: &CString) -> Result<Option<libc::stat>, std::io::Error> {
        let mut st: libc::stat = unsafe { std::mem::zeroed() };
        let rc = unsafe {
            libc::fstatat(dir_fd, leaf.as_ptr(), &mut st, libc::AT_SYMLINK_NOFOLLOW)
        };
        if rc == 0 {
            Ok(Some(st))
        } else {
            let err = std::io::Error::last_os_error();
            if err.raw_os_error() == Some(libc::ENOENT) {
                Ok(None)
            } else {
                Err(err)
            }
        }
    }

    fn file_type_bits(st: &libc::stat) -> u32 {
        (st.st_mode as u32) & (libc::S_IFMT as u32)
    }

    fn is_symlink(st: &libc::stat) -> bool {
        file_type_bits(st) == (libc::S_IFLNK as u32)
    }

    fn is_regular(st: &libc::stat) -> bool {
        file_type_bits(st) == (libc::S_IFREG as u32)
    }

    fn is_dir(st: &libc::stat) -> bool {
        file_type_bits(st) == (libc::S_IFDIR as u32)
    }

    /// Opens `workspace` and traverses each parent component using
    /// `openat(..., O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)` so no intermediate
    /// symlink can escape `workspace`.
    fn open_parent_dir_no_escape(
        workspace: &Path,
        rel_path: &Path,
    ) -> Result<(OwnedFd, CString, String), (Option<i32>, String)> {
        let (parents, leaf, normalized) =
            split_safe_rel_path(rel_path).map_err(|e| (None, e))?;
        let leaf_c = str_to_cstring(&leaf).map_err(|e| (None, e))?;

        let ws_canon = fs::canonicalize(workspace).map_err(|e| {
            (
                e.raw_os_error(),
                format!("failed to canonicalize workspace {}: {}", workspace.display(), e),
            )
        })?;
        let ws_c = path_to_cstring(&ws_canon).map_err(|e| (None, e))?;

        let root_fd = unsafe {
            libc::open(
                ws_c.as_ptr(),
                libc::O_RDONLY | libc::O_DIRECTORY | libc::O_CLOEXEC,
            )
        };
        if root_fd < 0 {
            let err = std::io::Error::last_os_error();
            return Err((
                err.raw_os_error(),
                format!("failed to open workspace dir {}: {}", ws_canon.display(), err),
            ));
        }
        let mut cur = OwnedFd(root_fd);

        for seg in &parents {
            let seg_c = str_to_cstring(seg).map_err(|e| (None, e))?;
            let next_fd = unsafe {
                libc::openat(
                    cur.raw(),
                    seg_c.as_ptr(),
                    libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
                )
            };
            if next_fd < 0 {
                let err = std::io::Error::last_os_error();
                let code = err.raw_os_error();
                let msg = if code == Some(libc::ELOOP) || code == Some(libc::ENOTDIR) {
                    format!(
                        "symlink or non-directory escape refused at parent segment '{}' in '{}': {}",
                        seg, normalized, err
                    )
                } else {
                    format!(
                        "failed to open parent segment '{}' in '{}': {}",
                        seg, normalized, err
                    )
                };
                return Err((code, msg));
            }
            cur = OwnedFd(next_fd);
        }

        Ok((cur, leaf_c, normalized))
    }

    fn hash_regular_at(dir_fd: RawFd, leaf: &CString) -> Result<(String, u32), String> {
        let fd = unsafe {
            libc::openat(
                dir_fd,
                leaf.as_ptr(),
                libc::O_RDONLY | libc::O_NOFOLLOW | libc::O_CLOEXEC | libc::O_NONBLOCK,
            )
        };
        if fd < 0 {
            let err = std::io::Error::last_os_error();
            return Err(format!("openat(O_RDONLY|O_NOFOLLOW) failed: {}", err));
        }
        let owned = OwnedFd(fd);
        let st = fstat_fd(owned.raw())?;
        if !is_regular(&st) {
            return Err("refusing non-regular file during O_NOFOLLOW hash".to_string());
        }
        let mode = (st.st_mode as u32) & 0o7777;
        let file = unsafe { fs::File::from_raw_fd(owned.into_raw()) };
        let digest = sha256_hex_from_reader(file)?;
        Ok((digest, mode))
    }

    pub fn in_kernel_touch(workspace: &Path, rel_path: &Path) -> Result<FsOpReceipt, String> {
        let (parent_fd, leaf_c, normalized) =
            open_parent_dir_no_escape(workspace, rel_path).map_err(|(_, e)| e)?;

        let pre_stat = fstatat_nofollow(parent_fd.raw(), &leaf_c)
            .map_err(|e| format!("fstatat failed for '{}': {}", normalized, e))?;

        let (existed_before, pre_sha256) = match pre_stat {
            None => (false, None),
            Some(st) => {
                if is_symlink(&st) {
                    return Err(format!(
                        "refusing in_kernel_touch on symlink '{}'",
                        normalized
                    ));
                }
                if !is_regular(&st) {
                    return Err(format!(
                        "refusing in_kernel_touch on non-regular file '{}'",
                        normalized
                    ));
                }
                let (digest, _) = hash_regular_at(parent_fd.raw(), &leaf_c)?;
                (true, Some(digest))
            }
        };

        // Open or create leaf with O_NOFOLLOW | O_CREAT | O_WRONLY | O_NONBLOCK via openat.
        let fd = unsafe {
            libc::openat(
                parent_fd.raw(),
                leaf_c.as_ptr(),
                libc::O_NOFOLLOW | libc::O_CREAT | libc::O_WRONLY | libc::O_CLOEXEC | libc::O_NONBLOCK,
                0o644 as libc::c_uint,
            )
        };
        if fd < 0 {
            let err = std::io::Error::last_os_error();
            return Err(format!(
                "in_kernel_touch openat(O_NOFOLLOW|O_CREAT|O_WRONLY) failed for '{}': {}",
                normalized, err
            ));
        }
        let write_fd = OwnedFd(fd);
        let st = fstat_fd(write_fd.raw())?;
        if !is_regular(&st) {
            return Err(format!(
                "in_kernel_touch target '{}' is not a regular file",
                normalized
            ));
        }

        // Update atime/mtime to now on the already-opened regular file fd.
        let rc = unsafe { libc::futimens(write_fd.raw(), std::ptr::null()) };
        if rc != 0 {
            let err = std::io::Error::last_os_error();
            return Err(format!(
                "in_kernel_touch futimens failed for '{}': {}",
                normalized, err
            ));
        }
        let final_mode = (st.st_mode as u32) & 0o7777;
        drop(write_fd);

        let (post_sha256, _) = hash_regular_at(parent_fd.raw(), &leaf_c)?;

        Ok(FsOpReceipt {
            op: "touch".to_string(),
            path: normalized,
            src_path: None,
            pre_sha256,
            post_sha256: Some(post_sha256),
            src_sha256: None,
            existed_before,
            exists_after: true,
            mode: Some(final_mode),
        })
    }

    pub fn in_kernel_rm(
        workspace: &Path,
        rel_path: &Path,
        force: bool,
    ) -> Result<FsOpReceipt, String> {
        let (parent_fd, leaf_c, normalized) = match open_parent_dir_no_escape(workspace, rel_path) {
            Ok(v) => v,
            Err((Some(libc::ENOENT), _)) if force => {
                let (_, _, norm) = split_safe_rel_path(rel_path)?;
                return Ok(FsOpReceipt {
                    op: "rm".to_string(),
                    path: norm,
                    src_path: None,
                    pre_sha256: None,
                    post_sha256: None,
                    src_sha256: None,
                    existed_before: false,
                    exists_after: false,
                    mode: None,
                });
            }
            Err((_, e)) => return Err(e),
        };

        let pre_stat = fstatat_nofollow(parent_fd.raw(), &leaf_c)
            .map_err(|e| format!("fstatat failed for '{}': {}", normalized, e))?;

        let (existed_before, pre_sha256, pre_mode) = match pre_stat {
            None => {
                if force {
                    return Ok(FsOpReceipt {
                        op: "rm".to_string(),
                        path: normalized,
                        src_path: None,
                        pre_sha256: None,
                        post_sha256: None,
                        src_sha256: None,
                        existed_before: false,
                        exists_after: false,
                        mode: None,
                    });
                }
                return Err(format!("in_kernel_rm target not found: '{}'", normalized));
            }
            Some(st) => {
                if is_dir(&st) {
                    return Err(format!(
                        "in_kernel_rm refuses directory '{}'",
                        normalized
                    ));
                }
                if is_regular(&st) {
                    let (digest, mode) = hash_regular_at(parent_fd.raw(), &leaf_c)?;
                    (true, Some(digest), Some(mode))
                } else {
                    // Symlink or special file: never follow, unlinkat removes leaf itself.
                    (true, None, Some((st.st_mode as u32) & 0o7777))
                }
            }
        };

        let rc = unsafe { libc::unlinkat(parent_fd.raw(), leaf_c.as_ptr(), 0) };
        if rc != 0 {
            let err = std::io::Error::last_os_error();
            if force && err.raw_os_error() == Some(libc::ENOENT) {
                return Ok(FsOpReceipt {
                    op: "rm".to_string(),
                    path: normalized,
                    src_path: None,
                    pre_sha256: None,
                    post_sha256: None,
                    src_sha256: None,
                    existed_before: false,
                    exists_after: false,
                    mode: None,
                });
            }
            return Err(format!(
                "in_kernel_rm unlinkat failed for '{}': {}",
                normalized, err
            ));
        }

        Ok(FsOpReceipt {
            op: "rm".to_string(),
            path: normalized,
            src_path: None,
            pre_sha256,
            post_sha256: None,
            src_sha256: None,
            existed_before,
            exists_after: false,
            mode: pre_mode,
        })
    }

    pub fn in_kernel_mv(
        workspace: &Path,
        src_rel: &Path,
        dst_rel: &Path,
    ) -> Result<FsOpReceipt, String> {
        let (src_dir_fd, src_leaf_c, src_norm) =
            open_parent_dir_no_escape(workspace, src_rel).map_err(|(_, e)| e)?;
        let (dst_dir_fd, dst_leaf_c, dst_norm) =
            open_parent_dir_no_escape(workspace, dst_rel).map_err(|(_, e)| e)?;

        let src_stat = fstatat_nofollow(src_dir_fd.raw(), &src_leaf_c)
            .map_err(|e| format!("fstatat failed for src '{}': {}", src_norm, e))?
            .ok_or_else(|| format!("in_kernel_mv source not found: '{}'", src_norm))?;

        if is_symlink(&src_stat) {
            return Err(format!(
                "refusing in_kernel_mv of symlink source '{}'",
                src_norm
            ));
        }

        let src_sha256 = if is_regular(&src_stat) {
            Some(hash_regular_at(src_dir_fd.raw(), &src_leaf_c)?.0)
        } else {
            None
        };

        let dst_stat = fstatat_nofollow(dst_dir_fd.raw(), &dst_leaf_c)
            .map_err(|e| format!("fstatat failed for dst '{}': {}", dst_norm, e))?;

        let (existed_before, pre_sha256) = match dst_stat {
            None => (false, None),
            Some(st) => {
                if is_symlink(&st) {
                    return Err(format!(
                        "refusing in_kernel_mv onto symlink destination '{}'",
                        dst_norm
                    ));
                }
                if is_regular(&st) {
                    let (digest, _) = hash_regular_at(dst_dir_fd.raw(), &dst_leaf_c)?;
                    (true, Some(digest))
                } else {
                    (true, None)
                }
            }
        };

        let rc = unsafe {
            libc::renameat(
                src_dir_fd.raw(),
                src_leaf_c.as_ptr(),
                dst_dir_fd.raw(),
                dst_leaf_c.as_ptr(),
            )
        };
        if rc != 0 {
            let err = std::io::Error::last_os_error();
            return Err(format!(
                "in_kernel_mv renameat '{}' -> '{}' failed: {}",
                src_norm, dst_norm, err
            ));
        }

        let (post_sha256, final_mode) = if is_regular(&src_stat) {
            let (digest, mode) = hash_regular_at(dst_dir_fd.raw(), &dst_leaf_c)?;
            (Some(digest), Some(mode))
        } else {
            (None, Some((src_stat.st_mode as u32) & 0o7777))
        };

        Ok(FsOpReceipt {
            op: "mv".to_string(),
            path: dst_norm,
            src_path: Some(src_norm),
            pre_sha256,
            post_sha256,
            src_sha256,
            existed_before,
            exists_after: true,
            mode: final_mode,
        })
    }

    pub fn in_kernel_install(
        workspace: &Path,
        src_rel: &Path,
        dst_rel: &Path,
        mode: Option<u32>,
    ) -> Result<FsOpReceipt, String> {
        let (src_dir_fd, src_leaf_c, src_norm) =
            open_parent_dir_no_escape(workspace, src_rel).map_err(|(_, e)| e)?;
        let (dst_dir_fd, dst_leaf_c, dst_norm) =
            open_parent_dir_no_escape(workspace, dst_rel).map_err(|(_, e)| e)?;

        // Open source without following symlinks and verify regular file.
        let src_fd_raw = unsafe {
            libc::openat(
                src_dir_fd.raw(),
                src_leaf_c.as_ptr(),
                libc::O_RDONLY | libc::O_NOFOLLOW | libc::O_CLOEXEC | libc::O_NONBLOCK,
            )
        };
        if src_fd_raw < 0 {
            let err = std::io::Error::last_os_error();
            return Err(format!(
                "in_kernel_install openat(O_RDONLY|O_NOFOLLOW) failed for src '{}': {}",
                src_norm, err
            ));
        }
        let src_owned = OwnedFd(src_fd_raw);
        let src_stat = fstat_fd(src_owned.raw())?;
        if !is_regular(&src_stat) {
            return Err(format!(
                "in_kernel_install refuses non-regular source '{}'",
                src_norm
            ));
        }
        // Strip setuid/setgid/sticky bits so installed files can never gain special privileges.
        let target_mode = mode.unwrap_or(src_stat.st_mode as u32) & 0o777;

        // Inspect destination without following symlinks; refuse symlink/directory destination.
        let dst_stat = fstatat_nofollow(dst_dir_fd.raw(), &dst_leaf_c)
            .map_err(|e| format!("fstatat failed for dst '{}': {}", dst_norm, e))?;
        let (existed_before, pre_sha256) = match dst_stat {
            None => (false, None),
            Some(st) => {
                if is_symlink(&st) {
                    return Err(format!(
                        "refusing in_kernel_install onto symlink destination '{}'",
                        dst_norm
                    ));
                }
                if !is_regular(&st) {
                    return Err(format!(
                        "refusing in_kernel_install onto non-regular destination '{}'",
                        dst_norm
                    ));
                }
                let (digest, _) = hash_regular_at(dst_dir_fd.raw(), &dst_leaf_c)?;
                (true, Some(digest))
            }
        };

        // Create unique sibling temp file inside dst_dir_fd using O_EXCL | O_NOFOLLOW.
        let seq = TMP_COUNTER.fetch_add(1, Ordering::Relaxed);
        let pid = std::process::id();
        let tmp_name = format!(".hz-install-{}-{}.tmp", pid, seq);
        let tmp_c = str_to_cstring(&tmp_name)?;
        let tmp_fd_raw = unsafe {
            libc::openat(
                dst_dir_fd.raw(),
                tmp_c.as_ptr(),
                libc::O_WRONLY | libc::O_CREAT | libc::O_EXCL | libc::O_NOFOLLOW | libc::O_CLOEXEC,
                0o600 as libc::c_uint,
            )
        };
        if tmp_fd_raw < 0 {
            let err = std::io::Error::last_os_error();
            return Err(format!(
                "in_kernel_install failed to create atomic temp file '{}': {}",
                tmp_name, err
            ));
        }

        let copy_res: Result<String, String> = (|| {
            let mut src_file = unsafe { fs::File::from_raw_fd(src_owned.into_raw()) };
            let mut tmp_file = unsafe { fs::File::from_raw_fd(tmp_fd_raw) };
            let mut hasher = Sha256::new();
            let mut buf = [0u8; 65536];
            loop {
                let n = src_file
                    .read(&mut buf)
                    .map_err(|e| format!("read error copying '{}': {}", src_norm, e))?;
                if n == 0 {
                    break;
                }
                hasher.update(&buf[..n]);
                tmp_file
                    .write_all(&buf[..n])
                    .map_err(|e| format!("write error installing '{}': {}", dst_norm, e))?;
            }
            use std::os::unix::io::AsRawFd;
            let rc = unsafe { libc::fchmod(tmp_file.as_raw_fd(), target_mode as libc::mode_t) };
            if rc != 0 {
                let err = std::io::Error::last_os_error();
                return Err(format!(
                    "in_kernel_install fchmod(0o{:o}) failed for '{}': {}",
                    target_mode, dst_norm, err
                ));
            }
            let _ = tmp_file.sync_all();
            Ok(hex_encode(&hasher.finalize()))
        })();

        let digest = match copy_res {
            Ok(d) => d,
            Err(e) => {
                unsafe {
                    libc::unlinkat(dst_dir_fd.raw(), tmp_c.as_ptr(), 0);
                }
                return Err(e);
            }
        };

        // Re-check destination is not a symlink right before atomic renameat.
        if let Ok(Some(st)) = fstatat_nofollow(dst_dir_fd.raw(), &dst_leaf_c) {
            if is_symlink(&st) {
                unsafe {
                    libc::unlinkat(dst_dir_fd.raw(), tmp_c.as_ptr(), 0);
                }
                return Err(format!(
                    "refusing in_kernel_install onto raced symlink destination '{}'",
                    dst_norm
                ));
            }
        }

        let rc = unsafe {
            libc::renameat(
                dst_dir_fd.raw(),
                tmp_c.as_ptr(),
                dst_dir_fd.raw(),
                dst_leaf_c.as_ptr(),
            )
        };
        if rc != 0 {
            let err = std::io::Error::last_os_error();
            unsafe {
                libc::unlinkat(dst_dir_fd.raw(), tmp_c.as_ptr(), 0);
            }
            return Err(format!(
                "in_kernel_install renameat failed for '{}': {}",
                dst_norm, err
            ));
        }

        Ok(FsOpReceipt {
            op: "install".to_string(),
            path: dst_norm,
            src_path: Some(src_norm),
            pre_sha256,
            post_sha256: Some(digest.clone()),
            src_sha256: Some(digest),
            existed_before,
            exists_after: true,
            mode: Some(target_mode),
        })
    }

    pub fn hash_regular_file_nofollow(path: &Path) -> Result<String, String> {
        let c_path = path_to_cstring(path)?;
        let fd = unsafe {
            libc::open(
                c_path.as_ptr(),
                libc::O_RDONLY | libc::O_NOFOLLOW | libc::O_CLOEXEC | libc::O_NONBLOCK,
            )
        };
        if fd < 0 {
            let err = std::io::Error::last_os_error();
            return Err(format!(
                "open(O_RDONLY|O_NOFOLLOW) failed for {}: {}",
                path.display(),
                err
            ));
        }
        let owned = OwnedFd(fd);
        let st = fstat_fd(owned.raw())?;
        if !is_regular(&st) {
            return Err(format!(
                "refusing non-regular file during snapshot hash: {}",
                path.display()
            ));
        }
        let file = unsafe { fs::File::from_raw_fd(owned.into_raw()) };
        sha256_hex_from_reader(file)
    }
}

// ---------------------------------------------------------------------------
// Non-Unix (Windows) verified regular-file fallback implementations
// ---------------------------------------------------------------------------

#[cfg(not(unix))]
mod fallback_ops {
    use super::*;
    use std::io::Write;
    use std::sync::atomic::{AtomicU64, Ordering};

    static TMP_COUNTER: AtomicU64 = AtomicU64::new(1);

    fn resolve_parent_no_escape(
        workspace: &Path,
        rel_path: &Path,
    ) -> Result<(PathBuf, String, String), (Option<std::io::ErrorKind>, String)> {
        let (parents, leaf, normalized) =
            split_safe_rel_path(rel_path).map_err(|e| (None, e))?;
        let ws_canon = fs::canonicalize(workspace).map_err(|e| {
            (
                Some(e.kind()),
                format!("failed to canonicalize workspace {}: {}", workspace.display(), e),
            )
        })?;
        let mut cur = ws_canon.clone();
        for seg in &parents {
            cur.push(seg);
            let meta = fs::symlink_metadata(&cur).map_err(|e| {
                (
                    Some(e.kind()),
                    format!("parent segment '{}' in '{}' failed: {}", seg, normalized, e),
                )
            })?;
            if meta.file_type().is_symlink() || !meta.is_dir() {
                return Err((
                    None,
                    format!(
                        "symlink or non-directory escape refused at parent segment '{}' in '{}'",
                        seg, normalized
                    ),
                ));
            }
        }
        let parent_canon = fs::canonicalize(&cur).map_err(|e| {
            (
                Some(e.kind()),
                format!("failed to canonicalize parent of '{}': {}", normalized, e),
            )
        })?;
        if !parent_canon.starts_with(&ws_canon) {
            return Err((
                None,
                format!("parent directory escapes workspace for '{}'", normalized),
            ));
        }
        Ok((parent_canon, leaf, normalized))
    }

    pub fn hash_regular_file_nofollow(path: &Path) -> Result<String, String> {
        let meta = fs::symlink_metadata(path)
            .map_err(|e| format!("symlink_metadata failed for {}: {}", path.display(), e))?;
        if meta.file_type().is_symlink() || !meta.is_file() {
            return Err(format!(
                "refusing non-regular or symlink file: {}",
                path.display()
            ));
        }
        let file = fs::File::open(path)
            .map_err(|e| format!("open failed for {}: {}", path.display(), e))?;
        sha256_hex_from_reader(file)
    }

    pub fn in_kernel_touch(workspace: &Path, rel_path: &Path) -> Result<FsOpReceipt, String> {
        let (parent, leaf, normalized) =
            resolve_parent_no_escape(workspace, rel_path).map_err(|(_, e)| e)?;
        let target = parent.join(&leaf);
        let (existed_before, pre_sha256) = match fs::symlink_metadata(&target) {
            Ok(meta) => {
                if meta.file_type().is_symlink() || !meta.is_file() {
                    return Err(format!(
                        "refusing in_kernel_touch on symlink/non-regular '{}'",
                        normalized
                    ));
                }
                (true, Some(hash_regular_file_nofollow(&target)?))
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => (false, None),
            Err(e) => return Err(format!("symlink_metadata failed for '{}': {}", normalized, e)),
        };

        let file = fs::OpenOptions::new()
            .create(true)
            .write(true)
            .open(&target)
            .map_err(|e| format!("in_kernel_touch open failed for '{}': {}", normalized, e))?;
        let _ = file.set_modified(SystemTime::now());
        drop(file);

        let post_sha256 = hash_regular_file_nofollow(&target)?;
        Ok(FsOpReceipt {
            op: "touch".to_string(),
            path: normalized,
            src_path: None,
            pre_sha256,
            post_sha256: Some(post_sha256),
            src_sha256: None,
            existed_before,
            exists_after: true,
            mode: None,
        })
    }

    pub fn in_kernel_rm(
        workspace: &Path,
        rel_path: &Path,
        force: bool,
    ) -> Result<FsOpReceipt, String> {
        let (parent, leaf, normalized) = match resolve_parent_no_escape(workspace, rel_path) {
            Ok(v) => v,
            Err((Some(std::io::ErrorKind::NotFound), _)) if force => {
                let (_, _, norm) = split_safe_rel_path(rel_path)?;
                return Ok(FsOpReceipt {
                    op: "rm".to_string(),
                    path: norm,
                    src_path: None,
                    pre_sha256: None,
                    post_sha256: None,
                    src_sha256: None,
                    existed_before: false,
                    exists_after: false,
                    mode: None,
                });
            }
            Err((_, e)) => return Err(e),
        };
        let target = parent.join(&leaf);
        let (existed_before, pre_sha256) = match fs::symlink_metadata(&target) {
            Ok(meta) => {
                if meta.is_dir() && !meta.file_type().is_symlink() {
                    return Err(format!("in_kernel_rm refuses directory '{}'", normalized));
                }
                if meta.is_file() && !meta.file_type().is_symlink() {
                    (true, Some(hash_regular_file_nofollow(&target)?))
                } else {
                    (true, None)
                }
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound && force => {
                return Ok(FsOpReceipt {
                    op: "rm".to_string(),
                    path: normalized,
                    src_path: None,
                    pre_sha256: None,
                    post_sha256: None,
                    src_sha256: None,
                    existed_before: false,
                    exists_after: false,
                    mode: None,
                });
            }
            Err(e) => return Err(format!("in_kernel_rm stat failed for '{}': {}", normalized, e)),
        };

        if let Err(e) = fs::remove_file(&target) {
            if force && e.kind() == std::io::ErrorKind::NotFound {
                return Ok(FsOpReceipt {
                    op: "rm".to_string(),
                    path: normalized,
                    src_path: None,
                    pre_sha256: None,
                    post_sha256: None,
                    src_sha256: None,
                    existed_before: false,
                    exists_after: false,
                    mode: None,
                });
            }
            return Err(format!("in_kernel_rm failed for '{}': {}", normalized, e));
        }

        Ok(FsOpReceipt {
            op: "rm".to_string(),
            path: normalized,
            src_path: None,
            pre_sha256,
            post_sha256: None,
            src_sha256: None,
            existed_before,
            exists_after: false,
            mode: None,
        })
    }

    pub fn in_kernel_mv(
        workspace: &Path,
        src_rel: &Path,
        dst_rel: &Path,
    ) -> Result<FsOpReceipt, String> {
        let (src_parent, src_leaf, src_norm) =
            resolve_parent_no_escape(workspace, src_rel).map_err(|(_, e)| e)?;
        let (dst_parent, dst_leaf, dst_norm) =
            resolve_parent_no_escape(workspace, dst_rel).map_err(|(_, e)| e)?;
        let src_path = src_parent.join(&src_leaf);
        let dst_path = dst_parent.join(&dst_leaf);

        let src_meta = fs::symlink_metadata(&src_path)
            .map_err(|e| format!("in_kernel_mv source not found '{}': {}", src_norm, e))?;
        if src_meta.file_type().is_symlink() {
            return Err(format!("refusing in_kernel_mv of symlink '{}'", src_norm));
        }
        let src_sha256 = if src_meta.is_file() {
            Some(hash_regular_file_nofollow(&src_path)?)
        } else {
            None
        };

        let (existed_before, pre_sha256) = match fs::symlink_metadata(&dst_path) {
            Ok(meta) => {
                if meta.file_type().is_symlink() {
                    return Err(format!(
                        "refusing in_kernel_mv onto symlink destination '{}'",
                        dst_norm
                    ));
                }
                if meta.is_file() {
                    (true, Some(hash_regular_file_nofollow(&dst_path)?))
                } else {
                    (true, None)
                }
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => (false, None),
            Err(e) => return Err(format!("dst stat failed for '{}': {}", dst_norm, e)),
        };

        fs::rename(&src_path, &dst_path).map_err(|e| {
            format!(
                "in_kernel_mv rename '{}' -> '{}' failed: {}",
                src_norm, dst_norm, e
            )
        })?;

        let post_sha256 = if src_meta.is_file() {
            Some(hash_regular_file_nofollow(&dst_path)?)
        } else {
            None
        };

        Ok(FsOpReceipt {
            op: "mv".to_string(),
            path: dst_norm,
            src_path: Some(src_norm),
            pre_sha256,
            post_sha256,
            src_sha256,
            existed_before,
            exists_after: true,
            mode: None,
        })
    }

    pub fn in_kernel_install(
        workspace: &Path,
        src_rel: &Path,
        dst_rel: &Path,
        mode: Option<u32>,
    ) -> Result<FsOpReceipt, String> {
        let (src_parent, src_leaf, src_norm) =
            resolve_parent_no_escape(workspace, src_rel).map_err(|(_, e)| e)?;
        let (dst_parent, dst_leaf, dst_norm) =
            resolve_parent_no_escape(workspace, dst_rel).map_err(|(_, e)| e)?;
        let src_path = src_parent.join(&src_leaf);
        let dst_path = dst_parent.join(&dst_leaf);

        let src_meta = fs::symlink_metadata(&src_path)
            .map_err(|e| format!("in_kernel_install source not found '{}': {}", src_norm, e))?;
        if src_meta.file_type().is_symlink() || !src_meta.is_file() {
            return Err(format!(
                "in_kernel_install refuses non-regular/symlink source '{}'",
                src_norm
            ));
        }
        let (existed_before, pre_sha256) = match fs::symlink_metadata(&dst_path) {
            Ok(meta) => {
                if meta.file_type().is_symlink() || !meta.is_file() {
                    return Err(format!(
                        "refusing in_kernel_install onto symlink/non-regular '{}'",
                        dst_norm
                    ));
                }
                (true, Some(hash_regular_file_nofollow(&dst_path)?))
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => (false, None),
            Err(e) => return Err(format!("dst stat failed for '{}': {}", dst_norm, e)),
        };

        let seq = TMP_COUNTER.fetch_add(1, Ordering::Relaxed);
        let tmp_path = dst_parent.join(format!(".hz-install-{}-{}.tmp", std::process::id(), seq));
        let mut src_file = fs::File::open(&src_path)
            .map_err(|e| format!("open src '{}' failed: {}", src_norm, e))?;
        let mut tmp_file = fs::OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&tmp_path)
            .map_err(|e| format!("create temp file failed: {}", e))?;
        let mut hasher = Sha256::new();
        let mut buf = [0u8; 65536];
        loop {
            let n = src_file
                .read(&mut buf)
                .map_err(|e| format!("read src failed: {}", e))?;
            if n == 0 {
                break;
            }
            hasher.update(&buf[..n]);
            tmp_file
                .write_all(&buf[..n])
                .map_err(|e| format!("write temp failed: {}", e))?;
        }
        let _ = tmp_file.sync_all();
        drop(tmp_file);
        let digest = hex_encode(&hasher.finalize());

        if let Err(e) = fs::rename(&tmp_path, &dst_path) {
            let _ = fs::remove_file(&tmp_path);
            return Err(format!("rename temp to '{}' failed: {}", dst_norm, e));
        }

        Ok(FsOpReceipt {
            op: "install".to_string(),
            path: dst_norm,
            src_path: Some(src_norm),
            pre_sha256,
            post_sha256: Some(digest.clone()),
            src_sha256: Some(digest),
            existed_before,
            exists_after: true,
            mode,
        })
    }
}

// ---------------------------------------------------------------------------
// Public In-Kernel O_NOFOLLOW FS Primitives
// ---------------------------------------------------------------------------

pub fn in_kernel_touch(workspace: &Path, rel_path: &Path) -> Result<FsOpReceipt, String> {
    #[cfg(unix)]
    {
        unix_ops::in_kernel_touch(workspace, rel_path)
    }
    #[cfg(not(unix))]
    {
        fallback_ops::in_kernel_touch(workspace, rel_path)
    }
}

pub fn in_kernel_rm(workspace: &Path, rel_path: &Path, force: bool) -> Result<FsOpReceipt, String> {
    #[cfg(unix)]
    {
        unix_ops::in_kernel_rm(workspace, rel_path, force)
    }
    #[cfg(not(unix))]
    {
        fallback_ops::in_kernel_rm(workspace, rel_path, force)
    }
}

pub fn in_kernel_mv(
    workspace: &Path,
    src_rel: &Path,
    dst_rel: &Path,
) -> Result<FsOpReceipt, String> {
    #[cfg(unix)]
    {
        unix_ops::in_kernel_mv(workspace, src_rel, dst_rel)
    }
    #[cfg(not(unix))]
    {
        fallback_ops::in_kernel_mv(workspace, src_rel, dst_rel)
    }
}

pub fn in_kernel_install(
    workspace: &Path,
    src_rel: &Path,
    dst_rel: &Path,
    mode: Option<u32>,
) -> Result<FsOpReceipt, String> {
    #[cfg(unix)]
    {
        unix_ops::in_kernel_install(workspace, src_rel, dst_rel, mode)
    }
    #[cfg(not(unix))]
    {
        fallback_ops::in_kernel_install(workspace, src_rel, dst_rel, mode)
    }
}

// ---------------------------------------------------------------------------
// Unprivileged userns + OverlayFS Capability Probe (Linux/WSL2)
// ---------------------------------------------------------------------------

/// Pure evaluator for Linux sysctl + `/proc/filesystems` probe inputs.
pub fn evaluate_linux_probe_inputs(
    apparmor_restrict_unpriv_userns: Option<&str>,
    unprivileged_userns_clone: Option<&str>,
    max_user_namespaces: Option<&str>,
    proc_filesystems: Option<&str>,
) -> FsObservationCapability {
    if let Some(val) = apparmor_restrict_unpriv_userns {
        if val.trim() == "1" {
            return FsObservationCapability::WorkspaceSnapshotFallback {
                reason: "ubuntu-24.04-apparmor-restrict-userns".to_string(),
            };
        }
    }
    if let Some(val) = unprivileged_userns_clone {
        if val.trim() == "0" {
            return FsObservationCapability::WorkspaceSnapshotFallback {
                reason: "unprivileged-userns-clone-disabled".to_string(),
            };
        }
    }
    if let Some(val) = max_user_namespaces {
        if val.trim() == "0" {
            return FsObservationCapability::WorkspaceSnapshotFallback {
                reason: "max-user-namespaces-zero".to_string(),
            };
        }
    }
    let has_overlay = proc_filesystems
        .map(|content| {
            content.lines().any(|line| {
                line.split_whitespace()
                    .any(|tok| tok == "overlay" || tok == "overlayfs")
            })
        })
        .unwrap_or(false);
    if !has_overlay {
        return FsObservationCapability::WorkspaceSnapshotFallback {
            reason: "overlayfs-unavailable".to_string(),
        };
    }

    FsObservationCapability::OverlayFsUserns
}

/// Probes whether unprivileged `userns` + `overlayfs` observation is supported on this host.
pub fn probe_fs_observation_backend() -> FsObservationCapability {
    #[cfg(target_os = "linux")]
    {
        let apparmor = fs::read_to_string("/proc/sys/kernel/apparmor_restrict_unprivileged_userns").ok();
        let unpriv_clone = fs::read_to_string("/proc/sys/kernel/unprivileged_userns_clone").ok();
        let max_user_ns = fs::read_to_string("/proc/sys/user/max_user_namespaces").ok();
        let proc_fs = fs::read_to_string("/proc/filesystems").ok();
        evaluate_linux_probe_inputs(
            apparmor.as_deref(),
            unpriv_clone.as_deref(),
            max_user_ns.as_deref(),
            proc_fs.as_deref(),
        )
    }
    #[cfg(not(target_os = "linux"))]
    {
        FsObservationCapability::WorkspaceSnapshotFallback {
            reason: "non-linux-host".to_string(),
        }
    }
}

// ---------------------------------------------------------------------------
// Cross-Platform Deterministic WorkspaceSnapshot & compute_fs_delta
// ---------------------------------------------------------------------------

fn should_skip_rel_dir(rel_norm: &str, dir_name: &str) -> bool {
    matches!(dir_name, ".git" | "node_modules" | "target")
        || rel_norm == ".hz/state/kernel"
        || rel_norm.starts_with(".hz/state/kernel/")
}

fn hash_file_for_snapshot(path: &Path) -> Result<String, String> {
    #[cfg(unix)]
    {
        unix_ops::hash_regular_file_nofollow(path)
    }
    #[cfg(not(unix))]
    {
        fallback_ops::hash_regular_file_nofollow(path)
    }
}

/// Walks `workspace` deterministically using `symlink_metadata` (`lstat`), never following
/// symlinks, skipping `.git`, `node_modules`, `target`, and `.hz/state/kernel`.
pub fn capture_workspace_snapshot(
    workspace: &Path,
    max_files: usize,
    max_file_bytes: u64,
) -> Result<WorkspaceSnapshot, String> {
    let ws_canon = fs::canonicalize(workspace)
        .map_err(|e| format!("failed to canonicalize workspace {}: {}", workspace.display(), e))?;
    if !ws_canon.is_dir() {
        return Err(format!(
            "workspace path is not a directory: {}",
            ws_canon.display()
        ));
    }

    let mut entries: BTreeMap<String, SnapshotEntry> = BTreeMap::new();
    let mut truncated = false;

    fn walk_dir(
        dir_abs: &Path,
        rel_prefix: &str,
        max_files: usize,
        max_file_bytes: u64,
        entries: &mut BTreeMap<String, SnapshotEntry>,
        truncated: &mut bool,
    ) -> Result<(), String> {
        let rd = fs::read_dir(dir_abs)
            .map_err(|e| format!("read_dir failed for {}: {}", dir_abs.display(), e))?;
        let mut children: Vec<(String, PathBuf)> = Vec::new();
        for item in rd {
            let entry = item.map_err(|e| format!("read_dir entry error: {}", e))?;
            let name = entry.file_name().to_string_lossy().to_string();
            children.push((name, entry.path()));
        }
        // Sort lexicographically for deterministic traversal and deterministic truncation.
        children.sort_by(|a, b| a.0.cmp(&b.0));

        for (name, child_abs) in children {
            if entries.len() >= max_files {
                *truncated = true;
                return Ok(());
            }

            let rel_norm = if rel_prefix.is_empty() {
                name.clone()
            } else {
                format!("{}/{}", rel_prefix, name)
            };

            let meta = match fs::symlink_metadata(&child_abs) {
                Ok(m) => m,
                Err(_) => continue,
            };
            let ft = meta.file_type();
            let (mtime_secs, mtime_nanos) = system_time_to_parts(meta.modified());

            if ft.is_symlink() {
                // Record symlink presence via lstat without ever following it.
                entries.insert(
                    rel_norm,
                    SnapshotEntry {
                        entry_type: SnapshotEntryType::Symlink,
                        size: meta.len(),
                        mtime_secs,
                        mtime_nanos,
                        sha256: None,
                        skipped_oversize: false,
                    },
                );
                continue;
            }

            if ft.is_dir() {
                if should_skip_rel_dir(&rel_norm, &name) {
                    continue;
                }
                entries.insert(
                    rel_norm.clone(),
                    SnapshotEntry {
                        entry_type: SnapshotEntryType::Directory,
                        size: 0,
                        mtime_secs,
                        mtime_nanos,
                        sha256: None,
                        skipped_oversize: false,
                    },
                );
                walk_dir(
                    &child_abs,
                    &rel_norm,
                    max_files,
                    max_file_bytes,
                    entries,
                    truncated,
                )?;
                if *truncated {
                    return Ok(());
                }
                continue;
            }

            if ft.is_file() {
                let size = meta.len();
                let (sha256, skipped_oversize) = if size <= max_file_bytes {
                    match hash_file_for_snapshot(&child_abs) {
                        Ok(h) => (Some(h), false),
                        Err(_) => (None, false),
                    }
                } else {
                    (None, true)
                };
                entries.insert(
                    rel_norm,
                    SnapshotEntry {
                        entry_type: SnapshotEntryType::RegularFile,
                        size,
                        mtime_secs,
                        mtime_nanos,
                        sha256,
                        skipped_oversize,
                    },
                );
                continue;
            }

            entries.insert(
                rel_norm,
                SnapshotEntry {
                    entry_type: SnapshotEntryType::Other,
                    size: meta.len(),
                    mtime_secs,
                    mtime_nanos,
                    sha256: None,
                    skipped_oversize: false,
                },
            );
        }

        Ok(())
    }

    walk_dir(
        &ws_canon,
        "",
        max_files,
        max_file_bytes,
        &mut entries,
        &mut truncated,
    )?;

    // Explicitly capture `.git/config` and `.git/hooks` (when present) even though
    // `.git` as a whole is skipped for performance, so hook/config tampering is
    // always observable in WorkspaceSnapshot / compute_fs_delta.
    let git_dir = ws_canon.join(".git");
    if let Ok(git_meta) = fs::symlink_metadata(&git_dir) {
        if git_meta.is_dir() && !git_meta.file_type().is_symlink() {
            let git_config = git_dir.join("config");
            if entries.len() < max_files {
                if let Ok(meta) = fs::symlink_metadata(&git_config) {
                    let ft = meta.file_type();
                    let (mtime_secs, mtime_nanos) = system_time_to_parts(meta.modified());
                    if ft.is_symlink() {
                        entries.insert(
                            ".git/config".to_string(),
                            SnapshotEntry {
                                entry_type: SnapshotEntryType::Symlink,
                                size: meta.len(),
                                mtime_secs,
                                mtime_nanos,
                                sha256: None,
                                skipped_oversize: false,
                            },
                        );
                    } else if ft.is_file() {
                        let size = meta.len();
                        let (sha256, skipped_oversize) = if size <= max_file_bytes {
                            match hash_file_for_snapshot(&git_config) {
                                Ok(h) => (Some(h), false),
                                Err(_) => (None, false),
                            }
                        } else {
                            (None, true)
                        };
                        entries.insert(
                            ".git/config".to_string(),
                            SnapshotEntry {
                                entry_type: SnapshotEntryType::RegularFile,
                                size,
                                mtime_secs,
                                mtime_nanos,
                                sha256,
                                skipped_oversize,
                            },
                        );
                    }
                }
            }
            let git_hooks = git_dir.join("hooks");
            if entries.len() < max_files {
                if let Ok(meta) = fs::symlink_metadata(&git_hooks) {
                    let ft = meta.file_type();
                    let (mtime_secs, mtime_nanos) = system_time_to_parts(meta.modified());
                    if ft.is_symlink() {
                        entries.insert(
                            ".git/hooks".to_string(),
                            SnapshotEntry {
                                entry_type: SnapshotEntryType::Symlink,
                                size: meta.len(),
                                mtime_secs,
                                mtime_nanos,
                                sha256: None,
                                skipped_oversize: false,
                            },
                        );
                    } else if ft.is_dir() {
                        entries.insert(
                            ".git/hooks".to_string(),
                            SnapshotEntry {
                                entry_type: SnapshotEntryType::Directory,
                                size: 0,
                                mtime_secs,
                                mtime_nanos,
                                sha256: None,
                                skipped_oversize: false,
                            },
                        );
                        let _ = walk_dir(
                            &git_hooks,
                            ".git/hooks",
                            max_files,
                            max_file_bytes,
                            &mut entries,
                            &mut truncated,
                        );
                    }
                }
            }
        }
    }

    Ok(WorkspaceSnapshot {
        root: ws_canon.to_string_lossy().to_string(),
        entries,
        truncated,
        max_files,
        max_file_bytes,
    })
}

/// Computes deterministic sorted `created`, `modified`, and `deleted` entries with
/// before/after SHA-256 digests between two `WorkspaceSnapshot` instances.
pub fn compute_fs_delta(before: &WorkspaceSnapshot, after: &WorkspaceSnapshot) -> FsDeltaReport {
    let mut created = Vec::new();
    let mut modified = Vec::new();
    let mut deleted = Vec::new();

    for (path, b) in &before.entries {
        match after.entries.get(path) {
            None => {
                deleted.push(FsDeltaEntry {
                    path: path.clone(),
                    before_type: Some(b.entry_type),
                    after_type: None,
                    before_size: Some(b.size),
                    after_size: None,
                    before_sha256: b.sha256.clone(),
                    after_sha256: None,
                });
            }
            Some(a) => {
                let type_changed = b.entry_type != a.entry_type;
                let changed = if type_changed {
                    true
                } else {
                    match a.entry_type {
                        SnapshotEntryType::Directory => false,
                        SnapshotEntryType::RegularFile => {
                            if b.size != a.size || b.sha256 != a.sha256 {
                                true
                            } else if b.sha256.is_none() && a.sha256.is_none() {
                                b.mtime_secs != a.mtime_secs || b.mtime_nanos != a.mtime_nanos
                            } else {
                                false
                            }
                        }
                        SnapshotEntryType::Symlink | SnapshotEntryType::Other => {
                            b.size != a.size
                                || b.mtime_secs != a.mtime_secs
                                || b.mtime_nanos != a.mtime_nanos
                        }
                    }
                };
                if changed {
                    modified.push(FsDeltaEntry {
                        path: path.clone(),
                        before_type: Some(b.entry_type),
                        after_type: Some(a.entry_type),
                        before_size: Some(b.size),
                        after_size: Some(a.size),
                        before_sha256: b.sha256.clone(),
                        after_sha256: a.sha256.clone(),
                    });
                }
            }
        }
    }

    for (path, a) in &after.entries {
        if !before.entries.contains_key(path) {
            created.push(FsDeltaEntry {
                path: path.clone(),
                before_type: None,
                after_type: Some(a.entry_type),
                before_size: None,
                after_size: Some(a.size),
                before_sha256: None,
                after_sha256: a.sha256.clone(),
            });
        }
    }

    FsDeltaReport {
        created,
        modified,
        deleted,
    }
}

// ---------------------------------------------------------------------------
// Comprehensive Unit Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};

    static TEST_DIR_SEQ: AtomicU64 = AtomicU64::new(1);

    struct TempWorkspace {
        base: PathBuf,
        workspace: PathBuf,
        outside: PathBuf,
    }

    impl TempWorkspace {
        fn new(label: &str) -> Self {
            let seq = TEST_DIR_SEQ.fetch_add(1, Ordering::Relaxed);
            let base = std::env::temp_dir().join(format!(
                "hz-fs-delta-test-{}-{}-{}",
                label,
                std::process::id(),
                seq
            ));
            let _ = fs::remove_dir_all(&base);
            let workspace = base.join("ws");
            let outside = base.join("outside");
            fs::create_dir_all(&workspace).expect("create workspace");
            fs::create_dir_all(&outside).expect("create outside");
            Self {
                base,
                workspace,
                outside,
            }
        }
    }

    impl Drop for TempWorkspace {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.base);
        }
    }

    #[test]
    fn test_in_kernel_touch_create_update_and_nofollow() {
        let tw = TempWorkspace::new("touch");
        let empty_sha = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

        // 1. Create new file
        let r1 = in_kernel_touch(&tw.workspace, Path::new("hello.txt")).expect("touch new");
        assert_eq!(r1.op, "touch");
        assert!(!r1.existed_before);
        assert!(r1.exists_after);
        assert_eq!(r1.pre_sha256, None);
        assert_eq!(r1.post_sha256.as_deref(), Some(empty_sha));

        // 2. Write content then touch existing file
        fs::write(tw.workspace.join("hello.txt"), b"horizon").expect("write");
        let r2 = in_kernel_touch(&tw.workspace, Path::new("hello.txt")).expect("touch existing");
        assert!(r2.existed_before);
        assert!(r2.exists_after);
        assert_eq!(r2.pre_sha256, r2.post_sha256);
        assert_ne!(r2.post_sha256.as_deref(), Some(empty_sha));

        // 3. Refuse parent traversal '..' and absolute paths
        assert!(in_kernel_touch(&tw.workspace, Path::new("../outside/pwn")).is_err());
        assert!(in_kernel_touch(&tw.workspace, &tw.outside.join("pwn")).is_err());

        // 4. Unix symlink-escape refusal (both leaf symlink and intermediate dir symlink)
        #[cfg(unix)]
        {
            use std::os::unix::fs::symlink;
            let outside_secret = tw.outside.join("secret.txt");
            fs::write(&outside_secret, b"do-not-touch").expect("write outside");

            let leaf_link = tw.workspace.join("leaf_link.txt");
            symlink(&outside_secret, &leaf_link).expect("symlink leaf");
            let err_leaf = in_kernel_touch(&tw.workspace, Path::new("leaf_link.txt"))
                .expect_err("must refuse leaf symlink");
            assert!(
                err_leaf.contains("symlink") || err_leaf.contains("ELOOP"),
                "unexpected err: {}",
                err_leaf
            );

            let dir_link = tw.workspace.join("escape_dir");
            symlink(&tw.outside, &dir_link).expect("symlink dir");
            let err_dir = in_kernel_touch(&tw.workspace, Path::new("escape_dir/new.txt"))
                .expect_err("must refuse parent symlink escape");
            assert!(
                err_dir.contains("symlink") || err_dir.contains("escape"),
                "unexpected err: {}",
                err_dir
            );
            assert!(!tw.outside.join("new.txt").exists());
        }
    }

    #[test]
    fn test_in_kernel_rm_regular_force_and_symlink_safety() {
        let tw = TempWorkspace::new("rm");
        let f = tw.workspace.join("victim.txt");
        fs::write(&f, b"bye").expect("write");

        // 1. Remove regular file and record preimage SHA-256
        let r = in_kernel_rm(&tw.workspace, Path::new("victim.txt"), false).expect("rm");
        assert!(r.existed_before);
        assert!(!r.exists_after);
        assert!(r.pre_sha256.is_some());
        assert_eq!(r.post_sha256, None);
        assert!(!f.exists());

        // 2. ENOENT fails when force == false, succeeds cleanly when force == true
        assert!(in_kernel_rm(&tw.workspace, Path::new("victim.txt"), false).is_err());
        let rf = in_kernel_rm(&tw.workspace, Path::new("victim.txt"), true).expect("rm -f");
        assert!(!rf.existed_before);
        assert!(!rf.exists_after);
        assert_eq!(rf.pre_sha256, None);

        // 3. Unix: unlinkat removes leaf symlink without touching target, and refuses parent dir symlink escape
        #[cfg(unix)]
        {
            use std::os::unix::fs::symlink;
            let outside_keep = tw.outside.join("keep.txt");
            fs::write(&outside_keep, b"intact").expect("write outside");

            let leaf_link = tw.workspace.join("link_to_keep");
            symlink(&outside_keep, &leaf_link).expect("symlink");
            let r_link = in_kernel_rm(&tw.workspace, Path::new("link_to_keep"), false)
                .expect("unlinkat symlink leaf");
            assert!(r_link.existed_before);
            assert!(!r_link.exists_after);
            assert_eq!(r_link.pre_sha256, None);
            assert!(outside_keep.exists(), "target outside workspace must remain intact");

            let dir_link = tw.workspace.join("escape_dir");
            symlink(&tw.outside, &dir_link).expect("symlink dir");
            assert!(
                in_kernel_rm(&tw.workspace, Path::new("escape_dir/keep.txt"), true).is_err(),
                "must refuse parent symlink escape even with force=true"
            );
            assert!(outside_keep.exists());
        }
    }

    #[test]
    fn test_in_kernel_mv_and_symlink_escape_refusal() {
        let tw = TempWorkspace::new("mv");
        fs::create_dir_all(tw.workspace.join("sub")).expect("mkdir sub");
        fs::write(tw.workspace.join("a.txt"), b"payload-a").expect("write a");
        fs::write(tw.workspace.join("sub/b.txt"), b"old-b").expect("write b");

        let r = in_kernel_mv(&tw.workspace, Path::new("a.txt"), Path::new("sub/b.txt"))
            .expect("mv");
        assert_eq!(r.op, "mv");
        assert!(r.existed_before);
        assert!(r.exists_after);
        assert!(r.pre_sha256.is_some());
        assert!(r.post_sha256.is_some());
        assert_eq!(r.src_sha256, r.post_sha256);
        assert_ne!(r.pre_sha256, r.post_sha256);
        assert!(!tw.workspace.join("a.txt").exists());
        assert_eq!(
            fs::read(tw.workspace.join("sub/b.txt")).expect("read b"),
            b"payload-a"
        );

        #[cfg(unix)]
        {
            use std::os::unix::fs::symlink;
            let outside_target = tw.outside.join("target.txt");
            fs::write(&outside_target, b"outside").expect("write outside");

            let dst_link = tw.workspace.join("dst_link");
            symlink(&outside_target, &dst_link).expect("symlink dst");
            assert!(
                in_kernel_mv(&tw.workspace, Path::new("sub/b.txt"), Path::new("dst_link")).is_err(),
                "must refuse mv onto symlink destination"
            );

            let dir_link = tw.workspace.join("escape_dir");
            symlink(&tw.outside, &dir_link).expect("symlink dir");
            assert!(
                in_kernel_mv(
                    &tw.workspace,
                    Path::new("sub/b.txt"),
                    Path::new("escape_dir/moved.txt")
                )
                .is_err(),
                "must refuse mv into symlinked parent dir"
            );
            assert!(tw.workspace.join("sub/b.txt").exists());
        }
    }

    #[test]
    fn test_in_kernel_install_mode_atomic_and_nofollow() {
        let tw = TempWorkspace::new("install");
        fs::create_dir_all(tw.workspace.join("bin")).expect("mkdir bin");
        fs::write(tw.workspace.join("tool.sh"), b"#!/bin/sh\necho hi\n").expect("write src");

        let r = in_kernel_install(
            &tw.workspace,
            Path::new("tool.sh"),
            Path::new("bin/tool.sh"),
            Some(0o755),
        )
        .expect("install");
        assert_eq!(r.op, "install");
        assert!(!r.existed_before);
        assert!(r.exists_after);
        assert_eq!(r.pre_sha256, None);
        assert_eq!(r.post_sha256, r.src_sha256);
        assert_eq!(r.mode, Some(0o755));
        assert_eq!(
            fs::read(tw.workspace.join("bin/tool.sh")).expect("read installed"),
            b"#!/bin/sh\necho hi\n"
        );

        #[cfg(unix)]
        {
            use std::os::unix::fs::{symlink, PermissionsExt};
            let perms = fs::metadata(tw.workspace.join("bin/tool.sh"))
                .expect("meta")
                .permissions()
                .mode()
                & 0o7777;
            assert_eq!(perms, 0o755);

            let outside_secret = tw.outside.join("secret.sh");
            fs::write(&outside_secret, b"original").expect("write outside");
            let dst_link = tw.workspace.join("bin/link.sh");
            symlink(&outside_secret, &dst_link).expect("symlink dst");
            assert!(
                in_kernel_install(
                    &tw.workspace,
                    Path::new("tool.sh"),
                    Path::new("bin/link.sh"),
                    Some(0o755)
                )
                .is_err(),
                "must refuse install onto symlink destination"
            );
            assert_eq!(fs::read(&outside_secret).expect("read outside"), b"original");

            // Strip setuid/setgid/sticky bits (0o6755 -> 0o755)
            let r_suid = in_kernel_install(
                &tw.workspace,
                Path::new("tool.sh"),
                Path::new("bin/suid.sh"),
                Some(0o6755),
            )
            .expect("install with stripped suid/sgid");
            assert_eq!(r_suid.mode, Some(0o755));
            let perms_suid = fs::metadata(tw.workspace.join("bin/suid.sh"))
                .expect("meta")
                .permissions()
                .mode()
                & 0o7777;
            assert_eq!(perms_suid, 0o755, "setuid/setgid bits must be stripped");
        }
    }

    #[test]
    fn test_probe_fs_observation_backend_and_evaluator() {
        // Real host probe must return a valid honest capability enum without panicking.
        let cap = probe_fs_observation_backend();
        match &cap {
            FsObservationCapability::OverlayFsUserns => {}
            FsObservationCapability::WorkspaceSnapshotFallback { reason } => {
                assert!(!reason.is_empty(), "fallback reason must be non-empty");
            }
        }

        // Deterministic unit checks for all Linux probe conditions:
        assert_eq!(
            evaluate_linux_probe_inputs(
                Some("1\n"),
                Some("1\n"),
                Some("65536\n"),
                Some("nodev\toverlay\n"),
            ),
            FsObservationCapability::WorkspaceSnapshotFallback {
                reason: "ubuntu-24.04-apparmor-restrict-userns".to_string()
            }
        );
        assert_eq!(
            evaluate_linux_probe_inputs(
                Some("0\n"),
                Some("0\n"),
                Some("65536\n"),
                Some("nodev\toverlay\n"),
            ),
            FsObservationCapability::WorkspaceSnapshotFallback {
                reason: "unprivileged-userns-clone-disabled".to_string()
            }
        );
        assert_eq!(
            evaluate_linux_probe_inputs(
                None,
                Some("1\n"),
                Some("65536\n"),
                Some("nodev\ttmpfs\next4\n"),
            ),
            FsObservationCapability::WorkspaceSnapshotFallback {
                reason: "overlayfs-unavailable".to_string()
            }
        );
        assert_eq!(
            evaluate_linux_probe_inputs(
                Some("0\n"),
                Some("1\n"),
                Some("65536\n"),
                Some("nodev\ttmpfs\nnodev\toverlay\n"),
            ),
            FsObservationCapability::OverlayFsUserns
        );
    }

    #[test]
    fn test_workspace_snapshot_and_compute_fs_delta() {
        let tw = TempWorkspace::new("snapshot");

        // Excluded directories that must be skipped, plus `.git/config` and `.git/hooks` which MUST be captured:
        fs::create_dir_all(tw.workspace.join(".git/objects")).expect("mkdir .git");
        fs::create_dir_all(tw.workspace.join(".git/hooks")).expect("mkdir .git/hooks");
        fs::write(tw.workspace.join(".git/HEAD"), b"ref: refs/heads/main\n").expect("write .git");
        fs::write(tw.workspace.join(".git/config"), b"[core]\n\trepositoryformatversion = 0\n")
            .expect("write .git/config");
        fs::write(tw.workspace.join(".git/hooks/pre-commit"), b"#!/bin/sh\nexit 0\n")
            .expect("write .git/hooks/pre-commit");
        fs::create_dir_all(tw.workspace.join("node_modules/pkg")).expect("mkdir node_modules");
        fs::write(tw.workspace.join("node_modules/pkg/index.js"), b"module.exports={};")
            .expect("write nm");
        fs::create_dir_all(tw.workspace.join("target/debug")).expect("mkdir target");
        fs::write(tw.workspace.join("target/debug/app"), b"bin").expect("write target");
        fs::create_dir_all(tw.workspace.join(".hz/state/kernel")).expect("mkdir kernel state");
        fs::write(tw.workspace.join(".hz/state/kernel/events.jsonl"), b"{}\n")
            .expect("write kernel state");

        // Regular files:
        fs::create_dir_all(tw.workspace.join("src")).expect("mkdir src");
        fs::write(tw.workspace.join("src/keep.rs"), b"fn keep() {}").expect("write keep");
        fs::write(tw.workspace.join("src/mod.rs"), b"v1").expect("write mod");
        fs::write(tw.workspace.join("src/del.rs"), b"gone").expect("write del");

        // Symlink pointing outside workspace must be recorded as Symlink with sha256=None and never followed:
        #[cfg(unix)]
        {
            use std::os::unix::fs::symlink;
            fs::write(tw.outside.join("secret.txt"), b"outside-secret").expect("write outside");
            symlink(tw.outside.join("secret.txt"), tw.workspace.join("ext_link"))
                .expect("symlink file");
            symlink(&tw.outside, tw.workspace.join("ext_dir_link")).expect("symlink dir");
        }

        let before = capture_workspace_snapshot(&tw.workspace, 10_000, 10 * 1024 * 1024)
            .expect("before snapshot");
        assert!(!before.truncated);
        assert!(!before.entries.contains_key(".git"));
        assert!(!before.entries.contains_key(".git/HEAD"));
        assert!(before.entries.contains_key(".git/config"), ".git/config must be captured");
        assert!(before.entries.contains_key(".git/hooks"), ".git/hooks must be captured");
        assert!(
            before.entries.contains_key(".git/hooks/pre-commit"),
            ".git/hooks/pre-commit must be captured"
        );
        assert!(!before.entries.contains_key("node_modules"));
        assert!(!before.entries.contains_key("target"));
        assert!(!before.entries.contains_key(".hz/state/kernel"));
        assert!(!before.entries.contains_key(".hz/state/kernel/events.jsonl"));
        assert!(before.entries.contains_key("src/keep.rs"));
        assert!(before.entries.contains_key("src/mod.rs"));
        assert!(before.entries.contains_key("src/del.rs"));

        #[cfg(unix)]
        {
            let link_entry = before.entries.get("ext_link").expect("ext_link present");
            assert_eq!(link_entry.entry_type, SnapshotEntryType::Symlink);
            assert_eq!(link_entry.sha256, None);
            let dir_link_entry = before
                .entries
                .get("ext_dir_link")
                .expect("ext_dir_link present");
            assert_eq!(dir_link_entry.entry_type, SnapshotEntryType::Symlink);
            assert!(
                !before.entries.contains_key("ext_dir_link/secret.txt"),
                "must never traverse into symlinked directories"
            );
        }

        // Mutate workspace: create, modify, delete
        fs::write(tw.workspace.join("src/new.rs"), b"fn new() {}").expect("create new");
        fs::write(tw.workspace.join("src/mod.rs"), b"v2-updated").expect("modify mod");
        fs::remove_file(tw.workspace.join("src/del.rs")).expect("delete del");

        let after = capture_workspace_snapshot(&tw.workspace, 10_000, 10 * 1024 * 1024)
            .expect("after snapshot");
        let delta = compute_fs_delta(&before, &after);

        assert_eq!(delta.created.len(), 1);
        assert_eq!(delta.created[0].path, "src/new.rs");
        assert_eq!(delta.created[0].before_sha256, None);
        assert!(delta.created[0].after_sha256.is_some());

        assert_eq!(delta.modified.len(), 1);
        assert_eq!(delta.modified[0].path, "src/mod.rs");
        assert!(delta.modified[0].before_sha256.is_some());
        assert!(delta.modified[0].after_sha256.is_some());
        assert_ne!(delta.modified[0].before_sha256, delta.modified[0].after_sha256);

        assert_eq!(delta.deleted.len(), 1);
        assert_eq!(delta.deleted[0].path, "src/del.rs");
        assert!(delta.deleted[0].before_sha256.is_some());
        assert_eq!(delta.deleted[0].after_sha256, None);
    }
}
