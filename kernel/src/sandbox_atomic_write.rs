//! Temp-file + rename writes, contained deletes, and atomic renames scoped to a sandbox root
//! (EffectHost `fs.write` / `fs.edit` / `fs.delete` / `fs.rename`).
//!
//! Fails closed when the destination parent is outside `sandbox_root`, when a sibling
//! temp path would escape the root, or when temp and target are not on the same device
//! (cross-device `rename` is not atomic).

use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};

use crate::guard;
use crate::jsonl_append;

#[cfg(unix)]
use std::os::unix::fs::MetadataExt;

fn random_suffix() -> String {
    format!(
        "{:x}{:x}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0)
    )
}

fn temp_path_beside(target: &Path) -> PathBuf {
    let parent = target.parent().unwrap_or_else(|| Path::new("."));
    let base = target
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("file");
    parent.join(format!(".{base}.hz-tmp-{suffix}", suffix = random_suffix()))
}

#[cfg(unix)]
fn same_device(a: &Path, b: &Path) -> Result<bool, String> {
    let meta_a = fs::metadata(a).map_err(|e| format!("cannot stat {}: {e}", a.display()))?;
    let meta_b = fs::metadata(b).map_err(|e| format!("cannot stat {}: {e}", b.display()))?;
    Ok(meta_a.dev() == meta_b.dev())
}

#[cfg(not(unix))]
fn same_device(_a: &Path, _b: &Path) -> Result<bool, String> {
    Ok(true)
}

/// Replace `target` with `payload` using a sibling temp file + `rename` inside `sandbox_root`.
pub fn write_bytes_atomic_in_sandbox(
    sandbox_root: &Path,
    target: &Path,
    payload: &[u8],
) -> Result<(), String> {
    if !guard::path_contained_in(sandbox_root, target) {
        return Err(
            "HZ_PRECONDITION_FAILED: atomic write target must resolve inside sandboxRoot".to_string(),
        );
    }
    let parent = target
        .parent()
        .ok_or_else(|| "HZ_PRECONDITION_FAILED: atomic write target has no parent directory".to_string())?;
    if !guard::path_contained_in(sandbox_root, parent) {
        return Err(
            "HZ_PRECONDITION_FAILED: atomic write parent must resolve inside sandboxRoot".to_string(),
        );
    }
    if let Some(parent_resolved) = guard::lexical_resolve(parent) {
        if !guard::path_contained_in(sandbox_root, &parent_resolved) {
            return Err(
                "HZ_PRECONDITION_FAILED: atomic write parent must resolve inside sandboxRoot"
                    .to_string(),
            );
        }
    }
    fs::create_dir_all(parent).map_err(|e| {
        format!("HZ_PRECONDITION_FAILED: effect.execute write failed creating parent: {e}")
    })?;

    let tmp = temp_path_beside(target);
    if !guard::path_contained_in(sandbox_root, &tmp) {
        return Err(
            "HZ_PRECONDITION_FAILED: atomic write temp path must resolve inside sandboxRoot"
                .to_string(),
        );
    }

    {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&tmp)
            .map_err(|e| {
                format!("HZ_PRECONDITION_FAILED: atomic write could not create temp file: {e}")
            })?;
        file.write_all(payload)
            .map_err(|e| format!("HZ_PRECONDITION_FAILED: atomic write temp write failed: {e}"))?;
        file.flush()
            .map_err(|e| format!("HZ_PRECONDITION_FAILED: atomic write temp flush failed: {e}"))?;
        file.sync_data()
            .map_err(|e| format!("HZ_PRECONDITION_FAILED: atomic write temp fsync failed: {e}"))?;
    }

    if !same_device(&tmp, parent)? {
        let _ = fs::remove_file(&tmp);
        return Err(
            "HZ_PRECONDITION_FAILED: atomic write refused: temp and parent on different devices (cross-device rename)"
                .to_string(),
        );
    }
    if target.exists() && !same_device(&tmp, target)? {
        let _ = fs::remove_file(&tmp);
        return Err(
            "HZ_PRECONDITION_FAILED: atomic write refused: temp and target on different devices (cross-device rename)"
                .to_string(),
        );
    }

    fs::rename(&tmp, target).map_err(|e| {
        let _ = fs::remove_file(&tmp);
        format!("HZ_PRECONDITION_FAILED: atomic write rename failed: {e}")
    })?;
    jsonl_append::sync_jsonl_parent_dir_best_effort(target);
    Ok(())
}

/// Remove `target` when it resolves inside `sandbox_root` (existing file only).
pub fn delete_file_in_sandbox(sandbox_root: &Path, target: &Path) -> Result<(), String> {
    if !guard::path_contained_in(sandbox_root, target) {
        return Err(
            "HZ_PRECONDITION_FAILED: fs.delete target must resolve inside sandboxRoot".to_string(),
        );
    }
    if !target.is_file() {
        return Err(
            "HZ_PRECONDITION_FAILED: effect.execute fs.delete requires an existing file".to_string(),
        );
    }
    fs::remove_file(target).map_err(|e| {
        format!("HZ_PRECONDITION_FAILED: effect.execute fs.delete failed: {e}")
    })?;
    jsonl_append::sync_jsonl_parent_dir_best_effort(target);
    Ok(())
}

