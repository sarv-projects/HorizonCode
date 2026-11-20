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
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::Mutex;
use std::thread;
use std::time::{Duration, Instant};

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
        "pure"
            | "echo"
            | "test"
            | "fs.read"
            | "fs.write"
            | "fs.edit"
            | "fs.delete"
            | "fs.rename"
            | "fs.batch"
            | "shell.exec"
    )
}

const EMPTY_SHA256_HEX: &str = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

fn file_missing_stable(path: &Path) -> bool {
    !path.exists()
}

const SHELL_STDOUT_CAP: usize = 256 * 1024;
const SHELL_STDERR_CAP: usize = 64 * 1024;
/// Hard wall for kernel-routed `shell.exec` so a hung child cannot deadlock the
/// OwnerLog flock + handle_gate forever (ruling 660). Overridable via
/// `HZ_SHELL_EXEC_TIMEOUT_MS` (minimum 1_000).
const SHELL_EXEC_TIMEOUT_DEFAULT_MS: u64 = 120_000;

fn shell_exec_timeout() -> Duration {
    let ms = std::env::var("HZ_SHELL_EXEC_TIMEOUT_MS")
        .ok()
        .and_then(|s| s.parse::<u64>().ok())
        .unwrap_or(SHELL_EXEC_TIMEOUT_DEFAULT_MS)
        .max(1_000);
    Duration::from_millis(ms)
}

/// PATH for hermetic shell.exec: keep a scrubbed env (`env_clear`) but include
/// common toolchain prefixes so `bun`/`cargo`/`node`/`uv` remain reachable
/// without inheriting the full parent environment (ruling 660).
fn shell_exec_path() -> String {
    let mut parts: Vec<String> = Vec::new();
    if let Ok(home) = std::env::var("HOME") {
        for sub in [".bun/bin", ".cargo/bin", ".local/bin"] {
            parts.push(format!("{home}/{sub}"));
        }
    }
    #[cfg(target_os = "macos")]
    parts.push("/opt/homebrew/bin".to_string());
    for p in ["/usr/local/bin", "/usr/bin", "/bin"] {
        parts.push(p.to_string());
    }
    if let Ok(parent) = std::env::var("PATH") {
        for p in parent.split(':') {
            if p.is_empty() {
                continue;
            }
            if !parts.iter().any(|x| x == p) {
                parts.push(p.to_string());
            }
        }
    }
    parts.join(":")
}

fn shell_exec_wrap_disabled() -> bool {
    std::env::var("HZ_SANDBOX_EXEC")
        .map(|value| value.trim() == "0")
        .unwrap_or(false)
}

/// Fail-closed when product posture requires hz-sandbox-exec wrap (ruling **730**).
fn shell_exec_require_wrap() -> bool {
    std::env::var("HZ_SANDBOX_REQUIRE")
        .map(|value| value.trim() == "1")
        .unwrap_or(false)
        || std::env::var("HZ_SHELL_EXEC_REQUIRE_WRAP")
            .map(|value| value.trim() == "1")
            .unwrap_or(false)
}

fn shell_exec_wrap_unavailable_reason() -> &'static str {
    if shell_exec_wrap_disabled() {
        "HZ_SANDBOX_EXEC=0 disables hz-sandbox-exec wrap"
    } else {
        "hz-sandbox-exec not found"
    }
}

/// Spawn plan for kernel-routed `shell.exec` (ruling **660**/**675**): wrap argv
/// through `hz-sandbox-exec` when the helper resolves; otherwise run bare argv
/// and report honestly unless require-wrap refuses (never shell-net `enforced`).
fn shell_exec_spawn(
    argv: &[String],
    sandbox_root: &Path,
    cwd: &Path,
) -> Result<(Command, bool, String, Option<String>), String> {
    let (child_net, wsl_default) = crate::sandbox::resolve_child_net(
        std::env::var("HZ_SANDBOX_CHILD_NET").ok().as_deref(),
        crate::sandbox::host_is_wsl(),
    );
    let path_value = shell_exec_path();
    let wrap_reason = |wrapped: bool| -> String {
        if !wrapped {
            if shell_exec_wrap_disabled() {
                return "HZ_SANDBOX_EXEC=0 — bare argv exec (no OS sandbox confinement; never shell-net enforced)"
                    .to_string();
            }
            return "hz-sandbox-exec not found — bare argv exec (no OS sandbox confinement; never shell-net enforced)"
                .to_string();
        }
        if wsl_default {
            "wrapped via hz-sandbox-exec (WSL child_net defaults to on — network egress NOT confined; never shell-net enforced)".to_string()
        } else if child_net == "on" {
            "wrapped via hz-sandbox-exec (HZ_SANDBOX_CHILD_NET=on — network egress NOT confined; never shell-net enforced)".to_string()
        } else {
            "wrapped via hz-sandbox-exec (process/FS confinement applied; child_net=off does not imply product egress enforced)".to_string()
        }
    };
    if shell_exec_wrap_disabled() || crate::sandbox::resolve_sandbox_exec_binary().is_none() {
        if shell_exec_require_wrap() {
            return Err(format!(
                "HZ_PRECONDITION_FAILED: HZ_SANDBOX_REQUIRE=1 (or HZ_SHELL_EXEC_REQUIRE_WRAP=1) but {} — kernel shell.exec refuses bare argv (never shell-net enforced)",
                shell_exec_wrap_unavailable_reason()
            ));
        }
        let program = &argv[0];
        let mut cmd = Command::new(program);
        cmd.args(&argv[1..]);
        cmd.current_dir(cwd);
        cmd.env_clear();
        cmd.env("PATH", &path_value);
        cmd.env("HOME", cwd);
        cmd.env("LANG", "C.UTF-8");
        return Ok((cmd, false, wrap_reason(false), None));
    }
    let binary = crate::sandbox::resolve_sandbox_exec_binary().unwrap();
    let exec_display = binary.display().to_string();
    let mut cmd = Command::new(&binary);
    cmd.arg("--");
    cmd.args(argv);
    cmd.current_dir(cwd);
    cmd.env_clear();
    cmd.env("PATH", &path_value);
    cmd.env("HOME", cwd);
    cmd.env("LANG", "C.UTF-8");
    cmd.env(
        "HZ_SANDBOX_FS_ROOT",
        sandbox_root.to_string_lossy().as_ref(),
    );
    cmd.env("HZ_SANDBOX_FS_MODE", "workspace-write");
    cmd.env("HZ_SANDBOX_CHILD_NET", &child_net);
    Ok((
        cmd,
        true,
        wrap_reason(true),
        Some(exec_display),
    ))
}

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

fn verify_one_write_preimage(
    root: &Path,
    raw_path: &str,
    expected: &Value,
    allow_null_missing: bool,
) -> Result<(), String> {
    let candidate = candidate_read_path(root, raw_path);
    if !crate::guard::path_contained_in(root, &candidate) {
        return Err("HZ_PRECONDITION_FAILED: preimage target outside sandboxRoot".into());
    }
    let resolved = crate::guard::lexical_resolve(&candidate)
        .ok_or_else(|| "HZ_PRECONDITION_FAILED: cannot resolve preimage target".to_string())?;
    match expected {
        Value::Null if allow_null_missing => {
            // Catch even a dangling symlink at the candidate spelling.
            if fs::symlink_metadata(&candidate).is_ok() {
                return Err("HZ_PRECONDITION_FAILED: preimage missing-file assertion failed".into());
            }
        }
        Value::String(s)
            if s.len() == 64
                && s.bytes()
                    .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)) =>
        {
            let obs = crate::receipt_postimage::observe_file_postimage(&resolved);
            if !obs.observation_stable {
                return Err("HZ_PRECONDITION_FAILED: independent preimage observation unstable".into());
            }
            if obs.digest.as_deref() != Some(s.as_str()) {
                return Err("HZ_PRECONDITION_FAILED: preimage digest mismatch".into());
            }
        }
        _ => {
            return Err(
                "HZ_PRECONDITION_FAILED: expectedPreimageDigest must be lowercase sha256 hex (or null for new fs.write)"
                    .into(),
            );
        }
    }
    Ok(())
}

