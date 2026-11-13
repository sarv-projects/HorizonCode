//! Direct kernel EffectHost execute primitives. The cross-process OwnerLog and
//! independent kernel-issued receipt transaction now live in effect_owner.rs
//! (ruling 348). This module retains the pure reconcile helper and per-class
//! effects. Only direct Rust callers participating in effect_owner have that
//! OS-level admission fence; Bun and extensions do not.
//!
//! Pure reconcile of allow → execute → observe. The Bun loop owns the in-run
//! ledger, emits `hz.effect.settled` / `hz.effect.unknown`, and executes real
//! tools; this module is the kernel-side mirror (`effect.reconcile`) plus a
//! fail-closed `effect.execute` stub (ruling **243**): mutating dispatch kinds
//! are refused; hermetic `pure`/`echo`, sandboxed `fs.read` (**267**), and
//! sandboxed `fs.write` (**275**), sandboxed `fs.edit` (**277**), sandboxed
//! `fs.delete` (**296**), sandboxed `fs.rename` (**297**), sandboxed `shell.exec` (**278**, **314** digest observe), postimage double-read on write/edit (**279**), and
//! sandbox atomic temp+rename writes (**283**) run in-kernel; Bun still owns
//! unrestricted workspace writes, edits, and
//! ambient shell (not netns/Landlock-enforced).

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::Mutex;

use serde_json::{json, Value};

/// In-process allow → execute → observe rows for hermetic `effect.execute` only.
#[derive(Debug, Default)]
pub struct HermeticEffectLedger {
    phases: HashMap<String, Vec<EffectPhase>>,
}

impl HermeticEffectLedger {
    pub fn record_hermetic(&mut self, effect_id: &str) -> Vec<EffectPhase> {
        let row = vec![
            EffectPhase::Allow,
            EffectPhase::Execute,
            EffectPhase::Observe,
        ];
        self.phases.insert(effect_id.to_string(), row.clone());
        row
    }
}

/// Hermetic ledger shared across kernel NDJSON requests (selftest / integration).
pub type SharedHermeticLedger = Mutex<HermeticEffectLedger>;

const HERMETIC_OBSERVE_RECEIPT_ID: &str = "hermetic-observe";
const HERMETIC_OBSERVE_RECEIPT_SEQ: u64 = 1;

/// Dispatch kinds the kernel refuses — Bun owns real mutation and process effects.
const MUTATING_EXECUTE_KINDS: &[&str] = &[
    "fs.patch",
    "process.exec",
    "process.spawn",
    "files.write",
    "files.patch",
    "terminal.run",
    "net.fetch",
    "web.fetch",
    "artifact.write",
];

fn is_hermetic_execute_kind(kind: &str) -> bool {
    matches!(
        kind.trim().to_ascii_lowercase().as_str(),
        "pure" | "echo" | "test" | "fs.read" | "fs.write" | "fs.edit" | "fs.delete" | "fs.rename" | "shell.exec"
    )
}

const EMPTY_SHA256_HEX: &str = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

fn file_missing_stable(path: &Path) -> bool {
    !path.exists()
}

const SHELL_STDOUT_CAP: usize = 256 * 1024;
const SHELL_STDERR_CAP: usize = 64 * 1024;

fn is_mutating_execute_kind(kind: &str) -> bool {
    MUTATING_EXECUTE_KINDS
        .iter()
        .any(|k| kind.eq_ignore_ascii_case(k))
}

fn dispatch_kind(params: &Value) -> Result<&str, String> {
    let dispatch = params
        .get("dispatch")
        .and_then(|v| v.as_object())
        .ok_or_else(|| "effect.execute.dispatch must be an object".to_string())?;
    dispatch
        .get("kind")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .ok_or_else(|| "effect.execute.dispatch.kind must be a non-empty string".to_string())
}

fn string_param(params: &Value, key: &str) -> Result<String, String> {
    params
        .get(key)
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string())
        .ok_or_else(|| format!("effect.execute.{key} must be a non-empty string"))
}

fn optional_string_param(params: &Value, key: &str) -> Result<Option<String>, String> {
    match params.get(key) {
        None => Ok(None),
        Some(v) => v
            .as_str()
            .filter(|s| !s.is_empty())
            .map(|s| s.to_string())
            .ok_or_else(|| format!("effect.execute.{key} must be a non-empty string when present"))
            .map(Some),
    }
}

fn dispatch_spec(params: &Value) -> Result<&serde_json::Map<String, Value>, String> {
    let dispatch = params
        .get("dispatch")
        .and_then(|v| v.as_object())
        .ok_or_else(|| "effect.execute.dispatch must be an object".to_string())?;
    dispatch
        .get("spec")
        .and_then(|v| v.as_object())
        .ok_or_else(|| "effect.execute dispatch requires dispatch.spec".to_string())
}

fn read_path_from_spec(params: &Value) -> Result<String, String> {
    let spec = dispatch_spec(params)?;
    spec.get("path")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string())
        .ok_or_else(|| "effect.execute fs.read requires dispatch.spec.path".to_string())
}

fn write_path_from_spec(params: &Value) -> Result<String, String> {
    let spec = dispatch_spec(params)?;
    spec.get("path")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string())
        .ok_or_else(|| "effect.execute fs.write requires dispatch.spec.path".to_string())
}

fn edit_path_from_spec(params: &Value) -> Result<String, String> {
    let spec = dispatch_spec(params)?;
    spec.get("path")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string())
        .ok_or_else(|| "effect.execute fs.edit requires dispatch.spec.path".to_string())
}

fn rename_paths_from_spec(params: &Value) -> Result<(String, String), String> {
    let spec = dispatch_spec(params)?;
    let from = spec
        .get("from")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string())
        .ok_or_else(|| "effect.execute fs.rename requires dispatch.spec.from".to_string())?;
    let to = spec
        .get("to")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string())
        .ok_or_else(|| "effect.execute fs.rename requires dispatch.spec.to".to_string())?;
    Ok((from, to))
}

