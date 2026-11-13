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

use std::collections::HashMap;
use std::fs::{self, File, OpenOptions};
use std::io::{BufRead, BufReader, Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
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
        note_appended(&path, &envelope);
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
///
/// A per-process cache keeps appends linear: appending to a chain used to read
/// and parse every record on every append (measured 1.25 ms at 200 records →
/// 12.3 ms at 2,200). The cache is keyed by path and stores the file state
/// (len, mtime) it describes, the offset just past the last complete line, and
/// the tail record. On a (len, mtime) match the cached tail is NOT trusted
/// blindly: an in-place rewrite that preserves byte length and lands within the
/// same mtime tick leaves (len, mtime) unchanged, so the cached last-record
/// region is cheaply re-read from disk and its `seq`/`hash` confirmed to still
/// match the cached entry before the tail is served. If that re-read fails,
/// does not parse, or disagrees (the same-length/same-mtime-tick forgery), the
/// entry is dropped and the whole file is rescanned so the real (tampered) tail
/// is seen and the append is refused by the anchor check. When the file grew,
/// only the delta from the cached offset is parsed and must chain
/// (first new record's `prevHash` equals the cached hash); on shrink, rewrite,
/// an unchainable delta or any read error the whole file is rescanned exactly
/// as before. `note_appended` refreshes the entry after this process appends.
/// The append lockfile still serializes writers, so the cache only ever skips
/// work this process can prove is redundant.
pub fn tail_of(path: &Path) -> Result<(u64, Option<String>, Option<Value>), String> {
    let meta = match fs::metadata(path) {
        Ok(meta) => Some(meta),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
        // A chain that exists but cannot be stat'ed is unreadable material:
        // refuse rather than pretending it is empty (fail closed).
        Err(e) => return Err(format!("cannot read {}: {}", path.display(), e)),
    };
    let (len, mtime) = match &meta {
        Some(meta) => (meta.len(), meta.modified().ok()),
        None => (0, None),
    };

    if let Some(entry) = cache_get(path) {
        // (len, mtime) match: likely unchanged, but an in-place rewrite that
        // preserves byte length within the same mtime tick leaves both equal.
        // Re-read only the cached last-record region and confirm it still
        // matches before trusting the cached tail; otherwise drop and rescan.
        if entry.len == len && entry.mtime == mtime {
            if cached_tail_still_on_disk(path, &entry) {
                return Ok((entry.seq, entry.hash.clone(), entry.record.clone()));
            }
            cache_drop(path);
        }
        // The file grew: read only the new bytes; the delta must chain.
        if meta.is_some() && entry.len < len {
            if let Some(entry) = extend_tail_from_delta(path, &entry, len, mtime) {
                cache_put(path, entry.clone());
                return Ok((entry.seq, entry.hash, entry.record));
            }
        }
    }

    // Never seen, shrank, rewritten, unchainable or unreadable: full rescan.
    let entry = full_tail_scan(path, len, mtime, meta.is_some())?;
    cache_put(path, entry.clone());
    Ok((entry.seq, entry.hash, entry.record))
}

/// One chain file's tail as of `len`/`mtime`; `line_end` is the offset just
/// past the last complete (`\n`-terminated) line — where a delta starts.
#[derive(Clone)]
struct TailCacheEntry {
    len: u64,
    mtime: Option<SystemTime>,
    line_end: u64,
    seq: u64,
    hash: Option<String>,
    record: Option<Value>,
}

fn tail_cache() -> &'static Mutex<HashMap<PathBuf, TailCacheEntry>> {
    static CACHE: OnceLock<Mutex<HashMap<PathBuf, TailCacheEntry>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

fn cache_get(path: &Path) -> Option<TailCacheEntry> {
    tail_cache().lock().ok()?.get(path).cloned()
}

fn cache_put(path: &Path, entry: TailCacheEntry) {
    if let Ok(mut cache) = tail_cache().lock() {
        cache.insert(path.to_path_buf(), entry);
    }
}

fn cache_drop(path: &Path) {
    if let Ok(mut cache) = tail_cache().lock() {
        cache.remove(path);
    }
}

/// Remember the record this process just appended, so the next append can skip
/// the file read entirely. If the file did not end at a line boundary before
/// the append (a partial line from a crashed writer), the new record is glued
/// to it and is not a complete line: drop the cache and let the next append
/// rescan instead of inventing a tail.
pub fn note_appended(path: &Path, record: &Value) {
    let Ok(meta) = fs::metadata(path) else {
        cache_drop(path);
        return;
    };
    let ended_at_line_boundary = cache_get(path).map(|entry| entry.len == entry.line_end).unwrap_or(false);
    if !ended_at_line_boundary {
        cache_drop(path);
        return;
    }
    cache_put(
        path,
        TailCacheEntry {
            len: meta.len(),
            mtime: meta.modified().ok(),
            line_end: meta.len(),
            seq: record.get("seq").and_then(|v| v.as_u64()).unwrap_or(0),
            hash: record
                .get("hash")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string()),
            record: Some(record.clone()),
        },
    );
}

