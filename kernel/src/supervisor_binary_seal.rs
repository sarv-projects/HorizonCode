//! H-30 / CB-6 / ruling **710** — release-binary seal for detach durability.
//!
//! Each fresh `--socket` bind writes `<state>/hzk.binary` with the sha256 hex
//! digest of the running `hz-kernel` executable. Reattach clients compare the
//! on-disk seal, their configured binary, and `ping.supervisorBinarySha256`.
//! Does **not** claim Windows detach or cross-build hot-swap policy.

use std::fs;
use std::path::Path;

use crate::canon;

const SEAL_FILE: &str = "hzk.binary";

fn is_sha256_hex(s: &str) -> bool {
    s.len() == 64
        && s.bytes().all(|b| {
            (b'0'..=b'9').contains(&b) || (b'a'..=b'f').contains(&b)
        })
}

/// Sha256 hex of the currently running `hz-kernel` image bytes.
pub fn running_binary_sha256() -> Result<String, String> {
    let exe = std::env::current_exe()
        .map_err(|e| format!("HZ_PRECONDITION_FAILED: cannot resolve hz-kernel binary path: {e}"))?;
    let bytes = fs::read(&exe)
        .map_err(|e| format!("HZ_PRECONDITION_FAILED: cannot read hz-kernel binary {}: {e}", exe.display()))?;
    Ok(canon::sha256_bytes(&bytes))
}

/// Write `<state_dir>/hzk.binary` with the running release image digest.
pub fn seal_detach_binary(state_dir: &Path) -> Result<String, String> {
    let digest = running_binary_sha256()?;
    let path = state_dir.join(SEAL_FILE);
    crate::permm::write_new(path.as_path(), format!("{digest}\n").as_bytes())
        .map_err(|e| format!("cannot write {}: {}", path.display(), e))?;
    Ok(digest)
}

/// Read the on-disk detach binary seal when present and well-formed.
pub fn read_detach_binary_seal(state_dir: &Path) -> Option<String> {
    let path = state_dir.join(SEAL_FILE);
    let raw = fs::read_to_string(&path).ok()?;
    let trimmed = raw.trim();
    if is_sha256_hex(trimmed) {
        Some(trimmed.to_string())
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn seal_detach_binary_records_current_exe_sha() {
        let dir = std::env::temp_dir().join(format!("hz-bin-seal-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let expected = running_binary_sha256().expect("exe hash");
        let sealed = seal_detach_binary(&dir).expect("seal");
        assert_eq!(sealed, expected);
        assert_eq!(read_detach_binary_seal(&dir), Some(expected));
        let _ = fs::remove_dir_all(&dir);
    }
}