fn edit_old_new_from_spec(spec: &serde_json::Map<String, Value>) -> Result<(String, String), String> {
    let old = spec
        .get("oldString")
        .or_else(|| spec.get("old_string"))
        .and_then(|v| v.as_str())
        .ok_or_else(|| "effect.execute fs.edit requires dispatch.spec.oldString".to_string())?
        .to_string();
    let new = spec
        .get("newString")
        .or_else(|| spec.get("new_string"))
        .and_then(|v| v.as_str())
        .ok_or_else(|| "effect.execute fs.edit requires dispatch.spec.newString".to_string())?
        .to_string();
    Ok((old, new))
}

fn write_payload_from_spec(params: &Value) -> Result<Vec<u8>, String> {
    let spec = dispatch_spec(params)?;
    if let Some(text) = spec.get("text").and_then(|v| v.as_str()) {
        return Ok(text.as_bytes().to_vec());
    }
    if let Some(bytes) = spec.get("bytes") {
        if let Some(arr) = bytes.as_array() {
            let mut out = Vec::with_capacity(arr.len());
            for (i, item) in arr.iter().enumerate() {
                let n = item
                    .as_u64()
                    .ok_or_else(|| format!("effect.execute fs.write spec.bytes[{i}] must be a byte 0–255"))?;
                let b = u8::try_from(n).map_err(|_| {
                    format!("effect.execute fs.write spec.bytes[{i}] must be a byte 0–255")
                })?;
                out.push(b);
            }
            return Ok(out);
        }
        if let Some(s) = bytes.as_str() {
            return Ok(s.as_bytes().to_vec());
        }
    }
    Err(
        "HZ_PRECONDITION_FAILED: effect.execute fs.write requires dispatch.spec.text or dispatch.spec.bytes"
            .to_string(),
    )
}

fn candidate_read_path(sandbox_root: &Path, raw_path: &str) -> PathBuf {
    let path = Path::new(raw_path);
    if path.is_absolute() {
        path.to_path_buf()
    } else {
        sandbox_root.join(path)
    }
}

fn execute_fs_read(
    params: &Value,
    ledger: &mut HermeticEffectLedger,
    effect_id: &str,
) -> Result<Value, String> {
    let sandbox_root = string_param(params, "sandboxRoot")?;
    let raw_path = read_path_from_spec(params)?;
    let root = Path::new(&sandbox_root);
    let candidate = candidate_read_path(root, &raw_path);
    if !crate::guard::path_contained_in(root, &candidate) {
        return Err(
            "HZ_PRECONDITION_FAILED: effect.execute fs.read path must resolve inside sandboxRoot"
                .to_string(),
        );
    }
    let resolved = crate::guard::lexical_resolve(&candidate).ok_or_else(|| {
        "HZ_PRECONDITION_FAILED: effect.execute fs.read path could not be resolved".to_string()
    })?;
    if !resolved.is_file() {
        let phases = ledger.record_hermetic(effect_id);
        let verdict = reconcile(
            &phases,
            Some(HERMETIC_OBSERVE_RECEIPT_ID),
            Some(HERMETIC_OBSERVE_RECEIPT_SEQ),
            None,
            Some(true),
            None,
        );
        return Ok(json!({
            "verdict": verdict.as_str(),
            "effectId": effect_id,
            "phases": ["allow", "execute", "observe"],
            "readPath": resolved.to_string_lossy(),
            "postimageMissing": true,
        }));
    }
    let obs = crate::receipt_postimage::observe_file_postimage(&resolved);
    let phases = ledger.record_hermetic(effect_id);
    let verdict = reconcile(
        &phases,
        Some(HERMETIC_OBSERVE_RECEIPT_ID),
        Some(HERMETIC_OBSERVE_RECEIPT_SEQ),
        None,
        None,
        Some(obs.observation_stable),
    );
    let mut out = json!({
        "verdict": verdict.as_str(),
        "effectId": effect_id,
        "phases": ["allow", "execute", "observe"],
        "postimageObservationStable": obs.observation_stable,
        "readPath": resolved.to_string_lossy(),
    });
    if obs.observation_stable {
        if let Some(d) = obs.digest {
            out["contentDigest"] = json!(d);
        }
    } else if let Some(c) = obs.confirm_digest {
        out["postimageConfirmDigest"] = json!(c);
    }
    Ok(out)
}

fn execute_fs_edit(
    params: &Value,
    ledger: &mut HermeticEffectLedger,
    effect_id: &str,
) -> Result<Value, String> {
    let sandbox_root = string_param(params, "sandboxRoot")?;
    let raw_path = edit_path_from_spec(params)?;
    let spec = dispatch_spec(params)?;
    let (old, new) = edit_old_new_from_spec(spec)?;
    let root = Path::new(&sandbox_root);
    let candidate = candidate_read_path(root, &raw_path);
    if !crate::guard::path_contained_in(root, &candidate) {
        return Err(
            "HZ_PRECONDITION_FAILED: effect.execute fs.edit path must resolve inside sandboxRoot"
                .to_string(),
        );
    }
    let resolved = crate::guard::lexical_resolve(&candidate).ok_or_else(|| {
        "HZ_PRECONDITION_FAILED: effect.execute fs.edit path could not be resolved".to_string()
    })?;
    if !resolved.is_file() {
        return Err(
            "HZ_PRECONDITION_FAILED: effect.execute fs.edit requires an existing file".to_string(),
        );
    }
    let content = fs::read_to_string(&resolved).map_err(|e| {
        format!("HZ_PRECONDITION_FAILED: effect.execute fs.edit failed: {e}")
    })?;
    let edit_span = crate::effect_host_edit_repair::resolve_kernel_fs_edit_old_string(&content, &old)
        .map_err(|reason| match reason {
            crate::effect_host_edit_repair::EditResolveFail::Ambiguous => {
                "HZ_PRECONDITION_FAILED: effect.execute fs.edit oldString must match exactly once"
                    .to_string()
            }
            crate::effect_host_edit_repair::EditResolveFail::NotFound => {
                "HZ_PRECONDITION_FAILED: effect.execute fs.edit oldString not found in file".to_string()
            }
        })?;
    let replacement = crate::effect_host_edit_repair::render_fs_edit_replacement(&new, &edit_span, &content);
    let updated = format!(
        "{}{}{}",
        &content[..edit_span.start],
        replacement,
        &content[edit_span.end..]
    );
    crate::sandbox_atomic_write::write_bytes_atomic_in_sandbox(root, &resolved, updated.as_bytes())?;
    finish_fs_postimage_mutation_json(
        ledger,
        effect_id,
        "editPath",
        &raw_path,
        Some(crate::effect_evidence::FsMutationResultKind::Edit),
        None,
        &resolved,
    )
}

