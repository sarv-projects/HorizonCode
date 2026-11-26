//! Observe evidence flags — TS `effect-evidence.ts` / **257** mirror for kernel reconcile + execute.

use std::fs;
use std::path::{Path, PathBuf};

use serde_json::{json, Value};

use crate::receipt_postimage::observe_file_postimage;

/// Sentinel digest for directory-only postimage rows (metadata observe, no byte archive).
pub const DIRECTORY_POSTIMAGE_DIGEST: &str =
    "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ShellFsMutateShape {
    Rm,
    Rmdir,
    Touch,
    Mkdir,
    /// `mkdir -p path`: report the resultant postimage of each path component.
    MkdirParents,
    Cp,
    Mv,
    /// `truncate [-s N] file`: a content write with an observable postimage.
    Truncate,
    /// `install [-m MODE] SRC DST`: a copy-like write whose destination is observed.
    Install,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParsedShellFsMutate {
    pub shape: ShellFsMutateShape,
    /// Destination or sole path (delete/touch/mkdir/cp/mv dest).
    pub raw_path: String,
    /// Source path for two-path `cp` / `mv` only.
    pub raw_path_from: Option<String>,
}

fn program_basename(argv0: &str) -> &str {
    Path::new(argv0)
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or(argv0)
}

/// Reduced honesty classes for shell.exec side-effects beyond streamEvidence (P0-2 **706**).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ShellSideEffectClass {
    /// Reduced rm/touch/mkdir/cp/mv argv — FS postimages observed.
    ReducedFs,
    /// stdout/stderr streamEvidence only; no predicted FS mutate.
    StreamOnly,
    /// Network-capable program — FS/net landing not independently observed.
    LikelyNet,
    /// Mutating / compound FS-capable argv outside reduced shapes.
    ArbitraryFs,
    /// Empty or unclassified argv.
    Unknown,
}

pub fn shell_side_effect_class_label(c: ShellSideEffectClass) -> &'static str {
    match c {
        ShellSideEffectClass::ReducedFs => "reduced_fs",
        ShellSideEffectClass::StreamOnly => "stream_only",
        ShellSideEffectClass::LikelyNet => "likely_net",
        ShellSideEffectClass::ArbitraryFs => "arbitrary_fs",
        ShellSideEffectClass::Unknown => "unknown",
    }
}

const LIKELY_NET_PROGRAMS: &[&str] = &[
    "curl",
    "wget",
    "nc",
    "ncat",
    "netcat",
    "ssh",
    "scp",
    "sftp",
    "ftp",
    "telnet",
    "dig",
    "nslookup",
    "ping",
    "traceroute",
    "tracepath",
    "aria2c",
    "http",
    "https",
];

/// Classify argv for postimage/history honesty — never claims shell-net enforced.
pub fn classify_shell_argv_side_effect(argv: &[String]) -> ShellSideEffectClass {
    if argv.is_empty() {
        return ShellSideEffectClass::Unknown;
    }
    // A basename does not authenticate an executable. Path-qualified names
    // may point at an arbitrary lookalike, so never grant a reduced/read-only
    // classification without a trusted resolver/identity check.
    if argv[0].contains('/') || argv[0].contains('\\') {
        return ShellSideEffectClass::Unknown;
    }
    if parse_reduced_shell_fs_mutate_argv(argv).is_some() {
        return ShellSideEffectClass::ReducedFs;
    }
    let base = program_basename(&argv[0]);
    let lower = base.to_ascii_lowercase();
    if LIKELY_NET_PROGRAMS.iter().any(|p| *p == lower.as_str()) {
        return ShellSideEffectClass::LikelyNet;
    }
    // Common FS mutators / shells outside reduced shapes → arbitrary FS residual.
    match lower.as_str() {
        "rm" | "cp" | "mv" | "mkdir" | "touch" | "chmod" | "chown" | "ln" | "install" | "tar"
        | "unzip" | "gzip" | "dd" | "truncate" | "tee" | "bash" | "sh" | "zsh" | "python"
        | "python3" | "node" | "perl" | "ruby"
        // Build/test runners, VCS and admin tools can write files even when
        // invoked with apparently harmless flags. Classify them as arbitrary FS
        // so streamEvidence never masquerades as a complete shell observation.
        | "git" | "make" | "cmake" | "npm" | "npx" | "pnpm" | "yarn" | "bun" | "cargo"
        | "rustc" | "go" | "pip" | "pip3" | "uv" | "poetry" | "pytest" | "jest" | "vitest"
        | "gradle" | "mvn" | "dotnet" | "docker" | "kubectl" | "terraform" | "ansible"
        | "sudo" | "su" | "env" | "xargs" | "find" | "sed" | "awk" | "patch" | "rsync"
        | "gpg" | "ssh-keygen" => ShellSideEffectClass::ArbitraryFs,
        "echo" | "printf" | "true" | "false" | "cat" | "head" | "tail" | "wc" | "ls" | "pwd" | "sleep" => {
            ShellSideEffectClass::StreamOnly
        }
        _ => ShellSideEffectClass::Unknown,
    }
}

