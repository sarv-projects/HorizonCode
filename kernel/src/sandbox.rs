//! Sandbox: a FAIL-CLOSED per-call `SandboxMode` ladder with capability-detected
//! OS enforcement (FEAT-004; NF-016 item 11; docs/11 S1-S9).
//!
//! Modeled on dsh's `escalation.ts` (research/compare-ohmypi-deepseek.md §2.4,
//! L140-146): a per-call `SandboxMode = read-only | workspace-write |
//! danger-full-access`, a strictly-WIDER_MODES table, byte-for-byte model-facing
//! escalation/denial markers, and a one-shot `approveEscalation` that widens a
//! SINGLE call. Two layers live here:
//!
//!   (1) the PURE ladder/contract — `SandboxMode`, `WIDER_MODES`,
//!       `ESCALATION_TARGETS`, the markers, `validate_escalation_args`,
//!       `approve_escalation`, and `EnforcementCompleteness { Full, Partial }`
//!       plus a `SANDBOX_UNAVAILABLE` outcome. This is deterministic, does NO
//!       I/O, and is fully unit-testable on any host.
//!
//!   (2) the capability-detected OS layer — detect at RUNTIME (cache once) what
//!       the kernel this binary runs on actually offers (Landlock, bubblewrap,
//!       unprivileged user namespaces, seccomp, rlimits, netns) via std + raw
//!       syscall / `/proc` inspection, and FAIL CLOSED to `unsupported` on ANY
//!       error (never panic). A required mechanism being absent yields a typed
//!       `SANDBOX_UNAVAILABLE` (HZ_PRECONDITION_FAILED class) OR an
//!       `EnforcementReport` with the missing dimension `unsupported` + a
//!       NON-EMPTY residual and an explicit backend name or `none` — NEVER a
//!       silent `enforced`, NEVER silently unconfined (docs/11 S1/S2/S4/S5).
//!
//! THE FAIL-CLOSED RULE (docs/11 S1/S4, dsh SANDBOX_UNAVAILABLE). `read-only`
//! and `workspace-write` REQUIRE kernel-enforced per-path FS confinement.
//! Enforcement for owned children is applied by the companion binary
//! `hz-sandbox-exec` (seccomp + rlimits + userns/netns + Landlock FS via
//! `HZ_SANDBOX_FS_ROOT` / `HZ_SANDBOX_FS_MODE`) when the live host canary
//! succeeds (docs/28 rulings 140–150). This module remains the REPORTING/
//! admission seam: a dimension is `enforced` ONLY when the host OFFERS the
//! mechanism (capability detection) AND `kernel_applied_mechanisms()` — which
//! now runs `hz-sandbox-exec -- /bin/true` with the child policy — proves this
//! tree APPLIES it. Detection alone (`available` / `hostCapabilities`) is never
//! converted into enforcement (ruling 51). The report always carries the
//! `probe` object so a caller can see whether a live probe was possible. When
//! the helper/canary cannot confine FS, FS-demanding modes yield
//! `SANDBOX_UNAVAILABLE` with a residual that names the gap.
//! `danger-full-access` reports NO dimension enforced (S4).
//!
//! LAW reuse: nothing here invents a hash. Where a digest or canonical form is
//! needed (`EnforcementReport::to_canonical_json`) it goes through
//! `canon::canonical_json` — the SAME canonical-JSON contract the event and
//! receipt chains use. NO new hash scheme is introduced.

// Dead-code note: the escalation vocabulary — `WIDER_MODES`/`is_strictly_wider`,
// `ESCALATION_TARGETS`, the `sandbox_denial_marker`/`escalation_hint_marker`
// model-facing strings, `ApprovalOutcome`/`EscalationRequest`/
// `approve_escalation`, and the `EnforcementOutcome::to_canonical_json` /
// `EnforcementReport::has_no_enforced_dimension` accessors — is the PURE,
// fully unit-tested model of dsh's one-call escalation flow. Its live
// consumers are the runtime admission seam (shell.exec/spawn GuardDecision
// metadata and the TUI approval prompt that actually widens a single call) and
// a model-facing tool surface, which are a DEFERRED follow-up (see the module
// header and docs/28 ruling 44): the kernel reports the fail-closed posture
// over `sandbox.report` today, the one-shot widen wires later. They are
// exercised by the `#[cfg(test)]` suite below; `allow(dead_code)` documents
// that they are contract-and-data now, wiring later, rather than accidentally
// unused — matching `egress.rs`.
#![allow(dead_code)]

use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::OnceLock;
use std::time::{Duration, Instant};

use serde_json::{json, Value};

/* -------------------------------- SandboxMode ------------------------------ */

/// The three fail-closed per-call sandbox modes (dsh `SandboxMode`). Wire
/// strings are stable and byte-identical to `app/src/contracts.ts`
/// (`"read-only"` / `"workspace-write"` / `"danger-full-access"`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SandboxMode {
    /// The floor: no mutation, no network. Requires FS confinement (read-only).
    ReadOnly,
    /// Write within the workspace. Requires FS confinement (path-scoped write).
    WorkspaceWrite,
    /// No confinement at all — the user's ambient authority (S4: NO dimension
    /// is enforced under this mode).
    DangerFullAccess,
}

impl SandboxMode {
    /// The stable wire string.
    pub fn as_str(self) -> &'static str {
        match self {
            SandboxMode::ReadOnly => "read-only",
            SandboxMode::WorkspaceWrite => "workspace-write",
            SandboxMode::DangerFullAccess => "danger-full-access",
        }
    }

    /// Parse a wire string, fail-closed (an unknown string is `None`, never a
    /// silent default to a wider or narrower mode).
    pub fn parse(s: &str) -> Option<SandboxMode> {
        match s {
            "read-only" => Some(SandboxMode::ReadOnly),
            "workspace-write" => Some(SandboxMode::WorkspaceWrite),
            "danger-full-access" => Some(SandboxMode::DangerFullAccess),
            _ => None,
        }
    }

    /// The strictly-WIDER modes for this mode (dsh `WIDER_MODES`): the modes a
    /// one-shot escalation may target FROM here. `read-only` is the floor, so
    /// nothing escalates TO it; `danger-full-access` is the ceiling, so nothing
    /// is wider than it.
    ///
    ///   read-only       -> [workspace-write, danger-full-access]
    ///   workspace-write -> [danger-full-access]
    ///   danger-full-access -> []
    pub fn wider_modes(self) -> &'static [SandboxMode] {
        match self {
            SandboxMode::ReadOnly => {
                &[SandboxMode::WorkspaceWrite, SandboxMode::DangerFullAccess]
            }
            SandboxMode::WorkspaceWrite => &[SandboxMode::DangerFullAccess],
            SandboxMode::DangerFullAccess => &[],
        }
    }

    /// `true` when `target` is strictly WIDER than `self` (per `wider_modes`).
    pub fn is_strictly_wider(self, target: SandboxMode) -> bool {
        self.wider_modes().contains(&target)
    }

    /// Does this mode REQUIRE kernel-enforced per-path FS confinement? Both
    /// `read-only` and `workspace-write` do (read-only still needs the write
    /// floor enforced); `danger-full-access` does not (S4 — it is deliberately
    /// unconfined).
    pub fn requires_fs_confinement(self) -> bool {
        matches!(self, SandboxMode::ReadOnly | SandboxMode::WorkspaceWrite)
    }
}

/// The schema-enum escalation targets (dsh `ESCALATION_TARGETS`): the modes a
/// caller may ASK to escalate to. `read-only` is the floor and is deliberately
/// absent — nothing escalates to it.
pub const ESCALATION_TARGETS: &[SandboxMode] =
    &[SandboxMode::WorkspaceWrite, SandboxMode::DangerFullAccess];

/* --------------------------------- markers --------------------------------- */

/// The model-facing denial marker (dsh `sandboxDenialMarker(mode)`), reproduced
/// byte-for-byte from `escalation.ts` as quoted in
/// research/compare-ohmypi-deepseek.md §2.4:
///   `[sandbox: file access denied under ${mode} mode]`
pub fn sandbox_denial_marker(mode: SandboxMode) -> String {
    format!("[sandbox: file access denied under {} mode]", mode.as_str())
}

/// The model-facing escalation-hint marker (dsh `escalationHintMarker(subject)`),
/// reproduced BYTE-FOR-BYTE from `escalation.ts` as quoted in
/// research/compare-ohmypi-deepseek.md §2.4 L145. The source separates
/// "available" from "retry" with an EM DASH (U+2014) — preserved exactly, as
/// this is model-facing text:
///   `[sandbox: escalation available — retry this exact ${subject} once with
///    sandbox_permissions (the narrowest wider mode that suffices) +
///    justification; the approval prompt asks the user]`
///
/// (The single-line string is what ships; the wrap above is only for the doc.)
pub fn escalation_hint_marker(subject: &str) -> String {
    format!(
        "[sandbox: escalation available \u{2014} retry this exact {} once with sandbox_permissions (the narrowest wider mode that suffices) + justification; the approval prompt asks the user]",
        subject
    )
}

/* ---------------------------- escalation arguments ------------------------- */