/// Parse the whole file once; mirrors the historical `tail_of` walk exactly.
fn full_tail_scan(
    path: &Path,
    len: u64,
    mtime: Option<SystemTime>,
    exists: bool,
) -> Result<TailCacheEntry, String> {
    if !exists {
        return Ok(TailCacheEntry {
            len: 0,
            mtime: None,
            line_end: 0,
            seq: 0,
            hash: None,
            record: None,
        });
    }
    let bytes = fs::read(path).map_err(|e| format!("cannot read {}: {}", path.display(), e))?;
    let text =
        String::from_utf8(bytes).map_err(|e| format!("cannot read {}: {}", path.display(), e))?;
    let (seq, hash, record) = tail_from_text(&text);
    let line_end = match text.rfind('\n') {
        Some(index) => index as u64 + 1,
        None => 0,
    };
    Ok(TailCacheEntry {
        len,
        mtime,
        line_end,
        seq,
        hash,
        record,
    })
}

/// The last well-formed record of a full chain text: exact port of the old
/// per-append walk (`seq >= last_seq` means a later same-seq record wins).
fn tail_from_text(text: &str) -> (u64, Option<String>, Option<Value>) {
    let mut last_seq = 0u64;
    let mut last_hash = None;
    let mut last_record = None;
    for line in text.split('\n') {
        let Ok(value) = serde_json::from_str::<Value>(line) else {
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
    (last_seq, last_hash, last_record)
}

/// Extend a cached tail by reading only `[entry.line_end, len)`. Returns `None`
/// when the delta cannot be trusted (open/read error, non-UTF-8, an unparseable
/// first line, or a first record that does not chain onto the cached hash), in
/// which case the caller falls back to a full rescan.
fn extend_tail_from_delta(
    path: &Path,
    entry: &TailCacheEntry,
    len: u64,
    mtime: Option<SystemTime>,
) -> Option<TailCacheEntry> {
    if entry.line_end > len {
        return None;
    }
    let mut file = File::open(path).ok()?;
    file.seek(SeekFrom::Start(entry.line_end)).ok()?;
    let mut buf = vec![0u8; (len - entry.line_end) as usize];
    file.read_exact(&mut buf).ok()?;
    let text = String::from_utf8(buf).ok()?;

    let mut seq = entry.seq;
    let mut hash = entry.hash.clone();
    let mut record = entry.record.clone();
    let mut first = true;
    let mut delta_line_end = 0u64;
    let mut offset = 0u64;
    for line in text.split_inclusive('\n') {
        let complete = line.ends_with('\n');
        let body = if complete { &line[..line.len() - 1] } else { line };
        if complete {
            delta_line_end = offset + line.len() as u64;
        }
        offset += line.len() as u64;
        if body.is_empty() {
            continue; // blank separators are not records
        }
        let Ok(value) = serde_json::from_str::<Value>(body) else {
            if first {
                return None; // cannot prove the chain continues: rescan
            }
            continue; // mirror the full walk: malformed lines are skipped
        };
        let Some(value_seq) = value.get("seq").and_then(|v| v.as_u64()) else {
            if first {
                return None;
            }
            continue;
        };
        if first {
            let prev = value.get("prevHash").cloned().unwrap_or(Value::Null);
            let chains = match (&entry.hash, &prev) {
                (None, Value::Null) => true,
                (Some(expected), Value::String(actual)) => expected == actual,
                _ => false,
            };
            if !chains || value_seq != entry.seq + 1 {
                return None; // the delta does not continue this chain: rescan
            }
            first = false;
        }
        if value_seq >= seq {
            seq = value_seq;
            hash = value.get("hash").and_then(|v| v.as_str()).map(|s| s.to_string());
            record = Some(value);
        }
    }
    Some(TailCacheEntry {
        len,
        mtime,
        line_end: entry.line_end + delta_line_end,
        seq,
        hash,
        record,
    })
}

/// Cheaply confirm the cached tail record is still the one on disk when
/// (len, mtime) matched. An in-place rewrite that preserves byte length and
/// lands in the same mtime tick is invisible to the (len, mtime) key, so we
/// re-read ONLY the last record's byte region (the serialized-record-plus-`\n`
/// span ending at `entry.line_end`, via the same narrow open+seek+read_exact
/// `extend_tail_from_delta` uses), parse it, and
/// require its `seq` and `hash` to still equal the cached entry's. Returns
/// `false` on any read/parse error or disagreement, so the caller drops the
/// stale entry and falls back to a full rescan (which sees the tampered tail).
fn cached_tail_still_on_disk(path: &Path, entry: &TailCacheEntry) -> bool {
    // An empty chain has no last-record bytes to re-validate; trust the entry
    // only if it genuinely described an empty file ending at a line boundary.
    let Some(record) = &entry.record else {
        return entry.len == 0 && entry.line_end == 0;
    };
    // The cached tail's last line is `<serialized record>\n`, written just past
    // `line_end`'s preceding complete line. Its serialized length lets us read
    // exactly that record's byte region `[start, line_end)` and no more.
    let Ok(serialized) = serde_json::to_string(record) else {
        return false;
    };
    // The record plus its trailing newline must fit inside the cached file; the
    // last line starts one line-length-plus-newline before the last boundary.
    let line_bytes = serialized.len() as u64 + 1;
    if entry.line_end > entry.len || line_bytes > entry.line_end {
        return false;
    }
    let start = entry.line_end - line_bytes;
    let Ok(mut file) = File::open(path) else {
        return false;
    };
    if file.seek(SeekFrom::Start(start)).is_err() {
        return false;
    }
    let mut buf = vec![0u8; line_bytes as usize];
    if file.read_exact(&mut buf).is_err() {
        return false;
    }
    let Ok(text) = String::from_utf8(buf) else {
        return false;
    };
    // The region is the last record line plus its trailing newline.
    let Some(body) = text.strip_suffix('\n') else {
        return false;
    };
    let Ok(value) = serde_json::from_str::<Value>(body) else {
        return false;
    };
    let seq = value.get("seq").and_then(|v| v.as_u64());
    let hash = value
        .get("hash")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());
    // The record's identity (seq + hash) must still match what we cached; an
    // in-place same-length rewrite that changes the hash is caught here.
    seq == Some(entry.seq) && hash == entry.hash
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
    crate::jsonl_append::sync_jsonl_append(path, &file)
        .map_err(|e| format!("cannot fsync {}: {}", path.display(), e))?;
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

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("hz-eventlog-{}-{}", tag, Uuid::new_v4()));
        fs::create_dir_all(&dir).expect("scratch dir");
        dir
    }

    /// The tail cache must not change semantics at scale: 20k appends through
    /// one EventLog (cache warm after every one) still form a verifiable chain.
    #[test]
    fn tail_cache_keeps_a_20k_chain_verifiable() {
        let dir = scratch("cache-20k");
        let log = EventLog::new_with_anchor(&dir, AnchorConfig::default());
        let stream = "session:cache-20k";
        for i in 0..20_000u64 {
            log.append(
                stream,
                &json!({ "type": "message.delta", "payload": { "i": i } }),
            )
            .unwrap_or_else(|e| panic!("append {} failed: {}", i, e));
        }
        let report = log.verify(stream).expect("verify");
        assert!(report.ok, "20k chain must verify: {:?}", report.to_json());
        assert_eq!(report.count, 20_000);
        let _ = fs::remove_dir_all(&dir);
    }

    /// A warm cache must not hide a truncated tail: the append still refuses.
    #[test]
    fn warm_cache_still_refuses_a_truncated_tail() {
        let dir = scratch("cache-truncate");
        let log = EventLog::new_with_anchor(&dir, AnchorConfig::default());
        let stream = "session:cache-truncate";
        for i in 0..3u64 {
            log.append(stream, &json!({ "type": "message.delta", "payload": { "i": i } }))
                .expect("append");
        }
        let path = log.stream_path(stream).expect("stream path");
        let text = fs::read_to_string(&path).expect("read chain");
        let lines: Vec<&str> = text.lines().collect();
        let truncated = format!("{}\n", lines[..lines.len() - 1].join("\n"));
        fs::write(&path, &truncated).expect("truncate");

        let err = log
            .append(stream, &json!({ "type": "message.delta", "payload": { "i": 9 } }))
            .expect_err("a truncated tail must not be extended");
        assert!(err.contains("anchor"), "unexpected refusal: {}", err);
        assert_eq!(fs::read_to_string(&path).unwrap(), truncated);
        let _ = fs::remove_dir_all(&dir);
    }

    /// A warm cache must not hide a rewritten tail: appending is still refused.
    #[test]
    fn warm_cache_still_refuses_a_rewritten_tail() {
        let dir = scratch("cache-rewrite");
        let log = EventLog::new_with_anchor(&dir, AnchorConfig::default());
        let stream = "session:cache-rewrite";
        for i in 0..3u64 {
            log.append(stream, &json!({ "type": "message.delta", "payload": { "i": i } }))
                .expect("append");
        }
        let path = log.stream_path(stream).expect("stream path");
        let text = fs::read_to_string(&path).expect("read chain");
        let mut lines: Vec<String> = text.lines().map(|line| line.to_string()).collect();
        let mut forged: Value = serde_json::from_str(&lines[2]).expect("parse last record");
        forged["hash"] = json!("deadbeef".repeat(8));
        lines[2] = serde_json::to_string(&forged).expect("serialize");
        fs::write(&path, format!("{}\n", lines.join("\n"))).expect("rewrite tail");

        let err = log
            .append(stream, &json!({ "type": "message.delta", "payload": { "i": 9 } }))
            .expect_err("a rewritten tail must not be extended");
        assert!(err.contains("anchor"), "unexpected refusal: {}", err);
        let _ = fs::remove_dir_all(&dir);
    }
}