/// Additive preimage compare-and-observe contract. Caller-pinned bytes are
/// independently double-read by Rust under OwnerLog before durable prepare
/// and rechecked just before file effects. External filesystem TOCTOU remains.
/// Reduced `fs.batch` verifies *every* exact write op before any mutation.
pub fn verify_expected_preimage(params: &Value, kind: &str) -> Result<(), String> {
    let Some(spec) = params
        .get("dispatch")
        .and_then(|v| v.get("spec"))
        .and_then(Value::as_object)
    else {
        return Ok(());
    };
    if kind == "fs.batch" {
        let ops = parse_fs_batch_write_ops(params)?;
        let root = PathBuf::from(string_param(params, "sandboxRoot")?);
        for op in ops {
            let kind = op.get("kind").and_then(Value::as_str).unwrap_or("");
            let is_rename = kind.eq_ignore_ascii_case("fs.rename");
            let is_write = kind.eq_ignore_ascii_case("fs.write");
            let Some(expected) = op.get("expectedPreimageDigest") else {
                continue;
            };
            let raw_path = if is_rename {
                op.get("from")
                    .and_then(Value::as_str)
                    .filter(|s| !s.is_empty())
                    .ok_or_else(|| {
                        "HZ_PRECONDITION_FAILED: fs.batch rename preimage pin requires from"
                            .to_string()
                    })?
            } else {
                op.get("path")
                    .and_then(Value::as_str)
                    .filter(|s| !s.is_empty())
                    .ok_or_else(|| {
                        "HZ_PRECONDITION_FAILED: fs.batch write op requires path".to_string()
                    })?
            };
            // Only fs.write may pin null (= assert missing). Edit/rename/delete pin bytes.
            verify_one_write_preimage(&root, raw_path, expected, is_write)?;
        }
        return Ok(());
    }
    let Some(expected) = spec.get("expectedPreimageDigest") else {
        return Ok(());
    };
    let raw_path = spec
        .get(if kind == "fs.rename" { "from" } else { "path" })
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| "HZ_PRECONDITION_FAILED: preimage pin requires a path".to_string())?;
    let root = PathBuf::from(string_param(params, "sandboxRoot")?);
    verify_one_write_preimage(&root, raw_path, expected, kind == "fs.write")
}

/// Reduced multi-file exact ownership: list of exact `fs.write`, `fs.edit`,
/// `fs.rename`, and/or `fs.delete` ops (optional expectedPreimageDigest).
/// Fuzzy/ambiguous plans still refuse at the TS projector.
pub fn parse_fs_batch_write_ops(
    params: &Value,
) -> Result<Vec<&serde_json::Map<String, Value>>, String> {
    let spec = dispatch_spec(params)?;
    let ops = spec
        .get("ops")
        .and_then(Value::as_array)
        .ok_or_else(|| {
            "HZ_PRECONDITION_FAILED: effect.execute fs.batch requires dispatch.spec.ops array"
                .to_string()
        })?;
    if ops.is_empty() {
        return Err(
            "HZ_PRECONDITION_FAILED: effect.execute fs.batch requires a non-empty ops list"
                .to_string(),
        );
    }
    let mut out = Vec::with_capacity(ops.len());
    for (i, op) in ops.iter().enumerate() {
        let obj = op.as_object().ok_or_else(|| {
            format!("HZ_PRECONDITION_FAILED: fs.batch ops[{i}] must be an object")
        })?;
        let kind = obj
            .get("kind")
            .and_then(Value::as_str)
            .unwrap_or("");
        let is_write = kind.eq_ignore_ascii_case("fs.write");
        let is_edit = kind.eq_ignore_ascii_case("fs.edit");
        let is_rename = kind.eq_ignore_ascii_case("fs.rename");
        let is_delete = kind.eq_ignore_ascii_case("fs.delete");
        if !is_write && !is_edit && !is_rename && !is_delete {
            return Err(format!(
                "HZ_PRECONDITION_FAILED: fs.batch accepts only exact fs.write/fs.edit/fs.rename/fs.delete ops; refused mixed/non-write kind {kind:?} at ops[{i}]"
            ));
        }
        if is_rename {
            let from = obj
                .get("from")
                .and_then(Value::as_str)
                .filter(|s| !s.is_empty());
            let to = obj
                .get("to")
                .and_then(Value::as_str)
                .filter(|s| !s.is_empty());
            if from.is_none() || to.is_none() {
                return Err(format!(
                    "HZ_PRECONDITION_FAILED: fs.batch ops[{i}] fs.rename requires from and to"
                ));
            }
            out.push(obj);
            continue;
        }
        if is_delete {
            let path = obj
                .get("path")
                .and_then(Value::as_str)
                .filter(|s| !s.is_empty());
            if path.is_none() {
                return Err(format!(
                    "HZ_PRECONDITION_FAILED: fs.batch ops[{i}] fs.delete requires path"
                ));
            }
            out.push(obj);
            continue;
        }
        let path = obj
            .get("path")
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty());
        if path.is_none() {
            return Err(format!(
                "HZ_PRECONDITION_FAILED: fs.batch ops[{i}] {} requires path",
                if is_edit { "fs.edit" } else { "fs.write" }
            ));
        }
        if is_write
            && obj.get("text").and_then(Value::as_str).is_none()
            && obj.get("bytes").is_none()
        {
            return Err(format!(
                "HZ_PRECONDITION_FAILED: fs.batch ops[{i}] fs.write requires text or bytes"
            ));
        }
        if is_edit {
            if obj.get("oldString").and_then(Value::as_str).is_none() {
                return Err(format!(
                    "HZ_PRECONDITION_FAILED: fs.batch ops[{i}] fs.edit requires oldString"
                ));
            }
            if obj.get("newString").and_then(Value::as_str).is_none() {
                return Err(format!(
                    "HZ_PRECONDITION_FAILED: fs.batch ops[{i}] fs.edit requires newString"
                ));
            }
        }
        out.push(obj);
    }
    Ok(out)
}

fn batch_edit_payload_on_content(
    content: &str,
    op: &serde_json::Map<String, Value>,
) -> Result<Vec<u8>, String> {
    let old = op
        .get("oldString")
        .and_then(Value::as_str)
        .ok_or_else(|| {
            "HZ_PRECONDITION_FAILED: effect.execute fs.batch fs.edit requires oldString".to_string()
        })?;
    let new = op
        .get("newString")
        .and_then(Value::as_str)
        .ok_or_else(|| {
            "HZ_PRECONDITION_FAILED: effect.execute fs.batch fs.edit requires newString".to_string()
        })?;
    let edit_span = crate::effect_host_edit_repair::resolve_kernel_fs_edit_old_string(content, old)
        .map_err(|reason| match reason {
            crate::effect_host_edit_repair::EditResolveFail::Ambiguous => {
                "HZ_PRECONDITION_FAILED: effect.execute fs.batch fs.edit oldString must match exactly once"
                    .to_string()
            }
            crate::effect_host_edit_repair::EditResolveFail::NotFound => {
                "HZ_PRECONDITION_FAILED: effect.execute fs.batch fs.edit oldString not found in file"
                    .to_string()
            }
        })?;
    let replacement =
        crate::effect_host_edit_repair::render_fs_edit_replacement(new, &edit_span, content);
    let updated = format!(
        "{}{}{}",
        &content[..edit_span.start],
        replacement,
        &content[edit_span.end..]
    );
    Ok(updated.into_bytes())
}

