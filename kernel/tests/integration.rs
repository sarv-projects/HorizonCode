//! Deep integration tests for the HorizonCode trust kernel (`hz-kernel`).
//!
//! Every test drives the real binary over its NDJSON stdio protocol, spawned as
//! a separate process with an isolated `--state-dir`. That exercises exactly what
//! a runtime client sees: process boundaries, on-disk JSONL files, the
//! cross-process append lock, `policy.json` overrides, and the wire shapes frozen
//! in `app/src/contracts.ts`.
//!
//! Coverage map:
//!   - chain           : append/verify/read order, hash conformance to contracts.ts
//!   - tamper          : one-byte corruption, middle-payload tamper, truncated line,
//!                       tail truncation vs the `.head` anchor, rewritten/corrupt anchor
//!   - concurrency     : 4 separate processes × 5 appends on one stream
//!   - receipts        : issue/verify/tamper, empty and absent file
//!   - guard           : default policy matrix, policy.json override + deny precedence,
//!                       lease matching (exact / prefix `*` / `*`), expiry, scope `*`
//!   - protocol        : malformed input, unknown methods, param validation, 1 MB payload
//!
//! Determinism: every test owns a unique temp state dir; the only timing
//! assumption is "sleep 40 ms to outlive a 1 ms lease TTL".

use std::collections::BTreeMap;
use std::fs;
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Barrier};
use std::thread::sleep;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};

const CONTRACTS_HASH_FIXTURE: &str =
    "e01afd531202f990a87972bae8d8e489e88e794c234fcbe0368101b729f015b0";

/* ------------------------------- test temp dir ------------------------------- */

static DIR_SEQ: AtomicU64 = AtomicU64::new(0);

/// Unique, self-cleaning state dir for one test.
struct TempDir(PathBuf);

impl TempDir {
    fn new(tag: &str) -> TempDir {
        let seq = DIR_SEQ.fetch_add(1, Ordering::Relaxed);
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock before unix epoch")
            .as_nanos();
        let path = std::env::temp_dir().join(format!(
            "hz-kernel-it-{}-{}-{}-{}",
            std::process::id(),
            tag,
            seq,
            nanos
        ));
        fs::create_dir_all(&path).expect("create temp state dir");
        TempDir(path)
    }