/// The paired escalation arguments a caller supplies to widen a single call
/// (dsh `sandbox_permissions` + `justification`). They travel TOGETHER and the
/// justification is non-empty (enforced by `validate_escalation_args`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EscalationArgs {
    /// The strictly-wider mode the caller asks for (dsh `sandbox_permissions`).
    pub sandbox_permissions: SandboxMode,
    /// A non-empty human justification shown in the approval prompt.
    pub justification: String,
}

/// Why an escalation request is refused BEFORE execution (a typed, fail-closed
/// refusal — never a silent widen). Every variant is a pre-execution throw.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum EscalationError {
    /// `sandbox_permissions` and `justification` did not travel together, or the
    /// justification was empty/blank (dsh `validateEscalationArgs`).
    Args(String),
    /// The target is not strictly wider than the effective mode (narrower,
    /// equal-but-claimed-wider, or an unsupported target).
    NotWider { from: SandboxMode, to: SandboxMode },
    /// No approver/agent was present (no session to audit, no UI to route).
    MissingApprover,
    /// The approval outcome was not a grant (rejected / cancelled / unavailable).
    NotGranted(String),
}

impl std::fmt::Display for EscalationError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            EscalationError::Args(detail) => write!(
                f,
                "HZ_PRECONDITION_FAILED: sandbox escalation arguments are invalid: {}",
                detail
            ),
            EscalationError::NotWider { from, to } => write!(
                f,
                "HZ_PRECONDITION_FAILED: sandbox escalation target {:?} is not strictly wider than the effective mode {:?}",
                to.as_str(),
                from.as_str()
            ),
            EscalationError::MissingApprover => write!(
                f,
                "HZ_PRECONDITION_FAILED: sandbox escalation needs an approver/agent; none present"
            ),
            EscalationError::NotGranted(detail) => write!(
                f,
                "HZ_PRECONDITION_FAILED: sandbox escalation was not granted: {}",
                detail
            ),
        }
    }
}

impl std::error::Error for EscalationError {}

/// Validate the paired escalation arguments (dsh `validateEscalationArgs`):
/// `sandbox_permissions` and `justification` MUST travel together and the
/// justification MUST be non-empty. `raw_permissions` is the (optional) parsed
/// mode; `raw_justification` is the (optional) raw justification string. A lone
/// or empty field is a typed refusal BEFORE execution.
pub fn validate_escalation_args(
    raw_permissions: Option<SandboxMode>,
    raw_justification: Option<&str>,
) -> Result<EscalationArgs, EscalationError> {
    let justification_present = raw_justification.map(|s| !s.trim().is_empty()).unwrap_or(false);
    match (raw_permissions, justification_present) {
        (Some(mode), true) => Ok(EscalationArgs {
            sandbox_permissions: mode,
            // keep the raw (untrimmed) justification; non-emptiness is proven
            justification: raw_justification.unwrap().to_string(),
        }),
        (Some(_), false) => Err(EscalationError::Args(
            "sandbox_permissions was given without a non-empty justification".to_string(),
        )),
        (None, true) => Err(EscalationError::Args(
            "justification was given without sandbox_permissions".to_string(),
        )),
        (None, false) => Err(EscalationError::Args(
            "sandbox_permissions and justification must travel together".to_string(),
        )),
    }
}

/// The approval outcome a caller feeds back (dsh approval seam): a grant, or one
/// of the distinct non-grant outcomes. Only `Granted` admits.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ApprovalOutcome {
    Granted,
    Rejected,
    Cancelled,
    Unavailable,
}

impl ApprovalOutcome {
    fn non_grant_detail(self) -> Option<&'static str> {
        match self {
            ApprovalOutcome::Granted => None,
            ApprovalOutcome::Rejected => Some("rejected"),
            ApprovalOutcome::Cancelled => Some("cancelled"),
            ApprovalOutcome::Unavailable => Some("unavailable"),
        }
    }
}

/// A one-shot escalation request (dsh `approveEscalation(request, approval)`):
/// the effective (current) mode, the requested args, whether an approver/agent
/// is present, and the approval outcome.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EscalationRequest {
    pub effective: SandboxMode,
    pub args: EscalationArgs,
    pub has_approver: bool,
    pub approval: ApprovalOutcome,
}

/// Resolve a one-shot escalation (dsh `approveEscalation`), PURE/deterministic
/// so it is fully unit-testable:
///   - repeating the current EFFECTIVE mode needs NO approval (returns it);
///   - a strictly-WIDER mode (per `wider_modes`) requires approval and applies
///     to THAT ONE call only (returns the wider mode on a grant);
///   - a narrower-or-equal-but-claimed-wider target, an unsupported target, a
///     missing approver/agent, or a non-grant approval outcome THROW before
///     execution.
///
/// Returns the effective mode FOR THIS ONE CALL.
pub fn approve_escalation(req: &EscalationRequest) -> Result<SandboxMode, EscalationError> {
    let target = req.args.sandbox_permissions;

    // Repeating the effective mode: no approval needed, no widen.
    if target == req.effective {
        return Ok(req.effective);
    }

    // Anything else must be STRICTLY WIDER than the effective mode. A narrower
    // or an otherwise-not-wider target is refused before execution.
    if !req.effective.is_strictly_wider(target) {
        return Err(EscalationError::NotWider {
            from: req.effective,
            to: target,
        });
    }

    // A strictly-wider mode needs an approver/agent present …
    if !req.has_approver {
        return Err(EscalationError::MissingApprover);
    }

    // … and an actual grant. A non-grant outcome throws (distinct reasons).
    if let Some(detail) = req.approval.non_grant_detail() {
        return Err(EscalationError::NotGranted(detail.to_string()));
    }

    // Granted: the wider mode applies to THIS ONE call only.
    Ok(target)
}

/* --------------------------- enforcement reporting ------------------------- */

/// Whether a mode's confinement was reported FULLY enforced or only PARTIALLY
/// (dsh enforcement-completeness `full`/`partial`). A consumer needing the
/// absolute boundary can reject `partial`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EnforcementCompleteness {
    Full,
    Partial,
}

impl EnforcementCompleteness {
    pub fn as_str(self) -> &'static str {
        match self {
            EnforcementCompleteness::Full => "full",
            EnforcementCompleteness::Partial => "partial",
        }
    }
}

/// The guarantee level for a single sandbox dimension (docs/11 S2/S3 guarantee
/// vector): `enforced` (a real OS mechanism confines it), `best_effort` (a
/// mechanism is applied but cannot be relied on as a hard boundary), or
/// `unsupported` (no mechanism — NEVER silently treated as enforced).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Guarantee {
    Enforced,
    BestEffort,
    Unsupported,
}

impl Guarantee {
    pub fn as_str(self) -> &'static str {
        match self {
            Guarantee::Enforced => "enforced",
            Guarantee::BestEffort => "best_effort",
            Guarantee::Unsupported => "unsupported",
        }
    }
}

/// One dimension of the guarantee vector. `residual` MUST be non-empty whenever
/// the guarantee is below `enforced` (docs/11 S2/S3); it names what is NOT
/// guaranteed. `backend` is the explicit mechanism name, or `"none"` (docs/11
/// S5: no silent fallback — there is always an explicit backend or an explicit
/// `none`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DimensionReport {
    pub dimension: String,
    pub guarantee: Guarantee,
    /// The explicit backend name (e.g. `"seccomp"`, `"netns"`) or `"none"`.
    pub backend: String,
    /// NON-EMPTY whenever the guarantee is below `enforced`; the typed residual.
    pub residual: String,
    /// Whether the HOST offers the mechanism for this dimension (capability
    /// detection). Informational only: `available` NEVER implies `enforced`.
    pub available: bool,
}

impl DimensionReport {
    fn to_json(&self) -> Value {
        json!({
            "dimension": self.dimension,
            "guarantee": self.guarantee.as_str(),
            "backend": self.backend,
            "residual": self.residual,
            "available": self.available,
        })
    }
}

/// The per-call enforcement outcome for a requested mode: either a report
/// (possibly `partial`) or a `SANDBOX_UNAVAILABLE` refusal when a REQUIRED
/// dimension cannot be met (the fail-closed choice — never a silent downgrade to
/// `enforced`, never silently unconfined).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum EnforcementOutcome {
    Report(EnforcementReport),
    /// A required mechanism is absent: a typed `SANDBOX_UNAVAILABLE`
    /// (HZ_PRECONDITION_FAILED class) naming the unmet dimension + reason.
    Unavailable {
        mode: SandboxMode,
        reason: String,
        /// What the host offers (detection only; not enforcement).
        host_capabilities: Capabilities,
    },
}

impl EnforcementOutcome {
    /// The wire JSON for the outcome. A report is `{status:"report", ...}`; an
    /// unavailable outcome is `{status:"sandbox_unavailable", ...}` with the
    /// typed `HZ_PRECONDITION_FAILED` reason — byte-identical in semantics to
    /// `app/src/contracts.ts`.
    pub fn to_json(&self) -> Value {
        match self {
            EnforcementOutcome::Report(report) => report.to_json(),
            EnforcementOutcome::Unavailable {
                mode,
                reason,
                host_capabilities,
            } => {
                let mut obj = json!({
                    "status": "sandbox_unavailable",
                    "mode": mode.as_str(),
                    "reason": reason,
                    "hostCapabilities": host_capabilities.to_json(),
                });
                append_platform_notes(&mut obj);
                obj
            }
        }
    }

