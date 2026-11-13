//! Canonical JSON + SHA-256, mirroring `app/src/contracts.ts` (frozen, v0.1).
//!
//! Rules (see the header comment of contracts.ts):
//!  - objects: keys sorted lexicographically by UTF-8 bytes, compact, no whitespace
//!  - arrays: order preserved; strings/bools/null native
//!  - `undefined` is serialized as `null`; Rust callers simply omit absent fields
//!  - resulting string is UTF-8 encoded, SHA-256 hashed, hex lowercase
//!
//! Event hash input   = canonical JSON of {id,seq,ts,stream,type,actor,payload,prevHash}
//! Receipt hash input = canonical JSON of all receipt fields except `hash`
//!                      (`leaseId` is only included when the caller supplied it).
//!
//! v0.1 payloads carry strings/booleans/null/objects/arrays/integers only; floats are
//! serialized with serde_json's shortest round-trip form and are not part of the contract.

use serde_json::{Map, Value};
use sha2::{Digest, Sha256};

/// Envelope fields that feed the event hash, always present (order irrelevant here:
/// canonicalization sorts the keys).
pub const ENVELOPE_FIELDS: [&str; 8] = [
    "id",
    "seq",
    "ts",
    "stream",
    "type",
    "actor",
    "payload",
    "prevHash",
];

/// Receipt fields that feed the receipt hash, always present.
pub const RECEIPT_FIELDS: [&str; 8] = [
    "id",
    "seq",
    "ts",
    "action",
    "tool",
    "argsDigest",
    "resultDigest",
    "prevHash",
];

/// Canonical JSON: compact, object keys sorted by UTF-8 bytes.
pub fn canonical_json(v: &Value) -> String {
    let mut out = String::new();
    write_canonical(v, &mut out);
    out
}

fn write_canonical(v: &Value, out: &mut String) {
    match v {
        Value::Null => out.push_str("null"),
        Value::Bool(true) => out.push_str("true"),
        Value::Bool(false) => out.push_str("false"),
        Value::Number(n) => out.push_str(&n.to_string()),
        Value::String(s) => write_json_string(s, out),
        Value::Array(items) => {
            out.push('[');
            for (i, item) in items.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                write_canonical(item, out);
            }
            out.push(']');
        }
        Value::Object(map) => {
            let mut keys: Vec<&String> = map.keys().collect();
            keys.sort_unstable_by(|a, b| a.as_bytes().cmp(b.as_bytes()));
            out.push('{');
            for (i, key) in keys.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                write_json_string(key, out);
                out.push(':');
                write_canonical(&map[key.as_str()], out);
            }
            out.push('}');
        }
    }
}

fn write_json_string(s: &str, out: &mut String) {
    // serde_json escapes exactly like JSON.stringify for the characters that matter here.
    match serde_json::to_string(s) {
        Ok(escaped) => out.push_str(&escaped),
        Err(_) => {
            out.push('"');
            out.push_str(s);
            out.push('"');
        }
    }
}

/// sha256 of the UTF-8 bytes of `s`, hex lowercase.
pub fn sha256_hex(s: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(s.as_bytes());
    hex_lower(&hasher.finalize())
}

/// sha256 of raw bytes, hex lowercase (file observation digests).
pub fn sha256_bytes(data: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(data);
    hex_lower(&hasher.finalize())
}

/// HMAC-SHA256 (RFC 2104) of `message` under `key`, hex lowercase.
///
/// Built on the sha2 crate the chain hashes already use, so keyed anchors add
/// no dependency: HMAC(K, m) = H((K0 ^ opad) || H((K0 ^ ipad) || m)), with K0
/// zero-padded (or hashed first) to the 64-byte SHA-256 block.
/// Pinned against the RFC 4231 vectors in the tests below.
pub fn hmac_sha256_hex(key: &[u8], message: &[u8]) -> String {
    const BLOCK: usize = 64;
    let mut block_key = [0u8; BLOCK];
    if key.len() > BLOCK {
        block_key[..32].copy_from_slice(&Sha256::digest(key));
    } else {
        block_key[..key.len()].copy_from_slice(key);
    }
    let mut ipad = [0u8; BLOCK];
    let mut opad = [0u8; BLOCK];
    for i in 0..BLOCK {
        ipad[i] = block_key[i] ^ 0x36;
        opad[i] = block_key[i] ^ 0x5c;
    }
    let mut inner = Sha256::new();
    inner.update(ipad);
    inner.update(message);
    let inner = inner.finalize();
    let mut outer = Sha256::new();
    outer.update(opad);
    outer.update(inner);
    hex_lower(&outer.finalize())
}

fn hex_lower(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len() * 2);
    const HEX: &[u8; 16] = b"0123456789abcdef";
    for byte in bytes.iter() {
        out.push(HEX[(byte >> 4) as usize] as char);
        out.push(HEX[(byte & 0x0f) as usize] as char);
    }
    out
}

