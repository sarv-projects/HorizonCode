//! Kernel-owned, cross-process admission and durable UNKNOWN fence for the
//! supported `effect.execute` mutation classes (P0 R170 precursor).
//!
//! Unlike the Bun reconcile-latches.jsonl precursor, the OwnerLog is written
//! inside the kernel and every participating Rust process takes the SAME OS
//! file lock for prepare -> execute -> independent observe -> settle.
//!
//! This is not universal EffectHost ownership: ambient Bun effects still exist
//! outside strict mode; a local actor who controls the state directory can
//! replace files; and UNKNOWN clean-release requires further evidence.
use serde_json::{json, Value};
use std::collections::{BTreeMap, BTreeSet};
use std::fs::{self, File, OpenOptions};
use std::path::Path;
use std::thread::sleep;
use std::time::{Duration, Instant};

use crate::effect_host::{self, HermeticEffectLedger};
use crate::eventlog::EventLog;
use crate::guard::{Guard, GuardAction};
use crate::receipts::Receipts;

pub const STREAM: &str = "owner:effects";
const LOCK_WAIT: Duration = Duration::from_secs(5);

/// The lockfile is NEVER unlinked. A create_new + stale-takeover lock could be
/// replaced while a live owner is executing. A persistent flock-backed inode
/// allows processes to serialize without age-based unsafe takeovers.
struct OwnerLock {
    file: File,
}
impl OwnerLock {
    fn acquire(state_dir: &Path) -> Result<Self, String> {
        fs::create_dir_all(state_dir).map_err(|e| format!("owner: create state dir: {e}"))?;
        let path = state_dir.join("owner-admission.lock");
        let mut opts = OpenOptions::new();
        opts.read(true).write(true).create(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            opts.mode(0o600)
                .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC);
        }
        let file = opts
            .open(&path)
            .map_err(|e| format!("HZ_PRECONDITION_FAILED: owner lock unavailable: {e}"))?;
        #[cfg(not(unix))]
        {
            let _ = file;
            return Err("HZ_PRECONDITION_FAILED: kernel OwnerLog requires POSIX flock".into());
        }
        #[cfg(unix)]
        {
            use std::os::fd::AsRawFd;
            use std::os::unix::fs::MetadataExt;
            let meta = file
                .metadata()
                .map_err(|e| format!("owner lock metadata: {e}"))?;
            if !meta.is_file() || meta.nlink() != 1 {
                return Err(
                    "HZ_PRECONDITION_FAILED: owner lock must be a single-link regular file".into(),
                );
            }
            let start = Instant::now();
            loop {
                let rc = unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) };
                if rc == 0 {
                    break;
                }
                let error = std::io::Error::last_os_error();
                if error.raw_os_error() != Some(libc::EWOULDBLOCK)
                    && error.raw_os_error() != Some(libc::EAGAIN)
                {
                    return Err(format!(
                        "HZ_PRECONDITION_FAILED: owner lock failed: {error}"
                    ));
                }
                if start.elapsed() >= LOCK_WAIT {
                    return Err("HZ_PRECONDITION_FAILED: owner admission busy; retry after current effect settles".into());
                }
                sleep(Duration::from_millis(10));
            }
            // Detect a replaced lock path after acquisition. No unlink of the
            // permanent lockfile is part of normal kernel operation.
            let on_disk = fs::symlink_metadata(&path)
                .map_err(|e| format!("HZ_PRECONDITION_FAILED: owner lock was removed: {e}"))?;
            if meta.ino() != on_disk.ino() || meta.dev() != on_disk.dev() || !on_disk.is_file() {
                return Err(
                    "HZ_PRECONDITION_FAILED: owner lock path changed during acquisition".into(),
                );
            }
            Ok(Self { file })
        }
    }
}
impl Drop for OwnerLock {
    fn drop(&mut self) {
        #[cfg(unix)]
        {
            use std::os::fd::AsRawFd;
            unsafe {
                libc::flock(self.file.as_raw_fd(), libc::LOCK_UN);
            }
        }
    }
}

fn record(events: &EventLog, kind: &str, effect_id: &str, payload: Value) -> Result<(), String> {
    events.append(
        STREAM,
        &json!({
            "type": kind,
            "actor": {"kind": "system", "id": "kernel-effect-owner"},
            "payload": {"effectId": effect_id, "details": payload},
        }),
    )?;
    Ok(())
}

#[derive(Default)]
struct OwnerState {
    seen: BTreeSet<String>,
    unresolved: BTreeMap<String, String>,
    /// Only versioned prepare records have a durable execute boundary.
    /// Legacy v1 prepares may have already mutated disk; NEVER auto-release.
    prepare_v2: BTreeSet<String>,
    count: usize,
}

