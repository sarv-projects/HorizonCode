//! HorizonCode trust kernel — NDJSON stdio server.
//!
//! Usage:
//!   hz-kernel [--state-dir <path>]         serve NDJSON on stdio
//!   hz-kernel --selftest [--state-dir <p>] run self checks, exit 0/1
//!   hz-kernel --version
//!
//! State dir defaults to $HZ_STATE_DIR, then ~/.hzcode/kernel.

mod canon;
mod eventlog;
mod guard;
mod permm;
mod protocol;
mod receipts;
mod time;

use std::io::{BufRead, BufWriter, Write};
use std::path::{Path, PathBuf};

use serde_json::{json, Value};
use uuid::Uuid;

use protocol::{Kernel, VERSION};

fn main() {
    std::process::exit(run());
}

fn run() -> i32 {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let mut state_dir: Option<PathBuf> = None;
    let mut selftest = false;

    let mut i = 0;
    while i < args.len() {
        let arg = args[i].as_str();
        match arg {
            "--version" | "-V" => {
                println!("hz-kernel {}", VERSION);
                return 0;
            }
            "--help" | "-h" => {
                print_help();
                return 0;
            }
            "--selftest" => selftest = true,
            "--state-dir" => {
                i += 1;
                match args.get(i) {
                    Some(path) => state_dir = Some(PathBuf::from(path)),
                    None => {
                        eprintln!("error: --state-dir requires a value");
                        return 2;
                    }
                }
            }
            other if other.starts_with("--state-dir=") => {
                state_dir = Some(PathBuf::from(&other["--state-dir=".len()..]));
            }
            other => {
                eprintln!("error: unknown argument: {}", other);
                print_help();
                return 2;
            }
        }
        i += 1;
    }

    let dir = state_dir.unwrap_or_else(default_state_dir);
    if let Err(e) = std::fs::create_dir_all(&dir) {
        eprintln!("error: cannot create state dir {}: {}", dir.display(), e);
        return 2;
    }
    // Event payloads and receipts are not world-readable material.
    permm::private_dir(&dir);

    // A present-but-malformed policy refuses service: serving it would mean
    // silently dropping rules (a dropped `deny` is a fail-open).
    if let Err(e) = guard::validate_policy(&dir) {
        eprintln!("error: {}", e);
        return 2;
    }

    // Keyed anchors: HZ_ANCHOR_KEY (hex) flips anchors to HMAC-SHA256; a
    // malformed key is refused outright rather than silently left unkeyed.
    let anchor = match eventlog::AnchorConfig::from_env() {
        Ok(anchor) => anchor,
        Err(e) => {
            eprintln!("error: {}", e);
            return 2;
        }
    };

    if selftest {
        return selftest_run(&dir, &anchor);
    }
    serve(&dir, anchor)
}

fn default_state_dir() -> PathBuf {
    if let Ok(dir) = std::env::var("HZ_STATE_DIR") {
        if !dir.trim().is_empty() {
            return PathBuf::from(dir);
        }
    }
    match std::env::var("HOME") {
        Ok(home) if !home.trim().is_empty() => PathBuf::from(home).join(".hzcode").join("kernel"),
        _ => PathBuf::from(".hzcode").join("kernel"),
    }
}

fn print_help() {
    println!("hz-kernel {} — HorizonCode trust kernel", VERSION);
    println!("usage: hz-kernel [--state-dir <path>] [--selftest] [--version]");
    println!("env:   HZ_ANCHOR_KEY=<hex>             keyed HMAC-SHA256 chain anchors");
    println!("       HZ_ACCEPT_LEGACY_ANCHORS=1      accept legacy anchors while keyed");
}

/// NDJSON loop: one response line per request, flushed immediately.
fn serve(dir: &Path, anchor: eventlog::AnchorConfig) -> i32 {
    let kernel = Kernel::new_with_anchor(dir, anchor);
    let stdin = std::io::stdin();
    let mut out = BufWriter::new(std::io::stdout().lock());

    for line in stdin.lock().lines() {
        let line = match line {
            Ok(line) => line,
            Err(e) => {
                eprintln!("error: cannot read stdin: {}", e);
                return 1;
            }
        };
        if line.trim().is_empty() {
            continue;
        }
        let response = match serde_json::from_str::<Value>(&line) {
            Ok(request) => kernel.handle(&request),
            Err(e) => canon::error_response(Value::Null, &format!("malformed request line: {}", e)),
        };
        let _ = serde_json::to_writer(&mut out, &response);
        let _ = out.write_all(b"\n");
        let _ = out.flush();
    }
    0
}