/// The digest stored in a `.head` anchor for one canonical record preimage:
/// plain sha256 when unkeyed (byte-identical to the legacy anchor), and
/// HMAC-SHA256(key, utf8(preimage)) when a key is configured.
pub fn anchor_digest(preimage: &Value, key: Option<&[u8]>) -> String {
    let canonical = canonical_json(preimage);
    match key {
        Some(key) => hmac_sha256_hex(key, canonical.as_bytes()),
        None => sha256_hex(&canonical),
    }
}

/// Hash of a `sha256` hex string shape check (64 lowercase hex chars).
pub fn is_hash(s: &str) -> bool {
    s.len() == 64 && s.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

/// The exact object that is canonicalized to hash an envelope.
pub fn envelope_preimage(envelope: &Value) -> Value {
    let mut map = Map::new();
    for field in ENVELOPE_FIELDS {
        map.insert(
            field.to_string(),
            envelope.get(field).cloned().unwrap_or(Value::Null),
        );
    }
    Value::Object(map)
}

pub fn hash_envelope(envelope: &Value) -> String {
    sha256_hex(&canonical_json(&envelope_preimage(envelope)))
}

/// The exact object that is canonicalized to hash a receipt.
pub fn receipt_preimage(receipt: &Value) -> Value {
    let mut map = Map::new();
    for field in RECEIPT_FIELDS {
        map.insert(
            field.to_string(),
            receipt.get(field).cloned().unwrap_or(Value::Null),
        );
    }
    match receipt.get("leaseId") {
        Some(v) if !v.is_null() => {
            map.insert("leaseId".to_string(), v.clone());
        }
        _ => {}
    }
    Value::Object(map)
}

pub fn hash_receipt(receipt: &Value) -> String {
    sha256_hex(&canonical_json(&receipt_preimage(receipt)))
}

pub fn error_response(id: Value, message: &str) -> Value {
    serde_json::json!({ "id": id, "error": { "message": message } })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn canonical_json_is_compact_and_sorted() {
        let v = json!({"b": 2, "a": {"d": [1, true, null, "x"], "c": false}, "z": null});
        assert_eq!(
            canonical_json(&v),
            "{\"a\":{\"c\":false,\"d\":[1,true,null,\"x\"]},\"b\":2,\"z\":null}"
        );
    }

    /// Hash stability: this digest is the contract-level answer for the same
    /// envelope object hashed by contracts.ts' canonicalJson + sha256Hex.
    #[test]
    fn event_hash_is_stable() {
        let envelope = json!({
            "id": "id-1",
            "seq": 1,
            "ts": "2026-01-01T00:00:00.000Z",
            "stream": "session:t",
            "type": "session.start",
            "actor": { "kind": "human", "id": "u1" },
            "payload": { "b": [true, null, "x"], "a": 1 },
            "prevHash": null,
            "hash": "ignored-by-hash"
        });
        assert_eq!(
            hash_envelope(&envelope),
            "e01afd531202f990a87972bae8d8e489e88e794c234fcbe0368101b729f015b0"
        );
        assert!(is_hash(&hash_envelope(&envelope)));
    }

    /// RFC 4231 test vectors: proves the HMAC construction is the standard one
    /// (behind every keyed anchor), not a look-alike.
    #[test]
    fn hmac_sha256_matches_rfc4231_vectors() {
        assert_eq!(
            hmac_sha256_hex(&[0x0b; 20], b"Hi There"),
            "b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7"
        );
        assert_eq!(
            hmac_sha256_hex(b"Jefe", b"what do ya want for nothing?"),
            "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843"
        );
        // a key longer than the 64-byte block is hashed first (RFC 2104 K0 rule)
        let long_key = vec![0xaa_u8; 131];
        assert_eq!(
            hmac_sha256_hex(&long_key, b"Test Using Larger Than Block-Size Key - Hash Key First"),
            "60e431591ee0b67f0d8a26aacbf5b77f8e0bc6213728c5140546040f0ee37f54"
        );
    }

    /// Unkeyed anchors must stay byte-identical to the legacy record digest.
    #[test]
    fn unkeyed_anchor_digest_equals_the_record_hash() {
        let envelope = json!({
            "id": "id-1",
            "seq": 1,
            "ts": "2026-01-01T00:00:00.000Z",
            "stream": "session:t",
            "type": "session.start",
            "actor": { "kind": "human", "id": "u1" },
            "payload": { "a": 1 },
            "prevHash": null,
        });
        assert_eq!(
            anchor_digest(&envelope_preimage(&envelope), None),
            hash_envelope(&envelope)
        );
        // ...and keyed mode replaces the digest, never the chain hash itself
        let keyed = anchor_digest(&envelope_preimage(&envelope), Some(b"k"));
        assert_ne!(keyed, hash_envelope(&envelope));
        assert_eq!(keyed, hmac_sha256_hex(b"k", canonical_json(&envelope_preimage(&envelope)).as_bytes()));
    }
}
