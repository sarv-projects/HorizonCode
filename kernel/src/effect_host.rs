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
#[cfg(unix)]
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
/// Maximum time to keep draining stdout/stderr pipes after the direct child
/// process exits, so an orphaned grandchild still holding open inherited FDs
/// cannot hang `effect_host.rs`.
const DRAIN_AFTER_EXIT: Duration = Duration::from_secs(1);

/// Process-global lock serializing `pipe()`/`spawn()` on Unix so CLOEXEC/FD
/// inheritance races cannot leak pipes across concurrent spawns.
#[cfg(unix)]
static SPAWN_LOCK: Mutex<()> = Mutex::new(());

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
fn merge_shell_exec_path(home: Option<&str>, parent_path: Option<&std::ffi::OsStr>) -> String {
    let mut parts: Vec<PathBuf> = Vec::new();
    if let Some(home) = home.filter(|s| !s.trim().is_empty()) {
        let home_path = Path::new(home);
        for sub in [".bun/bin", ".cargo/bin", ".local/bin"] {
            parts.push(home_path.join(sub));
        }
    }
    #[cfg(target_os = "macos")]
    parts.push(PathBuf::from("/opt/homebrew/bin"));
    #[cfg(not(windows))]
    for p in ["/usr/local/bin", "/usr/bin", "/bin"] {
        parts.push(PathBuf::from(p));
    }
    if let Some(parent) = parent_path {
        for p in std::env::split_paths(parent) {
            if p.as_os_str().is_empty() {
                continue;
            }
            if !parts.iter().any(|x| x == &p) {
                parts.push(p);
            }
        }
    }
    match std::env::join_paths(&parts) {
        Ok(joined) => joined.to_string_lossy().into_owned(),
        Err(_) => {
            let sep = if cfg!(windows) { ";" } else { ":" };
            parts
                .iter()
                .map(|p| p.to_string_lossy().into_owned())
                .collect::<Vec<_>>()
                .join(sep)
        }
    }
}

fn shell_exec_path() -> String {
    let home = std::env::var("HOME")
        .ok()
        .filter(|s| !s.trim().is_empty())
        .or_else(|| {
            if cfg!(windows) {
                std::env::var("USERPROFILE")
                    .ok()
                    .filter(|s| !s.trim().is_empty())
            } else {
                None
            }
        });
    let parent = std::env::var_os("PATH");
    merge_shell_exec_path(home.as_deref(), parent.as_deref())
}

/// Independent re-read of captured stream bytes through a temp file (D-5/P0-2).
/// `None` means the round trip was unavailable; the caller then reports a single
/// observation rather than pretending to have compared two.
fn reread_captured_stream(bytes: &[u8]) -> Option<Vec<u8>> {
    let path = std::env::temp_dir().join(format!(
        "hz-stream-{}-{}.bin",
        std::process::id(),
        uuid::Uuid::new_v4()
    ));
    std::fs::write(&path, bytes).ok()?;
    let read = std::fs::read(&path).ok();
    let _ = std::fs::remove_file(&path);
    read
}

#[cfg(test)]
pub(crate) static EXTENDED_ENV_LOCK: Mutex<()> = Mutex::new(());

#[cfg(test)]
mod stream_reread_tests {
    use super::*;

    #[test]
    fn hook_exec_is_refused_by_name_not_as_an_unknown_kind() {
        let _guard = EXTENDED_ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let mut ledger = HermeticEffectLedger::default();
        let err = execute_params(
            &json!({
                "effectId": "eff-hook",
                "dispatch": { "kind": "hook.exec", "spec": { "point": "preTool", "index": 0 } }
            }),
            &mut ledger,
        )
        .expect_err("hook.exec must be refused");
        assert!(err.contains("hook.exec"), "{err}");
        assert!(err.contains("909"), "{err}");
        assert!(!err.contains("is unknown"), "{err}");
    }

    #[test]
    fn mcp_invoke_is_refused_by_name_not_as_an_unknown_kind() {
        let _guard = EXTENDED_ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let mut ledger = HermeticEffectLedger::default();
        let err = execute_params(
            &json!({
                "effectId": "eff-mcp",
                "dispatch": { "kind": "mcp.invoke", "spec": { "serverId": "s", "toolName": "t" } }
            }),
            &mut ledger,
        )
        .expect_err("mcp.invoke must be refused");
        assert!(err.contains("mcp.invoke"), "{err}");
        assert!(err.contains("OwnerLog"), "{err}");
        assert!(!err.contains("is unknown"), "{err}");
    }

    #[test]
    fn reread_returns_the_same_bytes() {
        let bytes = b"hello stream\n";
        let again = reread_captured_stream(bytes).expect("temp round trip");
        assert_eq!(again, bytes);
    }
}

fn shell_exec_wrap_disabled() -> bool {
    std::env::var("HZ_SANDBOX_EXEC")
        .map(|value| value.trim() == "0")
        .unwrap_or(false)
}

/// Fail-closed when product posture requires hz-sandbox-exec wrap (ruling **732**).
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

struct SpawnSpec {
    program: String,
    args: Vec<String>,
    cwd: PathBuf,
    env: Vec<(String, String)>,
}

struct HardenedProcessOutput {
    stdout: Vec<u8>,
    stdout_truncated: bool,
    stderr: Vec<u8>,
    stderr_truncated: bool,
    exit_code: i32,
}