fn write_payload_from_op(op: &serde_json::Map<String, Value>) -> Result<Vec<u8>, String> {
    if let Some(text) = op.get("text").and_then(|v| v.as_str()) {
        return Ok(text.as_bytes().to_vec());
    }
    if let Some(bytes) = op.get("bytes") {
        if let Some(arr) = bytes.as_array() {
            let mut out = Vec::with_capacity(arr.len());
            for (i, item) in arr.iter().enumerate() {
                let n = item.as_u64().ok_or_else(|| {
                    format!("effect.execute fs.batch write spec.bytes[{i}] must be a byte 0–255")
                })?;
                let b = u8::try_from(n).map_err(|_| {
                    format!("effect.execute fs.batch write spec.bytes[{i}] must be a byte 0–255")
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
        "HZ_PRECONDITION_FAILED: effect.execute fs.batch write requires text or bytes".to_string(),
    )
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
    verify_expected_preimage(params, "fs.edit")?;
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
    let resolved = crate::sandbox_path_verify::recheck_path_in_sandbox(root, &candidate, Some(&resolved))?;
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
    let (mut cmd, sandbox_wrapped, sandbox_wrap_reason, sandbox_exec_path) =
        shell_exec_spawn(&argv, root, &resolved_cwd)?;
    cmd.stdin(Stdio::null());
    cmd.stdout(Stdio::piped());
    cmd.stderr(Stdio::piped());
    let mut child = cmd.spawn().map_err(|e| {
        format!("HZ_PRECONDITION_FAILED: effect.execute shell.exec failed: {e}")
    })?;
    let mut stdout_pipe = child.stdout.take().ok_or_else(|| {
        "HZ_PRECONDITION_FAILED: effect.execute shell.exec missing stdout pipe".to_string()
    })?;
    let mut stderr_pipe = child.stderr.take().ok_or_else(|| {
        "HZ_PRECONDITION_FAILED: effect.execute shell.exec missing stderr pipe".to_string()
    })?;
    let stdout_reader = thread::spawn(move || {
        let mut buf = Vec::new();
        let _ = stdout_pipe.read_to_end(&mut buf);
        buf
    });
    let stderr_reader = thread::spawn(move || {
        let mut buf = Vec::new();
        let _ = stderr_pipe.read_to_end(&mut buf);
        buf
    });
    let deadline = Instant::now() + shell_exec_timeout();
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) => {
                if Instant::now() >= deadline {
                    let _ = child.kill();
                    let _ = child.wait();
                    let _ = stdout_reader.join();
                    let _ = stderr_reader.join();
                    return Err(format!(
                        "HZ_PRECONDITION_FAILED: effect.execute shell.exec timed out after {}ms",
                        shell_exec_timeout().as_millis()
                    ));
                }
                thread::sleep(Duration::from_millis(20));
            }
            Err(e) => {
                let _ = child.kill();
                let _ = stdout_reader.join();
                let _ = stderr_reader.join();
                return Err(format!(
                    "HZ_PRECONDITION_FAILED: effect.execute shell.exec wait failed: {e}"
                ));
            }
        }
    };
    let stdout_raw = stdout_reader.join().unwrap_or_default();
    let stderr_raw = stderr_reader.join().unwrap_or_default();
    let exit_code = status.code().ok_or_else(|| {
        "HZ_PRECONDITION_FAILED: effect.execute shell.exec process terminated by signal"
            .to_string()
    })?;
    let (stdout, stdout_truncated) = cap_bytes(&stdout_raw, SHELL_STDOUT_CAP);
    let (stderr, stderr_truncated) = cap_bytes(&stderr_raw, SHELL_STDERR_CAP);
    let stdout_obs = crate::effect_evidence::observe_captured_stream_digest(&stdout);
    let stderr_obs = crate::effect_evidence::observe_captured_stream_digest(&stderr);
    let stream_digest_stable =
        crate::effect_evidence::shell_exec_result_digest_stable(&stdout_obs, &stderr_obs);
    let mut shell_fs_postimages: Option<Value> = None;
    let mut shell_fs_postimage_stable = true;
    if let Some(parsed) = crate::effect_evidence::parse_reduced_shell_fs_mutate_argv(&argv) {
        let (rows, stable) =
            crate::effect_evidence::observe_shell_fs_postimages(root, &resolved_cwd, &parsed)?;
        shell_fs_postimage_stable = stable;
        if let Some(arr) = rows.as_array() {
            if !arr.is_empty() {
                shell_fs_postimages = Some(rows);
            }
        }
    }
    let result_digest_stable = stream_digest_stable && shell_fs_postimage_stable;
    let phases = ledger.record_hermetic(effect_id);
    let verdict = reconcile(
        &phases,
        Some(HERMETIC_OBSERVE_RECEIPT_ID),
        Some(HERMETIC_OBSERVE_RECEIPT_SEQ),
        Some(result_digest_stable),
        None,
        if shell_fs_postimages.is_some() {
            Some(shell_fs_postimage_stable)
        } else {
            None
        },
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
        "sandboxExecWrapped": sandbox_wrapped,
        "sandboxExecWrapReason": sandbox_wrap_reason,
        // The shell tool exists to show the model what the command printed.
        // Digest-only evidence made every kernel-routed `ls`/`cat`/test run
        // blank, so the captured (already capped) bytes travel with the result.
        "stdout": String::from_utf8_lossy(&stdout),
        "stderr": String::from_utf8_lossy(&stderr),
    });
    if stdout_obs.observation_stable {
        if let Some(d) = stdout_obs.digest {
            out["stdoutDigest"] = json!(d);
            // Hex ferry for OwnerLog streamEvidence archive (removed after
            // settle archive; not part of the durable resultDigest binding).
            out["stdoutHex"] = json!(crate::canon::hex_encode(&stdout));
        }
    } else if let Some(c) = stdout_obs.confirm_digest {
        out["stdoutConfirmDigest"] = json!(c);
    }
    if stderr_obs.observation_stable {
        if let Some(d) = stderr_obs.digest {
            out["stderrDigest"] = json!(d);
            out["stderrHex"] = json!(crate::canon::hex_encode(&stderr));
        }
    } else if let Some(c) = stderr_obs.confirm_digest {
        out["stderrConfirmDigest"] = json!(c);
    }
    if let Some(path) = sandbox_exec_path {
        out["sandboxExecPath"] = json!(path);
    }
    if let Some(rows) = shell_fs_postimages {
        out["shellPostimages"] = rows;
        out["shellFsPostimageStable"] = json!(shell_fs_postimage_stable);
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
    verify_expected_preimage(params, "fs.delete")?;
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
    verify_expected_preimage(params, "fs.rename")?;
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
    verify_expected_preimage(params, "fs.write")?;
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
    let resolved = crate::sandbox_path_verify::recheck_path_in_sandbox(root, &candidate, Some(&resolved))?;
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

/// Reduced OwnerLog multi-file exact write/edit/rename: verify *all* preimages
/// first, then apply writes then renames. Mid-op failure rolls back already-
/// committed paths (rulings 627/630) and returns Err so OwnerLog can record UNKNOWN.
fn execute_fs_batch(
    params: &Value,
    ledger: &mut HermeticEffectLedger,
    effect_id: &str,
) -> Result<Value, String> {
    let sandbox_root = string_param(params, "sandboxRoot")?;
    let root = Path::new(&sandbox_root);
    let ops = parse_fs_batch_write_ops(params)?;
    // All-or-nothing admission: every preimage and containment check runs
    // before the first write so a stale plan cannot partially mutate.
    verify_expected_preimage(params, "fs.batch")?;
    // Same-path fs.edit ops are applied sequentially against staged bytes so
    // multi-hunk Updates compose (ruling 553); disk is read only for the first
    // touch of each path during planning. Renames are planned separately and
    // committed after all write/edit collapses (edit-then-move apply_patch).
    let mut staged: std::collections::HashMap<PathBuf, Vec<u8>> =
        std::collections::HashMap::new();
    let mut planned_writes: Vec<(String, PathBuf, Vec<u8>)> = Vec::with_capacity(ops.len());
    let mut planned_renames: Vec<(String, String, PathBuf, PathBuf)> = Vec::new();
    let mut planned_deletes: Vec<(String, PathBuf)> = Vec::new();
    for op in &ops {
        let kind = op.get("kind").and_then(Value::as_str).unwrap_or("");
        if kind.eq_ignore_ascii_case("fs.delete") {
            let raw_path = op
                .get("path")
                .and_then(Value::as_str)
                .filter(|s| !s.is_empty())
                .ok_or_else(|| {
                    "HZ_PRECONDITION_FAILED: effect.execute fs.batch fs.delete requires path"
                        .to_string()
                })?
                .to_string();
            let candidate = candidate_read_path(root, &raw_path);
            if !crate::guard::path_contained_in(root, &candidate) {
                return Err(
                    "HZ_PRECONDITION_FAILED: effect.execute fs.batch delete path must resolve inside sandboxRoot"
                        .to_string(),
                );
            }
            let resolved = crate::guard::lexical_resolve(&candidate).ok_or_else(|| {
                "HZ_PRECONDITION_FAILED: effect.execute fs.batch delete path could not be resolved"
                    .to_string()
            })?;
            planned_deletes.push((raw_path, resolved));
            continue;
        }
        if kind.eq_ignore_ascii_case("fs.rename") {
            let raw_from = op
                .get("from")
                .and_then(Value::as_str)
                .filter(|s| !s.is_empty())
                .ok_or_else(|| {
                    "HZ_PRECONDITION_FAILED: effect.execute fs.batch fs.rename requires from"
                        .to_string()
                })?
                .to_string();
            let raw_to = op
                .get("to")
                .and_then(Value::as_str)
                .filter(|s| !s.is_empty())
                .ok_or_else(|| {
                    "HZ_PRECONDITION_FAILED: effect.execute fs.batch fs.rename requires to"
                        .to_string()
                })?
                .to_string();
            let from_candidate = candidate_read_path(root, &raw_from);
            let to_candidate = candidate_read_path(root, &raw_to);
            if !crate::guard::path_contained_in(root, &from_candidate)
                || !crate::guard::path_contained_in(root, &to_candidate)
            {
                return Err(
                    "HZ_PRECONDITION_FAILED: effect.execute fs.batch rename paths must resolve inside sandboxRoot"
                        .to_string(),
                );
            }
            let from_resolved = crate::guard::lexical_resolve(&from_candidate).ok_or_else(|| {
                "HZ_PRECONDITION_FAILED: effect.execute fs.batch rename from could not be resolved"
                    .to_string()
            })?;
            let to_resolved = crate::guard::lexical_resolve(&to_candidate).ok_or_else(|| {
                "HZ_PRECONDITION_FAILED: effect.execute fs.batch rename to could not be resolved"
                    .to_string()
            })?;
            // Source may be created by an earlier write in this same batch — existence
            // is checked at commit time against disk after writes land.
            planned_renames.push((raw_from, raw_to, from_resolved, to_resolved));
            continue;
        }
        let raw_path = op
            .get("path")
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
            .ok_or_else(|| {
                "HZ_PRECONDITION_FAILED: effect.execute fs.batch op requires path".to_string()
            })?
            .to_string();
        let candidate = candidate_read_path(root, &raw_path);
        if !crate::guard::path_contained_in(root, &candidate) {
            return Err(
                "HZ_PRECONDITION_FAILED: effect.execute fs.batch path must resolve inside sandboxRoot"
                    .to_string(),
            );
        }
        let resolved = crate::guard::lexical_resolve(&candidate).ok_or_else(|| {
            "HZ_PRECONDITION_FAILED: effect.execute fs.batch path could not be resolved"
                .to_string()
        })?;
        let payload = if kind.eq_ignore_ascii_case("fs.edit") {
            let base = if let Some(bytes) = staged.get(&resolved) {
                String::from_utf8(bytes.clone()).map_err(|e| {
                    format!(
                        "HZ_PRECONDITION_FAILED: effect.execute fs.batch fs.edit staged bytes invalid utf8: {e}"
                    )
                })?
            } else {
                if !resolved.is_file() {
                    return Err(
                        "HZ_PRECONDITION_FAILED: effect.execute fs.batch fs.edit requires an existing file"
                            .to_string(),
                    );
                }
                fs::read_to_string(&resolved).map_err(|e| {
                    format!("HZ_PRECONDITION_FAILED: effect.execute fs.batch fs.edit failed: {e}")
                })?
            };
            batch_edit_payload_on_content(&base, op)?
        } else {
            write_payload_from_op(op)?
        };
        staged.insert(resolved.clone(), payload.clone());
        planned_writes.push((raw_path, resolved, payload));
    }
    // Collapse same-path planned writes: only the final staged payload per path
    // is committed (earlier same-path edit postimages are intermediate).
    let mut final_by_path: std::collections::HashMap<PathBuf, (String, Vec<u8>)> =
        std::collections::HashMap::new();
    let mut order: Vec<PathBuf> = Vec::new();
    for (raw, resolved, payload) in planned_writes {
        if !final_by_path.contains_key(&resolved) {
            order.push(resolved.clone());
        }
        final_by_path.insert(resolved, (raw, payload));
    }
    let planned_writes: Vec<(String, PathBuf, Vec<u8>)> = order
        .into_iter()
        .filter_map(|p| {
            final_by_path
                .remove(&p)
                .map(|(raw, payload)| (raw, p, payload))
        })
        .collect();

    // Snapshot preimages for rollback if a later commit fails (H EffectHost /
    // ruling 627). `None` means the path did not exist before this batch.
    let mut write_rollbacks: Vec<(PathBuf, Option<Vec<u8>>)> =
        Vec::with_capacity(planned_writes.len());
    for (_raw, resolved, _) in &planned_writes {
        let prior = if resolved.is_file() {
            Some(fs::read(resolved).map_err(|e| {
                format!(
                    "HZ_PRECONDITION_FAILED: effect.execute fs.batch could not snapshot {}: {e}",
                    resolved.display()
                )
            })?)
        } else if resolved.exists() {
            return Err(format!(
                "HZ_PRECONDITION_FAILED: effect.execute fs.batch target is not a regular file: {}",
                resolved.display()
            ));
        } else {
            None
        };
        write_rollbacks.push((resolved.clone(), prior));
    }

    let restore_writes = |committed: usize, rollbacks: &[(PathBuf, Option<Vec<u8>>)]| {
        for i in (0..committed).rev() {
            let (path, prior) = &rollbacks[i];
            let _ = match prior {
                Some(bytes) => {
                    crate::sandbox_atomic_write::write_bytes_atomic_in_sandbox(root, path, bytes)
                }
                None => fs::remove_file(path).map_err(|err| err.to_string()),
            };
        }
    };

    let mut writes_committed: usize = 0;
    for (_raw, resolved, payload) in &planned_writes {
        if let Err(e) =
            crate::sandbox_atomic_write::write_bytes_atomic_in_sandbox(root, resolved, payload)
        {
            restore_writes(writes_committed, &write_rollbacks);
            return Err(format!(
                "HZ_PRECONDITION_FAILED: effect.execute fs.batch aborted after {writes_committed} write commit(s); rolled back: {e}"
            ));
        }
        writes_committed += 1;
    }

    let undo_renames = |committed: usize| {
        for i in (0..committed).rev() {
            let (_rf, _rt, from, to) = &planned_renames[i];
            let _ = crate::sandbox_atomic_write::rename_file_in_sandbox(root, to, from);
        }
    };

    let mut renames_committed: usize = 0;
    for (_raw_from, _raw_to, from_resolved, to_resolved) in &planned_renames {
        if let Err(e) = crate::sandbox_atomic_write::rename_file_in_sandbox(
            root,
            from_resolved,
            to_resolved,
        ) {
            undo_renames(renames_committed);
            restore_writes(writes_committed, &write_rollbacks);
            return Err(format!(
                "HZ_PRECONDITION_FAILED: effect.execute fs.batch aborted after {renames_committed} rename(s); rolled back: {e}"
            ));
        }
        renames_committed += 1;
    }

    // Snapshot delete targets after writes/renames so rollback can restore bytes.
    let mut delete_rollbacks: Vec<(PathBuf, Vec<u8>)> = Vec::with_capacity(planned_deletes.len());
    for (_raw, resolved) in &planned_deletes {
        if !resolved.is_file() {
            undo_renames(renames_committed);
            restore_writes(writes_committed, &write_rollbacks);
            return Err(format!(
                "HZ_PRECONDITION_FAILED: effect.execute fs.batch fs.delete requires an existing file: {}",
                resolved.display()
            ));
        }
        let prior = fs::read(resolved).map_err(|e| {
            format!(
                "HZ_PRECONDITION_FAILED: effect.execute fs.batch could not snapshot delete {}: {e}",
                resolved.display()
            )
        })?;
        delete_rollbacks.push((resolved.clone(), prior));
    }

    let mut deletes_committed: usize = 0;
    for (_raw, resolved) in &planned_deletes {
        if let Err(e) = crate::sandbox_atomic_write::delete_file_in_sandbox(root, resolved) {
            for i in (0..deletes_committed).rev() {
                let (path, bytes) = &delete_rollbacks[i];
                let _ = crate::sandbox_atomic_write::write_bytes_atomic_in_sandbox(root, path, bytes);
            }
            undo_renames(renames_committed);
            restore_writes(writes_committed, &write_rollbacks);
            return Err(format!(
                "HZ_PRECONDITION_FAILED: effect.execute fs.batch aborted after {deletes_committed} delete(s); rolled back: {e}"
            ));
        }
        deletes_committed += 1;
    }

    let phases = ledger.record_hermetic(effect_id);
    let batch_op_count = planned_writes.len() + planned_renames.len() + planned_deletes.len();
    let mut write_paths = Vec::with_capacity(batch_op_count);
    let mut content_digests = Vec::with_capacity(batch_op_count);
    let mut rel_paths = Vec::with_capacity(batch_op_count);
    let mut all_stable = true;
    for (raw_path, resolved, _) in &planned_writes {
        // If this path was later renamed in the same batch, observe the destination.
        let observe_path = planned_renames
            .iter()
            .find(|(_, _, from, _)| from == resolved)
            .map(|(_, _, _, to)| to.as_path())
            .unwrap_or(resolved.as_path());
        let obs = crate::receipt_postimage::observe_file_postimage(observe_path);
        if !obs.observation_stable {
            all_stable = false;
        }
        write_paths.push(json!(observe_path.to_string_lossy()));
        rel_paths.push(raw_path.clone());
        if obs.observation_stable {
            if let Some(d) = obs.digest {
                content_digests.push(json!(d));
            } else {
                all_stable = false;
                content_digests.push(Value::Null);
            }
        } else {
            content_digests.push(Value::Null);
        }
    }
    for (raw_from, raw_to, from_resolved, to_resolved) in &planned_renames {
        // Skip rename observe when the source was also a write in this batch
        // (already observed at destination above).
        if planned_writes
            .iter()
            .any(|(_, resolved, _)| resolved == from_resolved)
        {
            rel_paths.push(format!("{raw_from}→{raw_to}"));
            continue;
        }
        let obs = crate::receipt_postimage::observe_file_postimage(to_resolved);
        if !obs.observation_stable {
            all_stable = false;
        }
        write_paths.push(json!(to_resolved.to_string_lossy()));
        rel_paths.push(format!("{raw_from}→{raw_to}"));
        if obs.observation_stable {
            if let Some(d) = obs.digest {
                content_digests.push(json!(d));
            } else {
                all_stable = false;
                content_digests.push(Value::Null);
            }
        } else {
            content_digests.push(Value::Null);
        }
    }
    for (raw_path, resolved) in &planned_deletes {
        // Settled delete = path absent after commit.
        if resolved.exists() {
            all_stable = false;
        }
        write_paths.push(json!(resolved.to_string_lossy()));
        rel_paths.push(format!("delete:{raw_path}"));
        content_digests.push(Value::Null);
    }
    let paths_joined = rel_paths.join(", ");
    let last_digest = content_digests
        .iter()
        .rev()
        .find_map(|v| v.as_str())
        .map(str::to_string);
    let result_obs = crate::effect_evidence::observe_kernel_apply_patch_multi_op_result_digest(
        batch_op_count,
        &paths_joined,
        last_digest.as_deref(),
    );
    let result_digest_stable = all_stable && result_obs.observation_stable;
    let verdict = reconcile(
        &phases,
        Some(HERMETIC_OBSERVE_RECEIPT_ID),
        Some(HERMETIC_OBSERVE_RECEIPT_SEQ),
        Some(result_digest_stable),
        None,
        Some(all_stable),
    );
    let mut out = json!({
        "verdict": verdict.as_str(),
        "effectId": effect_id,
        "phases": ["allow", "execute", "observe"],
        "postimageObservationStable": all_stable,
        "resultDigestStable": result_digest_stable,
        "batchOpCount": batch_op_count,
        "writePaths": write_paths,
        "contentDigests": content_digests,
        "renameCount": planned_renames.len(),
        "deleteCount": planned_deletes.len(),
    });
    if let Some(d) = last_digest {
        out["contentDigest"] = json!(d);
        if let Some(first) = write_paths.first() {
            out["writePath"] = first.clone();
        } else if let Some((_, _, _, to)) = planned_renames.first() {
            out["writePath"] = json!(to.to_string_lossy());
        }
    }
    if let Some(d) = result_obs.digest {
        out["resultDigest"] = json!(d);
    }
    Ok(out)
}

/// Independent disk observe for recovery when execution finished but OwnerLog
/// settlement did not persist (ruling **714** partial). Never writes bytes.
pub fn observe_intended_fs_write_settlement(params: &Value) -> Result<Value, String> {
    verify_expected_preimage(params, "fs.write")?;
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
    let resolved = crate::sandbox_path_verify::recheck_path_in_sandbox(root, &candidate, Some(&resolved))?;
    let obs = crate::receipt_postimage::observe_file_postimage(&resolved);
    if !obs.observation_stable {
        return Err(
            "HZ_PRECONDITION_FAILED: observe-settle fs.write postimage observation unstable".into(),
        );
    }
    let observed_digest = obs.digest.as_deref().ok_or_else(|| {
        "HZ_PRECONDITION_FAILED: observe-settle fs.write missing observed digest".to_string()
    })?;
    let expected_digest = crate::canon::sha256_bytes(&payload);
    if observed_digest != expected_digest {
        return Err(
            "HZ_PRECONDITION_FAILED: observe-settle fs.write digest does not match dispatch intent"
                .into(),
        );
    }
    let result_obs = crate::effect_evidence::observe_kernel_fs_mutation_result_digest(
        crate::effect_evidence::FsMutationResultKind::Write,
        &raw_path,
        Some(observed_digest),
        None,
    );
    if !result_obs.observation_stable {
        return Err(
            "HZ_PRECONDITION_FAILED: observe-settle fs.write result digest unstable".into(),
        );
    }
    let mut out = json!({
        "verdict": "settled",
        "effectId": params.get("effectId"),
        "phases": ["allow", "execute", "observe"],
        "postimageObservationStable": true,
        "writePath": resolved.to_string_lossy(),
        "contentDigest": observed_digest,
        "resultDigestStable": true,
    });
    if let Some(d) = result_obs.digest {
        out["resultDigest"] = json!(d);
    }
    Ok(out)
}

/// Apply the same kernel `fs.edit` string replacement as execute, without writing.
fn intended_kernel_fs_edit_post_bytes(content: &str, old: &str, new: &str) -> Result<Vec<u8>, String> {
    let edit_span = crate::effect_host_edit_repair::resolve_kernel_fs_edit_old_string(content, old)
        .map_err(|reason| match reason {
            crate::effect_host_edit_repair::EditResolveFail::Ambiguous => {
                "HZ_PRECONDITION_FAILED: observe-settle fs.edit oldString must match exactly once"
                    .to_string()
            }
            crate::effect_host_edit_repair::EditResolveFail::NotFound => {
                "HZ_PRECONDITION_FAILED: observe-settle fs.edit oldString not found in file"
                    .to_string()
            }
        })?;
    let replacement =
        crate::effect_host_edit_repair::render_fs_edit_replacement(&new, &edit_span, content);
    Ok(format!(
        "{}{}{}",
        &content[..edit_span.start],
        replacement,
        &content[edit_span.end..]
    )
    .into_bytes())
}

/// When execution already replaced `oldString`, reconstruct the unique preimage
/// whose single forward edit yields `post` (fails on ambiguity).
fn unique_preimage_forward_replay(post: &str, old: &str, new: &str) -> Result<String, String> {
    let post_bytes = post.as_bytes();
    let mut preimage: Option<String> = None;
    for i in 0..=post.len() {
        if !post.is_char_boundary(i) {
            continue;
        }
        for j in i..=post.len() {
            if !post.is_char_boundary(j) {
                continue;
            }
            let candidate = format!("{}{}{}", &post[..i], old, &post[j..]);
            let applied = match intended_kernel_fs_edit_post_bytes(&candidate, old, new) {
                Ok(bytes) => bytes,
                Err(_) => continue,
            };
            if applied != post_bytes {
                continue;
            }
            if preimage.is_some() {
                return Err(
                    "HZ_PRECONDITION_FAILED: observe-settle fs.edit intent ambiguous".into(),
                );
            }
            preimage = Some(candidate);
        }
    }
    preimage.ok_or_else(|| {
        "HZ_PRECONDITION_FAILED: observe-settle fs.edit digest does not match dispatch intent"
            .into()
    })
}

/// Independent disk observe for recovery when `fs.edit` finished but OwnerLog
/// settlement did not persist (ruling **721** partial). Never writes bytes.
pub fn observe_intended_fs_edit_settlement(params: &Value) -> Result<Value, String> {
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
            "HZ_PRECONDITION_FAILED: observe-settle fs.edit requires an existing file".to_string(),
        );
    }
    let resolved =
        crate::sandbox_path_verify::recheck_path_in_sandbox(root, &candidate, Some(&resolved))?;
    let obs = crate::receipt_postimage::observe_file_postimage(&resolved);
    if !obs.observation_stable {
        return Err(
            "HZ_PRECONDITION_FAILED: observe-settle fs.edit postimage observation unstable".into(),
        );
    }
    let observed_digest = obs.digest.as_deref().ok_or_else(|| {
        "HZ_PRECONDITION_FAILED: observe-settle fs.edit missing observed digest".to_string()
    })?;
    let content = fs::read_to_string(&resolved).map_err(|e| {
        format!("HZ_PRECONDITION_FAILED: observe-settle fs.edit failed: {e}")
    })?;
    let (expected_bytes, preimage_for_pin) =
        match intended_kernel_fs_edit_post_bytes(&content, &old, &new) {
            Ok(bytes) => (bytes, content.clone()),
            Err(_) => {
                let preimage = unique_preimage_forward_replay(&content, &old, &new)?;
                (content.as_bytes().to_vec(), preimage)
            }
        };
    let expected_digest = crate::canon::sha256_bytes(&expected_bytes);
    if observed_digest != expected_digest {
        return Err(
            "HZ_PRECONDITION_FAILED: observe-settle fs.edit digest does not match dispatch intent"
                .into(),
        );
    }
    if let Some(expected_preimage) = spec
        .get("expectedPreimageDigest")
        .and_then(Value::as_str)
    {
        let pin_digest = crate::canon::sha256_bytes(preimage_for_pin.as_bytes());
        if pin_digest != expected_preimage {
            return Err(
                "HZ_PRECONDITION_FAILED: observe-settle fs.edit preimage pin does not match replay"
                    .into(),
            );
        }
    }
    let result_obs = crate::effect_evidence::observe_kernel_fs_mutation_result_digest(
        crate::effect_evidence::FsMutationResultKind::Edit,
        &raw_path,
        Some(observed_digest),
        None,
    );
    if !result_obs.observation_stable {
        return Err(
            "HZ_PRECONDITION_FAILED: observe-settle fs.edit result digest unstable".into(),
        );
    }
    let mut out = json!({
        "verdict": "settled",
        "effectId": params.get("effectId"),
        "phases": ["allow", "execute", "observe"],
        "postimageObservationStable": true,
        "editPath": resolved.to_string_lossy(),
        "contentDigest": observed_digest,
        "resultDigestStable": true,
    });
    if let Some(d) = result_obs.digest {
        out["resultDigest"] = json!(d);
    }
    Ok(out)
}

