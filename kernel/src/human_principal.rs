//! Human vs parent-control attribution and Ed25519 cryptographic human-principal
//! verification on permission mints (rulings **682**, **719**, Wave A / Track A1).
//!
//! When a `guard.lease` or `guard.grant` request includes `humanSig`, the kernel
//! verifies the Ed25519 signature over `canonical_human_approval_payload(...)`,
//! enforces pinned public-key matching when configured, and rejects replayed
//! nonces via a bounded in-memory set (4096 entries). On success the minted
//! lease/grant is stamped `principal:"human"` and `principalVerified:true`.
//! Any invalid, tampered, or replayed signature fails closed.
//!
//! When `HZ_HUMAN_PRINCIPAL_STRICT=1`, unsigned `principal:"human"` claims and
//! unsigned parent-control mints are refused at the kernel boundary.
//!
//! Never shell-net `enforced`.

use std::collections::{HashSet, VecDeque};
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};

use ring::signature::{UnparsedPublicKey, ED25519};

pub const HUMAN_APPROVAL_PRINCIPAL: &str = "human";
pub const PARENT_CONTROL_PRINCIPAL: &str = "parent";
const HUMAN_PRINCIPAL_STRICT_ENV: &str = "HZ_HUMAN_PRINCIPAL_STRICT";
const HUMAN_PRINCIPAL_PUBKEY_ENV: &str = "HZ_HUMAN_PRINCIPAL_PUBKEY_HEX";

/// Fixed 12-byte ASN.1 SubjectPublicKeyInfo (SPKI) DER prefix for Ed25519
/// (`302a300506032b6570032100`). Followed by the 32-byte raw public key.
const ED25519_SPKI_PREFIX: [u8; 12] = [
    0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00,
];
const MAX_REPLAY_NONCES: usize = 4096;
/// Maximum allowed clock skew / staleness for `humanIssuedAt` (+/- 5 minutes).
const MAX_ISSUED_AT_SKEW_MS: i64 = 5 * 60 * 1_000;

struct ReplayNonceCache {
    seen: HashSet<String>,
    order: VecDeque<String>,
}

impl ReplayNonceCache {
    fn new() -> Self {
        Self {
            seen: HashSet::with_capacity(256),
            order: VecDeque::with_capacity(256),
        }
    }

    fn contains(&self, nonce: &str) -> bool {
        self.seen.contains(nonce)
    }

    fn insert(&mut self, nonce: String) -> bool {
        if self.seen.contains(&nonce) {
            return false;
        }
        while self.seen.len() >= MAX_REPLAY_NONCES {
            if let Some(oldest) = self.order.pop_front() {
                self.seen.remove(&oldest);
            } else {
                break;
            }
        }
        self.order.push_back(nonce.clone());
        self.seen.insert(nonce);
        true
    }
}

fn replay_nonce_cache() -> &'static Mutex<ReplayNonceCache> {
    static CACHE: OnceLock<Mutex<ReplayNonceCache>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(ReplayNonceCache::new()))
}

pub fn human_principal_strict_enabled() -> bool {
    match std::env::var(HUMAN_PRINCIPAL_STRICT_ENV) {
        Ok(raw) => {
            let v = raw.trim().to_ascii_lowercase();
            v == "1" || v == "true" || v == "yes"
        }
        Err(_) => false,
    }
}

fn decode_hex(input: &str) -> Result<Vec<u8>, String> {
    let trimmed = input.trim();
    if trimmed.is_empty() || trimmed.len() % 2 != 0 {
        return Err("invalid hex string length".to_string());
    }
    let bytes = trimmed.as_bytes();
    let mut out = Vec::with_capacity(bytes.len() / 2);
    for pair in bytes.chunks_exact(2) {
        let hi = hex_nibble(pair[0])?;
        let lo = hex_nibble(pair[1])?;
        out.push((hi << 4) | lo);
    }
    Ok(out)
}