/// Spawn plan for kernel-routed `shell.exec` (ruling **660**/**675**): wrap argv
/// through `hz-sandbox-exec` when the helper resolves; otherwise run bare argv
/// and report honestly unless require-wrap refuses (never shell-net `enforced`).
fn shell_exec_spawn(
    argv: &[String],
    sandbox_root: &Path,
    cwd: &Path,
) -> Result<(SpawnSpec, bool, String, Option<String>), String> {
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
        let spec = SpawnSpec {
            program: argv[0].clone(),
            args: argv[1..].to_vec(),
            cwd: cwd.to_path_buf(),
            env: vec![
                ("PATH".to_string(), path_value),
                ("HOME".to_string(), cwd.to_string_lossy().into_owned()),
                ("LANG".to_string(), "C.UTF-8".to_string()),
            ],
        };
        return Ok((spec, false, wrap_reason(false), None));
    }
    let binary = crate::sandbox::resolve_sandbox_exec_binary().unwrap();
    let exec_display = binary.display().to_string();
    let mut args = Vec::with_capacity(argv.len() + 1);
    args.push("--".to_string());
    args.extend(argv.iter().cloned());
    let spec = SpawnSpec {
        program: binary.to_string_lossy().into_owned(),
        args,
        cwd: cwd.to_path_buf(),
        env: vec![
            ("PATH".to_string(), path_value),
            ("HOME".to_string(), cwd.to_string_lossy().into_owned()),
            ("LANG".to_string(), "C.UTF-8".to_string()),
            (
                "HZ_SANDBOX_FS_ROOT".to_string(),
                sandbox_root.to_string_lossy().into_owned(),
            ),
            (
                "HZ_SANDBOX_FS_MODE".to_string(),
                "workspace-write".to_string(),
            ),
            ("HZ_SANDBOX_CHILD_NET".to_string(), child_net.clone()),
        ],
    };
    Ok((spec, true, wrap_reason(true), Some(exec_display)))
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
                return Err(
                    "HZ_PRECONDITION_FAILED: preimage missing-file assertion failed".into(),
                );
            }
        }
        Value::String(s)
            if s.len() == 64
                && s.bytes()
                    .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)) =>
        {
            let obs = crate::receipt_postimage::observe_file_postimage(&resolved);
            if !obs.observation_stable {
                return Err(
                    "HZ_PRECONDITION_FAILED: independent preimage observation unstable".into(),
                );
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
    let ops = spec.get("ops").and_then(Value::as_array).ok_or_else(|| {
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
        let kind = obj.get("kind").and_then(Value::as_str).unwrap_or("");
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
    let old = op.get("oldString").and_then(Value::as_str).ok_or_else(|| {
        "HZ_PRECONDITION_FAILED: effect.execute fs.batch fs.edit requires oldString".to_string()
    })?;
    let new = op.get("newString").and_then(Value::as_str).ok_or_else(|| {
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
    Err("HZ_PRECONDITION_FAILED: effect.execute fs.batch write requires text or bytes".to_string())
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

fn edit_old_new_from_spec(
    spec: &serde_json::Map<String, Value>,
) -> Result<(String, String), String> {
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
                let n = item.as_u64().ok_or_else(|| {
                    format!("effect.execute fs.write spec.bytes[{i}] must be a byte 0–255")
                })?;
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
    let content = fs::read_to_string(&resolved)
        .map_err(|e| format!("HZ_PRECONDITION_FAILED: effect.execute fs.edit failed: {e}"))?;
    let edit_span = crate::effect_host_edit_repair::resolve_kernel_fs_edit_old_string(
        &content, &old,
    )
    .map_err(|reason| match reason {
        crate::effect_host_edit_repair::EditResolveFail::Ambiguous => {
            "HZ_PRECONDITION_FAILED: effect.execute fs.edit oldString must match exactly once"
                .to_string()
        }
        crate::effect_host_edit_repair::EditResolveFail::NotFound => {
            "HZ_PRECONDITION_FAILED: effect.execute fs.edit oldString not found in file".to_string()
        }
    })?;
    let replacement =
        crate::effect_host_edit_repair::render_fs_edit_replacement(&new, &edit_span, &content);
    let updated = format!(
        "{}{}{}",
        &content[..edit_span.start],
        replacement,
        &content[edit_span.end..]
    );
    let resolved =
        crate::sandbox_path_verify::recheck_path_in_sandbox(root, &candidate, Some(&resolved))?;
    crate::sandbox_atomic_write::write_bytes_atomic_in_sandbox(
        root,
        &resolved,
        updated.as_bytes(),
    )?;
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
    let argv_val = spec.get("argv").and_then(|v| v.as_array()).ok_or_else(|| {
        "effect.execute shell.exec requires dispatch.spec.argv (array)".to_string()
    })?;
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
            .ok_or_else(|| {
                "effect.execute shell.exec spec.cwd must be a non-empty string when present"
                    .to_string()
            })
            .map(Some),
    }
}

/// Read at most `cap` bytes from a child pipe into memory, draining any
/// remaining output into a fixed stack buffer so a noisy child cannot OOM
/// `hz-kernel` or stall on a full pipe before exiting.
#[cfg(windows)]
fn read_pipe_capped<R: std::io::Read>(mut pipe: R, cap: usize) -> (Vec<u8>, bool) {
    let mut out = Vec::new();
    let mut truncated = false;
    let mut chunk = [0u8; 8192];
    loop {
        match pipe.read(&mut chunk) {
            Ok(0) => break,
            Ok(n) => {
                if out.len() < cap {
                    let take = (cap - out.len()).min(n);
                    out.extend_from_slice(&chunk[..take]);
                    if take < n {
                        truncated = true;
                    }
                } else {
                    truncated = true;
                }
            }
            Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(_) => break,
        }
    }
    (out, truncated)
}

#[cfg(unix)]
mod unix_proc {
    use super::*;
    use std::io::{self, Read};
    use std::os::unix::io::{AsRawFd, FromRawFd};
    use std::os::unix::process::CommandExt;

    /// Create a pipe with `FD_CLOEXEC` set on both ends. Caller must hold
    /// `SPAWN_LOCK` so no concurrent `fork`/`exec` can inherit the descriptors.
    pub(super) fn create_cloexec_pipe() -> io::Result<(std::fs::File, std::fs::File)> {
        let mut fds = [0 as libc::c_int; 2];
        if unsafe { libc::pipe(fds.as_mut_ptr()) } != 0 {
            return Err(io::Error::last_os_error());
        }
        for fd in fds {
            if unsafe { libc::fcntl(fd, libc::F_SETFD, libc::FD_CLOEXEC) } != 0 {
                let err = io::Error::last_os_error();
                unsafe {
                    libc::close(fds[0]);
                    libc::close(fds[1]);
                }
                return Err(err);
            }
        }
        Ok(unsafe {
            (
                std::fs::File::from_raw_fd(fds[0]),
                std::fs::File::from_raw_fd(fds[1]),
            )
        })
    }

    fn set_nonblocking(fd: libc::c_int) {
        unsafe {
            let flags = libc::fcntl(fd, libc::F_GETFL);
            if flags >= 0 {
                let _ = libc::fcntl(fd, libc::F_SETFL, flags | libc::O_NONBLOCK);
            }
        }
    }

    /// Observe child exit via `waitid(P_PID, pid, &mut siginfo, WEXITED | WNOWAIT | WNOHANG)`
    /// without reaping the zombie, keeping PID/PGID reserved until `reap_pid`.
    pub(super) fn wait_child_zombie_nonblocking(
        pid: libc::pid_t,
    ) -> io::Result<Option<(libc::c_int, libc::c_int)>> {
        let mut info: libc::siginfo_t = unsafe { std::mem::zeroed() };
        let rc = unsafe {
            libc::waitid(
                libc::P_PID,
                pid as libc::id_t,
                &mut info,
                libc::WEXITED | libc::WNOWAIT | libc::WNOHANG,
            )
        };
        if rc == -1 {
            return Err(io::Error::last_os_error());
        }
        #[cfg(target_os = "linux")]
        let si_pid = unsafe { info.si_pid() };
        #[cfg(not(target_os = "linux"))]
        let si_pid = info.si_pid;
        if si_pid == 0 {
            return Ok(None);
        }
        #[cfg(target_os = "linux")]
        let si_status = unsafe { info.si_status() };
        #[cfg(not(target_os = "linux"))]
        let si_status = info.si_status;
        Ok(Some((info.si_code, si_status)))
    }

    /// Block until `pid` enters zombie state without reaping it.
    pub(super) fn wait_child_zombie_blocking(pid: libc::pid_t) {
        loop {
            let mut info: libc::siginfo_t = unsafe { std::mem::zeroed() };
            let rc = unsafe {
                libc::waitid(
                    libc::P_PID,
                    pid as libc::id_t,
                    &mut info,
                    libc::WEXITED | libc::WNOWAIT,
                )
            };
            if rc == 0 {
                break;
            }
            if io::Error::last_os_error().kind() != io::ErrorKind::Interrupted {
                break;
            }
        }
    }

    /// Kill the child's entire process group while its zombie still reserves
    /// the PID/PGID so the OS cannot recycle it onto an unrelated process.
    pub(super) fn kill_process_group_while_zombie(pid: libc::pid_t) {
        if pid > 0 {
            unsafe {
                libc::killpg(pid, libc::SIGKILL);
                libc::kill(pid, libc::SIGKILL);
            }
        }
    }

    /// Reap the retained zombie cleanly via `waitpid`.
    pub(super) fn reap_pid(pid: libc::pid_t) {
        if pid <= 0 {
            return;
        }
        loop {
            let rc = unsafe { libc::waitpid(pid, std::ptr::null_mut(), 0) };
            if rc != -1 || io::Error::last_os_error().kind() != io::ErrorKind::Interrupted {
                break;
            }
        }
    }

    /// Drain stdout and stderr pipes using `poll()`, enforcing `drain_after_exit`
    /// once `exited_rx` signals child exit so an orphaned grandchild holding
    /// inherited stdout/stderr FDs cannot hang `effect_host.rs`.
    fn drain_pipes(
        mut stdout_pipe: std::process::ChildStdout,
        mut stderr_pipe: std::process::ChildStderr,
        exited_rx: std::fs::File,
        stdout_cap: usize,
        stderr_cap: usize,
        drain_after_exit: Duration,
    ) -> (Vec<u8>, bool, Vec<u8>, bool) {
        set_nonblocking(stdout_pipe.as_raw_fd());
        set_nonblocking(stderr_pipe.as_raw_fd());

        let mut stdout = Vec::new();
        let mut stdout_truncated = false;
        let mut stderr = Vec::new();
        let mut stderr_truncated = false;

        let mut stdout_open = true;
        let mut stderr_open = true;
        let mut stdout_hup = false;
        let mut stderr_hup = false;
        let mut drain_deadline: Option<Instant> = None;
        let mut chunk = [0u8; 8192];

        while stdout_open || stderr_open {
            let writers_all_closed =
                (!stdout_open || stdout_hup) && (!stderr_open || stderr_hup);
            let timeout_ms: libc::c_int = match drain_deadline {
                Some(dl) if !writers_all_closed => {
                    let left = dl.saturating_duration_since(Instant::now());
                    if left.is_zero() {
                        // Drain deadline elapsed while a writer still holds the pipe open.
                        break;
                    }
                    left.as_nanos()
                        .div_ceil(1_000_000)
                        .min(libc::c_int::MAX as u128) as libc::c_int
                }
                _ => -1,
            };

            let mut pfds: [libc::pollfd; 3] = [
                libc::pollfd {
                    fd: -1,
                    events: 0,
                    revents: 0,
                };
                3
            ];
            let mut idx_stdout: Option<usize> = None;
            let mut idx_stderr: Option<usize> = None;
            let mut idx_exited: Option<usize> = None;
            let mut nfds = 0usize;

            if stdout_open {
                idx_stdout = Some(nfds);
                pfds[nfds] = libc::pollfd {
                    fd: stdout_pipe.as_raw_fd(),
                    events: libc::POLLIN,
                    revents: 0,
                };
                nfds += 1;
            }
            if stderr_open {
                idx_stderr = Some(nfds);
                pfds[nfds] = libc::pollfd {
                    fd: stderr_pipe.as_raw_fd(),
                    events: libc::POLLIN,
                    revents: 0,
                };
                nfds += 1;
            }
            if drain_deadline.is_none() {
                idx_exited = Some(nfds);
                pfds[nfds] = libc::pollfd {
                    fd: exited_rx.as_raw_fd(),
                    events: libc::POLLIN,
                    revents: 0,
                };
                nfds += 1;
            }

            let rc = unsafe { libc::poll(pfds.as_mut_ptr(), nfds as libc::nfds_t, timeout_ms) };
            if rc < 0 {
                if io::Error::last_os_error().kind() == io::ErrorKind::Interrupted {
                    continue;
                }
                break;
            }
            if rc == 0 {
                // Poll timed out; top of loop checks deadline.
                continue;
            }

            if let Some(i) = idx_exited {
                if pfds[i].revents != 0 {
                    drain_deadline = Some(Instant::now() + drain_after_exit);
                }
            }

            if let Some(i) = idx_stdout {
                let revents = pfds[i].revents;
                if (revents & libc::POLLHUP) != 0 {
                    stdout_hup = true;
                }
                if revents != 0 {
                    loop {
                        match stdout_pipe.read(&mut chunk) {
                            Ok(0) => {
                                stdout_open = false;
                                break;
                            }
                            Ok(n) => {
                                if stdout.len() < stdout_cap {
                                    let take = (stdout_cap - stdout.len()).min(n);
                                    stdout.extend_from_slice(&chunk[..take]);
                                    if take < n {
                                        stdout_truncated = true;
                                    }
                                } else {
                                    stdout_truncated = true;
                                }
                            }
                            Err(e) if e.kind() == io::ErrorKind::Interrupted => continue,
                            Err(e) if e.kind() == io::ErrorKind::WouldBlock => break,
                            Err(_) => {
                                stdout_open = false;
                                break;
                            }
                        }
                    }
                }
            }

            if let Some(i) = idx_stderr {
                let revents = pfds[i].revents;
                if (revents & libc::POLLHUP) != 0 {
                    stderr_hup = true;
                }
                if revents != 0 {
                    loop {
                        match stderr_pipe.read(&mut chunk) {
                            Ok(0) => {
                                stderr_open = false;
                                break;
                            }
                            Ok(n) => {
                                if stderr.len() < stderr_cap {
                                    let take = (stderr_cap - stderr.len()).min(n);
                                    stderr.extend_from_slice(&chunk[..take]);
                                    if take < n {
                                        stderr_truncated = true;
                                    }
                                } else {
                                    stderr_truncated = true;
                                }
                            }
                            Err(e) if e.kind() == io::ErrorKind::Interrupted => continue,
                            Err(e) if e.kind() == io::ErrorKind::WouldBlock => break,
                            Err(_) => {
                                stderr_open = false;
                                break;
                            }
                        }
                    }
                }
            }
        }

        (stdout, stdout_truncated, stderr, stderr_truncated)
    }

    pub(super) fn run_hardened_process(
        spec: &SpawnSpec,
        timeout: Duration,
        drain_after_exit: Duration,
        label: &str,
    ) -> Result<HardenedProcessOutput, String> {
        let (mut child, exited_rx, exited_tx) = {
            // Serialize pipe creation and fork/exec so CLOEXEC/FD races cannot
            // leak pipes across concurrent spawns.
            let _spawn_guard = SPAWN_LOCK.lock().unwrap_or_else(|e| e.into_inner());
            let (exited_rx, exited_tx) = create_cloexec_pipe().map_err(|e| {
                format!("HZ_PRECONDITION_FAILED: {label} exit pipe failed: {e}")
            })?;
            let mut cmd = Command::new(&spec.program);
            cmd.args(&spec.args);
            cmd.current_dir(&spec.cwd);
            cmd.env_clear();
            for (k, v) in &spec.env {
                cmd.env(k, v);
            }
            cmd.stdin(Stdio::null());
            cmd.stdout(Stdio::piped());
            cmd.stderr(Stdio::piped());
            unsafe {
                cmd.pre_exec(|| {
                    if libc::setpgid(0, 0) != 0 {
                        return Err(io::Error::last_os_error());
                    }
                    Ok(())
                });
            }
            let child = cmd
                .spawn()
                .map_err(|e| format!("HZ_PRECONDITION_FAILED: {label} failed: {e}"))?;
            (child, exited_rx, exited_tx)
        };

        let pid = child.id() as libc::pid_t;
        let stdout_pipe = child.stdout.take().ok_or_else(|| {
            kill_process_group_while_zombie(pid);
            reap_pid(pid);
            format!("HZ_PRECONDITION_FAILED: {label} missing stdout pipe")
        })?;
        let stderr_pipe = child.stderr.take().ok_or_else(|| {
            kill_process_group_while_zombie(pid);
            reap_pid(pid);
            format!("HZ_PRECONDITION_FAILED: {label} missing stderr pipe")
        })?;
        // Dropping `Child` neither waits nor kills; we manage zombie retention
        // via `waitid(WNOWAIT)` and reap explicitly via `waitpid`.
        drop(child);

        let reader = thread::spawn(move || {
            drain_pipes(
                stdout_pipe,
                stderr_pipe,
                exited_rx,
                SHELL_STDOUT_CAP,
                SHELL_STDERR_CAP,
                drain_after_exit,
            )
        });

        let deadline = Instant::now() + timeout;
        let (si_code, si_status) = loop {
            match wait_child_zombie_nonblocking(pid) {
                Ok(Some((code, status))) => break (code, status),
                Ok(None) => {
                    if Instant::now() >= deadline {
                        kill_process_group_while_zombie(pid);
                        wait_child_zombie_blocking(pid);
                        reap_pid(pid);
                        drop(exited_tx);
                        drop(reader);
                        return Err(format!(
                            "HZ_PRECONDITION_FAILED: {label} timed out after {}ms",
                            timeout.as_millis()
                        ));
                    }
                    thread::sleep(Duration::from_millis(20));
                }
                Err(e) if e.kind() == io::ErrorKind::Interrupted => continue,
                Err(e) => {
                    kill_process_group_while_zombie(pid);
                    reap_pid(pid);
                    drop(exited_tx);
                    drop(reader);
                    return Err(format!("HZ_PRECONDITION_FAILED: {label} wait failed: {e}"));
                }
            }
        };

        // Zombie is still retained here: PID/PGID cannot be recycled by the OS
        // while we tear down any surviving process-group members.
        kill_process_group_while_zombie(pid);
        reap_pid(pid);
        // Signal reader thread that the child has exited; starts DRAIN_AFTER_EXIT.
        drop(exited_tx);

        let (stdout, stdout_truncated, stderr, stderr_truncated) =
            reader.join().unwrap_or_default();
        if si_code != libc::CLD_EXITED {
            return Err(format!(
                "HZ_PRECONDITION_FAILED: {label} process terminated by signal"
            ));
        }
        Ok(HardenedProcessOutput {
            stdout,
            stdout_truncated,
            stderr,
            stderr_truncated,
            exit_code: si_status,
        })
    }
}

#[cfg(windows)]
mod win_proc {
    use super::*;
    use std::ffi::{c_void, OsStr};
    use std::io;
    use std::marker::PhantomData;
    use std::mem::{size_of, size_of_val};
    use std::os::windows::ffi::OsStrExt;
    use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
    use std::ptr::{null, null_mut};
    use std::sync::mpsc;

    use windows_sys::Win32::Foundation::{
        ERROR_ACCESS_DENIED, GENERIC_READ, HANDLE, INVALID_HANDLE_VALUE, WAIT_OBJECT_0,
        WAIT_TIMEOUT,
    };
    use windows_sys::Win32::Security::SECURITY_ATTRIBUTES;
    use windows_sys::Win32::Storage::FileSystem::{
        CreateFileW, FILE_SHARE_READ, FILE_SHARE_WRITE, OPEN_EXISTING,
    };

    pub(super) const PROC_THREAD_ATTRIBUTE_HANDLE_LIST: usize = 0x0002_0002;
    pub(super) const PROC_THREAD_ATTRIBUTE_JOB_LIST: usize = 0x0002_000D;
    const EXTENDED_STARTUPINFO_PRESENT: u32 = 0x0008_0000;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    const CREATE_UNICODE_ENVIRONMENT: u32 = 0x0000_0400;
    const STARTF_USESTDHANDLES: u32 = 0x0000_0100;
    const JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE: u32 = 0x0000_2000;
    const JOB_OBJECT_EXTENDED_LIMIT_INFORMATION_CLASS: i32 = 9;
    const HANDLE_FLAG_INHERIT: u32 = 0x0000_0001;
    const INFINITE: u32 = 0xFFFF_FFFF;

    #[repr(C)]
    #[derive(Default)]
    struct StartupInfoW {
        cb: u32,
        lp_reserved: *mut u16,
        lp_desktop: *mut u16,
        lp_title: *mut u16,
        dw_x: u32,
        dw_y: u32,
        dw_x_size: u32,
        dw_y_size: u32,
        dw_x_count_chars: u32,
        dw_y_count_chars: u32,
        dw_fill_attribute: u32,
        dw_flags: u32,
        w_show_window: u16,
        cb_reserved2: u16,
        lp_reserved2: *mut u8,
        h_std_input: HANDLE,
        h_std_output: HANDLE,
        h_std_error: HANDLE,
    }

    #[repr(C)]
    struct StartupInfoExW {
        startup_info: StartupInfoW,
        lp_attribute_list: *mut c_void,
    }

    #[repr(C)]
    #[derive(Default)]
    struct ProcessInformation {
        h_process: HANDLE,
        h_thread: HANDLE,
        dw_process_id: u32,
        dw_thread_id: u32,
    }

    #[repr(C)]
    #[derive(Default)]
    struct IoCounters {
        read_operation_count: u64,
        write_operation_count: u64,
        other_operation_count: u64,
        read_transfer_count: u64,
        write_transfer_count: u64,
        other_transfer_count: u64,
    }

    #[repr(C)]
    #[derive(Default)]
    struct JobObjectBasicLimitInformation {
        per_process_user_time_limit: i64,
        per_job_user_time_limit: i64,
        limit_flags: u32,
        minimum_working_set_size: usize,
        maximum_working_set_size: usize,
        active_process_limit: u32,
        affinity: usize,
        priority_class: u32,
        scheduling_class: u32,
    }

    #[repr(C)]
    #[derive(Default)]
    struct JobObjectExtendedLimitInformation {
        basic_limit_information: JobObjectBasicLimitInformation,
        io_info: IoCounters,
        process_memory_limit: usize,
        job_memory_limit: usize,
        peak_process_memory_used: usize,
        peak_job_memory_used: usize,
    }

    #[link(name = "kernel32")]
    extern "system" {
        fn CreateJobObjectW(
            lp_job_attributes: *const SECURITY_ATTRIBUTES,
            lp_name: *const u16,
        ) -> HANDLE;
        fn SetInformationJobObject(
            h_job: HANDLE,
            job_object_information_class: i32,
            lp_job_object_information: *const c_void,
            cb_job_object_information_length: u32,
        ) -> i32;
        fn TerminateJobObject(h_job: HANDLE, u_exit_code: u32) -> i32;
        #[cfg(test)]
        pub(super) fn IsProcessInJob(
            process_handle: HANDLE,
            job_handle: HANDLE,
            result: *mut i32,
        ) -> i32;
        fn InitializeProcThreadAttributeList(
            lp_attribute_list: *mut c_void,
            dw_attribute_count: u32,
            dw_flags: u32,
            lp_size: *mut usize,
        ) -> i32;
        fn UpdateProcThreadAttribute(
            lp_attribute_list: *mut c_void,
            dw_flags: u32,
            attribute: usize,
            lp_value: *const c_void,
            cb_size: usize,
            lp_previous_value: *mut c_void,
            lp_return_size: *const usize,
        ) -> i32;
        fn DeleteProcThreadAttributeList(lp_attribute_list: *mut c_void);
        fn CreateProcessW(
            lp_application_name: *const u16,
            lp_command_line: *mut u16,
            lp_process_attributes: *const SECURITY_ATTRIBUTES,
            lp_thread_attributes: *const SECURITY_ATTRIBUTES,
            b_inherit_handles: i32,
            dw_creation_flags: u32,
            lp_environment: *const c_void,
            lp_current_directory: *const u16,
            lp_startup_info: *const StartupInfoW,
            lp_process_information: *mut ProcessInformation,
        ) -> i32;
        pub(super) fn WaitForSingleObject(h_handle: HANDLE, dw_milliseconds: u32) -> u32;
        pub(super) fn GetExitCodeProcess(h_process: HANDLE, lp_exit_code: *mut u32) -> i32;
        fn TerminateProcess(h_process: HANDLE, u_exit_code: u32) -> i32;
        fn CreatePipe(
            h_read_pipe: *mut HANDLE,
            h_write_pipe: *mut HANDLE,
            lp_pipe_attributes: *const SECURITY_ATTRIBUTES,
            n_size: u32,
        ) -> i32;
        fn SetHandleInformation(h_object: HANDLE, dw_mask: u32, dw_flags: u32) -> i32;
    }

    fn owned_handle(handle: HANDLE) -> io::Result<OwnedHandle> {
        if handle.is_null() || handle == INVALID_HANDLE_VALUE {
            return Err(io::Error::last_os_error());
        }
        Ok(unsafe { OwnedHandle::from_raw_handle(handle) })
    }

    fn inheritable_sa() -> SECURITY_ATTRIBUTES {
        SECURITY_ATTRIBUTES {
            nLength: size_of::<SECURITY_ATTRIBUTES>() as u32,
            lpSecurityDescriptor: null_mut(),
            bInheritHandle: 1,
        }
    }

    fn create_pipe_pair() -> io::Result<(OwnedHandle, OwnedHandle)> {
        let sa = inheritable_sa();
        let mut read_h: HANDLE = null_mut();
        let mut write_h: HANDLE = null_mut();
        if unsafe { CreatePipe(&mut read_h, &mut write_h, &sa, 64 * 1024) } == 0 {
            return Err(io::Error::last_os_error());
        }
        let read = owned_handle(read_h)?;
        let write = owned_handle(write_h)?;
        // Parent read end must never be inherited by child processes.
        if unsafe { SetHandleInformation(read.as_raw_handle(), HANDLE_FLAG_INHERIT, 0) } == 0 {
            return Err(io::Error::last_os_error());
        }
        Ok((read, write))
    }

    fn null_stdin_handle() -> io::Result<OwnedHandle> {
        let name: Vec<u16> = "NUL\0".encode_utf16().collect();
        let sa = inheritable_sa();
        owned_handle(unsafe {
            CreateFileW(
                name.as_ptr(),
                GENERIC_READ,
                FILE_SHARE_READ | FILE_SHARE_WRITE,
                &sa,
                OPEN_EXISTING,
                0,
                null_mut(),
            )
        })
    }

    fn wide_os(value: &OsStr) -> io::Result<Vec<u16>> {
        let mut w: Vec<u16> = value.encode_wide().collect();
        if w.contains(&0) {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "path contains NUL",
            ));
        }
        w.push(0);
        Ok(w)
    }

    fn append_arg(line: &mut Vec<u16>, arg: &str) {
        let quote = arg.is_empty() || arg.contains([' ', '\t']);
        if quote {
            line.push('"' as u16);
        }
        let mut backslashes = 0usize;
        for unit in arg.encode_utf16() {
            if unit == '\\' as u16 {
                backslashes += 1;
            } else {
                if unit == '"' as u16 {
                    line.extend((0..=backslashes).map(|_| '\\' as u16));
                }
                backslashes = 0;
            }
            line.push(unit);
        }
        if quote {
            line.extend((0..backslashes).map(|_| '\\' as u16));
            line.push('"' as u16);
        }
    }

    fn command_line(program: &str, args: &[String]) -> io::Result<Vec<u16>> {
        if program.contains(['\0', '"']) || args.iter().any(|a| a.contains('\0')) {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "command cannot be passed to child process",
            ));
        }
        let mut line = Vec::new();
        line.push('"' as u16);
        line.extend(program.encode_utf16());
        line.push('"' as u16);
        for arg in args {
            line.push(' ' as u16);
            append_arg(&mut line, arg);
        }
        line.push(0);
        Ok(line)
    }

    fn environment_block(env: &[(String, String)]) -> io::Result<Vec<u16>> {
        let mut entries: Vec<(String, String)> = Vec::with_capacity(env.len());
        for (key, value) in env {
            if key.is_empty()
                || key == "="
                || key.contains('\0')
                || value.contains('\0')
                || key.strip_prefix('=').unwrap_or(key).contains('=')
            {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidInput,
                    "invalid environment variable for child process",
                ));
            }
            entries.push((key.clone(), value.clone()));
        }
        entries.sort_by(|a, b| {
            a.0.to_ascii_lowercase()
                .cmp(&b.0.to_ascii_lowercase())
                .then_with(|| b.0.cmp(&a.0))
        });
        entries.dedup_by(|a, b| a.0.eq_ignore_ascii_case(&b.0));
        let mut block = Vec::new();
        if entries.is_empty() {
            block.push(0);
        }
        for (key, value) in entries {
            block.extend(key.encode_utf16());
            block.push('=' as u16);
            block.extend(value.encode_utf16());
            block.push(0);
        }
        block.push(0);
        Ok(block)
    }

    pub(super) struct Job(OwnedHandle);

    impl Job {
        pub(super) fn new() -> io::Result<Self> {
            let job = owned_handle(unsafe { CreateJobObjectW(null(), null()) })?;
            let mut limits = JobObjectExtendedLimitInformation::default();
            limits.basic_limit_information.limit_flags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            if unsafe {
                SetInformationJobObject(
                    job.as_raw_handle(),
                    JOB_OBJECT_EXTENDED_LIMIT_INFORMATION_CLASS,
                    (&limits as *const JobObjectExtendedLimitInformation).cast(),
                    size_of_val(&limits) as u32,
                )
            } == 0
            {
                return Err(io::Error::last_os_error());
            }
            Ok(Self(job))
        }

        pub(super) fn handle(&self) -> HANDLE {
            self.0.as_raw_handle()
        }

        pub(super) fn terminate(&self) {
            unsafe {
                let _ = TerminateJobObject(self.0.as_raw_handle(), 1);
            }
        }
    }

    struct Attributes<'a> {
        _buffer: Vec<usize>,
        list: *mut c_void,
        _attached: PhantomData<&'a ()>,
    }

    impl<'a> Attributes<'a> {
        fn new(handles: &'a [HANDLE], jobs: Option<&'a [HANDLE]>) -> io::Result<Self> {
            let mut entries = vec![(
                PROC_THREAD_ATTRIBUTE_HANDLE_LIST,
                handles.as_ptr().cast::<c_void>(),
                size_of_val(handles),
            )];
            if let Some(jobs) = jobs {
                entries.push((
                    PROC_THREAD_ATTRIBUTE_JOB_LIST,
                    jobs.as_ptr().cast::<c_void>(),
                    size_of_val(jobs),
                ));
            }
            let mut bytes = 0usize;
            unsafe {
                InitializeProcThreadAttributeList(null_mut(), entries.len() as u32, 0, &mut bytes);
            }
            if bytes == 0 {
                return Err(io::Error::last_os_error());
            }
            let mut buffer = vec![0usize; bytes.div_ceil(size_of::<usize>())];
            let list = buffer.as_mut_ptr().cast::<c_void>();
            if unsafe {
                InitializeProcThreadAttributeList(list, entries.len() as u32, 0, &mut bytes)
            } == 0
            {
                return Err(io::Error::last_os_error());
            }
            let this = Self {
                _buffer: buffer,
                list,
                _attached: PhantomData,
            };
            for &(attribute, value, length) in &entries {
                if unsafe {
                    UpdateProcThreadAttribute(
                        this.list,
                        0,
                        attribute,
                        value,
                        length,
                        null_mut(),
                        null(),
                    )
                } == 0
                {
                    return Err(io::Error::last_os_error());
                }
            }
            Ok(this)
        }

        fn list(&self) -> *mut c_void {
            self.list
        }
    }

    impl Drop for Attributes<'_> {
        fn drop(&mut self) {
            unsafe {
                DeleteProcThreadAttributeList(self.list);
            }
        }
    }

    pub(super) struct SpawnedWinProcess {
        pub(super) process: OwnedHandle,
        pub(super) job: Option<Job>,
    }

    fn create_process_once(
        spec: &SpawnSpec,
        stdin: &OwnedHandle,
        stdout_write: &OwnedHandle,
        stderr_write: &OwnedHandle,
        job: Option<&Job>,
    ) -> io::Result<OwnedHandle> {
        let handles = [
            stdin.as_raw_handle(),
            stdout_write.as_raw_handle(),
            stderr_write.as_raw_handle(),
        ];
        let jobs = job.map(|j| [j.handle()]);
        let attributes = Attributes::new(&handles, jobs.as_ref().map(|j| j.as_slice()))?;
        let mut cmdline = command_line(&spec.program, &spec.args)?;
        let env_block = environment_block(&spec.env)?;
        let cwd_wide = wide_os(spec.cwd.as_os_str())?;

        let startup = StartupInfoExW {
            startup_info: StartupInfoW {
                cb: size_of::<StartupInfoExW>() as u32,
                dw_flags: STARTF_USESTDHANDLES,
                h_std_input: stdin.as_raw_handle(),
                h_std_output: stdout_write.as_raw_handle(),
                h_std_error: stderr_write.as_raw_handle(),
                ..Default::default()
            },
            lp_attribute_list: attributes.list(),
        };
        let mut info = ProcessInformation::default();
        let created = unsafe {
            CreateProcessW(
                null(),
                cmdline.as_mut_ptr(),
                null(),
                null(),
                1,
                CREATE_NO_WINDOW | CREATE_UNICODE_ENVIRONMENT | EXTENDED_STARTUPINFO_PRESENT,
                env_block.as_ptr().cast(),
                cwd_wide.as_ptr(),
                (&startup as *const StartupInfoExW).cast(),
                &mut info,
            )
        };
        if created == 0 {
            return Err(io::Error::last_os_error());
        }
        let process = owned_handle(info.h_process)?;
        drop(owned_handle(info.h_thread)?);
        Ok(process)
    }

    pub(super) fn spawn_in_job(
        spec: &SpawnSpec,
    ) -> io::Result<(SpawnedWinProcess, std::fs::File, std::fs::File)> {
        let stdin = null_stdin_handle()?;
        let (stdout_read, stdout_write) = create_pipe_pair()?;
        let (stderr_read, stderr_write) = create_pipe_pair()?;
        let job = Job::new().ok();

        let (process, job) = match create_process_once(
            spec,
            &stdin,
            &stdout_write,
            &stderr_write,
            job.as_ref(),
        ) {
            Ok(process) => (process, job),
            Err(err)
                if job.is_some() && err.raw_os_error() == Some(ERROR_ACCESS_DENIED as i32) =>
            {
                let process =
                    create_process_once(spec, &stdin, &stdout_write, &stderr_write, None)?;
                (process, None)
            }
            Err(err) => return Err(err),
        };
        // Drop parent copies of child stdio ends so EOF arrives on child exit.
        drop(stdin);
        drop(stdout_write);
        drop(stderr_write);

        Ok((
            SpawnedWinProcess { process, job },
            std::fs::File::from(stdout_read),
            std::fs::File::from(stderr_read),
        ))
    }

    fn recv_with_deadline(
        rx: &mpsc::Receiver<(Vec<u8>, bool)>,
        deadline: Instant,
    ) -> (Vec<u8>, bool) {
        let left = deadline.saturating_duration_since(Instant::now());
        rx.recv_timeout(left).unwrap_or_default()
    }

    pub(super) fn run_hardened_process(
        spec: &SpawnSpec,
        timeout: Duration,
        drain_after_exit: Duration,
        label: &str,
    ) -> Result<HardenedProcessOutput, String> {
        let (spawned, stdout_file, stderr_file) = spawn_in_job(spec)
            .map_err(|e| format!("HZ_PRECONDITION_FAILED: {label} failed: {e}"))?;

        let (stdout_tx, stdout_rx) = mpsc::channel();
        let (stderr_tx, stderr_rx) = mpsc::channel();
        thread::spawn(move || {
            let _ = stdout_tx.send(read_pipe_capped(stdout_file, SHELL_STDOUT_CAP));
        });
        thread::spawn(move || {
            let _ = stderr_tx.send(read_pipe_capped(stderr_file, SHELL_STDERR_CAP));
        });

        let wait_ms = timeout
            .as_millis()
            .min((INFINITE - 1) as u128) as u32;
        // Wait on the process handle BEFORE calling GetExitCodeProcess so a
        // process exiting with code 259 (STILL_ACTIVE) is never mistaken for
        // still running.
        let wait_rc = unsafe { WaitForSingleObject(spawned.process.as_raw_handle(), wait_ms) };
        if wait_rc == WAIT_TIMEOUT {
            if let Some(ref job) = spawned.job {
                job.terminate();
            } else {
                unsafe {
                    let _ = TerminateProcess(spawned.process.as_raw_handle(), 1);
                }
            }
            unsafe {
                let _ = WaitForSingleObject(spawned.process.as_raw_handle(), 5_000);
            }
            drop(spawned);
            return Err(format!(
                "HZ_PRECONDITION_FAILED: {label} timed out after {}ms",
                timeout.as_millis()
            ));
        }
        if wait_rc != WAIT_OBJECT_0 {
            let err = io::Error::last_os_error();
            if let Some(ref job) = spawned.job {
                job.terminate();
            } else {
                unsafe {
                    let _ = TerminateProcess(spawned.process.as_raw_handle(), 1);
                }
            }
            drop(spawned);
            return Err(format!(
                "HZ_PRECONDITION_FAILED: {label} wait failed: {err}"
            ));
        }

        let mut exit_code: u32 = 0;
        if unsafe { GetExitCodeProcess(spawned.process.as_raw_handle(), &mut exit_code) } == 0 {
            let err = io::Error::last_os_error();
            drop(spawned);
            return Err(format!(
                "HZ_PRECONDITION_FAILED: {label} exit code failed: {err}"
            ));
        }
        // Tear down any remaining descendants in the job object immediately.
        if let Some(ref job) = spawned.job {
            job.terminate();
        }
        drop(spawned);

        let drain_deadline = Instant::now() + drain_after_exit;
        let (stdout, stdout_truncated) = recv_with_deadline(&stdout_rx, drain_deadline);
        let (stderr, stderr_truncated) = recv_with_deadline(&stderr_rx, drain_deadline);

        Ok(HardenedProcessOutput {
            stdout,
            stdout_truncated,
            stderr,
            stderr_truncated,
            exit_code: exit_code as i32,
        })
    }
}

