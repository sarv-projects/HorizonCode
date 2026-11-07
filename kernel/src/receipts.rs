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
use crate::eventlog::{read_head, verify_chain, write_head, ChainKind, LockFile, VerifyReport};
use crate::permm;
use crate::time::now_iso;

pub struct Receipts {
    path: PathBuf,
}

impl Receipts {
    pub fn new(state_dir: &Path) -> Self {
        Receipts {
            path: state_dir.join("receipts.jsonl"),
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

        if let Some(parent) = self.path.parent() {
            fs::create_dir_all(parent)
                .map_err(|e| format!("cannot create {}: {}", parent.display(), e))?;
            permm::private_dir(parent);
        }
        let _lock = LockFile::acquire(&self.path)?;
        let (last_seq, prev_hash) = tail_of(&self.path)?;
        crate::eventlog::ensure_anchor_matches(&self.path, last_seq, prev_hash.as_deref())?;

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
        }

        append_line(&self.path, &receipt)?;
        let hash_written = receipt
            .get("hash")
            .and_then(|v| v.as_str())
            .unwrap_or_default()
            .to_string();
        write_head(&self.path, last_seq + 1, &hash_written)?;
        Ok(receipt)
    }

    pub fn verify(&self) -> Result<VerifyReport, String> {
        let lines = crate::eventlog::read_lines(&self.path)?;
        verify_chain(lines, ChainKind::Receipt, read_head(&self.path))
    }
}

fn tail_of(path: &Path) -> Result<(u64, Option<String>), String> {
    let mut last_seq = 0u64;
    let mut last_hash = None;
    for line in crate::eventlog::read_lines(path)? {
        let Ok(value) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        if let Some(seq) = value.get("seq").and_then(|v| v.as_u64()) {
            if seq >= last_seq {
                last_seq = seq;
                last_hash = value
                    .get("hash")
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string());
            }
        }
    }
    Ok((last_seq, last_hash))
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
    Ok(())
}