/* --------------------------------- selftest --------------------------------- */

struct Checks {
    total: u32,
    failures: u32,
}

impl Checks {
    fn new() -> Self {
        Checks {
            total: 0,
            failures: 0,
        }
    }

    fn check(&mut self, label: &str, ok: bool) {
        self.total += 1;
        if ok {
            println!("OK   {}", label);
        } else {
            println!("FAIL {}", label);
            self.failures += 1;
        }
    }
}

fn call(kernel: &Kernel, method: &str, params: Value) -> Result<Value, String> {
    let request = json!({ "id": 1, "method": method, "params": params });
    let response = kernel.handle(&request);
    if let Some(message) = response
        .get("error")
        .and_then(|e| e.get("message"))
        .and_then(|m| m.as_str())
    {
        return Err(format!("{} failed: {}", method, message));
    }
    response
        .get("result")
        .cloned()
        .ok_or_else(|| format!("{} returned no result", method))
}

fn selftest_run(dir: &Path, anchor: &eventlog::AnchorConfig) -> i32 {
    // Hermetic scratch: every invocation works in its own unique subdirectory
    // and removes it afterwards, so repeating the selftest — or running it
    // against a state dir that already holds chains, including a previous
    // run's keyed or unkeyed leftovers — can never collide with live state.
    // (Found in integrator verification: a second bare run against the default
    // state dir failed half the checks on the first run's stale scratch.)
    let scratch = dir.join(format!("selftest-{}", Uuid::new_v4()));
    let kernel = Kernel::new_with_anchor(&scratch, anchor.clone());
    let stream = "session:selftest";
    let mut checks = Checks::new();

    // 1. ping
    let ping = call(&kernel, "ping", json!({}));
    checks.check(
        "ping",
        matches!(&ping, Ok(v) if v.get("version").and_then(|x| x.as_str()) == Some(VERSION)),
    );

    // 2. three appends, chained and sequenced
    let mut appended: Vec<Value> = Vec::new();
    for (i, event_type) in ["session.start", "message.start", "session.end"]
        .iter()
        .enumerate()
    {
        let seed = json!({
            "id": Uuid::new_v4().to_string(),
            "ts": time::now_iso(),
            "stream": stream,
            "type": event_type,
            "actor": { "kind": "system", "id": "selftest" },
            "payload": { "index": i, "ok": true },
        });
        match call(&kernel, "log.append", json!({ "stream": stream, "event": seed })) {
            Ok(envelope) => {
                let seq_ok = envelope.get("seq").and_then(|v| v.as_u64()) == Some(appended.len() as u64 + 1);
                let hash_ok = envelope
                    .get("hash")
                    .and_then(|v| v.as_str())
                    .map(canon::is_hash)
                    .unwrap_or(false);
                let link_ok = match (appended.last(), envelope.get("prevHash")) {
                    (None, Some(Value::Null)) => true,
                    (Some(prev), Some(Value::String(prev_hash))) => {
                        prev.get("hash").and_then(|v| v.as_str()) == Some(prev_hash.as_str())
                    }
                    _ => false,
                };
                checks.check(
                    &format!("log.append seq={}", appended.len() + 1),
                    seq_ok && hash_ok && link_ok,
                );
                appended.push(envelope);
            }
            Err(e) => {
                checks.check(&format!("log.append seq={}", appended.len() + 1), false);
                eprintln!("selftest: {}", e);
            }
        }
    }

    // 3. verify the event chain
    match call(&kernel, "log.verify", json!({ "stream": stream })) {
        Ok(report) => {
            let ok = report.get("ok").and_then(|v| v.as_bool()) == Some(true);
            let count = report.get("count").and_then(|v| v.as_u64()).unwrap_or(0);
            checks.check(&format!("log.verify ok count={}", count), ok && count >= 3);
        }
        Err(e) => {
            checks.check("log.verify", false);
            eprintln!("selftest: {}", e);
        }
    }

    // 4. read back from seq 2
    match call(&kernel, "log.read", json!({ "stream": stream, "fromSeq": 2, "limit": 2 })) {
        Ok(result) => {
            let events = result.get("events").and_then(|v| v.as_array());
            let ok = events
                .map(|list| {
                    list.len() == 2 && list[0].get("seq").and_then(|v| v.as_u64()) == Some(2)
                })
                .unwrap_or(false);
            checks.check("log.read fromSeq=2 limit=2", ok);
        }
        Err(e) => {
            checks.check("log.read fromSeq=2 limit=2", false);
            eprintln!("selftest: {}", e);
        }
    }

    // 5. two receipts, chained
    let mut last_receipt_hash: Option<String> = None;
    for i in 0..2 {
        let input = json!({
            "action": "tool.execute",
            "tool": "selftest",
            "argsDigest": canon::sha256_hex(&format!("{{\"i\":{}}}", i)),
            "resultDigest": canon::sha256_hex("ok"),
        });
        match call(&kernel, "receipt.issue", input) {
            Ok(receipt) => {
                let hash_ok = receipt
                    .get("hash")
                    .and_then(|v| v.as_str())
                    .map(canon::is_hash)
                    .unwrap_or(false);
                let link_ok = match (&last_receipt_hash, receipt.get("prevHash")) {
                    (None, Some(Value::Null)) => true,
                    (Some(prev), Some(Value::String(prev_hash))) => prev == prev_hash,
                    _ => false,
                };
                let seq = receipt.get("seq").and_then(|v| v.as_u64()).unwrap_or(0);
                checks.check(&format!("receipt.issue seq={}", seq), hash_ok && link_ok);
                last_receipt_hash = receipt
                    .get("hash")
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string());
            }
            Err(e) => {
                checks.check(&format!("receipt.issue #{}", i + 1), false);
                eprintln!("selftest: {}", e);
            }
        }
    }

    // 6. verify the receipt chain
    match call(&kernel, "receipt.verify", json!({})) {
        Ok(report) => {
            let ok = report.get("ok").and_then(|v| v.as_bool()) == Some(true);
            let count = report.get("count").and_then(|v| v.as_u64()).unwrap_or(0);
            checks.check(&format!("receipt.verify ok count={}", count), ok && count >= 2);
        }
        Err(e) => {
            checks.check("receipt.verify", false);
            eprintln!("selftest: {}", e);
        }
    }

    // 7. guard policy: workspace write allowed, shell asks
    let workspace_write = call(
        &kernel,
        "guard.check",
        json!({ "action": { "kind": "fs.write", "target": "/tmp/hz-kernel-selftest/f" }, "scope": "workspace" }),
    );
    checks.check(
        "guard.check fs.write workspace -> allow",
        matches!(&workspace_write, Ok(d) if d.get("decision").and_then(|v| v.as_str()) == Some("allow")),
    );
    let shell_ask = call(
        &kernel,
        "guard.check",
        json!({ "action": { "kind": "shell.exec", "target": "echo hi" }, "scope": "workspace" }),
    );
    checks.check(
        "guard.check shell.exec -> ask",
        matches!(&shell_ask, Ok(d) if d.get("decision").and_then(|v| v.as_str()) == Some("ask")),
    );

    // 8. lease grants allow for a matching shell command
    match call(
        &kernel,
        "guard.lease",
        json!({ "kind": "shell.exec", "pattern": "echo *", "ttlMs": 60_000 }),
    ) {
        Ok(lease) => {
            let lease_id = lease
                .get("leaseId")
                .and_then(|v| v.as_str())
                .unwrap_or_default()
                .to_string();
            let decision = call(
                &kernel,
                "guard.check",
                json!({
                    "action": { "kind": "shell.exec", "target": "echo hi" },
                    "scope": "workspace",
                    "leases": [lease],
                }),
            );
            let ok = matches!(&decision, Ok(d)
                if d.get("decision").and_then(|v| v.as_str()) == Some("allow")
                    && d.get("leaseId").and_then(|v| v.as_str()) == Some(lease_id.as_str()));
            checks.check("guard.lease echo * -> allow", ok && !lease_id.is_empty());
        }
        Err(e) => {
            checks.check("guard.lease echo * -> allow", false);
            eprintln!("selftest: {}", e);
        }
    }

    // 9. protocol robustness: unknown method and malformed request never crash
    let unknown = kernel.handle(&json!({ "id": 7, "method": "nope", "params": {} }));
    checks.check(
        "unknown method -> error",
        unknown.get("error").and_then(|e| e.get("message")).is_some()
            && unknown.get("id").and_then(|v| v.as_u64()) == Some(7),
    );
    let malformed = kernel.handle(&json!("not a request"));
    checks.check(
        "malformed request -> error id null",
        malformed.get("error").is_some() && malformed.get("id") == Some(&Value::Null),
    );

    // 10. keyed anchors: anchor digest = HMAC-SHA256(key, record preimage);
    // a legacy (unkeyed) anchor fails closed unless legacy acceptance is asked for.
    let keyed_dir = scratch.join("selftest-keyed");
    let key = b"hz-selftest-anchor-key-000000000".to_vec();
    let keyed = Kernel::new_with_anchor(&keyed_dir, eventlog::AnchorConfig::keyed(key.clone()));
    let keyed_stream = "session:selftest-keyed";
    match call(
        &keyed,
        "log.append",
        json!({ "stream": keyed_stream, "event": { "type": "session.start", "payload": { "keyed": true } } }),
    ) {
        Ok(event) => {
            let event_hash = event
                .get("hash")
                .and_then(|v| v.as_str())
                .unwrap_or_default()
                .to_string();
            let expected = canon::anchor_digest(&canon::envelope_preimage(&event), Some(&key));
            let head = eventlog::read_head(&keyed_dir.join("events/session__selftest-keyed.jsonl"));
            checks.check(
                "keyed anchor is HMAC over the record preimage",
                matches!(&head, eventlog::HeadState::Present(1, digest) if digest == &expected && digest != &event_hash),
            );
            let verified = matches!(
                call(&keyed, "log.verify", json!({ "stream": keyed_stream })),
                Ok(report) if report.get("ok") == Some(&Value::Bool(true)) && report.get("count") == Some(&json!(1))
            );
            checks.check("keyed chain verifies", verified);

            // Rewrite the anchor into the legacy (unkeyed) shape: fail closed.
            let head_path = keyed_dir.join("events/session__selftest-keyed.jsonl.head");
            let legacy_body = serde_json::to_string(&json!({ "hash": event_hash, "seq": 1 }))
                .unwrap_or_default();
            let wrote = std::fs::write(&head_path, format!("{}\n", legacy_body)).is_ok();
            let refused = matches!(
                call(&keyed, "log.verify", json!({ "stream": keyed_stream })),
                Err(e) if e.contains("HZ_PRECONDITION_FAILED") && e.contains("legacy (unkeyed) anchor")
            );
            checks.check("legacy anchor refused while keyed", wrote && refused);

            let accepting = Kernel::new_with_anchor(
                &keyed_dir,
                eventlog::AnchorConfig {
                    key: Some(key.clone()),
                    accept_legacy: true,
                },
            );
            let accepted = matches!(
                call(&accepting, "log.verify", json!({ "stream": keyed_stream })),
                Ok(report) if report.get("ok") == Some(&Value::Bool(true))
            );
            checks.check("legacy acceptance opt-in verifies", accepted);
        }
        Err(e) => {
            for label in [
                "keyed anchor is HMAC over the record preimage",
                "keyed chain verifies",
                "legacy anchor refused while keyed",
                "legacy acceptance opt-in verifies",
            ] {
                checks.check(label, false);
            }
            eprintln!("selftest: {}", e);
        }
    }

    let _ = std::fs::remove_dir_all(&scratch);
    if checks.failures == 0 {
        println!("SELFTEST OK ({} checks)", checks.total);
        0
    } else {
        println!("SELFTEST FAILED ({} of {} checks)", checks.failures, checks.total);
        1
    }
}