    /// The canonical-JSON string (LAW reuse: `canon`).
    pub fn to_canonical_json(&self) -> String {
        crate::canon::canonical_json(&self.to_json())
    }
}

/// A per-call enforcement report for a requested mode (dsh enforcement-
/// completeness, docs/11 S2/S3/S5 guarantee vector). `backend` at the top level
/// is the primary confinement backend name or `"none"` (S5).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EnforcementReport {
    pub mode: SandboxMode,
    pub completeness: EnforcementCompleteness,
    pub dimensions: Vec<DimensionReport>,
    /// The primary confinement backend (explicit name or `"none"`, S5).
    pub backend: String,
    /// Present when a required mechanism was absent but the caller did not
    /// demand full enforcement (so the report is `partial` rather than
    /// `SANDBOX_UNAVAILABLE`); names what is unavailable.
    pub unavailable_reason: Option<String>,
    /// What the host offers (detection only; not enforcement).
    pub host_capabilities: Capabilities,
}

impl EnforcementReport {
    fn to_json(&self) -> Value {
        let dims: Vec<Value> = self.dimensions.iter().map(DimensionReport::to_json).collect();
        let mut obj = json!({
            "status": "report",
            "mode": self.mode.as_str(),
            "completeness": self.completeness.as_str(),
            "backend": self.backend,
            "dimensions": dims,
            "hostCapabilities": self.host_capabilities.to_json(),
        });
        if let Some(reason) = &self.unavailable_reason {
            obj.as_object_mut()
                .unwrap()
                .insert("unavailableReason".to_string(), json!(reason));
        }
        append_platform_notes(&mut obj);
        obj
    }

    /// `true` when NO dimension is `enforced` (danger-full-access, S4).
    pub fn has_no_enforced_dimension(&self) -> bool {
        !self
            .dimensions
            .iter()
            .any(|d| d.guarantee == Guarantee::Enforced)
    }
}

/// Additive honesty: never imply Seatbelt/macOS child_net on Linux builds (ruling 246).
fn platform_honesty_notes() -> Vec<String> {
    #[cfg(target_os = "macos")]
    {
        vec![
            "Linux hz-sandbox-exec confinement is unavailable in macOS-target builds; never reported as enforced.".to_string(),
            "Seatbelt / macOS child_net backends are not implemented; never reported as enforced.".to_string(),
        ]
    }
    #[cfg(not(target_os = "macos"))]
    {
        vec![
            "macOS Seatbelt and macOS child_net confinement are unavailable on Linux builds; never reported as enforced.".to_string(),
        ]
    }
}

fn append_platform_notes(obj: &mut Value) {
    let notes = platform_honesty_notes();
    if notes.is_empty() {
        return;
    }
    obj.as_object_mut()
        .unwrap()
        .insert("platformNotes".to_string(), json!(notes));
}

/* -------------------------- capability detection --------------------------- */

/// The live, cached capability posture of the host this binary runs on. Each
/// field is decided at RUNTIME by a detector that FAILS CLOSED to "not usable"
/// on any error and NEVER panics. Cached once (`OnceLock`) so the probes run a
/// single time per process.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Capabilities {
    /// Kernel-enforced per-path FS confinement via Landlock. Usable ONLY when
    /// BOTH the `landlock_create_ruleset` syscall reports a usable ABI version
    /// AND `landlock` is in the active LSM list — a present syscall with NO
    /// active LSM is still NOT usable (the spike's decisive gate).
    pub landlock_fs: bool,
    /// `bwrap` (bubblewrap) is present on PATH. NOTE: presence alone does NOT
    /// imply kernel-enforced per-path FS confinement (that needs an FS-LSM
    /// backing); FS-via-bwrap without Landlock is best_effort at most.
    pub bwrap_present: bool,
    /// Unprivileged user namespaces work (`unshare -Ur` equivalent).
    pub userns: bool,
    /// seccomp ERRNO/KILL filtering is available (syscall-level confinement).
    pub seccomp: bool,
    /// rlimits are settable (resource bounds).
    pub rlimits: bool,
    /// Network namespaces are available (netns — network-off confinement).
    pub netns: bool,
}

impl Capabilities {
    /// The wire form (additive `hostCapabilities`): what the host OFFERS. Not a
    /// statement about what this kernel enforces.
    pub fn to_json(&self) -> Value {
        json!({
            "landlockFs": self.landlock_fs,
            "bwrapPresent": self.bwrap_present,
            "userns": self.userns,
            "seccomp": self.seccomp,
            "rlimits": self.rlimits,
            "netns": self.netns,
        })
    }
}

static CAPABILITIES: OnceLock<Capabilities> = OnceLock::new();

/// Detect the host capabilities once and cache. Every probe is fail-closed.
pub fn capabilities() -> &'static Capabilities {
    CAPABILITIES.get_or_init(detect_capabilities)
}

/// Run every detector. Pure composition of the isolated, fail-closed probes.
fn detect_capabilities() -> Capabilities {
    Capabilities {
        landlock_fs: detect_landlock_fs(),
        bwrap_present: detect_bwrap_present(),
        userns: detect_userns(),
        seccomp: detect_seccomp(),
        rlimits: detect_rlimits(),
        netns: detect_netns(),
    }
}

/// Landlock FS confinement is usable when the ABI probe succeeds AND a canary
/// `landlock_create_ruleset` can allocate a ruleset (closed immediately).
/// The LSM list (`/sys/kernel/security/lsm`) is corroboration when present, but
/// some hosts (notably current WSL2) omit that sysfs node while Landlock still
/// enforces path rules — the canary is the decisive gate. Fail-closed to `false`
/// on ANY error.
fn detect_landlock_fs() -> bool {
    landlock_abi_usable() && landlock_create_canary()
}

/// Canary: create an empty-ish ruleset and close it. Proves the LSM is active
/// even when `/sys/kernel/security/lsm` is absent.
#[cfg(target_arch = "x86_64")]
fn landlock_create_canary() -> bool {
    #[repr(C)]
    struct Attr {
        handled_access_fs: u64,
    }
    // Minimal handled set (read file) — enough to prove create works.
    let attr = Attr {
        handled_access_fs: 1 << 2,
    };
    let ret: i64;
    unsafe {
        std::arch::asm!(
            "syscall",
            inlateout("rax") SYS_LANDLOCK_CREATE_RULESET as i64 => ret,
            in("rdi") &attr as *const _ as u64,
            in("rsi") std::mem::size_of::<Attr>() as u64,
            in("rdx") 0u64,
            out("rcx") _,
            out("r11") _,
            options(nostack),
        );
    }
    if ret < 0 {
        return false;
    }
    unsafe {
        libc::close(ret as i32);
    }
    true
}

#[cfg(not(target_arch = "x86_64"))]
fn landlock_create_canary() -> bool {
    false
}

/// `true` when the active LSM list names `landlock`. Fail-closed: an absent or
/// unreadable list is `false` (the decisive gate, per `ops/landlock-probe.sh`).
fn lsm_list_contains_landlock() -> bool {
    match std::fs::read_to_string("/sys/kernel/security/lsm") {
        Ok(list) => list.split(',').any(|name| name.trim() == "landlock"),
        Err(_) => false,
    }
}

/// `LANDLOCK_CREATE_RULESET_VERSION` flag: ask for the supported ABI version
/// rather than creating a ruleset.
const LANDLOCK_CREATE_RULESET_VERSION: u64 = 1 << 0;

/// The `landlock_create_ruleset` syscall number on x86_64 (444). On any other
/// architecture we cannot make the raw syscall portably, so we fail closed.
#[cfg(target_arch = "x86_64")]
const SYS_LANDLOCK_CREATE_RULESET: u64 = 444;

/// `true` when the raw `landlock_create_ruleset` ABI probe returns a usable
/// version (>= 1). Fail-closed to `false` on `-ENOSYS`/any negative return and
/// on any non-x86_64 target (we never panic, never assume).
#[cfg(target_arch = "x86_64")]
fn landlock_abi_usable() -> bool {
    // landlock_create_ruleset(NULL, 0, LANDLOCK_CREATE_RULESET_VERSION) returns
    // the supported ABI version (>= 1) or -errno (e.g. -ENOSYS). A raw syscall
    // via inline asm keeps us dependency-free (no libc), matching the house
    // "std + raw syscall numbers / /proc inspection" style. SAFETY: the call
    // has no memory effects (NULL attr, size 0, the VERSION flag is read-only);
    // it only reads a kernel-reported integer.
    let ret: i64;
    unsafe {
        std::arch::asm!(
            "syscall",
            inlateout("rax") SYS_LANDLOCK_CREATE_RULESET as i64 => ret,
            in("rdi") 0u64,                               // attr = NULL
            in("rsi") 0u64,                               // size = 0
            in("rdx") LANDLOCK_CREATE_RULESET_VERSION,    // flags
            out("rcx") _,
            out("r11") _,
            options(nostack, preserves_flags),
        );
    }
    ret >= 1
}

