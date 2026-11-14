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
//!                       tail truncation vs the `.head` anchor, rewritten/corrupt anchor,
//!                       keyed (HMAC) anchors, legacy-anchor refusal + opt-in
//!   - concurrency     : 4 separate processes × 5 appends on one stream
//!   - receipts        : issue/verify/tamper, empty and absent file
//!   - guard           : default policy matrix, policy.json override + deny precedence,
//!                       docs/11 R1 ask-over-allow precedence, lease matching
//!                       (exact / prefix `*` / `*`), expiry, scope `*`
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

/*
 * P0 R170 kernel-owner admission tests. These deliberately open two real
 * independent hz-kernel processes against one state directory.
 */
#[test]
fn owner_effects_serialise_and_block_unknown_across_processes() {
    let state = TempDir::new("owner-fence");
    let sandbox = TempDir::new("owner-workspace");
    fs::write(sandbox.path().join("file.txt"), b"original").unwrap();
    let mut first = Kernel::start(state.path());
    let mut second = Kernel::start(state.path());

    let settled = first.ok("effect.execute", json!({
        "effectId": "owner-one", "sandboxRoot": sandbox.path(),
        "dispatch": { "kind": "fs.write", "spec": { "path": "file.txt", "text": "first" } }
    }));
    assert_eq!(settled["verdict"], "settled");
    assert_eq!(first.ok("effect.owner.status", json!({}))["blocked"], false);
    assert_eq!(second.ok("effect.owner.status", json!({}))["unresolved"], 0);

    // An edit error after durable prepare is conservatively UNKNOWN: the
    // owner cannot establish that a future mutation is safe from one caller.
    let failed = first.err("effect.execute", json!({
        "effectId": "owner-broken", "sandboxRoot": sandbox.path(),
        "dispatch": { "kind": "fs.edit", "spec": {
            "path": "file.txt", "oldString": "missing", "newString": "hijack"
        } }
    }));
    assert!(failed.contains("oldString"), "{failed}");
    let events = first.ok("log.read", json!({"stream": "owner:effects"}));
    let last = events["events"].as_array().unwrap().last().unwrap();
    assert_eq!(last["type"], "owner.unknown");
    assert_eq!(last["payload"]["details"]["terminal"], "unknown");
    assert_eq!(first.ok("effect.owner.status", json!({}))["blocked"], true);
    let refused = second.err("effect.execute", json!({
        "effectId": "owner-two", "sandboxRoot": sandbox.path(),
        "dispatch": { "kind": "fs.write", "spec": { "path": "file.txt", "text": "second" } }
    }));
    assert!(refused.contains("HZ_PRECONDITION_FAILED"), "{refused}");
    assert!(refused.contains("UNKNOWN"), "{refused}");
    assert_eq!(fs::read(sandbox.path().join("file.txt")).unwrap(), b"first");
    assert_eq!(second.ok("effect.owner.verify", json!({}))["ok"], true);
}

#[test]
fn raw_effect_execute_never_mutates_its_own_kernel_state_through_alias_or_rename() {
    let ws = TempDir::new("owner-protected-ws");
    let state = ws.path().join(".hzcode").join("kernel");
    fs::create_dir_all(&state).unwrap();
    let mut kernel = Kernel::start(&state);
    let original = fs::read(state.join("owner-admission.lock")).unwrap_or_default();
    let refused = kernel.err("effect.execute", json!({
        "effectId": "owner-state-write", "sandboxRoot": ws.path(),
        "dispatch": { "kind": "fs.write", "spec": {
            "path": ".hzcode/kernel/owner-admission.lock", "text": "OVERWRITE"
        }}
    }));
    assert!(refused.contains("kernel-state-protected"), "{refused}");
    assert_eq!(fs::read(state.join("owner-admission.lock")).unwrap_or_default(), original);

    #[cfg(unix)]
    {
        let alias = ws.path().join("alias-to-kernel");
        std::os::unix::fs::symlink(&state, &alias).unwrap();
        let denied = kernel.err("effect.execute", json!({
            "effectId": "owner-state-symlink", "sandboxRoot": ws.path(),
            "dispatch": { "kind": "fs.write", "spec": {
                "path": "alias-to-kernel/owner-admission.lock", "text": "OVERWRITE"
            }}
        }));
        assert!(denied.contains("kernel-state-protected"), "{denied}");
    }

    fs::write(ws.path().join("safe.txt"), "safe").unwrap();
    let denied = kernel.err("effect.execute", json!({
        "effectId": "owner-state-rename", "sandboxRoot": ws.path(),
        "dispatch": { "kind": "fs.rename", "spec": {
            "from": "safe.txt", "to": ".hzcode/kernel/owner-admission.lock"
        }}
    }));
    assert!(denied.contains("kernel-state-protected"), "{denied}");
    assert_eq!(fs::read(ws.path().join("safe.txt")).unwrap(), b"safe");
}

#[test]
fn unconfined_shell_interpreter_is_explicitly_refused_before_spawn() {
    let state = TempDir::new("owner-shell-unconfined");
    let ws = TempDir::new("owner-shell-reject");
    let mut k = Kernel::start(state.path());
    let refused = k.err("effect.execute", json!({
        "effectId": "shell-untrusted", "sandboxRoot": ws.path(),
        "dispatch": { "kind": "shell.exec", "spec": {
            "argv": ["sh", "-c", "printf UNSAFE > denied.txt"]
        }}
    }));
    assert!(refused.contains("HZ_PRECONDITION_FAILED"), "{refused}");
    assert!(refused.contains("unconfined"), "{refused}");
    assert!(!ws.path().join("denied.txt").exists());
    assert_eq!(k.ok("effect.owner.status", json!({}))["unresolved"], 0);
}

#[test]
fn bound_kernel_workspace_cannot_be_widened_by_raw_sandbox_root_argument() {
    let state = TempDir::new("kernel-workspace-binding-state");
    let workspace = TempDir::new("kernel-workspace-binding-ws");
    let outside = TempDir::new("kernel-workspace-binding-elsewhere");
    let mut kernel = Kernel::start_with_env(state.path(), &[(
        "HZ_KERNEL_WORKSPACE_ROOT", workspace.path().to_str().unwrap(),
    )]);
    // A workspace binding without the private parent fd is NOT a grant-minting
    // authority, even in the standalone compatibility transport.
    let no_control = kernel.err("guard.lease", json!({
        "kind": "shell.exec", "pattern": "echo forged", "ttlMs": 60000
    }));
    assert!(no_control.contains("private parent control channel"), "{no_control}");
    let no_receipt = kernel.err("receipt.issue", json!({
        "action": "tool.execute", "tool": "shell",
        "argsDigest": "0".repeat(64), "resultDigest": "1".repeat(64),
    }));
    assert!(no_receipt.contains("private parent control channel"), "{no_receipt}");
    assert_eq!(kernel.ok("receipt.verify", json!({}))["count"], 0);
    let denied = kernel.err("effect.execute", json!({
        "effectId": "root-widen", "sandboxRoot": outside.path(),
        "dispatch": {"kind": "fs.write", "spec": {"path": "outside.txt", "text": "NO"}}
    }));
    assert!(denied.contains("kernel-bound workspace root"), "{denied}");
    assert!(!outside.path().join("outside.txt").exists());
    assert_eq!(kernel.ok("effect.owner.status", json!({}))["events"], 0);
    let yes = kernel.ok("effect.execute", json!({
        "effectId": "root-widen", "sandboxRoot": workspace.path(),
        "dispatch": {"kind": "fs.write", "spec": {"path": "inside.txt", "text": "YES"}}
    }));
    assert_eq!(yes["ownerLogSettled"], true);
    assert_eq!(fs::read(workspace.path().join("inside.txt")).unwrap(), b"YES");
}

#[test]
fn owner_direct_file_effect_respects_guard_deny_and_ask_before_prepare() {
    let state = TempDir::new("owner-guard-file-policy");
    let ws = TempDir::new("owner-guard-file-workspace");
    fs::write(state.path().join("policy.json"), serde_json::to_string(&json!([
        { "kind": "fs.write", "scope": "workspace", "decision": "deny" },
        { "kind": "fs.read", "scope": "workspace", "decision": "allow" }
    ])).unwrap()).unwrap();
    let mut kernel = Kernel::start(state.path());
    let denied = kernel.err("effect.execute", json!({
        "effectId": "deny-file", "sandboxRoot": ws.path(),
        "dispatch": {"kind": "fs.write", "spec": {"path": "no.txt", "text": "NEVER"}}
    }));
    assert!(denied.contains("Guard"), "{denied}");
    assert!(denied.contains("deny"), "{denied}");
    assert!(!ws.path().join("no.txt").exists());
    assert_eq!(kernel.ok("effect.owner.status", json!({}))["events"], 0);

    fs::write(state.path().join("policy.json"), serde_json::to_string(&json!([
        { "kind": "fs.write", "scope": "workspace", "decision": "ask" }
    ])).unwrap()).unwrap();
    let asked = kernel.err("effect.execute", json!({
        "effectId": "ask-file", "sandboxRoot": ws.path(),
        "dispatch": {"kind": "fs.write", "spec": {"path": "no.txt", "text": "NEVER"}}
    }));
    assert!(asked.contains("Guard"), "{asked}");
    assert!(asked.contains("ask"), "{asked}");
    assert!(!ws.path().join("no.txt").exists());
    assert_eq!(kernel.ok("effect.owner.status", json!({}))["events"], 0);

    // A previously refused effect ID never creates an OwnerLog admission.
    fs::write(state.path().join("policy.json"), serde_json::to_string(&json!([
        { "kind": "fs.write", "scope": "workspace", "decision": "allow" }
    ])).unwrap()).unwrap();
    let accepted = kernel.ok("effect.execute", json!({
        "effectId": "ask-file", "sandboxRoot": ws.path(),
        "dispatch": {"kind": "fs.write", "spec": {"path": "no.txt", "text": "YES"}}
    }));
    assert_eq!(accepted["ownerLogSettled"], true);
    assert_eq!(fs::read(ws.path().join("no.txt")).unwrap(), b"YES");
}

#[test]
fn owner_rename_checks_both_endpoints_against_guard_under_same_fence() {
    let state = TempDir::new("owner-guard-rename");
    let ws = TempDir::new("owner-guard-rename-workspace");
    fs::write(ws.path().join("from.txt"), b"original").unwrap();
    // The policy class is fs.write for BOTH rename endpoints, not a made-up
    // "fs.rename" kind that could fail open outside the Guard vocabulary.
    fs::write(state.path().join("policy.json"), serde_json::to_string(&json!([
        { "kind": "fs.write", "scope": "workspace", "decision": "ask" }
    ])).unwrap()).unwrap();
    let mut kernel = Kernel::start(state.path());
    let refused = kernel.err("effect.execute", json!({
        "effectId": "rename-ask", "sandboxRoot": ws.path(),
        "dispatch": {"kind": "fs.rename", "spec": {
            "from": "from.txt", "to": "to.txt"
        }}
    }));
    assert!(refused.contains("Guard"), "{refused}");
    assert!(ws.path().join("from.txt").exists());
    assert!(!ws.path().join("to.txt").exists());
    assert_eq!(kernel.ok("effect.owner.status", json!({}))["events"], 0);
    let source = kernel.ok("guard.lease", json!({
        "kind": "fs.write",
        "pattern": ws.path().join("from.txt").to_string_lossy(),
        "ttlMs": 60000,
    }));
    let destination = kernel.ok("guard.lease", json!({
        "kind": "fs.write",
        "pattern": ws.path().join("to.txt").to_string_lossy(),
        "ttlMs": 60000,
    }));
    let settled = kernel.ok("effect.execute", json!({
        "effectId": "rename-ask", "sandboxRoot": ws.path(),
        "dispatch": {"kind": "fs.rename", "spec": {
            "from": "from.txt", "to": "to.txt"
        }}
    }));
    assert_eq!(settled["ownerLogSettled"], true);
    assert_eq!(settled["ownerGuardLeaseIds"][0], source["leaseId"]);
    assert_eq!(settled["ownerGuardLeaseIds"][1], destination["leaseId"]);
    assert_eq!(settled["ownerGuardLeaseId"], destination["leaseId"]);
    assert_eq!(fs::read(ws.path().join("to.txt")).unwrap(), b"original");
    let events = kernel.ok("log.read", json!({"stream": "owner:effects"}));
    assert_eq!(events["events"][0]["payload"]["details"]["guardLeaseIds"][0], source["leaseId"]);
    assert_eq!(events["events"][2]["payload"]["details"]["guardLeaseIds"][1], destination["leaseId"]);
    assert_eq!(kernel.ok("effect.owner.verify", json!({}))["ok"], true);
}

#[test]
fn owner_shell_guard_requires_authorization_even_for_output_only_argv() {
    let state = TempDir::new("owner-guard-shell");
    let ws = TempDir::new("owner-guard-shell-workspace");
    let mut kernel = Kernel::start(state.path());
    let refused = kernel.err("effect.execute", json!({
        "effectId": "shell-needs-guard", "sandboxRoot": ws.path(),
        "dispatch": {"kind": "shell.exec", "spec": {"argv": ["echo", "hello"]}}
    }));
    assert!(refused.contains("Guard"), "{refused}");
    assert!(refused.contains("ask"), "{refused}");
    assert_eq!(kernel.ok("effect.owner.status", json!({}))["events"], 0);
    let minted = kernel.ok("guard.lease", json!({
        "kind": "shell.exec", "pattern": "echo hello", "ttlMs": 60000
    }));
    let allowed = kernel.ok("effect.execute", json!({
        "effectId": "shell-needs-guard", "sandboxRoot": ws.path(),
        "dispatch": {"kind": "shell.exec", "spec": {"argv": ["echo", "hello"]}}
    }));
    assert_eq!(allowed["ownerLogSettled"], true);
    assert_eq!(allowed["ownerGuardLeaseId"], minted["leaseId"]);
    let receipts_file = fs::read_to_string(state.path().join("receipts.jsonl")).unwrap();
    let issued: Value = serde_json::from_str(receipts_file.lines().last().unwrap()).unwrap();
    assert_eq!(issued["leaseId"], minted["leaseId"]);
    let events = kernel.ok("log.read", json!({"stream": "owner:effects"}));
    assert_eq!(events["events"][0]["payload"]["details"]["guardDecision"], "allow");
    assert_eq!(events["events"][0]["payload"]["details"]["guardLeaseId"], minted["leaseId"]);
    assert_eq!(kernel.ok("effect.owner.verify", json!({}))["ok"], true);
}