fn run_hardened_process(
    spec: &SpawnSpec,
    timeout: Duration,
    drain_after_exit: Duration,
    label: &str,
) -> Result<HardenedProcessOutput, String> {
    #[cfg(unix)]
    {
        unix_proc::run_hardened_process(spec, timeout, drain_after_exit, label)
    }
    #[cfg(windows)]
    {
        win_proc::run_hardened_process(spec, timeout, drain_after_exit, label)
    }
}

#[cfg(all(test, unix))]
static REDUCED_SHELL_SWAP_TO_SYMLINK: std::sync::Mutex<Option<(std::path::PathBuf, std::path::PathBuf)>> =
    std::sync::Mutex::new(None);

#[cfg(all(test, unix))]
fn apply_reduced_shell_test_swap() {
    let swap = REDUCED_SHELL_SWAP_TO_SYMLINK
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .clone();
    if let Some((dest, target)) = swap {
        let _ = std::fs::remove_file(&dest);
        std::os::unix::fs::symlink(&target, &dest).expect("test symlink swap");
    }
}

#[cfg(unix)]
fn copy_reduced_cp_nofollow(
    sandbox_root: &Path,
    cwd: &Path,
    parsed: &crate::effect_evidence::ParsedShellFsMutate,
) -> Result<(), String> {
    use std::ffi::CString;
    use std::os::unix::ffi::OsStrExt;
    use std::os::unix::io::{AsRawFd, FromRawFd};

    let from_raw = parsed.raw_path_from.as_deref().ok_or_else(|| {
        "HZ_PRECONDITION_FAILED: kernel cp missing source path".to_string()
    })?;
    let src = if Path::new(from_raw).is_absolute() {
        PathBuf::from(from_raw)
    } else {
        cwd.join(from_raw)
    };
    let dst = if Path::new(&parsed.raw_path).is_absolute() {
        PathBuf::from(&parsed.raw_path)
    } else {
        cwd.join(&parsed.raw_path)
    };
    if !crate::guard::path_contained_in(sandbox_root, &src)
        || !crate::guard::path_contained_in(sandbox_root, &dst)
    {
        return Err(
            "HZ_PRECONDITION_FAILED: kernel cp path must stay inside sandboxRoot".to_string(),
        );
    }
    let src_parent = src.parent().ok_or_else(|| {
        "HZ_PRECONDITION_FAILED: kernel cp source has no parent".to_string()
    })?;
    let dst_parent = dst.parent().ok_or_else(|| {
        "HZ_PRECONDITION_FAILED: kernel cp destination has no parent".to_string()
    })?;
    let src_name = src.file_name().ok_or_else(|| {
        "HZ_PRECONDITION_FAILED: kernel cp source has no file name".to_string()
    })?;
    let dst_name = dst.file_name().ok_or_else(|| {
        "HZ_PRECONDITION_FAILED: kernel cp destination has no file name".to_string()
    })?;

    fn open_dir(path: &Path) -> Result<std::fs::File, String> {
        let c = CString::new(path.as_os_str().as_bytes()).map_err(|_| {
            "HZ_PRECONDITION_FAILED: kernel cp directory path contains NUL".to_string()
        })?;
        let fd = unsafe {
            libc::open(
                c.as_ptr(),
                libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
            )
        };
        if fd < 0 {
            let err = std::io::Error::last_os_error();
            if err.raw_os_error() == Some(libc::ELOOP) {
                return Err(
                    "HZ_PRECONDITION_FAILED: kernel cp refuses symlink directory (O_NOFOLLOW)"
                        .to_string(),
                );
            }
            return Err(format!(
                "HZ_PRECONDITION_FAILED: kernel cp directory open failed: {err}"
            ));
        }
        Ok(unsafe { std::fs::File::from_raw_fd(fd) })
    }

    fn openat_name(dir: &std::fs::File, name: &std::ffi::OsStr, flags: i32, mode: libc::mode_t) -> Result<std::fs::File, String> {
        let c = CString::new(name.as_bytes()).map_err(|_| {
            "HZ_PRECONDITION_FAILED: kernel cp file name contains NUL".to_string()
        })?;
        let fd = unsafe { libc::openat(dir.as_raw_fd(), c.as_ptr(), flags, mode as libc::c_uint) };
        if fd < 0 {
            let err = std::io::Error::last_os_error();
            if err.raw_os_error() == Some(libc::ELOOP) {
                return Err(
                    "HZ_PRECONDITION_FAILED: kernel cp refuses symlink (O_NOFOLLOW)".to_string(),
                );
            }
            return Err(format!("HZ_PRECONDITION_FAILED: kernel cp openat failed: {err}"));
        }
        Ok(unsafe { std::fs::File::from_raw_fd(fd) })
    }

    fn ensure_regular_fd(file: &std::fs::File, label: &str) -> Result<(), String> {
        let mut st: libc::stat = unsafe { std::mem::zeroed() };
        if unsafe { libc::fstat(file.as_raw_fd(), &mut st) } != 0 {
            return Err(format!(
                "HZ_PRECONDITION_FAILED: kernel cp {label} fstat failed: {}",
                std::io::Error::last_os_error()
            ));
        }
        if ((st.st_mode as u32) & (libc::S_IFMT as u32)) != (libc::S_IFREG as u32) {
            return Err(format!(
                "HZ_PRECONDITION_FAILED: kernel cp refuses non-regular {label}"
            ));
        }
        Ok(())
    }

    let src_dir = open_dir(src_parent)?;
    let dst_dir = open_dir(dst_parent)?;
    let mut src_file = openat_name(
        &src_dir,
        src_name,
        libc::O_RDONLY | libc::O_NOFOLLOW | libc::O_CLOEXEC | libc::O_NONBLOCK,
        0,
    )?;
    ensure_regular_fd(&src_file, "source")?;
    let mut dst_file = openat_name(
        &dst_dir,
        dst_name,
        libc::O_WRONLY | libc::O_CREAT | libc::O_TRUNC | libc::O_NOFOLLOW | libc::O_CLOEXEC | libc::O_NONBLOCK,
        0o644,
    )?;
    ensure_regular_fd(&dst_file, "destination")?;
    std::io::copy(&mut src_file, &mut dst_file)
        .map_err(|e| format!("HZ_PRECONDITION_FAILED: kernel cp copy failed: {e}"))?;
    Ok(())
}

#[cfg(unix)]
fn touch_reduced_nofollow(
    sandbox_root: &Path,
    cwd: &Path,
    parsed: &crate::effect_evidence::ParsedShellFsMutate,
) -> Result<(), String> {
    use std::ffi::CString;
    use std::os::unix::ffi::OsStrExt;
    use std::os::unix::io::{AsRawFd, FromRawFd};

    let dst = if Path::new(&parsed.raw_path).is_absolute() {
        PathBuf::from(&parsed.raw_path)
    } else {
        cwd.join(&parsed.raw_path)
    };
    if !crate::guard::path_contained_in(sandbox_root, &dst) {
        return Err(
            "HZ_PRECONDITION_FAILED: kernel touch path must stay inside sandboxRoot".to_string(),
        );
    }
    let parent = dst.parent().ok_or_else(|| {
        "HZ_PRECONDITION_FAILED: kernel touch path has no parent".to_string()
    })?;
    let name = dst.file_name().ok_or_else(|| {
        "HZ_PRECONDITION_FAILED: kernel touch path has no file name".to_string()
    })?;
    let parent_c = CString::new(parent.as_os_str().as_bytes()).map_err(|_| {
        "HZ_PRECONDITION_FAILED: kernel touch directory path contains NUL".to_string()
    })?;
    let dir_fd = unsafe {
        libc::open(
            parent_c.as_ptr(),
            libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
        )
    };
    if dir_fd < 0 {
        let err = std::io::Error::last_os_error();
        if err.raw_os_error() == Some(libc::ELOOP) {
            return Err(
                "HZ_PRECONDITION_FAILED: kernel touch refuses symlink directory (O_NOFOLLOW)"
                    .to_string(),
            );
        }
        return Err(format!(
            "HZ_PRECONDITION_FAILED: kernel touch directory open failed: {err}"
        ));
    }
    let dir = unsafe { std::fs::File::from_raw_fd(dir_fd) };
    let name_c = CString::new(name.as_bytes()).map_err(|_| {
        "HZ_PRECONDITION_FAILED: kernel touch file name contains NUL".to_string()
    })?;
    let fd = unsafe {
        libc::openat(
            dir.as_raw_fd(),
            name_c.as_ptr(),
            libc::O_WRONLY | libc::O_CREAT | libc::O_NOFOLLOW | libc::O_CLOEXEC | libc::O_NONBLOCK,
            0o644,
        )
    };
    if fd < 0 {
        let err = std::io::Error::last_os_error();
        if err.raw_os_error() == Some(libc::ELOOP) {
            return Err(
                "HZ_PRECONDITION_FAILED: kernel touch refuses symlink (O_NOFOLLOW)".to_string(),
            );
        }
        return Err(format!("HZ_PRECONDITION_FAILED: kernel touch openat failed: {err}"));
    }
    let file = unsafe { std::fs::File::from_raw_fd(fd) };
    let mut st: libc::stat = unsafe { std::mem::zeroed() };
    if unsafe { libc::fstat(file.as_raw_fd(), &mut st) } != 0 {
        return Err(format!(
            "HZ_PRECONDITION_FAILED: kernel touch fstat failed: {}",
            std::io::Error::last_os_error()
        ));
    }
    if ((st.st_mode as u32) & (libc::S_IFMT as u32)) != (libc::S_IFREG as u32) {
        return Err(
            "HZ_PRECONDITION_FAILED: kernel touch refuses non-regular file".to_string(),
        );
    }
    let rc = unsafe { libc::futimens(file.as_raw_fd(), std::ptr::null()) };
    if rc != 0 {
        return Err(format!(
            "HZ_PRECONDITION_FAILED: kernel touch futimens failed: {}",
            std::io::Error::last_os_error()
        ));
    }
    Ok(())
}