#[cfg(not(target_arch = "x86_64"))]
fn landlock_abi_usable() -> bool {
    // No portable raw-syscall path off x86_64: fail closed.
    false
}

/// `true` when `bwrap` is found on PATH. Fail-closed: no PATH, or no executable
/// entry, is `false`. Presence is NOT FS enforcement (see `Capabilities`).
fn detect_bwrap_present() -> bool {
    find_on_path("bwrap").is_some()
}

/// Resolve an executable on `$PATH`, returning its full path if a regular file
/// with any execute bit exists. Fail-closed on any error.
fn find_on_path(program: &str) -> Option<std::path::PathBuf> {
    let path_var = std::env::var_os("PATH")?;
    for dir in std::env::split_paths(&path_var) {
        if dir.as_os_str().is_empty() {
            continue;
        }
        let candidate = dir.join(program);
        if is_executable_file(&candidate) {
            return Some(candidate);
        }
    }
    None
}

#[cfg(unix)]
fn is_executable_file(path: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    match std::fs::metadata(path) {
        Ok(meta) => meta.is_file() && (meta.permissions().mode() & 0o111) != 0,
        Err(_) => false,
    }
}

#[cfg(not(unix))]
fn is_executable_file(path: &Path) -> bool {
    std::fs::metadata(path).map(|m| m.is_file()).unwrap_or(false)
}

/// Unprivileged user namespaces: usable when the kernel exposes the knob
/// `/proc/sys/kernel/unprivileged_userns_clone` as `1`, OR (when that Debian-
/// specific knob is absent) `max_user_namespaces` is > 0 and the feature is
/// compiled in (`/proc/sys/user/max_user_namespaces`). Fail-closed: any read
/// error or a `0` is `false`.
fn detect_userns() -> bool {
    // The Debian/Ubuntu gate, when present, is authoritative.
    if let Ok(v) = std::fs::read_to_string("/proc/sys/kernel/unprivileged_userns_clone") {
        return v.trim() == "1";
    }
    // Otherwise the feature is on when the kernel permits any user namespaces.
    match std::fs::read_to_string("/proc/sys/user/max_user_namespaces") {
        Ok(v) => v.trim().parse::<u64>().map(|n| n > 0).unwrap_or(false),
        Err(_) => false,
    }
}

/// seccomp filtering: available when the kernel advertises `CONFIG_SECCOMP` via
/// the per-thread `Seccomp:` line in `/proc/self/status` (present on any kernel
/// with seccomp compiled in; the value is the current mode, 0 = disabled-but-
/// available). Fail-closed: no line / unreadable is `false`.
fn detect_seccomp() -> bool {
    match std::fs::read_to_string("/proc/self/status") {
        Ok(status) => status.lines().any(|l| l.starts_with("Seccomp:")),
        Err(_) => false,
    }
}

/// rlimits: resource limits are a POSIX baseline readable from
/// `/proc/self/limits`. Fail-closed: unreadable is `false`. (We report
/// `best_effort` for rlimits regardless — see `compose_report` — because a
/// limit bounds resources but is not a confinement boundary.)
fn detect_rlimits() -> bool {
    match std::fs::read_to_string("/proc/self/limits") {
        Ok(limits) => limits.contains("Max"),
        Err(_) => false,
    }
}

/// Network namespaces: available when the kernel exposes
/// `/proc/self/ns/net` AND unprivileged user namespaces work (a netns is
/// entered via a userns on an unprivileged host). Fail-closed on any error.
fn detect_netns() -> bool {
    Path::new("/proc/self/ns/net").exists() && detect_userns()
}

/* ------------------------------ exec canary -------------------------------- */

/// The live `hz-sandbox-exec -- /bin/true` posture. `probed=false` means no
/// canary could even be attempted (helper missing/disabled); `ok=false` means
/// the helper ran and refused or failed before exec. Neither is ever reported
/// as enforcement.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SandboxExecProbe {
    pub probed: bool,
    pub ok: bool,
    pub executable: Option<String>,
    /// `"off"` (netns requested) or `"on"` (no netns; never a network claim).
    pub child_net: String,
    /// True when WSL supplied `on` because nothing was requested.
    pub wsl_default_child_net: bool,
    pub exit_code: Option<i32>,
    pub timed_out: bool,
    pub reason: Option<String>,
    /// Visible host limitations (e.g. the WSL child-net default).
    pub notes: Vec<String>,
}

impl SandboxExecProbe {
    pub fn to_json(&self) -> Value {
        json!({
            "probed": self.probed,
            "ok": self.ok,
            "executable": self.executable,
            "childNet": self.child_net,
            "wslDefaultChildNet": self.wsl_default_child_net,
            "exitCode": self.exit_code,
            "timedOut": self.timed_out,
            "reason": self.reason,
            "notes": self.notes,
        })
    }
}

/// WSL kernels carry a `microsoft` marker in the osrelease/version string.
pub fn wsl_signature(text: &str) -> bool {
    text.to_ascii_lowercase().contains("microsoft")
}

/// True on a WSL host (`/proc/sys/kernel/osrelease` or `/proc/version`).
pub fn host_is_wsl() -> bool {
    ["/proc/sys/kernel/osrelease", "/proc/version"]
        .iter()
        .filter_map(|path| std::fs::read_to_string(path).ok())
        .any(|text| wsl_signature(&text))
}

/// Resolve the child-net mode: an explicit `off`/`on` wins; an absent value is
/// `on` on WSL (because `unshare(CLONE_NEWNET)` is not permitted there) and
/// `off` elsewhere. The bool is true only for the WSL default.
pub fn resolve_child_net(explicit: Option<&str>, wsl: bool) -> (String, bool) {
    match explicit.map(str::trim).filter(|value| !value.is_empty()) {
        Some(value) => {
            // Mirror hz-sandbox-exec: only the literal `on` disables isolation;
            // any other explicit value (including a typo) requests isolation and
            // must never silently become the WSL `on` default.
            let mode = if value.eq_ignore_ascii_case("on") {
                "on"
            } else {
                "off"
            };
            (mode.to_string(), false)
        }
        None => {
            if wsl {
                ("on".to_string(), true)
            } else {
                ("off".to_string(), false)
            }
        }
    }
}

fn child_net_notes(child_net: &str, wsl_default: bool) -> Vec<String> {
    if wsl_default {
        vec![
            "WSL detected: HZ_SANDBOX_CHILD_NET defaults to \"on\" for sandboxed children because unshare(CLONE_NEWNET) is not permitted on this host; network egress is NOT confined and the network dimension is not reported enforced.".to_string(),
        ]
    } else if child_net == "on" {
        vec![
            "HZ_SANDBOX_CHILD_NET=on: network egress is NOT confined and the network dimension is not reported enforced.".to_string(),
        ]
    } else {
        Vec::new()
    }
}

/// Resolve the helper the same way the app does: explicit override, then a
/// sibling of the running kernel binary, then PATH. Fail-closed: an override
/// that does not exist is not silently replaced.
pub fn resolve_sandbox_exec_binary() -> Option<PathBuf> {
    if let Ok(raw) = std::env::var("HZ_SANDBOX_EXEC_BIN") {
        let trimmed = raw.trim();
        if !trimmed.is_empty() {
            let path = PathBuf::from(trimmed);
            return is_executable_file(&path).then_some(path);
        }
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            let sibling = dir.join("hz-sandbox-exec");
            if is_executable_file(&sibling) {
                return Some(sibling);
            }
        }
    }
    find_on_path("hz-sandbox-exec")
}

fn tail_chars(text: &str, cap: usize) -> String {
    let count = text.chars().count();
    if count <= cap {
        return text.to_string();
    }
    text.chars().skip(count - cap).collect()
}

fn first_line(text: &str) -> String {
    text.lines()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .unwrap_or("")
        .chars()
        .take(400)
        .collect()
}

fn failed_probe(
    executable: Option<&Path>,
    child_net: &str,
    wsl_default: bool,
    notes: Vec<String>,
    probed: bool,
    reason: String,
) -> SandboxExecProbe {
    SandboxExecProbe {
        probed,
        ok: false,
        executable: executable.map(|p| p.display().to_string()),
        child_net: child_net.to_string(),
        wsl_default_child_net: wsl_default,
        exit_code: None,
        timed_out: false,
        reason: Some(reason),
        notes,
    }
}