/// Reduced argv shapes for kernel-routed shell FS observe (P0-2 partial): one
/// sandbox-relative path after known flags only. Arbitrary shell FS remains OPEN.
pub fn parse_reduced_shell_fs_mutate_argv(argv: &[String]) -> Option<ParsedShellFsMutate> {
    if argv.is_empty() {
        return None;
    }
    // Reduced postimages require an unqualified program name; basename-only
    // matching would let a local executable masquerade as a known mutator.
    if argv[0].contains('/') || argv[0].contains('\\') {
        return None;
    }
    let base = program_basename(&argv[0]);
    match base {
        "rm" => {
            let raw_path = match argv.len() {
                2 if !argv[1].starts_with('-') => argv[1].clone(),
                3 if argv[1] == "-f" && !argv[2].starts_with('-') => argv[2].clone(),
                _ => return None,
            };
            Some(ParsedShellFsMutate {
                shape: ShellFsMutateShape::Rm,
                raw_path,
                raw_path_from: None,
            })
        }
        "rmdir" => {
            if argv.len() != 2 || argv[1].starts_with('-') {
                return None;
            }
            Some(ParsedShellFsMutate {
                shape: ShellFsMutateShape::Rmdir,
                raw_path: argv[1].clone(),
                raw_path_from: None,
            })
        }
        "touch" => {
            if argv.len() != 2 {
                return None;
            }
            Some(ParsedShellFsMutate {
                shape: ShellFsMutateShape::Touch,
                raw_path: argv[1].clone(),
                raw_path_from: None,
            })
        }
        "mkdir" => match argv.len() {
            2 => Some(ParsedShellFsMutate {
                shape: ShellFsMutateShape::Mkdir,
                raw_path: argv[1].clone(),
                raw_path_from: None,
            }),
            3 if argv[1] == "-p" => Some(ParsedShellFsMutate {
                shape: ShellFsMutateShape::MkdirParents,
                raw_path: argv[2].clone(),
                raw_path_from: None,
            }),
            _ => None,
        },
        // P0-2 (ruling 920): truncate writes bytes (size 0 or an explicit size),
        // so its target gets the same present-postimage observation as touch.
        "truncate" => match argv.len() {
            2 => Some(ParsedShellFsMutate {
                shape: ShellFsMutateShape::Truncate,
                raw_path: argv[1].clone(),
                raw_path_from: None,
            }),
            4 if argv[1] == "-s"
                && !argv[2].is_empty()
                && argv[2].chars().all(|c| c.is_ascii_digit()) =>
            {
                Some(ParsedShellFsMutate {
                    shape: ShellFsMutateShape::Truncate,
                    raw_path: argv[3].clone(),
                    raw_path_from: None,
                })
            }
            _ => None,
        },
        // P0-2 (ruling 921): install copies SRC to DST. Only the plain and
        // `-m MODE` forms are reduced; `-d` (create directories) and any other
        // flag stay unobserved rather than guessed.
        "install" => match argv.len() {
            3 if !argv[1].starts_with('-') && !argv[2].starts_with('-') => {
                Some(ParsedShellFsMutate {
                    shape: ShellFsMutateShape::Install,
                    raw_path: argv[2].clone(),
                    raw_path_from: Some(argv[1].clone()),
                })
            }
            5 if argv[1] == "-m" && !argv[2].is_empty() => Some(ParsedShellFsMutate {
                shape: ShellFsMutateShape::Install,
                raw_path: argv[4].clone(),
                raw_path_from: Some(argv[3].clone()),
            }),
            _ => None,
        },
        "cp" => parse_shell_two_sandbox_paths(argv, "cp", ShellFsMutateShape::Cp),
        "mv" => parse_shell_two_sandbox_paths(argv, "mv", ShellFsMutateShape::Mv),
        _ => None,
    }
}

fn parse_shell_two_sandbox_paths(
    argv: &[String],
    program: &str,
    shape: ShellFsMutateShape,
) -> Option<ParsedShellFsMutate> {
    if program_basename(&argv[0]) != program {
        return None;
    }
    let (from, to) = match argv.len() {
        3 => (&argv[1], &argv[2]),
        4 if argv[1] == "-f" || argv[1] == "-n" => (&argv[2], &argv[3]),
        _ => return None,
    };
    if from.starts_with('-') || to.starts_with('-') {
        return None;
    }
    Some(ParsedShellFsMutate {
        shape,
        raw_path: to.clone(),
        raw_path_from: Some(from.clone()),
    })
}

/// Refuse a reduced shell filesystem path whose lexical resolution leaves the
/// sandbox, including a symlink that points outside. Callers must run this
/// before spawn so `cp` cannot follow the link first.
pub fn preflight_reduced_shell_fs_targets(
    sandbox_root: &Path,
    cwd: &Path,
    parsed: &ParsedShellFsMutate,
) -> Result<(), String> {
    resolve_shell_target_in_sandbox(sandbox_root, cwd, &parsed.raw_path)?;
    if let Some(from) = parsed.raw_path_from.as_deref() {
        resolve_shell_target_in_sandbox(sandbox_root, cwd, from)?;
    }
    Ok(())
}

