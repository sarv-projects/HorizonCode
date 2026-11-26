//! Append-only receipt log: `<state-dir>/receipts.jsonl`.
//!
//! Same chaining rules as the event log: `seq` (last+1 from 1), `prevHash`
//! (previous receipt hash, `null` first) and `hash` = sha256 of canonical JSON of
//! every other field. `leaseId` is omitted when the caller did not supply one.

use std::fs;
use std::path::{Path, PathBuf};

use serde_json::{json, Map, Value};
use uuid::Uuid;

use crate::eventlog::{
    anchor_digest, ensure_anchor_matches, read_head, tail_of, verify_chain, AnchorConfig,
    ChainKind, LockFile, VerifyReport,
};
use crate::permm;
use crate::receipt_schema;
use crate::time::now_iso;

pub struct Receipts {
    path: PathBuf,
    anchor: AnchorConfig,
    /// Kernel-held issuer key; stamps are not forgeable from ambient Bun alone.
    issuer_key: Option<Vec<u8>>,
}

impl Receipts {
    pub fn new_with_anchor(
        state_dir: &Path,
        anchor: AnchorConfig,
        issuer_key: Option<Vec<u8>>,
    ) -> Self {
        Receipts {
            path: state_dir.join("receipts.jsonl"),
            anchor,
            issuer_key,
        }
    }

    /// Issue a receipt for a completed action; returns the chained receipt.
    pub fn issue(&self, input: &Value) -> Result<Value, String> {
        let input = input
            .as_object()
            .ok_or_else(|| "receipt params must be an object".to_string())?;
        let required = |key: &str| -> Result<String, String> {
            input
                .get(key)
                .and_then(|v| v.as_str())
                .filter(|s| !s.is_empty())
                .map(|s| s.to_string())
                .ok_or_else(|| format!("receipt.{} must be a non-empty string", key))
        };
        let action = required("action")?;
        let tool = required("tool")?;
        let args_digest = required("argsDigest")?;
        let result_digest = required("resultDigest")?;
        let lease_id = match input.get("leaseId") {
            Some(v) if !v.is_null() => Some(
                v.as_str()
                    .map(|s| s.to_string())
                    .ok_or_else(|| "receipt.leaseId must be a string".to_string())?,
            ),
            _ => None,
        };
        let postimage_digest = match input.get("postimageDigest") {
            Some(v) if !v.is_null() => Some(
                v.as_str()
                    .map(|s| s.to_string())
                    .ok_or_else(|| "receipt.postimageDigest must be a string".to_string())?,
            ),
            _ => None,
        };
        let postimage_path = match input.get("postimagePath") {
            Some(v) if !v.is_null() => Some(
                v.as_str()
                    .map(|s| s.to_string())
                    .ok_or_else(|| "receipt.postimagePath must be a string".to_string())?,
            ),
            _ => None,
        };
        let v2 = receipt_schema::issue_v2(&Value::Object(input.clone()))?;
        let effect_id = match input.get("effectId") {
            Some(v) if !v.is_null() => Some(
                v.as_str()
                    .map(|s| s.to_string())
                    .ok_or_else(|| "receipt.effectId must be a string".to_string())?,
            ),
            _ => None,
        };

        if let Some(parent) = self.path.parent() {
            fs::create_dir_all(parent)
                .map_err(|e| format!("cannot create {}: {}", parent.display(), e))?;
            permm::private_dir(parent)
                .map_err(|e| format!("cannot secure {}: {}", parent.display(), e))?;
        }
        let _lock = LockFile::acquire(&self.path)?;
        let (last_seq, prev_hash, tail_record) = tail_of(&self.path)?;
        ensure_anchor_matches(
            &self.path,
            ChainKind::Receipt,
            tail_record.as_ref(),
            &self.anchor,
        )?;

        let mut receipt = Map::new();
        receipt.insert("id".to_string(), json!(Uuid::new_v4().to_string()));
        receipt.insert("seq".to_string(), json!(last_seq + 1));
        receipt.insert("ts".to_string(), json!(now_iso()));
        receipt.insert("action".to_string(), json!(action));
        receipt.insert("tool".to_string(), json!(tool));
        receipt.insert("argsDigest".to_string(), json!(args_digest));
        receipt.insert("resultDigest".to_string(), json!(result_digest));
        if let Some(lease_id) = &lease_id {
            receipt.insert("leaseId".to_string(), json!(lease_id));
        }
        receipt.insert(
            "prevHash".to_string(),
            match &prev_hash {
                Some(h) => json!(h),
                None => Value::Null,
            },
        );
        // v2 binds every declared effect/postimage/child sidecar INTO the
        // receipt hash. Legacy v1 rows retain byte-identical hashes.
        if v2 {
            receipt.insert("schemaVersion".to_string(), json!(2));
            if let Some(d) = &postimage_digest {
                receipt.insert("postimageDigest".to_string(), json!(d));
            }
            if let Some(p) = &postimage_path {
                receipt.insert("postimagePath".to_string(), json!(p));
            }
            if let Some(e) = &effect_id {
                receipt.insert("effectId".to_string(), json!(e));
            }
            if let Some(children) = input.get("childEffectIds") {
                receipt.insert("childEffectIds".to_string(), children.clone());
            }
            if let Some(parent) = input.get("parentReceiptId") {
                if !parent.is_null() {
                    receipt.insert("parentReceiptId".to_string(), parent.clone());
                }
            }
        }
        let receipt = Value::Object(receipt);
        let hash = receipt_schema::hash(&receipt)?;
        let mut receipt = receipt;
        if let Value::Object(map) = &mut receipt {
            map.insert("hash".to_string(), json!(hash));
            if let Some(key) = &self.issuer_key {
                let stamp = crate::receipt_issuer::stamp_hex(key, &hash);
                map.insert("issuerStamp".to_string(), json!(stamp));
            }
            // Sidecars are historical v1 additions; v2 already hashes them.
            if let Some(d) = &postimage_digest {
                map.insert("postimageDigest".to_string(), json!(d));
            }
            if let Some(p) = &postimage_path {
                map.insert("postimagePath".to_string(), json!(p));
            }
            if let Some(e) = &effect_id {
                map.insert("effectId".to_string(), json!(e));
            }
        }

        append_line(&self.path, &receipt)?;
        let anchor_hash = anchor_digest(ChainKind::Receipt, &receipt, self.anchor.key());
        crate::eventlog::write_head(&self.path, last_seq + 1, &anchor_hash)?;
        crate::eventlog::note_appended(&self.path, &receipt);
        Ok(receipt)
    }