const FS_DELTA_MAX_FILES: usize = 10_000;
const FS_DELTA_MAX_FILE_BYTES: u64 = 16 * 1024 * 1024;

fn in_kernel_fs_enabled() -> bool {
    std::env::var("HZ_EFFECT_HOST_IN_KERNEL_FS")
        .map(|v| v.trim() == "1")
        .unwrap_or(false)
}

fn fs_delta_observe_enabled() -> bool {
    std::env::var("HZ_EFFECT_HOST_FS_DELTA")
        .map(|v| v.trim() == "1")
        .unwrap_or(false)
}

pub fn kernel_extended_enabled() -> bool {
    std::env::var("HZ_EFFECT_HOST_KERNEL_EXTENDED")
        .map(|v| v.trim() == "1")
        .unwrap_or(false)
}

fn rel_to_workspace(workspace: &Path, cwd: &Path, raw_path: &str) -> Result<PathBuf, String> {
    let ws_canon = crate::guard::lexical_resolve(workspace).ok_or_else(|| {
        "HZ_PRECONDITION_FAILED: in-kernel fs op could not resolve workspace".to_string()
    })?;
    let candidate = if Path::new(raw_path).is_absolute() {
        PathBuf::from(raw_path)
    } else {
        cwd.join(raw_path)
    };
    // Preserve leaf symlink: resolve ONLY the parent directory so
    // `fs_delta_observe::in_kernel_*` receives the actual leaf entry and can
    // enforce O_NOFOLLOW / unlinkat on leaf symlinks instead of following them.
    let leaf = candidate.file_name().ok_or_else(|| {
        "HZ_PRECONDITION_FAILED: in-kernel fs op path has no leaf component".to_string()
    })?;
    if leaf == "." || leaf == ".." {
        return Err(
            "HZ_PRECONDITION_FAILED: in-kernel fs op refuses dot leaf component".to_string(),
        );
    }
    let parent = candidate.parent().ok_or_else(|| {
        "HZ_PRECONDITION_FAILED: in-kernel fs op path has no parent".to_string()
    })?;
    if !crate::guard::path_contained_in(workspace, parent) {
        return Err(
            "HZ_PRECONDITION_FAILED: in-kernel fs op parent must stay inside sandboxRoot"
                .to_string(),
        );
    }
    let resolved_parent = crate::guard::lexical_resolve(parent).ok_or_else(|| {
        "HZ_PRECONDITION_FAILED: in-kernel fs op parent could not be resolved".to_string()
    })?;
    let rel_parent = resolved_parent.strip_prefix(&ws_canon).map_err(|_| {
        "HZ_PRECONDITION_FAILED: in-kernel fs op path escaped sandboxRoot".to_string()
    })?;
    Ok(rel_parent.join(leaf))
}