fn shell_argv_from_spec(params: &Value) -> Result<Vec<String>, String> {
    let spec = dispatch_spec(params)?;
    let argv_val = spec
        .get("argv")
        .and_then(|v| v.as_array())
        .ok_or_else(|| "effect.execute shell.exec requires dispatch.spec.argv (array)".to_string())?;
    if argv_val.is_empty() {
        return Err(
            "HZ_PRECONDITION_FAILED: effect.execute shell.exec argv must be non-empty".to_string(),
        );
    }
    let mut argv = Vec::with_capacity(argv_val.len());
    for (i, item) in argv_val.iter().enumerate() {
        let s = item
            .as_str()
            .ok_or_else(|| format!("effect.execute shell.exec spec.argv[{i}] must be a string"))?;
        if s.is_empty() {
            return Err(format!(
                "HZ_PRECONDITION_FAILED: effect.execute shell.exec spec.argv[{i}] must be non-empty"
            ));
        }
        if s.bytes().any(|b| b == b'\0' || b == b'\n' || b == b'\r') {
            return Err(format!(
                "HZ_PRECONDITION_FAILED: effect.execute shell.exec spec.argv[{i}] must not contain control characters"
            ));
        }
        argv.push(s.to_string());
    }
    Ok(argv)
}

fn shell_cwd_from_spec(params: &Value) -> Result<Option<String>, String> {
    let spec = dispatch_spec(params)?;
    match spec.get("cwd") {
        None => Ok(None),
        Some(v) => v
            .as_str()
            .filter(|s| !s.is_empty())
            .map(|s| s.to_string())
            .ok_or_else(|| "effect.execute shell.exec spec.cwd must be a non-empty string when present".to_string())
            .map(Some),
    }
}

fn cap_bytes(data: &[u8], cap: usize) -> (Vec<u8>, bool) {
    if data.len() <= cap {
        return (data.to_vec(), false);
    }
    (data[..cap].to_vec(), true)
}

fn execute_shell_exec(
    params: &Value,
    ledger: &mut HermeticEffectLedger,
    effect_id: &str,
) -> Result<Value, String> {
    let sandbox_root = string_param(params, "sandboxRoot")?;
    let argv = shell_argv_from_spec(params)?;
    let cwd_raw = shell_cwd_from_spec(params)?;
    let root = Path::new(&sandbox_root);
    let resolved_cwd = match cwd_raw {
        None => crate::guard::lexical_resolve(root).ok_or_else(|| {
            "HZ_PRECONDITION_FAILED: effect.execute shell.exec sandboxRoot could not be resolved"
                .to_string()
        })?,
        Some(ref raw) => {
            let candidate = candidate_read_path(root, raw);
            if !crate::guard::path_contained_in(root, &candidate) {
                return Err(
                    "HZ_PRECONDITION_FAILED: effect.execute shell.exec cwd must resolve inside sandboxRoot"
                        .to_string(),
                );
            }
            crate::guard::lexical_resolve(&candidate).ok_or_else(|| {
                "HZ_PRECONDITION_FAILED: effect.execute shell.exec cwd could not be resolved"
                    .to_string()
            })?
        }
    };
    let program = &argv[0];
    if program.contains('\0') {
        return Err(
            "HZ_PRECONDITION_FAILED: effect.execute shell.exec program must not contain NUL"
                .to_string(),
        );
    }
    let mut cmd = Command::new(program);
    cmd.args(&argv[1..]);
    cmd.current_dir(&resolved_cwd);
    cmd.env_clear();
    cmd.env("PATH", "/usr/bin:/bin");
    cmd.env("HOME", &resolved_cwd);
    cmd.env("LANG", "C.UTF-8");
    cmd.stdin(Stdio::null());
    cmd.stdout(Stdio::piped());
    cmd.stderr(Stdio::piped());
    let output = cmd.output().map_err(|e| {
        format!("HZ_PRECONDITION_FAILED: effect.execute shell.exec failed: {e}")
    })?;
    let exit_code = output
        .status
        .code()
        .ok_or_else(|| "HZ_PRECONDITION_FAILED: effect.execute shell.exec process terminated by signal".to_string())?;
    let (stdout, stdout_truncated) = cap_bytes(&output.stdout, SHELL_STDOUT_CAP);
    let (stderr, stderr_truncated) = cap_bytes(&output.stderr, SHELL_STDERR_CAP);
    let stdout_obs = crate::effect_evidence::observe_captured_stream_digest(&stdout);
    let stderr_obs = crate::effect_evidence::observe_captured_stream_digest(&stderr);
    let result_digest_stable =
        crate::effect_evidence::shell_exec_result_digest_stable(&stdout_obs, &stderr_obs);
    let phases = ledger.record_hermetic(effect_id);
    let verdict = reconcile(
        &phases,
        Some(HERMETIC_OBSERVE_RECEIPT_ID),
        Some(HERMETIC_OBSERVE_RECEIPT_SEQ),
        Some(result_digest_stable),
        None,
        None,
    );
    let mut out = json!({
        "verdict": verdict.as_str(),
        "effectId": effect_id,
        "phases": ["allow", "execute", "observe"],
        "exitCode": exit_code,
        "resultDigestStable": result_digest_stable,
        "shellCwd": resolved_cwd.to_string_lossy(),
        "stdoutTruncated": stdout_truncated,
        "stderrTruncated": stderr_truncated,
    });
    if stdout_obs.observation_stable {
        if let Some(d) = stdout_obs.digest {
            out["stdoutDigest"] = json!(d);
        }
    } else if let Some(c) = stdout_obs.confirm_digest {
        out["stdoutConfirmDigest"] = json!(c);
    }
    if stderr_obs.observation_stable {
        if let Some(d) = stderr_obs.digest {
            out["stderrDigest"] = json!(d);
        }
    } else if let Some(c) = stderr_obs.confirm_digest {
        out["stderrConfirmDigest"] = json!(c);
    }
    Ok(out)
}

