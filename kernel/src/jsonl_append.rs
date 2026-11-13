//! JSONL append durability helpers (docs/33 §6.5 / parity with `app/src/core/jsonl-append.ts`).
//!
//! Default: `sync_data` on the file after each append, then a best-effort parent-directory
//! sync on Unix. `HZ_JSONL_FSYNC=0` / `false` / `off` disables both (fast/test path).

use std::fs::File;
use std::io;
use std::path::Path;

/// Parse `HZ_JSONL_FSYNC` the same way as TypeScript `jsonlFsyncEnabled`.
pub fn jsonl_fsync_enabled_from(raw: Option<&str>) -> bool {
    match raw {
        None | Some("") => true,
        Some(v) => {
            let t = v.trim().to_ascii_lowercase();
            !(t == "0" || t == "false" || t == "off")
        }
    }
}

pub fn jsonl_fsync_enabled() -> bool {
    jsonl_fsync_enabled_from(std::env::var("HZ_JSONL_FSYNC").ok().as_deref())
}

/// File + optional parent-directory sync after a flushed JSONL append.
pub fn sync_jsonl_append(path: &Path, file: &File) -> io::Result<()> {
    if !jsonl_fsync_enabled() {
        return Ok(());
    }
    file.sync_data()?;
    sync_jsonl_parent_dir_best_effort(path);
    Ok(())
}

/// Best-effort directory fsync (same contract as `jsonl-append.ts` / `atomic-write.ts`).
#[cfg(unix)]
pub fn sync_jsonl_parent_dir_best_effort(path: &Path) {
    let Some(parent) = path.parent() else {
        return;
    };
    if parent.as_os_str().is_empty() {
        return;
    }
    if let Ok(dir) = File::open(parent) {
        let _ = dir.sync_data();
    }
}

#[cfg(not(unix))]
pub fn sync_jsonl_parent_dir_best_effort(_path: &Path) {}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use uuid::Uuid;

    #[test]
    fn jsonl_fsync_enabled_matches_ts_contract() {
        assert!(jsonl_fsync_enabled_from(None));
        assert!(jsonl_fsync_enabled_from(Some("")));
        assert!(jsonl_fsync_enabled_from(Some("1")));
        assert!(!jsonl_fsync_enabled_from(Some("0")));
        assert!(!jsonl_fsync_enabled_from(Some("false")));
        assert!(!jsonl_fsync_enabled_from(Some("FALSE")));
        assert!(!jsonl_fsync_enabled_from(Some("off")));
        assert!(!jsonl_fsync_enabled_from(Some(" OFF ")));
    }

    /// Parent sync is not observable without platform hooks; ensure the path runs when fsync is on.
    #[test]
    fn sync_jsonl_append_with_fsync_enabled_does_not_error() {
        let dir = std::env::temp_dir().join(format!("hz-jsonl-append-{}", Uuid::new_v4()));
        std::fs::create_dir_all(&dir).expect("mkdir");
        let path = dir.join("chain.jsonl");
        {
            let mut file = std::fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(&path)
                .expect("open");
            file.write_all(b"{\"x\":1}\n").expect("write");
            file.flush().expect("flush");
            sync_jsonl_append(&path, &file).expect("sync");
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn sync_jsonl_parent_dir_best_effort_on_missing_parent_is_noop() {
        sync_jsonl_parent_dir_best_effort(Path::new("nonexistent-dir/file.jsonl"));
    }
}