fn hex_nibble(b: u8) -> Result<u8, String> {
    match b {
        b'0'..=b'9' => Ok(b - b'0'),
        b'a'..=b'f' => Ok(b - b'a' + 10),
        b'A'..=b'F' => Ok(b - b'A' + 10),
        _ => Err(format!("invalid hex character: 0x{:02x}", b)),
    }
}

/// Extract the raw 32-byte Ed25519 public key from either:
/// - 44-byte Ed25519 SPKI DER hex (`302a300506032b6570032100` + 32-byte key), or
/// - raw 32-byte public key hex.
fn extract_raw_ed25519_pubkey(pub_key_spki_hex: &str) -> Result<[u8; 32], String> {
    let bytes = decode_hex(pub_key_spki_hex)
        .map_err(|e| format!("HZ_PRECONDITION_FAILED: invalid human public key hex: {e}"))?;
    match bytes.len() {
        44 => {
            if bytes[..12] != ED25519_SPKI_PREFIX {
                return Err(
                    "HZ_PRECONDITION_FAILED: 44-byte public key does not have Ed25519 SPKI DER prefix 302a300506032b6570032100"
                        .to_string(),
                );
            }
            let mut raw = [0u8; 32];
            raw.copy_from_slice(&bytes[12..44]);
            Ok(raw)
        }
        32 => {
            let mut raw = [0u8; 32];
            raw.copy_from_slice(&bytes);
            Ok(raw)
        }
        other => Err(format!(
            "HZ_PRECONDITION_FAILED: expected 32-byte raw or 44-byte Ed25519 SPKI DER public key, got {other} bytes"
        )),
    }
}

/// Deterministic canonical payload signed by the human approval key.
/// Must match the TypeScript signer byte-for-byte.
pub fn canonical_human_approval_payload(
    intent_digest: &str,
    kind: &str,
    target: &str,
    session_id: &str,
    ttl_ms: u64,
    nonce: &str,
    issued_at: &str,
) -> String {
    format!(
        "hz-human-approval-v1\nintent={intent_digest}\nkind={kind}\ntarget={target}\nsession={session_id}\nttl_ms={ttl_ms}\nnonce={nonce}\nissued_at={issued_at}"
    )
}

/// Verify an Ed25519 signature over `payload_utf8` using either a 44-byte
/// Ed25519 SPKI DER hex public key or a raw 32-byte hex public key.
pub fn verify_human_approval_signature(
    pub_key_spki_hex: &str,
    sig_hex: &str,
    payload_utf8: &str,
) -> Result<(), String> {
    let raw_pub = extract_raw_ed25519_pubkey(pub_key_spki_hex)?;
    let sig_bytes = decode_hex(sig_hex)
        .map_err(|e| format!("HZ_PRECONDITION_FAILED: invalid humanSig hex: {e}"))?;
    if sig_bytes.len() != 64 {
        return Err(format!(
            "HZ_PRECONDITION_FAILED: Ed25519 signature must be 64 bytes, got {} bytes",
            sig_bytes.len()
        ));
    }
    let verifier = UnparsedPublicKey::new(&ED25519, &raw_pub);
    verifier
        .verify(payload_utf8.as_bytes(), &sig_bytes)
        .map_err(|_| {
            "HZ_PRECONDITION_FAILED: Ed25519 human approval signature verification failed"
                .to_string()
        })
}

/// Read-only lookup of a pinned human-principal public key hex:
/// 1. `HZ_HUMAN_PRINCIPAL_PUBKEY_HEX` environment variable (if set and non-empty), or
/// 2. `~/.config/horizon/keys/human-approval.pub` (if present and non-empty).
pub fn pinned_human_pubkey_hex() -> Result<Option<String>, String> {
    if let Ok(raw) = std::env::var(HUMAN_PRINCIPAL_PUBKEY_ENV) {
        let trimmed = raw.trim();
        if !trimmed.is_empty() {
            return Ok(Some(trimmed.to_string()));
        }
    }
    let home = std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE"));
    if let Some(home_dir) = home {
        let path = PathBuf::from(home_dir)
            .join(".config")
            .join("horizon")
            .join("keys")
            .join("human-approval.pub");
        if path.exists() {
            let contents = std::fs::read_to_string(&path).map_err(|e| {
                format!(
                    "HZ_PRECONDITION_FAILED: failed to read pinned human public key {}: {e}",
                    path.display()
                )
            })?;
            let trimmed = contents.trim();
            if !trimmed.is_empty() {
                return Ok(Some(trimmed.to_string()));
            }
        }
    }
    Ok(None)
}

