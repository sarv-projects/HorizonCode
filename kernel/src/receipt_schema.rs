//! Receipt v2 SHA-256 preimages binding effect/postimage/child sidecars.
//! v1 canon::receipt_preimage remains frozen. Version 2 is selected for new
//! sidecar-bearing receipts; legacy rows remain readable but unbound.
use serde_json::{json, Value};

const BINDINGS: &[&str] = &["effectId", "postimageDigest", "postimagePath", "childEffectIds"];
const V1_FIELDS: &[&str] = &[
    "id", "seq", "ts", "action", "tool", "argsDigest", "resultDigest", "prevHash", "leaseId",
];

pub fn issue_v2(input: &Value) -> Result<bool, String> {
    match input.get("schemaVersion") {
        None => {}
        Some(Value::Number(n)) if n.as_u64() == Some(2) => {}
        _ => return Err("HZ_PRECONDITION_FAILED: unsupported receipt schema version".into()),
    }
    Ok(input.get("schemaVersion").is_some() ||
        BINDINGS.iter().any(|key| input.get(*key).is_some()))
}

pub fn check_version(record: &Value) -> Result<bool, String> {
    let Some(version) = record.get("schemaVersion") else {
        return Ok(false);
    };
    if version.as_u64() != Some(2) {
        return Err("HZ_PRECONDITION_FAILED: unsupported receipt schema version".into());
    }
    let keys = record.as_object().ok_or_else(|| "HZ_PRECONDITION_FAILED: receipt not an object".to_string())?;
    for name in keys.keys() {
        if name != "hash" && name != "schemaVersion" && !BINDINGS.contains(&name.as_str())
            && !V1_FIELDS.contains(&name.as_str()) {
            return Err(format!("HZ_PRECONDITION_FAILED: unexpected receipt v2 field {name}"));
        }
    }
    if let Some(effect) = record.get("effectId") {
        if effect.as_str().is_none_or(str::is_empty) {
            return Err("HZ_PRECONDITION_FAILED: receipt v2 effectId invalid".into());
        }
    }
    for key in ["postimageDigest", "postimagePath"] {
        if record.get(key).is_some_and(|v| !v.is_string()) {
            return Err(format!("HZ_PRECONDITION_FAILED: receipt v2 {key} must be a string"));
        }
    }
    if let Some(children) = record.get("childEffectIds") {
        let entries = children.as_array()
            .ok_or_else(|| "HZ_PRECONDITION_FAILED: receipt v2 childEffectIds invalid".to_string())?;
        if entries.len() > 1_000 {
            return Err("HZ_PRECONDITION_FAILED: receipt v2 childEffectIds budget exceeded".into());
        }
        let mut seen = std::collections::HashSet::new();
        for child in entries {
            let name = child.as_str().filter(|s| !s.is_empty())
                .ok_or_else(|| "HZ_PRECONDITION_FAILED: receipt v2 childEffectIds invalid".to_string())?;
            if !seen.insert(name) {
                return Err("HZ_PRECONDITION_FAILED: receipt v2 childEffectIds duplicate".into());
            }
        }
    }
    Ok(true)
}

pub fn preimage(record: &Value) -> Result<Value, String> {
    let v2 = check_version(record)?;
    let mut base = crate::canon::receipt_preimage(record);
    if v2 {
        base["schemaVersion"] = json!(2);
        for key in BINDINGS {
            if let Some(value) = record.get(*key) {
                base[*key] = value.clone();
            }
        }
    }
    Ok(base)
}

pub fn hash(record: &Value) -> Result<String, String> {
    let preimage = preimage(record)?;
    Ok(crate::canon::sha256_hex(&crate::canon::canonical_json(&preimage)))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn v2_sidecar_tampering_changes_the_hash_but_legacy_v1_is_identical() {
        let mut receipt = json!({
            "id":"r1", "seq":1, "ts":"2026-11-14T00:00:00Z",
            "action":"tool.execute", "tool":"write",
            "argsDigest":"a", "resultDigest":"b", "prevHash":null,
            "effectId":"effect-1"
        });
        assert!(issue_v2(&receipt).unwrap());
        let legacy_hash = hash(&receipt).unwrap();
        assert_eq!(legacy_hash, crate::canon::hash_receipt(&receipt));
        receipt["schemaVersion"] = json!(2);
        let v2_hash = hash(&receipt).unwrap();
        receipt["effectId"] = json!("forged");
        assert_ne!(hash(&receipt).unwrap(), v2_hash);
        receipt["childEffectIds"] = json!(["c1", "c2"]);
        let child_hash = hash(&receipt).unwrap();
        receipt["childEffectIds"] = json!(["c2", "c1"]);
        assert_ne!(hash(&receipt).unwrap(), child_hash);
        receipt["childEffectIds"] = json!(["c1", "c1"]);
        assert!(hash(&receipt).is_err());
    }
}
