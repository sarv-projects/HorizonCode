//! Append-only event log: `<state-dir>/events/<stream-sanitized>.jsonl`.
//!
//! Each line is a full `EventEnvelope` (see contracts.ts). The kernel assigns
//! `seq` (last+1, starting at 1), `prevHash` (last event's hash, `null` for the
//! first event) and `hash` (canonical-JSON sha256 over all other envelope fields).
//!
//! Concurrent appends are serialized with an exclusive lockfile
//! (`<stream>.jsonl.lock`, `create_new`), with stale-lock takeover after 30s so a
//! crashed process cannot wedge the log.
//!
//! Every append also refreshes `<stream>.jsonl.head`: the seq and digest of the
//! last record, written atomically (temp file + rename). `verify` compares the
//! chain against that anchor, so tail truncation — invisible to a bare chain
//! walk — is detected. The digest is sha256 of the record's canonical preimage;
//! when a key is configured (`HZ_ANCHOR_KEY` hex), it is instead
//! HMAC-SHA256(key, preimage) and a legacy (unkeyed) anchor fails closed unless
//! `HZ_ACCEPT_LEGACY_ANCHORS=1` explicitly accepts it. The residual (an actor who
//! can rewrite the log can also delete or rewrite the anchor) is recorded in
//! docs/28 §4, narrowed by the keyed mode.

use std::fs::{self, File, OpenOptions};
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::thread::sleep;
use std::time::{Duration, SystemTime};

use serde_json::{json, Map, Value};
use uuid::Uuid;

use crate::canon::{hash_envelope, is_hash};
use crate::permm;
use crate::time::now_iso;

pub const STREAM_FILE_SUFFIX: &str = ".jsonl";
const LOCK_STALE_AFTER: Duration = Duration::from_secs(30);
const LOCK_RETRY_DELAY: Duration = Duration::from_millis(5);
const LOCK_MAX_WAIT: Duration = Duration::from_secs(5);

/* -------------------------------- anchors -------------------------------- */

/// Anchor mode for one state dir. `Default` = unkeyed: every byte on disk is
/// exactly what it was before keyed anchors existed.
#[derive(Debug, Clone, Default)]
pub struct AnchorConfig {
    /// HMAC-SHA256 key for `.head` anchors; `None` = plain sha256 (legacy).
    pub key: Option<Vec<u8>>,
    /// Explicit opt-in to accept legacy (unkeyed or absent) anchors while keyed.
    pub accept_legacy: bool,
}

impl AnchorConfig {
    /// A keyed config that still refuses legacy anchors (the shipped default when
    /// HZ_ANCHOR_KEY is set).
    pub fn keyed(key: Vec<u8>) -> AnchorConfig {
        AnchorConfig {
            key: Some(key),
            accept_legacy: false,
        }
    }

    pub fn key(&self) -> Option<&[u8]> {
        self.key.as_deref()
    }

    /// HZ_ANCHOR_KEY (hex, at least 32 chars) and HZ_ACCEPT_LEGACY_ANCHORS
    /// (truthy = 1/true/anything but 0/false/empty). A malformed key is an
    /// error, never a silent fall back to unkeyed mode.
    pub fn from_env() -> Result<AnchorConfig, String> {
        let key = match std::env::var("HZ_ANCHOR_KEY") {
            Ok(raw) if !raw.trim().is_empty() => Some(parse_hex_key(raw.trim())?),
            _ => None,
        };
        Ok(AnchorConfig {
            key,
            accept_legacy: truthy_env("HZ_ACCEPT_LEGACY_ANCHORS"),
        })
    }
}

pub fn parse_hex_key(hex: &str) -> Result<Vec<u8>, String> {
    if hex.len() % 2 != 0 || hex.len() < 32 || !hex.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err(
            "HZ_ANCHOR_KEY must be an even-length hex string of at least 32 characters".to_string(),
        );
    }
    let mut out = Vec::with_capacity(hex.len() / 2);
    for i in (0..hex.len()).step_by(2) {
        let byte = u8::from_str_radix(&hex[i..i + 2], 16)
            .map_err(|_| "HZ_ANCHOR_KEY must be an even-length hex string".to_string())?;
        out.push(byte);
    }
    Ok(out)
}

pub fn truthy_env(name: &str) -> bool {
    match std::env::var(name) {
        Ok(value) => {
            let trimmed = value.trim();
            !trimmed.is_empty() && trimmed != "0" && !trimmed.eq_ignore_ascii_case("false")
        }
        Err(_) => false,
    }
}

/// The canonical object a record's chain hash (and its anchor digest) covers.
pub fn record_preimage(kind: ChainKind, record: &Value) -> Value {
    match kind {
        ChainKind::Event => crate::canon::envelope_preimage(record),
        ChainKind::Receipt => crate::canon::receipt_preimage(record),
    }
}

/// The digest an anchor stores for one record: sha256 of its canonical preimage
/// when unkeyed (equal to the record's own `hash`), HMAC-SHA256 when keyed.
pub fn anchor_digest(kind: ChainKind, record: &Value, key: Option<&[u8]>) -> String {
    crate::canon::anchor_digest(&record_preimage(kind, record), key)
}

