//! Append-only event log: `<state-dir>/events/<stream-sanitized>.jsonl`.
//!
//! Each line is a full `EventEnvelope` (see contracts.ts). The kernel assigns
//! `seq` (last+1, starting at 1), `prevHash` (last event's hash, `null` for the
//! first event) and `hash` (canonical-JSON sha256 over all other envelope fields).
//!
//! Concurrent appends are serialized with an exclusive lockfile
//! (`<stream>.jsonl.lock`, `create_new`), with stale-lock takeover after 30s so a
//! crashed process cannot wedge the log.

use std::fs::{self, File, OpenOptions};
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::thread::sleep;
use std::time::{Duration, SystemTime};

use serde_json::{json, Map, Value};
use uuid::Uuid;

use crate::canon::{hash_envelope, is_hash};
use crate::time::now_iso;

pub const STREAM_FILE_SUFFIX: &str = ".jsonl";
const LOCK_STALE_AFTER: Duration = Duration::from_secs(30);
const LOCK_RETRY_DELAY: Duration = Duration::from_millis(5);
const LOCK_MAX_WAIT: Duration = Duration::from_secs(5);

#[derive(Debug, Clone)]
pub struct VerifyReport {
    pub ok: bool,
    /// Number of events that verified (before the first break, if any).
    pub count: u64,
    /// 1-based seq/line of the first broken link.
    pub broken_at: Option<u64>,
}

impl VerifyReport {
    pub fn to_json(&self) -> Value {
        let mut m = json!({ "ok": self.ok, "count": self.count });
        if let (Some(broken), Value::Object(map)) = (self.broken_at, &mut m) {
            map.insert("brokenAt".to_string(), json!(broken));
        }
        m
    }
}

pub struct EventLog {
    state_dir: PathBuf,
}

impl EventLog {
    pub fn new(state_dir: &Path) -> Self {
        EventLog {
            state_dir: state_dir.to_path_buf(),
        }
    }

    fn events_dir(&self) -> PathBuf {
        self.state_dir.join("events")
    }

    /// `session:abc` -> `session__abc` (`':'` -> `"__"`). Path separators are
    /// neutralized too and traversal is rejected so a stream name can never
    /// escape the events directory.
    pub fn sanitize(stream: &str) -> Result<String, String> {
        let s = stream.trim();
        if s.is_empty() {
            return Err("stream must be a non-empty string".to_string());
        }
        let sanitized: String = s
            .replace(':', "__")
            .chars()
            .map(|c| match c {
                '/' | '\\' | '\0' => '_',
                c if c.is_control() => '_',
                c => c,
            })
            .collect();
        if sanitized.contains("..") {
            return Err(format!("stream name is not allowed: {}", stream));
        }
        Ok(sanitized)
    }

    pub fn stream_path(&self, stream: &str) -> Result<PathBuf, String> {
        let name = Self::sanitize(stream)?;
        Ok(self.events_dir().join(format!("{}{}", name, STREAM_FILE_SUFFIX)))
    }