fn execute_fs_delete(
    params: &Value,
    ledger: &mut HermeticEffectLedger,
    effect_id: &str,
) -> Result<Value, String> {
    let sandbox_root = string_param(params, "sandboxRoot")?;
    let raw_path = read_path_from_spec(params)?;
    let root = Path::new(&sandbox_root);
    let candidate = candidate_read_path(root, &raw_path);
    if !crate::guard::path_contained_in(root, &candidate) {
        return Err(
            "HZ_PRECONDITION_FAILED: effect.execute fs.delete path must resolve inside sandboxRoot"
                .to_string(),
        );
    }
    let resolved = crate::guard::lexical_resolve(&candidate).ok_or_else(|| {
        "HZ_PRECONDITION_FAILED: effect.execute fs.delete path could not be resolved".to_string()
    })?;
    crate::sandbox_atomic_write::delete_file_in_sandbox(root, &resolved)?;
    let primary_missing = file_missing_stable(&resolved);
    let confirm_missing = file_missing_stable(&resolved);
    let observation_stable = primary_missing && confirm_missing;
    let phases = ledger.record_hermetic(effect_id);
    let content_digest = if observation_stable {
        Some(EMPTY_SHA256_HEX)
    } else {
        None
    };
    let result_obs = crate::effect_evidence::observe_kernel_fs_mutation_result_digest(
        crate::effect_evidence::FsMutationResultKind::Delete,
        &raw_path,
        content_digest,
        None,
    );
    let verdict = reconcile(
        &phases,
        Some(HERMETIC_OBSERVE_RECEIPT_ID),
        Some(HERMETIC_OBSERVE_RECEIPT_SEQ),
        Some(result_obs.observation_stable),
        None,
        Some(observation_stable),
    );
    let mut out = json!({
        "verdict": verdict.as_str(),
        "effectId": effect_id,
        "phases": ["allow", "execute", "observe"],
        "postimageObservationStable": observation_stable,
        "resultDigestStable": result_obs.observation_stable,
        "deletePath": resolved.to_string_lossy(),
    });
    if observation_stable {
        out["contentDigest"] = json!(EMPTY_SHA256_HEX);
    }
    if let Some(d) = result_obs.digest {
        out["resultDigest"] = json!(d);
    }
    Ok(out)
}

fn execute_fs_rename(
    params: &Value,
    ledger: &mut HermeticEffectLedger,
    effect_id: &str,
) -> Result<Value, String> {
    let sandbox_root = string_param(params, "sandboxRoot")?;
    let (raw_from, raw_to) = rename_paths_from_spec(params)?;
    let root = Path::new(&sandbox_root);
    let from_candidate = candidate_read_path(root, &raw_from);
    let to_candidate = candidate_read_path(root, &raw_to);
    if !crate::guard::path_contained_in(root, &from_candidate) {
        return Err(
            "HZ_PRECONDITION_FAILED: effect.execute fs.rename source must resolve inside sandboxRoot"
                .to_string(),
        );
    }
    if !crate::guard::path_contained_in(root, &to_candidate) {
        return Err(
            "HZ_PRECONDITION_FAILED: effect.execute fs.rename destination must resolve inside sandboxRoot"
                .to_string(),
        );
    }
    let from_resolved = crate::guard::lexical_resolve(&from_candidate).ok_or_else(|| {
        "HZ_PRECONDITION_FAILED: effect.execute fs.rename source could not be resolved".to_string()
    })?;
    let to_resolved = crate::guard::lexical_resolve(&to_candidate).ok_or_else(|| {
        "HZ_PRECONDITION_FAILED: effect.execute fs.rename destination could not be resolved".to_string()
    })?;
    crate::sandbox_atomic_write::rename_file_in_sandbox(root, &from_resolved, &to_resolved)?;
    finish_fs_postimage_mutation_json(
        ledger,
        effect_id,
        "renameToPath",
        &raw_to,
        Some(crate::effect_evidence::FsMutationResultKind::Rename),
        Some(&raw_from),
        &to_resolved,
    )
}

fn execute_fs_write(
    params: &Value,
    ledger: &mut HermeticEffectLedger,
    effect_id: &str,
) -> Result<Value, String> {
    let sandbox_root = string_param(params, "sandboxRoot")?;
    let raw_path = write_path_from_spec(params)?;
    let payload = write_payload_from_spec(params)?;
    let root = Path::new(&sandbox_root);
    let candidate = candidate_read_path(root, &raw_path);
    if !crate::guard::path_contained_in(root, &candidate) {
        return Err(
            "HZ_PRECONDITION_FAILED: effect.execute fs.write path must resolve inside sandboxRoot"
                .to_string(),
        );
    }
    let resolved = crate::guard::lexical_resolve(&candidate).ok_or_else(|| {
        "HZ_PRECONDITION_FAILED: effect.execute fs.write path could not be resolved".to_string()
    })?;
    crate::sandbox_atomic_write::write_bytes_atomic_in_sandbox(root, &resolved, &payload)?;
    finish_fs_postimage_mutation_json(
        ledger,
        effect_id,
        "writePath",
        &raw_path,
        Some(crate::effect_evidence::FsMutationResultKind::Write),
        None,
        &resolved,
    )
}

