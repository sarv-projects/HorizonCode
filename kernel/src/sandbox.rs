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
//! and `workspace-write` REQUIRE kernel-enforced per-path FS confinement. On
//! both host classes we target (the gVisor `4.19.0-gvisor` deployment kernel of
//! the landlock spike AND this build host, Linux 6.1.189-amzn2023), there is NO
//! active FS-LSM: the spike's gVisor reports Landlock ENOSYS with no LSM list;
//! this host has the `landlock_create_ruleset` symbol but NO
//! `/sys/kernel/security/lsm` list, so Landlock FS confinement is NOT usable
//! (the probe `ops/landlock-probe.sh` decides on the LSM list, not the syscall
//! alone). bubblewrap exists here (`/usr/bin/bwrap`, 0.12.0) but without an
//! FS-LSM backing the bwrap binary cannot by itself provide kernel-enforced
//! per-path FS confinement, so FS-via-bwrap is reported `best_effort`/
//! `unsupported` with a residual — NEVER `enforced`. Therefore a request for a
//! mode that DEMANDS FS enforcement yields `SANDBOX_UNAVAILABLE` (the explicit,
//! documented fail-closed choice — "fail when the mode requires the missing
//! dimension"). The mechanisms that DO work here (seccomp ERRNO/KILL, rlimits,
//! netns for the process/network dimensions) are reported `enforced`/
//! `best_effort` with evidence. `danger-full-access` reports NO dimension
//! enforced (S4).
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
// header and docs/28 ruling 42): the kernel reports the fail-closed posture
// over `sandbox.report` today, the one-shot widen wires later. They are
// exercised by the `#[cfg(test)]` suite below; `allow(dead_code)` documents
// that they are contract-and-data now, wiring later, rather than accidentally
// unused — matching `egress.rs`.
#![allow(dead_code)]

use std::path::Path;
use std::sync::OnceLock;

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
}