/// The typed refusal for a legacy anchor while a key is configured. The
/// `HZ_PRECONDITION_FAILED` prefix is the registered wire vocabulary
/// (docs/07 §4.10.2); the phrase `legacy (unkeyed) anchor` is the stable marker.
fn legacy_anchor_refusal(detail: &str) -> String {
    format!(
        "HZ_PRECONDITION_FAILED: legacy (unkeyed) anchor: {} — HZ_ANCHOR_KEY is configured; set HZ_ACCEPT_LEGACY_ANCHORS=1 to accept it",
        detail
    )
}

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
    anchor: AnchorConfig,
}

impl EventLog {
    pub fn new_with_anchor(state_dir: &Path, anchor: AnchorConfig) -> Self {
        EventLog {
            state_dir: state_dir.to_path_buf(),
            anchor,
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
            permm::private_dir(parent);
        }
        let _lock = LockFile::acquire(&path)?;

        let (last_seq, prev_hash, tail_record) = tail_of(&path)?;
        ensure_anchor_matches(&path, ChainKind::Event, tail_record.as_ref(), &self.anchor)?;
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
        let anchor_hash = anchor_digest(ChainKind::Event, &envelope, self.anchor.key());
        write_head(&path, last_seq + 1, &anchor_hash)?;
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
        verify_chain(
            read_lines(&path)?,
            ChainKind::Event,
            read_head(&path),
            &self.anchor,
            &path.display().to_string(),
        )
    }
}

/// Generic chain verification, shared by the event log and the receipt log.
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum ChainKind {
    Event,
    Receipt,
}

/// The anchor verdict for one completed, internally consistent chain walk.
enum AnchorCheck {
    /// Anchor matches (or no key shines light on the case: legacy unkeyed mode).
    Ok,
    /// Chain and anchor disagree; the seq to report as broken.
    Breach(u64),
    /// A legacy (unkeyed or absent) anchor while a key is configured.
    Legacy(String),
}

pub fn verify_chain(
    lines: Vec<String>,
    kind: ChainKind,
    head: HeadState,
    anchor: &AnchorConfig,
    label: &str,
) -> Result<VerifyReport, String> {
    let mut expected_seq: u64 = 1;
    let mut prev_hash: Option<String> = None;
    let mut count: u64 = 0;
    let mut last_record: Option<Value> = None;
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
        last_record = Some(record);
    }

    // The chain is internally consistent; now compare it against its anchor.
    match anchor_check(&head, count, last_record.as_ref(), kind, anchor, label) {
        AnchorCheck::Ok => Ok(VerifyReport {
            ok: true,
            count,
            broken_at: None,
        }),
        AnchorCheck::Breach(broken_at) => Ok(VerifyReport {
            ok: false,
            count,
            broken_at: Some(broken_at),
        }),
        AnchorCheck::Legacy(message) => {
            if anchor.accept_legacy {
                Ok(VerifyReport {
                    ok: true,
                    count,
                    broken_at: None,
                })
            } else {
                Err(message)
            }
        }
    }
}

/// Integrity anchor state for a chain file.
pub enum HeadState {
    /// No `.head` file: a chain written before anchors existed.
    Absent,
    /// The `.head` file exists but cannot be read or parsed.
    Invalid,
    /// The anchor: seq and hash of the last record.
    Present(u64, String),
}

/// Where a chain file's anchor lives: `<file>.head`.
pub fn head_path(path: &Path) -> PathBuf {
    PathBuf::from(format!("{}.head", path.display()))
}

/// Persist the anchor after each append (write + rename, so it is never torn).
pub fn write_head(path: &Path, seq: u64, hash: &str) -> Result<(), String> {
    let head = head_path(path);
    let tmp = PathBuf::from(format!("{}.tmp", head.display()));
    let body = serde_json::to_string(&json!({ "hash": hash, "seq": seq }))
        .map_err(|e| format!("cannot serialize anchor: {}", e))?;
    permm::write_new(&tmp, format!("{}\n", body).as_bytes())
        .map_err(|e| format!("cannot write {}: {}", tmp.display(), e))?;
    fs::rename(&tmp, &head).map_err(|e| format!("cannot move {}: {}", head.display(), e))
}

/// Read a chain file's anchor.
pub fn read_head(path: &Path) -> HeadState {
    let head = head_path(path);
    if !head.exists() {
        return HeadState::Absent;
    }
    let Ok(text) = fs::read_to_string(&head) else {
        return HeadState::Invalid;
    };
    let Ok(value) = serde_json::from_str::<Value>(text.trim()) else {
        return HeadState::Invalid;
    };
    match (
        value.get("seq").and_then(|v| v.as_u64()),
        value.get("hash").and_then(|v| v.as_str()),
    ) {
        (Some(seq), Some(hash)) => HeadState::Present(seq, hash.to_string()),
        _ => HeadState::Invalid,
    }
}