    pub fn verify(&self) -> Result<VerifyReport, String> {
        let lines = crate::eventlog::read_lines(&self.path)?;
        let report = verify_chain(
            lines.clone(),
            ChainKind::Receipt,
            read_head(&self.path),
            &self.anchor,
            &self.path.display().to_string(),
        )?;
        if !report.ok {
            return Ok(report);
        }
        if let Some(key) = &self.issuer_key {
            if let Err(seq) = verify_issuer_stamps(&lines, key) {
                return Ok(VerifyReport {
                    ok: false,
                    count: report.count,
                    broken_at: Some(seq),
                });
            }
        }
        // R172 strict mode (TS `HZ_R172_REQUIRE_KEYED` mirror): a v2 receipt
        // chain must be independently keyed by the kernel issuer key. A chain
        // with no key available, or any unkeyed v2 row, fails closed.
        if std::env::var("HZ_R172_REQUIRE_KEYED").ok().as_deref() == Some("1") {
            let v2_seq = lines.iter().enumerate().find_map(|(index, line)| {
                serde_json::from_str::<Value>(line)
                    .ok()
                    .filter(|v| v.get("schemaVersion").and_then(Value::as_u64) == Some(2))
                    .map(|_| (index + 1) as u64)
            });
            if let Some(v2_seq) = v2_seq {
                match &self.issuer_key {
                    None => {
                        return Ok(VerifyReport {
                            ok: false,
                            count: report.count,
                            broken_at: Some(v2_seq),
                        });
                    }
                    Some(key) => {
                        if let Err(seq) = verify_strict_v2_issuer_stamps(&lines, key) {
                            return Ok(VerifyReport {
                                ok: false,
                                count: report.count,
                                broken_at: Some(seq),
                            });
                        }
                    }
                }
            }
        }
        Ok(report)
    }

    /// Obtain an internally consistent receipt snapshot for the kernel OwnerLog.
    /// Hold the SAME cross-process receipt lock as issue() while checking the
    /// hash chain and parsing, so a concurrent appender cannot create a false
    /// missing receipt between a log read and a head-anchor update. OwnerLog
    /// then validates its settlement-to-receipt links independently.
    pub fn read_verified(&self) -> Result<Vec<Value>, String> {
        let _lock = LockFile::acquire(&self.path)?;
        let lines = crate::eventlog::read_lines(&self.path)?;
        let verified = verify_chain(
            lines.clone(),
            ChainKind::Receipt,
            read_head(&self.path),
            &self.anchor,
            &self.path.display().to_string(),
        )?;
        if !verified.ok {
            return Err(format!(
                "HZ_PRECONDITION_FAILED: owner receipt linkage: receipt chain broken at {:?}",
                verified.broken_at,
            ));
        }
        lines
            .iter()
            .map(|line| {
                serde_json::from_str(line).map_err(|error| {
                    format!(
                        "HZ_PRECONDITION_FAILED: owner receipt linkage: malformed record: {error}"
                    )
                })
            })
            .collect()
    }
}