/// Rebuild from the verifiable hash chain on EVERY admission. Never treat a
/// truncated/malformed/unknown transition as a clean state.
fn rebuild(events: &EventLog) -> Result<OwnerState, String> {
    let verified = events.verify(STREAM)?;
    if !verified.ok {
        return Err(format!(
            "HZ_PRECONDITION_FAILED: owner EventLog verification failed at {:?}",
            verified.broken_at,
        ));
    }
    let mut state = OwnerState::default();
    for event in events.read(STREAM, None, None)? {
        let kind = event
            .get("type")
            .and_then(Value::as_str)
            .ok_or_else(|| "HZ_PRECONDITION_FAILED: owner event type missing".to_string())?;
        let payload = event
            .get("payload")
            .ok_or_else(|| "HZ_PRECONDITION_FAILED: owner event payload missing".to_string())?;
        let effect_id = payload
            .get("effectId")
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
            .ok_or_else(|| "HZ_PRECONDITION_FAILED: owner effectId invalid".to_string())?;
        match kind {
            "owner.prepare" => {
                if !state.seen.insert(effect_id.to_string()) {
                    return Err("HZ_PRECONDITION_FAILED: duplicate owner effect id in log".into());
                }
                let version = payload["details"]["protocolVersion"].as_u64();
                match version {
                    None | Some(1) => {}
                    Some(2) => {
                        state.prepare_v2.insert(effect_id.into());
                    }
                    Some(other) => {
                        return Err(format!(
                            "HZ_PRECONDITION_FAILED: unsupported owner protocolVersion {other}"
                        ))
                    }
                }
                state.unresolved.insert(effect_id.into(), "prepared".into());
            }
            "owner.executing" => {
                if !state.prepare_v2.contains(effect_id)
                    || state.unresolved.get(effect_id).map(String::as_str) != Some("prepared")
                {
                    return Err(
                        "HZ_PRECONDITION_FAILED: orphan or duplicate owner executing marker".into(),
                    );
                }
                state
                    .unresolved
                    .insert(effect_id.into(), "executing".into());
            }
            "owner.released" => {
                if !state.prepare_v2.contains(effect_id)
                    || state.unresolved.get(effect_id).map(String::as_str) != Some("prepared")
                {
                    return Err(
                        "HZ_PRECONDITION_FAILED: owner release lacks a v2 prepare-only boundary"
                            .into(),
                    );
                }
                state.unresolved.remove(effect_id);
            }
            "owner.settled" | "owner.unknown" => {
                let prior = state
                    .unresolved
                    .get(effect_id)
                    .ok_or_else(|| "HZ_PRECONDITION_FAILED: orphan owner settlement".to_string())?;
                let expected = if state.prepare_v2.contains(effect_id) {
                    "executing"
                } else {
                    "prepared"
                };
                if prior != expected {
                    return Err(
                        "HZ_PRECONDITION_FAILED: duplicate or out-of-order owner settlement".into(),
                    );
                }
                if kind == "owner.settled" {
                    state.unresolved.remove(effect_id);
                } else {
                    state.unresolved.insert(effect_id.into(), "UNKNOWN".into());
                }
            }
            _ => {
                return Err(format!(
                    "HZ_PRECONDITION_FAILED: unexpected owner event type {kind}"
                ))
            }
        }
        state.count += 1;
    }
    Ok(state)
}

/// Chain-integrity alone is insufficient: receipt.effectId and postimage
/// sidecars are outside the canonical receipt hash. Every owner settlement
/// must match its exact kernel-issued receipt and the prepare intent digest.
/// This runs under OwnerLock and obtains a receipt-file lock for a coherent
/// verified snapshot. Unrelated legacy receipts are allowed.
fn verify_settlement_receipt_links(events: &EventLog, receipts: &Receipts) -> Result<(), String> {
    let records = receipts.read_verified()?;
    let mut by_id: BTreeMap<&str, &Value> = BTreeMap::new();
    for receipt in &records {
        let id = receipt["id"].as_str().ok_or_else(|| {
            "HZ_PRECONDITION_FAILED: owner receipt linkage: missing receipt id".to_string()
        })?;
        if by_id.insert(id, receipt).is_some() {
            return Err(
                "HZ_PRECONDITION_FAILED: owner receipt linkage: duplicate receipt id".into(),
            );
        }
    }
    let mut prepared: BTreeMap<String, (Value, Value, Value, Value)> = BTreeMap::new();
    let mut used: BTreeSet<String> = BTreeSet::new();
    for event in events.read(STREAM, None, None)? {
        let kind = event["type"].as_str().unwrap_or("");
        let effect_id = event["payload"]["effectId"].as_str().ok_or_else(|| {
            "HZ_PRECONDITION_FAILED: owner receipt linkage: event has no effectId".to_string()
        })?;
        let details = &event["payload"]["details"];
        if kind == "owner.prepare" {
            prepared.insert(
                effect_id.to_string(),
                (
                    details["argsDigest"].clone(),
                    details["dispatchKind"].clone(),
                    details["guardLeaseId"].clone(),
                    details["guardLeaseIds"].clone(),
                ),
            );
        }
        if kind != "owner.settled" {
            continue;
        }
        let receipt_id = details["receiptId"].as_str().ok_or_else(|| {
            "HZ_PRECONDITION_FAILED: owner receipt linkage: settlement receipt id missing"
                .to_string()
        })?;
        let receipt = by_id.get(receipt_id).ok_or_else(|| {
            "HZ_PRECONDITION_FAILED: owner receipt linkage: settlement receipt absent".to_string()
        })?;
        let Some((args_digest, dispatch_kind, guard_lease_id, guard_lease_ids)) =
            prepared.get(effect_id)
        else {
            return Err(
                "HZ_PRECONDITION_FAILED: owner receipt linkage: settlement without prepare".into(),
            );
        };
        if !used.insert(receipt_id.to_string())
            || receipt["id"] != details["receiptId"]
            || receipt["seq"] != details["receiptSeq"]
            || receipt["hash"] != details["receiptHash"]
            || receipt["resultDigest"] != details["resultDigest"]
            || receipt["argsDigest"] != *args_digest
            || receipt["tool"] != *dispatch_kind
            || (event["payload"]["details"]["guardDecision"] == "allow"
                && (receipt["leaseId"] != *guard_lease_id
                    || details["guardLeaseId"] != *guard_lease_id
                    || details["guardLeaseIds"] != *guard_lease_ids))
            || receipt["effectId"] != json!(effect_id)
            || receipt["action"] != json!("effect.execute")
        {
            return Err(format!(
                "HZ_PRECONDITION_FAILED: owner receipt linkage: settlement and receipt disagree for {effect_id}"
            ));
        }
    }
    Ok(())
}