/// Spawn the canary with the exact confinement environment the app passes to a
/// wrapped child (FS root/mode + child net; RO paths are empty here because the
/// kernel does not own a workspace fence). Bounded wait so `sandbox.report`
/// cannot hang on a stuck helper.
pub fn run_sandbox_exec_probe(
    binary: Option<&Path>,
    child_net: &str,
    wsl_default: bool,
    notes: Vec<String>,
) -> SandboxExecProbe {
    let Some(binary) = binary else {
        return failed_probe(
            None,
            child_net,
            wsl_default,
            notes,
            false,
            "hz-sandbox-exec was not found (build the kernel helper or set HZ_SANDBOX_EXEC_BIN)"
                .to_string(),
        );
    };

    let mut command = Command::new(binary);
    command.env_clear();
    if let Some(path) = std::env::var_os("PATH") {
        command.env("PATH", path);
    }
    command
        .env("HZ_SANDBOX_FS_ROOT", std::env::current_dir().unwrap_or_else(|_| PathBuf::from(".")))
        .env("HZ_SANDBOX_FS_MODE", "workspace-write")
        .env("HZ_SANDBOX_CHILD_NET", child_net)
        .arg("--")
        .arg("/bin/true")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped());

    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(err) => {
            return failed_probe(
                Some(binary),
                child_net,
                wsl_default,
                notes,
                false,
                format!("cannot start hz-sandbox-exec: {}", err),
            )
        }
    };

    let deadline = Instant::now() + Duration::from_secs(5);
    let mut timed_out = false;
    let mut wait_error: Option<String> = None;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break Some(status),
            Ok(None) => {
                if Instant::now() >= deadline {
                    timed_out = true;
                    let _ = child.kill();
                    let _ = child.wait();
                    break None;
                }
                std::thread::sleep(Duration::from_millis(20));
            }
            Err(err) => {
                wait_error = Some(err.to_string());
                let _ = child.kill();
                let _ = child.wait();
                break None;
            }
        }
    };

    let mut stderr = String::new();
    if let Some(mut pipe) = child.stderr.take() {
        let _ = pipe.read_to_string(&mut stderr);
    }
    let stderr = tail_chars(&stderr, 2_000);

    if timed_out {
        return SandboxExecProbe {
            probed: true,
            ok: false,
            executable: Some(binary.display().to_string()),
            child_net: child_net.to_string(),
            wsl_default_child_net: wsl_default,
            exit_code: None,
            timed_out: true,
            reason: Some("hz-sandbox-exec canary timed out after 5000ms".to_string()),
            notes,
        };
    }
    if let Some(err) = wait_error {
        return SandboxExecProbe {
            probed: true,
            ok: false,
            executable: Some(binary.display().to_string()),
            child_net: child_net.to_string(),
            wsl_default_child_net: wsl_default,
            exit_code: None,
            timed_out: false,
            reason: Some(format!("cannot wait for hz-sandbox-exec: {}", err)),
            notes,
        };
    }
    let exit_code = status.and_then(|status| status.code());
    let ok = status.map(|status| status.success()).unwrap_or(false);
    let reason = if ok {
        None
    } else {
        let detail = first_line(&stderr);
        Some(format!(
            "hz-sandbox-exec -- /bin/true failed (exit {}){}",
            exit_code
                .map(|code| code.to_string())
                .unwrap_or_else(|| "signal".to_string()),
            if detail.is_empty() { String::new() } else { format!(": {}", detail) }
        ))
    };
    SandboxExecProbe {
        probed: true,
        ok,
        executable: Some(binary.display().to_string()),
        child_net: child_net.to_string(),
        wsl_default_child_net: wsl_default,
        exit_code,
        timed_out: false,
        reason,
        notes,
    }
}

static SANDBOX_EXEC_PROBE: OnceLock<SandboxExecProbe> = OnceLock::new();

/// The process-wide live canary (once). `HZ_SANDBOX_EXEC=0` is explicit
/// "unconfined": the probe reports `probed:false` and nothing is enforced.
pub fn probe_sandbox_exec() -> &'static SandboxExecProbe {
    SANDBOX_EXEC_PROBE.get_or_init(|| {
        let wsl = host_is_wsl();
        let (child_net, wsl_default) =
            resolve_child_net(std::env::var("HZ_SANDBOX_CHILD_NET").ok().as_deref(), wsl);
        let notes = child_net_notes(&child_net, wsl_default);
        if std::env::var("HZ_SANDBOX_EXEC")
            .map(|value| value.trim() == "0")
            .unwrap_or(false)
        {
            return failed_probe(
                None,
                &child_net,
                wsl_default,
                notes,
                false,
                "HZ_SANDBOX_EXEC=0 disables sandbox wrapping".to_string(),
            );
        }
        let binary = resolve_sandbox_exec_binary();
        run_sandbox_exec_probe(binary.as_deref(), &child_net, wsl_default, notes)
    })
}

/* ----------------------------- mode composition ---------------------------- */

/// Which confinement mechanisms THIS KERNEL ACTUALLY APPLIED to a child. This is
/// deliberately separate from `Capabilities` (what the host OFFERS): a dimension
/// may be reported `enforced` ONLY when the host offers the mechanism AND a live
/// `hz-sandbox-exec` canary proves the helper applied it. Detection is not
/// enforcement, and a kernel report alone is not evidence.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AppliedMechanisms {
    /// A Landlock ruleset is applied to shell/code execution.
    pub filesystem: bool,
    /// A netns (or equivalent) is applied to shell/code execution.
    pub network: bool,
    /// A seccomp filter is applied to shell/code execution.
    pub process: bool,
    /// rlimits are applied to shell/code execution.
    pub resources: bool,
    /// Why network confinement was not applied even though the helper ran.
    pub network_disabled_reason: Option<String>,
    /// Why the live probe did not prove confinement (report diagnostic).
    pub probe_reason: Option<String>,
}

impl AppliedMechanisms {
    /// Nothing is applied.
    pub fn none() -> Self {
        AppliedMechanisms {
            filesystem: false,
            network: false,
            process: false,
            resources: false,
            network_disabled_reason: None,
            probe_reason: None,
        }
    }
}

/// Derive the applied set from a probe + host capabilities. A failed probe
/// applies NOTHING (fail closed). A passing probe with child net on applies
/// filesystem/process/resources but never network.
pub fn applied_from_probe(probe: &SandboxExecProbe, caps: &Capabilities) -> AppliedMechanisms {
    if !probe.probed || !probe.ok {
        return AppliedMechanisms {
            probe_reason: probe.reason.clone(),
            ..AppliedMechanisms::none()
        };
    }
    AppliedMechanisms {
        filesystem: caps.landlock_fs,
        network: caps.netns && probe.child_net == "off",
        process: caps.seccomp,
        resources: caps.rlimits,
        network_disabled_reason: if probe.child_net == "off" {
            None
        } else {
            Some(
                "network namespace isolation is disabled for sandboxed children (HZ_SANDBOX_CHILD_NET=on); egress is NOT confined"
                    .to_string(),
            )
        },
        probe_reason: None,
    }
}

/// What the reduced `hz-sandbox-exec` helper ACTUALLY applied on this host,
/// decided by the cached live canary. Never all-true by assumption.
pub fn kernel_applied_mechanisms() -> AppliedMechanisms {
    applied_from_probe(probe_sandbox_exec(), capabilities())
}

/// Compose a requested `SandboxMode` into an `EnforcementOutcome`, FAIL-CLOSED
/// (docs/11 S1-S9). Both inputs are PARAMETERS so the ladder is deterministic
/// and host-independent; only the outermost caller probes the live host
/// (`capabilities()`) and passes `kernel_applied_mechanisms()`.
///
///   - `read-only` / `workspace-write` REQUIRE FS confinement that is both
///     available on the host AND applied by this kernel. Otherwise the result is
///     `SANDBOX_UNAVAILABLE` (never a silent `enforced`, never silently
///     unconfined). A Landlock-capable host is reported the same fail-closed way
///     while the kernel applies no ruleset; the reason says the capability is
///     available but not applied.
///   - `danger-full-access` reports NO dimension enforced (S4).
///
/// Set `demand_full = true` (the default for an FS-confined mode) to get the
/// `SANDBOX_UNAVAILABLE` fail. A caller that can tolerate a partial boundary may
/// pass `demand_full = false` to instead receive an `EnforcementReport` with
/// `completeness = partial`, the FS dimension `unsupported`, a NON-EMPTY
/// residual, and an explicit backend/`none` (S2/S5).
pub fn enforce(
    mode: SandboxMode,
    caps: &Capabilities,
    applied: &AppliedMechanisms,
    demand_full: bool,
) -> EnforcementOutcome {
    match mode {
        SandboxMode::DangerFullAccess => danger_full_access_report(caps),
        SandboxMode::ReadOnly | SandboxMode::WorkspaceWrite => {
            confined_outcome(mode, caps, applied, demand_full)
        }
    }
}

/// `danger-full-access`: NO dimension enforced (S4). Every dimension is
/// `unsupported` with a residual naming that nothing confines this mode, backend
/// `none`. Completeness is `partial` (nothing is fully enforced).
fn danger_full_access_report(caps: &Capabilities) -> EnforcementOutcome {
    let residual = "danger-full-access runs with the user's ambient authority; no dimension is confined (docs/11 S4)".to_string();
    let dim = |name: &str, available: bool| DimensionReport {
        dimension: name.to_string(),
        guarantee: Guarantee::Unsupported,
        backend: "none".to_string(),
        residual: residual.clone(),
        available,
    };
    let dims = vec![
        dim("filesystem", caps.landlock_fs),
        dim("network", caps.netns),
        dim("process", caps.seccomp),
    ];
    EnforcementOutcome::Report(EnforcementReport {
        mode: SandboxMode::DangerFullAccess,
        completeness: EnforcementCompleteness::Partial,
        dimensions: dims,
        backend: "none".to_string(),
        unavailable_reason: None,
        host_capabilities: caps.clone(),
    })
}