#[test]
fn owner_shell_receipt_binds_observed_streams_and_does_not_poison_next_effect() {
    let state = TempDir::new("owner-shell");
    let sandbox = TempDir::new("owner-shell-workspace");
    let mut kernel = Kernel::start(state.path());
    kernel.ok("guard.lease", json!({
        "kind": "shell.exec", "pattern": "echo hello", "ttlMs": 60_000
    }));
    let shell = kernel.ok("effect.execute", json!({
        "effectId": "shell-one", "sandboxRoot": sandbox.path(),
        "dispatch": { "kind": "shell.exec", "spec": { "argv": ["echo", "hello"] } }
    }));
    assert_eq!(shell["verdict"], "settled");
    assert_eq!(shell["ownerLogSettled"], true);
    assert!(shell["ownerReceiptId"].as_str().is_some());
    assert!(shell["ownerResultDigest"].as_str().is_some());
    let write = kernel.ok("effect.execute", json!({
        "effectId": "shell-followup", "sandboxRoot": sandbox.path(),
        "dispatch": { "kind": "fs.write", "spec": { "path": "after.txt", "text": "okay" } }
    }));
    assert_eq!(write["ownerLogSettled"], true);
    assert_eq!(kernel.ok("effect.owner.verify", json!({}))["receiptsVerified"], 2);
    let events = kernel.ok("log.read", json!({"stream": "owner:effects"}));
    assert_eq!(events["events"][2]["payload"]["details"]["terminal"], "succeeded");
    let replay = kernel.ok("effect.owner.postimage.verify", json!({}));
    assert_eq!(replay["ok"], false, "{replay}");
    assert_eq!(replay["unsupportedEffects"], 1);
    assert_eq!(replay["checked"], 1);
}

#[test]
fn owner_terminal_rc7_distinguishes_settled_failure_from_unknown() {
    let state = TempDir::new("owner-terminal-rc7");
    let sandbox = TempDir::new("owner-terminal-rc7-workspace");
    let mut kernel = Kernel::start(state.path());
    kernel.ok("guard.lease", json!({
        "kind": "shell.exec", "pattern": "false", "ttlMs": 60_000
    }));
    let process = kernel.ok("effect.execute", json!({
        "effectId": "shell-nonzero", "sandboxRoot": sandbox.path(),
        "dispatch": { "kind": "shell.exec", "spec": { "argv": ["false"] } }
    }));
    // A nonzero process still ran and produced an independently observed
    // receipt. Settlement and terminal success are distinct dimensions.
    assert_eq!(process["verdict"], "settled");
    assert_eq!(process["exitCode"], 1);
    let events = kernel.ok("log.read", json!({"stream": "owner:effects"}));
    assert_eq!(events["events"][2]["type"], "owner.settled");
    assert_eq!(events["events"][2]["payload"]["details"]["terminal"], "failed");
    assert_eq!(kernel.ok("effect.owner.verify", json!({}))["ok"], true);
}

#[test]
fn mixed_case_dispatch_cannot_evade_kernel_owner_fence() {
    let state = TempDir::new("owner-case");
    let sandbox = TempDir::new("owner-case-workspace");
    let mut a = Kernel::start(state.path());
    let mut b = Kernel::start(state.path());
    let first = a.ok("effect.execute", json!({
        "effectId": "case-write", "sandboxRoot": sandbox.path(),
        "dispatch": { "kind": "FS.WRITE", "spec": { "path": "case.txt", "text": "FIRST" } }
    }));
    assert_eq!(first["ownerLogSettled"], true, "mixed-case write must be owner-recorded");
    assert_eq!(a.ok("effect.owner.status", json!({}))["events"], 3);
    let again = b.err("effect.execute", json!({
        "effectId": "case-write", "sandboxRoot": sandbox.path(),
        "dispatch": { "kind": "Fs.WrItE", "spec": { "path": "case.txt", "text": "SECOND" } }
    }));
    assert!(again.contains("duplicate EffectHost effectId"), "{again}");
    assert_eq!(fs::read(sandbox.path().join("case.txt")).unwrap(), b"FIRST");
}

#[test]
fn owner_effect_id_replay_cannot_write_twice() {
    let state = TempDir::new("owner-replay");
    let sandbox = TempDir::new("owner-replay-sandbox");
    let mut a = Kernel::start(state.path());
    let mut b = Kernel::start(state.path());
    let first = a.ok("effect.execute", json!({
        "effectId": "same-id", "sandboxRoot": sandbox.path(),
        "dispatch": { "kind": "fs.write", "spec": { "path": "x", "text": "FIRST" } }
    }));
    assert_eq!(first["verdict"], "settled");
    let second = b.err("effect.execute", json!({
        "effectId": "same-id", "sandboxRoot": sandbox.path(),
        "dispatch": { "kind": "fs.write", "spec": { "path": "x", "text": "SECOND" } }
    }));
    assert!(second.contains("duplicate EffectHost effectId"), "{second}");
    assert_eq!(fs::read(sandbox.path().join("x")).unwrap(), b"FIRST");
    assert_eq!(b.ok("effect.owner.status", json!({}))["events"], 3);
}

#[test]
fn tampered_owner_chain_refuses_inspection_and_mutation() {
    let state = TempDir::new("owner-tamper");
    let sandbox = TempDir::new("owner-tamper-sandbox");
    let mut a = Kernel::start(state.path());
    a.ok("effect.execute", json!({
        "effectId": "tamper-first", "sandboxRoot": sandbox.path(),
        "dispatch": { "kind": "fs.write", "spec": { "path": "x", "text": "FIRST" } }
    }));
    let owner_log = state.path().join("events").join("owner__effects.jsonl");
    let original = fs::read_to_string(&owner_log).unwrap();
    fs::write(&owner_log, original.replace("owner.prepare", "owner.prepareX")).unwrap();
    let mut b = Kernel::start(state.path());
    let refusal = b.err("effect.owner.status", json!({}));
    assert!(refusal.contains("verification failed"), "{refusal}");
    let blocked = b.err("effect.execute", json!({
        "effectId": "tamper-second", "sandboxRoot": sandbox.path(),
        "dispatch": { "kind": "fs.write", "spec": { "path": "x", "text": "SECOND" } }
    }));
    assert!(blocked.contains("verification failed"), "{blocked}");
    assert_eq!(fs::read(sandbox.path().join("x")).unwrap(), b"FIRST");
}

#[test]
fn owner_verification_cross_checks_receipt_identity_sidecar_even_when_receipt_chain_is_valid() {
    let state = TempDir::new("owner-receipt-link");
    let sandbox = TempDir::new("owner-receipt-link-workspace");
    let mut a = Kernel::start(state.path());
    a.ok("effect.execute", json!({
        "effectId": "receipt-linked", "sandboxRoot": sandbox.path(),
        "dispatch": {"kind": "fs.write", "spec": {"path": "a.txt", "text": "ORIGINAL"}}
    }));
    // Receipt.effectId is an additive sidecar outside RECEIPT_FIELDS/hash.
    // A valid receipt hash chain alone cannot prove the owner settlement points
    // to the right effect; bind the two ledgers independently as well.
    let file = state.path().join("receipts.jsonl");
    let original = fs::read_to_string(&file).unwrap();
    assert!(original.contains("receipt-linked"));
    fs::write(&file, original.replace("receipt-linked", "receipt-forged")).unwrap();
    let mut b = Kernel::start(state.path());
    assert_eq!(b.ok("receipt.verify", json!({}))["ok"], true);
    let message = b.err("effect.owner.verify", json!({}));
    assert!(message.contains("owner receipt linkage"), "{message}");
    let blocked = b.err("effect.execute", json!({
        "effectId": "after-receipt-tamper", "sandboxRoot": sandbox.path(),
        "dispatch": {"kind": "fs.write", "spec": {"path": "a.txt", "text": "WRONG"}}
    }));
    assert!(blocked.contains("owner receipt linkage"), "{blocked}");
    assert_eq!(fs::read(sandbox.path().join("a.txt")).unwrap(), b"ORIGINAL");
}

#[test]
fn owner_crash_after_durable_prepare_blocks_replay_in_new_kernel_process() {
    let state = TempDir::new("owner-crash-prepared");
    let sandbox = TempDir::new("owner-crash-workspace");
    // A debug-only kernel fault injection exits immediately AFTER fsynced
    // prepare, BEFORE execute/observe/settle. No successful response exists.
    let mut crashed = Kernel::start_with_env(
        state.path(),
        &[("HZ_EFFECT_OWNER_FAULT_AFTER_PREPARE", "1")],
    );
    let request = json!({
        "id": 333, "method": "effect.execute",
        "params": {
            "effectId": "crashed-before-execute", "sandboxRoot": sandbox.path(),
            "dispatch": {"kind": "fs.write", "spec": {"path": "never.txt", "text": "NO"}}
        }
    });
    crashed.send_line(&request.to_string());
    let status = (0..100).find_map(|_| {
        let status = crashed.child.try_wait().expect("poll kernel process");
        if status.is_none() { std::thread::sleep(Duration::from_millis(20)); }
        status
    });
    if status.is_none() {
        let _ = crashed.child.kill();
        let _ = crashed.child.wait();
    }
    assert_eq!(
        status.and_then(|s| s.code()),
        Some(86),
        "fault-injected kernel should terminate without settlement",
    );
    assert!(!sandbox.path().join("never.txt").exists());

    let mut resumed = Kernel::start(state.path());
    let status = resumed.ok("effect.owner.status", json!({}));
    assert_eq!(status["blocked"], true);
    assert_eq!(status["unresolved"], 1);
    assert_eq!(resumed.ok("effect.owner.verify", json!({}))["ok"], true);
    let denied = resumed.err("effect.execute", json!({
        "effectId": "after-crash", "sandboxRoot": sandbox.path(),
        "dispatch": {"kind": "fs.write", "spec": {"path": "never.txt", "text": "NO"}}
    }));
    assert!(denied.contains("OwnerLog UNKNOWN"), "{denied}");
    assert!(!sandbox.path().join("never.txt").exists());
}

#[test]
fn owner_prepare_only_crash_can_be_recovered_without_reexecuting_effect() {
    let state = TempDir::new("owner-recover-safe");
    let sandbox = TempDir::new("owner-recover-workspace");
    let mut crashed = Kernel::start_with_env(
        state.path(),
        &[("HZ_EFFECT_OWNER_FAULT_AFTER_PREPARE", "1")],
    );
    crashed.send_line(&json!({
        "id": 1001, "method": "effect.execute", "params": {
            "effectId": "prepared-only", "sandboxRoot": sandbox.path(),
            "dispatch": { "kind": "fs.write", "spec": { "path": "new.txt", "text": "X" } }
        }
    }).to_string());
    let status = crashed.child.wait().expect("wait for debug crash");
    assert_eq!(status.code(), Some(86));
    assert!(!sandbox.path().join("new.txt").exists());

    let mut owner = Kernel::start(state.path());
    assert_eq!(owner.ok("effect.owner.status", json!({}))["blocked"], true);
    let released = owner.ok("effect.owner.recover", json!({"effectId": "prepared-only"}));
    assert_eq!(released["released"], true);
    assert_eq!(released["blocked"], false);
    let events = owner.ok("log.read", json!({"stream": "owner:effects"}));
    assert_eq!(events["events"][1]["type"], "owner.released");
    assert_eq!(events["events"][1]["payload"]["details"]["terminal"], "interrupted");
    assert_eq!(owner.ok("effect.owner.status", json!({}))["unresolved"], 0);
    assert_eq!(owner.ok("effect.owner.verify", json!({}))["ok"], true);
    // Recovery releases the fence; it does NOT permit reusing the old effectId.
    let replay = owner.err("effect.execute", json!({
        "effectId": "prepared-only", "sandboxRoot": sandbox.path(),
        "dispatch": { "kind": "fs.write", "spec": { "path": "new.txt", "text": "REPLAY" } }
    }));
    assert!(replay.contains("duplicate EffectHost effectId"), "{replay}");
    let next = owner.ok("effect.execute", json!({
        "effectId": "new-admission", "sandboxRoot": sandbox.path(),
        "dispatch": { "kind": "fs.write", "spec": { "path": "new.txt", "text": "SAFE" } }
    }));
    assert_eq!(next["verdict"], "settled");
    assert_eq!(fs::read(sandbox.path().join("new.txt")).unwrap(), b"SAFE");
}

#[test]
fn owner_crash_after_executing_fence_never_auto_releases() {
    let state = TempDir::new("owner-recover-unsafe");
    let sandbox = TempDir::new("owner-recover-unsafe-workspace");
    let mut crashed = Kernel::start_with_env(
        state.path(),
        &[("HZ_EFFECT_OWNER_FAULT_AFTER_EXECUTING", "1")],
    );
    crashed.send_line(&json!({
        "id": 1002, "method": "effect.execute", "params": {
            "effectId": "maybe-executed", "sandboxRoot": sandbox.path(),
            "dispatch": { "kind": "fs.write", "spec": { "path": "new.txt", "text": "X" } }
        }
    }).to_string());
    let status = crashed.child.wait().expect("wait for injected crash");
    assert_eq!(status.code(), Some(87));
    let mut owner = Kernel::start(state.path());
    let blocked = owner.ok("effect.owner.status", json!({}));
    assert_eq!(blocked["blocked"], true);
    let denial = owner.err("effect.owner.recover", json!({"effectId": "maybe-executed"}));
    assert!(denial.contains("execution may have started"), "{denial}");
    let mutation = owner.err("effect.execute", json!({
        "effectId": "next-effect", "sandboxRoot": sandbox.path(),
        "dispatch": { "kind": "fs.write", "spec": { "path": "new.txt", "text": "NOT_ALLOWED" } }
    }));
    assert!(mutation.contains("OwnerLog UNKNOWN"), "{mutation}");
    assert!(!sandbox.path().join("new.txt").exists());
}

#[test]
fn owner_preimage_pin_refuses_stale_edit_before_prepare_and_preserves_admission() {
    let state = TempDir::new("owner-preimage-pin");
    let sandbox = TempDir::new("owner-preimage-pin-workspace");
    fs::write(sandbox.path().join("src.txt"), b"before").unwrap();
    let mut k = Kernel::start(state.path());
    let refused = k.err("effect.execute", json!({
        "effectId": "stale-edit", "sandboxRoot": sandbox.path(),
        "dispatch": {"kind": "fs.edit", "spec": {
            "path": "src.txt", "oldString": "before", "newString": "after",
            "expectedPreimageDigest": "0000000000000000000000000000000000000000000000000000000000000000"
        }}
    }));
    assert!(refused.contains("preimage digest mismatch"), "{refused}");
    assert_eq!(k.ok("effect.owner.status", json!({}))["events"], 0);
    assert_eq!(fs::read(sandbox.path().join("src.txt")).unwrap(), b"before");
    let correct = sha256_bytes(b"before");
    let done = k.ok("effect.execute", json!({
        "effectId": "valid-edit", "sandboxRoot": sandbox.path(),
        "dispatch": {"kind": "fs.edit", "spec": {
            "path": "src.txt", "oldString": "before", "newString": "after",
            "expectedPreimageDigest": correct
        }}
    }));
    assert_eq!(done["ownerLogSettled"], true);
    assert_eq!(fs::read(sandbox.path().join("src.txt")).unwrap(), b"after");
}