    fn path(&self) -> &Path {
        &self.0
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

/* ------------------------------ kernel harness ------------------------------ */

/// One live `hz-kernel` process speaking NDJSON over stdio.
struct Kernel {
    child: Child,
    stdin: ChildStdin,
    stdout: BufReader<ChildStdout>,
    next_id: u64,
}

impl Kernel {
    fn start(state_dir: &Path) -> Kernel {
        let mut child = Command::new(env!("CARGO_BIN_EXE_hz-kernel"))
            .arg("--state-dir")
            .arg(state_dir)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()
            .expect("failed to spawn hz-kernel");
        let stdin = child.stdin.take().expect("child stdin");
        let stdout = BufReader::new(child.stdout.take().expect("child stdout"));
        Kernel {
            child,
            stdin,
            stdout,
            next_id: 1,
        }
    }

    fn send_line(&mut self, line: &str) {
        writeln!(self.stdin, "{}", line).expect("write request line");
        self.stdin.flush().expect("flush request line");
    }

    fn read_response(&mut self) -> Value {
        let mut line = String::new();
        let n = self
            .stdout
            .read_line(&mut line)
            .expect("read response line");
        assert!(n > 0, "kernel closed stdout before answering a request");
        serde_json::from_str(line.trim_end())
            .unwrap_or_else(|e| panic!("response is not JSON: {:?} ({})", line, e))
    }

    /// Send a raw line (may be malformed) and return the next response.
    fn request_raw(&mut self, line: &str) -> Value {
        self.send_line(line);
        self.read_response()
    }

    /// Well-formed request with an auto-assigned numeric id; asserts id echo.
    fn request(&mut self, method: &str, params: Value) -> Value {
        let id = self.next_id;
        self.next_id += 1;
        let request = json!({ "id": id, "method": method, "params": params });
        let response = self.request_raw(&request.to_string());
        assert_eq!(response["id"], json!(id), "id not echoed for {}: {}", method, response);
        response
    }

    /// Request expected to succeed; returns `result`.
    fn ok(&mut self, method: &str, params: Value) -> Value {
        let response = self.request(method, params);
        assert!(
            response.get("error").is_none(),
            "{} unexpectedly failed: {}",
            method,
            response
        );
        response.get("result").cloned().expect("missing result")
    }

    /// Request expected to fail; returns the error message.
    fn err(&mut self, method: &str, params: Value) -> String {
        let response = self.request(method, params);
        response["error"]["message"]
            .as_str()
            .unwrap_or_else(|| panic!("expected an error from {}, got {}", method, response))
            .to_string()
    }
}

impl Drop for Kernel {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

/* ------------------- canonical JSON + sha256 (contracts.ts) ------------------- */

fn canonical_json(v: &Value) -> String {
    match v {
        Value::Null => "null".to_string(),
        Value::Bool(b) => b.to_string(),
        Value::Number(n) => n.to_string(),
        Value::String(s) => serde_json::to_string(s).expect("serialize string"),
        Value::Array(items) => format!(
            "[{}]",
            items.iter().map(canonical_json).collect::<Vec<_>>().join(",")
        ),
        Value::Object(map) => {
            let mut keys: Vec<&String> = map.keys().collect();
            keys.sort_by(|a, b| a.as_bytes().cmp(b.as_bytes()));
            let body = keys
                .iter()
                .map(|key| {
                    format!(
                        "{}:{}",
                        serde_json::to_string(key).expect("serialize key"),
                        canonical_json(&map[key.as_str()])
                    )
                })
                .collect::<Vec<_>>()
                .join(",");
            format!("{{{}}}", body)
        }
    }
}

fn sha256_hex(s: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(s.as_bytes());
    hasher
        .finalize()
        .iter()
        .map(|byte| format!("{:02x}", byte))
        .collect()
}

/// `{id,seq,ts,stream,type,actor,payload,prevHash}` — event hash input.
fn envelope_preimage(envelope: &Value) -> Value {
    let mut map = Map::new();
    for field in [
        "id",
        "seq",
        "ts",
        "stream",
        "type",
        "actor",
        "payload",
        "prevHash",
    ] {
        map.insert(
            field.to_string(),
            envelope.get(field).cloned().unwrap_or(Value::Null),
        );
    }
    Value::Object(map)
}

fn hash_envelope(envelope: &Value) -> String {
    sha256_hex(&canonical_json(&envelope_preimage(envelope)))
}

/// Receipt hash input; `leaseId` only participates when the caller supplied it.
fn receipt_preimage(receipt: &Value) -> Value {
    let mut map = Map::new();
    for field in [
        "id",
        "seq",
        "ts",
        "action",
        "tool",
        "argsDigest",
        "resultDigest",
        "prevHash",
    ] {
        map.insert(
            field.to_string(),
            receipt.get(field).cloned().unwrap_or(Value::Null),
        );
    }
    if let Some(lease_id) = receipt.get("leaseId") {
        if !lease_id.is_null() {
            map.insert("leaseId".to_string(), lease_id.clone());
        }
    }
    Value::Object(map)
}

fn hash_receipt(receipt: &Value) -> String {
    sha256_hex(&canonical_json(&receipt_preimage(receipt)))
}

fn is_hash(s: &str) -> bool {
    s.len() == 64 && s.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

/// `YYYY-MM-DDTHH:MM:SS.mmmZ` (what `Date.toISOString()` emits).
fn is_iso_utc(s: &str) -> bool {
    let b = s.as_bytes();
    b.len() == 24
        && b[4] == b'-'
        && b[7] == b'-'
        && b[10] == b'T'
        && b[13] == b':'
        && b[16] == b':'
        && b[19] == b'.'
        && b[23] == b'Z'
        && b
            .iter()
            .enumerate()
            .all(|(i, c)| c.is_ascii_digit() || matches!(i, 4 | 7 | 10 | 13 | 16 | 19 | 23))
}

fn event_seed(i: u64) -> Value {
    json!({
        "id": format!("evt-{}", i),
        "type": "message.delta",
        "actor": { "kind": "agent", "id": "a-1" },
        "payload": { "i": i },
    })
}

fn guard_check(
    kernel: &mut Kernel,
    kind: &str,
    target: &str,
    scope: Option<&str>,
    leases: Option<Value>,
) -> Value {
    let mut params = json!({ "action": { "kind": kind, "target": target } });
    if let Some(scope) = scope {
        params["scope"] = json!(scope);
    }
    if let Some(leases) = leases {
        params["leases"] = leases;
    }
    let decision = kernel.ok("guard.check", params);
    assert!(
        decision["decision"].as_str().is_some(),
        "guard.check must return a decision string: {}",
        decision
    );
    assert!(
        decision["reason"]
            .as_str()
            .map(|reason| !reason.is_empty())
            .unwrap_or(false),
        "guard.check must return a non-empty reason: {}",
        decision
    );
    decision
}

fn guard_decision(
    kernel: &mut Kernel,
    kind: &str,
    target: &str,
    scope: Option<&str>,
    leases: Option<Value>,
) -> String {
    guard_check(kernel, kind, target, scope, leases)["decision"]
        .as_str()
        .expect("decision string")
        .to_string()
}

/* ---------------------------------- fixtures ---------------------------------- */

/// Guards the test-side canonicalization: it must reproduce the digest frozen in
/// the contract (same fixture as `canon.rs`'s `event_hash_is_stable`).
#[test]
fn test_canonical_json_matches_frozen_contract_fixture() {
    let envelope = json!({
        "id": "id-1",
        "seq": 1,
        "ts": "2026-01-01T00:00:00.000Z",
        "stream": "session:t",
        "type": "session.start",
        "actor": { "kind": "human", "id": "u1" },
        "payload": { "b": [true, null, "x"], "a": 1 },
        "prevHash": null,
        "hash": "ignored-by-hash",
    });
    assert_eq!(
        canonical_json(&envelope_preimage(&envelope)),
        "{\"actor\":{\"id\":\"u1\",\"kind\":\"human\"},\"id\":\"id-1\",\"payload\":{\"a\":1,\"b\":[true,null,\"x\"]},\"prevHash\":null,\"seq\":1,\"stream\":\"session:t\",\"ts\":\"2026-01-01T00:00:00.000Z\",\"type\":\"session.start\"}"
    );
    assert_eq!(hash_envelope(&envelope), CONTRACTS_HASH_FIXTURE);
}

/* ---------------------------------- 1. chain ---------------------------------- */

#[test]
fn chain_append_verify_and_read_in_seq_order() {
    let dir = TempDir::new("chain");
    let mut kernel = Kernel::start(dir.path());
    let stream = "session:chain";

    let mut prev: Option<String> = None;
    for i in 0..7u64 {
        let envelope = kernel.ok("log.append", json!({ "stream": stream, "event": event_seed(i) }));
        assert_eq!(envelope["seq"], json!(i + 1));
        assert_eq!(envelope["stream"], json!(stream));
        assert_eq!(envelope["type"], json!("message.delta"));
        assert_eq!(envelope["id"], json!(format!("evt-{}", i)));
        assert_eq!(envelope["payload"], json!({ "i": i }));
        assert!(
            is_iso_utc(envelope["ts"].as_str().unwrap_or("")),
            "ts is not ISO-8601 UTC: {}",
            envelope["ts"]
        );
        match &prev {
            None => assert!(envelope["prevHash"].is_null(), "first prevHash must be null"),
            Some(previous) => assert_eq!(envelope["prevHash"], json!(previous)),
        }
        let stored = envelope["hash"].as_str().expect("hash string");
        assert!(is_hash(stored), "hash shape invalid: {}", stored);
        assert_eq!(
            stored,
            hash_envelope(&envelope),
            "kernel hash diverges from the contracts.ts canonical rules"
        );
        prev = Some(stored.to_string());
    }

    // stream name sanitization: ':' -> '__' on disk
    assert!(dir.path().join("events/session__chain.jsonl").is_file());

    let report = kernel.ok("log.verify", json!({ "stream": stream }));
    assert_eq!(report["ok"], json!(true));
    assert_eq!(report["count"], json!(7));
    assert!(report.get("brokenAt").is_none(), "brokenAt must be absent when ok");

    // full read comes back in ascending seq order
    let read = kernel.ok("log.read", json!({ "stream": stream, "limit": 1000 }));
    let seqs: Vec<u64> = read["events"]
        .as_array()
        .expect("events array")
        .iter()
        .map(|event| event["seq"].as_u64().expect("seq"))
        .collect();
    assert_eq!(seqs, (1..=7).collect::<Vec<u64>>());

    // boundaries
    let mid = kernel.ok("log.read", json!({ "stream": stream, "fromSeq": 4, "limit": 2 }));
    let mid_seqs: Vec<u64> = mid["events"]
        .as_array()
        .unwrap()
        .iter()
        .map(|event| event["seq"].as_u64().unwrap())
        .collect();
    assert_eq!(mid_seqs, vec![4, 5]);

    let tail = kernel.ok("log.read", json!({ "stream": stream, "fromSeq": 7 }));
    assert_eq!(
        tail["events"].as_array().unwrap().len(),
        1,
        "fromSeq=last returns only the last event"
    );

    let beyond = kernel.ok("log.read", json!({ "stream": stream, "fromSeq": 8 }));
    assert!(beyond["events"].as_array().unwrap().is_empty());

    let zero_limit = kernel.ok("log.read", json!({ "stream": stream, "limit": 0 }));
    assert!(
        zero_limit["events"].as_array().unwrap().is_empty(),
        "limit: 0 must return zero events (at most `limit`)"
    );

    let one_limit = kernel.ok("log.read", json!({ "stream": stream, "limit": 1 }));
    assert_eq!(one_limit["events"].as_array().unwrap().len(), 1);
    assert_eq!(one_limit["events"][0]["seq"], json!(1));

    let unlimited = kernel.ok("log.read", json!({ "stream": stream, "fromSeq": 1, "limit": 1_000_000 }));
    assert_eq!(unlimited["events"].as_array().unwrap().len(), 7);

    // unknown streams read/verify as empty rather than erroring
    let absent = kernel.ok("log.read", json!({ "stream": "session:absent" }));
    assert!(absent["events"].as_array().unwrap().is_empty());
    let absent_report = kernel.ok("log.verify", json!({ "stream": "session:absent" }));
    assert_eq!(absent_report, json!({ "ok": true, "count": 0 }));

    // the on-disk file is the same chain the protocol reported
    let lines = fs::read_to_string(dir.path().join("events/session__chain.jsonl")).unwrap();
    assert_eq!(lines.lines().count(), 7);
}

#[test]
fn caller_supplied_chain_fields_are_ignored() {
    let dir = TempDir::new("spoof");
    let mut kernel = Kernel::start(dir.path());
    let stream = "session:spoof";

    let first = kernel.ok("log.append", json!({ "stream": stream, "event": event_seed(0) }));
    let second = kernel.ok(
        "log.append",
        json!({ "stream": stream, "event": {
            "id": "spoofed",
            "seq": 999,
            "prevHash": "deadbeef",
            "hash": "i-am-not-a-hash",
            "type": "message.delta",
            "payload": { "i": 1 },
        }}),
    );
    assert_eq!(second["seq"], json!(2), "kernel must assign seq, not trust the seed");
    assert_eq!(second["prevHash"], first["hash"], "kernel must chain to the real tail");
    assert_eq!(second["hash"], json!(hash_envelope(&second)));

    let report = kernel.ok("log.verify", json!({ "stream": stream }));
    assert_eq!(report["ok"], json!(true));
    assert_eq!(report["count"], json!(2));
}

/* --------------------------------- 2. tamper --------------------------------- */

#[test]
fn one_corrupted_byte_breaks_verification_with_broken_at() {
    let dir = TempDir::new("tamper-byte");
    let stream = "session:tamper";
    {
        let mut kernel = Kernel::start(dir.path());
        for i in 0..5u64 {
            kernel.ok("log.append", json!({ "stream": stream, "event": event_seed(i) }));
        }
        let report = kernel.ok("log.verify", json!({ "stream": stream }));
        assert_eq!(report["ok"], json!(true));
        assert_eq!(report["count"], json!(5));
    }

    let path = dir.path().join("events/session__tamper.jsonl");
    let original = fs::read_to_string(&path).unwrap();
    // Exactly one byte changes (0 -> 7) inside the first event's payload, keeping
    // the JSON valid so the *hash* check, not the parser, is what fails.
    let tampered = original.replacen("\"payload\":{\"i\":0}", "\"payload\":{\"i\":7}", 1);
    assert_ne!(original, tampered, "fixture assumption: first payload is {{\"i\":0}}");
    assert_eq!(original.len(), tampered.len(), "exactly one byte must change");
    fs::write(&path, tampered).unwrap();

    let mut kernel = Kernel::start(dir.path());
    let report = kernel.ok("log.verify", json!({ "stream": stream }));
    assert_eq!(report["ok"], json!(false));
    assert_eq!(report["brokenAt"], json!(1), "the first event's hash no longer matches");
    assert_eq!(report["count"], json!(0), "nothing verifies before the break");
}

#[test]
fn tampered_middle_payload_breaks_at_that_seq() {
    let dir = TempDir::new("tamper-middle");
    let stream = "session:middle";
    {
        let mut kernel = Kernel::start(dir.path());
        for i in 0..5u64 {
            kernel.ok("log.append", json!({ "stream": stream, "event": event_seed(i) }));
        }
    }

    let path = dir.path().join("events/session__middle.jsonl");
    let original = fs::read_to_string(&path).unwrap();
    let tampered = original.replacen("\"payload\":{\"i\":2}", "\"payload\":{\"i\":222}", 1);
    assert_ne!(original, tampered);
    fs::write(&path, tampered).unwrap();

    let mut kernel = Kernel::start(dir.path());
    let report = kernel.ok("log.verify", json!({ "stream": stream }));
    assert_eq!(report["ok"], json!(false));
    assert_eq!(report["brokenAt"], json!(3), "third event (i=2) was rewritten");
    assert_eq!(report["count"], json!(2), "events 1 and 2 still verify");
}

#[test]
fn truncated_line_breaks_at_that_seq() {
    let dir = TempDir::new("tamper-truncate");
    let stream = "session:truncate";
    {
        let mut kernel = Kernel::start(dir.path());
        for i in 0..5u64 {
            kernel.ok("log.append", json!({ "stream": stream, "event": event_seed(i) }));
        }
    }

    let path = dir.path().join("events/session__truncate.jsonl");
    let original = fs::read_to_string(&path).unwrap();
    let truncated = &original[..original.len() - 4]; // cut mid-object: invalid JSON tail
    fs::write(&path, truncated).unwrap();

    let mut kernel = Kernel::start(dir.path());
    let report = kernel.ok("log.verify", json!({ "stream": stream }));
    assert_eq!(report["ok"], json!(false));
    assert_eq!(report["brokenAt"], json!(5));
    assert_eq!(report["count"], json!(4));
}

/* ------------------------------ 2b. chain anchor ------------------------------ */

#[test]
fn tail_truncation_is_detected_and_appends_are_refused() {
    let dir = TempDir::new("anchor-truncate");
    let stream = "session:anchor";
    let path = dir.path().join("events/session__anchor.jsonl");
    let head_path = dir.path().join("events/session__anchor.jsonl.head");
    {
        let mut kernel = Kernel::start(dir.path());
        for i in 0..3u64 {
            kernel.ok("log.append", json!({ "stream": stream, "event": event_seed(i) }));
        }
        let report = kernel.ok("log.verify", json!({ "stream": stream }));
        assert_eq!(report, json!({ "ok": true, "count": 3 }));
        // the anchor beside the log names the last record
        let anchor: Value =
            serde_json::from_str(fs::read_to_string(&head_path).unwrap().trim()).unwrap();
        assert_eq!(anchor["seq"], json!(3));
        let last = kernel.ok("log.read", json!({ "stream": stream, "fromSeq": 3 }));
        assert_eq!(anchor["hash"], last["events"][0]["hash"]);
    }

    // delete whole trailing records: a bare chain walk can never see this
    let original = fs::read_to_string(&path).unwrap();
    let mut lines: Vec<&str> = original.lines().collect();
    lines.pop();
    fs::write(&path, format!("{}\n", lines.join("\n"))).unwrap();

    let mut kernel = Kernel::start(dir.path());
    let report = kernel.ok("log.verify", json!({ "stream": stream }));
    assert_eq!(report["ok"], json!(false));
    assert_eq!(
        report["brokenAt"],
        json!(3),
        "the record the anchor remembers is gone"
    );
    assert_eq!(report["count"], json!(2));
    // and the truncated chain cannot be extended as if nothing happened
    let message = kernel.err("log.append", json!({ "stream": stream, "event": event_seed(9) }));
    assert!(message.contains("anchor"), "{}", message);
    assert_eq!(fs::read_to_string(&path).unwrap().lines().count(), 2);

    // deleting the anchor too falls back to legacy acceptance of what remains —
    // the residual recorded in docs/28 §4
    fs::remove_file(&head_path).unwrap();
    let report = kernel.ok("log.verify", json!({ "stream": stream }));
    assert_eq!(report, json!({ "ok": true, "count": 2 }));
    let appended = kernel.ok("log.append", json!({ "stream": stream, "event": event_seed(9) }));
    assert_eq!(appended["seq"], json!(3));
    let report = kernel.ok("log.verify", json!({ "stream": stream }));
    assert_eq!(report, json!({ "ok": true, "count": 3 }));
}

#[test]
fn a_rewritten_or_corrupt_anchor_is_detected() {
    let dir = TempDir::new("anchor-rewrite");
    let stream = "session:anchor2";
    let head_path = dir.path().join("events/session__anchor2.jsonl.head");
    {
        let mut kernel = Kernel::start(dir.path());
        for i in 0..3u64 {
            kernel.ok("log.append", json!({ "stream": stream, "event": event_seed(i) }));
        }
    }

    // rewrite the anchor to claim more records than exist (truncation shape)
    let anchor: Value =
        serde_json::from_str(fs::read_to_string(&head_path).unwrap().trim()).unwrap();
    fs::write(
        &head_path,
        serde_json::to_string(&json!({ "hash": anchor["hash"], "seq": 5 })).unwrap(),
    )
    .unwrap();
    let mut kernel = Kernel::start(dir.path());
    let report = kernel.ok("log.verify", json!({ "stream": stream }));
    assert_eq!(report["ok"], json!(false));
    assert_eq!(report["brokenAt"], json!(4));

    // an unreadable anchor is a finding, not a free pass
    fs::write(&head_path, "{not json").unwrap();
    let report = kernel.ok("log.verify", json!({ "stream": stream }));
    assert_eq!(report["ok"], json!(false));
    assert_eq!(report["brokenAt"], json!(4));
    let message = kernel.err("log.append", json!({ "stream": stream, "event": event_seed(9) }));
    assert!(message.contains("anchor"), "{}", message);

    // a correct anchor over an intact chain verifies again
    let last = kernel.ok("log.read", json!({ "stream": stream, "fromSeq": 3 }));
    fs::write(
        &head_path,
        serde_json::to_string(&json!({ "hash": last["events"][0]["hash"], "seq": 3 })).unwrap(),
    )
    .unwrap();
    let report = kernel.ok("log.verify", json!({ "stream": stream }));
    assert_eq!(report, json!({ "ok": true, "count": 3 }));
}

#[test]
fn receipt_tail_truncation_is_detected() {
    let dir = TempDir::new("anchor-receipts");
    let receipts_path = dir.path().join("receipts.jsonl");
    let head_path = dir.path().join("receipts.jsonl.head");
    {
        let mut kernel = Kernel::start(dir.path());
        for i in 0..2u64 {
            kernel.ok(
                "receipt.issue",
                json!({
                    "action": "tool.execute",
                    "tool": "shell",
                    "argsDigest": sha256_hex(&format!("args-{}", i)),
                    "resultDigest": sha256_hex(&format!("res-{}", i)),
                }),
            );
        }
        assert_eq!(kernel.ok("receipt.verify", json!({})), json!({ "ok": true, "count": 2 }));
        assert!(head_path.is_file(), "receipts anchor must exist after issuing");
    }

    let original = fs::read_to_string(&receipts_path).unwrap();
    let mut lines: Vec<&str> = original.lines().collect();
    lines.pop();
    fs::write(&receipts_path, format!("{}\n", lines.join("\n"))).unwrap();

    let mut kernel = Kernel::start(dir.path());
    let report = kernel.ok("receipt.verify", json!({}));
    assert_eq!(report["ok"], json!(false));
    assert_eq!(report["brokenAt"], json!(2));
    assert_eq!(report["count"], json!(1));
    let message = kernel.err(
        "receipt.issue",
        json!({ "action": "tool.execute", "tool": "shell", "argsDigest": "aa", "resultDigest": "bb" }),
    );
    assert!(message.contains("anchor"), "{}", message);
}

/* ------------------------------- 3. concurrency ------------------------------- */

#[test]
fn four_processes_append_five_events_each_without_losing_any() {
    let dir = TempDir::new("concurrency");
    let stream = "session:conc";
    const WRITERS: usize = 4;
    const PER_WRITER: usize = 5;

    let barrier = Arc::new(Barrier::new(WRITERS));
    let envelopes: Vec<Vec<Value>> = std::thread::scope(|scope| {
        let handles: Vec<_> = (0..WRITERS)
            .map(|writer| {
                let barrier = Arc::clone(&barrier);
                let dir_path = dir.path().to_path_buf();
                scope.spawn(move || {
                    let mut kernel = Kernel::start(&dir_path);
                    barrier.wait(); // all four processes write at the same moment
                    (0..PER_WRITER)
                        .map(|n| {
                            kernel.ok(
                                "log.append",
                                json!({ "stream": stream, "event": {
                                    "type": "message.delta",
                                    "actor": { "kind": "agent", "id": format!("w{}", writer) },
                                    "payload": { "writer": writer, "n": n },
                                }}),
                            )
                        })
                        .collect()
                })
            })
            .collect();
        handles
            .into_iter()
            .map(|handle| handle.join().expect("writer thread panicked"))
            .collect()
    });

    let flat: Vec<&Value> = envelopes.iter().flatten().collect();
    assert_eq!(flat.len(), WRITERS * PER_WRITER);

    // 20 distinct seqs, exactly 1..=20
    let mut seqs: Vec<u64> = flat.iter().map(|e| e["seq"].as_u64().unwrap()).collect();
    seqs.sort_unstable();
    assert_eq!(
        seqs,
        (1..=20).collect::<Vec<u64>>(),
        "cross-process append produced duplicate or missing seqs"
    );

    // 20 distinct event ids
    let mut ids: Vec<&str> = flat.iter().map(|e| e["id"].as_str().unwrap()).collect();
    ids.sort_unstable();
    ids.dedup();
    assert_eq!(ids.len(), WRITERS * PER_WRITER);

    // every writer's own events survived with their payload intact
    let mut markers: Vec<(u64, u64)> = flat
        .iter()
        .map(|e| {
            (
                e["payload"]["writer"].as_u64().unwrap(),
                e["payload"]["n"].as_u64().unwrap(),
            )
        })
        .collect();
    markers.sort_unstable();
    let expected: Vec<(u64, u64)> = (0..WRITERS as u64)
        .flat_map(|writer| (0..PER_WRITER as u64).map(move |n| (writer, n)))
        .collect();
    assert_eq!(markers, expected);

    // chain links hold across writer interleaving, and hashes obey the contract
    let by_seq: BTreeMap<u64, Value> = flat
        .iter()
        .map(|e| (e["seq"].as_u64().unwrap(), (*e).clone()))
        .collect();
    for seq in 1..=20u64 {
        let envelope = &by_seq[&seq];
        assert_eq!(envelope["hash"].as_str().unwrap(), hash_envelope(envelope));
        if seq == 1 {
            assert!(envelope["prevHash"].is_null());
        } else {
            assert_eq!(
                envelope["prevHash"],
                by_seq[&(seq - 1)]["hash"],
                "prevHash chain broken at seq {}",
                seq
            );
        }
    }

    // a fresh process re-verifies the whole log and reads it in order
    let mut verifier = Kernel::start(dir.path());
    let report = verifier.ok("log.verify", json!({ "stream": stream }));
    assert_eq!(report["ok"], json!(true));
    assert_eq!(report["count"], json!(20));

    let read = verifier.ok("log.read", json!({ "stream": stream, "limit": 100 }));
    let read_seqs: Vec<u64> = read["events"]
        .as_array()
        .unwrap()
        .iter()
        .map(|event| event["seq"].as_u64().unwrap())
        .collect();
    assert_eq!(read_seqs, (1..=20).collect::<Vec<u64>>());
}

/* -------------------------------- 4. receipts -------------------------------- */

#[test]
fn receipts_chain_verify_tamper_and_empty_file() {
    let dir = TempDir::new("receipts");
    let receipts_path = dir.path().join("receipts.jsonl");
    fs::write(&receipts_path, "").unwrap(); // literal empty file
    let mut kernel = Kernel::start(dir.path());

    // empty file verifies as an empty chain
    let report = kernel.ok("receipt.verify", json!({}));
    assert_eq!(report, json!({ "ok": true, "count": 0 }));

    let mut last_hash: Option<String> = None;
    for i in 0..3u64 {
        let args_digest = sha256_hex(&canonical_json(&json!({ "cmd": "echo", "n": i })));
        let receipt = kernel.ok(
            "receipt.issue",
            json!({
                "action": "tool.execute",
                "tool": "shell",
                "argsDigest": args_digest,
                "resultDigest": sha256_hex(&format!("output-{}", i)),
            }),
        );
        assert_eq!(receipt["seq"], json!(i + 1));
        assert!(
            receipt.get("leaseId").is_none(),
            "leaseId must be omitted when the caller did not supply it"
        );
        match &last_hash {
            None => assert!(receipt["prevHash"].is_null()),
            Some(previous) => assert_eq!(receipt["prevHash"], json!(previous)),
        }
        let stored = receipt["hash"].as_str().unwrap();
        assert_eq!(
            stored,
            hash_receipt(&receipt),
            "receipt hash diverges from the contracts.ts canonical rules"
        );
        last_hash = Some(stored.to_string());
    }

    // a caller-supplied leaseId participates in the hash
    let with_lease = kernel.ok(
        "receipt.issue",
        json!({
            "action": "tool.execute",
            "tool": "shell",
            "argsDigest": sha256_hex("[]"),
            "resultDigest": sha256_hex("done"),
            "leaseId": "lease-abc-123",
        }),
    );
    assert_eq!(with_lease["leaseId"], json!("lease-abc-123"));
    assert_eq!(with_lease["seq"], json!(4));
    assert_eq!(with_lease["hash"].as_str().unwrap(), hash_receipt(&with_lease));
    // and the hash must actually change when leaseId is dropped from the preimage
    let mut without_lease = with_lease.clone();
    without_lease.as_object_mut().unwrap().remove("leaseId");
    assert_ne!(
        with_lease["hash"],
        json!(hash_receipt(&without_lease)),
        "leaseId must participate in the receipt hash"
    );

    let report = kernel.ok("receipt.verify", json!({}));
    assert_eq!(report["ok"], json!(true));
    assert_eq!(report["count"], json!(4));

    assert_eq!(fs::read_to_string(&receipts_path).unwrap().lines().count(), 4);

    // tamper the second receipt: verification stops there
    let original = fs::read_to_string(&receipts_path).unwrap();
    let tampered = original.replacen(&sha256_hex("output-1"), &sha256_hex("output-1-tampered"), 1);
    assert_ne!(original, tampered, "fixture assumption: receipt 2 resultDigest present");
    fs::write(&receipts_path, tampered).unwrap();

    let report = kernel.ok("receipt.verify", json!({}));
    assert_eq!(report["ok"], json!(false));
    assert_eq!(report["brokenAt"], json!(2));
    assert_eq!(report["count"], json!(1));

    // a state dir with no receipts file at all also verifies as empty
    let other = TempDir::new("receipts-absent");
    let mut other_kernel = Kernel::start(other.path());
    let report = other_kernel.ok("receipt.verify", json!({}));
    assert_eq!(report, json!({ "ok": true, "count": 0 }));
}

/* ---------------------------------- 5. guard ---------------------------------- */

#[test]
fn guard_default_policy_matrix() {
    let dir = TempDir::new("guard-default");
    let mut kernel = Kernel::start(dir.path());

    // (kind, target, scope, expected decision)
    let cases: &[(&str, &str, Option<&str>, &str)] = &[
        ("fs.read", "src/main.rs", Some("workspace"), "allow"),
        ("fs.write", "src/main.rs", Some("workspace"), "allow"),
        ("fs.read", "/etc/shadow", Some("outside"), "ask"),
        ("fs.write", "/etc/hosts", Some("outside"), "ask"),
        ("shell.exec", "rm -rf /", Some("workspace"), "ask"),
        ("net.fetch", "https://example.com", Some("workspace"), "ask"),
        ("net.fetch", "https://example.com", Some("outside"), "ask"),
        ("spawn", "node", Some("workspace"), "ask"),
        ("unknown.kind", "anything", Some("workspace"), "ask"),
        // scope absent is treated as "*": only wildcard-scope rules can match
        ("shell.exec", "echo hi", None, "ask"),
        ("fs.write", "src/main.rs", None, "ask"),
    ];
    for (kind, target, scope, expected) in cases {
        let decision = guard_decision(&mut kernel, kind, target, *scope, None);
        assert_eq!(
            &decision, expected,
            "default policy: {} on {} @ {:?}",
            kind, target, scope
        );
    }
}

#[test]
fn guard_policy_json_override_and_deny_precedence() {
    let dir = TempDir::new("guard-policy");
    let mut kernel = Kernel::start(dir.path());

    // defaults first: workspace write allowed, shell asks
    assert_eq!(
        guard_decision(&mut kernel, "fs.write", "src/x.rs", Some("workspace"), None),
        "allow"
    );

    // policy.json is picked up without a restart
    let policy = json!([
        // deny declared after allow must still win (deny > allow > ask)
        { "kind": "fs.write", "scope": "workspace", "decision": "allow" },
        { "kind": "fs.write", "scope": "workspace", "decision": "deny" },
        // scope wildcard
        { "kind": "shell.exec", "scope": "*", "decision": "allow" },
        // scope-specific allow must not leak to other scopes
        { "kind": "net.fetch", "scope": "workspace", "decision": "allow" },
    ]);
    fs::write(
        dir.path().join("policy.json"),
        serde_json::to_string(&policy).unwrap(),
    )
    .unwrap();

    assert_eq!(
        guard_decision(&mut kernel, "fs.write", "src/x.rs", Some("workspace"), None),
        "deny"
    );
    let decision = guard_check(&mut kernel, "fs.write", "src/x.rs", Some("workspace"), None);
    assert!(
        decision["reason"].as_str().unwrap().contains("deny"),
        "deny reason should say why: {}",
        decision
    );
    // the override replaces the defaults entirely: outside now matches nothing
    assert_eq!(
        guard_decision(&mut kernel, "fs.write", "src/x.rs", Some("outside"), None),
        "ask"
    );
    // scope "*" rules match every caller scope
    assert_eq!(
        guard_decision(&mut kernel, "shell.exec", "echo hi", Some("workspace"), None),
        "allow"
    );
    assert_eq!(
        guard_decision(&mut kernel, "shell.exec", "echo hi", Some("outside"), None),
        "allow"
    );
    assert_eq!(
        guard_decision(&mut kernel, "shell.exec", "echo hi", None, None),
        "allow"
    );
    // workspace allow does not extend to outside
    assert_eq!(
        guard_decision(&mut kernel, "net.fetch", "https://x", Some("workspace"), None),
        "allow"
    );
    assert_eq!(
        guard_decision(&mut kernel, "net.fetch", "https://x", Some("outside"), None),
        "ask"
    );

    // a matching lease cannot override a matching deny
    let lease = kernel.ok(
        "guard.lease",
        json!({ "kind": "fs.write", "pattern": "*", "ttlMs": 60_000 }),
    );
    let decision = guard_check(
        &mut kernel,
        "fs.write",
        "src/x.rs",
        Some("workspace"),
        Some(json!([lease])),
    );
    assert_eq!(decision["decision"], json!("deny"));
    assert!(decision.get("leaseId").is_none());

    // kind "*" + scope "*" denies everything
    fs::write(
        dir.path().join("policy.json"),
        serde_json::to_string(&json!([
            { "kind": "*", "scope": "*", "decision": "deny" }
        ]))
        .unwrap(),
    )
    .unwrap();
    for (kind, target, scope) in [
        ("fs.read", "src/x", Some("workspace")),
        ("fs.write", "src/x", Some("workspace")),
        ("shell.exec", "ls", Some("workspace")),
        ("net.fetch", "https://x", Some("outside")),
        ("spawn", "node", None),
    ] {
        assert_eq!(
            guard_decision(&mut kernel, kind, target, scope, None),
            "deny",
            "kind \"*\" + scope \"*\" rule must deny {} @ {:?}",
            kind,
            scope
        );
    }

    // malformed policy.json falls back to the built-in policy
    fs::write(dir.path().join("policy.json"), "{not json").unwrap();
    assert_eq!(
        guard_decision(&mut kernel, "fs.write", "src/x.rs", Some("workspace"), None),
        "allow"
    );
    assert_eq!(
        guard_decision(&mut kernel, "shell.exec", "echo hi", Some("workspace"), None),
        "ask"
    );
}

#[test]
fn guard_leases_match_exactly_or_by_prefix_and_expire() {
    let dir = TempDir::new("guard-leases");
    let mut kernel = Kernel::start(dir.path());

    // exact pattern
    let exact = kernel.ok(
        "guard.lease",
        json!({ "kind": "shell.exec", "pattern": "echo hi", "ttlMs": 60_000 }),
    );
    assert!(
        exact["leaseId"].as_str().map(|s| !s.is_empty()).unwrap_or(false),
        "leaseId must be a non-empty string: {}",
        exact
    );
    assert_eq!(exact["kind"], json!("shell.exec"));
    assert_eq!(exact["pattern"], json!("echo hi"));
    assert!(
        is_iso_utc(exact["expiry"].as_str().unwrap_or("")),
        "lease expiry must be ISO-8601 UTC: {}",
        exact["expiry"]
    );

    // the held lease applies to subsequent checks without being passed in
    let decision = guard_check(&mut kernel, "shell.exec", "echo hi", Some("workspace"), None);
    assert_eq!(decision["decision"], json!("allow"));
    assert_eq!(decision["leaseId"], exact["leaseId"]);

    // exact means exact
    assert_eq!(
        guard_decision(&mut kernel, "shell.exec", "echo hi again", Some("workspace"), None),
        "ask"
    );
    // ...and kind must match too
    assert_eq!(
        guard_decision(&mut kernel, "fs.write", "echo hi", Some("outside"), None),
        "ask"
    );

    // trailing '*' is a prefix match
    kernel.ok(
        "guard.lease",
        json!({ "kind": "shell.exec", "pattern": "echo *", "ttlMs": 60_000 }),
    );
    assert_eq!(
        guard_decision(&mut kernel, "shell.exec", "echo hey", Some("workspace"), None),
        "allow"
    );
    assert_eq!(
        guard_decision(&mut kernel, "shell.exec", "echo", Some("workspace"), None),
        "ask",
        "'echo *' matches 'echo ' prefixes, not bare 'echo'"
    );

    // '*' alone matches any target of its kind
    let star = kernel.ok(
        "guard.lease",
        json!({ "kind": "net.fetch", "pattern": "*", "ttlMs": 60_000 }),
    );
    let decision = guard_check(&mut kernel, "net.fetch", "https://any.example/x?q=1", None, None);
    assert_eq!(decision["decision"], json!("allow"));
    assert_eq!(decision["leaseId"], star["leaseId"]);

    // caller-supplied leases work statelessly
    let caller_lease = json!({
        "leaseId": "caller-lease-1",
        "kind": "fs.write",
        "pattern": "/tmp/*",
        "expiry": "2999-01-01T00:00:00.000Z",
    });
    let decision = guard_check(
        &mut kernel,
        "fs.write",
        "/tmp/scratch.txt",
        Some("outside"),
        Some(json!([caller_lease])),
    );
    assert_eq!(decision["decision"], json!("allow"));
    assert_eq!(decision["leaseId"], json!("caller-lease-1"));

    // an expired caller-supplied lease grants nothing
    let expired = json!({
        "leaseId": "caller-lease-2",
        "kind": "fs.write",
        "pattern": "/tmp/*",
        "expiry": "2000-01-01T00:00:00.000Z",
    });
    assert_eq!(
        guard_decision(
            &mut kernel,
            "fs.write",
            "/tmp/scratch.txt",
            Some("outside"),
            Some(json!([expired])),
        ),
        "ask"
    );
    // an unparseable expiry never grants authority
    let unparseable = json!({
        "leaseId": "caller-lease-3",
        "kind": "fs.write",
        "pattern": "/tmp/*",
        "expiry": "not-a-date",
    });
    assert_eq!(
        guard_decision(
            &mut kernel,
            "fs.write",
            "/tmp/scratch.txt",
            Some("outside"),
            Some(json!([unparseable])),
        ),
        "ask"
    );

    // ttlMs=1 expires: once the TTL has passed the same action falls back to ask
    kernel.ok(
        "guard.lease",
        json!({ "kind": "shell.exec", "pattern": "sleep *", "ttlMs": 1 }),
    );
    sleep(Duration::from_millis(40));
    assert_eq!(
        guard_decision(&mut kernel, "shell.exec", "sleep 1", Some("workspace"), None),
        "ask",
        "expired lease must fall back to the policy (ask), not allow"
    );

    // long-lived leases survive the same sleep
    kernel.ok(
        "guard.lease",
        json!({ "kind": "shell.exec", "pattern": "git *", "ttlMs": 60_000 }),
    );
    assert_eq!(
        guard_decision(&mut kernel, "shell.exec", "git status", Some("workspace"), None),
        "allow"
    );
}

/* --------------------------------- 6. protocol --------------------------------- */

#[test]
fn protocol_survives_malformed_and_unknown_requests() {
    let dir = TempDir::new("protocol");
    let mut kernel = Kernel::start(dir.path());

    // malformed JSON -> error with id null...
    let response = kernel.request_raw("this is not json {{{{");
    assert_eq!(response["id"], Value::Null);
    assert!(
        response["error"]["message"]
            .as_str()
            .unwrap_or("")
            .contains("malformed request line"),
        "unexpected malformed-line response: {}",
        response
    );
    // ...and the very next valid request is served
    let ping = kernel.ok("ping", json!({}));
    assert!(!ping["version"].as_str().unwrap_or("").is_empty());

    // valid JSON that is not an object -> error, id null
    let response = kernel.request_raw("[1,2,3]");
    assert_eq!(response["id"], Value::Null);
    assert!(response["error"]["message"].is_string());

    // trailing garbage after valid JSON -> malformed, id null, still alive
    let response = kernel.request_raw(r#"{"id":1,"method":"ping","params":{}} trailing"#);
    assert_eq!(response["id"], Value::Null);
    assert!(response["error"]["message"].is_string());

    // unknown method -> error, id echoed
    let response = kernel.request("does.not.exist", json!({}));
    assert!(
        response["error"]["message"]
            .as_str()
            .unwrap()
            .contains("unknown method"),
        "unexpected unknown-method response: {}",
        response
    );

    // a non-numeric id is echoed as null but the request still runs
    let response = kernel.request_raw(r#"{"id":"abc","method":"ping","params":{}}"#);
    assert_eq!(response["id"], Value::Null);
    assert!(response["result"]["version"].is_string());

    // blank lines are ignored; the following request gets the next response
    kernel.send_line("");
    let ping2 = kernel.ok("ping", json!({}));
    assert_eq!(ping2["version"], ping["version"]);

    // two requests in one write -> two responses, in order
    kernel.send_line(&json!({ "id": 900, "method": "ping", "params": {} }).to_string());
    kernel.send_line(&json!({ "id": 901, "method": "ping", "params": {} }).to_string());
    assert_eq!(kernel.read_response()["id"], json!(900));
    assert_eq!(kernel.read_response()["id"], json!(901));

    // param validation: errors, never exits or panics
    let message = kernel.err("log.append", json!({}));
    assert!(message.contains("stream"), "{}", message);
    let message = kernel.err(
        "log.append",
        json!({ "stream": "   ", "event": { "type": "t" } }),
    );
    assert!(message.contains("stream"), "{}", message);
    let message = kernel.err("log.append", json!({ "stream": "s" }));
    assert!(message.contains("event"), "{}", message);
    let message = kernel.err("log.append", json!({ "stream": "s", "event": 42 }));
    assert!(message.contains("must be an object"), "{}", message);
    let message = kernel.err("log.append", json!({ "stream": "s", "event": {} }));
    assert!(message.contains("type"), "{}", message);
    let message = kernel.err(
        "log.append",
        json!({ "stream": "s", "event": { "type": "t", "stream": "other" } }),
    );
    assert!(message.contains("does not match"), "{}", message);
    let message = kernel.err(
        "log.append",
        json!({ "stream": "s", "event": { "type": "t", "actor": 5 } }),
    );
    assert!(message.contains("actor"), "{}", message);
    let message = kernel.err("log.read", json!({}));
    assert!(message.contains("stream"), "{}", message);
    let message = kernel.err("log.verify", json!({ "stream": "" }));
    assert!(message.contains("stream"), "{}", message);
    let message = kernel.err("guard.check", json!({}));
    assert!(message.contains("action"), "{}", message);
    let message = kernel.err("guard.check", json!({ "action": { "kind": "fs.write" } }));
    assert!(message.contains("target"), "{}", message);
    let message = kernel.err(
        "guard.check",
        json!({ "action": { "kind": "fs.write", "target": "x" }, "leases": "nope" }),
    );
    assert!(message.contains("array"), "{}", message);
    let message = kernel.err(
        "guard.check",
        json!({ "action": { "kind": "fs.write", "target": "x" }, "leases": [1] }),
    );
    assert!(message.contains("leases[0]"), "{}", message);
    let message = kernel.err("guard.lease", json!({ "kind": "shell.exec", "pattern": "*" }));
    assert!(message.contains("ttlMs"), "{}", message);
    let message = kernel.err("guard.lease", json!({ "kind": "", "pattern": "*", "ttlMs": 10 }));
    assert!(message.contains("kind"), "{}", message);
    let message = kernel.err(
        "receipt.issue",
        json!({ "action": "a", "tool": "t", "argsDigest": "d" }),
    );
    assert!(message.contains("resultDigest"), "{}", message);
    let message = kernel.err("receipt.issue", json!({ "action": "a", "tool": "t" }));
    assert!(message.contains("argsDigest"), "{}", message);

    // after all that abuse the process still serves requests
    assert!(!kernel.ok("ping", json!({}))["version"].as_str().unwrap_or("").is_empty());
    let report = kernel.ok("log.verify", json!({ "stream": "s" }));
    assert_eq!(report["ok"], json!(true));
}

#[test]
fn protocol_handles_megabyte_and_unicode_payloads() {
    let dir = TempDir::new("large");
    let mut kernel = Kernel::start(dir.path());
    let stream = "session:large";

    // 1 MB string payload round-trips through stdin, the log and stdout
    let big = "x".repeat(1_000_000);
    let big_len = big.len();
    let envelope = kernel.ok(
        "log.append",
        json!({ "stream": stream, "event": {
            "type": "message.delta",
            "actor": { "kind": "tool", "id": "big" },
            "payload": { "blob": big },
        }}),
    );
    assert_eq!(envelope["payload"]["blob"].as_str().unwrap().len(), big_len);
    assert_eq!(envelope["hash"].as_str().unwrap(), hash_envelope(&envelope));

    let read = kernel.ok("log.read", json!({ "stream": stream }));
    let events = read["events"].as_array().unwrap();
    assert_eq!(events.len(), 1);
    assert_eq!(events[0]["payload"]["blob"].as_str().unwrap().len(), big_len);

    // unicode + escapes participate correctly in the canonical hash
    let text = "héllo \"quoted\" \\ 🎉 line\nbreak\ttab";
    let envelope = kernel.ok(
        "log.append",
        json!({ "stream": stream, "event": {
            "type": "message.delta",
            "payload": { "text": text },
        }}),
    );
    assert_eq!(envelope["payload"]["text"], json!(text));
    assert_eq!(envelope["hash"].as_str().unwrap(), hash_envelope(&envelope));

    let report = kernel.ok("log.verify", json!({ "stream": stream }));
    assert_eq!(report["ok"], json!(true));
    assert_eq!(report["count"], json!(2));
}

/* ---------------------------------- 7. CLI ---------------------------------- */

#[test]
fn cli_selftest_and_version() {
    let dir = TempDir::new("selftest");
    let output = Command::new(env!("CARGO_BIN_EXE_hz-kernel"))
        .arg("--selftest")
        .arg("--state-dir")
        .arg(dir.path())
        .output()
        .expect("run --selftest");
    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(
        output.status.success(),
        "--selftest failed (status {:?})\nstdout:\n{}\nstderr:\n{}",
        output.status,
        stdout,
        stderr
    );
    assert!(stdout.contains("SELFTEST OK"), "stdout:\n{}", stdout);

    let output = Command::new(env!("CARGO_BIN_EXE_hz-kernel"))
        .arg("--version")
        .output()
        .expect("run --version");
    assert!(output.status.success());
    assert!(
        String::from_utf8_lossy(&output.stdout)
            .trim()
            .starts_with("hz-kernel "),
        "unexpected --version output: {:?}",
        String::from_utf8_lossy(&output.stdout)
    );
}