    /// Append a caller-provided `EventSeed`; returns the completed envelope.
    pub fn append(&self, stream: &str, seed: &Value) -> Result<Value, String> {
        if stream.trim().is_empty() {
            return Err("stream must be a non-empty string".to_string());
        }
        let seed = seed
            .as_object()
            .ok_or_else(|| "event must be an object".to_string())?;
        if let Some(seed_stream) = seed.get("stream").and_then(|v| v.as_str()) {
            if seed_stream != stream {
                return Err(format!(
                    "event.stream ({}) does not match stream ({})",
                    seed_stream, stream
                ));
            }
        }
        let event_type = seed
            .get("type")
            .and_then(|v| v.as_str())
            .filter(|s| !s.is_empty())
            .ok_or_else(|| "event.type must be a non-empty string".to_string())?
            .to_string();
        let id = seed
            .get("id")
            .and_then(|v| v.as_str())
            .filter(|s| !s.is_empty())
            .map(|s| s.to_string())
            .unwrap_or_else(|| Uuid::new_v4().to_string());
        let ts = seed
            .get("ts")
            .and_then(|v| v.as_str())
            .filter(|s| !s.is_empty())
            .map(|s| s.to_string())
            .unwrap_or_else(now_iso);
        let actor = match seed.get("actor") {
            Some(a) if a.is_object() => a.clone(),
            Some(a) if !a.is_null() => {
                return Err("event.actor must be an object {kind,id}".to_string())
            }
            _ => json!({ "kind": "system", "id": "kernel" }),
        };
        let payload = seed.get("payload").cloned().unwrap_or(Value::Null);

        let path = self.stream_path(stream)?;
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)
                .map_err(|e| format!("cannot create {}: {}", parent.display(), e))?;
        }
        let _lock = LockFile::acquire(&path)?;

        let (last_seq, prev_hash) = tail_of(&path)?;
        let mut envelope = Map::new();
        envelope.insert("id".to_string(), Value::String(id));
        envelope.insert("seq".to_string(), json!(last_seq + 1));
        envelope.insert("ts".to_string(), Value::String(ts));
        envelope.insert("stream".to_string(), Value::String(stream.to_string()));
        envelope.insert("type".to_string(), Value::String(event_type));
        envelope.insert("actor".to_string(), actor);
        envelope.insert("payload".to_string(), payload);
        envelope.insert(
            "prevHash".to_string(),
            match &prev_hash {
                Some(h) => Value::String(h.clone()),
                None => Value::Null,
            },
        );
        let envelope = Value::Object(envelope);
        let hash = hash_envelope(&envelope);
        let mut envelope = envelope;
        if let Value::Object(map) = &mut envelope {
            map.insert("hash".to_string(), Value::String(hash));
        }

        append_line(&path, &envelope)?;
        Ok(envelope)
    }

    /// Read events with `seq >= fromSeq` (default 1), at most `limit` (default all).
    pub fn read(
        &self,
        stream: &str,
        from_seq: Option<u64>,
        limit: Option<usize>,
    ) -> Result<Vec<Value>, String> {
        let path = self.stream_path(stream)?;
        let from_seq = from_seq.unwrap_or(1);
        let mut out = Vec::new();
        for line in read_lines(&path)? {
            let Ok(event) = serde_json::from_str::<Value>(&line) else {
                continue;
            };
            let seq = event.get("seq").and_then(|v| v.as_u64()).unwrap_or(0);
            if seq < from_seq {
                continue;
            }
            // Check the cap before pushing so `limit: 0` really means zero events.
            if let Some(limit) = limit {
                if out.len() >= limit {
                    break;
                }
            }
            out.push(event);
        }
        Ok(out)
    }

    /// Walk the chain, checking seq continuity, prevHash links and recomputed hashes.
    pub fn verify(&self, stream: &str) -> Result<VerifyReport, String> {
        let path = self.stream_path(stream)?;
        verify_chain(read_lines(&path)?, ChainKind::Event)
    }
}

/// Generic chain verification, shared by the event log and the receipt log.
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum ChainKind {
    Event,
    Receipt,
}