fn resolve_shell_target_in_sandbox(
    sandbox_root: &Path,
    cwd: &Path,
    raw_path: &str,
) -> Result<PathBuf, String> {
    let candidate = if Path::new(raw_path).is_absolute() {
        PathBuf::from(raw_path)
    } else {
        cwd.join(raw_path)
    };
    if !crate::guard::path_contained_in(sandbox_root, &candidate) {
        return Err(
            "HZ_PRECONDITION_FAILED: shell fs observe path must resolve inside sandboxRoot".into(),
        );
    }
    crate::guard::lexical_resolve(&candidate).ok_or_else(|| {
        "HZ_PRECONDITION_FAILED: shell fs observe path could not be resolved".to_string()
    })
}

fn path_absent_stable(path: &Path) -> bool {
    for _ in 0..2 {
        match fs::symlink_metadata(path) {
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Ok(_) => return false,
            Err(_) => return false,
        }
    }
    true
}

const MAX_MKDIR_P_POSTIMAGE_COMPONENTS: usize = 64;

fn directory_entry_stable(path: &Path) -> bool {
    let probe = || match fs::symlink_metadata(path) {
        Ok(meta) => Some(meta.is_dir() && !meta.file_type().is_symlink()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Some(false),
        Err(_) => None,
    };
    probe() == Some(true) && probe() == Some(true)
}

fn observe_mkdir_p_postimages(root: &Path, target: &Path) -> Result<(Vec<Value>, bool), String> {
    let root = crate::guard::lexical_resolve(root).ok_or_else(|| {
        "HZ_PRECONDITION_FAILED: mkdir -p sandboxRoot could not be resolved".to_string()
    })?;
    let relative = target.strip_prefix(&root).map_err(|_| {
        "HZ_PRECONDITION_FAILED: mkdir -p postimage escaped sandboxRoot".to_string()
    })?;
    let components: Vec<_> = relative.components().collect();
    if components.len() > MAX_MKDIR_P_POSTIMAGE_COMPONENTS {
        return Err(format!(
            "HZ_PRECONDITION_FAILED: mkdir -p postimage exceeds {} path components",
            MAX_MKDIR_P_POSTIMAGE_COMPONENTS
        ));
    }

    let mut paths = Vec::with_capacity(components.len().max(1));
    if components.is_empty() {
        paths.push(root.clone());
    } else {
        let mut current = root;
        for component in components {
            if !matches!(component, std::path::Component::Normal(_)) {
                return Err(
                    "HZ_PRECONDITION_FAILED: mkdir -p postimage contains a non-normal component"
                        .into(),
                );
            }
            current.push(component.as_os_str());
            paths.push(current.clone());
        }
    }
    let stable = paths.iter().all(|path| directory_entry_stable(path));
    let rows = paths
        .into_iter()
        .map(|path| {
            json!({
                "path": path.to_string_lossy(),
                "state": "present",
                "digest": DIRECTORY_POSTIMAGE_DIGEST,
                "entryKind": "directory",
                "via": "shell.mkdir_p",
            })
        })
        .collect();
    Ok((rows, stable))
}

/// After `shell.exec`, independently observe predicted FS side-effect path(s).
pub fn observe_shell_fs_postimages(
    sandbox_root: &Path,
    cwd: &Path,
    parsed: &ParsedShellFsMutate,
) -> Result<(Value, bool), String> {
    let resolved = resolve_shell_target_in_sandbox(sandbox_root, cwd, &parsed.raw_path)?;
    let abs = resolved.to_string_lossy().to_string();
    if !Path::new(&abs).is_absolute() {
        return Err("HZ_PRECONDITION_FAILED: shell fs postimage path must be absolute".into());
    }
    let (rows, stable) = match parsed.shape {
        ShellFsMutateShape::Rm | ShellFsMutateShape::Rmdir => {
            let stable = path_absent_stable(&resolved);
            let via = if parsed.shape == ShellFsMutateShape::Rmdir {
                "shell.rmdir"
            } else {
                "shell.rm"
            };
            (
                vec![json!({"path": abs, "state": "absent", "via": via})],
                stable,
            )
        }
        ShellFsMutateShape::Touch | ShellFsMutateShape::Truncate => {
            let obs = observe_file_postimage(&resolved);
            let stable = obs.observation_stable && obs.digest.is_some();
            let via = if parsed.shape == ShellFsMutateShape::Truncate {
                "shell.truncate"
            } else {
                "shell.touch"
            };
            let mut row = json!({
                "path": abs,
                "state": "present",
                "via": via,
            });
            if let Some(d) = obs.digest {
                row["digest"] = json!(d);
            }
            (vec![row], stable)
        }
        ShellFsMutateShape::Mkdir => {
            let stable = directory_entry_stable(&resolved);
            (
                vec![json!({
                    "path": abs,
                    "state": "present",
                    "digest": DIRECTORY_POSTIMAGE_DIGEST,
                    "entryKind": "directory",
                    "via": "shell.mkdir",
                })],
                stable,
            )
        }
        ShellFsMutateShape::MkdirParents => observe_mkdir_p_postimages(sandbox_root, &resolved)?,
        ShellFsMutateShape::Cp | ShellFsMutateShape::Mv | ShellFsMutateShape::Install => {
            let from_raw = parsed.raw_path_from.as_deref().ok_or_else(|| {
                "HZ_PRECONDITION_FAILED: shell fs cp/mv observe missing source path".to_string()
            })?;
            let src = resolve_shell_target_in_sandbox(sandbox_root, cwd, from_raw)?;
            let src_abs = src.to_string_lossy().to_string();
            let via_dest = match parsed.shape {
                ShellFsMutateShape::Cp => "shell.cp",
                ShellFsMutateShape::Install => "shell.install",
                _ => "shell.mv",
            };
            let obs = observe_file_postimage(&resolved);
            let dest_stable = obs.observation_stable && obs.digest.is_some();
            let mut row = json!({
                "path": abs,
                "state": "present",
                "via": via_dest,
            });
            if let Some(d) = obs.digest {
                row["digest"] = json!(d);
            }
            let mut rows = vec![row];
            let mut stable = dest_stable;
            if parsed.shape == ShellFsMutateShape::Mv {
                let src_absent = path_absent_stable(&src);
                stable = stable && src_absent;
                rows.push(json!({
                    "path": src_abs,
                    "state": "absent",
                    "via": "shell.mv",
                }));
            }
            (rows, stable)
        }
    };
    Ok((Value::Array(rows), stable))
}

/// `resultDigest` at observe matches tool output digest (fail-closed when false).
pub fn assess_result_digest_stable(claimed: &str, observed: &str) -> bool {
    claimed == observed
}

/// Captured stdout/stderr observe — two independent sha256 passes (docs/28 **314**).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ShellStreamObservation {
    pub digest: Option<String>,
    pub observation_stable: bool,
    pub confirm_digest: Option<String>,
}