/// Independent disk observe for recovery when `fs.delete` finished but OwnerLog
/// settlement did not persist (ruling **733** partial). Never deletes bytes.
pub fn observe_intended_fs_delete_settlement(params: &Value) -> Result<Value, String> {
    verify_expected_preimage(params, "fs.delete")?;
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
    let resolved =
        crate::sandbox_path_verify::recheck_path_in_sandbox(root, &candidate, Some(&resolved))?;
    let observation_stable = file_missing_stable(&resolved) && file_missing_stable(&resolved);
    if !observation_stable {
        return Err(
            "HZ_PRECONDITION_FAILED: observe-settle fs.delete path not stably absent".into(),
        );
    }
    let result_obs = crate::effect_evidence::observe_kernel_fs_mutation_result_digest(
        crate::effect_evidence::FsMutationResultKind::Delete,
        &raw_path,
        Some(EMPTY_SHA256_HEX),
        None,
    );
    if !result_obs.observation_stable {
        return Err(
            "HZ_PRECONDITION_FAILED: observe-settle fs.delete result digest unstable".into(),
        );
    }
    let mut out = json!({
        "verdict": "settled",
        "effectId": params.get("effectId"),
        "phases": ["allow", "execute", "observe"],
        "postimageObservationStable": true,
        "deletePath": resolved.to_string_lossy(),
        "contentDigest": EMPTY_SHA256_HEX,
        "resultDigestStable": true,
    });
    if let Some(d) = result_obs.digest {
        out["resultDigest"] = json!(d);
    }
    Ok(out)
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
    if kind.eq_ignore_ascii_case("fs.batch") {
        if optional_string_param(params, "sandboxRoot")?.is_none() {
            return Err(
                "HZ_PRECONDITION_FAILED: effect.execute for dispatch kind \"fs.batch\" is not implemented in the kernel; TypeScript owns real tool execution".to_string(),
            );
        }
        return execute_fs_batch(params, ledger, &effect_id);
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
            "HZ_PRECONDITION_FAILED: effect.execute dispatch kind {:?} is unknown; only hermetic pure/echo/test/fs.read/fs.write/fs.edit/fs.delete/fs.rename/fs.batch/shell.exec (with sandboxRoot) are supported",
            kind
        ));
    }
    if optional_string_param(params, "sandboxRoot")?.is_some() {
        return Err(
            "HZ_PRECONDITION_FAILED: effect.execute sandboxRoot is only valid for fs.read, fs.write, fs.edit, fs.delete, fs.rename, fs.batch, and shell.exec"
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
        assert!(
            out.get("sandboxExecWrapReason")
                .and_then(|v| v.as_str())
                .is_some(),
            "{out}"
        );
        assert!(out["sandboxExecWrapped"].is_boolean());
        let _ = std::fs::remove_dir_all(&sandbox);
    }

    #[test]
    fn execute_shell_exec_refuses_bare_argv_when_require_wrap_and_helper_missing() {
        let sandbox =
            std::env::temp_dir().join(format!("hz-eff-shell-req-wrap-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&sandbox);
        std::fs::create_dir_all(&sandbox).unwrap();
        let prev_require = std::env::var("HZ_SANDBOX_REQUIRE").ok();
        let prev_bin = std::env::var("HZ_SANDBOX_EXEC_BIN").ok();
        std::env::set_var("HZ_SANDBOX_REQUIRE", "1");
        std::env::set_var("HZ_SANDBOX_EXEC_BIN", "/nonexistent/hz-sandbox-exec-missing");
        let mut ledger = HermeticEffectLedger::default();
        let err = execute_params(
            &json!({
                "effectId": "eff-shell-req-wrap",
                "sandboxRoot": sandbox.to_string_lossy(),
                "dispatch": { "kind": "shell.exec", "spec": { "argv": ["true"] } }
            }),
            &mut ledger,
        )
        .unwrap_err();
        match prev_require {
            Ok(v) => std::env::set_var("HZ_SANDBOX_REQUIRE", v),
            Err(_) => std::env::remove_var("HZ_SANDBOX_REQUIRE"),
        }
        match prev_bin {
            Ok(v) => std::env::set_var("HZ_SANDBOX_EXEC_BIN", v),
            Err(_) => std::env::remove_var("HZ_SANDBOX_EXEC_BIN"),
        }
        assert!(err.contains("HZ_SANDBOX_REQUIRE=1"), "{err}");
        assert!(err.contains("never shell-net enforced"), "{err}");
        let _ = std::fs::remove_dir_all(&sandbox);
    }

    #[test]
    fn execute_shell_exec_sandbox_wrap_honesty_fields() {
        let sandbox = std::env::temp_dir().join(format!("hz-eff-shell-wrap-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&sandbox);
        std::fs::create_dir_all(&sandbox).unwrap();
        let mut ledger = HermeticEffectLedger::default();
        let out = execute_params(
            &json!({
                "effectId": "eff-shell-wrap",
                "sandboxRoot": sandbox.to_string_lossy(),
                "dispatch": { "kind": "shell.exec", "spec": { "argv": ["true"] } }
            }),
            &mut ledger,
        )
        .unwrap();
        let wrapped = out["sandboxExecWrapped"].as_bool().unwrap_or(false);
        let reason = out["sandboxExecWrapReason"].as_str().unwrap_or("");
        assert!(reason.contains("never shell-net enforced"));
        if wrapped {
            assert!(reason.contains("hz-sandbox-exec"));
            assert!(out.get("sandboxExecPath").and_then(|v| v.as_str()).is_some());
        } else {
            assert!(reason.contains("not found") || reason.contains("bare argv"));
        }
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

    #[test]
    fn execute_fs_batch_exact_writes_all_or_nothing_happy_path() {
        let sandbox = std::env::temp_dir().join(format!("hz-eff-batch-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&sandbox);
        std::fs::create_dir_all(&sandbox).unwrap();
        std::fs::write(sandbox.join("exist.txt"), b"old").unwrap();
        let pin = crate::canon::sha256_bytes(b"old");
        let mut ledger = HermeticEffectLedger::default();
        let out = execute_params(
            &json!({
                "effectId": "eff-batch",
                "sandboxRoot": sandbox.to_string_lossy(),
                "dispatch": {
                    "kind": "fs.batch",
                    "spec": {
                        "ops": [
                            {
                                "kind": "fs.write",
                                "path": "new.txt",
                                "text": "one",
                                "expectedPreimageDigest": null
                            },
                            {
                                "kind": "fs.write",
                                "path": "exist.txt",
                                "text": "two",
                                "expectedPreimageDigest": pin
                            }
                        ]
                    }
                }
            }),
            &mut ledger,
        )
        .unwrap();
        assert_eq!(out["verdict"], "settled");
        assert_eq!(out["batchOpCount"], 2);
        assert_eq!(std::fs::read(sandbox.join("new.txt")).unwrap(), b"one");
        assert_eq!(std::fs::read(sandbox.join("exist.txt")).unwrap(), b"two");
        assert_eq!(out["postimageObservationStable"], true);
        assert_eq!(out["resultDigestStable"], true);
        let paths = out["writePaths"].as_array().expect("writePaths");
        assert_eq!(paths.len(), 2);
        let digests = out["contentDigests"].as_array().expect("contentDigests");
        assert_eq!(digests.len(), 2);
        let _ = std::fs::remove_dir_all(&sandbox);
    }

    #[test]
    fn execute_fs_batch_refuses_unknown_op_kind() {
        let sandbox = std::env::temp_dir().join(format!("hz-eff-batch-mix-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&sandbox);
        std::fs::create_dir_all(&sandbox).unwrap();
        let mut ledger = HermeticEffectLedger::default();
        let err = execute_params(
            &json!({
                "effectId": "eff-batch-mix",
                "sandboxRoot": sandbox.to_string_lossy(),
                "dispatch": {
                    "kind": "fs.batch",
                    "spec": {
                        "ops": [
                            { "kind": "fs.write", "path": "a.txt", "text": "x" },
                            { "kind": "fs.fuzzy", "path": "a.txt" }
                        ]
                    }
                }
            }),
            &mut ledger,
        )
        .unwrap_err();
        assert!(err.contains("fs.batch"), "{}", err);
        assert!(
            err.contains("fs.write") || err.contains("exact") || err.contains("fs.fuzzy"),
            "{}",
            err
        );
        assert!(!sandbox.join("a.txt").exists());
        let _ = std::fs::remove_dir_all(&sandbox);
    }

    #[test]
    fn execute_fs_batch_write_and_delete_ops() {
        let sandbox = std::env::temp_dir().join(format!("hz-eff-batch-del-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&sandbox);
        std::fs::create_dir_all(&sandbox).unwrap();
        std::fs::write(sandbox.join("gone.txt"), b"bye").unwrap();
        let mut ledger = HermeticEffectLedger::default();
        let out = execute_params(
            &json!({
                "effectId": "eff-batch-del",
                "sandboxRoot": sandbox.to_string_lossy(),
                "dispatch": {
                    "kind": "fs.batch",
                    "spec": {
                        "ops": [
                            { "kind": "fs.write", "path": "keep.txt", "text": "fresh" },
                            { "kind": "fs.delete", "path": "gone.txt" }
                        ]
                    }
                }
            }),
            &mut ledger,
        )
        .unwrap();
        assert_eq!(out["verdict"], "settled", "{out}");
        assert_eq!(out["deleteCount"], 1, "{out}");
        assert_eq!(std::fs::read(sandbox.join("keep.txt")).unwrap(), b"fresh");
        assert!(!sandbox.join("gone.txt").exists());
        let _ = std::fs::remove_dir_all(&sandbox);
    }

    #[test]
    fn execute_fs_batch_write_and_rename_ops() {
        let sandbox = std::env::temp_dir().join(format!("hz-eff-batch-ren-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&sandbox);
        std::fs::create_dir_all(&sandbox).unwrap();
        std::fs::write(sandbox.join("src.txt"), b"move-me").unwrap();
        let mut ledger = HermeticEffectLedger::default();
        let out = execute_params(
            &json!({
                "effectId": "eff-batch-ren",
                "sandboxRoot": sandbox.to_string_lossy(),
                "dispatch": {
                    "kind": "fs.batch",
                    "spec": {
                        "ops": [
                            { "kind": "fs.write", "path": "extra.txt", "text": "fresh" },
                            { "kind": "fs.rename", "from": "src.txt", "to": "dst.txt" }
                        ]
                    }
                }
            }),
            &mut ledger,
        )
        .unwrap();
        assert_eq!(out["verdict"], "settled", "{out}");
        assert_eq!(out["batchOpCount"], 2, "{out}");
        assert_eq!(out["renameCount"], 1, "{out}");
        assert_eq!(std::fs::read(sandbox.join("extra.txt")).unwrap(), b"fresh");
        assert!(!sandbox.join("src.txt").exists());
        assert_eq!(std::fs::read(sandbox.join("dst.txt")).unwrap(), b"move-me");
        let _ = std::fs::remove_dir_all(&sandbox);
    }

    #[test]
    fn execute_fs_batch_exact_write_and_edit_ops() {
        let sandbox = std::env::temp_dir().join(format!("hz-eff-batch-edit-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&sandbox);
        std::fs::create_dir_all(&sandbox).unwrap();
        std::fs::write(sandbox.join("edit.txt"), b"alpha beta gamma").unwrap();
        let mut ledger = HermeticEffectLedger::default();
        let out = execute_params(
            &json!({
                "effectId": "eff-batch-edit",
                "sandboxRoot": sandbox.to_string_lossy(),
                "dispatch": {
                    "kind": "fs.batch",
                    "spec": {
                        "ops": [
                            { "kind": "fs.write", "path": "new.txt", "text": "fresh" },
                            {
                                "kind": "fs.edit",
                                "path": "edit.txt",
                                "oldString": "beta",
                                "newString": "OMEGA"
                            }
                        ]
                    }
                }
            }),
            &mut ledger,
        )
        .unwrap();
        assert_eq!(out["verdict"], "settled", "{out}");
        assert_eq!(out["batchOpCount"], 2, "{out}");
        assert_eq!(std::fs::read(sandbox.join("new.txt")).unwrap(), b"fresh");
        assert_eq!(
            std::fs::read(sandbox.join("edit.txt")).unwrap(),
            b"alpha OMEGA gamma"
        );
        let _ = std::fs::remove_dir_all(&sandbox);
    }

    #[test]
    fn execute_fs_batch_sequential_same_path_edits() {
        let sandbox =
            std::env::temp_dir().join(format!("hz-eff-batch-seq-edit-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&sandbox);
        std::fs::create_dir_all(&sandbox).unwrap();
        std::fs::write(sandbox.join("multi.txt"), b"alpha\nmiddle\nbeta\n").unwrap();
        let mut ledger = HermeticEffectLedger::default();
        let out = execute_params(
            &json!({
                "effectId": "eff-batch-seq",
                "sandboxRoot": sandbox.to_string_lossy(),
                "dispatch": {
                    "kind": "fs.batch",
                    "spec": {
                        "ops": [
                            {
                                "kind": "fs.edit",
                                "path": "multi.txt",
                                "oldString": "alpha",
                                "newString": "ALPHA"
                            },
                            {
                                "kind": "fs.edit",
                                "path": "multi.txt",
                                "oldString": "beta",
                                "newString": "BETA"
                            },
                            { "kind": "fs.write", "path": "extra.txt", "text": "z\n" }
                        ]
                    }
                }
            }),
            &mut ledger,
        )
        .unwrap();
        assert_eq!(out["verdict"], "settled", "{out}");
        // Collapsed to unique paths: multi.txt + extra.txt.
        assert_eq!(out["batchOpCount"], 2, "{out}");
        assert_eq!(
            std::fs::read(sandbox.join("multi.txt")).unwrap(),
            b"ALPHA\nmiddle\nBETA\n"
        );
        assert_eq!(std::fs::read(sandbox.join("extra.txt")).unwrap(), b"z\n");
        let _ = std::fs::remove_dir_all(&sandbox);
    }

    #[test]
    fn execute_fs_batch_refuses_stale_preimage_before_any_write() {
        let sandbox = std::env::temp_dir().join(format!("hz-eff-batch-stale-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&sandbox);
        std::fs::create_dir_all(&sandbox).unwrap();
        std::fs::write(sandbox.join("a.txt"), b"A").unwrap();
        std::fs::write(sandbox.join("b.txt"), b"B").unwrap();
        let mut ledger = HermeticEffectLedger::default();
        let err = execute_params(
            &json!({
                "effectId": "eff-batch-stale",
                "sandboxRoot": sandbox.to_string_lossy(),
                "dispatch": {
                    "kind": "fs.batch",
                    "spec": {
                        "ops": [
                            {
                                "kind": "fs.write",
                                "path": "a.txt",
                                "text": "A2",
                                "expectedPreimageDigest": crate::canon::sha256_bytes(b"A")
                            },
                            {
                                "kind": "fs.write",
                                "path": "b.txt",
                                "text": "B2",
                                "expectedPreimageDigest": "0000000000000000000000000000000000000000000000000000000000000000"
                            }
                        ]
                    }
                }
            }),
            &mut ledger,
        )
        .unwrap_err();
        assert!(err.contains("preimage"), "{}", err);
        assert_eq!(std::fs::read(sandbox.join("a.txt")).unwrap(), b"A");
        assert_eq!(std::fs::read(sandbox.join("b.txt")).unwrap(), b"B");
        let _ = std::fs::remove_dir_all(&sandbox);
    }
}