#[test]
fn owner_postimage_replay_detects_external_mutation_without_rewriting_receipt_chain() {
    let state = TempDir::new("owner-replay-postimage");
    let ws = TempDir::new("owner-replay-postimage-workspace");
    let file = ws.path().join("tracked.txt");
    let mut writer = Kernel::start(state.path());
    let mut inspector = Kernel::start(state.path());

    writer.ok("effect.execute", json!({
        "effectId": "postimage-v1", "sandboxRoot": ws.path(),
        "dispatch": {"kind": "fs.write", "spec": {"path": "tracked.txt", "text": "first"}}
    }));
    writer.ok("effect.execute", json!({
        "effectId": "postimage-v2", "sandboxRoot": ws.path(),
        "dispatch": {"kind": "fs.write", "spec": {"path": "tracked.txt", "text": "second"}}
    }));
    // Verification compares the newest settled observation, not the
    // superseded first version (which is not recoverable from disk).
    let clean = inspector.ok("effect.owner.postimage.verify", json!({}));
    assert_eq!(clean["ok"], true, "{clean}");
    assert_eq!(clean["checked"], 1);
    assert_eq!(clean["legacyUnverifiable"], 0);
    assert_eq!(clean["scope"], "latest_settled_file_postimage_only");
    fs::write(&file, b"external tamper").unwrap();

    // Both cryptographic chains can still be valid; only independent disk
    // replay exposes a post-settlement change.
    assert_eq!(inspector.ok("effect.owner.verify", json!({}))["ok"], true);
    let stale = inspector.ok("effect.owner.postimage.verify", json!({}));
    assert_eq!(stale["ok"], false, "{stale}");
    assert_eq!(stale["mismatches"][0]["effectId"], "postimage-v2");
    assert_eq!(stale["mismatches"][0]["observedState"], "present");
    assert_ne!(
        stale["mismatches"][0]["expectedDigest"],
        stale["mismatches"][0]["observedDigest"]
    );
    assert_eq!(fs::read(&file).unwrap(), b"external tamper");
}

#[test]
fn owner_postimage_replay_tracks_delete_absence_and_both_rename_endpoints() {
    let state = TempDir::new("owner-replay-delete");
    let ws = TempDir::new("owner-replay-delete-workspace");
    let mut kernel = Kernel::start(state.path());
    fs::write(ws.path().join("source.txt"), b"original").unwrap();

    kernel.ok("effect.execute", json!({
        "effectId": "postimage-rename", "sandboxRoot": ws.path(),
        "dispatch": {"kind": "fs.rename", "spec": {"from": "source.txt", "to": "destination.txt"}}
    }));
    let clean = kernel.ok("effect.owner.postimage.verify", json!({}));
    assert_eq!(clean["ok"], true, "{clean}");
    assert_eq!(clean["checked"], 2); // source absent, destination present

    kernel.ok("effect.execute", json!({
        "effectId": "postimage-delete", "sandboxRoot": ws.path(),
        "dispatch": {"kind": "fs.delete", "spec": {"path": "destination.txt"}}
    }));
    let deleted = kernel.ok("effect.owner.postimage.verify", json!({}));
    assert_eq!(deleted["ok"], true, "{deleted}");
    assert_eq!(deleted["checked"], 2);
    fs::write(ws.path().join("source.txt"), b"recreated").unwrap();
    let tampered = kernel.ok("effect.owner.postimage.verify", json!({}));
    assert_eq!(tampered["ok"], false);
    assert_eq!(tampered["mismatches"][0]["expectedState"], "absent");
    assert_eq!(tampered["mismatches"][0]["observedState"], "present");
    #[cfg(unix)]
    {
        fs::remove_file(ws.path().join("source.txt")).unwrap();
        std::os::unix::fs::symlink("missing-target", ws.path().join("source.txt")).unwrap();
        let dangling = kernel.ok("effect.owner.postimage.verify", json!({}));
        assert_eq!(dangling["ok"], false, "{dangling}");
        assert_eq!(dangling["mismatches"][0]["observedState"], "present");
        assert_eq!(dangling["mismatches"][0]["expectedState"], "absent");
    }
}

#[test]
fn owner_event_stream_is_not_caller_appendable() {
    let state = TempDir::new("owner-private");
    let mut kernel = Kernel::start(state.path());
    let denied = kernel.err("log.append", json!({
        "stream": "owner:effects", "event": { "type": "effect.settled" }
    }));
    assert!(denied.contains("HZ_PRECONDITION_FAILED"), "{denied}");
    assert_eq!(kernel.ok("effect.owner.status", json!({}))["unresolved"], 0);
}

/* ------------------------------ kernel harness ------------------------------ */

/// One live `hz-kernel` process speaking NDJSON over stdio.
struct Kernel {
    child: Child,
    stderr_path: PathBuf,
    stdin: ChildStdin,
    stdout: BufReader<ChildStdout>,
    next_id: u64,
}

impl Kernel {
    fn start(state_dir: &Path) -> Kernel {
        Self::start_with_env(state_dir, &[])
    }

    /// Start a kernel with explicit env overrides. KEYED/LEGACY variables are
    /// always scrubbed first so the outer environment can never key the tests
    /// by accident.
    fn start_with_env(state_dir: &Path, env: &[(&str, &str)]) -> Kernel {
        // stderr goes to a per-process file (not inherited) so that a kernel
        // that dies early can explain itself in the panic message.
        static STDERR_SEQ: AtomicU64 = AtomicU64::new(0);
        let stderr_path = std::env::temp_dir().join(format!(
            "hz-kernel-stderr-{}-{}.log",
            std::process::id(),
            STDERR_SEQ.fetch_add(1, Ordering::SeqCst)
        ));
        let stderr_file = fs::File::create(&stderr_path).expect("create kernel stderr file");
        let mut command = Command::new(env!("CARGO_BIN_EXE_hz-kernel"));
        command
            .arg("--state-dir")
            .arg(state_dir)
            .env_remove("HZ_ANCHOR_KEY")
            .env_remove("HZ_ACCEPT_LEGACY_ANCHORS")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::from(stderr_file));
        for (key, value) in env {
            command.env(key, value);
        }
        let mut child = command.spawn().expect("failed to spawn hz-kernel");
        let stdin = child.stdin.take().expect("child stdin");
        let stdout = BufReader::new(child.stdout.take().expect("child stdout"));
        let mut kernel = Kernel {
            child,
            stderr_path,
            stdin,
            stdout,
            next_id: 1,
        };
        // Readiness handshake. The kernel validates `<state>/policy.json` once
        // at startup and exits 2 on a malformed one, so a test that writes
        // policy.json right after spawning could race that validation (a
        // non-atomic `fs::write` is briefly an empty file). Waiting for the
        // first reply proves startup validation has finished; every later
        // policy.json write is read per request, in sequence. The probe id is
        // outside the `next_id` range so request ids stay as the tests expect.
        kernel.send_line(r#"{"id":0,"method":"ping","params":{}}"#);
        let ready = kernel.read_response();
        assert_eq!(ready["id"], json!(0), "readiness ping not echoed: {}", ready);
        kernel
    }