/// Distinguish a real absent postimage from an inaccessible or unstable path.
/// A permission error is NOT proof that the file no longer exists.
fn independently_absent(path: &Path) -> Result<bool, String> {
    for _ in 0..2 {
        match fs::symlink_metadata(path) {
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Ok(_) => return Ok(false),
            Err(e) => {
                return Err(format!(
                    "HZ_PRECONDITION_FAILED: cannot observe postimage absence: {e}"
                ))
            }
        }
    }
    Ok(true)
}

/// Record the kernel-observed file postimage as a signed OwnerLog fact. These
/// evidence items are *not* a historical blob snapshot: later kernel effects
/// may legitimately supersede them. The standalone replay verifier compares
/// only the last settled observation per path against fresh disk reads.
fn settled_file_evidence(params: &Value, out: &Value, kind: &str) -> Result<Value, String> {
    let field = match kind {
        "fs.write" => "writePath",
        "fs.edit" => "editPath",
        "fs.delete" => "deletePath",
        "fs.rename" => "renameToPath",
        _ => return Ok(json!([])),
    };
    let target = out.get(field).and_then(Value::as_str).ok_or_else(|| {
        format!("HZ_PRECONDITION_FAILED: settled {kind} missing kernel postimage path")
    })?;
    if !Path::new(target).is_absolute() {
        return Err("HZ_PRECONDITION_FAILED: postimage evidence path must be absolute".into());
    }
    let mut records = Vec::new();
    if kind == "fs.delete" {
        // A dangling symlink is not an absent resource.
        if !independently_absent(Path::new(target))? {
            return Err("HZ_PRECONDITION_FAILED: delete postimage not independently absent".into());
        }
        records.push(json!({"path": target, "state": "absent"}));
    } else {
        let digest = out
            .get("contentDigest")
            .and_then(Value::as_str)
            .ok_or_else(|| {
                "HZ_PRECONDITION_FAILED: settled file mutation missing independent digest"
                    .to_string()
            })?;
        records.push(json!({"path": target, "state": "present", "digest": digest}));
    }
    if kind == "fs.rename" {
        let root = params
            .get("sandboxRoot")
            .and_then(Value::as_str)
            .ok_or_else(|| {
                "HZ_PRECONDITION_FAILED: rename evidence missing sandboxRoot".to_string()
            })?;
        let raw = params
            .get("dispatch")
            .and_then(|v| v.get("spec"))
            .and_then(|v| v.get("from"))
            .and_then(Value::as_str)
            .ok_or_else(|| "HZ_PRECONDITION_FAILED: rename evidence missing from".to_string())?;
        let from = Path::new(raw);
        let candidate = if from.is_absolute() {
            from.to_path_buf()
        } else {
            Path::new(root).join(from)
        };
        let _resolved = crate::guard::lexical_resolve(&candidate).ok_or_else(|| {
            "HZ_PRECONDITION_FAILED: rename evidence cannot resolve source".to_string()
        })?;
        // Check the SOURCE SPELLING with lstat, not the resolved target:
        // a dangling symlink at source must not be mistaken for an absent
        // post-rename path, nor be omitted from later replay checks.
        if !independently_absent(&candidate)? {
            return Err("HZ_PRECONDITION_FAILED: rename source not independently absent".into());
        }
        records.push(json!({
            "path": candidate.to_string_lossy(), "state": "absent",
        }));
    }
    Ok(json!(records))
}