pub struct HumanApprovalProof<'a> {
    pub sig_hex: &'a str,
    pub pub_key_hex: Option<&'a str>,
    pub nonce: &'a str,
    pub issued_at: &'a str,
    pub intent_digest: &'a str,
    pub kind: &'a str,
    pub target: &'a str,
    pub session_id: &'a str,
    pub ttl_ms: u64,
}

fn reject_control_delimiters(field: &str, value: &str) -> Result<(), String> {
    if value.bytes().any(|b| b == b'\n' || b == b'\r' || b == b'\0') {
        return Err(format!(
            "HZ_PRECONDITION_FAILED: human approval field '{field}' must not contain CR, LF, or NUL"
        ));
    }
    Ok(())
}

fn parse_issued_at_millis(issued_at: &str) -> Result<i64, String> {
    let trimmed = issued_at.trim();
    if let Some(ms) = crate::time::parse_iso_millis(trimmed) {
        return Ok(ms);
    }
    if !trimmed.is_empty() && trimmed.bytes().all(|b| b.is_ascii_digit()) {
        if let Ok(raw) = trimmed.parse::<i64>() {
            // 13+ digits -> Unix milliseconds; 10 digits -> Unix seconds.
            if raw >= 1_000_000_000_000 {
                return Ok(raw);
            }
            if raw >= 1_000_000_000 {
                return raw.checked_mul(1_000).ok_or_else(|| {
                    "HZ_PRECONDITION_FAILED: humanIssuedAt timestamp overflow".to_string()
                });
            }
        }
    }
    Err(
        "HZ_PRECONDITION_FAILED: humanIssuedAt must be a valid ISO-8601 or Unix timestamp"
            .to_string(),
    )
}

fn verify_issued_at_freshness(issued_at: &str) -> Result<(), String> {
    let issued_ms = parse_issued_at_millis(issued_at)?;
    let now_ms = crate::time::now_millis();
    let skew_ms = (now_ms - issued_ms).abs();
    if skew_ms > MAX_ISSUED_AT_SKEW_MS {
        return Err(format!(
            "HZ_PRECONDITION_FAILED: humanIssuedAt outside allowed freshness window (skew {}ms > {}ms)",
            skew_ms, MAX_ISSUED_AT_SKEW_MS
        ));
    }
    Ok(())
}