/// Compose an FS-confined mode (`read-only`/`workspace-write`). FS confinement
/// is the REQUIRED dimension: it must be available AND applied.
fn confined_outcome(
    mode: SandboxMode,
    caps: &Capabilities,
    applied: &AppliedMechanisms,
    demand_full: bool,
) -> EnforcementOutcome {
    if !(caps.landlock_fs && applied.filesystem) {
        let backend_note = fs_unmet_note(caps, applied);
        let reason = format!(
            "SANDBOX_UNAVAILABLE: {} mode requires kernel-enforced per-path FS confinement, which is not enforced here ({}); failing closed rather than running unconfined (docs/11 S1/S4)",
            mode.as_str(),
            backend_note
        );
        if demand_full {
            // The explicit, documented fail-closed choice: fail when the mode
            // requires the missing dimension.
            return EnforcementOutcome::Unavailable {
                mode,
                reason,
                host_capabilities: caps.clone(),
            };
        }
        // Tolerant caller: a PARTIAL report with the FS dimension unsupported +
        // a non-empty residual + an explicit backend/'none' (never 'enforced').
        return EnforcementOutcome::Report(partial_confined_report(mode, caps, applied, reason));
    }

    // Reachable only when the host offers Landlock AND the live
    // `hz-sandbox-exec` canary proved this kernel applies a ruleset.
    EnforcementOutcome::Report(full_confined_report(mode, caps, applied))
}

/// Why FS confinement is not enforced, in plain words.
fn fs_unmet_note(caps: &Capabilities, applied: &AppliedMechanisms) -> String {
    let mut note = if caps.landlock_fs && !applied.filesystem {
        "Landlock is available on this host but this kernel does not apply a ruleset to executed processes yet".to_string()
    } else if caps.bwrap_present {
        "bwrap present but no FS-LSM backing (Landlock inactive), and this kernel applies no FS confinement".to_string()
    } else {
        "no Landlock/bwrap FS backend, and this kernel applies no FS confinement".to_string()
    };
    if let Some(reason) = &applied.probe_reason {
        note = format!("{}; live sandbox canary: {}", note, reason);
    }
    note
}

/// The filesystem dimension: `enforced` only when available AND applied.
fn filesystem_dimension(
    caps: &Capabilities,
    applied: &AppliedMechanisms,
    fs_residual: String,
) -> DimensionReport {
    if caps.landlock_fs && applied.filesystem {
        DimensionReport {
            dimension: "filesystem".to_string(),
            guarantee: Guarantee::Enforced,
            backend: "landlock".to_string(),
            residual: String::new(),
            available: true,
        }
    } else {
        DimensionReport {
            dimension: "filesystem".to_string(),
            guarantee: Guarantee::Unsupported,
            backend: "none".to_string(),
            residual: fs_residual,
            available: caps.landlock_fs,
        }
    }
}

/// The PARTIAL report for an FS-confined mode when FS confinement is NOT
/// enforced: FS `unsupported` (residual + backend `none`) and every other
/// dimension reported by the same available-AND-applied rule.
fn partial_confined_report(
    mode: SandboxMode,
    caps: &Capabilities,
    applied: &AppliedMechanisms,
    fs_residual: String,
) -> EnforcementReport {
    let dims = vec![
        filesystem_dimension(caps, applied, fs_residual),
        network_dimension(caps, applied),
        process_dimension(caps, applied),
        rlimits_dimension(caps, applied),
    ];
    EnforcementReport {
        mode,
        completeness: EnforcementCompleteness::Partial,
        dimensions: dims,
        // The primary confinement backend is FS; it is not enforced -> 'none'.
        backend: "none".to_string(),
        unavailable_reason: Some(
            "filesystem confinement is not enforced (the kernel applies no confinement mechanism); this report is partial"
                .to_string(),
        ),
        host_capabilities: caps.clone(),
    }
}

/// The FULL report for an FS-confined mode when FS confinement IS available and
/// the live exec canary proved it is applied.
fn full_confined_report(
    mode: SandboxMode,
    caps: &Capabilities,
    applied: &AppliedMechanisms,
) -> EnforcementReport {
    let dims = vec![
        filesystem_dimension(caps, applied, String::new()),
        network_dimension(caps, applied),
        process_dimension(caps, applied),
        rlimits_dimension(caps, applied),
    ];
    let completeness = if dims.iter().all(|d| d.guarantee == Guarantee::Enforced) {
        EnforcementCompleteness::Full
    } else {
        EnforcementCompleteness::Partial
    };
    EnforcementReport {
        mode,
        completeness,
        dimensions: dims,
        backend: "landlock".to_string(),
        unavailable_reason: None,
        host_capabilities: caps.clone(),
    }
}

/// Residual for a mechanism that is not enforced: says whether the host offers
/// it (so "available but not applied" is never confused with "unavailable").
fn unmet_residual(available: bool, what: &str, mechanism: &str) -> String {
    if available {
        format!(
            "{}: available on this host but this kernel does not apply it yet; {} not confined at the OS layer",
            mechanism, what
        )
    } else {
        format!("{}: unavailable on this host and not applied; {} not confined at the OS layer", mechanism, what)
    }
}

/// The network dimension: `enforced` via `netns` only when available AND
/// applied, else `unsupported` with a residual + backend `none`.
fn network_dimension(caps: &Capabilities, applied: &AppliedMechanisms) -> DimensionReport {
    if caps.netns && applied.network {
        DimensionReport {
            dimension: "network".to_string(),
            guarantee: Guarantee::Enforced,
            backend: "netns".to_string(),
            residual: String::new(),
            available: true,
        }
    } else {
        DimensionReport {
            dimension: "network".to_string(),
            guarantee: Guarantee::Unsupported,
            backend: "none".to_string(),
            residual: applied
                .network_disabled_reason
                .clone()
                .unwrap_or_else(|| unmet_residual(caps.netns, "egress", "network namespaces")),
            available: caps.netns,
        }
    }
}

/// The process (syscall) dimension: `enforced` via `seccomp` only when available
/// AND applied, else `unsupported` with a residual + backend `none`.
fn process_dimension(caps: &Capabilities, applied: &AppliedMechanisms) -> DimensionReport {
    if caps.seccomp && applied.process {
        DimensionReport {
            dimension: "process".to_string(),
            guarantee: Guarantee::Enforced,
            backend: "seccomp".to_string(),
            residual: String::new(),
            available: true,
        }
    } else {
        DimensionReport {
            dimension: "process".to_string(),
            guarantee: Guarantee::Unsupported,
            backend: "none".to_string(),
            residual: unmet_residual(caps.seccomp, "syscalls", "seccomp"),
            available: caps.seccomp,
        }
    }
}

/// The resource (rlimits) dimension: `best_effort` only when rlimits are
/// available AND applied (a limit bounds resources but is not a hard boundary,
/// so never `enforced`), else `unsupported`. A below-`enforced` guarantee always
/// carries a non-empty residual (S2).
fn rlimits_dimension(caps: &Capabilities, applied: &AppliedMechanisms) -> DimensionReport {
    if caps.rlimits && applied.resources {
        DimensionReport {
            dimension: "resources".to_string(),
            guarantee: Guarantee::BestEffort,
            backend: "rlimits".to_string(),
            residual: "rlimits bound resources but are not a confinement boundary (best effort)".to_string(),
            available: true,
        }
    } else {
        DimensionReport {
            dimension: "resources".to_string(),
            guarantee: Guarantee::Unsupported,
            backend: "none".to_string(),
            residual: unmet_residual(caps.rlimits, "resource use", "rlimits"),
            available: caps.rlimits,
        }
    }
}

/* ----------------------------------- tests ---------------------------------- */

#[cfg(test)]
mod tests {
    use super::*;

    /* --- the pure ladder/contract --- */

    #[test]
    fn wider_modes_are_strictly_wider() {
        // read-only -> [workspace-write, danger-full-access]
        assert_eq!(
            SandboxMode::ReadOnly.wider_modes(),
            &[SandboxMode::WorkspaceWrite, SandboxMode::DangerFullAccess]
        );
        // workspace-write -> [danger-full-access]
        assert_eq!(
            SandboxMode::WorkspaceWrite.wider_modes(),
            &[SandboxMode::DangerFullAccess]
        );
        // danger-full-access -> [] (the ceiling; nothing is wider)
        assert!(SandboxMode::DangerFullAccess.wider_modes().is_empty());

        // read-only is the floor: nothing escalates TO it.
        assert!(!SandboxMode::WorkspaceWrite.is_strictly_wider(SandboxMode::ReadOnly));
        assert!(!SandboxMode::DangerFullAccess.is_strictly_wider(SandboxMode::ReadOnly));
        assert!(!ESCALATION_TARGETS.contains(&SandboxMode::ReadOnly));
        assert_eq!(
            ESCALATION_TARGETS,
            &[SandboxMode::WorkspaceWrite, SandboxMode::DangerFullAccess]
        );

        // a mode is never strictly wider than itself.
        for m in [
            SandboxMode::ReadOnly,
            SandboxMode::WorkspaceWrite,
            SandboxMode::DangerFullAccess,
        ] {
            assert!(!m.is_strictly_wider(m));
        }
    }

