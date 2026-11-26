//! H-31 reduced file-tool TOCTOU: re-resolve mutation paths and verify opened
//! fds stay inside `sandboxRoot` before bytes land. Does not close full H-31
//! (ambient races, rename window, universal EffectHost remain OPEN).

use std::fs::{self, File};
use std::path::{Path, PathBuf};

use crate::guard;

/// Lexical re-resolve + `path_contained_in` immediately before an effect.
pub fn recheck_path_in_sandbox(
    sandbox_root: &Path,
    candidate: &Path,
    expected_resolved: Option<&Path>,
) -> Result<PathBuf, String> {
    if !guard::path_contained_in(sandbox_root, candidate) {
        return Err("HZ_PRECONDITION_FAILED: mutation path outside sandboxRoot".to_string());
    }
    let resolved = guard::lexical_resolve(candidate).ok_or_else(|| {
        "HZ_PRECONDITION_FAILED: mutation path could not be re-resolved".to_string()
    })?;
    if !guard::path_contained_in(sandbox_root, &resolved) {
        return Err(
            "HZ_PRECONDITION_FAILED: re-resolved mutation path outside sandboxRoot".to_string(),
        );
    }
    if let Some(exp) = expected_resolved {
        if resolved != exp {
            return Err(format!(
                "HZ_PRECONDITION_FAILED: path resolution moved (approved {}, now {})",
                exp.display(),
                resolved.display()
            ));
        }
    }
    Ok(resolved)
}

/// After `open`, prove the fd still names a path inside `sandbox_root` (Linux:
/// `/proc/self/fd`; elsewhere: dev/ino match against `opened_path`).
#[cfg(unix)]
pub fn verify_fd_contained_in_sandbox(
    file: &File,
    sandbox_root: &Path,
    _opened_path: &Path,
    expected_resolved: Option<&Path>,
) -> Result<(), String> {
    use std::os::unix::io::AsRawFd;

    #[cfg(target_os = "linux")]
    {
        let _ = _opened_path;
        let proc = format!("/proc/self/fd/{}", file.as_raw_fd());
        let by_fd = fs::read_link(&proc)
            .map_err(|e| format!("HZ_PRECONDITION_FAILED: readlink {proc}: {e}"))?;
        if !guard::path_contained_in(sandbox_root, &by_fd) {
            return Err(format!(
                "HZ_PRECONDITION_FAILED: opened fd points outside sandboxRoot ({})",
                by_fd.display()
            ));
        }
        let fd_resolved = guard::lexical_resolve(&by_fd).unwrap_or(by_fd);
        if let Some(exp) = expected_resolved {
            if fd_resolved != *exp {
                return Err(format!(
                    "HZ_PRECONDITION_FAILED: symlink swap detected: fd resolves to {}, expected {}",
                    fd_resolved.display(),
                    exp.display()
                ));
            }
        }
        return Ok(());
    }

    #[cfg(not(target_os = "linux"))]
    {
        use std::os::unix::fs::MetadataExt;
        let opened_meta = file
            .metadata()
            .map_err(|e| format!("HZ_PRECONDITION_FAILED: fstat opened fd failed: {e}"))?;
        let path_meta = fs::symlink_metadata(_opened_path)
            .map_err(|e| format!("HZ_PRECONDITION_FAILED: stat opened path failed: {e}"))?;
        if path_meta.dev() != opened_meta.dev() || path_meta.ino() != opened_meta.ino() {
            return Err(
                "HZ_PRECONDITION_FAILED: opened path changed while opening (possible symlink swap)"
                    .to_string(),
            );
        }
        if !guard::path_contained_in(sandbox_root, _opened_path) {
            return Err("HZ_PRECONDITION_FAILED: opened path outside sandboxRoot".to_string());
        }
        Ok(())
    }
}

#[cfg(not(unix))]
pub fn verify_fd_contained_in_sandbox(
    _file: &File,
    sandbox_root: &Path,
    opened_path: &Path,
    expected_resolved: Option<&Path>,
) -> Result<(), String> {
    recheck_path_in_sandbox(sandbox_root, opened_path, expected_resolved).map(|_| ())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    #[cfg(unix)]
    use std::os::unix::fs::symlink;

    fn fresh_sandbox(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("hz-path-verify-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    #[cfg(unix)]
    fn recheck_refuses_resolution_move() {
        let sandbox = fresh_sandbox("move");
        let candidate = sandbox.join("a.txt");
        fs::write(&candidate, b"x").unwrap();
        let expected = guard::lexical_resolve(&candidate).unwrap();
        fs::remove_file(&candidate).unwrap();
        let outside = std::env::temp_dir().join(format!("hz-out-{}", std::process::id()));
        fs::create_dir_all(&outside).unwrap();
        let secret = outside.join("secret.txt");
        fs::write(&secret, b"secret").unwrap();
        symlink(&secret, &candidate).unwrap();
        let err = recheck_path_in_sandbox(&sandbox, &candidate, Some(&expected)).unwrap_err();
        assert!(
            err.contains("resolution moved") || err.contains("outside sandboxRoot"),
            "{err}"
        );
        let _ = fs::remove_dir_all(&sandbox);
        let _ = fs::remove_dir_all(&outside);
    }

    #[test]
    #[cfg(target_os = "linux")]
    fn verify_fd_refuses_outside_workspace() {
        let sandbox = fresh_sandbox("fd");
        let outside = std::env::temp_dir().join(format!("hz-fd-out-{}", std::process::id()));
        fs::create_dir_all(&outside).unwrap();
        let secret = outside.join("secret.txt");
        fs::write(&secret, b"secret").unwrap();
        let file = fs::File::open(&secret).unwrap();
        let err = verify_fd_contained_in_sandbox(&file, &sandbox, &secret, None).unwrap_err();
        assert!(err.contains("outside sandboxRoot"), "{err}");
        let _ = fs::remove_dir_all(&sandbox);
        let _ = fs::remove_dir_all(&outside);
    }
}