    /// Exit status and captured stderr of a kernel that went away early.
    fn describe_exit(&mut self) -> String {
        let status = match self.child.try_wait() {
            Ok(Some(status)) => format!("exited with {}", status),
            Ok(None) => {
                let _ = self.child.kill();
                match self.child.wait() {
                    Ok(status) => format!("closed stdout but was still running (killed: {})", status),
                    Err(e) => format!("closed stdout (wait failed: {})", e),
                }
            }
            Err(e) => format!("status unavailable: {}", e),
        };
        let stderr = fs::read_to_string(&self.stderr_path).unwrap_or_default();
        format!("kernel {}; stderr: {:?}", status, stderr)
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
        if n == 0 {
            // Give a dying child a moment to be reapable so the status is real.
            std::thread::sleep(std::time::Duration::from_millis(50));
            panic!(
                "kernel closed stdout before answering a request ({})",
                self.describe_exit()
            );
        }
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
        let _ = fs::remove_file(&self.stderr_path);
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

fn sha256_bytes(data: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(data);
    hasher
        .finalize()
        .iter()
        .map(|byte| format!("{:02x}", byte))
        .collect()
}

/// Test-side HMAC-SHA256 (RFC 2104): an independent statement of the keyed
/// anchor format, so the kernel's own canon.rs is never its own witness.
fn hmac_sha256_hex(key: &[u8], message: &[u8]) -> String {
    const BLOCK: usize = 64;
    let mut k0 = [0u8; BLOCK];
    if key.len() > BLOCK {
        k0[..32].copy_from_slice(&Sha256::digest(key));
    } else {
        k0[..key.len()].copy_from_slice(key);
    }
    let mut inner = Sha256::new();
    for byte in k0.iter() {
        inner.update([byte ^ 0x36]);
    }
    inner.update(message);
    let inner = inner.finalize();
    let mut outer = Sha256::new();
    for byte in k0.iter() {
        outer.update([byte ^ 0x5c]);
    }
    outer.update(inner);
    outer
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

/* --------------------------------- 2c. keyed anchors --------------------------------- */

/// The keyed anchor is HMAC-SHA256(key, canonical record preimage) — verified
/// independently over both the event log and the receipt chain.
#[test]
fn keyed_anchor_is_hmac_over_the_record_preimage() {
    let dir = TempDir::new("anchor-keyed");
    let key_hex = "5a".repeat(32);
    let key = vec![0x5au8; 32];
    let mut kernel = Kernel::start_with_env(dir.path(), &[("HZ_ANCHOR_KEY", key_hex.as_str())]);
    let stream = "session:keyed";

    let first = kernel.ok("log.append", json!({ "stream": stream, "event": event_seed(0) }));
    let second = kernel.ok("log.append", json!({ "stream": stream, "event": event_seed(1) }));
    assert_eq!(second["prevHash"], first["hash"]);
    assert_eq!(
        kernel.ok("log.verify", json!({ "stream": stream })),
        json!({ "ok": true, "count": 2 })
    );

    let head: Value = serde_json::from_str(
        fs::read_to_string(dir.path().join("events/session__keyed.jsonl.head"))
            .unwrap()
            .trim(),
    )
    .unwrap();
    let expected = hmac_sha256_hex(&key, canonical_json(&envelope_preimage(&second)).as_bytes());
    assert_eq!(head, json!({ "hash": expected, "seq": 2 }));
    assert_ne!(
        head["hash"], second["hash"],
        "keyed mode must replace the plain record digest with the HMAC"
    );
    // The chain itself is untouched: the record hash is still plain sha256.
    assert_eq!(second["hash"], json!(hash_envelope(&second)));

    let receipt = kernel.ok(
        "receipt.issue",
        json!({ "action": "tool.execute", "tool": "read", "argsDigest": sha256_hex("args"), "resultDigest": sha256_hex("res") }),
    );
    let rhead: Value = serde_json::from_str(
        fs::read_to_string(dir.path().join("receipts.jsonl.head"))
            .unwrap()
            .trim(),
    )
    .unwrap();
    assert_eq!(
        rhead["hash"],
        json!(hmac_sha256_hex(&key, canonical_json(&receipt_preimage(&receipt)).as_bytes()))
    );
    assert_eq!(rhead["seq"], json!(1));
    assert_ne!(rhead["hash"], receipt["hash"]);
    assert_eq!(
        kernel.ok("receipt.verify", json!({})),
        json!({ "ok": true, "count": 1 })
    );
}

/// Keyed mode refuses a legacy (unkeyed) anchor on verify and on append, and
/// the explicit opt-in accepts it, re-anchoring keyed on the next append.
#[test]
fn keyed_verify_refuses_legacy_anchor_and_append_refuses_it_too() {
    let dir = TempDir::new("anchor-legacy");
    let stream = "session:legacy";
    let key_hex = "7b".repeat(32);
    let key = vec![0x7bu8; 32];
    {
        // an unkeyed kernel writes a plain chain (the shipped default)
        let mut plain = Kernel::start(dir.path());
        kernel_append_two(&mut plain, stream);
        assert_eq!(
            plain.ok("log.verify", json!({ "stream": stream })),
            json!({ "ok": true, "count": 2 })
        );
    }

    // keyed, without the opt-in: a typed refusal, not a verdict
    let mut keyed = Kernel::start_with_env(dir.path(), &[("HZ_ANCHOR_KEY", key_hex.as_str())]);
    let message = keyed.err("log.verify", json!({ "stream": stream }));
    assert!(message.contains("HZ_PRECONDITION_FAILED"), "{}", message);
    assert!(message.contains("legacy (unkeyed) anchor"), "{}", message);
    assert!(message.contains("HZ_ACCEPT_LEGACY_ANCHORS=1"), "{}", message);
    let message = keyed.err("log.append", json!({ "stream": stream, "event": event_seed(9) }));
    assert!(message.contains("HZ_PRECONDITION_FAILED"), "{}", message);
    assert_eq!(fs::read_to_string(dir.path().join("events/session__legacy.jsonl")).unwrap().lines().count(), 2);

    // opt-in: verify succeeds and the next append writes a keyed anchor
    let mut accepting = Kernel::start_with_env(
        dir.path(),
        &[("HZ_ANCHOR_KEY", key_hex.as_str()), ("HZ_ACCEPT_LEGACY_ANCHORS", "1")],
    );
    assert_eq!(
        accepting.ok("log.verify", json!({ "stream": stream })),
        json!({ "ok": true, "count": 2 })
    );
    let third = accepting.ok("log.append", json!({ "stream": stream, "event": event_seed(9) }));
    assert_eq!(third["seq"], json!(3));
    let head: Value = serde_json::from_str(
        fs::read_to_string(dir.path().join("events/session__legacy.jsonl.head"))
            .unwrap()
            .trim(),
    )
    .unwrap();
    assert_eq!(
        head["hash"],
        json!(hmac_sha256_hex(&key, canonical_json(&envelope_preimage(&third)).as_bytes()))
    );

    // a strict keyed verifier (no opt-in) is happy with the re-anchored chain
    let mut strict = Kernel::start_with_env(dir.path(), &[("HZ_ANCHOR_KEY", key_hex.as_str())]);
    assert_eq!(
        strict.ok("log.verify", json!({ "stream": stream })),
        json!({ "ok": true, "count": 3 })
    );
}

/// Wrong key and deleted anchor both fail closed; a malformed key refuses to start.
#[test]
fn keyed_anchor_fails_closed_on_wrong_key_and_missing_anchor() {
    let dir = TempDir::new("anchor-wrong-key");
    let stream = "session:strict";
    let key_a = "11".repeat(32);
    let key_b = "22".repeat(32);
    {
        let mut writer = Kernel::start_with_env(dir.path(), &[("HZ_ANCHOR_KEY", key_a.as_str())]);
        kernel_append_two(&mut writer, stream);
    }

    // wrong key: the walk passes, the anchor cannot be authenticated → tamper verdict
    let mut wrong = Kernel::start_with_env(dir.path(), &[("HZ_ANCHOR_KEY", key_b.as_str())]);
    assert_eq!(
        wrong.ok("log.verify", json!({ "stream": stream })),
        json!({ "ok": false, "count": 2, "brokenAt": 2 })
    );
    let message = wrong.err("log.append", json!({ "stream": stream, "event": event_seed(9) }));
    assert!(message.contains("disagrees with its anchor"), "{}", message);

    // deleting the anchor drops the keyed material: typed refusal, not legacy acceptance
    fs::remove_file(dir.path().join("events/session__strict.jsonl.head")).unwrap();
    let mut keyed = Kernel::start_with_env(dir.path(), &[("HZ_ANCHOR_KEY", key_a.as_str())]);
    let message = keyed.err("log.verify", json!({ "stream": stream }));
    assert!(message.contains("HZ_PRECONDITION_FAILED"), "{}", message);
    assert!(message.contains("no anchor"), "{}", message);

    // a malformed key is refused at startup (exit 2), never ignored
    let output = Command::new(env!("CARGO_BIN_EXE_hz-kernel"))
        .arg("--state-dir")
        .arg(dir.path())
        .env("HZ_ANCHOR_KEY", "not-a-hex-key")
        .env_remove("HZ_ACCEPT_LEGACY_ANCHORS")
        .output()
        .expect("spawn with a malformed key");
    assert_eq!(output.status.code(), Some(2), "malformed key must exit 2");
    assert!(
        String::from_utf8_lossy(&output.stderr).contains("HZ_ANCHOR_KEY"),
        "stderr: {}",
        String::from_utf8_lossy(&output.stderr)
    );
}

fn kernel_append_two(kernel: &mut Kernel, stream: &str) {
    for i in 0..2u64 {
        let envelope = kernel.ok("log.append", json!({ "stream": stream, "event": event_seed(i) }));
        assert_eq!(envelope["seq"], json!(i + 1));
    }
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

/// docs/11-authority-safety.md R1: when the SAME action matches an `allow` rule
/// and an `ask` rule, `ask` wins — in either declaration order.
#[test]
fn guard_ask_rule_beats_allow_rule() {
    let dir = TempDir::new("guard-ask-over-allow");
    let mut kernel = Kernel::start(dir.path());

    // allow declared first, ask second
    fs::write(
        dir.path().join("policy.json"),
        serde_json::to_string(&json!([
            { "kind": "shell.exec", "scope": "*", "decision": "allow" },
            { "kind": "shell.exec", "scope": "*", "decision": "ask" },
        ]))
        .unwrap(),
    )
    .unwrap();
    let decision = guard_check(&mut kernel, "shell.exec", "echo hi", Some("workspace"), None);
    assert_eq!(decision["decision"], json!("ask"));
    assert!(
        decision["reason"].as_str().unwrap().contains("ask"),
        "reason should name the ask rule: {}",
        decision
    );
    assert_eq!(
        guard_decision(&mut kernel, "shell.exec", "echo hi", None, None),
        "ask",
        "scope '*' ask rule must beat a scope '*' allow rule"
    );

    // ask declared first, allow second: declaration order must not matter
    fs::write(
        dir.path().join("policy.json"),
        serde_json::to_string(&json!([
            { "kind": "shell.exec", "scope": "*", "decision": "ask" },
            { "kind": "shell.exec", "scope": "*", "decision": "allow" },
        ]))
        .unwrap(),
    )
    .unwrap();
    assert_eq!(
        guard_decision(&mut kernel, "shell.exec", "echo hi", Some("workspace"), None),
        "ask"
    );

    // deny still beats ask and allow
    fs::write(
        dir.path().join("policy.json"),
        serde_json::to_string(&json!([
            { "kind": "net.fetch", "scope": "*", "decision": "allow" },
            { "kind": "net.fetch", "scope": "*", "decision": "ask" },
            { "kind": "net.fetch", "scope": "*", "decision": "deny" },
        ]))
        .unwrap(),
    )
    .unwrap();
    assert_eq!(
        guard_decision(&mut kernel, "net.fetch", "https://x", Some("workspace"), None),
        "deny"
    );
}

/// Lease semantics are unchanged by the R1 reorder: an unexpired matching lease
/// still grants `allow` over a matching `ask` rule.
#[test]
fn guard_lease_still_beats_a_matching_ask_rule() {
    let dir = TempDir::new("guard-lease-vs-ask");
    let mut kernel = Kernel::start(dir.path());
    fs::write(
        dir.path().join("policy.json"),
        serde_json::to_string(&json!([{ "kind": "shell.exec", "scope": "*", "decision": "ask" }]))
            .unwrap(),
    )
    .unwrap();

    let lease = kernel.ok(
        "guard.lease",
        json!({ "kind": "shell.exec", "pattern": "echo *", "ttlMs": 60_000 }),
    );
    let decision = guard_check(&mut kernel, "shell.exec", "echo hi", Some("workspace"), None);
    assert_eq!(decision["decision"], json!("allow"));
    assert_eq!(decision["leaseId"], lease["leaseId"]);
    // outside the lease the ask rule still wins over nothing
    assert_eq!(
        guard_decision(&mut kernel, "shell.exec", "rm -rf /", Some("workspace"), None),
        "ask"
    );
}

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
        // docs/09 §4.7: the MCP tool-call kind asks by default, whatever the
        // caller's scope (an MCP call is not a path, so scope is "*").
        ("mcp.invoke", "github:create_pr", Some("*"), "ask"),
        // an unknown kind is refused before evaluation now (typed
        // HZ_PRECONDITION_FAILED — see
        // guard_rejects_unknown_action_kinds_before_evaluation), never answered
        // by the policy.
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

/// docs/09 §4.7 / R-tools-18/19/33 (reduced form): `mcp.invoke` is a first-class
/// guard kind. `parse_rule` whitelists it in policy.json (so allow/ask/deny rows
/// on it are served, never "unknown kind"), the default row asks, an exact lease
/// admits one call, and the unknown-kind refusal names it among the known kinds.
#[test]
fn guard_mcp_invoke_evaluates_and_unknown_kinds_stay_refused() {
    let dir = TempDir::new("guard-mcp-invoke");
    let mut kernel = Kernel::start(dir.path());

    // Default policy: an MCP tool call (serverId:toolName) asks.
    assert_eq!(
        guard_decision(&mut kernel, "mcp.invoke", "github:create_pr", Some("*"), None),
        "ask"
    );

    // A kernel-issued lease admits the exact call (lease > ask)...
    let lease = kernel.ok(
        "guard.lease",
        json!({ "kind": "mcp.invoke", "pattern": "github:create_pr", "ttlMs": 60_000 }),
    );
    let decision = guard_check(&mut kernel, "mcp.invoke", "github:create_pr", Some("*"), None);
    assert_eq!(decision["decision"], json!("allow"));
    assert_eq!(decision["leaseId"], lease["leaseId"]);
    // ...exactly once (ruling 32), and only for its own target.
    assert_eq!(
        guard_decision(&mut kernel, "mcp.invoke", "github:create_pr", Some("*"), None),
        "ask",
        "a consumed lease must not admit a second MCP call"
    );
    assert_eq!(
        guard_decision(&mut kernel, "mcp.invoke", "github:merge_pr", Some("*"), None),
        "ask"
    );

    // policy.json may carry allow/ask/deny rows for the kind: parse_rule accepts
    // the spelling (a malformed policy would exit 2 / refuse the check instead).
    fs::write(
        dir.path().join("policy.json"),
        serde_json::to_string(&json!([
            { "kind": "mcp.invoke", "scope": "*", "decision": "ask" },
            { "kind": "mcp.invoke", "scope": "*", "decision": "deny" },
        ]))
        .unwrap(),
    )
    .unwrap();
    let decision = guard_check(&mut kernel, "mcp.invoke", "github:create_pr", Some("*"), None);
    assert_eq!(decision["decision"], json!("deny"), "{}", decision);

    fs::write(
        dir.path().join("policy.json"),
        serde_json::to_string(&json!([
            { "kind": "mcp.invoke", "scope": "*", "decision": "allow" },
        ]))
        .unwrap(),
    )
    .unwrap();
    assert_eq!(
        guard_decision(&mut kernel, "mcp.invoke", "github:create_pr", Some("*"), None),
        "allow"
    );

    // The unknown-kind refusal is unchanged, and now names `mcp.invoke` too.
    let message = kernel.err(
        "guard.check",
        json!({ "action": { "kind": "mcp.connect", "target": "github" } }),
    );
    assert!(message.contains("unknown action kind \"mcp.connect\""), "{}", message);
    assert!(message.contains("mcp.invoke"), "the refusal must list the known kinds: {}", message);
    let message = kernel.err(
        "guard.check",
        json!({ "action": { "kind": "fs.edit", "target": "x" } }),
    );
    assert!(message.contains("unknown action kind \"fs.edit\""), "{}", message);
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
        // deny declared after allow must still win (deny > ask > allow)
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

    // A malformed policy.json is refused, never silently replaced by defaults:
    // a parsed-away rule could be the deny keeping a target closed.
    fs::write(dir.path().join("policy.json"), "{not json").unwrap();
    let message = kernel.err(
        "guard.check",
        json!({ "action": { "kind": "fs.write", "target": "src/x.rs" }, "scope": "workspace" }),
    );
    assert!(message.contains("HZ_PRECONDITION_FAILED"), "{}", message);
    assert!(message.contains("policy.json"), "{}", message);
    // ...and a rule missing its scope names the rule instead of dropping it.
    fs::write(
        dir.path().join("policy.json"),
        serde_json::to_string(&json!([
            { "kind": "fs.write", "scope": "workspace", "decision": "allow" },
            { "kind": "fs.write", "decision": "deny" },
        ]))
        .unwrap(),
    )
    .unwrap();
    let message = kernel.err(
        "guard.check",
        json!({ "action": { "kind": "fs.write", "target": "src/x.rs" }, "scope": "workspace" }),
    );
    assert!(message.contains("rule 1"), "{}", message);
}

/// A malformed policy is refused per check while a kernel is running, and a
/// kernel asked to serve it from startup refuses to start (exit 2).
#[test]
fn malformed_policy_fails_closed_at_check_and_at_startup() {
    let dir = TempDir::new("guard-policy-bad");
    let malformed = serde_json::to_string(&json!([
        { "kind": "fs.write", "scope": "workspace", "decision": "allow" },
        { "kind": "fs.write", "decision": "deny" },
    ]))
    .unwrap();

    // (1) a running kernel (started with no policy) refuses every check once
    // the malformed policy lands, naming the bad rule index... The ping first
    // proves startup validation completed before the bad policy was written.
    let mut kernel = Kernel::start(dir.path());
    assert!(!kernel.ok("ping", json!({}))["version"].as_str().unwrap_or("").is_empty());
    fs::write(dir.path().join("policy.json"), &malformed).unwrap();
    let message = kernel.err(
        "guard.check",
        json!({ "action": { "kind": "fs.write", "target": "src/x.rs" }, "scope": "workspace" }),
    );
    assert!(message.contains("HZ_PRECONDITION_FAILED"), "{}", message);
    assert!(
        message.contains("rule 1 is malformed"),
        "the bad rule index must be named: {}",
        message
    );
    // The kernel is still alive and serves a valid policy again once written.
    fs::write(
        dir.path().join("policy.json"),
        serde_json::to_string(&json!([
            { "kind": "fs.write", "scope": "workspace", "decision": "allow" },
        ]))
        .unwrap(),
    )
    .unwrap();
    assert_eq!(
        guard_decision(&mut kernel, "fs.write", "src/x.rs", Some("workspace"), None),
        "allow"
    );

    // Startup refuses to serve the malformed policy (exit 2, naming the rule).
    fs::write(dir.path().join("policy.json"), &malformed).unwrap();
    let output = Command::new(env!("CARGO_BIN_EXE_hz-kernel"))
        .arg("--state-dir")
        .arg(dir.path())
        .env_remove("HZ_ANCHOR_KEY")
        .env_remove("HZ_ACCEPT_LEGACY_ANCHORS")
        .output()
        .expect("spawn with a malformed policy");
    assert_eq!(output.status.code(), Some(2), "malformed policy must exit 2");
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(stderr.contains("rule 1"), "stderr: {}", stderr);
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

    // A caller-supplied lease is a claim, not a mint: only leases this kernel
    // issued (the held table) are honoured. A raw client inventing
    // {leaseId, kind, pattern, expiry} must not unlock anything.
    let fabricated = json!({
        "leaseId": "caller-wild",
        "kind": "fs.write",
        "pattern": "/tmp/*",
        "expiry": "2999-01-01T00:00:00.000Z",
    });
    assert_eq!(
        guard_decision(
            &mut kernel,
            "fs.write",
            "/tmp/scratch.txt",
            Some("outside"),
            Some(json!([fabricated])),
        ),
        "ask",
        "a fabricated caller-supplied lease must be ignored, not honoured"
    );
    // ...while a kernel-issued lease for the same surface IS honoured.
    let issued = kernel.ok(
        "guard.lease",
        json!({ "kind": "fs.write", "pattern": "/tmp/*", "ttlMs": 60_000 }),
    );
    let decision = guard_check(&mut kernel, "fs.write", "/tmp/scratch.txt", Some("outside"), None);
    assert_eq!(decision["decision"], json!("allow"));
    assert_eq!(decision["leaseId"], issued["leaseId"]);

    // The same rule covers a lease that happens to be malformed or expired:
    // caller-supplied entries are never authority, so nothing changes.
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
            "/var/hz-caller-check.txt",
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

/// The kernel state directory is structurally protected: even a policy.json that
/// allows every write cannot unlock `fs.write` into the state dir, because the
/// rule is evaluated before policy rules and leases. Lexical `..`, absolute
/// targets and symlinks all resolve to the same answer.
#[test]
fn guard_denies_writes_inside_the_state_dir_even_when_policy_allows() {
    let dir = TempDir::new("guard-state-protected");
    let mut kernel = Kernel::start(dir.path());

    // A permissive override: every fs.write, every scope, allowed.
    let permissive = serde_json::to_string(&json!([
        { "kind": "fs.write", "scope": "*", "decision": "allow" },
    ]))
    .unwrap();
    fs::write(dir.path().join("policy.json"), &permissive).unwrap();

    let policy_path = dir.path().join("policy.json");
    let policy_arg = policy_path.to_str().expect("utf8 path");

    // Absolute target: the structural rule wins over the allow rule.
    let decision = guard_check(&mut kernel, "fs.write", policy_arg, Some("workspace"), None);
    assert_eq!(decision["decision"], json!("deny"));
    assert!(
        decision["reason"]
            .as_str()
            .unwrap()
            .contains("kernel-state-protected"),
        "{}",
        decision
    );
    assert!(decision.get("leaseId").is_none());

    // Lexical traversal: out of the state dir and back in via `<state>/../<state>/`.
    let name = dir.path().file_name().expect("temp dir name");
    let out_and_back = format!(
        "{}/../{}/policy.json",
        dir.path().display(),
        name.to_string_lossy()
    );
    assert_eq!(
        guard_decision(&mut kernel, "fs.write", &out_and_back, Some("workspace"), None),
        "deny",
        "a lexical .. must not evade the state-dir rule"
    );
    // ...and through a descendant that does not exist yet (lexical collapse).
    let through_missing = format!("{}/not-created-yet/../policy.json", dir.path().display());
    assert_eq!(
        guard_decision(&mut kernel, "fs.write", &through_missing, Some("workspace"), None),
        "deny"
    );

    // A matching lease (issued by the kernel itself, and a caller copy) cannot
    // lift the structural rule either.
    let lease = kernel.ok(
        "guard.lease",
        json!({ "kind": "fs.write", "pattern": "*", "ttlMs": 60_000 }),
    );
    let decision = guard_check(
        &mut kernel,
        "fs.write",
        policy_arg,
        Some("workspace"),
        Some(json!([lease])),
    );
    assert_eq!(decision["decision"], json!("deny"));
    assert!(decision["reason"].as_str().unwrap().contains("kernel-state-protected"));

    // A symlink into the state dir is classified by where it lands.
    #[cfg(unix)]
    {
        use std::os::unix::fs::symlink;
        let holder = TempDir::new("guard-state-link");
        let link = holder.path().join("state-link");
        symlink(dir.path(), &link).expect("create symlink");
        let via_link = link.join("policy.json");
        let decision = guard_check(
            &mut kernel,
            "fs.write",
            via_link.to_str().unwrap(),
            Some("workspace"),
            None,
        );
        assert_eq!(decision["decision"], json!("deny"));
        assert!(decision["reason"].as_str().unwrap().contains("kernel-state-protected"));
    }

    // The rule is scoped to the state dir: a target outside it still follows the
    // permissive policy, and the state dir's own files are untouched.
    let outside = TempDir::new("guard-state-outside");
    let outside_file = outside.path().join("notes.txt");
    assert_eq!(
        guard_decision(
            &mut kernel,
            "fs.write",
            outside_file.to_str().unwrap(),
            Some("outside"),
            None,
        ),
        "allow",
        "a permissive policy must still govern writes outside the state dir"
    );
    assert_eq!(fs::read_to_string(&policy_path).unwrap(), permissive);
    // A sibling directory whose name shares the state dir's prefix is outside.
    let sibling = format!("{}-evil/policy.json", dir.path().display());
    assert_eq!(
        guard_decision(&mut kernel, "fs.write", &sibling, Some("workspace"), None),
        "allow"
    );

    // Reads of the state dir are not covered by this rule (the policy decides:
    // the override above has no fs.read rule, so the fallback is ask, not the
    // structural deny).
    let decision = guard_check(&mut kernel, "fs.read", policy_arg, Some("workspace"), None);
    assert_eq!(decision["decision"], json!("ask"));
    assert!(
        !decision["reason"].as_str().unwrap().contains("kernel-state-protected"),
        "{}",
        decision
    );
}

/// The confirmed bypass: `ln -s <state>/policy.json ws/link` (a dangling link)
/// used to be allowed because canonicalize of the link failed and the
/// resolution fell back to the link's own spelling. The lexical walk resolves
/// the chain without requiring any target to exist, so every path through it
/// is denied — while ordinary workspace writes stay governed by policy.
#[cfg(unix)]
#[test]
fn guard_denies_writes_through_dangling_and_chained_symlinks() {
    use std::os::unix::fs::symlink;

    let dir = TempDir::new("guard-links-state");
    let workspace = TempDir::new("guard-links-ws");
    let mut kernel = Kernel::start(dir.path());

    // A permissive override: only the structural rule can produce a deny below.
    let permissive = serde_json::to_string(&json!([
        { "kind": "fs.write", "scope": "*", "decision": "allow" },
    ]))
    .unwrap();
    fs::write(dir.path().join("policy.json"), &permissive).unwrap();

    let deny = |kernel: &mut Kernel, target: &str| {
        let decision = guard_check(kernel, "fs.write", target, Some("workspace"), None);
        assert_eq!(decision["decision"], json!("deny"), "{}", decision);
        assert!(
            decision["reason"]
                .as_str()
                .unwrap()
                .contains("kernel-state-protected"),
            "{}",
            decision
        );
    };

    // 1. the exact repro: a dangling link to <state>/policy.json
    let link = workspace.path().join("link");
    symlink(dir.path().join("policy.json"), &link).unwrap();
    deny(&mut kernel, link.to_str().unwrap());

    // 2. a two-hop link chain, both hops dangling
    let hop1 = workspace.path().join("hop1");
    let hop2 = workspace.path().join("hop2");
    symlink(&hop2, &hop1).unwrap();
    symlink(dir.path().join("events").join("tail.jsonl"), &hop2).unwrap();
    deny(&mut kernel, hop1.to_str().unwrap());

    // 3. a symlink to the state dir itself
    let alias = workspace.path().join("state-alias");
    symlink(dir.path(), &alias).unwrap();
    deny(&mut kernel, alias.to_str().unwrap());

    // 4. a symlinked middle component
    deny(&mut kernel, alias.join("policy.json").to_str().unwrap());

    // 5. a relative link target: ws/sub/rel -> ../../<state-name>/policy.json
    let nested = workspace.path().join("sub");
    fs::create_dir_all(&nested).unwrap();
    let relative = nested.join("rel");
    let state_name = dir.path().file_name().expect("state dir name");
    symlink(
        PathBuf::from("..")
            .join("..")
            .join(state_name)
            .join("policy.json"),
        &relative,
    )
    .unwrap();
    deny(&mut kernel, relative.to_str().unwrap());

    // 6. a link loop is refused (the walk fails closed), not resolved
    let loop_a = workspace.path().join("loop-a");
    let loop_b = workspace.path().join("loop-b");
    symlink(&loop_b, &loop_a).unwrap();
    symlink(&loop_a, &loop_b).unwrap();
    deny(&mut kernel, loop_a.to_str().unwrap());

    // The rule is still scoped: an ordinary workspace write — including one
    // through a symlink that resolves inside the workspace — follows policy.
    let inside_link = workspace.path().join("inside-link");
    symlink(workspace.path().join("notes.txt"), &inside_link).unwrap();
    assert_eq!(
        guard_decision(
            &mut kernel,
            "fs.write",
            inside_link.to_str().unwrap(),
            Some("workspace"),
            None,
        ),
        "allow"
    );
    // ...and reads are not covered by the rule (the permissive policy above has
    // no fs.read rule, so the fallback is ask).
    let read = guard_check(
        &mut kernel,
        "fs.read",
        dir.path().join("policy.json").to_str().unwrap(),
        Some("workspace"),
        None,
    );
    assert_ne!(read["decision"], json!("deny"));
}

/// owner-scoped guard.check: sessionId rides the request; a lease minted for a
/// session only covers checks carrying the same id.
fn guard_decision_with_session(
    kernel: &mut Kernel,
    kind: &str,
    target: &str,
    session: Option<&str>,
) -> String {
    let mut params = json!({ "action": { "kind": kind, "target": target } });
    if let Some(session) = session {
        params["sessionId"] = json!(session);
    }
    let decision = kernel.ok("guard.check", params);
    decision["decision"]
        .as_str()
        .expect("decision string")
        .to_string()
}

/// A lease minted with a sessionId is owner-scoped: a check carrying a different
/// session id never sees it (a subagent child re-enters approval), the owning
/// session does, and an owner-less lease (older clients) stays globally
/// consultable — the documented legacy path.
#[test]
fn guard_lease_owner_scoping() {
    let dir = TempDir::new("guard-lease-owner");
    let mut kernel = Kernel::start(dir.path());

    let lease = kernel.ok(
        "guard.lease",
        json!({ "kind": "shell.exec", "pattern": "echo *", "ttlMs": 60_000, "sessionId": "parent" }),
    );
    assert_eq!(lease["owner"], json!("parent"));

    // the owning session is covered
    let decision = kernel.ok(
        "guard.check",
        json!({
            "action": { "kind": "shell.exec", "target": "echo hi" },
            "sessionId": "parent",
        }),
    );
    assert_eq!(decision["decision"], json!("allow"));
    assert_eq!(decision["leaseId"], lease["leaseId"]);

    // a different session (the child) must ask again — and so must a caller
    // that carries no session id at all.
    assert_eq!(
        guard_decision_with_session(&mut kernel, "shell.exec", "echo hi", Some("child")),
        "ask"
    );
    assert_eq!(
        guard_decision_with_session(&mut kernel, "shell.exec", "echo hi", None),
        "ask"
    );

    // a caller-supplied copy of the parent's lease is equally invisible to the
    // child: passing the lease object does not widen it.
    let decision = kernel.ok(
        "guard.check",
        json!({
            "action": { "kind": "shell.exec", "target": "echo hi" },
            "sessionId": "child",
            "leases": [lease],
        }),
    );
    assert_eq!(decision["decision"], json!("ask"));

    // a legacy owner-less lease is still globally consultable (documented).
    let legacy = kernel.ok(
        "guard.lease",
        json!({ "kind": "shell.exec", "pattern": "echo hi", "ttlMs": 60_000 }),
    );
    assert!(
        legacy.get("owner").is_none(),
        "owner must be omitted for a legacy lease: {}",
        legacy
    );
    let decision = kernel.ok(
        "guard.check",
        json!({
            "action": { "kind": "shell.exec", "target": "echo hi" },
            "sessionId": "child",
        }),
    );
    assert_eq!(decision["decision"], json!("allow"));
    assert_eq!(decision["leaseId"], legacy["leaseId"]);
}

/// A raw client used to reach the state-dir rule under an unrecognised spelling:
/// kind "fs.edit" + its own lease was ALLOWed into the state dir. The protocol
/// now refuses any kind outside the five the guard knows, before evaluation.
#[test]
fn guard_rejects_unknown_action_kinds_before_evaluation() {
    let dir = TempDir::new("guard-kinds");
    let mut kernel = Kernel::start(dir.path());

    let message = kernel.err(
        "guard.check",
        json!({ "action": { "kind": "fs.edit", "target": "/etc/passwd" } }),
    );
    assert!(message.contains("HZ_PRECONDITION_FAILED"), "{}", message);
    assert!(message.contains("fs.edit"), "{}", message);
    assert!(message.contains("unknown action kind"), "{}", message);

    // Minting a lease for a kind the guard does not know is refused too: it
    // could never be consulted, and it is the other half of the verified repro.
    let message = kernel.err(
        "guard.lease",
        json!({ "kind": "fs.edit", "pattern": "*", "ttlMs": 60_000 }),
    );
    assert!(message.contains("HZ_PRECONDITION_FAILED"), "{}", message);
    assert!(message.contains("fs.edit"), "{}", message);

    // Every known kind still evaluates (a decision, never the vocabulary error).
    for (kind, target) in [
        ("fs.read", "/some/where.txt"),
        ("fs.write", "/some/where.txt"),
        ("shell.exec", "echo hi"),
        ("net.fetch", "https://example.invalid"),
        ("spawn", "agent task"),
        ("mcp.invoke", "github:create_pr"),
    ] {
        let decision = guard_check(&mut kernel, kind, target, Some("workspace"), None);
        assert!(
            decision["decision"].as_str().is_some(),
            "kind {} must still be evaluated: {}",
            kind,
            decision
        );
    }
}

/// A hardlink is the one bypass a path check cannot see: `ln <state>/policy.json
/// ws/pol-link.json` makes a plain, policy-allowed workspace write rewrite the
/// policy in place. The policy loader refuses a file with nlink > 1 (typed),
/// every decision while the link exists fails closed, and removing the extra
/// link restores service. The residual class (other state files rely on chain
/// detection; the OS-level fix is NF-016) is recorded for the docs.
#[cfg(unix)]
#[test]
fn hardlinked_policy_is_refused_until_the_extra_link_is_removed() {
    let dir = TempDir::new("policy-hardlink-state");
    let workspace = TempDir::new("policy-hardlink-ws");
    let mut kernel = Kernel::start(dir.path());
    let target = workspace.path().join("x.txt");
    let target = target.to_str().expect("utf8 target");

    // A permissive policy: without the hardlink every write is simply allowed.
    fs::write(
        dir.path().join("policy.json"),
        serde_json::to_string(&json!([
            { "kind": "fs.write", "scope": "*", "decision": "allow" },
        ]))
        .unwrap(),
    )
    .unwrap();
    assert_eq!(
        guard_decision(&mut kernel, "fs.write", target, Some("workspace"), None),
        "allow"
    );

    let link = workspace.path().join("pol-link.json");
    fs::hard_link(dir.path().join("policy.json"), &link).expect("hard link");
    let before = fs::read_to_string(dir.path().join("policy.json")).unwrap();

    // Every decision now refuses, with a typed message naming the policy path.
    let message = kernel.err(
        "guard.check",
        json!({ "action": { "kind": "fs.write", "target": target }, "scope": "workspace" }),
    );
    assert!(message.contains("HZ_PRECONDITION_FAILED"), "{}", message);
    assert!(message.contains("policy.json must have exactly one link"), "{}", message);
    assert!(message.contains("policy.json"), "{}", message);
    // The refusal means no decision answered the write: the policy is intact.
    assert_eq!(fs::read_to_string(dir.path().join("policy.json")).unwrap(), before);

    // Removing the extra link restores service.
    fs::remove_file(&link).unwrap();
    assert_eq!(
        guard_decision(&mut kernel, "fs.write", target, Some("workspace"), None),
        "allow"
    );
}

/// ttlMs=0 mints an already-expired lease (never a 15-minute substitute), and a
/// negative TTL is refused — the two implementations must observe the same
/// lease for the same request.
#[test]
fn zero_ttl_lease_is_already_expired_and_negative_is_refused() {
    let dir = TempDir::new("guard-ttl");
    let mut kernel = Kernel::start(dir.path());

    let zero = kernel.ok(
        "guard.lease",
        json!({ "kind": "shell.exec", "pattern": "echo hi", "ttlMs": 0 }),
    );
    assert!(
        is_iso_utc(zero["expiry"].as_str().unwrap_or("")),
        "expiry must be ISO-8601 UTC: {}",
        zero
    );
    // Expired on issue: the same action falls back to the policy (ask).
    assert_eq!(
        guard_decision(&mut kernel, "shell.exec", "echo hi", Some("workspace"), None),
        "ask"
    );

    // Control: the same surface with a positive TTL is covered.
    kernel.ok(
        "guard.lease",
        json!({ "kind": "shell.exec", "pattern": "echo hi", "ttlMs": 60_000 }),
    );
    assert_eq!(
        guard_decision(&mut kernel, "shell.exec", "echo hi", Some("workspace"), None),
        "allow"
    );

    // A negative TTL is not a number the protocol mints with.
    let message = kernel.err(
        "guard.lease",
        json!({ "kind": "shell.exec", "pattern": "echo x", "ttlMs": -1 }),
    );
    assert!(message.contains("ttlMs"), "{}", message);
}

/// Ruling 32 / docs/11 L1 (reduced form): a lease admits ONE effect. The first
/// matching check consumes it — the allow cites the lease id and the lease is
/// gone — so a second identical action falls back to the policy (`ask`) instead
/// of reusing the authority. Re-approval mints a new lease; the spent one is
/// never authority again.
#[test]
fn guard_lease_is_consumed_at_most_once() {
    let dir = TempDir::new("guard-lease-once");
    let mut kernel = Kernel::start(dir.path());

    let lease = kernel.ok(
        "guard.lease",
        json!({ "kind": "shell.exec", "pattern": "echo hi", "ttlMs": 60_000 }),
    );
    let first = guard_check(&mut kernel, "shell.exec", "echo hi", Some("workspace"), None);
    assert_eq!(first["decision"], json!("allow"));
    assert_eq!(first["leaseId"], lease["leaseId"]);
    assert!(
        first["reason"].as_str().unwrap_or("").contains("consumed"),
        "the allow must say the lease was consumed: {}",
        first
    );

    // The spent lease does not admit a second effect...
    assert_eq!(
        guard_decision(&mut kernel, "shell.exec", "echo hi", Some("workspace"), None),
        "ask",
        "a consumed lease must not admit a second effect"
    );
    // ...even when its id is echoed back as a caller-supplied claim.
    let replay = kernel.ok(
        "guard.check",
        json!({
            "action": { "kind": "shell.exec", "target": "echo hi" },
            "scope": "workspace",
            "leases": [lease],
        }),
    );
    assert_eq!(replay["decision"], json!("ask"));

    // A fresh lease covers the next effect — re-approval is one mint per effect.
    let second = kernel.ok(
        "guard.lease",
        json!({ "kind": "shell.exec", "pattern": "echo hi", "ttlMs": 60_000 }),
    );
    assert_ne!(second["leaseId"], lease["leaseId"]);
    let decision = guard_check(&mut kernel, "shell.exec", "echo hi", Some("workspace"), None);
    assert_eq!(decision["decision"], json!("allow"));
    assert_eq!(decision["leaseId"], second["leaseId"]);
}

/// Ruling 32 / docs/11 L7 (reduced form): "always" mints a session GRANT. The
/// grant itself allows nothing — each check it covers mints a fresh one-use
/// lease BOUND to that exact action, which the decision returns and the receipt
/// cites. The grant is never consumed; the leases it mints always are.
#[test]
fn guard_grant_mints_one_fresh_lease_per_effect() {
    let dir = TempDir::new("guard-grant-mint");
    let mut kernel = Kernel::start(dir.path());

    let grant = kernel.ok(
        "guard.grant",
        json!({ "kind": "shell.exec", "pattern": "echo *", "ttlMs": 60_000, "sessionId": "s1" }),
    );
    assert_eq!(grant["owner"], json!("s1"));
    assert!(
        is_iso_utc(grant["expiry"].as_str().unwrap_or("")),
        "grant expiry must be ISO-8601 UTC: {}",
        grant
    );

    // Each covered effect gets its own fresh, bound lease.
    let d1 = kernel.ok(
        "guard.check",
        json!({ "action": { "kind": "shell.exec", "target": "echo one" }, "sessionId": "s1" }),
    );
    assert_eq!(d1["decision"], json!("allow"));
    assert!(
        d1["reason"].as_str().unwrap_or("").contains("minted one-use lease"),
        "the allow must name the minted lease: {}",
        d1
    );
    let id1 = d1["leaseId"].as_str().unwrap_or("").to_string();
    assert!(!id1.is_empty() && id1 != grant["leaseId"].as_str().unwrap_or(""),
        "a grant must never be cited as a usable lease id: {}", d1);
    let d2 = kernel.ok(
        "guard.check",
        json!({ "action": { "kind": "shell.exec", "target": "echo two" }, "sessionId": "s1" }),
    );
    assert_eq!(d2["decision"], json!("allow"));
    let id2 = d2["leaseId"].as_str().unwrap_or("").to_string();
    assert!(id2 != id1 && id2 != id1, "each effect gets a distinct lease: {} vs {}", id1, id2);

    // The minted lease is spent by issue: it exists only as the evidence for
    // the decision that returned it. A repeat of "echo one" is covered because
    // the grant mints AGAIN — never because the previous mint was consulted.
    let d3 = kernel.ok(
        "guard.check",
        json!({ "action": { "kind": "shell.exec", "target": "echo one" }, "sessionId": "s1" }),
    );
    assert_eq!(d3["decision"], json!("allow"));
    assert!(
        d3["reason"].as_str().unwrap_or("").contains("minted one-use lease"),
        "a repeat is a fresh mint, not a consulted lease: {}",
        d3
    );
    assert_ne!(d3["leaseId"].as_str().unwrap_or(""), id1, "the second mint must be a new lease");

    // Owner scoping (inherited from ruling 29) still applies to grants: another
    // session and a session-less caller are not covered.
    assert_eq!(
        guard_decision_with_session(&mut kernel, "shell.exec", "echo one", Some("child")),
        "ask"
    );
    assert_eq!(
        guard_decision_with_session(&mut kernel, "shell.exec", "echo one", None),
        "ask"
    );

    // Expiry: a grant past its window mints nothing.
    kernel.ok(
        "guard.grant",
        json!({ "kind": "shell.exec", "pattern": "sleep *", "ttlMs": 1, "sessionId": "s1" }),
    );
    sleep(Duration::from_millis(40));
    assert_eq!(
        guard_decision_with_session(&mut kernel, "shell.exec", "sleep 1", Some("s1")),
        "ask",
        "an expired grant must fall back to the policy (ask)"
    );

    // A legacy owner-less grant is globally consultable (documented), matching
    // the owner-less lease rule.
    let legacy = kernel.ok(
        "guard.grant",
        json!({ "kind": "shell.exec", "pattern": "echo world", "ttlMs": 60_000 }),
    );
    assert!(legacy.get("owner").is_none(), "owner must be omitted: {}", legacy);
    assert_eq!(
        guard_decision_with_session(&mut kernel, "shell.exec", "echo world", Some("child")),
        "allow"
    );

    // Protocol validation mirrors guard.lease.
    let message = kernel.err("guard.grant", json!({ "kind": "shell.exec", "pattern": "*" }));
    assert!(message.contains("ttlMs"), "{}", message);
    let message = kernel.err(
        "guard.grant",
        json!({ "kind": "fs.edit", "pattern": "*", "ttlMs": 10 }),
    );
    assert!(message.contains("HZ_PRECONDITION_FAILED"), "{}", message);
}

/// MEMORY.md next to `.hz/state/kernel` needs approval even when policy allows
/// fs.write (docs/33 §5.4; ruling 148).
#[test]
fn guard_memory_manifest_write_asks_despite_policy_allow() {
    let hz = TempDir::new("mem-manifest-hz");
    let state_dir = hz.path().join("state").join("kernel");
    fs::create_dir_all(&state_dir).unwrap();
    fs::write(
        state_dir.join("policy.json"),
        serde_json::to_string(&json!([
            { "kind": "fs.write", "scope": "workspace", "decision": "allow" },
        ]))
        .unwrap(),
    )
    .unwrap();
    let mut kernel = Kernel::start(&state_dir);
    let manifest = hz.path().join("MEMORY.md");
    let manifest = manifest.to_str().expect("utf8");
    let decision = guard_check(&mut kernel, "fs.write", manifest, Some("workspace"), None);
    assert_eq!(decision["decision"], json!("ask"), "{}", decision);
    assert!(
        decision["reason"]
            .as_str()
            .unwrap_or("")
            .contains("memory-manifest-protected"),
        "{}",
        decision
    );
    let ordinary = hz.path().join("ok.txt");
    let ordinary = ordinary.to_str().expect("utf8");
    let allowed = guard_check(&mut kernel, "fs.write", ordinary, Some("workspace"), None);
    assert_eq!(allowed["decision"], json!("allow"), "{}", allowed);
}

/// A grant is an answer to `ask`, never a bypass: policy deny still wins over a
/// matching grant, and a surface a plain allow rule already covers is decided
/// by that rule — no grant is consulted, and no lease id is fabricated.
#[test]
fn guard_grant_never_beats_deny_and_never_fires_on_allow() {
    let dir = TempDir::new("guard-grant-scope");
    let mut kernel = Kernel::start(dir.path());
    let ws = TempDir::new("guard-grant-scope-ws");
    let target = ws.path().join("note.txt");
    let target = target.to_str().expect("utf8 target");

    // Default policy: fs.write workspace is allowed. A grant for the exact
    // path must not turn that into a "grant-minted lease" allow: the allow rule
    // answers, with no leaseId.
    kernel.ok(
        "guard.grant",
        json!({ "kind": "fs.write", "pattern": target, "ttlMs": 60_000 }),
    );
    let decision = guard_check(&mut kernel, "fs.write", target, Some("workspace"), None);
    assert_eq!(decision["decision"], json!("allow"));
    assert!(
        decision["reason"].as_str().unwrap_or("").contains("policy allow"),
        "an allow rule answers on its own: {}",
        decision
    );
    assert!(
        decision.get("leaseId").is_none(),
        "no lease may be fabricated where an allow rule answered: {}",
        decision
    );

    // A deny rule outranks a matching grant: the grant is consultable but the
    // decision is deny, with no lease minted.
    fs::write(
        dir.path().join("policy.json"),
        serde_json::to_string(&json!([
            { "kind": "shell.exec", "scope": "*", "decision": "deny" },
        ]))
        .unwrap(),
    )
    .unwrap();
    kernel.ok(
        "guard.grant",
        json!({ "kind": "shell.exec", "pattern": "echo hi", "ttlMs": 60_000 }),
    );
    let decision = guard_check(&mut kernel, "shell.exec", "echo hi", Some("workspace"), None);
    assert_eq!(decision["decision"], json!("deny"));
    assert!(decision.get("leaseId").is_none(), "deny mints nothing: {}", decision);
}

/// Stream names that traverse are refused, not sanitized into something else:
/// the name appears in the error, and nothing was created outside the events dir.
#[test]
fn traversing_stream_names_are_refused_by_the_protocol() {
    let dir = TempDir::new("stream-traversal");
    let mut kernel = Kernel::start(dir.path());

    let message = kernel.err(
        "log.append",
        json!({ "stream": "session:../../evil", "event": { "type": "t" } }),
    );
    assert!(message.contains("stream name is not allowed"), "{}", message);
    assert!(message.contains("session:../../evil"), "{}", message);

    let message = kernel.err("log.read", json!({ "stream": "session:../../evil" }));
    assert!(message.contains("stream name is not allowed"), "{}", message);

    let message = kernel.err("log.append", json!({ "stream": "..", "event": { "type": "t" } }));
    assert!(message.contains("stream name is not allowed"), "{}", message);

    assert!(!dir.path().join("evil").exists());
    assert!(!dir.path().parent().unwrap().join("evil").exists());

    // A normal stream still appends and verifies (the refusal is not a freeze).
    let stream = "session:traversal-control";
    kernel.ok(
        "log.append",
        json!({ "stream": stream, "event": { "type": "t" } }),
    );
    assert_eq!(kernel.ok("log.verify", json!({ "stream": stream }))["ok"], json!(true));
}

/* --------------------------------- 6. protocol --------------------------------- */

/// Two alive kernels appending to one stream in turn: each grows the file behind
/// the other's back, so every append after the first crosses the tail cache's
/// delta path (stat says "grew", the cached tail must chain the new records).
/// The chain must stay a single verifiable chain, and a third, cold process
/// must agree.
#[test]
fn two_kernels_appending_in_turn_keep_one_cached_chain() {
    let dir = TempDir::new("tail-cache-turn");
    let stream = "session:cache-turn";
    let mut a = Kernel::start(dir.path());
    let mut b = Kernel::start(dir.path());

    let mut seq = 0u64;
    let append = |kernel: &mut Kernel, label: &str, n: u64| {
        let event = kernel.ok(
            "log.append",
            json!({ "stream": stream, "event": {
                "type": "message.delta",
                "actor": { "kind": "agent", "id": label },
                "payload": { "n": n },
            }}),
        );
        assert_eq!(event["seq"], json!(n), "seq must continue across processes");
    };
    seq += 1;
    append(&mut a, "a1", seq);
    seq += 1;
    append(&mut a, "a2", seq);
    seq += 1;
    append(&mut b, "b1", seq);
    seq += 1;
    append(&mut b, "b2", seq);
    seq += 1;
    append(&mut a, "a3", seq);
    seq += 1;
    append(&mut b, "b3", seq);

    // Both warm processes agree, and so does a cold third one.
    let report = a.ok("log.verify", json!({ "stream": stream }));
    assert_eq!(report["ok"], json!(true), "{}", report);
    assert_eq!(report["count"], json!(6));
    let report = b.ok("log.verify", json!({ "stream": stream }));
    assert_eq!(report["ok"], json!(true), "{}", report);
    assert_eq!(report["count"], json!(6));
    let mut cold = Kernel::start(dir.path());
    let report = cold.ok("log.verify", json!({ "stream": stream }));
    assert_eq!(report["ok"], json!(true), "{}", report);
    assert_eq!(report["count"], json!(6));
}

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
        .env_remove("HZ_ANCHOR_KEY")
        .env_remove("HZ_ACCEPT_LEGACY_ANCHORS")
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
        .env_remove("HZ_ANCHOR_KEY")
        .env_remove("HZ_ACCEPT_LEGACY_ANCHORS")
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

/* ---------------------------- 7. command allowlist ---------------------------- */
//
// FEAT-002: the declarative command allowlist (<state-dir>/allowlist.json) is
// consulted for shell.exec BEFORE the policy rules. A deny wins (docs/11 R1),
// an allow admits, absence leaves shell.exec=ask byte-identical to today, and a
// malformed allowlist is a typed HZ_PRECONDITION_FAILED refusal. Every test
// drives the real binary over the NDJSON protocol.

/// Write an allowlist document (bare array of rule objects) into the state dir.
fn write_allowlist(state_dir: &Path, rules: Value) {
    fs::write(
        state_dir.join("allowlist.json"),
        serde_json::to_string(&rules).unwrap(),
    )
    .unwrap();
}

#[test]
fn allowlist_deny_wins_before_policy_for_shell_exec() {
    let dir = TempDir::new("allowlist-deny");
    let mut kernel = Kernel::start(dir.path());

    // No allowlist yet: shell.exec asks (the shipped default, unchanged).
    assert_eq!(
        guard_decision(&mut kernel, "shell.exec", "rm -rf /", Some("workspace"), None),
        "ask"
    );

    // A deny rule on `rm` makes the same command deny, BEFORE policy.
    write_allowlist(
        dir.path(),
        json!([{ "program": "rm", "args": ["-rf"], "decision": "deny" }]),
    );
    let decision = guard_check(&mut kernel, "shell.exec", "rm -rf /", Some("workspace"), None);
    assert_eq!(decision["decision"], json!("deny"));
    assert!(
        decision["reason"].as_str().unwrap_or("").contains("allowlist deny"),
        "deny reason must cite the allowlist: {}",
        decision
    );
    // a command that does not match the deny rule falls through to ask
    assert_eq!(
        guard_decision(&mut kernel, "shell.exec", "rm file.txt", Some("workspace"), None),
        "ask"
    );
}

#[test]
fn allowlist_allow_admits_shell_exec() {
    let dir = TempDir::new("allowlist-allow");
    let mut kernel = Kernel::start(dir.path());

    write_allowlist(
        dir.path(),
        json!([{ "program": "git", "args": [["status", "diff"]], "decision": "allow" }]),
    );

    let decision = guard_check(&mut kernel, "shell.exec", "git status -s", Some("workspace"), None);
    assert_eq!(decision["decision"], json!("allow"));
    assert!(
        decision["reason"].as_str().unwrap_or("").contains("allowlist allow"),
        "allow reason must cite the allowlist: {}",
        decision
    );
    // case-insensitive (canonical) match by default
    assert_eq!(
        guard_decision(&mut kernel, "shell.exec", "GIT diff", Some("workspace"), None),
        "allow"
    );
    // a non-covered subcommand still asks
    assert_eq!(
        guard_decision(&mut kernel, "shell.exec", "git push", Some("workspace"), None),
        "ask"
    );
    // the allowlist is shell.exec only: fs.write workspace is untouched (allow
    // via policy, not via the allowlist path)
    let ws = TempDir::new("allowlist-allow-ws");
    let target = ws.path().join("f.txt");
    let decision = guard_check(
        &mut kernel,
        "fs.write",
        target.to_str().unwrap(),
        Some("workspace"),
        None,
    );
    assert_eq!(decision["decision"], json!("allow"));
    assert!(
        decision["reason"].as_str().unwrap_or("").contains("policy allow"),
        "fs.write must still go through policy, not the allowlist: {}",
        decision
    );
}

#[test]
fn absent_allowlist_leaves_shell_exec_asking() {
    let dir = TempDir::new("allowlist-absent");
    let mut kernel = Kernel::start(dir.path());
    // No allowlist file at all: behaviour is byte-identical to today.
    assert!(!dir.path().join("allowlist.json").exists());
    let decision = guard_check(&mut kernel, "shell.exec", "echo hi", Some("workspace"), None);
    assert_eq!(decision["decision"], json!("ask"));
    assert!(
        !decision["reason"].as_str().unwrap_or("").contains("allowlist"),
        "no allowlist opinion must not appear in the reason: {}",
        decision
    );
}

#[test]
fn malformed_allowlist_is_a_typed_refusal() {
    let dir = TempDir::new("allowlist-malformed");
    let mut kernel = Kernel::start(dir.path());

    // not JSON
    fs::write(dir.path().join("allowlist.json"), "{not json").unwrap();
    let message = kernel.err(
        "guard.check",
        json!({ "action": { "kind": "shell.exec", "target": "echo hi" }, "scope": "workspace" }),
    );
    assert!(message.contains("HZ_PRECONDITION_FAILED"), "{}", message);
    assert!(message.contains("allowlist"), "{}", message);

    // a bad rule names its index and still fails closed
    fs::write(
        dir.path().join("allowlist.json"),
        r#"[{"program":"git","decision":"maybe"}]"#,
    )
    .unwrap();
    let message = kernel.err(
        "guard.check",
        json!({ "action": { "kind": "shell.exec", "target": "git status" }, "scope": "workspace" }),
    );
    assert!(message.contains("HZ_PRECONDITION_FAILED"), "{}", message);
    assert!(message.contains("rule 0"), "the bad rule index must be named: {}", message);

    // a malformed allowlist does NOT affect non-shell kinds (they never consult it)
    let ws = TempDir::new("allowlist-malformed-ws");
    let target = ws.path().join("f.txt");
    let decision = guard_check(
        &mut kernel,
        "fs.write",
        target.to_str().unwrap(),
        Some("workspace"),
        None,
    );
    assert_eq!(decision["decision"], json!("allow"));
}

#[test]
fn allowlist_amend_appends_and_takes_effect() {
    let dir = TempDir::new("allowlist-amend");
    let mut kernel = Kernel::start(dir.path());

    // before amend: ask
    assert_eq!(
        guard_decision(&mut kernel, "shell.exec", "git status", Some("workspace"), None),
        "ask"
    );

    // amend a prefix allow rule at runtime over the NDJSON protocol
    let result = kernel.ok(
        "guard.allowlist.amend",
        json!({ "rule": { "program": "git", "args": ["status"], "decision": "allow" } }),
    );
    assert_eq!(result["changed"], json!(true));
    assert!(is_hash(result["fingerprint"].as_str().unwrap_or("")));

    // now the same command is admitted by the allowlist
    assert_eq!(
        guard_decision(&mut kernel, "shell.exec", "git status -s", Some("workspace"), None),
        "allow"
    );

    // a second identical amend dedups (changed=false) and the fingerprint is stable
    let again = kernel.ok(
        "guard.allowlist.amend",
        json!({ "rule": { "program": "git", "args": ["status"], "decision": "allow" } }),
    );
    assert_eq!(again["changed"], json!(false));
    assert_eq!(again["fingerprint"], result["fingerprint"]);

    // an unknown amend kind is refused the way guard.lease refuses one
    let message = kernel.err(
        "guard.allowlist.amend",
        json!({ "kind": "bogus", "rule": { "program": "git", "decision": "allow" } }),
    );
    assert!(message.contains("unknown"), "{}", message);
}

/* ----------------------------- 8. egress decider ----------------------------- */

// FEAT-003: a per-origin egress decider (<state-dir>/egress.json) is consulted
// for net.fetch BEFORE the policy rules (docs/11 N1/N2). With a policy present
// it is default-deny; a deny rule denies, an allow rule admits, an unmatched
// origin denies (N1). With NO egress.json present net.fetch keeps its
// policy-layer `ask`, byte-identical to today. A malformed egress.json is a
// typed HZ_PRECONDITION_FAILED refusal (fail closed). Every test drives the
// real binary over the NDJSON protocol.

/// Write an egress policy document into the state dir.
fn write_egress(state_dir: &Path, doc: Value) {
    fs::write(
        state_dir.join("egress.json"),
        serde_json::to_string(&doc).unwrap(),
    )
    .unwrap();
}

#[test]
fn egress_deny_rule_denies_net_fetch_before_policy() {
    let dir = TempDir::new("egress-deny");
    let mut kernel = Kernel::start(dir.path());

    // No egress policy yet: net.fetch asks (the shipped default, unchanged).
    assert_eq!(
        guard_decision(&mut kernel, "net.fetch", "https://evil.test/x", Some("workspace"), None),
        "ask"
    );

    // A deny rule on evil.test denies the same fetch BEFORE policy would ask.
    write_egress(
        dir.path(),
        json!([{ "host": "evil.test", "decision": "deny" }]),
    );
    let decision = guard_check(&mut kernel, "net.fetch", "https://evil.test/x", Some("workspace"), None);
    assert_eq!(decision["decision"], json!("deny"));
    assert!(
        decision["reason"].as_str().unwrap_or("").contains("egress deny"),
        "deny reason must cite the egress decider: {}",
        decision
    );
    assert!(
        decision["reason"].as_str().unwrap_or("").contains("deny_row"),
        "deny reason must name the DenySource: {}",
        decision
    );
}

#[test]
fn egress_default_deny_for_unmatched_origin_when_policy_present() {
    let dir = TempDir::new("egress-default-deny");
    let mut kernel = Kernel::start(dir.path());

    // A policy that only allows one host: any OTHER origin is denied (N1).
    write_egress(
        dir.path(),
        json!([{ "host": "allowed.test", "decision": "allow" }]),
    );
    let decision = guard_check(&mut kernel, "net.fetch", "https://other.test/x", Some("workspace"), None);
    assert_eq!(decision["decision"], json!("deny"));
    assert!(
        decision["reason"].as_str().unwrap_or("").contains("N1"),
        "default-deny reason must cite docs/11 N1: {}",
        decision
    );
}

#[test]
fn egress_allow_rule_admits_net_fetch() {
    let dir = TempDir::new("egress-allow");
    let mut kernel = Kernel::start(dir.path());

    write_egress(
        dir.path(),
        json!([{ "host": "api.example.com", "decision": "allow" }]),
    );
    let decision = guard_check(
        &mut kernel,
        "net.fetch",
        "https://api.example.com/v1/models?q=1",
        Some("workspace"),
        None,
    );
    assert_eq!(decision["decision"], json!("allow"));
    assert!(
        decision["reason"].as_str().unwrap_or("").contains("egress allow"),
        "allow reason must cite the egress decider: {}",
        decision
    );

    // a different (unmatched) origin still denies (N1), proving allow is scoped
    assert_eq!(
        guard_decision(&mut kernel, "net.fetch", "https://other.test/x", Some("workspace"), None),
        "deny"
    );
}

#[test]
fn absent_egress_policy_leaves_net_fetch_asking() {
    let dir = TempDir::new("egress-absent");
    let mut kernel = Kernel::start(dir.path());
    // No egress file at all: behaviour is byte-identical to today (ask), and
    // the reason must not mention the egress decider.
    assert!(!dir.path().join("egress.json").exists());
    let decision = guard_check(&mut kernel, "net.fetch", "https://x.test/y", Some("workspace"), None);
    assert_eq!(decision["decision"], json!("ask"));
    assert!(
        !decision["reason"].as_str().unwrap_or("").contains("egress"),
        "no egress opinion must not appear in the reason: {}",
        decision
    );
}

#[test]
fn egress_observe_mode_admits_without_blocking() {
    let dir = TempDir::new("egress-observe");
    let mut kernel = Kernel::start(dir.path());

    // observe mode: even a would-deny origin ADMITS (does not block) and falls
    // through to the policy layer, which for net.fetch is ask by default.
    write_egress(
        dir.path(),
        json!({
            "rules": [{ "host": "watch.test", "decision": "deny" }],
            "observe": true
        }),
    );
    let decision = guard_check(&mut kernel, "net.fetch", "https://watch.test/x", Some("workspace"), None);
    // not a deny: observe mode never blocks; the policy-layer ask stands.
    assert_ne!(decision["decision"], json!("deny"));
    assert_eq!(decision["decision"], json!("ask"));
}

#[test]
fn malformed_egress_policy_is_a_typed_refusal() {
    let dir = TempDir::new("egress-malformed");
    let mut kernel = Kernel::start(dir.path());

    // not JSON
    fs::write(dir.path().join("egress.json"), "{not json").unwrap();
    let message = kernel.err(
        "guard.check",
        json!({ "action": { "kind": "net.fetch", "target": "https://x.test/y" }, "scope": "workspace" }),
    );
    assert!(message.contains("HZ_PRECONDITION_FAILED"), "{}", message);
    assert!(message.contains("egress"), "{}", message);

    // a bad rule names its index and still fails closed
    fs::write(
        dir.path().join("egress.json"),
        r#"[{"host":"x.test","decision":"maybe"}]"#,
    )
    .unwrap();
    let message = kernel.err(
        "guard.check",
        json!({ "action": { "kind": "net.fetch", "target": "https://x.test/y" }, "scope": "workspace" }),
    );
    assert!(message.contains("HZ_PRECONDITION_FAILED"), "{}", message);
    assert!(message.contains("rule 0"), "the bad rule index must be named: {}", message);

    // a malformed egress policy does NOT affect non-net kinds (they never
    // consult it): shell.exec still asks via policy.
    assert_eq!(
        guard_decision(&mut kernel, "shell.exec", "echo hi", Some("workspace"), None),
        "ask"
    );
}

/* ---------------------- 8b. egress CONNECT listener stub ---------------------- */

// §5.2 reduced (ruling 234): kernel loopback CONNECT consults egress.json; 403 on
// deny. Hermetic — no real internet. Does NOT prove shell-net enforced.

fn write_egress_connect_policy(dir: &Path, doc: Value) {
    fs::write(dir.join("egress.json"), serde_json::to_string(&doc).unwrap()).unwrap();
}

fn kernel_connect_status(port: u16, authority: &str) -> u16 {
    use std::io::{Read, Write};
    use std::net::TcpStream;
    let req = format!("CONNECT {} HTTP/1.1\r\nHost: {}\r\n\r\n", authority, authority);
    for attempt in 0..40 {
        let mut stream = match TcpStream::connect(("127.0.0.1", port)) {
            Ok(s) => s,
            Err(_) => {
                sleep(Duration::from_millis(25));
                continue;
            }
        };
        let _ = stream.set_read_timeout(Some(Duration::from_secs(2)));
        if stream.write_all(req.as_bytes()).and_then(|_| stream.flush()).is_err() {
            sleep(Duration::from_millis(25));
            continue;
        }
        let mut buf = [0u8; 512];
        let status = match stream.read(&mut buf) {
            Ok(0) => 0,
            Ok(n) => {
                let head = std::str::from_utf8(&buf[..n]).unwrap_or_default();
                head.lines()
                    .next()
                    .and_then(|l| l.split_whitespace().nth(1))
                    .and_then(|s| s.parse().ok())
                    .unwrap_or(0)
            }
            Err(_) => 0,
        };
        if status != 0 || attempt + 1 >= 40 {
            return status;
        }
        sleep(Duration::from_millis(25));
    }
    0
}

#[test]
fn egress_connect_listen_denies_and_allows_without_enforcement_claim() {
    let dir = TempDir::new("egress-connect-kernel");
    write_egress_connect_policy(
        dir.path(),
        json!([
            { "host": "deny.kernel.test", "decision": "deny" },
            { "host": "allow.kernel.test", "decision": "allow" }
        ]),
    );
    let mut kernel = Kernel::start(dir.path());
    let started = kernel.ok(
        "egress.connect.listen",
        json!({ "action": "start", "port": 0, "forward": false }),
    );
    let port = started["port"].as_u64().expect("port") as u16;
    sleep(Duration::from_millis(50));
    assert_eq!(kernel_connect_status(port, "deny.kernel.test:443"), 403);
    assert_eq!(kernel_connect_status(port, "allow.kernel.test:443"), 502);
    let stopped = kernel.ok("egress.connect.listen", json!({ "action": "stop" }));
    assert_eq!(stopped["stopped"], json!(true));
}

/* --------------------------- 9. sandbox-mode ladder --------------------------- */

// FEAT-004: the fail-closed SandboxMode ladder over `sandbox.report`.
// Host-aware: when Landlock is usable AND hz-sandbox-exec applies a ruleset,
// FS-confined modes report `enforced`; otherwise they fail closed (or partial
// with a residual). Never silently unconfined. danger-full-access reports no
// enforced dimension (docs/11 S4).

#[test]
fn sandbox_report_fs_mode_is_unavailable_not_silently_enforced() {
    let dir = TempDir::new("sandbox-unavailable");
    let mut kernel = Kernel::start(dir.path());

    for mode in ["read-only", "workspace-write"] {
        let result = kernel.ok("sandbox.report", json!({ "mode": mode }));
        let landlock = result["hostCapabilities"]["landlockFs"].as_bool().unwrap_or(false);
        if landlock {
            assert_eq!(
                result["status"],
                json!("report"),
                "Landlock-capable host should report FS confinement for {}: {}",
                mode,
                result
            );
            let dims = result["dimensions"].as_array().expect("dimensions");
            let fs = dims.iter().find(|d| d["dimension"] == json!("filesystem")).expect("fs dim");
            assert_eq!(fs["guarantee"], json!("enforced"), "{}", result);
            assert_eq!(fs["backend"], json!("landlock"), "{}", result);
        } else {
            assert_eq!(
                result["status"],
                json!("sandbox_unavailable"),
                "FS-confined mode {} must fail closed without Landlock: {}",
                mode,
                result
            );
            let reason = result["reason"].as_str().unwrap_or("");
            assert!(
                reason.contains("SANDBOX_UNAVAILABLE"),
                "the reason must be the typed SANDBOX_UNAVAILABLE outcome: {}",
                result
            );
        }
        assert_eq!(result["mode"], json!(mode));
        assert!(result["hostCapabilities"]["landlockFs"].is_boolean(), "{}", result);
        let notes = result["platformNotes"].as_array().expect("platformNotes");
        assert!(
            notes.iter().any(|n| n.as_str().unwrap_or("").contains("Seatbelt")),
            "platform honesty must name macOS backends as unavailable on Linux: {}",
            result
        );
    }
}

#[test]
fn sandbox_report_partial_has_nonempty_residual_and_explicit_backend() {
    let dir = TempDir::new("sandbox-partial");
    let mut kernel = Kernel::start(dir.path());

    let result = kernel.ok(
        "sandbox.report",
        json!({ "mode": "workspace-write", "allowPartial": true }),
    );
    assert_eq!(result["status"], json!("report"), "{}", result);
    let landlock = result["hostCapabilities"]["landlockFs"].as_bool().unwrap_or(false);
    let dims = result["dimensions"].as_array().expect("dimensions array");
    let fs = dims
        .iter()
        .find(|d| d["dimension"] == json!("filesystem"))
        .expect("a filesystem dimension");
    if landlock {
        // rlimits stay best_effort, so completeness may be partial even with FS enforced.
        assert_eq!(result["backend"], json!("landlock"), "{}", result);
        assert_eq!(fs["guarantee"], json!("enforced"), "{}", result);
        assert_eq!(fs["backend"], json!("landlock"), "{}", result);
    } else {
        assert_eq!(result["completeness"], json!("partial"), "{}", result);
        assert_eq!(result["backend"], json!("none"), "{}", result);
        assert_eq!(fs["guarantee"], json!("unsupported"), "FS must not be enforced: {}", result);
        assert_eq!(fs["backend"], json!("none"), "{}", result);
        assert!(
            !fs["residual"].as_str().unwrap_or("").is_empty(),
            "FS residual must be non-empty (docs/11 S2): {}",
            result
        );
    }
    let proc = dims
        .iter()
        .find(|d| d["dimension"] == json!("process"))
        .expect("process dimension");
    if proc["guarantee"] == json!("enforced") {
        assert_eq!(proc["backend"], json!("seccomp"), "{}", result);
    }
    assert!(result["hostCapabilities"]["landlockFs"].is_boolean(), "{}", result);

    // Every below-enforced dimension carries a non-empty residual and an
    // explicit backend (a name or 'none') — no silent fallback (S5).
    for d in dims {
        let backend = d["backend"].as_str().unwrap_or("");
        assert!(!backend.is_empty(), "backend must be explicit: {}", d);
        if d["guarantee"] != json!("enforced") {
            assert!(
                !d["residual"].as_str().unwrap_or("").is_empty(),
                "a below-enforced dimension must carry a residual: {}",
                d
            );
        }
    }
}

#[test]
fn sandbox_report_danger_full_access_has_no_enforced_dimension() {
    let dir = TempDir::new("sandbox-danger");
    let mut kernel = Kernel::start(dir.path());

    let result = kernel.ok("sandbox.report", json!({ "mode": "danger-full-access" }));
    assert_eq!(result["status"], json!("report"), "{}", result);
    assert_eq!(result["backend"], json!("none"), "{}", result);
    let dims = result["dimensions"].as_array().expect("dimensions array");
    assert!(
        dims.iter().all(|d| d["guarantee"] != json!("enforced")),
        "danger-full-access must report NO enforced dimension (docs/11 S4): {}",
        result
    );
}

#[test]
fn sandbox_report_validates_escalation_args_over_the_protocol() {
    let dir = TempDir::new("sandbox-escalation-args");
    let mut kernel = Kernel::start(dir.path());

    // lone sandbox_permissions (no justification) -> typed refusal
    let message = kernel.err(
        "sandbox.report",
        json!({ "mode": "read-only", "sandboxPermissions": "workspace-write" }),
    );
    assert!(message.contains("HZ_PRECONDITION_FAILED"), "{}", message);
    assert!(message.contains("escalation arguments"), "{}", message);

    // lone justification (no sandbox_permissions) -> typed refusal
    let message = kernel.err(
        "sandbox.report",
        json!({ "mode": "read-only", "justification": "please let me write" }),
    );
    assert!(message.contains("HZ_PRECONDITION_FAILED"), "{}", message);

    // empty justification with permissions -> typed refusal
    let message = kernel.err(
        "sandbox.report",
        json!({ "mode": "read-only", "sandboxPermissions": "workspace-write", "justification": "   " }),
    );
    assert!(message.contains("HZ_PRECONDITION_FAILED"), "{}", message);

    // an unknown mode is refused (fail-closed, never a silent default)
    let message = kernel.err("sandbox.report", json!({ "mode": "wide-open" }));
    assert!(message.contains("not a known mode"), "{}", message);

    // a well-formed escalation pairing is accepted; outcome depends on Landlock.
    let result = kernel.ok(
        "sandbox.report",
        json!({
            "mode": "workspace-write",
            "sandboxPermissions": "danger-full-access",
            "justification": "need full access for this one call"
        }),
    );
    let landlock = result["hostCapabilities"]["landlockFs"].as_bool().unwrap_or(false);
    if landlock {
        assert_eq!(result["status"], json!("report"), "{}", result);
        assert_eq!(result["backend"], json!("landlock"), "{}", result);
    } else {
        assert_eq!(result["status"], json!("sandbox_unavailable"), "{}", result);
    }
}

#[test]
fn effect_execute_hermetic_pure_settles() {
    let dir = TempDir::new("effect-execute-pure");
    let mut kernel = Kernel::start(dir.path());

    let result = kernel.ok(
        "effect.execute",
        json!({
            "effectId": "it-eff-pure",
            "dispatch": { "kind": "pure" }
        }),
    );
    assert_eq!(result["verdict"], json!("settled"), "{}", result);
    assert_eq!(
        result["phases"],
        json!(["allow", "execute", "observe"]),
        "{}",
        result
    );
}

#[test]
fn effect_execute_refuses_mutating_dispatch() {
    let dir = TempDir::new("effect-execute-mut");
    let mut kernel = Kernel::start(dir.path());

    let message = kernel.err(
        "effect.execute",
        json!({
            "effectId": "it-eff-mut",
            "dispatch": { "kind": "shell.exec", "spec": { "command": "true" } }
        }),
    );
    assert!(message.contains("HZ_PRECONDITION_FAILED"), "{}", message);
    assert!(message.contains("shell.exec"), "{}", message);
    assert!(message.contains("TypeScript"), "{}", message);
}

#[test]
fn effect_execute_fs_read_under_sandbox_root() {
    let dir = TempDir::new("effect-execute-read");
    let sandbox = dir.path().join("sandbox");
    std::fs::create_dir_all(&sandbox).expect("sandbox dir");
    let probe = sandbox.join("data.bin");
    std::fs::write(&probe, b"integration-read").expect("probe file");
    let expected = sha256_bytes(b"integration-read");

    let mut kernel = Kernel::start(dir.path());
    let result = kernel.ok(
        "effect.execute",
        json!({
            "effectId": "it-eff-read",
            "sandboxRoot": sandbox.to_string_lossy(),
            "dispatch": { "kind": "fs.read", "spec": { "path": "data.bin" } }
        }),
    );
    assert_eq!(result["verdict"], json!("settled"), "{}", result);
    assert_eq!(result["contentDigest"], json!(expected), "{}", result);

    let message = kernel.err(
        "effect.execute",
        json!({
            "effectId": "it-eff-read-esc",
            "sandboxRoot": sandbox.to_string_lossy(),
            "dispatch": { "kind": "fs.read", "spec": { "path": "../../etc/passwd" } }
        }),
    );
    assert!(message.contains("sandboxRoot"), "{}", message);
}

#[test]
fn effect_execute_fs_write_under_sandbox_root() {
    let dir = TempDir::new("effect-execute-write");
    // The workspace and the kernel's own durable authority state cannot
    // coincide: raw kernel mutations must never rewrite its OwnerLog.
    let state = TempDir::new("effect-execute-write-kernel");
    let sandbox = dir.path().join("sandbox");
    std::fs::create_dir_all(&sandbox).expect("sandbox dir");
    let expected = sha256_bytes(b"integration-write");

    let mut kernel = Kernel::start(state.path());
    let result = kernel.ok(
        "effect.execute",
        json!({
            "effectId": "it-eff-write",
            "sandboxRoot": sandbox.to_string_lossy(),
            "dispatch": { "kind": "fs.write", "spec": { "path": "out.bin", "text": "integration-write" } }
        }),
    );
    assert_eq!(result["verdict"], json!("settled"), "{}", result);
    assert_eq!(result["contentDigest"], json!(expected), "{}", result);
    let on_disk = std::fs::read(sandbox.join("out.bin")).expect("written file");
    assert_eq!(on_disk, b"integration-write");

    let message = kernel.err(
        "effect.execute",
        json!({
            "effectId": "it-eff-write-esc",
            "sandboxRoot": sandbox.to_string_lossy(),
            "dispatch": { "kind": "fs.write", "spec": { "path": "../../etc/passwd", "text": "x" } }
        }),
    );
    assert!(message.contains("sandboxRoot"), "{}", message);

    let unrestricted = kernel.err(
        "effect.execute",
        json!({
            "effectId": "it-eff-write-open",
            "dispatch": { "kind": "fs.write", "spec": { "path": "x", "text": "y" } }
        }),
    );
    assert!(unrestricted.contains("HZ_PRECONDITION_FAILED"), "{}", unrestricted);
    assert!(unrestricted.contains("fs.write"), "{}", unrestricted);
}

#[test]
fn effect_execute_fs_edit_under_sandbox_root() {
    let dir = TempDir::new("effect-execute-edit");
    let state = TempDir::new("effect-execute-edit-kernel");
    let sandbox = dir.path().join("sandbox");
    std::fs::create_dir_all(&sandbox).expect("sandbox dir");
    std::fs::write(sandbox.join("src.txt"), b"alpha-beta").expect("seed file");
    let expected = sha256_bytes(b"alpha-OMEGA");

    let mut kernel = Kernel::start(state.path());
    let result = kernel.ok(
        "effect.execute",
        json!({
            "effectId": "it-eff-edit",
            "sandboxRoot": sandbox.to_string_lossy(),
            "dispatch": {
                "kind": "fs.edit",
                "spec": { "path": "src.txt", "oldString": "beta", "newString": "OMEGA" }
            }
        }),
    );
    assert_eq!(result["verdict"], json!("settled"), "{}", result);
    assert_eq!(result["contentDigest"], json!(expected), "{}", result);
    let on_disk = std::fs::read_to_string(sandbox.join("src.txt")).expect("edited file");
    assert_eq!(on_disk, "alpha-OMEGA");

    let message = kernel.err(
        "effect.execute",
        json!({
            "effectId": "it-eff-edit-miss",
            "sandboxRoot": sandbox.to_string_lossy(),
            "dispatch": {
                "kind": "fs.edit",
                "spec": { "path": "src.txt", "oldString": "nope", "newString": "x" }
            }
        }),
    );
    assert!(message.contains("oldString not found"), "{}", message);

    let unrestricted = kernel.err(
        "effect.execute",
        json!({
            "effectId": "it-eff-edit-open",
            "dispatch": {
                "kind": "fs.edit",
                "spec": { "path": "src.txt", "oldString": "a", "newString": "b" }
            }
        }),
    );
    assert!(unrestricted.contains("HZ_PRECONDITION_FAILED"), "{}", unrestricted);
    assert!(unrestricted.contains("fs.edit"), "{}", unrestricted);
}

#[test]
fn effect_execute_shell_exec_under_sandbox_root() {
    let dir = TempDir::new("effect-execute-shell");
    let sandbox = dir.path().join("sandbox");
    std::fs::create_dir_all(&sandbox).expect("sandbox dir");
    let expected_stdout = sha256_bytes(b"hello\n");

    let mut kernel = Kernel::start(dir.path());
    kernel.ok("guard.lease", json!({
        "kind": "shell.exec", "pattern": "echo hello", "ttlMs": 60_000
    }));
    let result = kernel.ok(
        "effect.execute",
        json!({
            "effectId": "it-eff-shell",
            "sandboxRoot": sandbox.to_string_lossy(),
            "dispatch": { "kind": "shell.exec", "spec": { "argv": ["echo", "hello"] } }
        }),
    );
    assert_eq!(result["verdict"], json!("settled"), "{}", result);
    assert_eq!(result["exitCode"], json!(0), "{}", result);
    assert_eq!(result["stdoutDigest"], json!(expected_stdout), "{}", result);
    assert_eq!(result["resultDigestStable"], json!(true), "{}", result);

    let unrestricted = kernel.err(
        "effect.execute",
        json!({
            "effectId": "it-eff-shell-open",
            "dispatch": { "kind": "shell.exec", "spec": { "argv": ["true"] } }
        }),
    );
    assert!(unrestricted.contains("HZ_PRECONDITION_FAILED"), "{}", unrestricted);
    assert!(unrestricted.contains("shell.exec"), "{}", unrestricted);

    kernel.ok("guard.lease", json!({
        "kind": "shell.exec", "pattern": "pwd", "ttlMs": 60_000
    }));
    let cwd_escape = kernel.err(
        "effect.execute",
        json!({
            "effectId": "it-eff-shell-cwd",
            "sandboxRoot": sandbox.to_string_lossy(),
            "dispatch": { "kind": "shell.exec", "spec": { "argv": ["pwd"], "cwd": "../" } }
        }),
    );
    assert!(cwd_escape.contains("sandboxRoot"), "{}", cwd_escape);
}