/// Refuse to extend a chain whose tail disagrees with its anchor: appending
/// onto a truncated or rewritten tail would silently bless the edit.
///
/// Keyed mode compares the anchor against HMAC-SHA256(key, tail preimage); a
/// legacy anchor over an intact tail is refused too (a rewriter could simply
/// keep the old unkeyed anchor) unless `accept_legacy` was set explicitly.
pub fn ensure_anchor_matches(
    path: &Path,
    kind: ChainKind,
    tail: Option<&Value>,
    anchor: &AnchorConfig,
) -> Result<(), String> {
    let tail_seq = tail
        .and_then(|record| record.get("seq").and_then(|v| v.as_u64()))
        .unwrap_or(0);
    let tail_hash = tail.and_then(|record| record.get("hash").and_then(|v| v.as_str()));
    let key = anchor.key();
    match read_head(path) {
        HeadState::Absent => {
            if key.is_some() && tail_seq > 0 {
                return Err(legacy_anchor_refusal(&format!(
                    "chain {} has {} record(s) but no anchor",
                    path.display(),
                    tail_seq
                )));
            }
            Ok(())
        }
        HeadState::Invalid => Err(format!(
            "chain anchor for {} is unreadable; refusing to append",
            path.display()
        )),
        HeadState::Present(seq, hash) => {
            if seq == tail_seq {
                if tail_seq == 0 {
                    return Ok(());
                }
                if let (Some(key), Some(record)) = (key, tail) {
                    if anchor_digest(kind, record, Some(key)) == hash {
                        return Ok(());
                    }
                    if tail_hash == Some(hash.as_str()) {
                        // An unkeyed anchor over an intact tail: legacy shape.
                        if anchor.accept_legacy {
                            return Ok(());
                        }
                        return Err(legacy_anchor_refusal(&format!(
                            "chain {} is anchored with an unkeyed anchor",
                            path.display()
                        )));
                    }
                } else if let (None, Some(tail_hash)) = (key, tail_hash) {
                    if tail_hash == hash {
                        return Ok(());
                    }
                }
            }
            Err(format!(
                "chain tail (seq {}, hash {:?}) disagrees with its anchor (seq {}, hash {}); refusing to append",
                tail_seq, tail_hash, seq, hash
            ))
        }
    }
}

/// Compare a completed, internally consistent walk of `count` records against
/// its anchor. Returns the anchor verdict (Ok / Breach(seq) / Legacy(message)).
fn anchor_check(
    head: &HeadState,
    count: u64,
    last: Option<&Value>,
    kind: ChainKind,
    anchor: &AnchorConfig,
    label: &str,
) -> AnchorCheck {
    match head {
        HeadState::Absent => {
            // Unkeyed: an absent anchor is a legacy chain. Keyed: a non-empty
            // chain without its anchor has lost exactly the material the key
            // protects, so it fails closed.
            if anchor.key().is_some() && count > 0 {
                AnchorCheck::Legacy(legacy_anchor_refusal(&format!(
                    "chain {} has {} record(s) but no anchor",
                    label, count
                )))
            } else {
                AnchorCheck::Ok
            }
        }
        HeadState::Invalid => AnchorCheck::Breach(count + 1),
        HeadState::Present(seq, hash) => {
            if *seq > count {
                return AnchorCheck::Breach(count + 1); // records were removed from the tail
            }
            if *seq < count {
                return AnchorCheck::Breach(seq + 1); // records exist the anchor never saw
            }
            if count == 0 {
                return AnchorCheck::Ok;
            }
            let Some(record) = last else {
                return AnchorCheck::Breach(count);
            };
            match anchor.key() {
                None => {
                    if record.get("hash").and_then(|v| v.as_str()) != Some(hash.as_str()) {
                        AnchorCheck::Breach(count) // the tail record was rewritten
                    } else {
                        AnchorCheck::Ok
                    }
                }
                Some(key) => {
                    if anchor_digest(kind, record, Some(key)) == *hash {
                        return AnchorCheck::Ok;
                    }
                    let stored = record.get("hash").and_then(|v| v.as_str());
                    if stored == Some(hash.as_str()) {
                        AnchorCheck::Legacy(legacy_anchor_refusal(&format!(
                            "chain {} is anchored with an unkeyed anchor",
                            label
                        )))
                    } else {
                        AnchorCheck::Breach(count)
                    }
                }
            }
        }
    }
}

/// (seq, hash, last well-formed record) of the file, or (0, None, None) for an
/// empty/absent file. The record itself is needed to recompute a keyed anchor.
pub fn tail_of(path: &Path) -> Result<(u64, Option<String>, Option<Value>), String> {
    let mut last_seq = 0u64;
    let mut last_hash = None;
    let mut last_record = None;
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
                last_record = Some(value);
            }
        }
    }
    Ok((last_seq, last_hash, last_record))
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
    let mut file = permm::append_options()
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
            match {
                let mut options = OpenOptions::new();
                options.write(true).create_new(true);
                #[cfg(unix)]
                {
                    use std::os::unix::fs::OpenOptionsExt;
                    options.mode(0o600);
                }
                options.open(&lock_path)
            } {
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
