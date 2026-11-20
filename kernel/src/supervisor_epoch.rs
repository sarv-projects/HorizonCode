//! H-30 / ruling 634 — monotonic supervisor epoch for detach lease identity.
//!
//! Each fresh `--socket` bind advances `<state>/hzk.epoch`. Reattach clients
//! compare the on-disk epoch to `ping.supervisorEpoch` so a restarted kernel
//! (upgrade / second launch) cannot silently inherit a stale supervisor claim.
//! Paired with `supervisor_lease` (ruling **635** / CB-6) for exclusive live ownership.

use std::fs;
use std::path::Path;

/// Read `<state_dir>/hzk.epoch`, increment, rewrite, return the new epoch.
/// Missing or unparseable files start at `1`.
pub fn advance_supervisor_epoch(state_dir: &Path) -> Result<u64, String> {
    let path = state_dir.join("hzk.epoch");
    let previous = read_supervisor_epoch(state_dir).unwrap_or(0);
    let next = previous.saturating_add(1).max(1);
    crate::permm::write_new(&path, format!("{next}\n").as_bytes())
        .map_err(|e| format!("cannot write {}: {}", path.display(), e))?;
    Ok(next)
}

/// Read the current on-disk supervisor epoch, if present and parseable.
pub fn read_supervisor_epoch(state_dir: &Path) -> Option<u64> {
    let path = state_dir.join("hzk.epoch");
    let raw = fs::read_to_string(&path).ok()?;
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return None;
    }
    trimmed.parse::<u64>().ok().filter(|n| *n > 0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn advance_supervisor_epoch_starts_at_one_and_increments() {
        let dir = std::env::temp_dir().join(format!("hz-epoch-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        assert_eq!(advance_supervisor_epoch(&dir).unwrap(), 1);
        assert_eq!(read_supervisor_epoch(&dir), Some(1));
        assert_eq!(advance_supervisor_epoch(&dir).unwrap(), 2);
        assert_eq!(read_supervisor_epoch(&dir), Some(2));
        let _ = fs::remove_dir_all(&dir);
    }
}