impl DimensionReport {
    fn to_json(&self) -> Value {
        json!({
            "dimension": self.dimension,
            "guarantee": self.guarantee.as_str(),
            "backend": self.backend,
            "residual": self.residual,
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
            EnforcementOutcome::Unavailable { mode, reason } => json!({
                "status": "sandbox_unavailable",
                "mode": mode.as_str(),
                "reason": reason,
            }),
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
        });
        if let Some(reason) = &self.unavailable_reason {
            obj.as_object_mut()
                .unwrap()
                .insert("unavailableReason".to_string(), json!(reason));
        }
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

/// Landlock FS confinement is usable ONLY when BOTH signals agree:
///   (1) the raw `landlock_create_ruleset(NULL, 0, LANDLOCK_CREATE_RULESET_VERSION)`
///       syscall returns a usable ABI version (>= 1), not `-ENOSYS`; AND
///   (2) `landlock` appears in the active LSM list (`/sys/kernel/security/lsm`).
/// A present syscall with NO active LSM is still unsupported (exactly the
/// posture this build host shows: the symbol exists but the LSM list is absent).
/// Fail-closed to `false` on ANY error.
fn detect_landlock_fs() -> bool {
    landlock_abi_usable() && lsm_list_contains_landlock()
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

/* ----------------------------- mode composition ---------------------------- */

/// Compose a requested `SandboxMode` into an `EnforcementOutcome` against the
/// LIVE host capabilities, FAIL-CLOSED (docs/11 S1-S9):
///
///   - `read-only` / `workspace-write` REQUIRE FS confinement. If Landlock FS
///     is not usable (both host classes), the FS dimension cannot be enforced,
///     so we return `SANDBOX_UNAVAILABLE` (the explicit fail-closed choice:
///     "fail when the mode requires the missing dimension" — NEVER a silent
///     `enforced`, NEVER silently unconfined).
///   - `danger-full-access` reports NO dimension enforced (S4): it is
///     deliberately the user's ambient authority.
///
/// Set `demand_full = true` (the default for an FS-confined mode) to get the
/// `SANDBOX_UNAVAILABLE` fail. A caller that can tolerate a partial boundary may
/// pass `demand_full = false` to instead receive an `EnforcementReport` with
/// `completeness = partial`, the FS dimension `unsupported`, a NON-EMPTY
/// residual, and an explicit backend/`none` (S2/S5).
pub fn enforce(mode: SandboxMode, caps: &Capabilities, demand_full: bool) -> EnforcementOutcome {
    match mode {
        SandboxMode::DangerFullAccess => danger_full_access_report(),
        SandboxMode::ReadOnly | SandboxMode::WorkspaceWrite => {
            confined_outcome(mode, caps, demand_full)
        }
    }
}

/// `danger-full-access`: NO dimension enforced (S4). Every dimension is
/// `unsupported` with a residual naming that nothing confines this mode, backend
/// `none`. Completeness is `partial` (nothing is fully enforced).
fn danger_full_access_report() -> EnforcementOutcome {
    let residual = "danger-full-access runs with the user's ambient authority; no dimension is confined (docs/11 S4)".to_string();
    let dims = vec![
        DimensionReport {
            dimension: "filesystem".to_string(),
            guarantee: Guarantee::Unsupported,
            backend: "none".to_string(),
            residual: residual.clone(),
        },
        DimensionReport {
            dimension: "network".to_string(),
            guarantee: Guarantee::Unsupported,
            backend: "none".to_string(),
            residual: residual.clone(),
        },
        DimensionReport {
            dimension: "process".to_string(),
            guarantee: Guarantee::Unsupported,
            backend: "none".to_string(),
            residual,
        },
    ];
    EnforcementOutcome::Report(EnforcementReport {
        mode: SandboxMode::DangerFullAccess,
        completeness: EnforcementCompleteness::Partial,
        dimensions: dims,
        backend: "none".to_string(),
        unavailable_reason: None,
    })
}

/// Compose an FS-confined mode (`read-only`/`workspace-write`) against the live
/// capabilities. FS confinement is the REQUIRED dimension.
fn confined_outcome(
    mode: SandboxMode,
    caps: &Capabilities,
    demand_full: bool,
) -> EnforcementOutcome {
    // The decisive gate: kernel-enforced per-path FS confinement.
    if !caps.landlock_fs {
        // bwrap may exist but cannot provide kernel-enforced FS confinement
        // without an FS-LSM backing — so the FS dimension is NOT enforceable.
        let backend_note = if caps.bwrap_present {
            "bwrap present but no FS-LSM backing (Landlock inactive)"
        } else {
            "no Landlock/bwrap FS backend"
        };
        let reason = format!(
            "SANDBOX_UNAVAILABLE: {} mode requires kernel-enforced per-path FS confinement, which is unavailable here ({}); failing closed rather than running unconfined (docs/11 S1/S4)",
            mode.as_str(),
            backend_note
        );
        if demand_full {
            // The explicit, documented fail-closed choice: fail when the mode
            // requires the missing dimension.
            return EnforcementOutcome::Unavailable {
                mode,
                reason,
            };
        }
        // Tolerant caller: a PARTIAL report with the FS dimension unsupported +
        // a non-empty residual + an explicit backend/'none' (never 'enforced').
        return EnforcementOutcome::Report(partial_confined_report(mode, caps, reason));
    }

    // (Not reachable on either target host class; kept for correctness on a
    // hypothetical host with an active Landlock LSM.) FS is enforceable.
    EnforcementOutcome::Report(full_confined_report(mode, caps))
}

/// The PARTIAL report for an FS-confined mode when FS confinement is NOT usable:
/// FS `unsupported` (residual + backend `none`), and the mechanisms that DO work
/// here reported with evidence (seccomp/netns `enforced` where live, rlimits
/// `best_effort`).
fn partial_confined_report(
    mode: SandboxMode,
    caps: &Capabilities,
    fs_residual: String,
) -> EnforcementReport {
    let dims = vec![
        DimensionReport {
            dimension: "filesystem".to_string(),
            guarantee: Guarantee::Unsupported,
            backend: "none".to_string(),
            residual: fs_residual,
        },
        network_dimension(caps),
        process_dimension(caps),
        rlimits_dimension(caps),
    ];
    EnforcementReport {
        mode,
        completeness: EnforcementCompleteness::Partial,
        dimensions: dims,
        // The primary confinement backend is FS; it is unavailable -> 'none'.
        backend: "none".to_string(),
        unavailable_reason: Some(
            "filesystem confinement is unavailable (no active Landlock LSM); this report is partial"
                .to_string(),
        ),
    }
}

/// The FULL report for an FS-confined mode when FS confinement IS usable (only
/// reached on a host with an active Landlock LSM — not either target class).
fn full_confined_report(mode: SandboxMode, caps: &Capabilities) -> EnforcementReport {
    let dims = vec![
        DimensionReport {
            dimension: "filesystem".to_string(),
            guarantee: Guarantee::Enforced,
            backend: "landlock".to_string(),
            residual: String::new(),
        },
        network_dimension(caps),
        process_dimension(caps),
        rlimits_dimension(caps),
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
    }
}

/// The network dimension from the live capabilities: `enforced` via `netns`
/// when available, else `unsupported` with a residual + backend `none`.
fn network_dimension(caps: &Capabilities) -> DimensionReport {
    if caps.netns {
        DimensionReport {
            dimension: "network".to_string(),
            guarantee: Guarantee::Enforced,
            backend: "netns".to_string(),
            residual: String::new(),
        }
    } else {
        DimensionReport {
            dimension: "network".to_string(),
            guarantee: Guarantee::Unsupported,
            backend: "none".to_string(),
            residual: "network namespaces unavailable; egress is not confined at the OS layer".to_string(),
        }
    }
}

/// The process (syscall) dimension: `enforced` via `seccomp` when available,
/// else `unsupported` with a residual + backend `none`.
fn process_dimension(caps: &Capabilities) -> DimensionReport {
    if caps.seccomp {
        DimensionReport {
            dimension: "process".to_string(),
            guarantee: Guarantee::Enforced,
            backend: "seccomp".to_string(),
            residual: String::new(),
        }
    } else {
        DimensionReport {
            dimension: "process".to_string(),
            guarantee: Guarantee::Unsupported,
            backend: "none".to_string(),
            residual: "seccomp unavailable; syscalls are not filtered at the OS layer".to_string(),
        }
    }
}

/// The resource (rlimits) dimension: `best_effort` when rlimits are settable (a
/// limit bounds resources but is not a hard confinement boundary, so it is never
/// `enforced`), else `unsupported`. A below-`enforced` guarantee always carries
/// a non-empty residual (S2).
fn rlimits_dimension(caps: &Capabilities) -> DimensionReport {
    if caps.rlimits {
        DimensionReport {
            dimension: "resources".to_string(),
            guarantee: Guarantee::BestEffort,
            backend: "rlimits".to_string(),
            residual: "rlimits bound resources but are not a confinement boundary (best effort)".to_string(),
        }
    } else {
        DimensionReport {
            dimension: "resources".to_string(),
            guarantee: Guarantee::Unsupported,
            backend: "none".to_string(),
            residual: "rlimits unavailable".to_string(),
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

    #[test]
    fn capability_detection_never_panics() {
        // Every detector must return cleanly (true or false) and never panic.
        let caps = detect_capabilities();
        // On every target host class we confine, Landlock FS is NOT usable
        // (no active LSM list) and bwrap presence does NOT make FS enforced.
        assert!(
            !caps.landlock_fs,
            "Landlock FS must not be reported usable without an active LSM list"
        );
        // Caching returns the same posture.
        assert_eq!(capabilities(), capabilities());
    }

    #[test]
    fn fs_confined_modes_fail_closed_here() {
        // Use the LIVE host capabilities: FS confinement is unavailable, so a
        // mode that demands it yields SANDBOX_UNAVAILABLE (never 'enforced').
        let caps = capabilities();
        for mode in [SandboxMode::ReadOnly, SandboxMode::WorkspaceWrite] {
            let outcome = enforce(mode, caps, true);
            match outcome {
                EnforcementOutcome::Unavailable { mode: m, reason } => {
                    assert_eq!(m, mode);
                    assert!(reason.contains("SANDBOX_UNAVAILABLE"));
                    assert!(!reason.is_empty());
                }
                other => panic!("expected SANDBOX_UNAVAILABLE for {:?}, got {:?}", mode, other),
            }
        }
    }

    #[test]
    fn fs_confined_partial_report_has_nonempty_residual_and_explicit_backend() {
        // A tolerant caller (demand_full=false) gets a PARTIAL report with the
        // FS dimension unsupported, a NON-EMPTY residual, and backend 'none' —
        // never a silent 'enforced'.
        let caps = capabilities();
        let outcome = enforce(SandboxMode::WorkspaceWrite, caps, false);
        let report = match outcome {
            EnforcementOutcome::Report(r) => r,
            other => panic!("expected a partial report, got {:?}", other),
        };
        assert_eq!(report.completeness, EnforcementCompleteness::Partial);
        assert_eq!(report.backend, "none");
        let fs = report
            .dimensions
            .iter()
            .find(|d| d.dimension == "filesystem")
            .expect("a filesystem dimension");
        assert_eq!(fs.guarantee, Guarantee::Unsupported);
        assert_eq!(fs.backend, "none");
        assert!(!fs.residual.is_empty(), "FS residual must be non-empty (S2)");
        // No dimension is silently 'enforced' for the FS requirement: FS is not.
        assert_ne!(fs.guarantee, Guarantee::Enforced);
        // Every below-enforced dimension carries a non-empty residual (S2).
        for d in &report.dimensions {
            if d.guarantee != Guarantee::Enforced {
                assert!(
                    !d.residual.is_empty(),
                    "dimension {} below enforced must carry a residual",
                    d.dimension
                );
            }
            // Backend is always explicit (a name or 'none'), S5.
            assert!(!d.backend.is_empty());
        }
    }

    #[test]
    fn danger_full_access_reports_no_enforced_dimension() {
        let caps = capabilities();
        let outcome = enforce(SandboxMode::DangerFullAccess, caps, true);
        let report = match outcome {
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

    #[test]
    fn outcome_json_is_stable_and_typed() {
        let caps = capabilities();
        // SANDBOX_UNAVAILABLE json
        let unavail = enforce(SandboxMode::ReadOnly, caps, true).to_json();
        assert_eq!(unavail["status"], json!("sandbox_unavailable"));
        assert_eq!(unavail["mode"], json!("read-only"));
        assert!(unavail["reason"].as_str().unwrap().contains("SANDBOX_UNAVAILABLE"));

        // report json
        let report = enforce(SandboxMode::DangerFullAccess, caps, true).to_json();
        assert_eq!(report["status"], json!("report"));
        assert_eq!(report["mode"], json!("danger-full-access"));
        assert_eq!(report["completeness"], json!("partial"));
        assert!(report["dimensions"].is_array());
    }
}