    #[test]
    fn markers_are_byte_exact() {
        // Pin the model-facing strings byte-for-byte (dsh escalation.ts).
        assert_eq!(
            sandbox_denial_marker(SandboxMode::ReadOnly),
            "[sandbox: file access denied under read-only mode]"
        );
        assert_eq!(
            sandbox_denial_marker(SandboxMode::WorkspaceWrite),
            "[sandbox: file access denied under workspace-write mode]"
        );
        // The hint line separates "available" from "retry" with an EM DASH.
        let hint = escalation_hint_marker("tool call");
        assert_eq!(
            hint,
            "[sandbox: escalation available \u{2014} retry this exact tool call once with sandbox_permissions (the narrowest wider mode that suffices) + justification; the approval prompt asks the user]"
        );
        // The separator is literally U+2014 (em dash), not a hyphen or " - ".
        assert!(hint.contains('\u{2014}'));
        assert!(!hint.contains(" - retry"));
    }

    #[test]
    fn validate_escalation_args_requires_the_pair() {
        // both present + non-empty justification -> ok
        let ok = validate_escalation_args(Some(SandboxMode::WorkspaceWrite), Some("need to write"));
        assert_eq!(
            ok,
            Ok(EscalationArgs {
                sandbox_permissions: SandboxMode::WorkspaceWrite,
                justification: "need to write".to_string(),
            })
        );
        // lone sandbox_permissions -> refused before execution
        assert!(matches!(
            validate_escalation_args(Some(SandboxMode::WorkspaceWrite), None),
            Err(EscalationError::Args(_))
        ));
        // lone justification -> refused
        assert!(matches!(
            validate_escalation_args(None, Some("please")),
            Err(EscalationError::Args(_))
        ));
        // empty / blank justification with permissions -> refused
        assert!(matches!(
            validate_escalation_args(Some(SandboxMode::WorkspaceWrite), Some("")),
            Err(EscalationError::Args(_))
        ));
        assert!(matches!(
            validate_escalation_args(Some(SandboxMode::WorkspaceWrite), Some("   ")),
            Err(EscalationError::Args(_))
        ));
        // neither -> refused
        assert!(matches!(
            validate_escalation_args(None, None),
            Err(EscalationError::Args(_))
        ));
    }

    fn req(
        effective: SandboxMode,
        target: SandboxMode,
        has_approver: bool,
        approval: ApprovalOutcome,
    ) -> EscalationRequest {
        EscalationRequest {
            effective,
            args: EscalationArgs {
                sandbox_permissions: target,
                justification: "because".to_string(),
            },
            has_approver,
            approval,
        }
    }

    #[test]
    fn approve_escalation_same_mode_needs_no_approval() {
        // Repeating the effective mode: no approver, no grant needed.
        let r = req(
            SandboxMode::ReadOnly,
            SandboxMode::ReadOnly,
            false,
            ApprovalOutcome::Unavailable,
        );
        assert_eq!(approve_escalation(&r), Ok(SandboxMode::ReadOnly));
    }

    #[test]
    fn approve_escalation_strictly_wider_is_one_shot_with_approval() {
        // read-only -> workspace-write with a grant: admits, one call only.
        let r = req(
            SandboxMode::ReadOnly,
            SandboxMode::WorkspaceWrite,
            true,
            ApprovalOutcome::Granted,
        );
        assert_eq!(approve_escalation(&r), Ok(SandboxMode::WorkspaceWrite));
    }

    #[test]
    fn approve_escalation_throws_before_execution() {
        // narrower target (workspace-write -> read-only): not wider -> throw
        let narrower = req(
            SandboxMode::WorkspaceWrite,
            SandboxMode::ReadOnly,
            true,
            ApprovalOutcome::Granted,
        );
        assert!(matches!(
            approve_escalation(&narrower),
            Err(EscalationError::NotWider { .. })
        ));

        // strictly wider but no approver -> throw
        let no_approver = req(
            SandboxMode::ReadOnly,
            SandboxMode::DangerFullAccess,
            false,
            ApprovalOutcome::Granted,
        );
        assert!(matches!(
            approve_escalation(&no_approver),
            Err(EscalationError::MissingApprover)
        ));

        // strictly wider, approver present, but a non-grant outcome -> throw
        for outcome in [
            ApprovalOutcome::Rejected,
            ApprovalOutcome::Cancelled,
            ApprovalOutcome::Unavailable,
        ] {
            let r = req(
                SandboxMode::ReadOnly,
                SandboxMode::WorkspaceWrite,
                true,
                outcome,
            );
            assert!(matches!(
                approve_escalation(&r),
                Err(EscalationError::NotGranted(_))
            ));
        }
    }

    /* --- capability detection + mode composition --- */

    /// Synthetic capability sets: the ladder tests never read the live host.
    fn caps_none() -> Capabilities {
        Capabilities {
            landlock_fs: false,
            bwrap_present: false,
            userns: false,
            seccomp: false,
            rlimits: false,
            netns: false,
        }
    }

    fn caps_all() -> Capabilities {
        Capabilities {
            landlock_fs: true,
            bwrap_present: true,
            userns: true,
            seccomp: true,
            rlimits: true,
            netns: true,
        }
    }

    fn all_applied() -> AppliedMechanisms {
        AppliedMechanisms {
            filesystem: true,
            network: true,
            process: true,
            resources: true,
            network_disabled_reason: None,
            probe_reason: None,
        }
    }

    #[test]
    fn capability_detection_never_panics() {
        // Every detector must return cleanly and never panic. The VALUES are
        // host-dependent and deliberately NOT asserted.
        let caps = detect_capabilities();
        // Caching returns the same posture.
        assert_eq!(capabilities(), capabilities());
        // Detection is internally consistent: ABI + create canary.
        if caps.landlock_fs {
            assert!(landlock_abi_usable() && landlock_create_canary());
        }
    }

    #[test]
    fn kernel_applied_matches_hzsandbox_exec() {
        // The live applied set is probe-derived: nothing is claimed when the
        // canary did not prove confinement, and network is never claimed with
        // child net `on` (the WSL default).
        let probe = probe_sandbox_exec();
        let applied = kernel_applied_mechanisms();
        if !probe.ok {
            assert!(!applied.filesystem);
            assert!(!applied.network);
            assert!(!applied.process);
            assert!(!applied.resources);
        } else {
            assert_eq!(applied.filesystem, capabilities().landlock_fs);
            assert_eq!(applied.process, capabilities().seccomp);
            assert_eq!(applied.resources, capabilities().rlimits);
            assert_eq!(applied.network, capabilities().netns && probe.child_net == "off");
        }
    }

    #[test]
    fn applied_from_probe_never_claims_without_a_passing_probe() {
        let caps = caps_all();
        let failed = SandboxExecProbe {
            probed: false,
            ok: false,
            executable: None,
            child_net: "off".to_string(),
            wsl_default_child_net: false,
            exit_code: None,
            timed_out: false,
            reason: Some("helper missing".to_string()),
            notes: Vec::new(),
        };
        let applied = applied_from_probe(&failed, &caps);
        assert!(!applied.filesystem);
        assert!(!applied.network);
        assert!(!applied.process);
        assert!(!applied.resources);
        assert_eq!(applied.probe_reason.as_deref(), Some("helper missing"));

        let wsl_ok = SandboxExecProbe {
            probed: true,
            ok: true,
            executable: Some("/x/hz-sandbox-exec".to_string()),
            child_net: "on".to_string(),
            wsl_default_child_net: true,
            exit_code: Some(0),
            timed_out: false,
            reason: None,
            notes: vec!["wsl".to_string()],
        };
        let applied = applied_from_probe(&wsl_ok, &caps);
        assert!(applied.filesystem);
        assert!(applied.process);
        assert!(applied.resources);
        assert!(!applied.network, "child net on must never claim network enforcement");
        assert!(applied.network_disabled_reason.is_some());
        // And the composed report is honest about it.
        let report = match enforce(
            SandboxMode::WorkspaceWrite,
            &caps,
            &applied_from_probe(&wsl_ok, &caps),
            true,
        ) {
            EnforcementOutcome::Report(report) => report,
            other => panic!("expected a partial report, got {:?}", other),
        };
        let network = report
            .dimensions
            .iter()
            .find(|d| d.dimension == "network")
            .unwrap();
        assert_eq!(network.guarantee, Guarantee::Unsupported);
        assert!(network.residual.contains("HZ_SANDBOX_CHILD_NET=on"));

        let off_ok = SandboxExecProbe {
            child_net: "off".to_string(),
            wsl_default_child_net: false,
            ..wsl_ok
        };
        let applied = applied_from_probe(&off_ok, &caps);
        assert!(applied.network);
        assert!(applied.network_disabled_reason.is_none());
    }