/// Verify a human approval signature against pinned/supplied public key,
/// canonical payload, and the bounded in-memory replay-nonce set.
/// Always fails closed on any invalid, tampered, mismatched, or replayed proof.
pub fn verify_and_consume_human_approval(proof: &HumanApprovalProof<'_>) -> Result<(), String> {
    let nonce = proof.nonce.trim();
    if nonce.is_empty() {
        return Err(
            "HZ_PRECONDITION_FAILED: humanNonce must be a non-empty string when humanSig is provided"
                .to_string(),
        );
    }
    let issued_at = proof.issued_at.trim();
    if issued_at.is_empty() {
        return Err(
            "HZ_PRECONDITION_FAILED: humanIssuedAt must be a non-empty string when humanSig is provided"
                .to_string(),
        );
    }

    // Reject CR/LF/NUL in all canonical payload fields to eliminate delimiter collision
    // while preserving the exact `hz-human-approval-v1` wire format with TS.
    reject_control_delimiters("intentDigest", proof.intent_digest)?;
    reject_control_delimiters("kind", proof.kind)?;
    reject_control_delimiters("target", proof.target)?;
    reject_control_delimiters("sessionId", proof.session_id)?;
    reject_control_delimiters("humanNonce", nonce)?;
    reject_control_delimiters("humanIssuedAt", issued_at)?;

    // Enforce issued_at freshness against current kernel clock.
    verify_issued_at_freshness(issued_at)?;

    // Resolve and validate public key (enforcing pin if configured, and requiring a
    // pinned key in HZ_HUMAN_PRINCIPAL_STRICT=1 mode).
    let pinned = pinned_human_pubkey_hex()?;
    let effective_pub_hex: String = match (pinned, proof.pub_key_hex.map(str::trim).filter(|s| !s.is_empty())) {
        (Some(pinned_hex), Some(supplied_hex)) => {
            let pinned_raw = extract_raw_ed25519_pubkey(&pinned_hex)?;
            let supplied_raw = extract_raw_ed25519_pubkey(supplied_hex)?;
            if pinned_raw != supplied_raw {
                return Err(
                    "HZ_PRECONDITION_FAILED: humanPubKeyHex does not match pinned human principal public key"
                        .to_string(),
                );
            }
            pinned_hex
        }
        (Some(pinned_hex), None) => pinned_hex,
        (None, Some(supplied_hex)) => {
            if human_principal_strict_enabled() {
                return Err(format!(
                    "HZ_PRECONDITION_FAILED: {HUMAN_PRINCIPAL_STRICT_ENV}=1 requires a pinned human principal public key ({HUMAN_PRINCIPAL_PUBKEY_ENV} or ~/.config/horizon/keys/human-approval.pub)"
                ));
            }
            supplied_hex.to_string()
        }
        (None, None) => {
            return Err(
                "HZ_PRECONDITION_FAILED: humanPubKeyHex is required when humanSig is provided and no pinned public key is configured"
                    .to_string(),
            );
        }
    };

    // Fast-fail if nonce was already consumed.
    {
        let cache = replay_nonce_cache()
            .lock()
            .map_err(|_| "HZ_PRECONDITION_FAILED: replay nonce lock poisoned".to_string())?;
        if cache.contains(nonce) {
            return Err(
                "HZ_PRECONDITION_FAILED: humanNonce already used (replayed human approval rejected)"
                    .to_string(),
            );
        }
    }

    let payload = canonical_human_approval_payload(
        proof.intent_digest,
        proof.kind,
        proof.target,
        proof.session_id,
        proof.ttl_ms,
        nonce,
        issued_at,
    );

    verify_human_approval_signature(&effective_pub_hex, proof.sig_hex, &payload)?;

    // Record nonce only after signature verification succeeds (prevents DoS
    // cache eviction with forged signatures) while still checking atomically
    // against concurrent replays.
    let mut cache = replay_nonce_cache()
        .lock()
        .map_err(|_| "HZ_PRECONDITION_FAILED: replay nonce lock poisoned".to_string())?;
    if !cache.insert(nonce.to_string()) {
        return Err(
            "HZ_PRECONDITION_FAILED: humanNonce already used (replayed human approval rejected)"
                .to_string(),
        );
    }

    Ok(())
}

/// When the kernel is parent-control-bound (fd-3), stamp or refuse non-human mints.
pub fn normalize_parent_control_mint_principal(
    parent_control_bound: bool,
    principal: Option<String>,
) -> Result<Option<String>, String> {
    if !parent_control_bound {
        return Ok(principal);
    }
    if principal.as_deref() == Some(HUMAN_APPROVAL_PRINCIPAL) {
        return Ok(principal);
    }
    if human_principal_strict_enabled() {
        return Err(format!(
            "HZ_PRECONDITION_FAILED: {HUMAN_PRINCIPAL_STRICT_ENV}=1 refuses parent-control guard.lease/guard.grant mint without principal:\"{HUMAN_APPROVAL_PRINCIPAL}\" — fd-3 proves controlling Bun parent only (ruling 352); cryptographic human identity remains OPEN"
        ));
    }
    Ok(Some(PARENT_CONTROL_PRINCIPAL.to_string()))
}