/// Independent *latest-state* verifier. It never pretends to reconstruct an
/// overwritten historical postimage. Each path is checked using the latest
/// kernel-owned settled evidence. Legacy owner settlements without evidence
/// remain explicitly UNVERIFIABLE and cannot count toward full P0-2.
pub fn verify_latest_postimages(
    events: &EventLog,
    receipts: &Receipts,
    state_dir: &Path,
) -> Result<Value, String> {
    let _lock = OwnerLock::acquire(state_dir)?;
    let state = rebuild(events)?;
    verify_settlement_receipt_links(events, receipts)?;
    let owner_events = events.read(STREAM, None, None)?;
    let history = crate::effect_history::verify_history(state_dir, &owner_events, state.unresolved.len());
    let mut latest: BTreeMap<String, (String, String, Option<String>)> = BTreeMap::new();
    let mut legacy_unverifiable = 0usize;
    let mut unsupported_effects = 0usize;
    for event in owner_events {
        if event["type"] != "owner.settled" {
            continue;
        }
        let id = event["payload"]["effectId"]
            .as_str()
            .ok_or_else(|| "HZ_PRECONDITION_FAILED: owner evidence has no effect id".to_string())?;
        let details = &event["payload"]["details"];
        let Some(evidence) = details.get("postimages") else {
            legacy_unverifiable += 1;
            continue;
        };
        let rows = evidence.as_array().ok_or_else(|| {
            "HZ_PRECONDITION_FAILED: owner postimage evidence must be an array".to_string()
        })?;
        if rows.is_empty() {
            // A settled shell has verifiable output streams, but this
            // verifier cannot prove its filesystem or network side effects.
            unsupported_effects += 1;
        }
        for row in rows {
            let p = row["path"]
                .as_str()
                .filter(|p| Path::new(p).is_absolute())
                .ok_or_else(|| {
                    "HZ_PRECONDITION_FAILED: owner postimage evidence path invalid".to_string()
                })?;
            let state = row["state"].as_str().ok_or_else(|| {
                "HZ_PRECONDITION_FAILED: owner postimage evidence state invalid".to_string()
            })?;
            let digest = match state {
                "present" => Some(
                    row["digest"]
                        .as_str()
                        .filter(|v| {
                            v.len() == 64
                                && v.bytes()
                                    .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
                        })
                        .ok_or_else(|| {
                            "HZ_PRECONDITION_FAILED: owner postimage evidence digest invalid"
                                .to_string()
                        })?
                        .to_string(),
                ),
                "absent" => None,
                _ => {
                    return Err(
                        "HZ_PRECONDITION_FAILED: owner postimage evidence state unknown".into(),
                    )
                }
            };
            latest.insert(p.to_string(), (id.to_string(), state.to_string(), digest));
        }
    }
    let mut mismatches = Vec::new();
    for (path, (id, expected_state, expected_digest)) in &latest {
        let actual_state = if fs::symlink_metadata(path)
            .is_err_and(|e| e.kind() == std::io::ErrorKind::NotFound)
        {
            "absent"
        } else {
            "present"
        };
        let mut observed_digest = None;
        let stable = if expected_state == "present" && actual_state == "present" {
            let obs = crate::receipt_postimage::observe_file_postimage(Path::new(path));
            observed_digest = obs.digest;
            obs.observation_stable
        } else {
            // Two independent lstat probes; permission errors must not look
            // like an absent file (and dangling symlinks are present).
            let probe = || match fs::symlink_metadata(path) {
                Ok(_) => Some("present"),
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => Some("absent"),
                Err(_) => None,
            };
            probe() == Some(actual_state) && probe() == Some(actual_state)
        };
        if !stable
            || actual_state != expected_state
            || (expected_state == "present" && observed_digest.as_ref() != expected_digest.as_ref())
        {
            mismatches.push(json!({
                "effectId": id,
                "path": path,
                "expectedState": expected_state,
                "observedState": actual_state,
                "expectedDigest": expected_digest,
                "observedDigest": observed_digest,
                "observationStable": stable,
            }));
        }
    }
    Ok(json!({
        "ok": mismatches.is_empty() && legacy_unverifiable == 0 && unsupported_effects == 0 && state.unresolved.is_empty() && history["ok"] == true,
        "checked": latest.len(),
        "history": history,
        "legacyUnverifiable": legacy_unverifiable,
        "unsupportedEffects": unsupported_effects,
        "unresolved": state.unresolved.len(),
        "mismatches": mismatches,
        "scope": "latest_settled_file_postimage_only",
    }))
}

fn status_json(state: OwnerState) -> Value {
    let unresolved_ids: Vec<_> = state.unresolved.keys().take(32).cloned().collect();
    let recoverable_ids: Vec<_> = state
        .unresolved
        .iter()
        .filter(|(id, phase)| phase.as_str() == "prepared" && state.prepare_v2.contains(*id))
        .take(32)
        .map(|(id, _)| id.clone())
        .collect();
    json!({
        "blocked": !state.unresolved.is_empty(),
        "unresolved": state.unresolved.len(),
        "unresolvedIds": unresolved_ids,
        "recoverableIds": recoverable_ids,
        "events": state.count,
    })
}