    #[test]
    fn wsl_signature_and_child_net_default_are_truthful() {
        assert!(wsl_signature("5.15.153.1-microsoft-standard-WSL2"));
        assert!(wsl_signature("Linux version ... (Microsoft@...)")); // case-insensitive
        assert!(!wsl_signature("6.8.0-generic"));

        assert_eq!(resolve_child_net(None, false), ("off".to_string(), false));
        assert_eq!(resolve_child_net(None, true), ("on".to_string(), true));
        assert_eq!(resolve_child_net(Some("off"), true), ("off".to_string(), false));
        assert_eq!(resolve_child_net(Some("ON"), false), ("on".to_string(), false));
        // A typo requests isolation (same fail-closed reading as the helper), so
        // it can never silently become the WSL `on` default.
        assert_eq!(resolve_child_net(Some("maybe"), true), ("off".to_string(), false));
        assert_eq!(resolve_child_net(Some("  "), true), ("on".to_string(), true));
    }

    #[test]
    fn exec_probe_plumbing_reports_success_and_failure_not_silence() {
        use std::io::Write as _;
        use std::os::unix::fs::PermissionsExt;

        let dir = std::env::temp_dir().join(format!("hz-probe-unit-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();

        let ok_bin = dir.join("ok.sh");
        std::fs::write(&ok_bin, "#!/bin/sh\nexit 0\n").unwrap();
        std::fs::set_permissions(&ok_bin, std::fs::Permissions::from_mode(0o755)).unwrap();
        let ok = run_sandbox_exec_probe(Some(&ok_bin), "off", false, Vec::new());
        assert!(ok.probed && ok.ok, "{:?}", ok);
        assert_eq!(ok.exit_code, Some(0));

        let fail_bin = dir.join("fail.sh");
        let mut f = std::fs::File::create(&fail_bin).unwrap();
        writeln!(f, "#!/bin/sh").unwrap();
        writeln!(f, "echo 'exec /bin/true: Operation not permitted' >&2").unwrap();
        writeln!(f, "exit 1").unwrap();
        drop(f);
        std::fs::set_permissions(&fail_bin, std::fs::Permissions::from_mode(0o755)).unwrap();
        let failed = run_sandbox_exec_probe(Some(&fail_bin), "off", false, Vec::new());
        assert!(failed.probed && !failed.ok, "{:?}", failed);
        assert_eq!(failed.exit_code, Some(1));
        assert!(failed
            .reason
            .as_deref()
            .unwrap_or("")
            .contains("Operation not permitted"));

        let missing = run_sandbox_exec_probe(None, "off", false, Vec::new());
        assert!(!missing.probed && !missing.ok);
        assert!(missing.reason.unwrap().contains("not found"));

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn fs_confined_modes_fail_closed_without_landlock_or_succeed_when_applied() {
        let applied = all_applied();
        for mode in [SandboxMode::ReadOnly, SandboxMode::WorkspaceWrite] {
            match enforce(mode, &caps_none(), &applied, true) {
                EnforcementOutcome::Unavailable { mode: m, reason, host_capabilities } => {
                    assert_eq!(m, mode);
                    assert!(reason.contains("SANDBOX_UNAVAILABLE"));
                    assert_eq!(host_capabilities, caps_none());
                }
                other => panic!("expected SANDBOX_UNAVAILABLE without Landlock, got {:?}", other),
            }
            match enforce(mode, &caps_all(), &applied, true) {
                EnforcementOutcome::Report(report) => {
                    assert_eq!(report.backend, "landlock");
                    let fs = report.dimensions.iter().find(|d| d.dimension == "filesystem").unwrap();
                    assert_eq!(fs.guarantee, Guarantee::Enforced);
                }
                other => panic!("expected full report when Landlock available+applied, got {:?}", other),
            }
        }
    }

    #[test]
    fn partial_report_honest_for_hzsandbox_exec_backend() {
        let applied = all_applied();
        // Without Landlock: allowPartial yields a PARTIAL report (FS unsupported).
        let report = match enforce(SandboxMode::WorkspaceWrite, &caps_none(), &applied, false) {
            EnforcementOutcome::Report(r) => r,
            other => panic!("expected a partial report, got {:?}", other),
        };
        assert_eq!(report.completeness, EnforcementCompleteness::Partial);
        assert_eq!(report.backend, "none");
        let fs = report.dimensions.iter().find(|d| d.dimension == "filesystem").unwrap();
        assert_eq!(fs.guarantee, Guarantee::Unsupported);
        assert!(!fs.residual.is_empty(), "FS residual must be non-empty (S2)");

        // With Landlock available+applied: FS-confined mode is a landlock report.
        let report = match enforce(SandboxMode::WorkspaceWrite, &caps_all(), &applied, false) {
            EnforcementOutcome::Report(r) => r,
            other => panic!("expected a landlock report, got {:?}", other),
        };
        assert_eq!(report.backend, "landlock");
        let fs = report.dimensions.iter().find(|d| d.dimension == "filesystem").unwrap();
        assert_eq!(fs.guarantee, Guarantee::Enforced);
        assert_eq!(fs.backend, "landlock");
        let process = report.dimensions.iter().find(|d| d.dimension == "process").unwrap();
        assert_eq!(process.guarantee, Guarantee::Enforced);
        let network = report.dimensions.iter().find(|d| d.dimension == "network").unwrap();
        assert_eq!(network.guarantee, Guarantee::Enforced);
        let resources = report.dimensions.iter().find(|d| d.dimension == "resources").unwrap();
        assert_eq!(resources.guarantee, Guarantee::BestEffort);
    }

    #[test]
    fn enforced_requires_both_available_and_applied() {
        // The seam for a future backend: only available AND applied is enforced.
        let report = match enforce(SandboxMode::ReadOnly, &caps_all(), &all_applied(), true) {
            EnforcementOutcome::Report(r) => r,
            other => panic!("expected a full report, got {:?}", other),
        };
        assert_eq!(report.backend, "landlock");
        for d in &report.dimensions {
            if d.dimension == "resources" {
                assert_eq!(d.guarantee, Guarantee::BestEffort);
            } else {
                assert_eq!(d.guarantee, Guarantee::Enforced, "{}", d.dimension);
            }
        }
        // Applied but not available -> not enforced, fail closed.
        assert!(matches!(
            enforce(SandboxMode::ReadOnly, &caps_none(), &all_applied(), true),
            EnforcementOutcome::Unavailable { .. }
        ));
    }

    #[test]
    fn platform_notes_on_wire_never_claim_macos_enforced() {
        let report = match enforce(SandboxMode::DangerFullAccess, &caps_none(), &all_applied(), true) {
            EnforcementOutcome::Report(r) => r,
            other => panic!("expected a report, got {:?}", other),
        };
        let json = EnforcementOutcome::Report(report).to_json();
        let notes = json["platformNotes"].as_array().expect("platformNotes");
        assert!(
            notes.iter().any(|n| n.as_str().unwrap_or("").contains("Seatbelt")),
            "{}",
            json
        );
        let joined = notes
            .iter()
            .filter_map(|v| v.as_str())
            .collect::<Vec<_>>()
            .join(" ");
        assert!(
            !joined.contains("is enforced"),
            "platformNotes must not claim enforcement: {}",
            joined
        );
    }

    #[test]
    fn danger_full_access_reports_no_enforced_dimension() {
        for caps in [caps_none(), caps_all()] {
            let report = match enforce(SandboxMode::DangerFullAccess, &caps, &all_applied(), true) {
                EnforcementOutcome::Report(r) => r,
                other => panic!("expected a report, got {:?}", other),
            };
            assert!(
                report.has_no_enforced_dimension(),
                "danger-full-access must report NO enforced dimension (S4)"
            );
            assert_eq!(report.backend, "none");
            for d in &report.dimensions {
                assert_eq!(d.guarantee, Guarantee::Unsupported);
                assert!(!d.residual.is_empty());
            }
        }
    }

    #[test]
    fn outcome_json_is_stable_and_typed() {
        let applied = all_applied();
        let unavail = enforce(SandboxMode::ReadOnly, &caps_none(), &applied, true).to_json();
        assert_eq!(unavail["status"], json!("sandbox_unavailable"));
        assert_eq!(unavail["mode"], json!("read-only"));
        assert!(unavail["reason"].as_str().unwrap().contains("SANDBOX_UNAVAILABLE"));
        assert_eq!(unavail["hostCapabilities"]["landlockFs"], json!(false));

        let confined = enforce(SandboxMode::ReadOnly, &caps_all(), &applied, true).to_json();
        assert_eq!(confined["status"], json!("report"));
        assert_eq!(confined["backend"], json!("landlock"));

        let report = enforce(SandboxMode::DangerFullAccess, &caps_all(), &applied, true).to_json();
        assert_eq!(report["status"], json!("report"));
        assert_eq!(report["mode"], json!("danger-full-access"));
        assert_eq!(report["completeness"], json!("partial"));
        assert!(report["dimensions"].is_array());
        assert_eq!(report["hostCapabilities"]["netns"], json!(true));
        assert_eq!(report["dimensions"][0]["available"], json!(true));
    }
}