/// Resolve `(principal, principal_verified)` for `guard.lease` and `guard.grant`.
///
/// - When `human_sig_verified` is true, stamps `principal: "human"` and
///   `principal_verified: Some(true)`.
/// - When `human_sig_verified` is false and `HZ_HUMAN_PRINCIPAL_STRICT=1`,
///   refuses unsigned `principal: "human"` claims (fail closed).
/// - Otherwise preserves existing non-strict parent-control normalization.
pub fn resolve_mint_principal(
    parent_control_bound: bool,
    principal: Option<String>,
    human_sig_verified: bool,
) -> Result<(Option<String>, Option<bool>), String> {
    if human_sig_verified {
        return Ok((Some(HUMAN_APPROVAL_PRINCIPAL.to_string()), Some(true)));
    }
    if human_principal_strict_enabled()
        && principal.as_deref() == Some(HUMAN_APPROVAL_PRINCIPAL)
    {
        return Err(format!(
            "HZ_PRECONDITION_FAILED: {HUMAN_PRINCIPAL_STRICT_ENV}=1 refuses unsigned principal:\"{HUMAN_APPROVAL_PRINCIPAL}\" mint without a valid Ed25519 humanSig (fd-3 proves controlling parent only, ruling 352)"
        ));
    }
    let normalized = normalize_parent_control_mint_principal(parent_control_bound, principal)?;
    Ok((normalized, None))
}

#[cfg(test)]
mod tests {
    use super::*;
    use ring::rand::SystemRandom;
    use ring::signature::{Ed25519KeyPair, KeyPair};
    use std::sync::{Mutex, OnceLock};