fn finish_fs_postimage_mutation_json(
    ledger: &mut HermeticEffectLedger,
    effect_id: &str,
    path_field: &str,
    rel_path: &str,
    mutation: Option<crate::effect_evidence::FsMutationResultKind>,
    rel_from: Option<&str>,
    resolved: &Path,
) -> Result<Value, String> {
    let phases = ledger.record_hermetic(effect_id);
    let obs = crate::receipt_postimage::observe_file_postimage(resolved);
    let digest_for_output = if obs.observation_stable {
        obs.digest.as_deref()
    } else {
        None
    };
    let (result_digest_stable, result_digest) = match mutation {
        Some(kind) => {
            let result_obs = crate::effect_evidence::observe_kernel_fs_mutation_result_digest(
                kind,
                rel_path,
                digest_for_output,
                rel_from,
            );
            (
                Some(result_obs.observation_stable),
                result_obs.digest,
            )
        }
        None => (None, None),
    };
    let verdict = reconcile(
        &phases,
        Some(HERMETIC_OBSERVE_RECEIPT_ID),
        Some(HERMETIC_OBSERVE_RECEIPT_SEQ),
        result_digest_stable,
        None,
        Some(obs.observation_stable),
    );
    let mut out = json!({
        "verdict": verdict.as_str(),
        "effectId": effect_id,
        "phases": ["allow", "execute", "observe"],
        "postimageObservationStable": obs.observation_stable,
        path_field: resolved.to_string_lossy(),
    });
    if let Some(stable) = result_digest_stable {
        out["resultDigestStable"] = json!(stable);
    }
    if obs.observation_stable {
        if let Some(d) = obs.digest {
            out["contentDigest"] = json!(d);
        }
    } else if let Some(c) = obs.confirm_digest {
        out["postimageConfirmDigest"] = json!(c);
    }
    if let Some(d) = result_digest {
        out["resultDigest"] = json!(d);
    }
    Ok(out)
}

