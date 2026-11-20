//! Kernel-held HMAC issuer stamp for minted receipts (R172 partial).
//!
//! The key lives only in kernel state (`.receipt-issuer.key`, mode 0600). Bun
//! cannot forge stamps without reading that file; minting still goes through
//! `receipt.issue` on the trusted kernel.

use std::fs;
use std::path::Path;

use crate::canon::hmac_sha256_hex;
use crate::permm;

pub const KEY_FILENAME: &str = ".receipt-issuer.key";

/// Load an existing key, or create and persist one when `create` is true.
pub fn load_or_create(state_dir: &Path, create: bool) -> Result<Option<Vec<u8>>, String> {
    let path = state_dir.join(KEY_FILENAME);
    if path.is_file() {
        return read_key_file(&path);
    }
    if !create {
        return Ok(None);
    }
    let mut raw = [0u8; 32];
    fill_random(&mut raw)?;
    let hex: String = raw.iter().map(|b| format!("{b:02x}")).collect();
    fs::create_dir_all(state_dir)
        .map_err(|e| format!("cannot create {}: {}", state_dir.display(), e))?;
    permm::private_dir(state_dir);
    permm::write_new(&path, hex.as_bytes())
        .map_err(|e| format!("cannot write {}: {}", path.display(), e))?;
    Ok(Some(raw.to_vec()))
}

fn read_key_file(path: &Path) -> Result<Option<Vec<u8>>, String> {
    let text = fs::read_to_string(path)
        .map_err(|e| format!("cannot read {}: {}", path.display(), e))?;
    let hex = text.trim();
    if hex.len() != 64 || !hex.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err("HZ_PRECONDITION_FAILED: invalid receipt issuer key file".into());
    }
    let mut key = Vec::with_capacity(32);
    for chunk in hex.as_bytes().chunks(2) {
        let hi = hex_nibble(chunk[0])?;
        let lo = hex_nibble(chunk[1])?;
        key.push((hi << 4) | lo);
    }
    Ok(Some(key))
}

fn fill_random(out: &mut [u8]) -> Result<(), String> {
    #[cfg(unix)]
    {
        use std::io::Read;
        let mut file = std::fs::File::open("/dev/urandom")
            .map_err(|_| "HZ_PRECONDITION_FAILED: cannot generate receipt issuer key".to_string())?;
        file.read_exact(out)
            .map_err(|_| "HZ_PRECONDITION_FAILED: cannot generate receipt issuer key".to_string())
    }
    #[cfg(not(unix))]
    {
        let _ = out;
        Err("HZ_PRECONDITION_FAILED: receipt issuer key requires Unix".into())
    }
}

fn hex_nibble(b: u8) -> Result<u8, String> {
    match b {
        b'0'..=b'9' => Ok(b - b'0'),
        b'a'..=b'f' => Ok(b - b'a' + 10),
        b'A'..=b'F' => Ok(b - b'A' + 10),
        _ => Err("HZ_PRECONDITION_FAILED: invalid receipt issuer key hex".into()),
    }
}

pub fn stamp_hex(key: &[u8], receipt_hash: &str) -> String {
    hmac_sha256_hex(key, receipt_hash.as_bytes())
}

pub fn verify_hex(key: &[u8], receipt_hash: &str, stamp: &str) -> bool {
    if stamp.len() != 64 || !stamp.bytes().all(|b| b.is_ascii_hexdigit()) {
        return false;
    }
    let expected = stamp_hex(key, receipt_hash);
    if expected.len() != stamp.len() {
        return false;
    }
    let mut diff = 0u8;
    for (a, b) in expected.bytes().zip(stamp.bytes()) {
        diff |= a ^ b;
    }
    diff == 0
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::env::temp_dir;

    #[test]
    fn issuer_stamp_is_deterministic_and_verifiable() {
        let key = b"test-receipt-issuer-key-32bytes!";
        let hash = "a".repeat(64);
        let stamp = stamp_hex(key, &hash);
        assert!(verify_hex(key, &hash, &stamp));
        assert!(!verify_hex(key, &hash, &"b".repeat(64)));
        assert!(!verify_hex(b"other-key", &hash, &stamp));
    }

    #[test]
    fn load_or_create_persists_key() {
        let dir = temp_dir().join(format!("hz-issuer-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let key = load_or_create(&dir, true).unwrap().expect("created");
        assert_eq!(key.len(), 32);
        let again = load_or_create(&dir, false).unwrap().expect("loaded");
        assert_eq!(key, again);
        let _ = fs::remove_dir_all(&dir);
    }
}