pub fn status(events: &EventLog, state_dir: &Path) -> Result<Value, String> {
    let _lock = OwnerLock::acquire(state_dir)?;
    Ok(status_json(rebuild(events)?))
}

/// Narrow clean release for v2 PREPARE-only crash. The kernel never calls any
/// effect primitive before an fsynced owner.executing marker. Acquiring the
/// SAME OS lock as execute proves no concurrent owner is between the two
/// phases. A v1 prepare or an executing/UNKNOWN v2 is not safely recoverable.
/// Duplicate effect IDs remain reserved after release (no reexecution).
pub fn recover(
    events: &EventLog,
    receipts: &Receipts,
    state_dir: &Path,
    effect_id: &str,
) -> Result<Value, String> {
    if effect_id.trim().is_empty() {
        return Err(
            "HZ_PRECONDITION_FAILED: effect.owner.recover.effectId must be non-empty".into(),
        );
    }
    let _lock = OwnerLock::acquire(state_dir)?;
    let state = rebuild(events)?;
    verify_settlement_receipt_links(events, receipts)?;
    if !state.prepare_v2.contains(effect_id)
        || state.unresolved.get(effect_id).map(String::as_str) != Some("prepared")
    {
        return Err(format!(
            "HZ_PRECONDITION_FAILED: owner recovery refused for {effect_id}: execution may have started, effect is UNKNOWN, or record predates v2"
        ));
    }
    record(
        events,
        "owner.released",
        effect_id,
        json!({
            "protocolVersion": 2,
            "reason": "prepare_only_no_execute_marker",
            "terminal": "interrupted"
        }),
    )?;
    let after = rebuild(events)?;
    let mut value = status_json(after);
    value["released"] = json!(true);
    value["effectId"] = json!(effect_id);
    Ok(value)
}

pub fn verify(events: &EventLog, receipts: &Receipts, state_dir: &Path) -> Result<Value, String> {
    let _lock = OwnerLock::acquire(state_dir)?;
    let state = rebuild(events)?;
    let receipt_state = receipts.verify()?;
    if !receipt_state.ok {
        return Err("HZ_PRECONDITION_FAILED: owner cannot verify broken receipt chain".into());
    }
    verify_settlement_receipt_links(events, receipts)?;
    let history = crate::effect_history::verify_history(
        state_dir, &events.read(STREAM, None, None)?, state.unresolved.len()
    );
    if history["failures"].as_array().is_some_and(|rows| !rows.is_empty()) {
        return Err("HZ_PRECONDITION_FAILED: historical postimage archive verification failed".into());
    }
    Ok(json!({
        "ok": true,
        "historicalArchivedChecked": history["checked"],
        "historicalLegacyUnverifiable": history["legacyUnverifiable"],
        "events": state.count,
        "unresolved": state.unresolved.len(),
        "blocked": !state.unresolved.is_empty(),
        "receiptsVerified": receipt_state.count,
    }))
}

pub fn is_mutating(params: &Value) -> bool {
    let kind = params
        .get("dispatch")
        .and_then(|d| d.get("kind"))
        .and_then(Value::as_str)
        .unwrap_or("");
    matches!(
        kind.to_ascii_lowercase().as_str(),
        "fs.write" | "fs.edit" | "fs.delete" | "fs.rename" | "shell.exec"
    )
}

/// A caller's arbitrary sandboxRoot is never proof of permission to
/// rewrite the kernel's own OwnerLog, receipt chain, lockfile or policy.
/// Resolve all file targets symlink-aware; check BOTH rename endpoints.
/// Refuse unreadable walks before creating an owner prepare row.
fn refuse_kernel_state_target(state_dir: &Path, params: &Value, kind: &str) -> Result<(), String> {
    let sandbox = params
        .get("sandboxRoot")
        .and_then(Value::as_str)
        .unwrap_or("");
    let root = Path::new(sandbox);
    let spec = params.get("dispatch").and_then(|v| v.get("spec"));
    let fields: &[&str] = if kind == "fs.rename" {
        &["from", "to"]
    } else {
        &["path"]
    };
    for field in fields {
        let Some(raw) = spec
            .and_then(|v| v.get(*field))
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
        else {
            return Err(format!(
                "HZ_PRECONDITION_FAILED: missing mutation target {field}"
            ));
        };
        let raw_path = Path::new(raw);
        let candidate = if raw_path.is_absolute() {
            raw_path.to_path_buf()
        } else {
            root.join(raw_path)
        };
        let resolved = crate::guard::lexical_resolve(&candidate).ok_or_else(|| {
            "HZ_PRECONDITION_FAILED: mutation target cannot be resolved".to_string()
        })?;
        let state_resolved = crate::guard::lexical_resolve(state_dir).ok_or_else(|| {
            "HZ_PRECONDITION_FAILED: kernel state directory cannot be resolved".to_string()
        })?;
        if resolved == state_resolved
            || resolved.starts_with(&state_resolved)
            || state_resolved.starts_with(&resolved)
        {
            return Err(format!(
                "HZ_PRECONDITION_FAILED: kernel-state-protected: {} overlaps protected kernel state",
                raw
            ));
        }
    }
    Ok(())
}