/// Strict R172: every v2 receipt must carry a valid kernel issuer stamp.
fn verify_strict_v2_issuer_stamps(lines: &[String], key: &[u8]) -> Result<(), u64> {
    for (index, line) in lines.iter().enumerate() {
        let Ok(value) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        if value.get("schemaVersion").and_then(Value::as_u64) != Some(2) {
            continue;
        }
        let stamp = value["issuerStamp"].as_str().unwrap_or("");
        let hash = value["hash"].as_str().unwrap_or("");
        if !crate::receipt_issuer::verify_hex(key, hash, stamp) {
            return Err((index + 1) as u64);
        }
    }
    Ok(())
}

/// When an issuer key is configured, nested-link receipts MUST carry a valid stamp.
fn verify_issuer_stamps(lines: &[String], key: &[u8]) -> Result<(), u64> {
    let mut seq: u64 = 0;
    for line in lines {
        if line.trim().is_empty() {
            continue;
        }
        seq += 1;
        let record: Value = serde_json::from_str(line).map_err(|_| seq)?;
        let hash = record.get("hash").and_then(Value::as_str).ok_or(seq)?;
        let parent = record.get("parentReceiptId").and_then(Value::as_str);
        let child_link = parent.is_some_and(|p| !p.is_empty());
        if !child_link {
            continue;
        }
        let stamp = record
            .get("issuerStamp")
            .and_then(Value::as_str)
            .ok_or(seq)?;
        if !crate::receipt_issuer::verify_hex(key, hash, stamp) {
            return Err(seq);
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::env::temp_dir;

    #[test]
    fn strict_keyed_verify_refuses_unkeyed_v2_chain() {
        let dir = temp_dir().join(format!("hz-rcp-strict-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let receipts = Receipts::new_with_anchor(&dir, AnchorConfig::default(), None);
        receipts
            .issue(&json!({
                "action": "tool.execute",
                "tool": "write",
                "argsDigest": "a",
                "resultDigest": "b",
                "schemaVersion": 2,
                "effectId": "fx-1"
            }))
            .unwrap();
        assert_eq!(receipts.verify().unwrap().ok, true);
        std::env::set_var("HZ_R172_REQUIRE_KEYED", "1");
        let strict = receipts.verify().unwrap();
        std::env::remove_var("HZ_R172_REQUIRE_KEYED");
        let _ = fs::remove_dir_all(&dir);
        assert_eq!(strict.ok, false, "{strict:?}");
        assert_eq!(strict.broken_at, Some(1));
    }

    #[test]
    fn nested_parent_receipt_gets_kernel_issuer_stamp() {
        let dir = temp_dir().join(format!("hz-rcp-issuer-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let key = vec![0x11u8; 32];
        let receipts = Receipts::new_with_anchor(&dir, AnchorConfig::default(), Some(key.clone()));
        let issued = receipts
            .issue(&json!({
                "action": "tool.execute",
                "tool": "agent",
                "argsDigest": "a",
                "resultDigest": "b",
                "schemaVersion": 2,
                "effectId": "child-fx",
                "parentReceiptId": "rcp_parent",
            }))
            .unwrap();
        let hash = issued["hash"].as_str().unwrap();
        let stamp = issued["issuerStamp"].as_str().expect("issuerStamp");
        assert!(crate::receipt_issuer::verify_hex(&key, hash, stamp));
        assert!(receipts.verify().unwrap().ok);
        let _ = fs::remove_dir_all(&dir);
    }
}

fn append_line(path: &Path, value: &Value) -> Result<(), String> {
    let line = serde_json::to_string(value).map_err(|e| format!("cannot serialize: {}", e))?;
    use std::io::Write;
    let mut file = permm::append_options()
        .open(path)
        .map_err(|e| format!("cannot open {}: {}", path.display(), e))?;
    file.write_all(line.as_bytes())
        .and_then(|_| file.write_all(b"\n"))
        .and_then(|_| file.flush())
        .map_err(|e| format!("cannot append to {}: {}", path.display(), e))?;
    crate::jsonl_append::sync_jsonl_append(path, &file)
        .map_err(|e| format!("cannot fsync {}: {}", path.display(), e))?;
    Ok(())
}
