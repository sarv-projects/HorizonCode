//! Append-only receipt log: `<state-dir>/receipts.jsonl`.
//!
//! Same chaining rules as the event log: `seq` (last+1 from 1), `prevHash`
//! (previous receipt hash, `null` first) and `hash` = sha256 of canonical JSON of
//! every other field. `leaseId` is omitted when the caller did not supply one.

use std::fs;
use std::path::{Path, PathBuf};

use serde_json::{json, Map, Value};
use uuid::Uuid;

use crate::canon::hash_receipt;
use crate::eventlog::{
    anchor_digest, ensure_anchor_matches, read_head, tail_of, verify_chain, AnchorConfig,
    ChainKind, LockFile, VerifyReport,
};
use crate::permm;
use crate::time::now_iso;

pub struct Receipts {
    path: PathBuf,
    anchor: AnchorConfig,
}

impl Receipts {
    pub fn new_with_anchor(state_dir: &Path, anchor: AnchorConfig) -> Self {
        Receipts {
            path: state_dir.join("receipts.jsonl"),
            anchor,
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
            permm::private_dir(parent);
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
        let receipt = Value::Object(receipt);
        let hash = hash_receipt(&receipt);
        let mut receipt = receipt;
        if let Value::Object(map) = &mut receipt {
            map.insert("hash".to_string(), json!(hash));
            // Additive observation sidecars — not in RECEIPT_FIELDS / hash.
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
        verify_chain(
            lines,
            ChainKind::Receipt,
            read_head(&self.path),
            &self.anchor,
            &self.path.display().to_string(),
        )
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