/// Atomically rename `from` → `to` when both resolve inside `sandbox_root` (existing file only).
pub fn rename_file_in_sandbox(
    sandbox_root: &Path,
    from: &Path,
    to: &Path,
) -> Result<(), String> {
    if !guard::path_contained_in(sandbox_root, from) {
        return Err(
            "HZ_PRECONDITION_FAILED: fs.rename source must resolve inside sandboxRoot".to_string(),
        );
    }
    if !guard::path_contained_in(sandbox_root, to) {
        return Err(
            "HZ_PRECONDITION_FAILED: fs.rename destination must resolve inside sandboxRoot".to_string(),
        );
    }
    let parent = to.parent().ok_or_else(|| {
        "HZ_PRECONDITION_FAILED: fs.rename destination has no parent directory".to_string()
    })?;
    if !guard::path_contained_in(sandbox_root, parent) {
        return Err(
            "HZ_PRECONDITION_FAILED: fs.rename destination parent must resolve inside sandboxRoot"
                .to_string(),
        );
    }
    if let Some(parent_resolved) = guard::lexical_resolve(parent) {
        if !guard::path_contained_in(sandbox_root, &parent_resolved) {
            return Err(
                "HZ_PRECONDITION_FAILED: fs.rename destination parent must resolve inside sandboxRoot"
                    .to_string(),
            );
        }
    }
    if !from.is_file() {
        return Err(
            "HZ_PRECONDITION_FAILED: effect.execute fs.rename requires an existing source file"
                .to_string(),
        );
    }
    if !same_device(from, parent)? {
        return Err(
            "HZ_PRECONDITION_FAILED: fs.rename refused: source and destination parent on different devices (cross-device rename)"
                .to_string(),
        );
    }
    fs::rename(from, to).map_err(|e| {
        format!("HZ_PRECONDITION_FAILED: effect.execute fs.rename failed: {e}")
    })?;
    jsonl_append::sync_jsonl_parent_dir_best_effort(to);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn fresh_sandbox(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("hz-atomic-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn atomic_write_then_read_matches() {
        let sandbox = fresh_sandbox("ok");
        let target = sandbox.join("nested/out.txt");
        write_bytes_atomic_in_sandbox(&sandbox, &target, b"atomic-bytes").unwrap();
        let on_disk = fs::read(&target).unwrap();
        assert_eq!(on_disk, b"atomic-bytes");
        let _ = fs::remove_dir_all(&sandbox);
    }

    #[test]
    fn atomic_write_refuses_escape_via_temp() {
        let sandbox = fresh_sandbox("esc");
        let outside = std::env::temp_dir().join(format!(
            "hz-atomic-out-{}",
            std::process::id()
        ));
        let target = sandbox.join("in.txt");
        fs::write(&target, b"x").unwrap();
        // Craft a fake target path outside root that still passes initial resolve — use parent escape.
        let evil = sandbox.join("../hz-atomic-evil-target.txt");
        let err = write_bytes_atomic_in_sandbox(&sandbox, &evil, b"y").unwrap_err();
        assert!(err.contains("sandboxRoot"), "{err}");
        let _ = fs::remove_dir_all(&sandbox);
        let _ = fs::remove_file(outside);
    }

    #[test]
    fn leaves_no_temp_after_success() {
        let sandbox = fresh_sandbox("clean");
        let target = sandbox.join("a.bin");
        write_bytes_atomic_in_sandbox(&sandbox, &target, b"z").unwrap();
        let entries: Vec<_> = fs::read_dir(&sandbox)
            .unwrap()
            .filter_map(|e| e.ok())
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .collect();
        assert_eq!(entries, vec!["a.bin".to_string()]);
        let _ = fs::remove_dir_all(&sandbox);
    }

    #[test]
    fn delete_file_in_sandbox_removes_file() {
        let sandbox = fresh_sandbox("del");
        let target = sandbox.join("gone.txt");
        fs::write(&target, b"x").unwrap();
        delete_file_in_sandbox(&sandbox, &target).unwrap();
        assert!(!target.exists());
        let _ = fs::remove_dir_all(&sandbox);
    }

    #[test]
    fn rename_file_in_sandbox_moves_within_root() {
        let sandbox = fresh_sandbox("ren");
        let from = sandbox.join("a.txt");
        let to = sandbox.join("nested").join("b.txt");
        fs::create_dir_all(sandbox.join("nested")).unwrap();
        fs::write(&from, b"payload").unwrap();
        rename_file_in_sandbox(&sandbox, &from, &to).unwrap();
        assert!(!from.exists());
        assert_eq!(fs::read(&to).unwrap(), b"payload");
        let _ = fs::remove_dir_all(&sandbox);
    }

    #[test]
    fn rename_file_in_sandbox_refuses_escape() {
        let sandbox = fresh_sandbox("ren-esc");
        let from = sandbox.join("in.txt");
        fs::write(&from, b"x").unwrap();
        let evil = sandbox.join("../hz-rename-evil.txt");
        let err = rename_file_in_sandbox(&sandbox, &from, &evil).unwrap_err();
        assert!(err.contains("sandboxRoot"), "{err}");
        let _ = fs::remove_dir_all(&sandbox);
    }
}