    fn env_lock() -> &'static Mutex<()> {
        static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
        LOCK.get_or_init(|| Mutex::new(()))
    }

    struct EnvGuard {
        saved: Vec<(&'static str, Option<std::ffi::OsString>)>,
    }

    impl EnvGuard {
        fn isolate_clean() -> Self {
            let keys = [
                HUMAN_PRINCIPAL_STRICT_ENV,
                HUMAN_PRINCIPAL_PUBKEY_ENV,
                "HOME",
                "USERPROFILE",
            ];
            let saved = keys
                .iter()
                .map(|&k| (k, std::env::var_os(k)))
                .collect::<Vec<_>>();
            std::env::remove_var(HUMAN_PRINCIPAL_STRICT_ENV);
            std::env::remove_var(HUMAN_PRINCIPAL_PUBKEY_ENV);
            std::env::set_var("HOME", "/nonexistent-hz-test-home");
            std::env::set_var("USERPROFILE", "/nonexistent-hz-test-home");
            Self { saved }
        }
    }

    impl Drop for EnvGuard {
        fn drop(&mut self) {
            for (k, v) in &self.saved {
                match v {
                    Some(val) => std::env::set_var(k, val),
                    None => std::env::remove_var(k),
                }
            }
        }
    }

    fn encode_hex(bytes: &[u8]) -> String {
        let mut s = String::with_capacity(bytes.len() * 2);
        for b in bytes {
            use std::fmt::Write;
            let _ = write!(&mut s, "{:02x}", b);
        }
        s
    }

    fn gen_test_keypair() -> (Ed25519KeyPair, String, String) {
        let rng = SystemRandom::new();
        let pkcs8 = Ed25519KeyPair::generate_pkcs8(&rng).expect("generate ed25519 pkcs8");
        let kp = Ed25519KeyPair::from_pkcs8(pkcs8.as_ref()).expect("parse ed25519 pkcs8");
        let (spki_hex, raw_hex) = {
            let raw_pub = kp.public_key().as_ref();
            assert_eq!(raw_pub.len(), 32);
            let mut spki = Vec::with_capacity(44);
            spki.extend_from_slice(&ED25519_SPKI_PREFIX);
            spki.extend_from_slice(raw_pub);
            (encode_hex(&spki), encode_hex(raw_pub))
        };
        (kp, spki_hex, raw_hex)
    }

    #[test]
    fn unbound_kernel_preserves_caller_principal() {
        let _g = env_lock().lock().unwrap_or_else(|e| e.into_inner());
        let _env = EnvGuard::isolate_clean();
        assert_eq!(
            normalize_parent_control_mint_principal(false, None).unwrap(),
            None
        );
    }

    #[test]
    fn parent_bound_stamps_parent_when_not_human() {
        let _g = env_lock().lock().unwrap_or_else(|e| e.into_inner());
        let _env = EnvGuard::isolate_clean();
        assert_eq!(
            normalize_parent_control_mint_principal(false, Some("human".into())).unwrap(),
            Some("human".into())
        );
        assert_eq!(
            normalize_parent_control_mint_principal(true, None).unwrap(),
            Some(PARENT_CONTROL_PRINCIPAL.to_string())
        );
        assert_eq!(
            normalize_parent_control_mint_principal(true, Some("human".into())).unwrap(),
            Some("human".into())
        );
    }

    #[test]
    fn strict_refuses_non_human_parent_mint() {
        let _g = env_lock().lock().unwrap_or_else(|e| e.into_inner());
        let _env = EnvGuard::isolate_clean();
        std::env::set_var(HUMAN_PRINCIPAL_STRICT_ENV, "1");
        let err = normalize_parent_control_mint_principal(true, None).unwrap_err();
        assert!(err.contains(HUMAN_PRINCIPAL_STRICT_ENV), "{err}");
        assert!(err.contains("352"), "{err}");
    }

    #[test]
    fn valid_ed25519_spki_der_and_raw_signature_verify() {
        let _g = env_lock().lock().unwrap_or_else(|e| e.into_inner());
        let _env = EnvGuard::isolate_clean();
        let (kp, spki_hex, raw_hex) = gen_test_keypair();
        assert_eq!(spki_hex.len(), 88);
        assert_eq!(raw_hex.len(), 64);

        let wire_check = canonical_human_approval_payload(
            "sha256:deadbeef",
            "shell.exec",
            "git status",
            "sess-1",
            60_000,
            "nonce-valid-spki-001",
            "2026-11-26T00:00:00Z",
        );
        assert_eq!(
            wire_check,
            "hz-human-approval-v1\nintent=sha256:deadbeef\nkind=shell.exec\ntarget=git status\nsession=sess-1\nttl_ms=60000\nnonce=nonce-valid-spki-001\nissued_at=2026-11-26T00:00:00Z"
        );

        let now = crate::time::now_iso();
        let payload = canonical_human_approval_payload(
            "sha256:deadbeef",
            "shell.exec",
            "git status",
            "sess-1",
            60_000,
            "nonce-valid-spki-001",
            &now,
        );
        let sig_hex = encode_hex(kp.sign(payload.as_bytes()).as_ref());

        verify_human_approval_signature(&spki_hex, &sig_hex, &payload)
            .expect("44-byte SPKI DER hex should verify");
        verify_human_approval_signature(&raw_hex, &sig_hex, &payload)
            .expect("32-byte raw hex should verify");

        let proof = HumanApprovalProof {
            sig_hex: &sig_hex,
            pub_key_hex: Some(&spki_hex),
            nonce: "nonce-valid-spki-001",
            issued_at: &now,
            intent_digest: "sha256:deadbeef",
            kind: "shell.exec",
            target: "git status",
            session_id: "sess-1",
            ttl_ms: 60_000,
        };
        verify_and_consume_human_approval(&proof)
            .expect("full approval proof with SPKI DER key should verify");
    }

    #[test]
    fn tampered_payload_is_rejected() {
        let _g = env_lock().lock().unwrap_or_else(|e| e.into_inner());
        let _env = EnvGuard::isolate_clean();
        let (kp, spki_hex, _) = gen_test_keypair();
        let now = crate::time::now_iso();
        let original = canonical_human_approval_payload(
            "sha256:abc",
            "shell.exec",
            "echo safe",
            "sess-2",
            30_000,
            "nonce-tamper-001",
            &now,
        );
        let sig_hex = encode_hex(kp.sign(original.as_bytes()).as_ref());

        let tampered = canonical_human_approval_payload(
            "sha256:abc",
            "shell.exec",
            "rm -rf /",
            "sess-2",
            30_000,
            "nonce-tamper-001",
            &now,
        );
        let err = verify_human_approval_signature(&spki_hex, &sig_hex, &tampered).unwrap_err();
        assert!(err.contains("verification failed"), "{err}");

        let proof = HumanApprovalProof {
            sig_hex: &sig_hex,
            pub_key_hex: Some(&spki_hex),
            nonce: "nonce-tamper-001",
            issued_at: &now,
            intent_digest: "sha256:abc",
            kind: "shell.exec",
            target: "rm -rf /",
            session_id: "sess-2",
            ttl_ms: 30_000,
        };
        assert!(verify_and_consume_human_approval(&proof).is_err());
    }

    #[test]
    fn replayed_nonce_is_rejected() {
        let _g = env_lock().lock().unwrap_or_else(|e| e.into_inner());
        let _env = EnvGuard::isolate_clean();
        let (kp, spki_hex, _) = gen_test_keypair();
        let now = crate::time::now_iso();
        let payload = canonical_human_approval_payload(
            "sha256:replay",
            "fs.write",
            "/tmp/out.txt",
            "sess-3",
            15_000,
            "nonce-replay-001",
            &now,
        );
        let sig_hex = encode_hex(kp.sign(payload.as_bytes()).as_ref());

        let proof = HumanApprovalProof {
            sig_hex: &sig_hex,
            pub_key_hex: Some(&spki_hex),
            nonce: "nonce-replay-001",
            issued_at: &now,
            intent_digest: "sha256:replay",
            kind: "fs.write",
            target: "/tmp/out.txt",
            session_id: "sess-3",
            ttl_ms: 15_000,
        };
        verify_and_consume_human_approval(&proof).expect("first use of nonce should pass");
        let err = verify_and_consume_human_approval(&proof).unwrap_err();
        assert!(err.contains("replayed") || err.contains("already used"), "{err}");
    }

    #[test]
    fn strict_mode_rejects_unsigned_human_claim() {
        let _g = env_lock().lock().unwrap_or_else(|e| e.into_inner());
        let _env = EnvGuard::isolate_clean();
        std::env::set_var(HUMAN_PRINCIPAL_STRICT_ENV, "1");
        let err_bound =
            resolve_mint_principal(true, Some("human".into()), false).unwrap_err();
        assert!(err_bound.contains("humanSig"), "{err_bound}");
        let err_unbound =
            resolve_mint_principal(false, Some("human".into()), false).unwrap_err();
        assert!(err_unbound.contains("humanSig"), "{err_unbound}");

        // Signed human approval succeeds and stamps principalVerified = Some(true).
        let (principal, verified) =
            resolve_mint_principal(true, Some("human".into()), true).unwrap();
        assert_eq!(principal.as_deref(), Some("human"));
        assert_eq!(verified, Some(true));
    }

    #[test]
    fn pinned_pubkey_mismatch_is_rejected() {
        let _g = env_lock().lock().unwrap_or_else(|e| e.into_inner());
        let _env = EnvGuard::isolate_clean();
        let (_kp_pinned, pinned_spki_hex, _) = gen_test_keypair();
        let (kp_other, other_spki_hex, _) = gen_test_keypair();
        std::env::set_var(HUMAN_PRINCIPAL_PUBKEY_ENV, &pinned_spki_hex);

        let now = crate::time::now_iso();
        let payload = canonical_human_approval_payload(
            "sha256:pin",
            "shell.exec",
            "ls",
            "sess-4",
            10_000,
            "nonce-pin-001",
            &now,
        );
        let sig_hex = encode_hex(kp_other.sign(payload.as_bytes()).as_ref());
        let proof = HumanApprovalProof {
            sig_hex: &sig_hex,
            pub_key_hex: Some(&other_spki_hex),
            nonce: "nonce-pin-001",
            issued_at: &now,
            intent_digest: "sha256:pin",
            kind: "shell.exec",
            target: "ls",
            session_id: "sess-4",
            ttl_ms: 10_000,
        };
        let err = verify_and_consume_human_approval(&proof).unwrap_err();
        assert!(err.contains("pinned"), "{err}");
    }

    #[test]
    fn delimiter_injection_in_payload_fields_is_rejected() {
        let _g = env_lock().lock().unwrap_or_else(|e| e.into_inner());
        let _env = EnvGuard::isolate_clean();
        let (kp, spki_hex, _) = gen_test_keypair();
        let now = crate::time::now_iso();
        for bad_target in ["echo ok\nsession=evil", "echo ok\rfoo", "echo\0ok"] {
            let payload = canonical_human_approval_payload(
                "sha256:delim",
                "shell.exec",
                bad_target,
                "sess-5",
                10_000,
                "nonce-delim-001",
                &now,
            );
            let sig_hex = encode_hex(kp.sign(payload.as_bytes()).as_ref());
            let proof = HumanApprovalProof {
                sig_hex: &sig_hex,
                pub_key_hex: Some(&spki_hex),
                nonce: "nonce-delim-001",
                issued_at: &now,
                intent_digest: "sha256:delim",
                kind: "shell.exec",
                target: bad_target,
                session_id: "sess-5",
                ttl_ms: 10_000,
            };
            let err = verify_and_consume_human_approval(&proof).unwrap_err();
            assert!(err.contains("CR, LF, or NUL"), "{err}");
        }
    }

    #[test]
    fn strict_mode_requires_pinned_pubkey_even_when_caller_supplies_one() {
        let _g = env_lock().lock().unwrap_or_else(|e| e.into_inner());
        let _env = EnvGuard::isolate_clean();
        std::env::set_var(HUMAN_PRINCIPAL_STRICT_ENV, "1");
        let (kp, spki_hex, _) = gen_test_keypair();
        let now = crate::time::now_iso();
        let payload = canonical_human_approval_payload(
            "sha256:strict-pin",
            "shell.exec",
            "echo hi",
            "sess-6",
            10_000,
            "nonce-strict-pin-001",
            &now,
        );
        let sig_hex = encode_hex(kp.sign(payload.as_bytes()).as_ref());
        let proof = HumanApprovalProof {
            sig_hex: &sig_hex,
            pub_key_hex: Some(&spki_hex),
            nonce: "nonce-strict-pin-001",
            issued_at: &now,
            intent_digest: "sha256:strict-pin",
            kind: "shell.exec",
            target: "echo hi",
            session_id: "sess-6",
            ttl_ms: 10_000,
        };
        let err = verify_and_consume_human_approval(&proof).unwrap_err();
        assert!(err.contains("requires a pinned"), "{err}");

        // Once pinned, the same proof succeeds.
        std::env::set_var(HUMAN_PRINCIPAL_PUBKEY_ENV, &spki_hex);
        verify_and_consume_human_approval(&proof)
            .expect("strict mode should accept proof matching pinned pubkey");
    }

    #[test]
    fn stale_or_future_issued_at_is_rejected() {
        let _g = env_lock().lock().unwrap_or_else(|e| e.into_inner());
        let _env = EnvGuard::isolate_clean();
        let (kp, spki_hex, _) = gen_test_keypair();
        let stale = crate::time::iso_from_unix_millis(crate::time::now_millis() - 10 * 60 * 1_000);
        let future = crate::time::iso_from_unix_millis(crate::time::now_millis() + 10 * 60 * 1_000);

        for (tag, ts) in [("stale", stale), ("future", future)] {
            let payload = canonical_human_approval_payload(
                "sha256:skew",
                "shell.exec",
                "echo hi",
                "sess-7",
                10_000,
                &format!("nonce-skew-{tag}"),
                &ts,
            );
            let sig_hex = encode_hex(kp.sign(payload.as_bytes()).as_ref());
            let proof = HumanApprovalProof {
                sig_hex: &sig_hex,
                pub_key_hex: Some(&spki_hex),
                nonce: &format!("nonce-skew-{tag}"),
                issued_at: &ts,
                intent_digest: "sha256:skew",
                kind: "shell.exec",
                target: "echo hi",
                session_id: "sess-7",
                ttl_ms: 10_000,
            };
            let err = verify_and_consume_human_approval(&proof).unwrap_err();
            assert!(err.contains("freshness"), "{tag}: {err}");
        }
    }
}