/// One capture, one digest: no second look happened, so no instability is
/// claimed (D-5's Rust analogue; the old body hashed the same buffer twice).
pub fn observe_captured_stream_digest(bytes: &[u8]) -> ShellStreamObservation {
    ShellStreamObservation {
        digest: Some(crate::canon::sha256_bytes(bytes)),
        observation_stable: true,
        confirm_digest: None,
    }
}

/// A REAL second observation: `second` is bytes re-read from an independent
/// source (for kernel shell.exec, a temp-file round trip). Equal digests admit;
/// a mismatch withholds the digest so the evidence gate fails closed. `None`
/// degrades to the single-capture form above.
pub fn observe_captured_stream_digest_with_second(
    bytes: &[u8],
    second: Option<&[u8]>,
) -> ShellStreamObservation {
    let Some(second) = second else {
        return observe_captured_stream_digest(bytes);
    };
    let primary = crate::canon::sha256_bytes(bytes);
    let confirm = crate::canon::sha256_bytes(second);
    if primary == confirm {
        ShellStreamObservation {
            digest: Some(primary),
            observation_stable: true,
            confirm_digest: Some(confirm),
        }
    } else {
        ShellStreamObservation {
            digest: None,
            observation_stable: false,
            confirm_digest: Some(confirm),
        }
    }
}

/// Success output line for kernel-routed `write` / `edit` (mirrors TS `effect-kernel-mutation-route.ts`).
pub const KERNEL_ROUTE_TAG: &str = "[effect-host-kernel]";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FsMutationResultKind {
    Write,
    Edit,
    Delete,
    Rename,
}

pub fn kernel_fs_mutation_success_output(
    kind: FsMutationResultKind,
    rel_path: &str,
    content_digest: Option<&str>,
    rel_from: Option<&str>,
) -> String {
    let digest = content_digest.unwrap_or("?");
    match kind {
        FsMutationResultKind::Write => format!(
            "{KERNEL_ROUTE_TAG} wrote {rel_path} (kernel fs.write; postimage digest {digest})"
        ),
        FsMutationResultKind::Edit => format!(
            "{KERNEL_ROUTE_TAG} edited {rel_path} (kernel fs.edit; postimage digest {digest})"
        ),
        FsMutationResultKind::Delete => format!(
            "{KERNEL_ROUTE_TAG} deleted {rel_path} (kernel fs.delete; postimage digest {digest})"
        ),
        FsMutationResultKind::Rename => {
            let from = rel_from.unwrap_or("?");
            format!(
                "{KERNEL_ROUTE_TAG} renamed {from} → {rel_path} (kernel fs.rename; postimage digest {digest})"
            )
        }
    }
}

/// Independent double-hash on canonical kernel mutation tool output (docs/28 **327**, **328**).
pub fn observe_kernel_fs_mutation_result_digest(
    kind: FsMutationResultKind,
    rel_path: &str,
    content_digest: Option<&str>,
    rel_from: Option<&str>,
) -> ShellStreamObservation {
    let output = kernel_fs_mutation_success_output(kind, rel_path, content_digest, rel_from);
    observe_captured_stream_digest(output.as_bytes())
}

/// Multi-op kernel-routed `apply_patch` aggregated success output (docs/28 **328**).
pub fn kernel_apply_patch_multi_op_success_output(
    op_count: usize,
    paths: &str,
    content_digest: Option<&str>,
) -> String {
    let digest = content_digest.unwrap_or("?");
    format!(
        "{KERNEL_ROUTE_TAG} apply_patch {op_count} op(s) via kernel ({paths}; postimage digest {digest})"
    )
}

