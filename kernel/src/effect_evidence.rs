//! Observe evidence flags — TS `effect-evidence.ts` / **257** mirror for kernel reconcile + execute.

use crate::receipt_postimage::assess_postimage_observation;

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

pub fn observe_captured_stream_digest(bytes: &[u8]) -> ShellStreamObservation {
    let primary = Some(crate::canon::sha256_bytes(bytes));
    let confirm = Some(crate::canon::sha256_bytes(bytes));
    let (observation_stable, mismatch_confirm) =
        assess_postimage_observation(primary.as_deref(), confirm.as_deref());
    ShellStreamObservation {
        digest: if observation_stable { primary } else { None },
        observation_stable,
        confirm_digest: mismatch_confirm,
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
        assert!(!evidence_forces_unknown(Some(true), Some(false), Some(true)));
        assert!(!evidence_forces_unknown(None, None, None));
    }

    #[test]
    fn captured_stream_digest_double_hash_stable() {
        let obs = observe_captured_stream_digest(b"hello\n");
        assert!(obs.observation_stable);
        assert_eq!(
            obs.digest.as_deref(),
            Some(crate::canon::sha256_bytes(b"hello\n").as_str())
        );
        assert!(obs.confirm_digest.is_none());
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
        let multi = observe_kernel_apply_patch_multi_op_result_digest(2, "a.txt, b.txt", Some("dig"));
        assert!(multi.observation_stable);
    }
}