pub fn verify_chain(lines: Vec<String>, kind: ChainKind) -> Result<VerifyReport, String> {
    let mut expected_seq: u64 = 1;
    let mut prev_hash: Option<String> = None;
    let mut count: u64 = 0;
    let hash_of = |obj: &Value| match kind {
        ChainKind::Event => crate::canon::hash_envelope(obj),
        ChainKind::Receipt => crate::canon::hash_receipt(obj),
    };

    for line in lines {
        if line.trim().is_empty() {
            continue;
        }
        let record: Value = match serde_json::from_str(&line) {
            Ok(v) => v,
            Err(_) => {
                return Ok(VerifyReport {
                    ok: false,
                    count,
                    broken_at: Some(expected_seq),
                })
            }
        };
        let seq = record.get("seq").and_then(|v| v.as_u64());
        let stored_hash = record.get("hash").and_then(|v| v.as_str());
        if seq != Some(expected_seq) || !stored_hash.map(is_hash).unwrap_or(false) {
            return Ok(VerifyReport {
                ok: false,
                count,
                broken_at: Some(expected_seq),
            });
        }
        let prev_field = record.get("prevHash").cloned().unwrap_or(Value::Null);
        let prev_ok = match (&prev_hash, &prev_field) {
            (None, Value::Null) => true,
            (Some(expected), Value::String(actual)) => expected == actual,
            _ => false,
        };
        if !prev_ok {
            return Ok(VerifyReport {
                ok: false,
                count,
                broken_at: Some(expected_seq),
            });
        }
        let recomputed = hash_of(&record);
        if Some(recomputed.as_str()) != stored_hash {
            return Ok(VerifyReport {
                ok: false,
                count,
                broken_at: Some(expected_seq),
            });
        }
        prev_hash = stored_hash.map(|s| s.to_string());
        count += 1;
        expected_seq += 1;
    }

    Ok(VerifyReport {
        ok: true,
        count,
        broken_at: None,
    })
}

/// (seq, hash) of the last well-formed line, or (0, None) for an empty/absent file.
fn tail_of(path: &Path) -> Result<(u64, Option<String>), String> {
    let mut last_seq = 0u64;
    let mut last_hash = None;
    for line in read_lines(path)? {
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

pub fn read_lines(path: &Path) -> Result<Vec<String>, String> {
    if !path.exists() {
        return Ok(Vec::new());
    }
    let file = File::open(path).map_err(|e| format!("cannot read {}: {}", path.display(), e))?;
    let reader = BufReader::new(file);
    let mut lines = Vec::new();
    for line in reader.lines() {
        match line {
            Ok(l) => lines.push(l),
            Err(e) => return Err(format!("cannot read {}: {}", path.display(), e)),
        }
    }
    Ok(lines)
}

fn append_line(path: &Path, value: &Value) -> Result<(), String> {
    let line = serde_json::to_string(value).map_err(|e| format!("cannot serialize: {}", e))?;
    let mut file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .map_err(|e| format!("cannot open {}: {}", path.display(), e))?;
    file.write_all(line.as_bytes())
        .and_then(|_| file.write_all(b"\n"))
        .and_then(|_| file.flush())
        .map_err(|e| format!("cannot append to {}: {}", path.display(), e))?;
    Ok(())
}

/// Exclusive lockfile holding `<path>.lock`; removed on drop.
pub struct LockFile {
    path: PathBuf,
}

impl LockFile {
    pub fn acquire(target: &Path) -> Result<LockFile, String> {
        let lock_path = PathBuf::from(format!("{}.lock", target.display()));
        let started = SystemTime::now();
        loop {
            match OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&lock_path)
            {
                Ok(mut file) => {
                    let _ = write!(file, "{}", std::process::id());
                    let _ = file.flush();
                    return Ok(LockFile { path: lock_path });
                }
                Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
                    if is_stale(&lock_path) {
                        let _ = fs::remove_file(&lock_path);
                        continue;
                    }
                    let waited = SystemTime::now()
                        .duration_since(started)
                        .unwrap_or_default();
                    if waited >= LOCK_MAX_WAIT {
                        return Err(format!(
                            "timed out waiting for lock {}",
                            lock_path.display()
                        ));
                    }
                    sleep(LOCK_RETRY_DELAY);
                }
                Err(e) => {
                    return Err(format!("cannot create lock {}: {}", lock_path.display(), e))
                }
            }
        }
    }
}

impl Drop for LockFile {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.path);
    }
}

fn is_stale(lock_path: &Path) -> bool {
    match fs::metadata(lock_path).and_then(|m| m.modified()) {
        Ok(modified) => SystemTime::now()
            .duration_since(modified)
            .map(|age| age > LOCK_STALE_AFTER)
            .unwrap_or(false),
        Err(_) => false,
    }
}