pub fn observe_kernel_apply_patch_multi_op_result_digest(
    op_count: usize,
    paths: &str,
    content_digest: Option<&str>,
) -> ShellStreamObservation {
    let output = kernel_apply_patch_multi_op_success_output(op_count, paths, content_digest);
    observe_captured_stream_digest(output.as_bytes())
}

/// Both streams must pass independent digest observe for shell settlement evidence.
pub fn shell_exec_result_digest_stable(
    stdout: &ShellStreamObservation,
    stderr: &ShellStreamObservation,
) -> bool {
    stdout.observation_stable && stderr.observation_stable
}

/// Expected mutating postimage path resolvable but file absent at observe.
pub fn assess_postimage_missing_at_observe(expect_postimage: bool, file_present: bool) -> bool {
    expect_postimage && !file_present
}

/// Pure gate: any observe evidence flag forces reconcile `unknown` (docs/28 **260**).
pub fn evidence_forces_unknown(
    result_digest_stable: Option<bool>,
    postimage_missing: Option<bool>,
    postimage_observation_stable: Option<bool>,
) -> bool {
    result_digest_stable == Some(false)
        || postimage_missing == Some(true)
        || postimage_observation_stable == Some(false)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shell_side_effect_classifier_names_common_build_and_tool_runner_mutators() {
        for program in [
            "git",
            "make",
            "cmake",
            "npm",
            "npx",
            "pnpm",
            "yarn",
            "bun",
            "cargo",
            "rustc",
            "go",
            "pip",
            "pip3",
            "uv",
            "poetry",
            "pytest",
            "jest",
            "vitest",
            "gradle",
            "mvn",
            "dotnet",
            "docker",
            "kubectl",
            "terraform",
            "ansible",
            "sudo",
            "su",
            "env",
            "xargs",
            "find",
            "sed",
            "awk",
            "patch",
            "rsync",
            "gpg",
            "ssh-keygen",
        ] {
            let argv = vec![program.to_string(), "--version".to_string()];
            assert_eq!(
                classify_shell_argv_side_effect(&argv),
                ShellSideEffectClass::ArbitraryFs,
                "{program} must not be classified as read-only"
            );
        }
        for program in [
            "echo", "printf", "true", "false", "cat", "head", "tail", "wc", "ls", "pwd",
        ] {
            let argv = vec![program.to_string()];
            assert_eq!(
                classify_shell_argv_side_effect(&argv),
                ShellSideEffectClass::StreamOnly,
                "{program} is read-only"
            );
        }
    }

    #[test]
    fn result_digest_stable_when_equal() {
        assert!(assess_result_digest_stable("abc", "abc"));
        assert!(!assess_result_digest_stable("abc", "def"));
    }

    #[test]
    fn postimage_missing_only_when_expected_and_absent() {
        assert!(!assess_postimage_missing_at_observe(false, false));
        assert!(!assess_postimage_missing_at_observe(false, true));
        assert!(assess_postimage_missing_at_observe(true, false));
        assert!(!assess_postimage_missing_at_observe(true, true));
    }

    #[test]
    fn evidence_forces_unknown_matches_ts_flags() {
        assert!(evidence_forces_unknown(Some(false), None, None));
        assert!(evidence_forces_unknown(None, Some(true), None));
        assert!(evidence_forces_unknown(None, None, Some(false)));
        assert!(!evidence_forces_unknown(
            Some(true),
            Some(false),
            Some(true)
        ));
        assert!(!evidence_forces_unknown(None, None, None));
    }

    #[test]
    fn single_capture_reports_a_digest_and_no_second_look() {
        let obs = observe_captured_stream_digest(b"hello\n");
        assert!(obs.observation_stable);
        assert_eq!(
            obs.digest.as_deref(),
            Some(crate::canon::sha256_bytes(b"hello\n").as_str())
        );
        assert!(obs.confirm_digest.is_none());
    }

    #[test]
    fn a_second_observation_is_compared_not_restated() {
        let agree = observe_captured_stream_digest_with_second(b"hello\n", Some(b"hello\n"));
        assert!(agree.observation_stable);
        assert!(agree.digest.is_some());
        assert!(agree.confirm_digest.is_some());

        let disagree = observe_captured_stream_digest_with_second(b"hello\n", Some(b"HELLO\n"));
        assert!(!disagree.observation_stable);
        assert!(disagree.digest.is_none());
        assert!(disagree.confirm_digest.is_some());

        let single = observe_captured_stream_digest_with_second(b"hello\n", None);
        assert!(single.observation_stable);
        assert!(single.digest.is_some());
    }

    #[test]
    fn kernel_fs_mutation_result_digest_stable() {
        let obs = observe_kernel_fs_mutation_result_digest(
            FsMutationResultKind::Write,
            "note.txt",
            Some("abc123"),
            None,
        );
        assert!(obs.observation_stable);
        let output = kernel_fs_mutation_success_output(
            FsMutationResultKind::Write,
            "note.txt",
            Some("abc123"),
            None,
        );
        assert_eq!(
            obs.digest.as_deref(),
            Some(crate::canon::sha256_bytes(output.as_bytes()).as_str())
        );
    }

    #[test]
    fn shell_exec_digest_stable_requires_both_streams() {
        let ok = observe_captured_stream_digest(b"a");
        assert!(shell_exec_result_digest_stable(&ok, &ok));
        let bad = ShellStreamObservation {
            digest: None,
            observation_stable: false,
            confirm_digest: Some("x".to_string()),
        };
        assert!(!shell_exec_result_digest_stable(&ok, &bad));
    }

    #[test]
    fn parse_reduced_shell_fs_argv_shapes() {
        assert_eq!(
            parse_reduced_shell_fs_mutate_argv(&["rm".into(), "-f".into(), "x".into()])
                .map(|p| p.shape),
            Some(ShellFsMutateShape::Rm)
        );
        let plain_rm = parse_reduced_shell_fs_mutate_argv(&["rm".into(), "note.txt".into()])
            .expect("one-path rm must be a reduced shape");
        assert_eq!(plain_rm.shape, ShellFsMutateShape::Rm);
        assert_eq!(plain_rm.raw_path, "note.txt");
        assert!(parse_reduced_shell_fs_mutate_argv(&["rm".into(), "a".into(), "b".into()]).is_none());
        assert_eq!(
            parse_reduced_shell_fs_mutate_argv(&["touch".into(), "a.txt".into()]).map(|p| p.shape),
            Some(ShellFsMutateShape::Touch)
        );
        assert_eq!(
            parse_reduced_shell_fs_mutate_argv(&["mkdir".into(), "-p".into(), "d".into()])
                .map(|p| p.shape),
            Some(ShellFsMutateShape::MkdirParents)
        );
        assert_eq!(
            parse_reduced_shell_fs_mutate_argv(&["mkdir".into(), "single".into()]).map(|p| p.shape),
            Some(ShellFsMutateShape::Mkdir)
        );
        assert_eq!(
            parse_reduced_shell_fs_mutate_argv(&["cp".into(), "a".into(), "b".into()])
                .map(|p| (p.shape, p.raw_path_from.clone())),
            Some((ShellFsMutateShape::Cp, Some("a".into())))
        );
        assert_eq!(
            parse_reduced_shell_fs_mutate_argv(&["mv".into(), "-f".into(), "s".into(), "d".into()])
                .map(|p| p.shape),
            Some(ShellFsMutateShape::Mv)
        );
        let rmdir = parse_reduced_shell_fs_mutate_argv(&["rmdir".into(), "empty-dir".into()]);
        assert!(rmdir.is_some(), "one-path rmdir must be a reduced shape");
        let rmdir = rmdir.unwrap();
        assert_eq!(rmdir.raw_path, "empty-dir");
        assert_eq!(rmdir.raw_path_from, None);
        assert!(parse_reduced_shell_fs_mutate_argv(&[
            "rmdir".into(),
            "-p".into(),
            "empty-dir".into()
        ])
        .is_none());
        assert!(
            parse_reduced_shell_fs_mutate_argv(&["rmdir".into(), "a".into(), "b".into()]).is_none()
        );
        assert!(
            parse_reduced_shell_fs_mutate_argv(&["./rm".into(), "-f".into(), "x".into()]).is_none()
        );
        // Ruling 920: truncate shapes (bare = size 0; -s N = explicit size).
        assert_eq!(
            parse_reduced_shell_fs_mutate_argv(&["truncate".into(), "x".into()]),
            Some(ShellFsMutateShape::Truncate).map(|shape| ParsedShellFsMutate {
                shape,
                raw_path: "x".into(),
                raw_path_from: None,
            })
        );
        assert_eq!(
            parse_reduced_shell_fs_mutate_argv(&[
                "truncate".into(),
                "-s".into(),
                "7".into(),
                "y".into()
            ]),
            Some(ShellFsMutateShape::Truncate).map(|shape| ParsedShellFsMutate {
                shape,
                raw_path: "y".into(),
                raw_path_from: None,
            })
        );
        assert!(
            parse_reduced_shell_fs_mutate_argv(&["truncate".into(), "-c".into(), "x".into()])
                .is_none()
        );
        assert!(parse_reduced_shell_fs_mutate_argv(&[
            "truncate".into(),
            "-s".into(),
            "abc".into(),
            "y".into()
        ])
        .is_none());
        // Ruling 921: install shapes (plain and -m MODE), dest is the observed path.
        assert_eq!(
            parse_reduced_shell_fs_mutate_argv(&["install".into(), "src".into(), "dst".into()]),
            Some(ParsedShellFsMutate {
                shape: ShellFsMutateShape::Install,
                raw_path: "dst".into(),
                raw_path_from: Some("src".into()),
            })
        );
        assert_eq!(
            parse_reduced_shell_fs_mutate_argv(&[
                "install".into(),
                "-m".into(),
                "0755".into(),
                "src".into(),
                "dst".into()
            ]),
            Some(ParsedShellFsMutate {
                shape: ShellFsMutateShape::Install,
                raw_path: "dst".into(),
                raw_path_from: Some("src".into()),
            })
        );
        assert!(
            parse_reduced_shell_fs_mutate_argv(&["install".into(), "-d".into(), "dir".into()])
                .is_none()
        );
        assert!(parse_reduced_shell_fs_mutate_argv(&["install".into(), "src".into()]).is_none());
        assert!(parse_reduced_shell_fs_mutate_argv(&[
            "cp".into(),
            "-r".into(),
            "a".into(),
            "b".into()
        ])
        .is_none());
        assert!(
            parse_reduced_shell_fs_mutate_argv(&["rm".into(), "-rf".into(), "x".into()]).is_none()
        );
        assert!(parse_reduced_shell_fs_mutate_argv(&["echo".into(), "hi".into()]).is_none());
    }

    #[test]
    fn classify_shell_argv_side_effect_honesty() {
        assert_eq!(
            classify_shell_argv_side_effect(&["rm".into(), "-f".into(), "x".into()]),
            ShellSideEffectClass::ReducedFs
        );
        assert_eq!(
            classify_shell_argv_side_effect(&["rm".into(), "note.txt".into()]),
            ShellSideEffectClass::ReducedFs
        );
        assert_eq!(
            classify_shell_argv_side_effect(&["curl".into(), "https://example.com".into()]),
            ShellSideEffectClass::LikelyNet
        );
        assert_eq!(
            classify_shell_argv_side_effect(&["wget".into(), "-O".into(), "f".into(), "u".into()]),
            ShellSideEffectClass::LikelyNet
        );
        assert_eq!(
            classify_shell_argv_side_effect(&["rm".into(), "-rf".into(), "x".into()]),
            ShellSideEffectClass::ArbitraryFs
        );
        assert_eq!(
            classify_shell_argv_side_effect(&["echo".into(), "hi".into()]),
            ShellSideEffectClass::StreamOnly
        );
        assert_eq!(
            classify_shell_argv_side_effect(&["./echo".into(), "hi".into()]),
            ShellSideEffectClass::Unknown
        );
        assert_eq!(
            classify_shell_argv_side_effect(&["./rm".into(), "-f".into(), "x".into()]),
            ShellSideEffectClass::Unknown
        );
        assert_eq!(
            classify_shell_argv_side_effect(&["C:\\tools\\echo".into(), "hi".into()]),
            ShellSideEffectClass::Unknown
        );
        assert_eq!(
            classify_shell_argv_side_effect(&["sleep".into(), "1".into()]),
            ShellSideEffectClass::StreamOnly
        );
        assert_eq!(
            classify_shell_argv_side_effect(&[]),
            ShellSideEffectClass::Unknown
        );
    }

    #[test]
    fn observe_shell_cp_and_mv_postimages_on_disk() {
        let root = std::env::temp_dir().join(format!("hz-shell-fs-cpmv-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        fs::write(root.join("src.txt"), b"payload").unwrap();
        fs::copy(root.join("src.txt"), root.join("dest.txt")).unwrap();
        let cp_parsed = ParsedShellFsMutate {
            shape: ShellFsMutateShape::Cp,
            raw_path: "dest.txt".into(),
            raw_path_from: Some("src.txt".into()),
        };
        let (cp_rows, cp_stable) =
            observe_shell_fs_postimages(&root, &root, &cp_parsed).expect("cp observe");
        assert!(cp_stable);
        assert_eq!(cp_rows.as_array().unwrap().len(), 1);
        assert_eq!(cp_rows[0]["state"], "present");
        assert_eq!(cp_rows[0]["via"], "shell.cp");
        assert!(root.join("dest.txt").is_file());

        fs::write(root.join("mv-src.txt"), b"x").unwrap();
        let mv_parsed = ParsedShellFsMutate {
            shape: ShellFsMutateShape::Mv,
            raw_path: "mv-dest.txt".into(),
            raw_path_from: Some("mv-src.txt".into()),
        };
        // simulate mv by rename so observe sees expected layout
        fs::rename(root.join("mv-src.txt"), root.join("mv-dest.txt")).unwrap();
        let (mv_rows, mv_stable) =
            observe_shell_fs_postimages(&root, &root, &mv_parsed).expect("mv observe");
        assert!(mv_stable);
        assert_eq!(mv_rows.as_array().unwrap().len(), 2);
        assert_eq!(mv_rows[0]["via"], "shell.mv");
        assert_eq!(mv_rows[1]["state"], "absent");
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn reduced_shell_parser_rejects_path_qualified_executables() {
        assert!(
            parse_reduced_shell_fs_mutate_argv(&["./rm".into(), "-f".into(), "x".into()]).is_none()
        );
        assert!(
            parse_reduced_shell_fs_mutate_argv(&["C:\\tools\\rmdir".into(), "empty".into()])
                .is_none()
        );
    }

    #[test]
    fn observe_shell_mkdir_p_reports_bounded_parent_directory_postimages() {
        let root = std::env::temp_dir().join(format!("hz-shell-mkdir-p-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let leaf = root.join("a").join("b").join("c");
        fs::create_dir_all(&leaf).unwrap();

        let argv = ["mkdir".into(), "-p".into(), "a/b/c".into()];
        let parsed = parse_reduced_shell_fs_mutate_argv(&argv).expect("mkdir -p parses");
        let (rows, stable) = observe_shell_fs_postimages(&root, &root, &parsed).expect("observe");
        assert!(stable);
        assert_eq!(
            rows.as_array().unwrap().len(),
            3,
            "mkdir -p must report all resultant directories: {rows}"
        );
        for (row, path) in rows.as_array().unwrap().iter().zip([
            root.join("a"),
            root.join("a").join("b"),
            leaf.clone(),
        ]) {
            assert_eq!(row["path"], path.to_string_lossy().as_ref());
            assert_eq!(row["state"], "present");
            assert_eq!(row["entryKind"], "directory");
            assert_eq!(row["via"], "shell.mkdir_p");
        }
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn observe_shell_mkdir_p_refuses_paths_over_component_cap() {
        let root =
            std::env::temp_dir().join(format!("hz-shell-mkdir-p-cap-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let raw = vec!["a"; MAX_MKDIR_P_POSTIMAGE_COMPONENTS + 1].join("/");
        let argv = vec!["mkdir".to_string(), "-p".to_string(), raw];
        let parsed = parse_reduced_shell_fs_mutate_argv(&argv).expect("mkdir -p parses");
        let refused = observe_shell_fs_postimages(&root, &root, &parsed).unwrap_err();
        assert!(refused.contains("exceeds 64 path components"), "{refused}");
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn observe_shell_mkdir_single_path_remains_one_postimage() {
        let root =
            std::env::temp_dir().join(format!("hz-shell-mkdir-single-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let target = root.join("single");
        fs::create_dir(&target).unwrap();

        let argv = ["mkdir".into(), "single".into()];
        let parsed = parse_reduced_shell_fs_mutate_argv(&argv).expect("mkdir parses");
        let (rows, stable) = observe_shell_fs_postimages(&root, &root, &parsed).expect("observe");
        assert!(stable);
        assert_eq!(rows.as_array().unwrap().len(), 1);
        assert_eq!(rows[0]["path"], target.to_string_lossy().as_ref());
        assert_eq!(rows[0]["via"], "shell.mkdir");
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn observe_shell_rmdir_postimage_on_disk() {
        let root = std::env::temp_dir().join(format!("hz-shell-rmdir-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        let target = root.join("empty-dir");
        fs::create_dir(&target).unwrap();
        fs::remove_dir(&target).unwrap();

        let argv = ["rmdir".into(), "empty-dir".into()];
        let parsed = parse_reduced_shell_fs_mutate_argv(&argv)
            .expect("one-path rmdir must parse as a reduced mutation");
        let (rows, stable) = observe_shell_fs_postimages(&root, &root, &parsed).expect("observe");
        assert!(stable);
        assert_eq!(rows.as_array().unwrap().len(), 1);
        assert_eq!(rows[0]["path"], target.to_string_lossy().as_ref());
        assert_eq!(rows[0]["state"], "absent");
        assert_eq!(rows[0]["via"], "shell.rmdir");
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn observe_shell_plain_rm_postimage_on_disk() {
        let root = std::env::temp_dir().join(format!("hz-shell-rm-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        let target = root.join("note.txt");
        fs::write(&target, b"gone").unwrap();
        fs::remove_file(&target).unwrap();

        let argv = ["rm".into(), "note.txt".into()];
        let parsed = parse_reduced_shell_fs_mutate_argv(&argv)
            .expect("one-path rm must parse as a reduced mutation");
        let (rows, stable) = observe_shell_fs_postimages(&root, &root, &parsed).expect("observe");
        assert!(stable);
        assert_eq!(rows.as_array().unwrap().len(), 1);
        assert_eq!(rows[0]["path"], target.to_string_lossy().as_ref());
        assert_eq!(rows[0]["state"], "absent");
        assert_eq!(rows[0]["via"], "shell.rm");
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn observe_shell_touch_postimage_on_disk() {
        let root = std::env::temp_dir().join(format!("hz-shell-fs-observe-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        let target = root.join("probe.txt");
        fs::write(&target, b"").unwrap();
        let parsed = ParsedShellFsMutate {
            shape: ShellFsMutateShape::Touch,
            raw_path: "probe.txt".into(),
            raw_path_from: None,
        };
        let (rows, stable) = observe_shell_fs_postimages(&root, &root, &parsed).expect("observe");
        assert!(stable);
        assert_eq!(rows.as_array().unwrap().len(), 1);
        assert_eq!(rows[0]["state"], "present");
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn kernel_delete_rename_result_digest_stable() {
        let empty = crate::canon::sha256_bytes(b"");
        let del = observe_kernel_fs_mutation_result_digest(
            FsMutationResultKind::Delete,
            "gone.txt",
            Some(empty.as_str()),
            None,
        );
        assert!(del.observation_stable);
        let ren = observe_kernel_fs_mutation_result_digest(
            FsMutationResultKind::Rename,
            "dest.txt",
            Some("dig"),
            Some("src.txt"),
        );
        assert!(ren.observation_stable);
        let multi =
            observe_kernel_apply_patch_multi_op_result_digest(2, "a.txt, b.txt", Some("dig"));
        assert!(multi.observation_stable);
    }
}