/// JSON-RPC `effect.execute` — fail-closed except hermetic pure/echo/fs.read/fs.write/fs.edit/shell.exec (sandboxed).
pub fn execute_params(params: &Value, ledger: &mut HermeticEffectLedger) -> Result<Value, String> {
    let effect_id = string_param(params, "effectId")?;
    let kind = dispatch_kind(params)?;
    if is_mutating_execute_kind(kind) {
        return Err(format!(
            "HZ_PRECONDITION_FAILED: effect.execute for dispatch kind {:?} is not implemented in the kernel; TypeScript owns real tool execution",
            kind
        ));
    }
    if kind.eq_ignore_ascii_case("fs.read") {
        return execute_fs_read(params, ledger, &effect_id);
    }
    if kind.eq_ignore_ascii_case("fs.write") {
        if optional_string_param(params, "sandboxRoot")?.is_none() {
            return Err(
                "HZ_PRECONDITION_FAILED: effect.execute for dispatch kind \"fs.write\" is not implemented in the kernel; TypeScript owns real tool execution".to_string(),
            );
        }
        return execute_fs_write(params, ledger, &effect_id);
    }
    if kind.eq_ignore_ascii_case("fs.edit") {
        if optional_string_param(params, "sandboxRoot")?.is_none() {
            return Err(
                "HZ_PRECONDITION_FAILED: effect.execute for dispatch kind \"fs.edit\" is not implemented in the kernel; TypeScript owns real tool execution".to_string(),
            );
        }
        return execute_fs_edit(params, ledger, &effect_id);
    }
    if kind.eq_ignore_ascii_case("fs.delete") {
        if optional_string_param(params, "sandboxRoot")?.is_none() {
            return Err(
                "HZ_PRECONDITION_FAILED: effect.execute for dispatch kind \"fs.delete\" is not implemented in the kernel; TypeScript owns real tool execution".to_string(),
            );
        }
        return execute_fs_delete(params, ledger, &effect_id);
    }
    if kind.eq_ignore_ascii_case("fs.rename") {
        if optional_string_param(params, "sandboxRoot")?.is_none() {
            return Err(
                "HZ_PRECONDITION_FAILED: effect.execute for dispatch kind \"fs.rename\" is not implemented in the kernel; TypeScript owns real tool execution".to_string(),
            );
        }
        return execute_fs_rename(params, ledger, &effect_id);
    }
    if kind.eq_ignore_ascii_case("shell.exec") {
        if optional_string_param(params, "sandboxRoot")?.is_none() {
            return Err(
                "HZ_PRECONDITION_FAILED: effect.execute for dispatch kind \"shell.exec\" is not implemented in the kernel; TypeScript owns real tool execution".to_string(),
            );
        }
        return execute_shell_exec(params, ledger, &effect_id);
    }
    if !is_hermetic_execute_kind(kind) {
        return Err(format!(
            "HZ_PRECONDITION_FAILED: effect.execute dispatch kind {:?} is unknown; only hermetic pure/echo/test/fs.read/fs.write/fs.edit/fs.delete/fs.rename/shell.exec (with sandboxRoot) are supported",
            kind
        ));
    }
    if optional_string_param(params, "sandboxRoot")?.is_some() {
        return Err(
            "HZ_PRECONDITION_FAILED: effect.execute sandboxRoot is only valid for fs.read, fs.write, fs.edit, fs.delete, fs.rename, and shell.exec"
                .to_string(),
        );
    }
    let phases = ledger.record_hermetic(&effect_id);
    let verdict = reconcile(
        &phases,
        Some(HERMETIC_OBSERVE_RECEIPT_ID),
        Some(HERMETIC_OBSERVE_RECEIPT_SEQ),
        None,
        None,
        None,
    );
    let mut out = json!({
        "verdict": verdict.as_str(),
        "effectId": effect_id,
        "phases": ["allow", "execute", "observe"],
    });
    if kind.eq_ignore_ascii_case("echo") {
        let echo = params
            .get("dispatch")
            .and_then(|d| d.get("spec"))
            .and_then(|s| s.get("echo"))
            .and_then(|v| v.as_str())
            .unwrap_or("");
        out["echo"] = json!(echo);
    }
    Ok(out)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EffectPhase {
    Allow,
    Execute,
    Observe,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EffectVerdict {
    Settled,
    Unknown,
}

impl EffectVerdict {
    pub fn as_str(self) -> &'static str {
        match self {
            EffectVerdict::Settled => "settled",
            EffectVerdict::Unknown => "unknown",
        }
    }
}

/// Settled only when allow, execute, and observe (with receipt id + seq) are present,
/// and optional observe evidence flags do not force `unknown` (docs/28 **257**, **260**, **279**).
pub fn reconcile(
    phases: &[EffectPhase],
    receipt_id: Option<&str>,
    receipt_seq: Option<u64>,
    result_digest_stable: Option<bool>,
    postimage_missing: Option<bool>,
    postimage_observation_stable: Option<bool>,
) -> EffectVerdict {
    let has_allow = phases.iter().any(|p| *p == EffectPhase::Allow);
    let has_execute = phases.iter().any(|p| *p == EffectPhase::Execute);
    let has_observe = phases.iter().any(|p| *p == EffectPhase::Observe);
    if !(has_allow && has_execute && has_observe) {
        return EffectVerdict::Unknown;
    }
    let lifecycle_ok = matches!(
        (receipt_id, receipt_seq),
        (Some(id), Some(_)) if !id.is_empty()
    );
    if !lifecycle_ok {
        return EffectVerdict::Unknown;
    }
    if crate::effect_evidence::evidence_forces_unknown(
        result_digest_stable,
        postimage_missing,
        postimage_observation_stable,
    ) {
        return EffectVerdict::Unknown;
    }
    EffectVerdict::Settled
}

fn parse_optional_bool(params: &Value, key: &str) -> Result<Option<bool>, String> {
    match params.get(key) {
        None => Ok(None),
        Some(v) => v
            .as_bool()
            .ok_or_else(|| format!("effect.reconcile.{key} must be a boolean when present"))
            .map(Some),
    }
}

fn parse_phase(raw: &str) -> Option<EffectPhase> {
    match raw.trim().to_ascii_lowercase().as_str() {
        "allow" => Some(EffectPhase::Allow),
        "execute" => Some(EffectPhase::Execute),
        "observe" => Some(EffectPhase::Observe),
        _ => None,
    }
}

/// JSON-RPC `effect.reconcile` params → `{ verdict }`.
pub fn reconcile_params(params: &Value) -> Result<Value, String> {
    let phases_val = params
        .get("phases")
        .and_then(|v| v.as_array())
        .ok_or_else(|| "effect.reconcile.phases must be an array".to_string())?;
    let mut phases = Vec::with_capacity(phases_val.len());
    for (i, item) in phases_val.iter().enumerate() {
        let s = item
            .as_str()
            .ok_or_else(|| format!("effect.reconcile.phases[{i}] must be a string"))?;
        let phase = parse_phase(s)
            .ok_or_else(|| format!("effect.reconcile.phases[{i}] unknown phase {s}"))?;
        phases.push(phase);
    }
    let receipt_id = params.get("receiptId").and_then(|v| v.as_str());
    let receipt_seq = params.get("receiptSeq").and_then(|v| v.as_u64());
    let result_digest_stable = parse_optional_bool(params, "resultDigestStable")?;
    let postimage_missing = parse_optional_bool(params, "postimageMissing")?;
    let postimage_observation_stable = parse_optional_bool(params, "postimageObservationStable")?;
    let verdict = reconcile(
        &phases,
        receipt_id,
        receipt_seq,
        result_digest_stable,
        postimage_missing,
        postimage_observation_stable,
    );
    Ok(json!({ "verdict": verdict.as_str() }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn settled_when_full_lifecycle() {
        let phases = [EffectPhase::Allow, EffectPhase::Execute, EffectPhase::Observe];
        assert_eq!(
            reconcile(&phases, Some("rcp-1"), Some(3), None, None, None),
            EffectVerdict::Settled
        );
    }

    #[test]
    fn unknown_without_observe() {
        let phases = [EffectPhase::Allow, EffectPhase::Execute];
        assert_eq!(
            reconcile(&phases, None, None, None, None, None),
            EffectVerdict::Unknown
        );
    }

    #[test]
    fn unknown_observe_without_receipt() {
        let phases = [EffectPhase::Allow, EffectPhase::Execute, EffectPhase::Observe];
        assert_eq!(
            reconcile(&phases, Some(""), Some(1), None, None, None),
            EffectVerdict::Unknown
        );
    }

    #[test]
    fn unknown_when_result_digest_unstable() {
        let phases = [EffectPhase::Allow, EffectPhase::Execute, EffectPhase::Observe];
        assert_eq!(
            reconcile(&phases, Some("r1"), Some(1), Some(false), None, None),
            EffectVerdict::Unknown
        );
        assert_eq!(
            reconcile(&phases, Some("r1"), Some(1), Some(true), None, None),
            EffectVerdict::Settled
        );
    }

    #[test]
    fn unknown_when_postimage_missing() {
        let phases = [EffectPhase::Allow, EffectPhase::Execute, EffectPhase::Observe];
        assert_eq!(
            reconcile(&phases, Some("r1"), Some(1), None, Some(true), None),
            EffectVerdict::Unknown
        );
        assert_eq!(
            reconcile(&phases, Some("r1"), Some(1), None, Some(false), None),
            EffectVerdict::Settled
        );
    }

    #[test]
    fn unknown_when_postimage_observation_unstable() {
        let phases = [EffectPhase::Allow, EffectPhase::Execute, EffectPhase::Observe];
        assert_eq!(
            reconcile(&phases, Some("r1"), Some(1), None, None, Some(false)),
            EffectVerdict::Unknown
        );
        assert_eq!(
            reconcile(&phases, Some("r1"), Some(1), None, None, Some(true)),
            EffectVerdict::Settled
        );
    }

    #[test]
    fn params_round_trip() {
        let out = reconcile_params(&json!({
            "phases": ["allow", "execute", "observe"],
            "receiptId": "r1",
            "receiptSeq": 2
        }))
        .unwrap();
        assert_eq!(out["verdict"], "settled");
    }

    #[test]
    fn params_evidence_flags_fail_closed() {
        let out = reconcile_params(&json!({
            "phases": ["allow", "execute", "observe"],
            "receiptId": "r1",
            "receiptSeq": 2,
            "resultDigestStable": false
        }))
        .unwrap();
        assert_eq!(out["verdict"], "unknown");

        let out = reconcile_params(&json!({
            "phases": ["allow", "execute", "observe"],
            "receiptId": "r1",
            "receiptSeq": 2,
            "postimageMissing": true
        }))
        .unwrap();
        assert_eq!(out["verdict"], "unknown");
    }

    #[test]
    fn params_rejects_non_bool_evidence() {
        let err = reconcile_params(&json!({
            "phases": ["allow", "execute", "observe"],
            "receiptId": "r1",
            "receiptSeq": 2,
            "resultDigestStable": "no"
        }))
        .unwrap_err();
        assert!(err.contains("resultDigestStable"));
    }

    #[test]
    fn execute_pure_settles_hermetic() {
        let mut ledger = HermeticEffectLedger::default();
        let out = execute_params(
            &json!({
                "effectId": "eff-hermetic-1",
                "dispatch": { "kind": "pure" }
            }),
            &mut ledger,
        )
        .unwrap();
        assert_eq!(out["verdict"], "settled");
        assert_eq!(out["effectId"], "eff-hermetic-1");
    }

    #[test]
    fn execute_echo_returns_spec() {
        let mut ledger = HermeticEffectLedger::default();
        let out = execute_params(
            &json!({
                "effectId": "eff-echo",
                "dispatch": { "kind": "echo", "spec": { "echo": "hz" } }
            }),
            &mut ledger,
        )
        .unwrap();
        assert_eq!(out["echo"], "hz");
    }

    #[test]
    fn execute_refuses_mutating_kind() {
        let mut ledger = HermeticEffectLedger::default();
        let err = execute_params(
            &json!({
                "effectId": "eff-mut",
                "dispatch": { "kind": "fs.write", "spec": { "path": "x" } }
            }),
            &mut ledger,
        )
        .unwrap_err();
        assert!(err.contains("HZ_PRECONDITION_FAILED"), "{}", err);
        assert!(err.contains("fs.write"), "{}", err);
        assert!(err.contains("TypeScript"), "{}", err);
    }

    #[test]
    fn execute_fs_write_in_sandbox_returns_postimage_digest() {
        let sandbox = std::env::temp_dir().join(format!("hz-eff-write-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&sandbox);
        std::fs::create_dir_all(&sandbox).unwrap();
        let expected = crate::canon::sha256_bytes(b"hz-write");

        let mut ledger = HermeticEffectLedger::default();
        let out = execute_params(
            &json!({
                "effectId": "eff-write",
                "sandboxRoot": sandbox.to_string_lossy(),
                "dispatch": { "kind": "fs.write", "spec": { "path": "out.bin", "text": "hz-write" } }
            }),
            &mut ledger,
        )
        .unwrap();
        assert_eq!(out["verdict"], "settled");
        assert_eq!(out["contentDigest"], expected);
        assert_eq!(out["postimageObservationStable"], true);
        assert_eq!(out["resultDigestStable"], true);
        assert!(out.get("resultDigest").and_then(|v| v.as_str()).is_some());
        let on_disk = std::fs::read(sandbox.join("out.bin")).unwrap();
        assert_eq!(on_disk, b"hz-write");
        let _ = std::fs::remove_dir_all(&sandbox);
    }

    #[test]
    fn execute_fs_write_rejects_escape() {
        let sandbox = std::env::temp_dir().join(format!("hz-eff-write-esc-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&sandbox);
        std::fs::create_dir_all(&sandbox).unwrap();
        let mut ledger = HermeticEffectLedger::default();
        let err = execute_params(
            &json!({
                "effectId": "eff-write-esc",
                "sandboxRoot": sandbox.to_string_lossy(),
                "dispatch": { "kind": "fs.write", "spec": { "path": "../outside", "text": "x" } }
            }),
            &mut ledger,
        )
        .unwrap_err();
        assert!(err.contains("sandboxRoot"), "{}", err);
        let _ = std::fs::remove_dir_all(&sandbox);
    }

    #[test]
    fn execute_fs_read_in_sandbox_returns_digest() {
        let sandbox = std::env::temp_dir().join(format!("hz-eff-read-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&sandbox);
        std::fs::create_dir_all(&sandbox).unwrap();
        let file = sandbox.join("probe.txt");
        std::fs::write(&file, b"hz-read").unwrap();
        let expected = crate::canon::sha256_bytes(b"hz-read");

        let mut ledger = HermeticEffectLedger::default();
        let out = execute_params(
            &json!({
                "effectId": "eff-read",
                "sandboxRoot": sandbox.to_string_lossy(),
                "dispatch": { "kind": "fs.read", "spec": { "path": "probe.txt" } }
            }),
            &mut ledger,
        )
        .unwrap();
        assert_eq!(out["verdict"], "settled");
        assert_eq!(out["contentDigest"], expected);
        assert_eq!(out["postimageObservationStable"], true);
        let _ = std::fs::remove_dir_all(&sandbox);
    }

    #[test]
    fn execute_fs_read_missing_postimage_missing_unknown() {
        let sandbox = std::env::temp_dir().join(format!("hz-eff-read-miss-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&sandbox);
        std::fs::create_dir_all(&sandbox).unwrap();
        let mut ledger = HermeticEffectLedger::default();
        let out = execute_params(
            &json!({
                "effectId": "eff-read-miss",
                "sandboxRoot": sandbox.to_string_lossy(),
                "dispatch": { "kind": "fs.read", "spec": { "path": "nope.txt" } }
            }),
            &mut ledger,
        )
        .unwrap();
        assert_eq!(out["verdict"], "unknown");
        assert_eq!(out["postimageMissing"], true);
        let _ = std::fs::remove_dir_all(&sandbox);
    }

    #[test]
    fn execute_fs_edit_in_sandbox_returns_postimage_digest() {
        let sandbox = std::env::temp_dir().join(format!("hz-eff-edit-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&sandbox);
        std::fs::create_dir_all(&sandbox).unwrap();
        std::fs::write(sandbox.join("src.txt"), b"alpha-beta-gamma").unwrap();
        let expected = crate::canon::sha256_bytes(b"alpha-OMEGA-gamma");

        let mut ledger = HermeticEffectLedger::default();
        let out = execute_params(
            &json!({
                "effectId": "eff-edit",
                "sandboxRoot": sandbox.to_string_lossy(),
                "dispatch": {
                    "kind": "fs.edit",
                    "spec": { "path": "src.txt", "oldString": "beta", "newString": "OMEGA" }
                }
            }),
            &mut ledger,
        )
        .unwrap();
        assert_eq!(out["verdict"], "settled");
        assert_eq!(out["contentDigest"], expected);
        assert_eq!(out["postimageObservationStable"], true);
        let on_disk = std::fs::read_to_string(sandbox.join("src.txt")).unwrap();
        assert_eq!(on_disk, "alpha-OMEGA-gamma");
        let _ = std::fs::remove_dir_all(&sandbox);
    }

    #[test]
    fn execute_fs_edit_fails_when_old_missing() {
        let sandbox = std::env::temp_dir().join(format!("hz-eff-edit-miss-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&sandbox);
        std::fs::create_dir_all(&sandbox).unwrap();
        std::fs::write(sandbox.join("src.txt"), b"hello").unwrap();
        let mut ledger = HermeticEffectLedger::default();
        let err = execute_params(
            &json!({
                "effectId": "eff-edit-miss",
                "sandboxRoot": sandbox.to_string_lossy(),
                "dispatch": {
                    "kind": "fs.edit",
                    "spec": { "path": "src.txt", "oldString": "nope", "newString": "x" }
                }
            }),
            &mut ledger,
        )
        .unwrap_err();
        assert!(err.contains("oldString not found"), "{}", err);
        let _ = std::fs::remove_dir_all(&sandbox);
    }

    #[test]
    fn execute_shell_exec_in_sandbox_returns_digests() {
        let sandbox = std::env::temp_dir().join(format!("hz-eff-shell-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&sandbox);
        std::fs::create_dir_all(&sandbox).unwrap();
        let expected_out = crate::canon::sha256_bytes(b"hello\n");

        let mut ledger = HermeticEffectLedger::default();
        let out = execute_params(
            &json!({
                "effectId": "eff-shell",
                "sandboxRoot": sandbox.to_string_lossy(),
                "dispatch": { "kind": "shell.exec", "spec": { "argv": ["echo", "hello"] } }
            }),
            &mut ledger,
        )
        .unwrap();
        assert_eq!(out["verdict"], "settled");
        assert_eq!(out["exitCode"], 0);
        assert_eq!(out["stdoutDigest"], expected_out);
        assert_eq!(out["resultDigestStable"], true);
        let _ = std::fs::remove_dir_all(&sandbox);
    }

    #[test]
    fn execute_shell_exec_unknown_when_result_digest_unstable() {
        let phases = vec![
            EffectPhase::Allow,
            EffectPhase::Execute,
            EffectPhase::Observe,
        ];
        let verdict = reconcile(
            &phases,
            Some(HERMETIC_OBSERVE_RECEIPT_ID),
            Some(HERMETIC_OBSERVE_RECEIPT_SEQ),
            Some(false),
            None,
            None,
        );
        assert_eq!(verdict, EffectVerdict::Unknown);
    }

    #[test]
    fn execute_shell_exec_without_sandbox_refused() {
        let mut ledger = HermeticEffectLedger::default();
        let err = execute_params(
            &json!({
                "effectId": "eff-shell-open",
                "dispatch": { "kind": "shell.exec", "spec": { "argv": ["true"] } }
            }),
            &mut ledger,
        )
        .unwrap_err();
        assert!(err.contains("shell.exec"), "{}", err);
        assert!(err.contains("TypeScript"), "{}", err);
    }

    #[test]
    fn execute_shell_exec_cwd_escape_refused() {
        let sandbox = std::env::temp_dir().join(format!("hz-eff-shell-cwd-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&sandbox);
        std::fs::create_dir_all(&sandbox).unwrap();
        let mut ledger = HermeticEffectLedger::default();
        let err = execute_params(
            &json!({
                "effectId": "eff-shell-cwd",
                "sandboxRoot": sandbox.to_string_lossy(),
                "dispatch": {
                    "kind": "shell.exec",
                    "spec": { "argv": ["pwd"], "cwd": "../" }
                }
            }),
            &mut ledger,
        )
        .unwrap_err();
        assert!(err.contains("sandboxRoot"), "{}", err);
        let _ = std::fs::remove_dir_all(&sandbox);
    }

    #[test]
    fn execute_fs_read_rejects_escape() {
        let sandbox = std::env::temp_dir().join(format!("hz-eff-read-esc-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&sandbox);
        std::fs::create_dir_all(&sandbox).unwrap();
        let mut ledger = HermeticEffectLedger::default();
        let err = execute_params(
            &json!({
                "effectId": "eff-read-esc",
                "sandboxRoot": sandbox.to_string_lossy(),
                "dispatch": { "kind": "fs.read", "spec": { "path": "../outside" } }
            }),
            &mut ledger,
        )
        .unwrap_err();
        assert!(err.contains("sandboxRoot"), "{}", err);
        let _ = std::fs::remove_dir_all(&sandbox);
    }
}