/// P0-2: Execute reduced `touch`, `rm`, `mv`, or `install` argv directly in-kernel
/// via `fs_delta_observe::{in_kernel_touch, in_kernel_rm, in_kernel_mv, in_kernel_install}`
/// (anchored `O_NOFOLLOW` primitives). Returns `Ok(Some((receipt, reason)))` when handled,
/// `Ok(None)` when the shape is not one of those four primitives.
pub fn try_execute_in_kernel_fs_op(
    workspace: &Path,
    cwd: &Path,
    argv: &[String],
    parsed: &crate::effect_evidence::ParsedShellFsMutate,
) -> Result<Option<(crate::fs_delta_observe::FsOpReceipt, &'static str)>, String> {
    use crate::effect_evidence::ShellFsMutateShape;
    use crate::fs_delta_observe::{
        in_kernel_install, in_kernel_mv, in_kernel_rm, in_kernel_touch,
    };

    match parsed.shape {
        ShellFsMutateShape::Touch => {
            let rel = rel_to_workspace(workspace, cwd, &parsed.raw_path)?;
            let receipt = in_kernel_touch(workspace, &rel)
                .map_err(|e| format!("HZ_PRECONDITION_FAILED: {e}"))?;
            Ok(Some((
                receipt,
                "kernel touch via fs_delta_observe::in_kernel_touch (O_NOFOLLOW); touch was not spawned",
            )))
        }
        ShellFsMutateShape::Rm => {
            let rel = rel_to_workspace(workspace, cwd, &parsed.raw_path)?;
            let force = argv.len() == 3 && argv[1] == "-f";
            let receipt = in_kernel_rm(workspace, &rel, force)
                .map_err(|e| format!("HZ_PRECONDITION_FAILED: {e}"))?;
            Ok(Some((
                receipt,
                "kernel rm via fs_delta_observe::in_kernel_rm (O_NOFOLLOW); rm was not spawned",
            )))
        }
        ShellFsMutateShape::Mv => {
            let src_raw = parsed.raw_path_from.as_deref().ok_or_else(|| {
                "HZ_PRECONDITION_FAILED: in-kernel mv missing source path".to_string()
            })?;
            let src_rel = rel_to_workspace(workspace, cwd, src_raw)?;
            let dst_rel = rel_to_workspace(workspace, cwd, &parsed.raw_path)?;
            let receipt = in_kernel_mv(workspace, &src_rel, &dst_rel)
                .map_err(|e| format!("HZ_PRECONDITION_FAILED: {e}"))?;
            Ok(Some((
                receipt,
                "kernel mv via fs_delta_observe::in_kernel_mv (O_NOFOLLOW); mv was not spawned",
            )))
        }
        ShellFsMutateShape::Install => {
            let src_raw = parsed.raw_path_from.as_deref().ok_or_else(|| {
                "HZ_PRECONDITION_FAILED: in-kernel install missing source path".to_string()
            })?;
            let src_rel = rel_to_workspace(workspace, cwd, src_raw)?;
            let dst_rel = rel_to_workspace(workspace, cwd, &parsed.raw_path)?;
            let mode = if argv.len() == 5 && argv[1] == "-m" {
                u32::from_str_radix(argv[2].trim_start_matches("0o"), 8).ok()
            } else {
                None
            };
            let receipt = in_kernel_install(workspace, &src_rel, &dst_rel, mode)
                .map_err(|e| format!("HZ_PRECONDITION_FAILED: {e}"))?;
            Ok(Some((
                receipt,
                "kernel install via fs_delta_observe::in_kernel_install (O_NOFOLLOW); install was not spawned",
            )))
        }
        _ => Ok(None),
    }
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
    // P0-2: anything without a reduced postimage or a stream-only allowlist
    // entry can mutate or reach the network. Refuse before spawn. Reduced
    // shapes and stream-only programs still run.
    let side_effect = crate::effect_evidence::classify_shell_argv_side_effect(&argv);
    if matches!(
        side_effect,
        crate::effect_evidence::ShellSideEffectClass::ArbitraryFs
            | crate::effect_evidence::ShellSideEffectClass::LikelyNet
            | crate::effect_evidence::ShellSideEffectClass::Unknown
    ) {
        return Err(format!(
            "HZ_PRECONDITION_FAILED: effect.execute shell.exec refuses unobserved {} argv before spawn (never shell-net enforced)",
            crate::effect_evidence::shell_side_effect_class_label(side_effect)
        ));
    }
    let reduced = crate::effect_evidence::parse_reduced_shell_fs_mutate_argv(&argv);
    if let Some(parsed) = &reduced {
        crate::effect_evidence::preflight_reduced_shell_fs_targets(root, &resolved_cwd, parsed)?;
    }
    let pre_fs_snapshot = if fs_delta_observe_enabled() {
        crate::fs_delta_observe::capture_workspace_snapshot(
            root,
            FS_DELTA_MAX_FILES,
            FS_DELTA_MAX_FILE_BYTES,
        )
        .ok()
    } else {
        None
    };
    #[cfg(all(test, unix))]
    apply_reduced_shell_test_swap();
    #[allow(unused_mut)]
    let mut kernel_owned: Option<&'static str> = None;
    let mut in_kernel_fs_receipt: Option<crate::fs_delta_observe::FsOpReceipt> = None;
    if in_kernel_fs_enabled() {
        if let Some(parsed) = reduced.as_ref() {
            if let Some((receipt, reason)) =
                try_execute_in_kernel_fs_op(root, &resolved_cwd, &argv, parsed)?
            {
                in_kernel_fs_receipt = Some(receipt);
                kernel_owned = Some(reason);
            }
        }
    }
    #[cfg(unix)]
    if kernel_owned.is_none() {
        if let Some(parsed) = reduced.as_ref() {
            match parsed.shape {
                crate::effect_evidence::ShellFsMutateShape::Cp => {
                    copy_reduced_cp_nofollow(root, &resolved_cwd, parsed)?;
                    kernel_owned = Some("kernel cp via openat O_NOFOLLOW; cp was not spawned");
                }
                crate::effect_evidence::ShellFsMutateShape::Touch => {
                    touch_reduced_nofollow(root, &resolved_cwd, parsed)?;
                    kernel_owned = Some("kernel touch via openat O_NOFOLLOW; touch was not spawned");
                }
                _ => {}
            }
        }
    }
    let (
        stdout,
        stdout_truncated,
        stderr,
        stderr_truncated,
        exit_code,
        sandbox_wrapped,
        sandbox_wrap_reason,
        sandbox_exec_path,
    ) = if let Some(reason) = kernel_owned {
        (
            Vec::new(),
            false,
            Vec::new(),
            false,
            0,
            false,
            reason.to_string(),
            None,
        )
    } else {
        let (spec, sandbox_wrapped, sandbox_wrap_reason, sandbox_exec_path) =
            shell_exec_spawn(&argv, root, &resolved_cwd)?;
        let out = run_hardened_process(
            &spec,
            shell_exec_timeout(),
            DRAIN_AFTER_EXIT,
            "effect.execute shell.exec",
        )?;
        (
            out.stdout,
            out.stdout_truncated,
            out.stderr,
            out.stderr_truncated,
            out.exit_code,
            sandbox_wrapped,
            sandbox_wrap_reason,
            sandbox_exec_path,
        )
    };
    // D-5/P0-2: a genuine second observation. The captured bytes are written
    // and re-read through an independent I/O path; the digests are compared, so
    // a truncated or corrupted capture fails the evidence gate instead of being
    // "confirmed" by hashing one buffer twice.
    let stdout_second = reread_captured_stream(&stdout);
    let stderr_second = reread_captured_stream(&stderr);
    let stdout_obs = crate::effect_evidence::observe_captured_stream_digest_with_second(
        &stdout,
        stdout_second.as_deref(),
    );
    let stderr_obs = crate::effect_evidence::observe_captured_stream_digest_with_second(
        &stderr,
        stderr_second.as_deref(),
    );
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
        // Honesty: false means the temp-file second read was unavailable, so
        // only one capture exists (never claim a comparison that did not run).
        "stdoutDoubleObserved": stdout_second.is_some(),
        "stderrDoubleObserved": stderr_second.is_some(),
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
    if let Some(receipt) = in_kernel_fs_receipt {
        out["inKernelFsReceipt"] = serde_json::to_value(receipt).unwrap_or(Value::Null);
    }
    if let Some(before) = pre_fs_snapshot {
        if let Ok(after) = crate::fs_delta_observe::capture_workspace_snapshot(
            root,
            FS_DELTA_MAX_FILES,
            FS_DELTA_MAX_FILE_BYTES,
        ) {
            let backend = crate::fs_delta_observe::probe_fs_observation_backend();
            let backend_val = serde_json::to_value(&backend)
                .unwrap_or_else(|_| json!({ "backend": "workspace_snapshot_fallback" }));
            let backend_name = backend_val
                .get("backend")
                .and_then(Value::as_str)
                .unwrap_or("workspace_snapshot_fallback");
            let delta = crate::fs_delta_observe::compute_fs_delta(&before, &after);
            let mut fs_delta_json = json!({
                "backend": backend_name,
                "created": delta.created,
                "modified": delta.modified,
                "deleted": delta.deleted,
            });
            if let Some(reason) = backend_val.get("reason").and_then(Value::as_str) {
                fs_delta_json["backendReason"] = json!(reason);
            }
            out["fsDelta"] = fs_delta_json;
        }
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
        "HZ_PRECONDITION_FAILED: effect.execute fs.rename destination could not be resolved"
            .to_string()
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
    let resolved =
        crate::sandbox_path_verify::recheck_path_in_sandbox(root, &candidate, Some(&resolved))?;
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
    let mut staged: std::collections::HashMap<PathBuf, Vec<u8>> = std::collections::HashMap::new();
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
            "HZ_PRECONDITION_FAILED: effect.execute fs.batch path could not be resolved".to_string()
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
        if let Err(e) =
            crate::sandbox_atomic_write::rename_file_in_sandbox(root, from_resolved, to_resolved)
        {
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
                let _ =
                    crate::sandbox_atomic_write::write_bytes_atomic_in_sandbox(root, path, bytes);
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
    let resolved =
        crate::sandbox_path_verify::recheck_path_in_sandbox(root, &candidate, Some(&resolved))?;
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
fn intended_kernel_fs_edit_post_bytes(
    content: &str,
    old: &str,
    new: &str,
) -> Result<Vec<u8>, String> {
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

/// Hard bounds on `unique_preimage_forward_replay` to prevent O(N^3) CPU/RAM
/// DoS under `OwnerLock` when recovering large files.
const MAX_PREIMAGE_REPLAY_POST_BYTES: usize = 16 * 1024;
const MAX_PREIMAGE_REPLAY_SPAN_SLACK: usize = 256;
const MAX_PREIMAGE_REPLAY_CANDIDATES: usize = 50_000;

/// When execution already replaced `oldString`, reconstruct the unique preimage
/// whose single forward edit yields `post` (fails on ambiguity or budget overflow).
fn unique_preimage_forward_replay(post: &str, old: &str, new: &str) -> Result<String, String> {
    if post.len() > MAX_PREIMAGE_REPLAY_POST_BYTES {
        return Err(
            "HZ_PRECONDITION_FAILED: observe-settle fs.edit file exceeds preimage replay byte limit"
                .into(),
        );
    }
    let post_bytes = post.as_bytes();
    // Replacement span after line-ending/indentation repair stays near `new.len()`.
    let max_span = new
        .len()
        .saturating_mul(2)
        .saturating_add(MAX_PREIMAGE_REPLAY_SPAN_SLACK);
    let mut preimage: Option<String> = None;
    let mut checked: usize = 0;
    for i in 0..=post.len() {
        if !post.is_char_boundary(i) {
            continue;
        }
        let j_limit = i.saturating_add(max_span).min(post.len());
        for j in i..=j_limit {
            if !post.is_char_boundary(j) {
                continue;
            }
            checked += 1;
            if checked > MAX_PREIMAGE_REPLAY_CANDIDATES {
                return Err(
                    "HZ_PRECONDITION_FAILED: observe-settle fs.edit preimage replay candidate limit exceeded"
                        .into(),
                );
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
/// settlement did not persist (ruling **722** partial). Never writes bytes.
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
    let content = fs::read_to_string(&resolved)
        .map_err(|e| format!("HZ_PRECONDITION_FAILED: observe-settle fs.edit failed: {e}"))?;
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
    if let Some(expected_preimage) = spec.get("expectedPreimageDigest").and_then(Value::as_str) {
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
        return Err("HZ_PRECONDITION_FAILED: observe-settle fs.edit result digest unstable".into());
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

/// Independent disk observe for recovery when `fs.rename` finished but OwnerLog
/// settlement did not persist (P0-3 residual, docs/28 §14). Proves the source
/// is stably absent and the destination digest matches the caller-pinned
/// `expectedPreimageDigest`. Never moves or writes bytes during recovery.
pub fn observe_intended_fs_rename_settlement(params: &Value) -> Result<Value, String> {
    let sandbox_root = string_param(params, "sandboxRoot")?;
    let (raw_from, raw_to) = rename_paths_from_spec(params)?;
    let expected_preimage = dispatch_spec(params)?
        .get("expectedPreimageDigest")
        .and_then(Value::as_str)
        .filter(|digest| {
            digest.len() == 64
                && digest
                    .bytes()
                    .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        })
        .ok_or_else(|| {
            "HZ_PRECONDITION_FAILED: observe-settle fs.rename requires a lowercase SHA-256 expectedPreimageDigest".to_string()
        })?;
    let root = Path::new(&sandbox_root);
    let from_candidate = candidate_read_path(root, &raw_from);
    let to_candidate = candidate_read_path(root, &raw_to);
    if !crate::guard::path_contained_in(root, &from_candidate) {
        return Err("HZ_PRECONDITION_FAILED: observe-settle fs.rename source must resolve inside sandboxRoot".to_string());
    }
    if !crate::guard::path_contained_in(root, &to_candidate) {
        return Err("HZ_PRECONDITION_FAILED: observe-settle fs.rename destination must resolve inside sandboxRoot".to_string());
    }
    let from_resolved = crate::guard::lexical_resolve(&from_candidate).ok_or_else(|| {
        "HZ_PRECONDITION_FAILED: observe-settle fs.rename source could not be resolved".to_string()
    })?;
    let to_resolved = crate::guard::lexical_resolve(&to_candidate).ok_or_else(|| {
        "HZ_PRECONDITION_FAILED: observe-settle fs.rename destination could not be resolved"
            .to_string()
    })?;
    let from_resolved = crate::sandbox_path_verify::recheck_path_in_sandbox(
        root,
        &from_candidate,
        Some(&from_resolved),
    )?;
    let to_resolved = crate::sandbox_path_verify::recheck_path_in_sandbox(
        root,
        &to_candidate,
        Some(&to_resolved),
    )?;
    if !file_missing_stable(&from_resolved) || !file_missing_stable(&from_resolved) {
        return Err(
            "HZ_PRECONDITION_FAILED: observe-settle fs.rename source is not stably absent".into(),
        );
    }
    let obs = crate::receipt_postimage::observe_file_postimage(&to_resolved);
    if !obs.observation_stable {
        return Err(
            "HZ_PRECONDITION_FAILED: observe-settle fs.rename destination postimage unstable"
                .into(),
        );
    }
    let digest = obs.digest.as_deref().ok_or_else(|| {
        "HZ_PRECONDITION_FAILED: observe-settle fs.rename destination missing observed digest"
            .to_string()
    })?;
    if digest != expected_preimage {
        return Err(
            "HZ_PRECONDITION_FAILED: observe-settle fs.rename destination bytes do not match source preimage".into(),
        );
    }
    let result_obs = crate::effect_evidence::observe_kernel_fs_mutation_result_digest(
        crate::effect_evidence::FsMutationResultKind::Rename,
        &raw_to,
        Some(digest),
        Some(&raw_from),
    );
    if !result_obs.observation_stable {
        return Err(
            "HZ_PRECONDITION_FAILED: observe-settle fs.rename result digest unstable".into(),
        );
    }
    let mut out = json!({
        "verdict": "settled",
        "effectId": params.get("effectId"),
        "phases": ["allow", "execute", "observe"],
        "postimageObservationStable": true,
        "renameFromPath": from_resolved.to_string_lossy(),
        "renameToPath": to_resolved.to_string_lossy(),
        "contentDigest": digest,
        "resultDigestStable": true,
    });
    if let Some(d) = result_obs.digest {
        out["resultDigest"] = json!(d);
    }
    Ok(out)
}

/// Independent disk observe for recovery when a reduced `fs.batch` finished but
/// OwnerLog settlement did not persist (P0-3 residual). Every op is replayed
/// through the single-effect observer with its preimage pin stripped (the
/// preimage no longer exists after execution). Op targets must be distinct:
/// sequential same-path postimages are not independently reconstructible yet.
pub fn observe_intended_fs_batch_settlement(params: &Value) -> Result<Value, String> {
    fn fs_batch_path_key(path: &str) -> String {
        #[cfg(windows)]
        {
            path.to_ascii_lowercase()
        }
        #[cfg(not(windows))]
        {
            path.to_string()
        }
    }

    let sandbox_root = string_param(params, "sandboxRoot")?;
    let ops = parse_fs_batch_write_ops(params)?;
    let mut targets: std::collections::BTreeMap<
        String,
        (usize, std::collections::BTreeSet<String>),
    > = std::collections::BTreeMap::new();
    let mut last_kind: std::collections::BTreeMap<String, String> =
        std::collections::BTreeMap::new();
    // Final rename destination per SOURCE path (raw spelling — case-sensitive FS).
    let mut final_rename_to: std::collections::BTreeMap<String, String> =
        std::collections::BTreeMap::new();
    for op in &ops {
        let kind = op
            .get("kind")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_ascii_lowercase();
        if kind == "fs.rename" {
            if let (Some(from), Some(to)) = (
                op.get("from")
                    .and_then(Value::as_str)
                    .filter(|s| !s.is_empty()),
                op.get("to")
                    .and_then(Value::as_str)
                    .filter(|s| !s.is_empty()),
            ) {
                final_rename_to.insert(fs_batch_path_key(from), to.to_string());
            }
        }
        let keys: &[&str] = if kind == "fs.rename" {
            &["from", "to"]
        } else {
            &["path"]
        };
        for key in keys {
            let target = op
                .get(*key)
                .and_then(Value::as_str)
                .filter(|s| !s.is_empty())
                .ok_or_else(|| {
                    format!("HZ_PRECONDITION_FAILED: fs.batch observe op requires {key}")
                })?;
            let path_key = fs_batch_path_key(target);
            let entry = targets
                .entry(path_key.clone())
                .or_insert((0, std::collections::BTreeSet::new()));
            entry.0 += 1;
            entry.1.insert(kind.clone());
            last_kind.insert(path_key, kind.clone());
        }
    }
    // Only repeated exact writes to one path are independently observable: the
    // final bytes prove the last write. Mixed or interleaved kinds still refuse.
    let sequential_writes: std::collections::BTreeSet<String> = targets
        .iter()
        .filter(|(path, (count, kinds))| {
            if *count <= 1 {
                return false;
            }
            let last = last_kind.get(*path).map(String::as_str).unwrap_or("");
            (kinds.len() == 1 && kinds.contains("fs.write"))
                || (kinds.len() == 2
                    && kinds.contains("fs.write")
                    && kinds.contains("fs.delete")
                    && last == "fs.delete")
                // Same-path write→rename: the rename observer proves both
                // endpoints and the final block binds the last write bytes to
                // the destination. Gated on the path being a rename SOURCE, so
                // a rename destination that was also written stays refused.
                || (kinds.len() == 2
                    && kinds.contains("fs.write")
                    && kinds.contains("fs.rename")
                    && last == "fs.rename"
                    && final_rename_to.contains_key(*path))
        })
        .map(|(path, _)| path.clone())
        .collect();
    for (target, (count, kinds)) in &targets {
        if *count > 1 && !sequential_writes.contains(target) {
            return Err(format!(
                "HZ_PRECONDITION_FAILED: observe-settle fs.batch has duplicate target path {target:?} with kinds {kinds:?}; only exact write sequences are independently observable"
            ));
        }
    }
    // Last payload for each same-path write sequence, kept with its original
    // spelling so case-sensitive filesystems resolve the right path.
    let mut last_sequential_write: std::collections::BTreeMap<String, (String, Vec<u8>)> =
        std::collections::BTreeMap::new();
    for op in &ops {
        let kind = op
            .get("kind")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_ascii_lowercase();
        if kind != "fs.write" {
            continue;
        }
        let raw_path = op.get("path").and_then(Value::as_str).unwrap_or("");
        let path_key = fs_batch_path_key(raw_path);
        if !sequential_writes.contains(&path_key) {
            continue;
        }
        if last_kind.get(&path_key).map(String::as_str) == Some("fs.delete") {
            continue;
        }
        let mut spec = (*op).clone();
        spec.remove("kind");
        spec.remove("expectedPreimageDigest");
        let op_params = json!({
            "effectId": params.get("effectId"),
            "sandboxRoot": sandbox_root,
            "dispatch": { "kind": "fs.write", "spec": spec }
        });
        last_sequential_write.insert(
            path_key,
            (raw_path.to_string(), write_payload_from_spec(&op_params)?),
        );
    }

    let mut content_digests = Vec::new();
    let mut result_digests = Vec::new();
    for (index, op) in ops.iter().enumerate() {
        let kind = op
            .get("kind")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_ascii_lowercase();
        // Intermediate writes in a same-path sequence have no independent
        // postimage; the group check below proves the final bytes instead.
        if kind == "fs.write" {
            let raw = op.get("path").and_then(Value::as_str).unwrap_or("");
            if sequential_writes.contains(&fs_batch_path_key(raw)) {
                continue;
            }
        }
        if kind == "fs.rename" {
            let source = op.get("from").and_then(Value::as_str).unwrap_or("");
            if sequential_writes.contains(&fs_batch_path_key(source)) {
                // The final sequence check below binds the destination to the
                // last write payload, so the original preimage pin is inapplicable.
                continue;
            }
        }
        let mut spec = (*op).clone();
        spec.remove("kind");
        if kind != "fs.rename" {
            spec.remove("expectedPreimageDigest");
        }
        let op_params = json!({
            "effectId": params.get("effectId"),
            "sandboxRoot": sandbox_root,
            "dispatch": { "kind": kind, "spec": spec }
        });
        let observed = match kind.as_str() {
            "fs.write" => observe_intended_fs_write_settlement(&op_params)?,
            "fs.edit" => observe_intended_fs_edit_settlement(&op_params)?,
            "fs.delete" => observe_intended_fs_delete_settlement(&op_params)?,
            "fs.rename" => observe_intended_fs_rename_settlement(&op_params)?,
            _ => return Err(format!("HZ_PRECONDITION_FAILED: fs.batch observe refused unknown op kind {kind:?} at ops[{index}]")),
        };
        if observed.get("verdict").and_then(Value::as_str) != Some("settled")
            || observed.get("resultDigestStable").and_then(Value::as_bool) != Some(true)
        {
            return Err(format!(
                "HZ_PRECONDITION_FAILED: observe-settle fs.batch ops[{index}] ({kind}) is not independently settled"
            ));
        }
        content_digests.push(
            observed
                .get("contentDigest")
                .cloned()
                .unwrap_or(Value::Null),
        );
        result_digests.push(observed.get("resultDigest").cloned().unwrap_or(Value::Null));
    }
    let root = Path::new(&sandbox_root);
    for (_lower, (raw_path, payload)) in &last_sequential_write {
        let candidate = candidate_read_path(root, raw_path);
        if !crate::guard::path_contained_in(root, &candidate) {
            return Err(
                "HZ_PRECONDITION_FAILED: observe-settle fs.batch sequence path escapes sandboxRoot"
                    .into(),
            );
        }
        let resolved = crate::guard::lexical_resolve(&candidate).ok_or_else(|| {
            "HZ_PRECONDITION_FAILED: observe-settle fs.batch sequence path could not be resolved".to_string()
        })?;
        let resolved =
            crate::sandbox_path_verify::recheck_path_in_sandbox(root, &candidate, Some(&resolved))?;
        if last_kind.get(_lower).map(String::as_str) == Some("fs.rename") {
            // Rename source must be stably absent (two independent probes).
            if !file_missing_stable(&resolved) || !file_missing_stable(&resolved) {
                return Err("HZ_PRECONDITION_FAILED: observe-settle fs.batch sequence rename source not stably absent".into());
            }
            // The last write's bytes must be present at the RENAME DESTINATION,
            // verified through the same containment + recheck chain.
            let dest_raw = final_rename_to.get(_lower).ok_or_else(|| {
                "HZ_PRECONDITION_FAILED: observe-settle fs.batch rename destination missing"
                    .to_string()
            })?;
            let dest_candidate = candidate_read_path(root, dest_raw);
            if !crate::guard::path_contained_in(root, &dest_candidate) {
                return Err("HZ_PRECONDITION_FAILED: observe-settle fs.batch rename destination escapes sandboxRoot".into());
            }
            let dest_resolved = crate::guard::lexical_resolve(&dest_candidate).ok_or_else(|| {
                "HZ_PRECONDITION_FAILED: observe-settle fs.batch rename destination could not be resolved".to_string()
            })?;
            let dest_resolved = crate::sandbox_path_verify::recheck_path_in_sandbox(
                root,
                &dest_candidate,
                Some(&dest_resolved),
            )?;
            let obs = crate::receipt_postimage::observe_file_postimage(&dest_resolved);
            if !obs.observation_stable {
                return Err("HZ_PRECONDITION_FAILED: observe-settle fs.batch rename destination postimage unstable".into());
            }
            let expected = crate::canon::sha256_bytes(payload);
            if obs.digest.as_deref() != Some(expected.as_str()) {
                return Err("HZ_PRECONDITION_FAILED: observe-settle fs.batch rename destination bytes do not match last write intent".into());
            }
            content_digests.push(json!(expected));
            continue;
        }
        if last_kind.get(_lower).map(String::as_str) == Some("fs.delete") {
            if !file_missing_stable(&resolved) || !file_missing_stable(&resolved) {
                return Err("HZ_PRECONDITION_FAILED: observe-settle fs.batch sequence final path not stably absent".into());
            }
            content_digests.push(json!(EMPTY_SHA256_HEX));
            continue;
        }
        let obs = crate::receipt_postimage::observe_file_postimage(&resolved);
        if !obs.observation_stable {
            return Err(
                "HZ_PRECONDITION_FAILED: observe-settle fs.batch sequence postimage unstable"
                    .into(),
            );
        }
        let expected = crate::canon::sha256_bytes(payload);
        if obs.digest.as_deref() != Some(expected.as_str()) {
            return Err("HZ_PRECONDITION_FAILED: observe-settle fs.batch final bytes do not match last write intent".into());
        }
        content_digests.push(json!(expected));
    }
    Ok(json!({
        "verdict": "settled",
        "effectId": params.get("effectId"),
        "phases": ["allow", "execute", "observe"],
        "postimageObservationStable": true,
        "batchOpCount": ops.len(),
        "contentDigests": content_digests,
        "resultDigests": result_digests,
        "resultDigestStable": true,
    }))
}

/// Replay a caller-asserted read-only argv in a scrubbed child and return its
/// independently observed result. Never called from `execute` — recovery only.
fn replay_readonly_shell_for_observation(argv: &[String], cwd: &Path) -> Result<Value, String> {
    let spec = SpawnSpec {
        program: argv[0].clone(),
        args: argv[1..].to_vec(),
        cwd: cwd.to_path_buf(),
        env: vec![("PATH".to_string(), shell_exec_path())],
    };
    let out = run_hardened_process(
        &spec,
        shell_exec_timeout(),
        DRAIN_AFTER_EXIT,
        "observe-settle shell replay",
    )?;
    Ok(json!({
        "exitCode": out.exit_code,
        "stdoutDigest": crate::canon::sha256_bytes(&out.stdout),
        "stderrDigest": crate::canon::sha256_bytes(&out.stderr),
    }))
}

/// P0-3 reduction: settle an executed-UNKNOWN `shell.exec` only by replaying a
/// classified read-only argv and matching the pinned expected result digest.
/// Caller assertion alone cannot make an unknown or side-effecting program safe.
pub fn observe_intended_shell_exec_settlement(params: &Value) -> Result<Value, String> {
    let spec = dispatch_spec(params)?;
    if spec.get("readOnlyReplay").and_then(Value::as_bool) != Some(true) {
        return Err(
            "HZ_PRECONDITION_FAILED: shell observe-settle requires dispatch.spec.readOnlyReplay=true"
                .to_string(),
        );
    }
    let expected = spec
        .get("expectedResultDigest")
        .and_then(Value::as_str)
        .filter(|s| {
            s.len() == 64
                && s.bytes()
                    .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        })
        .ok_or_else(|| {
            "HZ_PRECONDITION_FAILED: shell observe-settle requires a 64-hex expectedResultDigest"
                .to_string()
        })?;
    let sandbox_root = string_param(params, "sandboxRoot")?;
    let root = Path::new(&sandbox_root);
    let argv = shell_argv_from_spec(params)?;
    // A caller assertion is not enough for programs known to mutate/reach the
    // network or whose behavior is unclassified. Refuse before spawning them.
    let side_effect = crate::effect_evidence::classify_shell_argv_side_effect(&argv);
    if matches!(
        side_effect,
        crate::effect_evidence::ShellSideEffectClass::ReducedFs
            | crate::effect_evidence::ShellSideEffectClass::ArbitraryFs
            | crate::effect_evidence::ShellSideEffectClass::LikelyNet
            | crate::effect_evidence::ShellSideEffectClass::Unknown
    ) {
        return Err(format!(
            "HZ_PRECONDITION_FAILED: shell observe-settle refuses mutating, net-capable, or unknown program ({})",
            crate::effect_evidence::shell_side_effect_class_label(side_effect)
        ));
    }
    let cwd_raw = shell_cwd_from_spec(params)?;
    let cwd = match cwd_raw {
        None => crate::guard::lexical_resolve(root).ok_or_else(|| {
            "HZ_PRECONDITION_FAILED: observe-settle shell sandboxRoot could not be resolved"
                .to_string()
        })?,
        Some(raw) => {
            let candidate = candidate_read_path(root, &raw);
            if !crate::guard::path_contained_in(root, &candidate) {
                return Err(
                    "HZ_PRECONDITION_FAILED: observe-settle shell cwd must resolve inside sandboxRoot"
                        .to_string(),
                );
            }
            crate::guard::lexical_resolve(&candidate).ok_or_else(|| {
                "HZ_PRECONDITION_FAILED: observe-settle shell cwd could not be resolved".to_string()
            })?
        }
    };
    let observed = replay_readonly_shell_for_observation(&argv, &cwd)?;
    let digest = crate::canon::sha256_hex(&crate::canon::canonical_json(&json!({
        "exitCode": observed["exitCode"],
        "stdoutDigest": observed["stdoutDigest"],
        "stderrDigest": observed["stderrDigest"],
    })));
    if digest != expected {
        return Err(format!(
            "HZ_PRECONDITION_FAILED: observe-settle shell result digest mismatch: expected {expected}, observed {digest}"
        ));
    }
    Ok(json!({
        "verdict": "settled",
        "effectId": params.get("effectId"),
        "phases": ["allow", "execute", "observe"],
        "replayed": true,
        "readonlyReplay": true,
        "exitCode": observed["exitCode"],
        "stdoutDigest": observed["stdoutDigest"],
        "stderrDigest": observed["stderrDigest"],
        "resultDigest": digest,
        "resultDigestStable": true,
    }))
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
            (Some(result_obs.observation_stable), result_obs.digest)
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

/// P0-1 opt-in (`HZ_EFFECT_HOST_KERNEL_EXTENDED=1`): metadata-admitted OwnerLog
/// settlement for `mcp.invoke`. Validates `serverId` and `toolName` and produces
/// a deterministic canonical metadata digest without executing ambient Bun code.
fn execute_mcp_invoke(
    params: &Value,
    ledger: &mut HermeticEffectLedger,
    effect_id: &str,
) -> Result<Value, String> {
    use sha2::{Digest, Sha256};

    let spec = dispatch_spec(params)?;
    let server_id = spec
        .get("serverId")
        .and_then(Value::as_str)
        .filter(|s| !s.trim().is_empty())
        .ok_or_else(|| {
            "HZ_PRECONDITION_FAILED: effect.execute mcp.invoke requires non-empty dispatch.spec.serverId".to_string()
        })?;
    let tool_name = spec
        .get("toolName")
        .and_then(Value::as_str)
        .filter(|s| !s.trim().is_empty())
        .ok_or_else(|| {
            "HZ_PRECONDITION_FAILED: effect.execute mcp.invoke requires non-empty dispatch.spec.toolName".to_string()
        })?;
    let args = spec.get("args").cloned().unwrap_or_else(|| json!({}));
    let canonical = crate::canon::canonical_json(&json!({
        "kind": "mcp.invoke",
        "serverId": server_id,
        "toolName": tool_name,
        "args": args,
    }));
    let digest = crate::canon::hex_encode(&Sha256::digest(canonical.as_bytes()));
    let phases = ledger.record_hermetic(effect_id);
    let verdict = reconcile(
        &phases,
        Some(HERMETIC_OBSERVE_RECEIPT_ID),
        Some(HERMETIC_OBSERVE_RECEIPT_SEQ),
        Some(true),
        None,
        None,
    );
    Ok(json!({
        "verdict": verdict.as_str(),
        "effectId": effect_id,
        "phases": ["allow", "execute", "observe"],
        "kind": "mcp.invoke",
        "admission": "metadata-admitted",
        "serverId": server_id,
        "toolName": tool_name,
        "resultDigest": digest,
        "resultDigestStable": true,
    }))
}

/// P0-1 opt-in (`HZ_EFFECT_HOST_KERNEL_EXTENDED=1`): sandboxed `hook.exec`
/// routed through `shell_exec_spawn` (`hz-sandbox-exec`) + `run_hardened_process`
/// with independent stream double-observation.
fn execute_hook_exec(
    params: &Value,
    ledger: &mut HermeticEffectLedger,
    effect_id: &str,
) -> Result<Value, String> {
    let sandbox_root = string_param(params, "sandboxRoot")?;
    let spec_obj = dispatch_spec(params)?;
    let argv = shell_argv_from_spec(params)?;
    let cwd_raw = shell_cwd_from_spec(params)?;
    let root = Path::new(&sandbox_root);
    let resolved_cwd = match cwd_raw {
        None => crate::guard::lexical_resolve(root).ok_or_else(|| {
            "HZ_PRECONDITION_FAILED: effect.execute hook.exec sandboxRoot could not be resolved"
                .to_string()
        })?,
        Some(ref raw) => {
            let candidate = candidate_read_path(root, raw);
            if !crate::guard::path_contained_in(root, &candidate) {
                return Err(
                    "HZ_PRECONDITION_FAILED: effect.execute hook.exec cwd must resolve inside sandboxRoot"
                        .to_string(),
                );
            }
            crate::guard::lexical_resolve(&candidate).ok_or_else(|| {
                "HZ_PRECONDITION_FAILED: effect.execute hook.exec cwd could not be resolved"
                    .to_string()
            })?
        }
    };
    if argv[0].contains('\0') {
        return Err(
            "HZ_PRECONDITION_FAILED: effect.execute hook.exec program must not contain NUL"
                .to_string(),
        );
    }
    let side_effect = crate::effect_evidence::classify_shell_argv_side_effect(&argv);
    if matches!(
        side_effect,
        crate::effect_evidence::ShellSideEffectClass::ArbitraryFs
            | crate::effect_evidence::ShellSideEffectClass::LikelyNet
            | crate::effect_evidence::ShellSideEffectClass::Unknown
    ) {
        return Err(format!(
            "HZ_PRECONDITION_FAILED: effect.execute hook.exec refuses unobserved {} argv before spawn (never shell-net enforced)",
            crate::effect_evidence::shell_side_effect_class_label(side_effect)
        ));
    }
    let (spawn_spec, sandbox_wrapped, sandbox_wrap_reason, sandbox_exec_path) =
        shell_exec_spawn(&argv, root, &resolved_cwd)?;
    let proc_out = run_hardened_process(
        &spawn_spec,
        shell_exec_timeout(),
        DRAIN_AFTER_EXIT,
        "effect.execute hook.exec",
    )?;
    let stdout_second = reread_captured_stream(&proc_out.stdout);
    let stderr_second = reread_captured_stream(&proc_out.stderr);
    let stdout_obs = crate::effect_evidence::observe_captured_stream_digest_with_second(
        &proc_out.stdout,
        stdout_second.as_deref(),
    );
    let stderr_obs = crate::effect_evidence::observe_captured_stream_digest_with_second(
        &proc_out.stderr,
        stderr_second.as_deref(),
    );
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
        "kind": "hook.exec",
        "exitCode": proc_out.exit_code,
        "resultDigestStable": result_digest_stable,
        "shellCwd": resolved_cwd.to_string_lossy(),
        "stdoutTruncated": proc_out.stdout_truncated,
        "stderrTruncated": proc_out.stderr_truncated,
        "sandboxExecWrapped": sandbox_wrapped,
        "sandboxExecWrapReason": sandbox_wrap_reason,
        "stdout": String::from_utf8_lossy(&proc_out.stdout),
        "stderr": String::from_utf8_lossy(&proc_out.stderr),
        "stdoutDoubleObserved": stdout_second.is_some(),
        "stderrDoubleObserved": stderr_second.is_some(),
    });
    if let Some(point) = spec_obj.get("point").and_then(Value::as_str) {
        out["point"] = json!(point);
    }
    if let Some(index) = spec_obj.get("index").and_then(Value::as_u64) {
        out["index"] = json!(index);
    }
    if stdout_obs.observation_stable {
        if let Some(d) = stdout_obs.digest {
            out["stdoutDigest"] = json!(d);
        }
    }
    if stderr_obs.observation_stable {
        if let Some(d) = stderr_obs.digest {
            out["stderrDigest"] = json!(d);
        }
    }
    if let Some(path) = sandbox_exec_path {
        out["sandboxExecPath"] = json!(path);
    }
    Ok(out)
}

/// JSON-RPC `effect.execute` — fail-closed except hermetic pure/echo/fs.read/fs.write/fs.edit/shell.exec (sandboxed).
pub fn execute_params(params: &Value, ledger: &mut HermeticEffectLedger) -> Result<Value, String> {
    let effect_id = string_param(params, "effectId")?;
    let kind = dispatch_kind(params)?;
    // P0-1 (ruling 914): mcp.invoke is a known, deliberately unsupported kernel
    // dispatch by default. Opt-in `HZ_EFFECT_HOST_KERNEL_EXTENDED=1` enables
    // metadata-admitted OwnerLog settlement.
    if kind.eq_ignore_ascii_case("mcp.invoke") {
        if kernel_extended_enabled() {
            return execute_mcp_invoke(params, ledger, &effect_id);
        }
        return Err(
            "HZ_PRECONDITION_FAILED: effect.execute does not execute \"mcp.invoke\": MCP tool calls are ambient Bun effects and are NOT kernel OwnerLog-admitted (ruling 914); the product refuses mutating MCP calls under EffectHost-on".to_string(),
        );
    }
    // P0-1 (ruling 918): hook.exec is likewise refused by default. Opt-in
    // `HZ_EFFECT_HOST_KERNEL_EXTENDED=1` enables sandboxed `hz-sandbox-exec`
    // hook execution.
    if kind.eq_ignore_ascii_case("hook.exec") {
        if kernel_extended_enabled() {
            return execute_hook_exec(params, ledger, &effect_id);
        }
        return Err(
            "HZ_PRECONDITION_FAILED: effect.execute does not execute \"hook.exec\": hook processes are admitted as spawn actions by the runtime (ruling 909) and are NOT kernel OwnerLog-admitted (ruling 918)".to_string(),
        );
    }
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
        let phases = [
            EffectPhase::Allow,
            EffectPhase::Execute,
            EffectPhase::Observe,
        ];
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
        let phases = [
            EffectPhase::Allow,
            EffectPhase::Execute,
            EffectPhase::Observe,
        ];
        assert_eq!(
            reconcile(&phases, Some(""), Some(1), None, None, None),
            EffectVerdict::Unknown
        );
    }

    #[test]
    fn unknown_when_result_digest_unstable() {
        let phases = [
            EffectPhase::Allow,
            EffectPhase::Execute,
            EffectPhase::Observe,
        ];
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
        let phases = [
            EffectPhase::Allow,
            EffectPhase::Execute,
            EffectPhase::Observe,
        ];
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
        let phases = [
            EffectPhase::Allow,
            EffectPhase::Execute,
            EffectPhase::Observe,
        ];
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
    fn execute_shell_exec_refuses_unobserved_mutators_before_spawn() {
        let sandbox =
            std::env::temp_dir().join(format!("hz-eff-shell-unobs-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&sandbox);
        std::fs::create_dir_all(&sandbox).unwrap();
        std::fs::write(sandbox.join("note.txt"), b"keep").unwrap();
        let mut ledger = HermeticEffectLedger::default();
        let err = execute_params(
            &json!({
                "effectId": "eff-ln",
                "sandboxRoot": sandbox.to_string_lossy(),
                "dispatch": { "kind": "shell.exec", "spec": { "argv": ["ln", "-s", "note.txt", "alias.txt"] } }
            }),
            &mut ledger,
        )
        .unwrap_err();
        assert!(err.contains("arbitrary_fs"), "{err}");
        assert!(
            !sandbox.join("alias.txt").exists(),
            "unobserved ln created a symlink"
        );
        let net = execute_params(
            &json!({
                "effectId": "eff-curl",
                "sandboxRoot": sandbox.to_string_lossy(),
                "dispatch": { "kind": "shell.exec", "spec": { "argv": ["curl", "--version"] } }
            }),
            &mut ledger,
        )
        .unwrap_err();
        assert!(net.contains("likely_net"), "{net}");
        let unknown = execute_params(
            &json!({
                "effectId": "eff-date",
                "sandboxRoot": sandbox.to_string_lossy(),
                "dispatch": { "kind": "shell.exec", "spec": { "argv": ["date"] } }
            }),
            &mut ledger,
        )
        .unwrap_err();
        assert!(unknown.contains("unknown"), "{unknown}");
        let _ = std::fs::remove_dir_all(&sandbox);
    }

    #[test]
    #[cfg(unix)]
    fn execute_shell_exec_refuses_cp_through_symlink_to_outside() {
        use std::os::unix::fs::symlink;

        let sandbox =
            std::env::temp_dir().join(format!("hz-eff-shell-symlink-{}", std::process::id()));
        let outside =
            std::env::temp_dir().join(format!("hz-eff-shell-outside-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&sandbox);
        let _ = std::fs::remove_dir_all(&outside);
        std::fs::create_dir_all(&sandbox).unwrap();
        std::fs::create_dir_all(&outside).unwrap();
        std::fs::write(sandbox.join("note.txt"), b"src").unwrap();
        let secret = outside.join("secret.txt");
        std::fs::write(&secret, b"secret").unwrap();
        symlink(&secret, sandbox.join("alias.txt")).unwrap();
        let mut ledger = HermeticEffectLedger::default();
        let err = execute_params(
            &json!({
                "effectId": "eff-cp-symlink",
                "sandboxRoot": sandbox.to_string_lossy(),
                "dispatch": { "kind": "shell.exec", "spec": { "argv": ["cp", "note.txt", "alias.txt"] } }
            }),
            &mut ledger,
        )
        .unwrap_err();
        assert!(
            err.contains("sandboxRoot") || err.contains("symlink"),
            "{err}"
        );
        assert_eq!(std::fs::read(&secret).unwrap(), b"secret");
        std::fs::write(sandbox.join("copy.txt"), b"old").unwrap();
        let copied = execute_params(
            &json!({
                "effectId": "eff-cp-inside",
                "sandboxRoot": sandbox.to_string_lossy(),
                "dispatch": { "kind": "shell.exec", "spec": { "argv": ["cp", "note.txt", "copy.txt"] } }
            }),
            &mut ledger,
        )
        .expect("in-sandbox cp");
        assert_eq!(copied["exitCode"], 0);
        assert_eq!(std::fs::read(sandbox.join("copy.txt")).unwrap(), b"src");
        let _ = std::fs::remove_dir_all(&sandbox);
        let _ = std::fs::remove_dir_all(&outside);
    }

    #[test]
    #[cfg(unix)]
    fn execute_shell_exec_cp_misses_symlink_swap_after_preflight() {
        let sandbox =
            std::env::temp_dir().join(format!("hz-eff-shell-swap-{}", std::process::id()));
        let outside =
            std::env::temp_dir().join(format!("hz-eff-shell-swap-out-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&sandbox);
        let _ = std::fs::remove_dir_all(&outside);
        std::fs::create_dir_all(&sandbox).unwrap();
        std::fs::create_dir_all(&outside).unwrap();
        std::fs::write(sandbox.join("note.txt"), b"src").unwrap();
        let dest = sandbox.join("copy.txt");
        std::fs::write(&dest, b"old").unwrap();
        let secret = outside.join("secret.txt");
        std::fs::write(&secret, b"secret").unwrap();
        *REDUCED_SHELL_SWAP_TO_SYMLINK.lock().unwrap() = Some((dest.clone(), secret.clone()));
        let mut ledger = HermeticEffectLedger::default();
        let result = execute_params(
            &json!({
                "effectId": "eff-cp-swap",
                "sandboxRoot": sandbox.to_string_lossy(),
                "dispatch": { "kind": "shell.exec", "spec": { "argv": ["cp", "note.txt", "copy.txt"] } }
            }),
            &mut ledger,
        );
        *REDUCED_SHELL_SWAP_TO_SYMLINK.lock().unwrap() = None;
        assert!(result.is_err(), "cp followed the swapped symlink: {result:?}");
        assert_eq!(std::fs::read(&secret).unwrap(), b"secret");
        let _ = std::fs::remove_dir_all(&sandbox);
        let _ = std::fs::remove_dir_all(&outside);
    }

    #[test]
    #[cfg(unix)]
    fn execute_shell_exec_touch_follows_symlink_swap_after_preflight() {
        let sandbox =
            std::env::temp_dir().join(format!("hz-eff-touch-swap-{}", std::process::id()));
        let outside =
            std::env::temp_dir().join(format!("hz-eff-touch-out-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&sandbox);
        let _ = std::fs::remove_dir_all(&outside);
        std::fs::create_dir_all(&sandbox).unwrap();
        std::fs::create_dir_all(&outside).unwrap();
        let dest = sandbox.join("copy.txt");
        std::fs::write(&dest, b"old").unwrap();
        let secret = outside.join("secret.txt");
        std::fs::write(&secret, b"secret").unwrap();
        let before = std::fs::metadata(&secret).unwrap().modified().unwrap();
        std::thread::sleep(std::time::Duration::from_millis(20));
        *REDUCED_SHELL_SWAP_TO_SYMLINK.lock().unwrap() = Some((dest.clone(), secret.clone()));
        let mut ledger = HermeticEffectLedger::default();
        let _ = execute_params(
            &json!({
                "effectId": "eff-touch-swap",
                "sandboxRoot": sandbox.to_string_lossy(),
                "dispatch": { "kind": "shell.exec", "spec": { "argv": ["touch", "copy.txt"] } }
            }),
            &mut ledger,
        );
        *REDUCED_SHELL_SWAP_TO_SYMLINK.lock().unwrap() = None;
        let after = std::fs::metadata(&secret).unwrap().modified().unwrap();
        assert_eq!(std::fs::read(&secret).unwrap(), b"secret");
        assert_eq!(before, after, "touch followed the swapped symlink");
        std::fs::write(sandbox.join("plain.txt"), b"keep").unwrap();
        let plain = execute_params(
            &json!({
                "effectId": "eff-touch-plain",
                "sandboxRoot": sandbox.to_string_lossy(),
                "dispatch": { "kind": "shell.exec", "spec": { "argv": ["touch", "plain.txt"] } }
            }),
            &mut ledger,
        )
        .expect("in-sandbox touch");
        assert_eq!(plain["exitCode"], 0);
        assert_eq!(std::fs::read(sandbox.join("plain.txt")).unwrap(), b"keep");
        let _ = std::fs::remove_dir_all(&sandbox);
        let _ = std::fs::remove_dir_all(&outside);
    }

    static SHELL_ENV_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

    #[test]
    fn execute_shell_exec_in_sandbox_returns_digests() {
        let _guard = SHELL_ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
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

    static SANDBOX_ENV_TEST_LOCK: Mutex<()> = Mutex::new(());

    #[test]
    fn execute_shell_exec_refuses_bare_argv_when_require_wrap_and_helper_missing() {
        let _env_guard = SANDBOX_ENV_TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let _guard = SHELL_ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let sandbox =
            std::env::temp_dir().join(format!("hz-eff-shell-req-wrap-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&sandbox);
        std::fs::create_dir_all(&sandbox).unwrap();
        let prev_require = std::env::var("HZ_SANDBOX_REQUIRE").ok();
        let prev_bin = std::env::var("HZ_SANDBOX_EXEC_BIN").ok();
        std::env::set_var("HZ_SANDBOX_REQUIRE", "1");
        std::env::set_var(
            "HZ_SANDBOX_EXEC_BIN",
            "/nonexistent/hz-sandbox-exec-missing",
        );
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
            Some(v) => std::env::set_var("HZ_SANDBOX_REQUIRE", v),
            None => std::env::remove_var("HZ_SANDBOX_REQUIRE"),
        }
        match prev_bin {
            Some(v) => std::env::set_var("HZ_SANDBOX_EXEC_BIN", v),
            None => std::env::remove_var("HZ_SANDBOX_EXEC_BIN"),
        }
        assert!(err.contains("HZ_SANDBOX_REQUIRE=1"), "{err}");
        assert!(err.contains("never shell-net enforced"), "{err}");
        let _ = std::fs::remove_dir_all(&sandbox);
    }

    #[test]
    fn execute_shell_exec_sandbox_wrap_honesty_fields() {
        let _env_guard = SANDBOX_ENV_TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let sandbox =
            std::env::temp_dir().join(format!("hz-eff-shell-wrap-{}", std::process::id()));
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
            assert!(out
                .get("sandboxExecPath")
                .and_then(|v| v.as_str())
                .is_some());
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
        let sandbox =
            std::env::temp_dir().join(format!("hz-eff-batch-edit-{}", std::process::id()));
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
        let sandbox =
            std::env::temp_dir().join(format!("hz-eff-batch-stale-{}", std::process::id()));
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

    #[test]
    fn observe_rename_recovery_rejects_destination_not_matching_source_preimage() {
        let sandbox =
            std::env::temp_dir().join(format!("hz-eff-rename-pin-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&sandbox).unwrap();
        let from = sandbox.join("old.txt");
        let to = sandbox.join("new.txt");
        let original = b"source-intent";
        let expected = crate::canon::sha256_bytes(original);
        std::fs::write(&from, original).unwrap();
        std::fs::rename(&from, &to).unwrap();
        std::fs::write(&to, b"replacement-after-rename").unwrap();

        let direct = json!({
            "effectId": "rename-pin-direct",
            "sandboxRoot": sandbox.to_string_lossy(),
            "dispatch": { "kind": "fs.rename", "spec": {
                "from": "old.txt",
                "to": "new.txt",
                "expectedPreimageDigest": expected
            } }
        });
        let direct_refused = observe_intended_fs_rename_settlement(&direct).unwrap_err();
        assert!(
            direct_refused.contains("preimage") || direct_refused.contains("destination"),
            "{direct_refused}"
        );
        let mut unpinned = direct.clone();
        unpinned["dispatch"]["spec"]
            .as_object_mut()
            .unwrap()
            .remove("expectedPreimageDigest");
        let missing_pin = observe_intended_fs_rename_settlement(&unpinned).unwrap_err();
        assert!(
            missing_pin.contains("expectedPreimageDigest"),
            "{missing_pin}"
        );
        let batch = json!({
            "effectId": "rename-pin-batch",
            "sandboxRoot": sandbox.to_string_lossy(),
            "dispatch": { "kind": "fs.batch", "spec": { "ops": [{
                "kind": "fs.rename",
                "from": "old.txt",
                "to": "new.txt",
                "expectedPreimageDigest": expected
            }] } }
        });
        let batch_refused = observe_intended_fs_batch_settlement(&batch).unwrap_err();
        assert!(
            batch_refused.contains("preimage") || batch_refused.contains("destination"),
            "{batch_refused}"
        );
        assert!(!from.exists(), "refusal must not restore the rename source");
        assert_eq!(std::fs::read(&to).unwrap(), b"replacement-after-rename");
        let _ = std::fs::remove_dir_all(&sandbox);
    }

    #[test]
    fn observe_intended_fs_rename_settlement_proves_disk_state() {
        let sandbox =
            std::env::temp_dir().join(format!("hz-eff-observe-rename-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&sandbox);
        std::fs::create_dir_all(&sandbox).unwrap();
        std::fs::write(sandbox.join("old.txt"), b"renamed-bytes").unwrap();
        std::fs::rename(sandbox.join("old.txt"), sandbox.join("new.txt")).unwrap();
        let params = json!({
            "effectId": "rename-observe",
            "sandboxRoot": sandbox.to_string_lossy(),
            "dispatch": { "kind": "fs.rename", "spec": { "from": "old.txt", "to": "new.txt", "expectedPreimageDigest": crate::canon::sha256_bytes(b"renamed-bytes") } }
        });
        let observed = observe_intended_fs_rename_settlement(&params).unwrap();
        assert_eq!(observed["verdict"], json!("settled"));
        assert_eq!(
            observed["contentDigest"],
            json!(crate::canon::sha256_bytes(b"renamed-bytes"))
        );
        assert_eq!(observed["resultDigestStable"], json!(true));
        assert!(observed["renameFromPath"]
            .as_str()
            .unwrap()
            .replace('\\', "/")
            .ends_with("old.txt"));
        assert!(observed["renameToPath"]
            .as_str()
            .unwrap()
            .replace('\\', "/")
            .ends_with("new.txt"));
        // A source that is still present must not prove a rename.
        std::fs::write(sandbox.join("old.txt"), b"still-here").unwrap();
        let refused = observe_intended_fs_rename_settlement(&params).unwrap_err();
        assert!(
            refused.contains("source") || refused.contains("absent"),
            "{refused}"
        );
        let _ = std::fs::remove_dir_all(&sandbox);
    }

    #[cfg(unix)]
    #[test]
    fn observe_intended_shell_exec_settlement_replays_readonly_intent() {
        let sandbox =
            std::env::temp_dir().join(format!("hz-eff-observe-shell-{}", std::process::id()));
        let _ = fs::remove_dir_all(&sandbox);
        fs::create_dir_all(&sandbox).unwrap();
        // `echo` is explicitly classified as stream-only and emits deterministic output.
        let argv = vec!["echo".to_string(), "observe-settle".to_string()];

        let observation = replay_readonly_shell_for_observation(&argv, &sandbox).unwrap();
        let expected = crate::canon::sha256_hex(&crate::canon::canonical_json(&json!({
            "exitCode": observation["exitCode"],
            "stdoutDigest": observation["stdoutDigest"],
            "stderrDigest": observation["stderrDigest"],
        })));
        let params = json!({
            "effectId": "shell-observe",
            "sandboxRoot": sandbox.to_string_lossy(),
            "dispatch": { "kind": "shell.exec", "spec": {
                "argv": argv,
                "readOnlyReplay": true,
                "expectedResultDigest": expected
            } }
        });
        let settled = observe_intended_shell_exec_settlement(&params).unwrap();
        assert_eq!(settled["verdict"], json!("settled"), "{settled}");
        assert_eq!(settled["replayed"], json!(true));
        assert_eq!(settled["exitCode"], observation["exitCode"]);

        // Without the explicit read-only assertion the observer refuses.
        let unsafe_params = json!({
            "effectId": "shell-observe-unsafe",
            "sandboxRoot": sandbox.to_string_lossy(),
            "dispatch": { "kind": "shell.exec", "spec": {
                "argv": argv,
                "expectedResultDigest": expected
            } }
        });
        let refused = observe_intended_shell_exec_settlement(&unsafe_params).unwrap_err();
        assert!(refused.contains("readOnlyReplay"), "{refused}");

        // A wrong expected digest fails closed too.
        let wrong = json!({
            "effectId": "shell-observe-wrong",
            "sandboxRoot": sandbox.to_string_lossy(),
            "dispatch": { "kind": "shell.exec", "spec": {
                "argv": argv,
                "readOnlyReplay": true,
                "expectedResultDigest": "0".repeat(64)
            } }
        });
        let refused = observe_intended_shell_exec_settlement(&wrong).unwrap_err();
        assert!(refused.contains("digest"), "{refused}");

        // A known mutating program is refused even with a caller assertion.
        let mutating = json!({
            "effectId": "shell-observe-mutating",
            "sandboxRoot": sandbox.to_string_lossy(),
            "dispatch": { "kind": "shell.exec", "spec": {
                "argv": ["rm", "-f", "x.txt"],
                "readOnlyReplay": true,
                "expectedResultDigest": expected
            } }
        });
        let refused = observe_intended_shell_exec_settlement(&mutating).unwrap_err();
        assert!(refused.contains("mutating"), "{refused}");
        let _ = fs::remove_dir_all(&sandbox);
    }

    #[test]
    fn observe_intended_shell_exec_settlement_refuses_unknown_program_before_spawn() {
        let sandbox = std::env::temp_dir().join(format!(
            "hz-eff-observe-shell-unknown-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&sandbox);
        fs::create_dir_all(&sandbox).unwrap();
        let sentinel = sandbox.join("should-not-be-created");
        let exe = std::env::current_exe().unwrap();
        let argv = vec![
            exe.to_string_lossy().to_string(),
            "--exact".to_string(),
            "effect_host::tests::unknown_shell_observe_side_effect_probe".to_string(),
            "--nocapture".to_string(),
            "--".to_string(),
            sentinel.to_string_lossy().to_string(),
        ];
        assert_eq!(
            crate::effect_evidence::classify_shell_argv_side_effect(&argv),
            crate::effect_evidence::ShellSideEffectClass::Unknown
        );
        let params = json!({
            "effectId": "shell-observe-unknown",
            "sandboxRoot": sandbox.to_string_lossy(),
            "dispatch": { "kind": "shell.exec", "spec": {
                "argv": argv,
                "readOnlyReplay": true,
                "expectedResultDigest": "0000000000000000000000000000000000000000000000000000000000000000"
            } }
        });

        let refused = observe_intended_shell_exec_settlement(&params).unwrap_err();
        assert!(
            !sentinel.exists(),
            "unknown executable was spawned during observe-settle: {refused}"
        );
        assert!(refused.contains("unknown"), "{refused}");
        let _ = fs::remove_dir_all(&sandbox);
    }

    #[test]
    fn unknown_shell_observe_side_effect_probe() {
        let mut args = std::env::args();
        if args.find(|arg| arg == "--").is_some() {
            if let Some(sentinel) = args.next() {
                fs::write(sentinel, b"side effect").unwrap();
            }
        }
    }

    #[cfg(unix)]
    #[test]
    fn observe_intended_shell_exec_settlement_timeout_fails_closed() {
        let argv = vec!["sleep".to_string(), "5".to_string()];
        let sandbox = std::env::temp_dir().join(format!(
            "hz-eff-observe-shell-timeout-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&sandbox);
        fs::create_dir_all(&sandbox).unwrap();
        let params = json!({
            "effectId": "shell-timeout",
            "sandboxRoot": sandbox.to_string_lossy(),
            "dispatch": { "kind": "shell.exec", "spec": {
                "argv": argv,
                "readOnlyReplay": true,
                "expectedResultDigest": "0".repeat(64)
            } }
        });
        std::env::set_var("HZ_SHELL_EXEC_TIMEOUT_MS", "1000");
        let result = observe_intended_shell_exec_settlement(&params);
        std::env::remove_var("HZ_SHELL_EXEC_TIMEOUT_MS");
        let _ = fs::remove_dir_all(&sandbox);
        let err = result.unwrap_err();
        assert!(err.contains("timed out"), "{err}");
    }

    #[test]
    fn observe_intended_fs_batch_settlement_proves_every_distinct_path() {
        let sandbox =
            std::env::temp_dir().join(format!("hz-eff-observe-batch-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&sandbox);
        std::fs::create_dir_all(&sandbox).unwrap();
        // Simulate a batch that already executed: two distinct exact writes.
        std::fs::write(sandbox.join("a.txt"), b"new-A").unwrap();
        std::fs::write(sandbox.join("c.txt"), b"new-C").unwrap();
        let params = json!({
            "effectId": "batch-observe",
            "sandboxRoot": sandbox.to_string_lossy(),
            "dispatch": { "kind": "fs.batch", "spec": { "ops": [
                { "kind": "fs.write", "path": "a.txt", "text": "new-A" },
                { "kind": "fs.write", "path": "c.txt", "text": "new-C" }
            ] } }
        });
        let observed = observe_intended_fs_batch_settlement(&params).unwrap();
        assert_eq!(observed["verdict"], json!("settled"));
        assert_eq!(observed["batchOpCount"], json!(2));
        assert_eq!(observed["contentDigests"].as_array().unwrap().len(), 2);

        // One path drifted after execution: the batch must not settle.
        std::fs::write(sandbox.join("c.txt"), b"wrong").unwrap();
        let drifted = observe_intended_fs_batch_settlement(&params).unwrap_err();
        assert!(
            drifted.contains("digest") || drifted.contains("intent"),
            "{drifted}"
        );

        // Duplicate target paths have no independent postimage per op yet.
        let duplicate = json!({
            "effectId": "batch-dup",
            "sandboxRoot": sandbox.to_string_lossy(),
            "dispatch": { "kind": "fs.batch", "spec": { "ops": [
                { "kind": "fs.write", "path": "a.txt", "text": "new-A" },
                { "kind": "fs.edit", "path": "a.txt", "oldString": "new-A", "newString": "other" }
            ] } }
        });
        let mut refused = observe_intended_fs_batch_settlement(&duplicate).unwrap_err();
        assert!(refused.contains("duplicate"), "{refused}");

        // Two exact writes to the SAME path are independently observable: the
        // final bytes must match the last write's payload.
        let sequential = json!({
            "effectId": "batch-same-path",
            "sandboxRoot": sandbox.to_string_lossy(),
            "dispatch": { "kind": "fs.batch", "spec": { "ops": [
                { "kind": "fs.write", "path": "a.txt", "text": "intermediate" },
                { "kind": "fs.write", "path": "a.txt", "text": "final" }
            ] } }
        });
        std::fs::write(sandbox.join("a.txt"), b"final").unwrap();
        let observed_same = observe_intended_fs_batch_settlement(&sequential).unwrap();
        assert_eq!(
            observed_same["verdict"],
            json!("settled"),
            "{observed_same}"
        );
        assert_eq!(observed_same["batchOpCount"], json!(2));

        // A mix of write + edit on one path stays refused (no independent
        // reconstruction of the intermediate edit).
        let mixed = json!({
            "effectId": "batch-same-path-mixed",
            "sandboxRoot": sandbox.to_string_lossy(),
            "dispatch": { "kind": "fs.batch", "spec": { "ops": [
                { "kind": "fs.write", "path": "a.txt", "text": "final" },
                { "kind": "fs.edit", "path": "a.txt", "oldString": "final", "newString": "else" }
            ] } }
        });
        refused = observe_intended_fs_batch_settlement(&mixed).unwrap_err();
        assert!(refused.contains("duplicate"), "{refused}");

        // write → delete on one path is observable: final state is stably absent.
        let write_delete = json!({
            "effectId": "batch-write-delete",
            "sandboxRoot": sandbox.to_string_lossy(),
            "dispatch": { "kind": "fs.batch", "spec": { "ops": [
                { "kind": "fs.write", "path": "c.txt", "text": "temporary" },
                { "kind": "fs.delete", "path": "c.txt" }
            ] } }
        });
        let _ = fs::remove_file(sandbox.join("c.txt"));
        let settled_delete = observe_intended_fs_batch_settlement(&write_delete).unwrap();
        assert_eq!(
            settled_delete["verdict"],
            json!("settled"),
            "{settled_delete}"
        );
        assert_eq!(settled_delete["batchOpCount"], json!(2));

        // delete → write leaves bytes on disk, so it must not be called settled.
        let delete_write = json!({
            "effectId": "batch-delete-write",
            "sandboxRoot": sandbox.to_string_lossy(),
            "dispatch": { "kind": "fs.batch", "spec": { "ops": [
                { "kind": "fs.delete", "path": "c.txt" },
                { "kind": "fs.write", "path": "c.txt", "text": "restored" }
            ] } }
        });
        assert!(observe_intended_fs_batch_settlement(&delete_write).is_err());
        let _ = std::fs::remove_dir_all(&sandbox);
    }

    /// P0-3 residual: same-path write→rename inside fs.batch is independently
    /// observable (the rename observer already proves both endpoints; only the
    /// group-level duplicate-path filter previously refused it).
    #[test]
    fn observe_intended_fs_batch_settlement_same_path_write_then_rename() {
        let sandbox = std::env::temp_dir().join(format!(
            "hz-eff-observe-batch-rename-{}",
            uuid::Uuid::new_v4()
        ));
        let _ = std::fs::remove_dir_all(&sandbox);
        std::fs::create_dir_all(&sandbox).unwrap();
        // Batch already executed: write a.txt, then rename a.txt -> b.txt.
        std::fs::write(sandbox.join("b.txt"), b"renamed-final").unwrap();
        let params = json!({
            "effectId": "batch-write-rename",
            "sandboxRoot": sandbox.to_string_lossy(),
            "dispatch": { "kind": "fs.batch", "spec": { "ops": [
                { "kind": "fs.write",  "path": "a.txt", "text": "renamed-final" },
                { "kind": "fs.rename", "from": "a.txt", "to": "b.txt" }
            ] } }
        });
        let settled = observe_intended_fs_batch_settlement(&params).unwrap();
        assert_eq!(settled["verdict"], json!("settled"), "{settled}");
        assert_eq!(settled["batchOpCount"], json!(2));
        assert_eq!(settled["resultDigestStable"], json!(true));
        assert!(
            settled["contentDigests"]
                .as_array()
                .unwrap()
                .contains(&json!(crate::canon::sha256_bytes(b"renamed-final"))),
            "{settled}"
        );

        // Drift at the rename destination (postimage != last write intent) fails.
        std::fs::write(sandbox.join("b.txt"), b"tampered").unwrap();
        let drift = observe_intended_fs_batch_settlement(&params).unwrap_err();
        assert!(
            drift.contains("bytes") || drift.contains("digest") || drift.contains("intent"),
            "{drift}"
        );

        // A still-present rename source fails (endpoint not proved).
        std::fs::write(sandbox.join("b.txt"), b"renamed-final").unwrap();
        std::fs::write(sandbox.join("a.txt"), b"leftover").unwrap();
        let refused = observe_intended_fs_batch_settlement(&params).unwrap_err();
        assert!(
            refused.contains("absent") || refused.contains("source"),
            "{refused}"
        );
        let _ = std::fs::remove_dir_all(&sandbox);
    }

    #[cfg(not(windows))]
    #[test]
    fn observe_intended_fs_batch_settlement_preserves_case_on_non_windows() {
        let sandbox = std::env::temp_dir().join(format!(
            "hz-eff-observe-batch-case-{}",
            uuid::Uuid::new_v4()
        ));
        let _ = std::fs::remove_dir_all(&sandbox);
        std::fs::create_dir_all(&sandbox).unwrap();
        std::fs::write(sandbox.join("Case.txt"), b"upper-payload").unwrap();
        std::fs::write(sandbox.join("case.txt"), b"lower-payload").unwrap();
        let params = json!({
            "effectId": "batch-case-distinct",
            "sandboxRoot": sandbox.to_string_lossy(),
            "dispatch": { "kind": "fs.batch", "spec": { "ops": [
                { "kind": "fs.write", "path": "Case.txt", "text": "upper-payload" },
                { "kind": "fs.write", "path": "case.txt", "text": "lower-payload" }
            ] } }
        });
        let settled = observe_intended_fs_batch_settlement(&params).unwrap();
        assert_eq!(settled["verdict"], json!("settled"), "{settled}");
        assert_eq!(settled["batchOpCount"], json!(2));
        assert_eq!(settled["contentDigests"].as_array().unwrap().len(), 2);
        let _ = std::fs::remove_dir_all(&sandbox);
    }
}

#[cfg(test)]
mod process_hardening_tests {
    use super::*;

    #[test]
    fn drain_after_exit_is_one_second() {
        assert_eq!(DRAIN_AFTER_EXIT, Duration::from_secs(1));
    }

    #[cfg(unix)]
    #[test]
    fn unix_spawn_lock_serializes_concurrent_spawns() {
        let cwd = std::env::temp_dir();
        let handles: Vec<_> = (0..6)
            .map(|idx| {
                let cwd = cwd.clone();
                thread::spawn(move || {
                    let spec = SpawnSpec {
                        program: "/bin/sh".to_string(),
                        args: vec!["-c".to_string(), format!("printf 'worker-{idx}'")],
                        cwd,
                        env: vec![("PATH".to_string(), shell_exec_path())],
                    };
                    let out = run_hardened_process(
                        &spec,
                        Duration::from_secs(5),
                        DRAIN_AFTER_EXIT,
                        "test concurrent spawn",
                    )
                    .expect("concurrent spawn must succeed");
                    assert_eq!(out.exit_code, 0);
                    assert_eq!(String::from_utf8_lossy(&out.stdout), format!("worker-{idx}"));
                })
            })
            .collect();
        for h in handles {
            h.join().expect("worker thread panicked");
        }
    }

    #[cfg(unix)]
    #[test]
    fn unix_waitid_wnowait_retains_zombie_before_killpg_and_reap() {
        use std::os::unix::process::CommandExt;

        let child = {
            let _guard = SPAWN_LOCK.lock().unwrap_or_else(|e| e.into_inner());
            let mut cmd = Command::new("/bin/sh");
            cmd.args(["-c", "exit 42"])
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null());
            unsafe {
                cmd.pre_exec(|| {
                    if libc::setpgid(0, 0) != 0 {
                        return Err(std::io::Error::last_os_error());
                    }
                    Ok(())
                });
            }
            cmd.spawn().expect("spawn short-lived child")
        };
        let pid = child.id() as libc::pid_t;
        drop(child);

        // Wait until zombie appears via WNOWAIT.
        let deadline = Instant::now() + Duration::from_secs(5);
        let (si_code, si_status) = loop {
            if let Some(res) = unix_proc::wait_child_zombie_nonblocking(pid).expect("waitid") {
                break res;
            }
            assert!(Instant::now() < deadline, "child did not exit in time");
            thread::sleep(Duration::from_millis(10));
        };
        assert_eq!(si_code, libc::CLD_EXITED);
        assert_eq!(si_status, 42);

        // Second WNOWAIT call MUST still observe the retained zombie (PID/PGID not yet recycled).
        let still_zombie = unix_proc::wait_child_zombie_nonblocking(pid)
            .expect("second waitid must succeed while zombie is retained");
        assert_eq!(still_zombie, Some((libc::CLD_EXITED, 42)));

        // Kill process group while zombie reserves PGID, then reap cleanly via waitpid.
        unix_proc::kill_process_group_while_zombie(pid);
        unix_proc::reap_pid(pid);

        // After waitpid reap, waitid must fail with ECHILD.
        let after_reap = unix_proc::wait_child_zombie_nonblocking(pid);
        assert!(
            after_reap.is_err(),
            "zombie should be reaped after waitpid, got {after_reap:?}"
        );
    }

    #[cfg(unix)]
    #[test]
    fn unix_drain_after_exit_bounds_orphaned_grandchild_holding_stdout() {
        // Spawn a child that prints to stdout, launches a session-detached
        // grandchild (`setsid`) holding stdout open for 10s, and exits immediately.
        let spec = SpawnSpec {
            program: "/bin/sh".to_string(),
            args: vec![
                "-c".to_string(),
                "printf 'before-orphan'; setsid sh -c 'sleep 10' <&- 2>/dev/null &".to_string(),
            ],
            cwd: std::env::temp_dir(),
            env: vec![("PATH".to_string(), shell_exec_path())],
        };
        let started = Instant::now();
        let out = run_hardened_process(
            &spec,
            Duration::from_secs(5),
            DRAIN_AFTER_EXIT,
            "test orphan drain",
        )
        .expect("must not hang on orphaned grandchild holding stdout");
        let elapsed = started.elapsed();
        assert_eq!(out.exit_code, 0);
        assert_eq!(String::from_utf8_lossy(&out.stdout), "before-orphan");
        assert!(
            elapsed < Duration::from_secs(5),
            "drain_after_exit should bound wait well below 10s grandchild sleep; took {elapsed:?}"
        );
    }

    #[cfg(windows)]
    fn windows_test_env() -> Vec<(String, String)> {
        ["PATH", "SystemRoot", "TEMP", "TMP", "ComSpec"]
            .into_iter()
            .filter_map(|k| std::env::var(k).ok().map(|v| (k.to_string(), v)))
            .collect()
    }

    #[cfg(windows)]
    #[test]
    fn windows_job_object_atomic_spawn_and_kill_on_close() {
        use std::os::windows::io::AsRawHandle;
        use windows_sys::Win32::Foundation::WAIT_OBJECT_0;

        let spec = SpawnSpec {
            program: "cmd.exe".to_string(),
            args: vec![
                "/d".to_string(),
                "/c".to_string(),
                "ping -n 30 127.0.0.1 >nul".to_string(),
            ],
            cwd: std::env::temp_dir(),
            env: windows_test_env(),
        };
        let (mut spawned, _stdout, _stderr) =
            win_proc::spawn_in_job(&spec).expect("spawn_in_job must succeed");
        let job = spawned
            .job
            .take()
            .expect("child should be atomically born in a Job Object");

        let mut in_job: i32 = 0;
        let ok = unsafe {
            win_proc::IsProcessInJob(
                spawned.process.as_raw_handle(),
                job.handle(),
                &mut in_job,
            )
        };
        assert_ne!(ok, 0, "IsProcessInJob call must succeed");
        assert_ne!(
            in_job, 0,
            "child must be atomically assigned to the Job Object via PROC_THREAD_ATTRIBUTE_JOB_LIST"
        );

        // Dropping the Job Object handle must kill the child via JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE.
        drop(job);
        let wait_rc = unsafe { win_proc::WaitForSingleObject(spawned.process.as_raw_handle(), 5_000) };
        assert_eq!(
            wait_rc, WAIT_OBJECT_0,
            "closing kill-on-close Job Object must terminate the child process"
        );
    }

    #[cfg(windows)]
    #[test]
    fn windows_exit_code_259_still_active_is_not_mistaken_for_running() {
        let spec = SpawnSpec {
            program: "cmd.exe".to_string(),
            args: vec![
                "/d".to_string(),
                "/c".to_string(),
                "echo ok-259 & exit /b 259".to_string(),
            ],
            cwd: std::env::temp_dir(),
            env: windows_test_env(),
        };
        let out = run_hardened_process(
            &spec,
            Duration::from_secs(10),
            DRAIN_AFTER_EXIT,
            "test exit 259",
        )
        .expect("process exiting with 259 (STILL_ACTIVE) must complete cleanly");
        assert_eq!(out.exit_code, 259);
        let stdout = String::from_utf8_lossy(&out.stdout);
        assert!(stdout.contains("ok-259"), "stdout was: {stdout:?}");
    }
}

#[cfg(test)]
mod track1_hardening_tests {
    use super::*;
    use std::ffi::OsString;

    #[test]
    fn merge_shell_exec_path_splits_and_deduplicates_using_platform_rules() {
        let joined_parent = std::env::join_paths([
            PathBuf::from("/custom/tools/bin"),
            PathBuf::from("/usr/bin"),
            PathBuf::from("/custom/tools/bin"),
        ])
        .unwrap_or_else(|_| OsString::from("/custom/tools/bin:/usr/bin"));
        let merged = merge_shell_exec_path(Some("/home/tester"), Some(joined_parent.as_os_str()));
        let split: Vec<PathBuf> = std::env::split_paths(&merged).collect();
        assert!(split.contains(&PathBuf::from("/home/tester/.cargo/bin")));
        assert!(split.contains(&PathBuf::from("/custom/tools/bin")));
        let custom_count = split
            .iter()
            .filter(|p| *p == &PathBuf::from("/custom/tools/bin"))
            .count();
        assert_eq!(custom_count, 1, "PATH entries must be deduplicated");
    }
}

#[cfg(test)]
mod wave_c_track_c1_tests {
    use super::*;

    struct EnvVarGuard {
        key: &'static str,
        prev: Option<String>,
    }

    impl EnvVarGuard {
        fn set(key: &'static str, val: &str) -> Self {
            let prev = std::env::var(key).ok();
            std::env::set_var(key, val);
            Self { key, prev }
        }
    }

    impl Drop for EnvVarGuard {
        fn drop(&mut self) {
            match &self.prev {
                Some(v) => std::env::set_var(self.key, v),
                None => std::env::remove_var(self.key),
            }
        }
    }

    #[test]
    fn in_kernel_fs_ops_touch_mv_install_rm_with_env_flag() {
        let _guard = EXTENDED_ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let _env = EnvVarGuard::set("HZ_EFFECT_HOST_IN_KERNEL_FS", "1");

        let sandbox = std::env::temp_dir().join(format!(
            "hz-c1-inkernel-fs-{}-{}",
            std::process::id(),
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(&sandbox).unwrap();
        let mut ledger = HermeticEffectLedger::default();

        // 1. touch
        let out_touch = execute_params(
            &json!({
                "effectId": "eff-c1-touch",
                "sandboxRoot": sandbox.to_string_lossy(),
                "dispatch": { "kind": "shell.exec", "spec": { "argv": ["touch", "a.txt"] } }
            }),
            &mut ledger,
        )
        .expect("in-kernel touch must succeed");
        assert_eq!(out_touch["exitCode"], json!(0));
        assert_eq!(out_touch["inKernelFsReceipt"]["op"], json!("touch"));
        assert!(sandbox.join("a.txt").exists());

        // 2. mv
        let out_mv = execute_params(
            &json!({
                "effectId": "eff-c1-mv",
                "sandboxRoot": sandbox.to_string_lossy(),
                "dispatch": { "kind": "shell.exec", "spec": { "argv": ["mv", "a.txt", "b.txt"] } }
            }),
            &mut ledger,
        )
        .expect("in-kernel mv must succeed");
        assert_eq!(out_mv["exitCode"], json!(0));
        assert_eq!(out_mv["inKernelFsReceipt"]["op"], json!("mv"));
        assert!(!sandbox.join("a.txt").exists());
        assert!(sandbox.join("b.txt").exists());

        // 3. install
        std::fs::write(sandbox.join("b.txt"), b"hello-install").unwrap();
        let out_install = execute_params(
            &json!({
                "effectId": "eff-c1-install",
                "sandboxRoot": sandbox.to_string_lossy(),
                "dispatch": { "kind": "shell.exec", "spec": { "argv": ["install", "-m", "644", "b.txt", "c.txt"] } }
            }),
            &mut ledger,
        )
        .expect("in-kernel install must succeed");
        assert_eq!(out_install["exitCode"], json!(0));
        assert_eq!(out_install["inKernelFsReceipt"]["op"], json!("install"));
        assert_eq!(std::fs::read(sandbox.join("c.txt")).unwrap(), b"hello-install");

        // 4. rm
        let out_rm = execute_params(
            &json!({
                "effectId": "eff-c1-rm",
                "sandboxRoot": sandbox.to_string_lossy(),
                "dispatch": { "kind": "shell.exec", "spec": { "argv": ["rm", "-f", "c.txt"] } }
            }),
            &mut ledger,
        )
        .expect("in-kernel rm must succeed");
        assert_eq!(out_rm["exitCode"], json!(0));
        assert_eq!(out_rm["inKernelFsReceipt"]["op"], json!("rm"));
        assert!(!sandbox.join("c.txt").exists());

        let _ = std::fs::remove_dir_all(&sandbox);
    }

    #[test]
    fn shell_exec_attaches_fs_delta_when_env_flag_enabled() {
        let _guard = EXTENDED_ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let _env_delta = EnvVarGuard::set("HZ_EFFECT_HOST_FS_DELTA", "1");

        let sandbox = std::env::temp_dir().join(format!(
            "hz-c1-fs-delta-{}-{}",
            std::process::id(),
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(&sandbox).unwrap();
        let mut ledger = HermeticEffectLedger::default();

        let out = execute_params(
            &json!({
                "effectId": "eff-c1-delta",
                "sandboxRoot": sandbox.to_string_lossy(),
                "dispatch": { "kind": "shell.exec", "spec": { "argv": ["touch", "created.txt"] } }
            }),
            &mut ledger,
        )
        .expect("shell.exec with HZ_EFFECT_HOST_FS_DELTA=1 must succeed");

        let fs_delta = out.get("fsDelta").expect("fsDelta must be attached");
        assert!(
            fs_delta
                .get("backend")
                .and_then(Value::as_str)
                .map(|s| !s.is_empty())
                .unwrap_or(false),
            "fsDelta.backend must be non-empty: {fs_delta}"
        );
        let created = fs_delta["created"]
            .as_array()
            .expect("fsDelta.created must be an array");
        assert!(
            created.iter().any(|e| e["path"] == json!("created.txt")),
            "created.txt must appear in fsDelta.created: {fs_delta}"
        );
        assert!(fs_delta["modified"].is_array());
        assert!(fs_delta["deleted"].is_array());

        let _ = std::fs::remove_dir_all(&sandbox);
    }

    #[test]
    fn kernel_extended_admits_mcp_invoke_metadata_settlement() {
        let _guard = EXTENDED_ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let _env = EnvVarGuard::set("HZ_EFFECT_HOST_KERNEL_EXTENDED", "1");

        let mut ledger = HermeticEffectLedger::default();
        let out = execute_params(
            &json!({
                "effectId": "eff-c1-mcp-ext",
                "dispatch": {
                    "kind": "mcp.invoke",
                    "spec": {
                        "serverId": "srv-1",
                        "toolName": "list_items",
                        "args": { "limit": 5 }
                    }
                }
            }),
            &mut ledger,
        )
        .expect("opt-in mcp.invoke must succeed");

        assert_eq!(out["verdict"], json!("settled"));
        assert_eq!(out["kind"], json!("mcp.invoke"));
        assert_eq!(out["admission"], json!("metadata-admitted"));
        assert_eq!(out["serverId"], json!("srv-1"));
        assert_eq!(out["toolName"], json!("list_items"));
        assert_eq!(out["resultDigestStable"], json!(true));
        assert_eq!(
            out["resultDigest"].as_str().map(|s| s.len()),
            Some(64),
            "resultDigest must be 64-char sha256 hex"
        );
    }

    #[test]
    fn kernel_extended_admits_hook_exec_sandboxed() {
        let _guard = EXTENDED_ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let _env = EnvVarGuard::set("HZ_EFFECT_HOST_KERNEL_EXTENDED", "1");

        let sandbox = std::env::temp_dir().join(format!(
            "hz-c1-hook-ext-{}-{}",
            std::process::id(),
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(&sandbox).unwrap();
        let mut ledger = HermeticEffectLedger::default();

        let out = execute_params(
            &json!({
                "effectId": "eff-c1-hook-ext",
                "sandboxRoot": sandbox.to_string_lossy(),
                "dispatch": {
                    "kind": "hook.exec",
                    "spec": {
                        "point": "preTool",
                        "index": 0,
                        "argv": ["echo", "hook-ok"]
                    }
                }
            }),
            &mut ledger,
        )
        .expect("opt-in hook.exec must succeed");

        assert_eq!(out["verdict"], json!("settled"));
        assert_eq!(out["kind"], json!("hook.exec"));
        assert_eq!(out["point"], json!("preTool"));
        assert_eq!(out["index"], json!(0));
        assert_eq!(out["exitCode"], json!(0));
        assert_eq!(out["resultDigestStable"], json!(true));
        assert!(
            out["stdout"].as_str().unwrap_or("").contains("hook-ok"),
            "stdout must contain hook-ok: {out}"
        );

        let _ = std::fs::remove_dir_all(&sandbox);
    }
}
