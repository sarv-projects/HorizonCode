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
    let digest = hasher.finalize();
    let mut out = String::with_capacity(digest.len() * 2);
    const HEX: &[u8; 16] = b"0123456789abcdef";
    for byte in digest.iter() {
        out.push(HEX[(byte >> 4) as usize] as char);
        out.push(HEX[(byte & 0x0f) as usize] as char);
    }
    out
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
}