/// Without verified product network/FS confinement, raw kernel shell.exec
/// cannot be an arbitrary-program bypass. Only known output-only programs are
/// accepted; scripts, interpreters, git, curl and user binaries refuse.
fn refuse_unconfined_shell(params: &Value) -> Result<(), String> {
    let program = params
        .get("dispatch")
        .and_then(|v| v.get("spec"))
        .and_then(|v| v.get("argv"))
        .and_then(Value::as_array)
        .and_then(|v| v.first())
        .and_then(Value::as_str)
        .unwrap_or("");
    const SAFE: &[&str] = &[
        "echo",
        "/bin/echo",
        "/usr/bin/echo",
        "true",
        "/bin/true",
        "/usr/bin/true",
        "false",
        "/bin/false",
        "/usr/bin/false",
        "pwd",
        "/bin/pwd",
        "/usr/bin/pwd",
    ];
    if !SAFE.contains(&program) {
        return Err(format!(
            "HZ_PRECONDITION_FAILED: unconfined shell.exec program {:?} refused by kernel; routed egress and filesystem confinement are not proven",
            program
        ));
    }
    Ok(())
}

/// Authorize an effect *inside* the same owner admission lock as execute
/// and settlement. A caller's previous guard.check result (or claimed leaseId)
/// is not authority: it may be stale, consumed, or minted in another process.
///
/// The existing Guard vocabulary has one mutating file kind, fs.write. Edits,
/// deletes and both rename endpoints map to that kind; inventing fs.edit or
/// fs.rename would make malformed policy rules silently inapplicable.
/// A shell request checks the exact argv-derived target as shell.exec, even
/// though its present kernel implementation permits only output-only commands.
/// No ask/deny ever creates a durable prepare or executes a primitive.
fn authorize_direct_effect(
    guard: &Guard,
    params: &Value,
    kind: &str,
) -> Result<Vec<String>, String> {
    let root = params
        .get("sandboxRoot")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| {
            "HZ_PRECONDITION_FAILED: effect.execute sandboxRoot required for authorization"
                .to_string()
        })?;
    let root = Path::new(root);
    let session_id = params
        .get("sessionId")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty());
    let mut targets: Vec<(String, String)> = Vec::new();
    if kind == "shell.exec" {
        let argv = params
            .get("dispatch")
            .and_then(|v| v.get("spec"))
            .and_then(|v| v.get("argv"))
            .and_then(Value::as_array)
            .ok_or_else(|| {
                "HZ_PRECONDITION_FAILED: shell.exec authorization requires argv".to_string()
            })?;
        if argv.is_empty() || argv.iter().any(|v| v.as_str().is_none_or(str::is_empty)) {
            return Err("HZ_PRECONDITION_FAILED: shell.exec authorization argv invalid".into());
        }
        let target = argv
            .iter()
            .map(|v| v.as_str().unwrap())
            .collect::<Vec<_>>()
            .join(" ");
        targets.push(("shell.exec".to_string(), target));
    } else {
        let spec = params
            .get("dispatch")
            .and_then(|v| v.get("spec"))
            .ok_or_else(|| {
                "HZ_PRECONDITION_FAILED: file authorization requires spec".to_string()
            })?;
        let fields: &[&str] = if kind == "fs.rename" {
            &["from", "to"]
        } else {
            &["path"]
        };
        for field in fields {
            let raw = spec
                .get(field)
                .and_then(Value::as_str)
                .filter(|v| !v.is_empty())
                .ok_or_else(|| {
                    format!("HZ_PRECONDITION_FAILED: mutation authorization missing {field}")
                })?;
            let path = Path::new(raw);
            let candidate = if path.is_absolute() {
                path.to_path_buf()
            } else {
                root.join(path)
            };
            // Never send a lexical escape or an unresolvable symlink walk to
            // policy as "workspace". The Guard decision is in addition to,
            // not a substitute for, the actual primitive's containment check.
            if !crate::guard::path_contained_in(root, &candidate) {
                return Err(format!(
                    "HZ_PRECONDITION_FAILED: Guard mutation target {field} outside sandboxRoot"
                ));
            }
            let resolved = crate::guard::lexical_resolve(&candidate)
                .ok_or_else(|| "HZ_PRECONDITION_FAILED: Guard target cannot resolve".to_string())?;
            targets.push((
                "fs.write".to_string(),
                resolved.to_string_lossy().into_owned(),
            ));
        }
    }
    let mut admitted_leases = Vec::new();
    for (guard_kind, target) in targets {
        let decision = guard
            .check(
                &GuardAction {
                    kind: guard_kind,
                    target,
                },
                Some("workspace"),
                &[],
                session_id,
            )
            .map_err(|e| format!("HZ_PRECONDITION_FAILED: Guard policy invalid: {e}"))?;
        if decision.decision != "allow" {
            return Err(format!(
                "HZ_PRECONDITION_FAILED: Guard {}: {}",
                decision.decision, decision.reason
            ));
        }
        if let Some(lease_id) = decision.lease_id {
            admitted_leases.push(lease_id);
        }
    }
    Ok(admitted_leases)
}

/// The kernel's durable five-step mutation seam. The OS lock is held across
/// the entire effect, independent postimage/digest observation and settlement.
/// A crash after prepare leaves a durably observable unresolved record; all
/// later kernel-owned mutations refuse until independently reconciled.
pub fn execute(
    events: &EventLog,
    receipts: &Receipts,
    state_dir: &Path,
    params: &Value,
    guard: &Guard,
    ledger: &mut HermeticEffectLedger,
) -> Result<Value, String> {
    if !is_mutating(params) {
        return effect_host::execute_params(params, ledger);
    }
    let id = params
        .get("effectId")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| "effect.execute.effectId must be a non-empty string".to_string())?;
    // The kernel primitive accepts case-insensitive names: owner admission
    // MUST normalize in the identical way, or FS.WRITE bypasses the lock.
    let canonical_kind = params["dispatch"]["kind"]
        .as_str()
        .unwrap()
        .to_ascii_lowercase();
    let kind = canonical_kind.as_str();
    // Do not create a pending row for a known ineligible shape: there is no
    // eligible kernel execute path, and the pure Rust dispatcher will refuse it.
    if params
        .get("sandboxRoot")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .is_none()
    {
        return effect_host::execute_params(params, ledger);
    }
    // Structural kernel state protection and unconfined shell refusal are
    // authorization prerequisites, not post-execution observations.
    if kind == "shell.exec" {
        refuse_unconfined_shell(params)?;
    } else {
        refuse_kernel_state_target(state_dir, params, kind)?;
    }

    let _lock = OwnerLock::acquire(state_dir)?;
    let state = rebuild(events)?;
    if !state.unresolved.is_empty() {
        return Err(format!(
            "HZ_PRECONDITION_FAILED: OwnerLog UNKNOWN: {} unresolved effect(s); mutation denied",
            state.unresolved.len(),
        ));
    }
    if state.seen.contains(id) {
        return Err(
            "HZ_PRECONDITION_FAILED: duplicate EffectHost effectId (replay cannot execute twice)"
                .into(),
        );
    }
    let receipt_verify = receipts.verify()?;
    if !receipt_verify.ok {
        return Err("HZ_PRECONDITION_FAILED: receipt chain broken; mutation denied".into());
    }
    verify_settlement_receipt_links(events, receipts)?;
    // A stale Bun patch/AST projection must be rejected BEFORE durable prepare,
    // so an ineligible preimage cannot poison OwnerLog with a fake UNKNOWN.
    effect_host::verify_expected_preimage(params, kind)?;
    // This Guard policy decision is made under the same cross-process lock
    // as prepare→execute→observe→settle. A separate caller-supplied guard.check
    // answer or leaseId is NEVER trusted as evidence of permission.
    let guard_lease_ids = authorize_direct_effect(guard, params, kind)?;
    // Legacy receipt v1 hashes at most one leaseId. Preserve its terminal
    // field, but record ALL consumed approval leases in the hashed OwnerLog
    // prepare/settle rows (rename can require two distinct approvals).
    let guard_lease_id = guard_lease_ids.last().cloned();
    let args_digest = crate::canon::sha256_hex(&crate::canon::canonical_json(params));
    record(
        events,
        "owner.prepare",
        id,
        json!({
            "dispatchKind": kind,
            "argsDigest": args_digest,
            "protocolVersion": 2,
            "guardDecision": "allow",
            "guardLeaseId": guard_lease_id,
            "guardLeaseIds": guard_lease_ids,
        }),
    )?;

    // Debug-only deterministic crash injection after durable prepare. The
    // kernel exits without running destructors or writing a settlement, while
    // the OS releases the cross-process flock. Release builds omit this hook.
    #[cfg(debug_assertions)]
    if std::env::var("HZ_EFFECT_OWNER_FAULT_AFTER_PREPARE")
        .ok()
        .as_deref()
        == Some("1")
    {
        std::process::exit(86);
    }

    // The only boundary after which any mutation may occur. If the process
    // dies with this marker, independent replay must remain UNKNOWN even if
    // the disk happens to resemble the preimage (ABA cannot be ruled out).
    record(
        events,
        "owner.executing",
        id,
        json!({ "protocolVersion": 2 }),
    )?;
    #[cfg(debug_assertions)]
    if std::env::var("HZ_EFFECT_OWNER_FAULT_AFTER_EXECUTING")
        .ok()
        .as_deref()
        == Some("1")
    {
        std::process::exit(87);
    }

    let result = effect_host::execute_params(params, ledger);
    match result {
        Ok(mut out)
            if out.get("verdict").and_then(Value::as_str) == Some("settled")
                && out.get("resultDigestStable").and_then(Value::as_bool) == Some(true) =>
        {
            // File effects already carry a kernel-derived output digest. Shell
            // carries independently observed stdout/stderr digests and exit
            // code; bind the entire kernel result shape into its owner receipt.
            // This digest is NOT a proof of shell filesystem/network effects.
            let digest = out
                .get("resultDigest")
                .and_then(Value::as_str)
                .map(str::to_string)
                .unwrap_or_else(|| crate::canon::sha256_hex(&crate::canon::canonical_json(&out)));
            let postimages = match settled_file_evidence(params, &out, kind) {
                Ok(postimages) => postimages,
                Err(error) => {
                    // Observation is part of settlement, never an advisory
                    // best effort. If evidence cannot be reconstructed,
                    // do not issue a settled receipt.
                    record(
                        events,
                        "owner.unknown",
                        id,
                        json!({
                            "cause": "postimage_evidence_unstable", "detail": error, "terminal": "unknown",
                        }),
                    )?;
                    return Err(error);
                }
            };
            // Persist the independently re-read bytes as immutable history
            // BEFORE issuing a settled receipt. Failure is UNKNOWN, never a
            // superficially successful effect with missing audit evidence.
            let postimages = match crate::effect_history::archive_postimages(state_dir, &postimages) {
                Ok(archive) => archive,
                Err(error) => {
                    record(events, "owner.unknown", id,
                        json!({"cause": "historical_postimage_archive_failed", "detail": error, "terminal": "unknown"}))?;
                    return Err(error);
                }
            };
            // RC-7 outcome spelling is independent of receipt settlement:
            // a nonzero shell exit still has a verifiable, settled receipt,
            // but its *terminal outcome* is failed, not succeeded.
            let terminal =
                if kind == "shell.exec" && out.get("exitCode").and_then(Value::as_i64) != Some(0) {
                    "failed"
                } else {
                    "succeeded"
                };
            let receipt = receipts.issue(&json!({
                "action": "effect.execute", "tool": kind,
                "argsDigest": args_digest, "resultDigest": digest, "effectId": id,
                "leaseId": guard_lease_id,
            }))?;
            let receipt_id = receipt["id"].as_str().unwrap();
            let receipt_seq = receipt["seq"].as_u64().unwrap();
            record(
                events,
                "owner.settled",
                id,
                json!({
                    "resultDigest": digest,
                    "receiptId": receipt_id,
                    "receiptSeq": receipt_seq,
                    "receiptHash": receipt["hash"],
                    "postimages": postimages,
                    "terminal": terminal,
                    "guardDecision": "allow",
                    "guardLeaseId": guard_lease_id,
                    "guardLeaseIds": guard_lease_ids,
                }),
            )?;
            out["ownerReceiptId"] = json!(receipt_id);
            out["ownerReceiptSeq"] = json!(receipt_seq);
            out["ownerResultDigest"] = json!(digest);
            out["ownerLogSettled"] = json!(true);
            if let Some(lease_id) = &guard_lease_id {
                out["ownerGuardLeaseId"] = json!(lease_id);
            }
            out["ownerGuardLeaseIds"] = json!(guard_lease_ids);
            Ok(out)
        }
        Ok(out) => {
            record(
                events,
                "owner.unknown",
                id,
                json!({"cause": "missing_or_unstable_independent_observation", "terminal": "unknown"}),
            )?;
            Ok(out)
        }
        Err(error) => {
            // Even if the tool claims failure, the kernel cannot prove it never
            // changed disk before the error. A terminal UNKNOWN blocks replay.
            record(
                events,
                "owner.unknown",
                id,
                json!({"cause": "execute_error", "terminal": "unknown"}),
            )?;
            Err(error)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::eventlog::AnchorConfig;
    #[test]
    fn tamper_and_unpaired_owner_rows_are_never_clean() {
        let root = std::env::temp_dir().join(format!("hz-owner-unit-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let events = EventLog::new_with_anchor(&root, AnchorConfig::default());
        assert_eq!(status(&events, &root).unwrap()["blocked"], false);
        record(&events, "owner.prepare", "pending", json!({})).unwrap();
        let receipts = Receipts::new_with_anchor(&root, AnchorConfig::default());
        // Legacy v1 had no "executing" marker, so an unpaired preparation
        // might ALREADY have executed: it cannot be released as clean.
        let refused = recover(&events, &receipts, &root, "pending").unwrap_err();
        assert!(refused.contains("execution may have started"), "{refused}");
        assert_eq!(status(&events, &root).unwrap()["recoverableIds"], json!([]));
        assert_eq!(status(&events, &root).unwrap()["unresolved"], 1);
        assert_eq!(status(&events, &root).unwrap()["blocked"], true);
        record(&events, "owner.settled", "pending", json!({})).unwrap();
        assert_eq!(status(&events, &root).unwrap()["blocked"], false);
        record(&events, "owner.settled", "pending", json!({})).unwrap();
        assert!(status(&events, &root).is_err());
        let _ = fs::remove_dir_all(&root);
    }
}
