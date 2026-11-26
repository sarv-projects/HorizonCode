//! Guard: authority evaluation (deny > lease > ask > allow) plus in-memory leases.
//!
//! H-4 / ruling 624: every `allow` decision that admits a mutation MUST cite a
//! one-use lease id (policy allow and allowlist allow mint a bound lease for
//! *this* check; grants already did). The lease is citation evidence for the
//! receipt/OwnerLog — it is not re-held for a second effect.
//!
//! G1 / ruling 637: docs/11 forbids an `Allow` *variant* — admission is always
//! an Ask that a lease resolves. The frozen wire still emits `decision:"allow"`
//! for compatibility; additive `g1:"ask"|"deny"` carries the Ask/Deny-only
//! vocabulary (`allow` → `g1:"ask"` with required `leaseId`).
//!
//! Policy comes from `<state-dir>/policy.json` when present and well formed,
//! otherwise from `DEFAULT_POLICY` (replicated verbatim from contracts.ts).
//!
//! Evaluation, per docs/11-authority-safety.md R1 (deny > ask > allow):
//!   0. a structural, hard-coded rule denies any `fs.write` whose target
//!      resolves inside the kernel state directory, and any `shell.exec` whose
//!      command string names that directory (`kernel-state-protected`);
//!      it is evaluated before policy rules and leases and cannot be lifted by
//!      policy.json (the model must never be able to rewrite its own policy);
//!   1. any matching `deny` rule wins;
//!   1b. a structural `sensitive-write` rule asks for any `fs.write` to a git
//!      hook/config, `.env*`, lockfile, CI workflow, Makefile/Dockerfile or
//!      shell profile — even when a policy (or the workspace default) says
//!      `allow` — and cannot be waived by a wildcard lease or grant; an
//!      exact-pattern one-use lease (human "once" approval) is consumed and
//!      allows the re-check (ruling 659);
//!   2. else an unexpired, matching lease grants `allow`;
//!   3. else any matching `ask` rule asks (an ask beats a matching allow);
//!   4. else any matching `allow` rule grants `allow`;
//!   5. otherwise `ask`.
//!
//! A rule matches when its `kind` equals the action kind (or is `"*"`) and its
//! `scope` equals the caller's scope (or is `"*"`). Scope is computed by the
//! caller (`"workspace"` or `"outside"`); when absent it is treated as `"*"`.
//!
//! Lease patterns: a trailing `*` means prefix match (`"echo *"` matches
//! `"echo hi"`, `"*"` matches everything); otherwise the pattern is an exact
//! match against the action target.

use std::collections::VecDeque;
use std::env;
use std::ffi::{OsStr, OsString};
use std::fs;
use std::path::{Component, Path, PathBuf};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use uuid::Uuid;

use crate::egress;
use crate::execpolicy::{self, Decision};
pub use crate::execpolicy::{network_rule_from_value, prefix_rule_from_value};
use crate::time::{iso_from_unix_millis, now_millis, parse_iso_millis};

type Rule = (&'static str, &'static str, &'static str);

/// Built-in policy used when `<state-dir>/policy.json` is absent.
///
/// `mcp.invoke` covers every namespaced MCP tool call (docs/09 §4.7): a
/// server's own annotations are a claim, not authority, so the default is
/// `ask` — connecting a server, and calling any tool on it, is a human call.
pub const DEFAULT_POLICY: [Rule; 8] = [
    ("fs.read", "workspace", "allow"),
    ("fs.write", "workspace", "allow"),
    ("fs.read", "outside", "ask"),
    ("fs.write", "outside", "ask"),
    ("shell.exec", "*", "ask"),
    ("net.fetch", "*", "ask"),
    ("spawn", "*", "ask"),
    ("mcp.invoke", "*", "ask"),
];

const MAX_LEASES: usize = 1024;
const MAX_GRANTS: usize = 256;
/// docs/11 L3 reduced form: a lease the guard itself mints from a grant lives
/// for at most this long, and never past the grant it came from.
const BOUND_LEASE_MS: i64 = 120_000;

/// H-31 / ruling 636: workspace identity stamped onto a held lease at mint so
/// remount/symlink swaps cannot consume authority under a different `(dev,ino)`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LeaseWorkspaceBinding {
    pub root: String,
    pub device: u64,
    pub inode: u64,
}

impl LeaseWorkspaceBinding {
    pub fn from_binding(binding: &crate::workspace_binding::WorkspaceBinding) -> Self {
        Self {
            root: binding.root.to_string_lossy().into_owned(),
            device: binding.device,
            inode: binding.inode,
        }
    }

    /// Re-stat the stamped root; true only when live identity still matches.
    pub fn still_valid(&self) -> bool {
        match crate::workspace_binding::WorkspaceBinding::capture(Path::new(&self.root)) {
            Ok(live) => {
                live.device == self.device
                    && live.inode == self.inode
                    && live.root.to_string_lossy() == self.root
            }
            Err(_) => false,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Lease {
    pub lease_id: String,
    pub kind: String,
    pub pattern: String,
    /// ISO-8601 UTC.
    pub expiry: String,
    /// The session the lease was minted for. Absent (`None`) = a legacy or
    /// caller-supplied lease that stays globally consultable by every caller —
    /// the pre-owner wire shape, documented as legacy here on purpose. A lease
    /// with an owner is only honoured for checks carrying that same session id,
    /// so a subagent child cannot inherit its parent session's "always" grant.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub owner: Option<String>,
    /// Approval-path attribution (`human`); cryptographically verified when
    /// `principal_verified` is `Some(true)`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub principal: Option<String>,
    /// True when `principal: "human"` was backed by a verified Ed25519
    /// human-approval signature over the canonical payload.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub principal_verified: Option<bool>,
    /// Launch-time workspace identity at mint (ruling **636**). Absent on
    /// legacy leases minted before binding existed — those stay consultable.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workspace_binding: Option<LeaseWorkspaceBinding>,
}

/// A session **grant**: the "always" answer, in the shape docs/11 L7 gives it —
/// a bounded pre-authorisation, never a bypass. A matching grant does not allow
/// anything by itself; it mints a fresh ONE-USE lease for the exact effect
/// (kind + resolved target) on the spot, and that lease is what the decision
/// returns and the receipt cites. Same fields as a lease, same owner scoping,
/// same 15-minute window the TUI states; kept in its own table so a grant can
/// never be consumed like a lease.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Grant {
    pub lease_id: String,
    pub kind: String,
    pub pattern: String,
    pub expiry: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub owner: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub principal: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub principal_verified: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workspace_binding: Option<LeaseWorkspaceBinding>,
}

/// The action kinds this kernel's guard vocabulary knows. The protocol refuses
/// anything else before evaluation: the structural state-dir rule below is keyed
/// to the exact mutating kind (`fs.write`), so an unrecognised kind (say a raw
/// client's `fs.edit`) would otherwise reach the policy as an unknown rule and
/// land on the fallback answer. Keep this list in step with `parse_rule` and
/// the TS `GuardKind`.
pub const KNOWN_KINDS: [&str; 6] = [
    "fs.read",
    "fs.write",
    "shell.exec",
    "net.fetch",
    "spawn",
    "mcp.invoke",
];

pub fn known_kind(kind: &str) -> bool {
    KNOWN_KINDS.contains(&kind)
}

/// The typed refusal for a kind this kernel does not know (the
/// `HZ_PRECONDITION_FAILED` class is the registered wire vocabulary).
pub fn unknown_kind_refusal(kind: &str) -> String {
    format!(
        "HZ_PRECONDITION_FAILED: unknown action kind {:?}; known kinds are {}",
        kind,
        KNOWN_KINDS.join(", ")
    )
}

impl Lease {
    pub fn is_expired(&self, now_ms: i64) -> bool {
        match parse_iso_millis(&self.expiry) {
            Some(expiry) => expiry <= now_ms,
            None => true, // unparseable expiry never grants authority
        }
    }
}

impl Grant {
    pub fn is_expired(&self, now_ms: i64) -> bool {
        match parse_iso_millis(&self.expiry) {
            Some(expiry) => expiry <= now_ms,
            None => true,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PolicyRule {
    pub kind: String,
    pub scope: String,
    pub decision: String,
}

#[derive(Debug, Clone)]
pub struct GuardAction {
    pub kind: String,
    pub target: String,
}

#[derive(Debug, Clone)]
pub struct GuardDecision {
    pub decision: String,
    pub reason: String,
    pub lease_id: Option<String>,
    /// H-31 / ruling 629: sha256 over kind|scope|target|(root,device,inode).
    pub intent_digest: Option<String>,
    /// Launch-time workspace identity when the kernel is bound (H-31).
    pub workspace_binding: Option<crate::workspace_binding::WorkspaceBinding>,
}

impl GuardDecision {
    /// G1 Ask/Deny-only projection (ruling **637**, owner-approved breaking removal of `"allow"`).
    pub fn g1_decision(&self) -> &'static str {
        match self.decision.as_str() {
            "deny" => "deny",
            _ => "ask",
        }
    }

    pub fn to_json(&self) -> Value {
        let g1 = self.g1_decision();
        let mut out = json!({
            "decision": g1,
            "reason": self.reason,
            "g1": g1,
        });
        if let (Some(lease_id), Value::Object(map)) = (&self.lease_id, &mut out) {
            map.insert("leaseId".to_string(), json!(lease_id));
        }
        if let (Some(digest), Value::Object(map)) = (&self.intent_digest, &mut out) {
            map.insert("intentDigest".to_string(), json!(digest));
        }
        if let (Some(binding), Value::Object(map)) = (&self.workspace_binding, &mut out) {
            map.insert("workspaceBinding".to_string(), binding.to_json());
        }
        out
    }
}

/// `true` when `pattern` matches `target` (trailing `*` = prefix match, else exact).
pub fn pattern_matches(pattern: &str, target: &str) -> bool {
    match pattern.strip_suffix('*') {
        Some(prefix) => target.starts_with(prefix),
        None => pattern == target,
    }
}

/// The lease/grant TTL ceiling (366 days), shared by both tables.
fn clamped_ttl(ttl_ms: u64) -> i64 {
    ttl_ms.min(366 * 24 * 60 * 60 * 1_000) as i64
}

pub struct Guard {
    policy_path: PathBuf,
    state_dir: PathBuf,
    leases: Mutex<Vec<Lease>>,
    grants: Mutex<Vec<Grant>>,
    /// H-31 / ruling 629: optional launch-time `(root, device, inode)` folded
    /// into every decision's `intentDigest`.
    workspace_binding: Option<crate::workspace_binding::WorkspaceBinding>,
    /// When true (workspace binding failed or parent-controlled kernel lacks a
    /// binding), fail closed to `"outside"` for `fs.*` actions instead of
    /// trusting caller-claimed `"workspace"`.
    fail_closed_unbound_scope: bool,
}

impl Guard {
    pub fn new(state_dir: &Path) -> Self {
        Guard {
            policy_path: state_dir.join("policy.json"),
            state_dir: state_dir.to_path_buf(),
            leases: Mutex::new(Vec::new()),
            grants: Mutex::new(Vec::new()),
            workspace_binding: None,
            fail_closed_unbound_scope: false,
        }
    }

    /// Force unbound `fs.*` scope derivation to fail closed to `"outside"`.
    pub fn set_fail_closed_unbound_scope(&mut self, fail_closed: bool) {
        self.fail_closed_unbound_scope = fail_closed;
    }

    /// Bind this Guard to a launch-time workspace identity (H-31).
    pub fn set_workspace_binding(
        &mut self,
        binding: Option<crate::workspace_binding::WorkspaceBinding>,
    ) {
        self.workspace_binding = binding;
    }

    pub fn state_dir(&self) -> &Path {
        &self.state_dir
    }

    /// Annotate a raw decision with intent digest + workspace binding (H-31).
    fn annotate(
        &self,
        mut decision: GuardDecision,
        action: &GuardAction,
        scope: &str,
    ) -> GuardDecision {
        decision.workspace_binding = self.workspace_binding.clone();
        decision.intent_digest = Some(intent_digest_hex(
            action,
            scope,
            self.workspace_binding.as_ref(),
        ));
        decision
    }

    /// Public check: annotate every decision with H-31 intent digest + binding.
    pub fn check(
        &self,
        action: &GuardAction,
        scope: Option<&str>,
        caller_leases: &[Lease],
        session_id: Option<&str>,
    ) -> Result<GuardDecision, PolicyError> {
        // Derive scope from target vs workspace binding — never trust a caller
        // claim of "workspace" for a path outside the bound root (ruling 658).
        let scope_str = self.derive_scope(action, scope);
        let decision = self.check_unguarded(action, Some(&scope_str), caller_leases, session_id)?;
        Ok(self.annotate(decision, action, &scope_str))
    }

    /// Authority-side scope for fs.* path actions when a workspace is bound.
    /// A caller JSON-RPC `scope: "workspace"` cannot widen an outside target.
    fn derive_scope(&self, action: &GuardAction, claimed: Option<&str>) -> String {
        let claimed = claimed.filter(|s| !s.is_empty());
        let path_kind = matches!(
            action.kind.as_str(),
            "fs.read" | "fs.write" | "fs.edit" | "fs.delete" | "fs.rename"
        );
        if path_kind {
            if let Some(binding) = &self.workspace_binding {
                if !path_contained_in(&binding.root, Path::new(&action.target)) {
                    return "outside".to_string();
                }
                return match claimed {
                    Some("outside") => "outside".to_string(),
                    Some(s) => s.to_string(),
                    None => "workspace".to_string(),
                };
            }
            if self.fail_closed_unbound_scope {
                return "outside".to_string();
            }
        }
        claimed.unwrap_or("*").to_string()
    }

    /// Loaded fresh on every check so policy edits apply without a restart.
    /// A present-but-malformed policy is a typed refusal (`PolicyError`), never
    /// a silent drop of the rules the parser did not understand: a dropped
    /// `deny` rule would be a fail-open. A genuinely absent file returns the
    /// built-in policy.
    pub fn policy(&self) -> Result<Vec<PolicyRule>, PolicyError> {
        match read_policy_rules(&self.policy_path)? {
            Some(rules) => Ok(rules),
            None => Ok(default_policy()),
        }
    }

    fn check_unguarded(
        &self,
        action: &GuardAction,
        scope: Option<&str>,
        caller_leases: &[Lease],
        session_id: Option<&str>,
    ) -> Result<GuardDecision, PolicyError> {
        // Fail closed on a kind this kernel does not know, before any rule or
        // lease is consulted: the structural rule below is keyed to the exact
        // mutating kind, so an unknown spelling (a raw client's "fs.edit") must
        // never fall through to the policy as an unrecognised action.
        if !known_kind(&action.kind) {
            return Ok(GuardDecision {
                decision: "deny".to_string(),
                reason: unknown_kind_refusal(&action.kind),
                lease_id: None,
                intent_digest: None,
                workspace_binding: None,
            });
        }

        // Structural rule, evaluated before policy rules and leases: the kernel
        // state directory holds the policy, the event log and the receipts, so
        // no fs.write may ever target it and no shell.exec may name it — a
        // policy that says otherwise is itself part of what this rule protects.
        // It cannot be lifted by policy.json, a caller-supplied lease, or a
        // held lease.
        // NOTE: keyed to `fs.write` + `shell.exec`. Any future mutating kind
        // must be added HERE as well as to KNOWN_KINDS.
        if action.kind == "fs.write" && resolves_inside(&self.state_dir, Path::new(&action.target))
        {
            return Ok(GuardDecision {
                decision: "deny".to_string(),
                reason: format!(
                    "kernel-state-protected: {} resolves inside the kernel state directory",
                    action.target
                ),
                lease_id: None,
                intent_digest: None,
                workspace_binding: None,
            });
        }
        if action.kind == "shell.exec"
            && shell_references_kernel_state(&action.target, &self.state_dir)
        {
            return Ok(GuardDecision {
                decision: "deny".to_string(),
                reason: format!(
                    "kernel-state-protected: shell.exec command references the kernel state directory ({})",
                    self.state_dir.display()
                ),
                lease_id: None,
                intent_digest: None,
                workspace_binding: None,
            });
        }

        // R1 is deny > lease > ask > allow ACROSS layers (D-2). A policy-layer
        // rule is a verdict; an allowlist/egress `allow` is only an ADMISSION
        // CANDIDATE. It is recorded here and consulted at the final default step,
        // after policy deny/ask/allow have had their say, so an allowlist cannot
        // admit what policy.json denies or asks about.
        let mut allowlist_admission: Option<String> = None;
        let mut egress_admission: Option<String> = None;

        // Command allowlist (FEAT-002, docs/11 R1): for shell.exec ONLY, consult
        // the declarative allowlist BEFORE the policy rules so an allowlist
        // `deny` wins (R1). A non-match or an `ask` returns `None`/`Ask` and falls
        // through to the EXISTING flow unchanged — so shell.exec with no
        // allowlist file present behaves EXACTLY as today (ask). A malformed
        // allowlist is a typed refusal (fail closed), never silently ignored.
        if action.kind == "shell.exec" {
            // Reduced-form argv split: whitespace tokenization. Wrapper
            // unwrapping (env/timeout/...), quote handling and a tree-sitter
            // per-segment split are DEFERRED (residual recorded in docs/28); a
            // conservative whitespace split never widens authority because a
            // non-match falls through to the ask default.
            let argv: Vec<String> = action
                .target
                .split_whitespace()
                .map(|s| s.to_string())
                .collect();
            if !argv.is_empty() {
                let policy = execpolicy::load(&self.state_dir)
                    .map_err(|e| PolicyError::Allowlist(e.to_string()))?;
                if let Some(policy) = policy {
                    match policy.evaluate_command(&argv) {
                        Some(Decision::Deny) => {
                            return Ok(GuardDecision {
                                decision: "deny".to_string(),
                                reason: format!(
                                    "allowlist deny: {} matches a deny rule (fingerprint {})",
                                    action.target,
                                    policy.fingerprint()
                                ),
                                lease_id: None,
                                intent_digest: None,
                                workspace_binding: None,
                            });
                        }
                        Some(Decision::Allow) => {
                            // Reject shell control metacharacters / quotes / escapes so
                            // compound commands like `git status; rm -rf /` can never
                            // match an allowlisted `git status` prefix (fall through to ask).
                            if !execpolicy::contains_shell_control_metachar(&action.target) {
                                // D-2: an admission candidate, not a verdict. The
                                // policy layer below may still deny or ask.
                                allowlist_admission = Some(policy.fingerprint());
                            }
                        }
                        // Ask or None: no allowlist admission — fall through to
                        // the existing policy/lease/grant/ask flow unchanged.
                        _ => {}
                    }
                }
            }
        }

        // Egress decider (FEAT-003, docs/11 N1/N2): for net.fetch ONLY, consult
        // the per-origin decider BEFORE the policy rules — the exact FEAT-002
        // shape. The decider is only consulted when an egress policy file is
        // PRESENT (<state-dir>/egress.json): a genuinely absent file is
        // `None`/no-opinion and net.fetch falls through to its policy-layer
        // `ask`, byte-identical to today. When a policy IS present it is
        // default-deny (N1): a decider Deny returns deny (reason naming the
        // origin + DenySource) BEFORE policy; an Allow admits; an Ask or an
        // observe-mode AllowAndRecord falls through to the existing net.fetch
        // flow (observe mode admits without blocking; the content-free record
        // emission is deferred to the egress proxy per docs/28 ruling 43, so the
        // would-be verdict is not surfaced in the reason today).
        // An unparseable target is a DENY candidate (fail closed).
        // A malformed egress.json is a typed refusal (fail closed), never
        // silently ignored.
        //
        // Spawn-with-network intent is NOT cleanly derivable from a spawn
        // target here, so this consult is scoped to net.fetch; spawn-with-network
        // is a documented follow-up (docs/28 ruling 43).
        if action.kind == "net.fetch" {
            if let Some(policy) =
                egress::load(&self.state_dir).map_err(|e| PolicyError::Egress(e.to_string()))?
            {
                let (origin_label, decision) = match policy.decide_url(&action.target) {
                    Ok((origin, decision)) => (origin.display(), decision),
                    // unparseable target -> deny candidate, fail closed.
                    Err(decision) => (action.target.clone(), decision),
                };
                match decision {
                    egress::EgressDecision::Deny(source) => {
                        return Ok(GuardDecision {
                            decision: "deny".to_string(),
                            reason: format!(
                                "egress deny: {} denied by {} (default-deny per docs/11 N1)",
                                origin_label,
                                source.as_str()
                            ),
                            lease_id: None,
                            intent_digest: None,
                            workspace_binding: None,
                        });
                    }
                    egress::EgressDecision::Allow => {
                        // D-2: candidate only, exactly like the allowlist. A
                        // policy deny/ask for net.fetch still wins.
                        egress_admission = Some(origin_label);
                    }
                    egress::EgressDecision::AllowAndRecord { would } => {
                        // observe mode: ADMIT at the decider, but do not short-
                        // circuit policy; fall through to the existing net.fetch
                        // flow so the policy-layer answer (ask, by default)
                        // stands. The would-be verdict is intentionally NOT
                        // surfaced here: content-free record emission is deferred
                        // to the egress proxy (docs/28 ruling 43), so `would` is
                        // dropped for now.
                        let _ = would;
                    }
                    // Ask: no decider admission — fall through to the existing
                    // net.fetch policy/lease/grant/ask flow unchanged.
                    egress::EgressDecision::Ask => {}
                }
            }
        }

        let scope = scope.filter(|s| !s.is_empty()).unwrap_or("*");
        let now_ms = now_millis();
        // D-2: an explicit policy file is a human verdict and outranks a layer
        // admission (allowlist/egress) for ask as well as deny. The BUILT-IN
        // default ask is not explicit: an allowlist allow exists precisely to
        // lift it (FEAT-002), so it may admit before the default rule answers.
        let explicit_policy = self.state_dir.join("policy.json").exists();

        let matching: Vec<PolicyRule> = self
            .policy()?
            .into_iter()
            .filter(|rule| rule_answer_matches(rule, &action.kind, scope))
            .collect();

        if let Some(deny) = matching.iter().find(|rule| rule.decision == "deny") {
            return Ok(GuardDecision {
                decision: "deny".to_string(),
                reason: format!(
                    "policy deny: {} @ {} (action {} on {})",
                    deny.kind, deny.scope, action.kind, action.target
                ),
                lease_id: None,
                intent_digest: None,
                workspace_binding: None,
            });
        }

        // D-2: with no explicit policy.json, a layer admission admits here —
        // before the built-in default ask rule can answer.
        if !explicit_policy && (allowlist_admission.is_some() || egress_admission.is_some()) {
            let lease = self.mint_allow_lease(&action.kind, &action.target, session_id, now_ms);
            let source = match (&allowlist_admission, &egress_admission) {
                (Some(fingerprint), _) => format!(
                    "allowlist allow: {} matches an allow rule (fingerprint {}; no policy deny)",
                    action.target, fingerprint
                ),
                (None, Some(origin)) => format!(
                    "egress allow: {} matches an allow rule (no policy deny)",
                    origin
                ),
                (None, None) => unreachable!(),
            };
            return Ok(GuardDecision {
                decision: "ask".to_string(),
                reason: format!("{}; minted one-use lease {}", source, lease.lease_id),
                lease_id: Some(lease.lease_id),
                intent_digest: None,
                workspace_binding: None,
            });
        }

        // Only leases this kernel issued are honoured (the held table). A
        // caller-supplied lease is a claim, not a mint: a raw client echoing
        // back `{leaseId, kind, pattern, expiry}` must not unlock anything it
        // was not issued. `caller_leases` stays in the signature for wire
        // compatibility (the protocol still validates its shape) and is
        // deliberately ignored here.
        let _ = caller_leases;

        // H6 + human-approval re-check (ruling 659): sensitive-write still
        // blocks policy allow, wildcard leases, and grants. An EXACT-pattern
        // one-use lease (human "once" approval for this target) is consumed
        // here so OwnerLog re-check under EffectHost=require can proceed.
        if action.kind == "fs.write" && is_sensitive_write(Path::new(&action.target)) {
            if let Some(lease) = self.take_exact_matching_lease(action, session_id, now_ms) {
                return Ok(GuardDecision {
                    decision: "ask".to_string(),
                    reason: format!(
                        "lease {} (exact) covers sensitive-write {} on {} (consumed)",
                        lease.lease_id, action.kind, action.target
                    ),
                    lease_id: Some(lease.lease_id),
                    intent_digest: None,
                    workspace_binding: None,
                });
            }
            return Ok(GuardDecision {
                decision: "ask".to_string(),
                reason: format!(
                    "sensitive-write: {} is a sensitive path (git hooks/config, env file, lockfile, CI workflow, container/build file or shell profile); explicit approval required",
                    action.target
                ),
                lease_id: None,
                intent_digest: None,
                workspace_binding: None,
            });
        }

        // docs/11 L1 reduced form: a lease is consumed at most once. The first
        // matching check takes the lease OUT of the held table and returns its
        // id with the allow; a second identical action finds no lease and falls
        // back to policy (ask) or a grant — never to the spent lease.
        if let Some(lease) = self.take_matching_lease(action, session_id, now_ms) {
            return Ok(GuardDecision {
                decision: "ask".to_string(),
                reason: format!(
                    "lease {} ({}) covers {} on {} (consumed)",
                    lease.lease_id, lease.pattern, action.kind, action.target
                ),
                lease_id: Some(lease.lease_id),
                intent_digest: None,
                workspace_binding: None,
            });
        }

        // docs/11 L7 reduced form: the grant is a pre-authorisation, never a
        // bypass. It fires only where the answer would otherwise be `ask`, and
        // it mints a fresh one-use lease for THIS effect — which is what the
        // decision returns and the receipt cites. deny still wins above; a
        // matching allow rule below is untouched.
        let needs_ask = matching.iter().any(|rule| rule.decision == "ask")
            || !matching.iter().any(|rule| rule.decision == "allow");
        if needs_ask {
            if let Some(grant) = self.matching_grant(action, session_id, now_ms) {
                let lease = self.mint_bound_lease(&action.kind, &action.target, &grant, now_ms);
                return Ok(GuardDecision {
                    decision: "ask".to_string(),
                    reason: format!(
                        "grant {} covers {} on {} (minted one-use lease {})",
                        grant.lease_id, action.kind, action.target, lease.lease_id
                    ),
                    lease_id: Some(lease.lease_id),
                    intent_digest: None,
                    workspace_binding: None,
                });
            }
        }

        if let Some(ask) = matching.iter().find(|rule| rule.decision == "ask") {
            // docs/11 R1: ask outranks allow. A lease above already won over this
            // rule on purpose — lease semantics are unchanged.
            return Ok(GuardDecision {
                decision: "ask".to_string(),
                reason: format!(
                    "policy ask: {} @ {} (action {} on {})",
                    ask.kind, ask.scope, action.kind, action.target
                ),
                lease_id: None,
                intent_digest: None,
                workspace_binding: None,
            });
        }

        if let Some(allow) = matching.iter().find(|rule| rule.decision == "allow") {
            // MEMORY.md is user-curated memory (docs/33 §5.4): a policy allow
            // never silent-writes it; a human ask (or a held/grant lease above)
            // is required.
            if action.kind == "fs.write"
                && is_memory_manifest_write(&self.state_dir, Path::new(&action.target))
            {
                return Ok(GuardDecision {
                    decision: "ask".to_string(),
                    reason: format!(
                        "memory-manifest-protected: writing MEMORY.md needs approval (action {} on {})",
                        action.kind, action.target
                    ),
                    lease_id: None,
                intent_digest: None,
                workspace_binding: None,
            });
            }
            // H-4 / ruling 624: policy allow still admits, but every allow
            // cites a fresh one-use lease bound to this exact effect. The mint
            // is not held — same shape as grant-minted leases (L3 reduced).
            let lease = self.mint_allow_lease(&action.kind, &action.target, session_id, now_ms);
            return Ok(GuardDecision {
                decision: "ask".to_string(),
                reason: format!(
                    "policy allow: {} @ {} (action {} on {}; minted one-use lease {})",
                    allow.kind, allow.scope, action.kind, action.target, lease.lease_id
                ),
                lease_id: Some(lease.lease_id),
                intent_digest: None,
                workspace_binding: None,
            });
        }

        // D-2: a layer admission candidate decides only here — after policy
        // deny, policy ask and policy allow. Every allow cites a one-use lease
        // (H-4 / G1, rulings 624/637/662).
        if allowlist_admission.is_some() || egress_admission.is_some() {
            let lease = self.mint_allow_lease(&action.kind, &action.target, session_id, now_ms);
            let source = match (allowlist_admission, egress_admission) {
                (Some(fingerprint), _) => format!(
                    "allowlist allow: {} matches an allow rule (fingerprint {}; no policy deny/ask)",
                    action.target, fingerprint
                ),
                (None, Some(origin)) => format!(
                    "egress allow: {} matches an allow rule (no policy deny/ask)",
                    origin
                ),
                (None, None) => unreachable!(),
            };
            return Ok(GuardDecision {
                decision: "ask".to_string(),
                reason: format!("{}; minted one-use lease {}", source, lease.lease_id),
                lease_id: Some(lease.lease_id),
                intent_digest: None,
                workspace_binding: None,
            });
        }

        Ok(GuardDecision {
            decision: "ask".to_string(),
            reason: format!(
                "no allow rule or lease for {} @ {} (action {} on {})",
                action.kind, scope, action.kind, action.target
            ),
            lease_id: None,
            intent_digest: None,
            workspace_binding: None,
        })
    }

    /// Append an allowlist prefix rule at runtime (FEAT-002). File-locked
    /// append-dedup under `<state-dir>/allowlist.json`; the rule's own examples
    /// are validated before it is persisted (codex R8). Returns
    /// `(changed, fingerprint)`: `changed` is false when the rule was already
    /// present (dedup). A malformed-on-disk allowlist is a typed refusal.
    pub fn amend_allow_prefix_rule(
        &self,
        rule: &execpolicy::PrefixRule,
    ) -> Result<(bool, String), PolicyError> {
        let changed = execpolicy::amend_allow_prefix_rule(&self.state_dir, rule)
            .map_err(|e| PolicyError::Allowlist(e.to_string()))?;
        let policy = execpolicy::load(&self.state_dir)
            .map_err(|e| PolicyError::Allowlist(e.to_string()))?
            .unwrap_or_default();
        Ok((changed, policy.fingerprint()))
    }

    /// Append an allowlist network rule at runtime (FEAT-002). As
    /// `amend_allow_prefix_rule`, dedup-by-content under the advisory lock.
    pub fn amend_network_rule(
        &self,
        rule: &execpolicy::NetworkRule,
    ) -> Result<(bool, String), PolicyError> {
        let changed = execpolicy::amend_network_rule(&self.state_dir, rule)
            .map_err(|e| PolicyError::Allowlist(e.to_string()))?;
        let policy = execpolicy::load(&self.state_dir)
            .map_err(|e| PolicyError::Allowlist(e.to_string()))?
            .unwrap_or_default();
        Ok((changed, policy.fingerprint()))
    }

    /// Create and remember a lease; returns it with a fresh uuid v4 id. `owner`
    /// is the session the lease is minted for; a `None` owner mints a legacy
    /// owner-less lease that stays globally consultable (see `Lease::owner`).
    #[allow(dead_code)]
    pub fn issue_lease(
        &self,
        kind: &str,
        pattern: &str,
        ttl_ms: u64,
        owner: Option<String>,
        principal: Option<String>,
    ) -> Lease {
        self.issue_lease_with_verification(kind, pattern, ttl_ms, owner, principal, None)
    }

    pub fn issue_lease_with_verification(
        &self,
        kind: &str,
        pattern: &str,
        ttl_ms: u64,
        owner: Option<String>,
        principal: Option<String>,
        principal_verified: Option<bool>,
    ) -> Lease {
        let lease = Lease {
            lease_id: Uuid::new_v4().to_string(),
            kind: kind.to_string(),
            pattern: pattern.to_string(),
            expiry: iso_from_unix_millis(now_millis() + clamped_ttl(ttl_ms)),
            owner,
            principal,
            principal_verified,
            workspace_binding: self
                .workspace_binding
                .as_ref()
                .map(LeaseWorkspaceBinding::from_binding),
        };
        if let Ok(mut held) = self.leases.lock() {
            let now_ms = now_millis();
            held.retain(|l| !l.is_expired(now_ms));
            if held.len() >= MAX_LEASES {
                held.remove(0);
            }
            held.push(lease.clone());
        }
        lease
    }

    /// Create and remember a session grant (docs/11 L7 reduced form). Same
    /// validation and window as `issue_lease`; its own table, so it is never
    /// consumed by a check.
    #[allow(dead_code)]
    pub fn issue_grant(
        &self,
        kind: &str,
        pattern: &str,
        ttl_ms: u64,
        owner: Option<String>,
        principal: Option<String>,
    ) -> Grant {
        self.issue_grant_with_verification(kind, pattern, ttl_ms, owner, principal, None)
    }

    pub fn issue_grant_with_verification(
        &self,
        kind: &str,
        pattern: &str,
        ttl_ms: u64,
        owner: Option<String>,
        principal: Option<String>,
        principal_verified: Option<bool>,
    ) -> Grant {
        let grant = Grant {
            lease_id: Uuid::new_v4().to_string(),
            kind: kind.to_string(),
            pattern: pattern.to_string(),
            expiry: iso_from_unix_millis(now_millis() + clamped_ttl(ttl_ms)),
            owner,
            principal,
            principal_verified,
            workspace_binding: self
                .workspace_binding
                .as_ref()
                .map(LeaseWorkspaceBinding::from_binding),
        };
        if let Ok(mut held) = self.grants.lock() {
            let now_ms = now_millis();
            held.retain(|g| !g.is_expired(now_ms));
            if held.len() >= MAX_GRANTS {
                held.remove(0);
            }
            held.push(grant.clone());
        }
        grant
    }

    /// Take the first active, visible, matching lease OUT of the held table and
    /// return it (docs/11 L1: consumed at most once). A poisoned lock returns
    /// `None` — the fail-closed direction (ask), matching `active_leases`.
    fn take_matching_lease(
        &self,
        action: &GuardAction,
        session_id: Option<&str>,
        now_ms: i64,
    ) -> Option<Lease> {
        let mut held = self.leases.lock().ok()?;
        held.retain(|lease| !lease.is_expired(now_ms));
        let index = held.iter().position(|lease| {
            lease_visible_to(lease, session_id)
                && lease.kind == action.kind
                && pattern_matches(&lease.pattern, &action.target)
        })?;
        let lease = held.remove(index);
        // H-31 / ruling 636: remount or rename-swap of the stamped workspace
        // burns the held lease (removed above) and refuses authority.
        if let Some(ref stamp) = lease.workspace_binding {
            if !stamp.still_valid() {
                return None;
            }
        }
        Some(lease)
    }

    /// Exact-pattern one-use lease only (no trailing `*` / prefix match).
    /// Used so human "once" approvals can clear H6 sensitive-write on re-check
    /// without letting a broad `*` lease or grant waive the structural rule.
    fn take_exact_matching_lease(
        &self,
        action: &GuardAction,
        session_id: Option<&str>,
        now_ms: i64,
    ) -> Option<Lease> {
        let mut held = self.leases.lock().ok()?;
        held.retain(|lease| !lease.is_expired(now_ms));
        let index = held.iter().position(|lease| {
            lease_visible_to(lease, session_id)
                && lease.kind == action.kind
                && lease.pattern == action.target
        })?;
        let lease = held.remove(index);
        if let Some(ref stamp) = lease.workspace_binding {
            if !stamp.still_valid() {
                return None;
            }
        }
        Some(lease)
    }

    /// Read-only: the newest active grant covering `action` (display / hydrate).
    /// Does not mint or consume authority.
    pub fn query_matching_grant(
        &self,
        action: &GuardAction,
        session_id: Option<&str>,
    ) -> Option<Grant> {
        self.matching_grant(action, session_id, now_millis())
    }

    /// The newest active, visible, matching grant, if any. Grants are never
    /// removed by a check — they are pre-authorisations, not tokens.
    /// Revalidates any stamped `workspace_binding` so a remount/rename-swap
    /// cannot reuse a grant minted under a different workspace `(dev, ino)`.
    fn matching_grant(
        &self,
        action: &GuardAction,
        session_id: Option<&str>,
        now_ms: i64,
    ) -> Option<Grant> {
        let held = self.grants.lock().ok()?;
        held.iter()
            .filter(|grant| {
                !grant.is_expired(now_ms)
                    && grant_visible_to(grant, session_id)
                    && grant.kind == action.kind
                    && pattern_matches(&grant.pattern, &action.target)
                    && grant
                        .workspace_binding
                        .as_ref()
                        .map(|stamp| stamp.still_valid())
                        .unwrap_or(true)
            })
            .next_back()
            .cloned()
    }

    /// Mint the one-use lease a grant authorises for one exact effect: bound to
    /// the action's kind and RESOLVED TARGET (pattern = target), expiring at
    /// `min(now + 120 s, grant expiry)` (docs/11 L3 reduced form).
    ///
    /// The mint is NOT added to the consultable table: its one use is the very
    /// decision that returns it (the receipt cites it). If it were held, a
    /// second check for the same target would take it and admit a second
    /// effect — one approval, two effects. Every covered effect therefore gets
    /// its own mint, and a mint is never authority on its own again.
    fn mint_bound_lease(&self, kind: &str, target: &str, grant: &Grant, now_ms: i64) -> Lease {
        let grant_remaining = parse_iso_millis(&grant.expiry)
            .map(|expiry| expiry - now_ms)
            .unwrap_or(0);
        let ttl = BOUND_LEASE_MS.min(grant_remaining.max(0));
        Lease {
            lease_id: Uuid::new_v4().to_string(),
            kind: kind.to_string(),
            pattern: target.to_string(),
            expiry: iso_from_unix_millis(now_ms + ttl),
            owner: grant.owner.clone(),
            principal: grant.principal.clone(),
            principal_verified: grant.principal_verified,
            workspace_binding: self
                .workspace_binding
                .as_ref()
                .map(LeaseWorkspaceBinding::from_binding),
        }
    }

    /// H-4 / ruling 624: mint a one-use lease citation for a policy or
    /// allowlist `allow`. Not held — same non-replay rule as `mint_bound_lease`.
    fn mint_allow_lease(
        &self,
        kind: &str,
        target: &str,
        session_id: Option<&str>,
        now_ms: i64,
    ) -> Lease {
        Lease {
            lease_id: Uuid::new_v4().to_string(),
            kind: kind.to_string(),
            pattern: target.to_string(),
            expiry: iso_from_unix_millis(now_ms + BOUND_LEASE_MS),
            owner: session_id.map(|s| s.to_string()),
            principal: None,
            principal_verified: None,
            workspace_binding: self
                .workspace_binding
                .as_ref()
                .map(LeaseWorkspaceBinding::from_binding),
        }
    }
}

fn rule_answer_matches(rule: &PolicyRule, kind: &str, scope: &str) -> bool {
    (rule.kind == kind || rule.kind == "*") && (rule.scope == scope || rule.scope == "*")
}

/// H-31 / ruling 629: decision digest binds kind, scope, target, and optional
/// `(root, device, inode)` so a remount/symlink swap cannot inherit authority
/// citations that were minted against a different workspace identity.
fn intent_digest_hex(
    action: &GuardAction,
    scope: &str,
    binding: Option<&crate::workspace_binding::WorkspaceBinding>,
) -> String {
    let payload = match binding {
        Some(b) => serde_json::json!({
            "kind": action.kind,
            "scope": scope,
            "target": action.target,
            "workspaceBinding": {
                "root": b.root.to_string_lossy(),
                "device": b.device,
                "inode": b.inode,
            }
        }),
        None => serde_json::json!({
            "kind": action.kind,
            "scope": scope,
            "target": action.target,
            "workspaceBinding": null
        }),
    };
    crate::canon::sha256_hex(&crate::canon::canonical_json(&payload))
}

/* ----------------------------- policy loading ----------------------------- */

/// Why a policy file could not be used. Every variant is a refusal: the kernel
/// never silently drops a rule it did not understand (a dropped `deny` rule
/// would be a fail-open).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PolicyError {
    /// The file exists but cannot be read.
    Unreadable(String),
    /// The file is not valid JSON, or not an array of rules.
    Shape(String),
    /// Element `index` (0-based) is not a valid rule.
    Rule { index: usize, detail: String },
    /// The file has more than one hard link (`nlink > 1`): the same bytes are
    /// reachable under another name, so a plain write through that name would
    /// rewrite this policy in place — path checks cannot see hard links. A
    /// policy that another name can rewrite is refused, not served.
    Hardlinked(String),
    /// The command allowlist (`<state-dir>/allowlist.json`) is present but
    /// malformed. Surfaced through the SAME typed-refusal channel as a bad
    /// `policy.json` (fail closed, never silently ignored); the message is the
    /// `execpolicy::AllowlistError` display, already `HZ_PRECONDITION_FAILED`.
    Allowlist(String),
    /// The egress policy (`<state-dir>/egress.json`) is present but malformed.
    /// Same typed-refusal channel (fail closed, never silently ignored); the
    /// message is the `egress::EgressError` display, already
    /// `HZ_PRECONDITION_FAILED` (FEAT-003).
    Egress(String),
}

impl std::fmt::Display for PolicyError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            PolicyError::Unreadable(detail) => write!(
                f,
                "HZ_PRECONDITION_FAILED: policy.json cannot be read: {}",
                detail
            ),
            PolicyError::Shape(detail) => write!(
                f,
                "HZ_PRECONDITION_FAILED: policy.json is malformed: {}",
                detail
            ),
            PolicyError::Rule { index, detail } => write!(
                f,
                "HZ_PRECONDITION_FAILED: policy.json rule {} is malformed: {}",
                index, detail
            ),
            PolicyError::Hardlinked(path) => write!(
                f,
                "HZ_PRECONDITION_FAILED: {}: policy.json must have exactly one link (metadata nlink > 1); refusing to serve a policy another name can rewrite",
                path
            ),
            // The AllowlistError display is already a typed HZ_PRECONDITION_FAILED
            // string; pass it through verbatim so the bad-rule index survives.
            PolicyError::Allowlist(detail) => write!(f, "{}", detail),
            // The EgressError display is already a typed HZ_PRECONDITION_FAILED
            // string; pass it through verbatim.
            PolicyError::Egress(detail) => write!(f, "{}", detail),
        }
    }
}

impl std::error::Error for PolicyError {}

/// Validate the policy this state dir would serve, without keeping the rules:
/// the startup gate. `Ok(())` when absent or well formed.
pub fn validate_policy(state_dir: &Path) -> Result<(), PolicyError> {
    read_policy_rules(&state_dir.join("policy.json")).map(|_| ())
}

/// Read the rules of `path`; `Ok(None)` when the file is genuinely absent (the
/// built-in policy applies). Any other problem is a typed refusal.
fn read_policy_rules(path: &Path) -> Result<Option<Vec<PolicyRule>>, PolicyError> {
    let text = match fs::read_to_string(path) {
        Ok(text) => text,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(PolicyError::Unreadable(e.to_string())),
    };
    // The self-governance surface: a hardlinked policy.json is shared with
    // another name, and a plain (policy-allowed) write through that name would
    // rewrite the policy in place — no path check can see it. Refuse to serve
    // the policy while more than one link exists; removing the extra link
    // restores service.
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        let meta = fs::metadata(path).map_err(|e| PolicyError::Unreadable(e.to_string()))?;
        if meta.nlink() > 1 {
            return Err(PolicyError::Hardlinked(path.display().to_string()));
        }
    }
    let parsed: Value = serde_json::from_str(&text)
        .map_err(|e| PolicyError::Shape(format!("not valid JSON: {}", e)))?;
    let items = match parsed {
        Value::Array(items) => items,
        Value::Object(mut map) => match map.remove("rules") {
            Some(Value::Array(items)) => items,
            _ => {
                return Err(PolicyError::Shape(
                    "expected a JSON array of rules".to_string(),
                ))
            }
        },
        _ => {
            return Err(PolicyError::Shape(
                "expected a JSON array of rules".to_string(),
            ))
        }
    };
    let mut rules = Vec::with_capacity(items.len());
    for (index, item) in items.iter().enumerate() {
        rules.push(parse_rule(index, item)?);
    }
    Ok(Some(rules))
}

/// One rule; the index is carried into every error so the bad rule can be
/// named without guessing.
fn parse_rule(index: usize, item: &Value) -> Result<PolicyRule, PolicyError> {
    let invalid = |detail: String| PolicyError::Rule { index, detail };
    // A missing or non-string field fails here, naming the field.
    let rule: PolicyRule =
        serde_json::from_value(item.clone()).map_err(|e| invalid(e.to_string()))?;
    if !matches!(
        rule.kind.as_str(),
        "*" | "fs.read" | "fs.write" | "shell.exec" | "net.fetch" | "spawn" | "mcp.invoke"
    ) {
        return Err(invalid(format!("unknown kind {:?}", rule.kind)));
    }
    if !matches!(rule.scope.as_str(), "*" | "workspace" | "outside") {
        return Err(invalid(format!("unknown scope {:?}", rule.scope)));
    }
    if !matches!(rule.decision.as_str(), "allow" | "ask" | "deny") {
        return Err(invalid(format!("unknown decision {:?}", rule.decision)));
    }
    Ok(rule)
}

fn default_policy() -> Vec<PolicyRule> {
    DEFAULT_POLICY
        .iter()
        .map(|(kind, scope, decision)| PolicyRule {
            kind: (*kind).to_string(),
            scope: (*scope).to_string(),
            decision: (*decision).to_string(),
        })
        .collect()
}

/// Whether `lease` may speak for a caller identified by `session_id`.
///
/// An owner-less lease (the legacy wire shape, and every caller-supplied lease
/// from a client that does not carry a session id) is honoured for everyone —
/// documented legacy, kept for older clients. A lease with an owner is only
/// visible to a check that carries the same session id, which is what stops a
/// subagent child from inheriting its parent session's grant (docs/09
/// R-tools-32: children re-enter approval).
fn owner_visible_to_session(owner: &str, session_id: Option<&str>) -> bool {
    session_id
        .map(|id| id == owner || owner == format!("human:{id}"))
        .unwrap_or(false)
}

fn lease_visible_to(lease: &Lease, session_id: Option<&str>) -> bool {
    match &lease.owner {
        None => true,
        Some(owner) => owner_visible_to_session(owner, session_id),
    }
}

/// The same visibility rule for grants (see `lease_visible_to`).
fn grant_visible_to(grant: &Grant, session_id: Option<&str>) -> bool {
    match &grant.owner {
        None => true,
        Some(owner) => owner_visible_to_session(owner, session_id),
    }
}

/* ------------------------- protected path resolution ------------------------- */

/// `true` when `target` is `root` or resolves inside it.
///
/// Both sides are resolved through a lexical symlink walk (`resolve_lexical`)
/// that does not require any target to exist, so the answer cannot be evaded
/// with a lexical `..`, an absolute target, or a symlink — including a dangling
/// symlink whose target does not exist yet. If either walk fails (a link loop
/// beyond the hop limit, an unreadable component) the answer is `true`: this
/// rule only ever guards the kernel state directory, so failing closed means
/// refusing the write.
fn normalize_path_for_compare(path: &Path, case_insensitive: bool) -> String {
    let mut s = path.to_string_lossy().replace('\\', "/");
    while s.len() > 1 && s.ends_with('/') {
        // Keep drive roots like "C:/" intact.
        if s.len() == 3 && s.as_bytes()[1] == b':' {
            break;
        }
        s.pop();
    }
    if case_insensitive {
        s.to_ascii_lowercase()
    } else {
        s
    }
}

fn path_starts_with_case(target: &Path, root: &Path, case_insensitive: bool) -> bool {
    if !case_insensitive {
        return target == root || target.starts_with(root);
    }
    let t = normalize_path_for_compare(target, true);
    let r = normalize_path_for_compare(root, true);
    if t == r {
        return true;
    }
    if r.ends_with('/') {
        t.starts_with(&r)
    } else {
        t.starts_with(&r) && t.as_bytes().get(r.len()) == Some(&b'/')
    }
}

fn resolves_inside(root: &Path, target: &Path) -> bool {
    match (resolve_lexical(root), resolve_lexical(target)) {
        (Some(root), Some(target)) => path_starts_with_case(&target, &root, cfg!(windows)),
        _ => true,
    }
}

/// `true` when `target` resolves to `root` or a path under it. Unresolvable
/// paths return `false` (sandbox reads fail closed; unlike `resolves_inside`).
pub fn path_contained_in(root: &Path, target: &Path) -> bool {
    match (resolve_lexical(root), resolve_lexical(target)) {
        (Some(root), Some(target)) => path_starts_with_case(&target, &root, cfg!(windows)),
        _ => false,
    }
}

/// Lexical path resolution for sandbox reads (symlink-aware, no existence required).
pub fn lexical_resolve(path: &Path) -> Option<PathBuf> {
    resolve_lexical(path)
}

/// Strip shell quotes (`'` and `"`) and backslash escapes before non-slash
/// characters so quoted/escaped path spellings like `".hz"/state/kernel` or
/// `.hz/stat\e/kernel` collapse to `.hz/state/kernel`.
fn strip_shell_quoting(input: &str, preserve_backslash_as_slash: bool) -> String {
    let mut out = String::with_capacity(input.len());
    let mut chars = input.chars().peekable();
    while let Some(c) = chars.next() {
        match c {
            '"' | '\'' => {}
            '\\' => {
                if preserve_backslash_as_slash {
                    out.push('/');
                } else if let Some(next) = chars.next() {
                    out.push(next);
                }
            }
            _ => out.push(c),
        }
    }
    out
}

/// Simple POSIX-style glob matcher (`*`, `?`, `[abc]`) for path segments.
fn glob_segment_matches(pattern: &str, text: &str) -> bool {
    let p: Vec<char> = pattern.chars().collect();
    let t: Vec<char> = text.chars().collect();
    let (mut pi, mut ti) = (0usize, 0usize);
    let mut star_pi: Option<usize> = None;
    let mut star_ti: usize = 0;

    while ti < t.len() {
        if pi < p.len() && p[pi] == '*' {
            star_pi = Some(pi);
            star_ti = ti;
            pi += 1;
        } else if pi < p.len() && p[pi] == '?' {
            pi += 1;
            ti += 1;
        } else if pi < p.len() && p[pi] == '[' {
            if let Some(close_rel) = p[pi + 1..].iter().position(|&c| c == ']') {
                let class = &p[pi + 1..pi + 1 + close_rel];
                let ch = t[ti];
                let (negated, body) = if class.first() == Some(&'!') || class.first() == Some(&'^') {
                    (true, &class[1..])
                } else {
                    (false, class)
                };
                let mut matched = false;
                let mut i = 0;
                while i < body.len() {
                    if i + 2 < body.len() && body[i + 1] == '-' {
                        if ch >= body[i] && ch <= body[i + 2] {
                            matched = true;
                        }
                        i += 3;
                    } else {
                        if ch == body[i] {
                            matched = true;
                        }
                        i += 1;
                    }
                }
                if negated {
                    matched = !matched;
                }
                if matched {
                    pi += close_rel + 2;
                    ti += 1;
                } else if let Some(sp) = star_pi {
                    pi = sp + 1;
                    star_ti += 1;
                    ti = star_ti;
                } else {
                    return false;
                }
            } else if p[pi] == t[ti] {
                pi += 1;
                ti += 1;
            } else if let Some(sp) = star_pi {
                pi = sp + 1;
                star_ti += 1;
                ti = star_ti;
            } else {
                return false;
            }
        } else if pi < p.len() && p[pi] == t[ti] {
            pi += 1;
            ti += 1;
        } else if let Some(sp) = star_pi {
            pi = sp + 1;
            star_ti += 1;
            ti = star_ti;
        } else {
            return false;
        }
    }
    while pi < p.len() && p[pi] == '*' {
        pi += 1;
    }
    pi == p.len()
}

fn token_glob_matches_sequence(token: &str, target: &[&str]) -> bool {
    if !token.contains('*') && !token.contains('?') && !token.contains('[') {
        return false;
    }
    let segs: Vec<&str> = token.split('/').filter(|s| !s.is_empty()).collect();
    if segs.len() < target.len() {
        return false;
    }
    for win in segs.windows(target.len()) {
        // Require the first segment in the window to explicitly start with '.'
        // (e.g. `.hz`, `.h?`, `.hz*`, `.[h]z`) so generic globs like `*/*/*`
        // do not false-positive.
        if !win[0].starts_with('.') {
            continue;
        }
        if win
            .iter()
            .zip(target.iter())
            .all(|(pat, literal)| glob_segment_matches(pat, literal))
        {
            return true;
        }
    }
    false
}

fn shell_references_kernel_state_with_case(
    command: &str,
    state_dir: &Path,
    case_insensitive: bool,
) -> bool {
    let norm = |s: &str| -> String {
        let replaced = s.replace('\\', "/");
        if case_insensitive {
            replaced.to_ascii_lowercase()
        } else {
            replaced
        }
    };
    let cmd_slash = norm(command);
    let cmd_dequoted_slash = {
        let s = strip_shell_quoting(command, true);
        if case_insensitive {
            s.to_ascii_lowercase()
        } else {
            s
        }
    };
    let cmd_dequoted_unix = {
        let s = strip_shell_quoting(command, false);
        if case_insensitive {
            s.to_ascii_lowercase()
        } else {
            s
        }
    };

    let state_raw = normalize_path_for_compare(state_dir, case_insensitive);
    if !state_raw.is_empty()
        && (cmd_slash.contains(&state_raw)
            || cmd_dequoted_slash.contains(&state_raw)
            || cmd_dequoted_unix.contains(&state_raw))
    {
        return true;
    }
    if let Some(resolved) = resolve_lexical(state_dir) {
        let state_norm = normalize_path_for_compare(&resolved, case_insensitive);
        if !state_norm.is_empty()
            && (cmd_slash.contains(&state_norm)
                || cmd_dequoted_slash.contains(&state_norm)
                || cmd_dequoted_unix.contains(&state_norm))
        {
            return true;
        }
    }
    for candidate in [&cmd_slash, &cmd_dequoted_slash, &cmd_dequoted_unix] {
        if candidate.contains(".hz/state/kernel") || candidate.contains(".hzcode/kernel") {
            return true;
        }
        for token in candidate.split(|c: char| {
            c.is_whitespace() || matches!(c, ';' | '&' | '|' | '>' | '<' | '(' | ')' | '=')
        }) {
            if token_glob_matches_sequence(token, &[".hz", "state", "kernel"])
                || token_glob_matches_sequence(token, &[".hzcode", "kernel"])
            {
                return true;
            }
        }
    }
    false
}

/// Conservative shell-command scan: absolute state-dir substrings and the
/// canonical/legacy relative markers. Mirrors `shellCommandReferencesKernelState`
/// in the TypeScript transport (path-token resolution lives there; Rust catches
/// the common redirect spellings before allowlist/policy).
fn shell_references_kernel_state(command: &str, state_dir: &Path) -> bool {
    shell_references_kernel_state_with_case(command, state_dir, cfg!(windows))
}

/// `.hz/MEMORY.md` (or legacy `.hzcode/MEMORY.md`) beside the kernel state tree.
fn memory_manifest_path(state_dir: &Path) -> PathBuf {
    let parent = state_dir.parent().unwrap_or(state_dir);
    let hz_root = if parent.file_name().and_then(|n| n.to_str()) == Some("state") {
        parent.parent().unwrap_or(parent)
    } else {
        parent
    };
    hz_root.join("MEMORY.md")
}

fn is_memory_manifest_write(state_dir: &Path, target: &Path) -> bool {
    let manifest = memory_manifest_path(state_dir);
    let Some(manifest_resolved) = resolve_lexical(&manifest) else {
        return true;
    };
    let Some(target_resolved) = resolve_lexical(target) else {
        return false;
    };
    let Some(manifest_parent) = manifest_resolved.parent() else {
        return false;
    };
    if !path_starts_with_case(&target_resolved, manifest_parent, cfg!(windows)) {
        return false;
    }
    target_resolved
        .file_name()
        .and_then(|n| n.to_str())
        .map(|n| n.eq_ignore_ascii_case("memory.md"))
        .unwrap_or(false)
}

/// H6: paths whose CONTENT decides what code runs, what dependencies install,
/// or which credentials a process sees. A policy `allow` must never be enough to
/// rewrite one of these silently — a compromised or confused model could turn a
/// routine "edit a file" into arbitrary code execution (git hooks, CI workflows,
/// Makefile/Dockerfile) or credential exposure (`.env*`, shell profiles), and a
/// lockfile rewrite can redirect dependency resolution.
///
/// Matching is on the RESOLVED path (symlinks and `..` followed lexically, no
/// existence required), by basename for the single-file targets and by
/// component window for the directory-scoped ones, so `.git/hooks/pre-commit`
/// and `nested/repo/.github/workflows/ci.yml` are caught at any depth.
fn is_sensitive_write(target: &Path) -> bool {
    // Fail closed: an unresolvable path (e.g. symlink loop or unreadable
    // component) must require explicit approval rather than falling back to
    // un-resolved `absolutize`.
    let Some(resolved) = resolve_lexical(target) else {
        return true;
    };
    let parts: Vec<&str> = resolved
        .components()
        .filter_map(|component| match component {
            Component::Normal(name) => name.to_str(),
            _ => None,
        })
        .collect();

    for (index, part) in parts.iter().enumerate() {
        // `.git/hooks` and everything under it; `.git/config` exactly.
        if part.eq_ignore_ascii_case(".git") {
            match parts.get(index + 1) {
                Some(next) if next.eq_ignore_ascii_case("hooks") => return true,
                Some(next) if next.eq_ignore_ascii_case("config") && index + 2 == parts.len() => {
                    return true;
                }
                _ => {}
            }
        }
        // `.github/workflows` and everything under it.
        if part.eq_ignore_ascii_case(".github")
            && parts
                .get(index + 1)
                .is_some_and(|next| next.eq_ignore_ascii_case("workflows"))
        {
            return true;
        }
        // `.husky` directory and everything under it.
        if part.eq_ignore_ascii_case(".husky") {
            return true;
        }
        // `.vscode/tasks.json` executes arbitrary workspace tasks.
        if part.eq_ignore_ascii_case(".vscode")
            && parts
                .get(index + 1)
                .is_some_and(|next| next.eq_ignore_ascii_case("tasks.json"))
            && index + 2 == parts.len()
        {
            return true;
        }
    }

    let Some(base) = resolved.file_name().and_then(|name| name.to_str()) else {
        return false;
    };
    let base_lower = base.to_ascii_lowercase();
    if base_lower == ".env"
        || base_lower.starts_with(".env.")
        || base_lower == "dockerfile"
        || base_lower.starts_with("dockerfile.")
    {
        return true;
    }
    matches!(
        base_lower.as_str(),
        "package.json"
            | "package-lock.json"
            | "bun.lock"
            | "bun.lockb"
            | "pnpm-lock.yaml"
            | "yarn.lock"
            | "cargo.toml"
            | "cargo.lock"
            | "build.rs"
            | "pyproject.toml"
            | "docker-compose.yml"
            | "docker-compose.yaml"
            | ".gitlab-ci.yml"
            | "makefile"
            | "gnumakefile"
            | ".bashrc"
            | ".zshrc"
            | ".profile"
            | ".bash_profile"
            | ".zprofile"
            | ".zshenv"
            | ".npmrc"
            | ".pypirc"
            | ".netrc"
            | ".gitmodules"
            | ".gitconfig"
            | ".husky"
    )
}

/// The path made absolute against the process cwd (relative targets are how a
/// client sitting in the workspace spells them).
fn absolutize(path: &Path) -> PathBuf {
    if path.is_absolute() {
        path.to_path_buf()
    } else {
        env::current_dir()
            .unwrap_or_else(|_| PathBuf::from("."))
            .join(path)
    }
}

/// One typed step of a lexical path walk. Prefix must stay typed: on Windows a
/// bare `C:` component followed by a root reset would otherwise lose the drive.
#[derive(Debug, Clone)]
enum LexStep {
    Prefix(OsString),
    Root,
    Name(OsString),
}

/// Append a path's components to the back of the work queue.
fn enqueue_back(pending: &mut VecDeque<LexStep>, path: &Path) {
    for component in path.components() {
        match component {
            Component::Prefix(prefix) => {
                pending.push_back(LexStep::Prefix(prefix.as_os_str().to_os_string()))
            }
            Component::RootDir => pending.push_back(LexStep::Root),
            Component::Normal(name) => pending.push_back(LexStep::Name(name.to_os_string())),
            Component::ParentDir => pending.push_back(LexStep::Name(OsString::from(".."))),
            Component::CurDir => {}
        }
    }
}

/// Prepend a path's components to the front of the work queue (a symlink's
/// target is spliced in where the link was).
fn enqueue_front(pending: &mut VecDeque<LexStep>, path: &Path) {
    let mut parts: Vec<LexStep> = Vec::new();
    for component in path.components() {
        match component {
            Component::Prefix(prefix) => {
                parts.push(LexStep::Prefix(prefix.as_os_str().to_os_string()))
            }
            Component::RootDir => parts.push(LexStep::Root),
            Component::Normal(name) => parts.push(LexStep::Name(name.to_os_string())),
            Component::ParentDir => parts.push(LexStep::Name(OsString::from(".."))),
            Component::CurDir => {}
        }
    }
    for part in parts.into_iter().rev() {
        pending.push_front(part);
    }
}

/// Resolve a path to where it lexically lands by walking every component and
/// replacing each symlink with its target — WITHOUT requiring any target to
/// exist. A dangling link therefore resolves to what a write through it would
/// actually create (this is the confirmed bypass the old, canonicalize-based
/// resolver missed: `realpath` of a dangling link fails and the link's own
/// spelling was used instead of where it points).
///
/// Relative link targets resolve against the link's own directory; `..` is
/// applied after each hop (never above the root). After 40 symlink hops the
/// walk is refused (`None`). Any unreadable component also returns `None`, and
/// every caller treats that as a refusal.
fn resolve_lexical(path: &Path) -> Option<PathBuf> {
    const MAX_HOPS: usize = 40;
    let start = absolutize(path);
    let mut out = PathBuf::new();
    let mut prefix: Option<OsString> = None;
    let mut pending: VecDeque<LexStep> = VecDeque::new();
    enqueue_back(&mut pending, &start);

    let mut hops = 0usize;
    while let Some(step) = pending.pop_front() {
        match step {
            LexStep::Prefix(p) => {
                prefix = Some(p.clone());
                out = PathBuf::from(p);
                continue;
            }
            LexStep::Root => {
                // A root component restarts the walk at the filesystem root.
                // On Windows keep the drive prefix; dropping it made every
                // resolved absolute path relative (and failed absolute checks).
                out = match &prefix {
                    Some(p) => PathBuf::from(p).join(std::path::MAIN_SEPARATOR_STR),
                    None => PathBuf::from(std::path::MAIN_SEPARATOR_STR),
                };
                continue;
            }
            LexStep::Name(name) if name == OsStr::new("..") => {
                out.pop(); // never escapes the root: pop() is a no-op at "/"
                continue;
            }
            LexStep::Name(name) => {
                let name = name;
                let candidate = out.join(&name);
                match fs::symlink_metadata(&candidate) {
                    Ok(meta) if meta.file_type().is_symlink() => {
                        hops += 1;
                        if hops > MAX_HOPS {
                            return None; // a link loop (or an absurd chain)
                        }
                        let target = fs::read_link(&candidate).ok()?;
                        enqueue_front(&mut pending, &target);
                    }
                    Ok(_) => out = candidate,
                    // Not created yet: the remaining components can only be lexical.
                    Err(e) if e.kind() == std::io::ErrorKind::NotFound => out = candidate,
                    // Unreadable component (EACCES, ...): fail closed.
                    Err(_) => return None,
                }
            }
        }
    }
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[cfg(unix)]
    use std::os::unix::fs::symlink;

    fn scratch(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("hz-guard-{}-{}", tag, Uuid::new_v4()));
        fs::create_dir_all(&dir).expect("scratch dir");
        dir
    }

    fn write_decision(guard: &Guard, target: &Path) -> GuardDecision {
        guard
            .check(
                &GuardAction {
                    kind: "fs.write".to_string(),
                    target: target.display().to_string(),
                },
                Some("workspace"),
                &[],
                None,
            )
            .expect("policy")
    }

    #[test]
    fn pattern_matching_rules() {
        assert!(pattern_matches("*", "anything"));
        assert!(pattern_matches("echo *", "echo hi"));
        assert!(pattern_matches("/tmp/x", "/tmp/x"));
        assert!(!pattern_matches("/tmp/x", "/tmp/xy"));
        assert!(!pattern_matches("echo *", "cat echo hi"));
    }

    /// The confirmed bypass: `ln -s <state>/policy.json ws/link` where the link
    /// is dangling. The lexical walk resolves the link target without requiring
    /// it to exist, so the write is denied. A two-hop chain, a link to the state
    /// dir itself, a symlinked middle component, a relative target and a loop
    /// are all denied too; an ordinary workspace write stays governed by policy.
    #[cfg(unix)]
    #[test]
    fn lexical_resolution_denies_every_link_path_into_the_state_dir() {
        let state = scratch("state");
        let workspace = scratch("ws");
        fs::create_dir_all(state.join("events")).expect("state dirs");
        let guard = Guard::new(&state);
        // The default policy (no policy.json in the scratch state dir) governs
        // ordinary paths; the structural rule must still deny every link above.

        // 1. the exact repro: a dangling link to <state>/policy.json
        let dangling = workspace.join("link");
        symlink(state.join("policy.json"), &dangling).expect("dangling link");
        assert_eq!(write_decision(&guard, &dangling).decision, "deny");

        // 2. a two-hop link chain, both hops dangling
        let hop1 = workspace.join("hop1");
        let hop2 = workspace.join("hop2");
        symlink(&hop2, &hop1).expect("hop1");
        symlink(state.join("events/x.jsonl"), &hop2).expect("hop2");
        assert_eq!(write_decision(&guard, &hop1).decision, "deny");

        // 3. a symlink to the state dir itself
        let alias = workspace.join("state-alias");
        symlink(&state, &alias).expect("state alias");
        assert_eq!(write_decision(&guard, &alias).decision, "deny");

        // 4. a symlinked middle component
        assert_eq!(
            write_decision(&guard, &alias.join("policy.json")).decision,
            "deny"
        );

        // 5. a relative link target (`../../<state-name>/policy.json`)
        let nested = workspace.join("sub");
        fs::create_dir_all(&nested).expect("nested");
        let relative = nested.join("rel");
        let state_name = state.file_name().expect("state name");
        symlink(
            PathBuf::from("..")
                .join("..")
                .join(state_name)
                .join("policy.json"),
            &relative,
        )
        .expect("relative link");
        assert_eq!(write_decision(&guard, &relative).decision, "deny");

        // 6. a link loop is refused (fail closed)
        let loop_a = workspace.join("loop-a");
        let loop_b = workspace.join("loop-b");
        symlink(&loop_b, &loop_a).expect("loop a");
        symlink(&loop_a, &loop_b).expect("loop b");
        let decision = write_decision(&guard, &loop_a);
        assert_eq!(decision.decision, "deny");
        assert!(decision.reason.contains("kernel-state-protected"));

        // 7. ordinary workspace paths are untouched by the rule
        let inside = workspace.join("notes.txt");
        let inside_link = workspace.join("inside-link");
        symlink(&inside, &inside_link).expect("inside link");
        let decision = write_decision(&guard, &inside_link);
        assert_ne!(decision.decision, "deny", "{}", decision.reason);
        assert!(!decision.reason.contains("kernel-state-protected"));
        let _ = fs::remove_dir_all(&workspace);
        let _ = fs::remove_dir_all(&state);
    }

    #[test]
    fn shell_exec_naming_kernel_state_is_structurally_denied() {
        let state = scratch("state-shell");
        fs::create_dir_all(state.join("events")).expect("state dirs");
        let guard = Guard::new(&state);
        let action = GuardAction {
            kind: "shell.exec".to_string(),
            target: format!("echo x > {}/policy.json", state.display()),
        };
        let decision = guard
            .check(&action, Some("workspace"), &[], None)
            .expect("check");
        assert_eq!(decision.decision, "deny");
        assert!(decision.reason.contains("kernel-state-protected"));

        let relative = GuardAction {
            kind: "shell.exec".to_string(),
            target: "rm -rf .hz/state/kernel".to_string(),
        };
        let decision = guard
            .check(&relative, Some("workspace"), &[], None)
            .expect("check");
        assert_eq!(decision.decision, "deny");
        assert!(decision.reason.contains("kernel-state-protected"));

        let ok = GuardAction {
            kind: "shell.exec".to_string(),
            target: "echo hello".to_string(),
        };
        let decision = guard
            .check(&ok, Some("workspace"), &[], None)
            .expect("check");
        assert!(!decision.reason.contains("kernel-state-protected"));
        let _ = fs::remove_dir_all(&state);
    }

    /* ---------------------- H6: sensitive-write rule ---------------------- */

    /// A policy that allows every fs.write, whatever the scope. The sensitive
    /// rule must still force `ask`.
    fn write_allow_all_policy(state: &Path) {
        let rules = serde_json::json!([
            {"kind": "fs.write", "scope": "*", "decision": "allow"}
        ]);
        fs::write(state.join("policy.json"), rules.to_string()).expect("policy");
    }

    fn write_deny_all_policy(state: &Path) {
        let rules = serde_json::json!([
            {"kind": "fs.write", "scope": "*", "decision": "deny"}
        ]);
        fs::write(state.join("policy.json"), rules.to_string()).expect("policy");
    }

    #[cfg(unix)]
    #[test]
    fn sensitive_writes_ask_even_when_policy_allows() {
        let state = scratch("state-sensitive");
        let workspace = scratch("ws-sensitive");
        write_allow_all_policy(&state);
        let guard = Guard::new(&state);

        let sensitive = [
            ".git/hooks",
            ".git/hooks/pre-commit",
            ".git/hooks/post-checkout",
            ".git/config",
            ".env",
            ".env.local",
            ".env.production",
            "package.json",
            "nested/package.json",
            "package-lock.json",
            "bun.lock",
            "bun.lockb",
            "pnpm-lock.yaml",
            "yarn.lock",
            "Cargo.lock",
            ".github/workflows",
            ".github/workflows/ci.yml",
            "nested/repo/.github/workflows/release.yaml",
            ".gitlab-ci.yml",
            "Makefile",
            "Dockerfile",
            ".bashrc",
            ".zshrc",
            ".profile",
        ];
        for rel in sensitive {
            let decision = write_decision(&guard, &workspace.join(rel));
            assert_eq!(decision.decision, "ask", "{}: {}", rel, decision.reason);
            assert!(
                decision.reason.contains("sensitive-write"),
                "{}: {}",
                rel,
                decision.reason
            );
        }

        // Near-misses stay on the policy answer: only the listed names are
        // structural sensitive writes, not every `.env*`-looking or `.git*` name.
        let ordinary = [
            "src/main.rs",
            "README.md",
            ".gitignore",
            ".environment",
            ".envrc",
            "package.json.bak",
            "Makefile.in",
            ".github/ISSUE_TEMPLATE/bug.yml",
            "hooks/pre-commit",
            ".git/objects/ab",
        ];
        for rel in ordinary {
            let decision = write_decision(&guard, &workspace.join(rel));
            assert_eq!(decision.decision, "ask", "{}: {}", rel, decision.reason);
            assert!(decision.lease_id.as_deref().is_some_and(|s| !s.is_empty()), "{}: {}", rel, decision.reason);
        }

        // Unresolvable symlink loop fails closed in is_sensitive_write (never falls back to absolutize)
        let loop_a = workspace.join("sens-loop-a");
        let loop_b = workspace.join("sens-loop-b");
        symlink(&loop_b, &loop_a).expect("loop a");
        symlink(&loop_a, &loop_b).expect("loop b");
        assert!(is_sensitive_write(&loop_a), "symlink loop must fail closed as sensitive write");

        // Scope is irrelevant to the structural rule: an outside path asks too.
        let outside = scratch("outside-sensitive");
        let decision = guard
            .check(
                &GuardAction {
                    kind: "fs.write".to_string(),
                    target: outside.join(".env").display().to_string(),
                },
                Some("outside"),
                &[],
                None,
            )
            .expect("check");
        assert_eq!(decision.decision, "ask");
        assert!(decision.reason.contains("sensitive-write"));

        let _ = fs::remove_dir_all(&state);
        let _ = fs::remove_dir_all(&workspace);
        let _ = fs::remove_dir_all(&outside);
    }

    #[cfg(unix)]
    #[test]
    fn sensitive_write_cannot_be_waived_by_a_wildcard_lease_or_grant() {
        let state = scratch("state-sensitive-lease");
        let workspace = scratch("ws-sensitive-lease");
        write_allow_all_policy(&state);
        let guard = Guard::new(&state);

        let lease = guard.issue_lease("fs.write", "*", 60_000, None, None);
        let decision = write_decision(&guard, &workspace.join("package.json"));
        assert_eq!(decision.decision, "ask", "{}", decision.reason);
        assert!(decision.reason.contains("sensitive-write"));

        // Wildcard lease was not consumed by sensitive-write: ordinary write uses it.
        let ordinary = write_decision(&guard, &workspace.join("notes.txt"));
        assert_eq!(ordinary.decision, "ask", "{}", ordinary.reason);
        assert!(ordinary.lease_id.as_deref().is_some_and(|s| !s.is_empty()), "{}", ordinary.reason);
        assert!(
            ordinary.reason.contains(&lease.lease_id),
            "{}",
            ordinary.reason
        );

        // A grant is a pre-authorisation, not a bypass: it too cannot lift it.
        guard.issue_grant("fs.write", "*", 60_000, None, None);
        let decision = write_decision(&guard, &workspace.join(".env"));
        assert_eq!(decision.decision, "ask", "{}", decision.reason);
        assert!(decision.reason.contains("sensitive-write"));

        let _ = fs::remove_dir_all(&state);
        let _ = fs::remove_dir_all(&workspace);
    }

    #[cfg(unix)]
    #[test]
    fn sensitive_write_exact_human_lease_is_consumed_on_recheck() {
        let state = scratch("state-sensitive-exact");
        let workspace = scratch("ws-sensitive-exact");
        write_allow_all_policy(&state);
        let guard = Guard::new(&state);
        let target = workspace.join("package.json");
        let target_s = target.to_string_lossy().to_string();

        let ask = write_decision(&guard, &target);
        assert_eq!(ask.decision, "ask", "{}", ask.reason);
        assert!(ask.reason.contains("sensitive-write"));

        let lease = guard.issue_lease("fs.write", &target_s, 60_000, None, None);
        let allowed = write_decision(&guard, &target);
        assert_eq!(allowed.decision, "ask", "{}", allowed.reason);
        assert_eq!(allowed.lease_id.as_deref(), Some(lease.lease_id.as_str()));
        assert!(allowed.reason.contains("exact"), "{}", allowed.reason);

        // One-use: second check asks again.
        let again = write_decision(&guard, &target);
        assert_eq!(again.decision, "ask", "{}", again.reason);
        assert!(again.reason.contains("sensitive-write"));

        let _ = fs::remove_dir_all(&state);
        let _ = fs::remove_dir_all(&workspace);
    }

    #[cfg(unix)]
    #[test]
    fn caller_workspace_scope_cannot_widen_outside_target() {
        let state = scratch("state-scope-bypass");
        let workspace = scratch("ws-scope-bypass");
        // Default policy: fs.write@workspace=allow, fs.write@outside=ask.
        let mut guard = Guard::new(&state);
        let binding = crate::workspace_binding::WorkspaceBinding::capture(&workspace)
            .expect("workspace binding");
        guard.set_workspace_binding(Some(binding));

        let outside_dir = scratch("outside-scope-bypass");
        let outside = outside_dir.join("hosts");
        fs::write(&outside, "x").expect("outside file");
        let action = GuardAction {
            kind: "fs.write".to_string(),
            target: outside.to_string_lossy().to_string(),
        };
        // Caller fraudulently claims workspace — derived scope must be outside → ask.
        let decision = guard
            .check(&action, Some("workspace"), &[], None)
            .expect("check");
        assert_eq!(
            decision.decision, "ask",
            "outside target must ask under default policy, not allow: {}",
            decision.reason
        );
        let digest_workspace =
            intent_digest_hex(&action, "workspace", guard.workspace_binding.as_ref());
        let digest_outside =
            intent_digest_hex(&action, "outside", guard.workspace_binding.as_ref());
        assert_eq!(
            decision.intent_digest.as_deref(),
            Some(digest_outside.as_str())
        );
        assert_ne!(
            decision.intent_digest.as_deref(),
            Some(digest_workspace.as_str())
        );

        let _ = fs::remove_dir_all(&state);
        let _ = fs::remove_dir_all(&workspace);
        let _ = fs::remove_dir_all(&outside_dir);
    }

    #[cfg(unix)]
    #[test]
    fn policy_deny_still_beats_the_sensitive_ask() {
        let state = scratch("state-sensitive-deny");
        let workspace = scratch("ws-sensitive-deny");
        write_deny_all_policy(&state);
        let guard = Guard::new(&state);
        let decision = write_decision(&guard, &workspace.join(".env"));
        assert_eq!(decision.decision, "deny", "{}", decision.reason);
        assert!(
            decision.reason.contains("policy deny"),
            "{}",
            decision.reason
        );
        let _ = fs::remove_dir_all(&state);
        let _ = fs::remove_dir_all(&workspace);
    }

    #[cfg(unix)]
    #[test]
    fn sensitive_write_follows_symlinks_to_the_sensitive_target() {
        let state = scratch("state-sensitive-link");
        let workspace = scratch("ws-sensitive-link");
        write_allow_all_policy(&state);
        let guard = Guard::new(&state);

        // A link named innocuously, pointing at a sensitive basename.
        let real_pkg = workspace.join("package.json");
        fs::write(&real_pkg, "{}").expect("package.json");
        let link = workspace.join("innocent.txt");
        symlink(&real_pkg, &link).expect("link to package.json");
        let decision = write_decision(&guard, &link);
        assert_eq!(decision.decision, "ask", "{}", decision.reason);
        assert!(decision.reason.contains("sensitive-write"));

        let real_env = workspace.join(".env");
        fs::write(&real_env, "SECRET=1").expect(".env");
        let env_link = workspace.join("innocent-config");
        symlink(&real_env, &env_link).expect("link to .env");
        let decision = write_decision(&guard, &env_link);
        assert_eq!(decision.decision, "ask", "{}", decision.reason);
        assert!(decision.reason.contains("sensitive-write"));

        // A symlinked directory towards a .git/hooks tree.
        let repo = workspace.join("repo");
        fs::create_dir_all(repo.join(".git").join("hooks")).expect("hooks dir");
        let hooks_link = workspace.join("hooks-alias");
        symlink(repo.join(".git").join("hooks"), &hooks_link).expect("hooks link");
        let decision = write_decision(&guard, &hooks_link.join("pre-commit"));
        assert_eq!(decision.decision, "ask", "{}", decision.reason);
        assert!(decision.reason.contains("sensitive-write"));

        let _ = fs::remove_dir_all(&state);
        let _ = fs::remove_dir_all(&workspace);
    }

    #[cfg(unix)]
    #[test]
    fn kernel_state_deny_precedes_the_sensitive_rule() {
        let state = scratch("state-sensitive-kernel");
        write_allow_all_policy(&state);
        let guard = Guard::new(&state);
        let decision = write_decision(&guard, &state.join("policy.json"));
        assert_eq!(decision.decision, "deny", "{}", decision.reason);
        assert!(
            decision.reason.contains("kernel-state-protected"),
            "{}",
            decision.reason
        );
        let _ = fs::remove_dir_all(&state);
    }

    /* ---------------------- H-4: lease-on-allow ---------------------- */

    #[test]
    fn intent_digest_changes_when_workspace_binding_changes() {
        let state = scratch("state-intent-digest");
        fs::create_dir_all(state.join("events")).expect("state dirs");
        write_allow_all_policy(&state);
        let ws_a = scratch("ws-intent-a");
        let ws_b = scratch("ws-intent-b");
        let binding_a = crate::workspace_binding::WorkspaceBinding::capture(&ws_a).unwrap();
        let binding_b = crate::workspace_binding::WorkspaceBinding::capture(&ws_b).unwrap();
        let mut guard = Guard::new(&state);
        guard.set_workspace_binding(Some(binding_a.clone()));
        let target = ws_a.join("note.txt");
        let a = write_decision(&guard, &target);
        assert!(a.intent_digest.is_some(), "{a:?}");
        assert_eq!(
            a.workspace_binding.as_ref().map(|b| b.inode),
            Some(binding_a.inode)
        );
        guard.set_workspace_binding(Some(binding_b.clone()));
        let b = write_decision(&guard, &target);
        assert_ne!(
            a.intent_digest, b.intent_digest,
            "digest must cover workspace identity"
        );
        let _ = fs::remove_dir_all(&state);
        let _ = fs::remove_dir_all(&ws_a);
        let _ = fs::remove_dir_all(&ws_b);
    }

    #[test]
    fn policy_allow_mints_distinct_one_use_lease_citations() {
        let state = scratch("state-lease-on-allow");
        fs::create_dir_all(state.join("events")).expect("state dirs");
        write_allow_all_policy(&state);
        let guard = Guard::new(&state);
        let ws = scratch("ws-lease-on-allow");
        let target = ws.join("note.txt");
        let a = write_decision(&guard, &target);
        let b = write_decision(&guard, &target);
        assert_eq!(a.decision, "ask", "{}", a.reason);
        assert_eq!(b.decision, "ask", "{}", b.reason);
        let la = a.lease_id.expect("first allow mints lease");
        let lb = b.lease_id.expect("second allow mints lease");
        assert_ne!(la, lb, "each allow must mint a fresh citation");
        assert!(a.reason.contains("minted one-use lease"), "{}", a.reason);
        // Mints are not held: a third check still comes from policy allow
        // (reason), not "lease … (consumed)".
        let c = write_decision(&guard, &target);
        assert!(c.reason.contains("policy allow"), "{}", c.reason);
        assert!(!c.reason.contains("(consumed)"), "{}", c.reason);
        let _ = fs::remove_dir_all(&state);
        let _ = fs::remove_dir_all(&ws);
    }

    #[test]
    fn g1_wire_projects_allow_to_ask_with_lease_citation() {
        // G1 / ruling 637 (owner-approved breaking removal of "allow"): decision is always Ask/Deny-only.
        let state = scratch("state-g1-wire");
        fs::create_dir_all(state.join("events")).expect("state dirs");
        write_allow_all_policy(&state);
        let guard = Guard::new(&state);
        let ws = scratch("ws-g1-wire");
        let allowed = write_decision(&guard, &ws.join("ok.txt"));
        assert_eq!(allowed.decision, "ask");
        assert_eq!(allowed.g1_decision(), "ask");
        assert!(allowed.lease_id.is_some());
        let json = allowed.to_json();
        assert_eq!(json["decision"], json!("ask"));
        assert_eq!(json["g1"], json!("ask"));
        assert!(json.get("leaseId").is_some());
        write_deny_all_policy(&state);
        let guard_deny = Guard::new(&state);
        let denied = write_decision(&guard_deny, &ws.join("no.txt"));
        assert_eq!(denied.decision, "deny");
        assert_eq!(denied.g1_decision(), "deny");
        assert_eq!(denied.to_json()["g1"], json!("deny"));
        let _ = fs::remove_dir_all(&state);
        let _ = fs::remove_dir_all(&ws);
    }

    #[test]
    fn g1_wire_v2_projects_decision_when_hz_guard_g1_wire_set() {
        let state = scratch("state-g1-wire-v2");
        fs::create_dir_all(state.join("events")).expect("state dirs");
        write_allow_all_policy(&state);
        let guard = Guard::new(&state);
        let ws = scratch("ws-g1-wire-v2");
        let allowed = write_decision(&guard, &ws.join("ok.txt"));
        let prev = std::env::var("HZ_GUARD_G1_WIRE").ok();
        std::env::set_var("HZ_GUARD_G1_WIRE", "1");
        let json = allowed.to_json();
        if let Some(p) = prev {
            std::env::set_var("HZ_GUARD_G1_WIRE", p);
        } else {
            std::env::remove_var("HZ_GUARD_G1_WIRE");
        }
        assert_eq!(allowed.decision, "ask");
        assert_eq!(json["decision"], json!("ask"));
        assert_eq!(json["g1"], json!("ask"));
        assert!(json.get("leaseId").is_some());
        let _ = fs::remove_dir_all(&state);
        let _ = fs::remove_dir_all(&ws);
    }

    #[test]
    fn human_approval_owner_visible_to_matching_session() {
        let state = scratch("state-human-owner");
        fs::create_dir_all(state.join("events")).expect("state dirs");
        write_allow_all_policy(&state);
        let guard = Guard::new(&state);
        let ws = scratch("ws-human-owner");
        let target = ws.join("x.txt").to_string_lossy().to_string();
        let lease = guard.issue_lease(
            "fs.write",
            &target,
            60_000,
            Some("human:sess-9".into()),
            Some("human".into()),
        );
        assert_eq!(lease.principal.as_deref(), Some("human"));
        let ok = guard
            .check(
                &GuardAction {
                    kind: "fs.write".into(),
                    target: target.clone(),
                },
                Some("workspace"),
                &[],
                Some("sess-9"),
            )
            .expect("check");
        assert_eq!(ok.decision, "ask");
        assert_eq!(ok.lease_id.as_deref(), Some(lease.lease_id.as_str()));
        let _ = fs::remove_dir_all(&state);
        let _ = fs::remove_dir_all(&ws);
    }

    #[test]
    fn g1_wire_v2_off_keeps_frozen_allow_on_decision_field() {
        // Owner-approved G1 breaking removal: decision is always "ask" + leaseId even when HZ_GUARD_G1_WIRE is unset.
        let state = scratch("state-g1-wire-legacy");
        fs::create_dir_all(state.join("events")).expect("state dirs");
        write_allow_all_policy(&state);
        let guard = Guard::new(&state);
        let ws = scratch("ws-g1-wire-legacy");
        let allowed = write_decision(&guard, &ws.join("ok.txt"));
        let prev = std::env::var("HZ_GUARD_G1_WIRE").ok();
        std::env::remove_var("HZ_GUARD_G1_WIRE");
        let json = allowed.to_json();
        if let Some(p) = prev {
            std::env::set_var("HZ_GUARD_G1_WIRE", p);
        }
        assert_eq!(json["decision"], json!("ask"));
        assert_eq!(json["g1"], json!("ask"));
        assert!(json["leaseId"].as_str().is_some_and(|s| !s.is_empty()));
        let _ = fs::remove_dir_all(&state);
        let _ = fs::remove_dir_all(&ws);
    }

    #[cfg(unix)]
    #[test]
    fn held_lease_refuses_after_workspace_rename_swap() {
        // H-31 / ruling 636: a held lease stamped with (dev,ino) must not
        // admit after the bound root is rename-swapped to a different inode.
        let parent = scratch("lease-revalidate-parent");
        let state = parent.join("state");
        let ws = parent.join("ws");
        let decoy = parent.join("decoy");
        fs::create_dir_all(state.join("events")).unwrap();
        fs::create_dir_all(&ws).unwrap();
        fs::create_dir_all(&decoy).unwrap();
        write_allow_all_policy(&state);
        let binding = crate::workspace_binding::WorkspaceBinding::capture(&ws).unwrap();
        let mut guard = Guard::new(&state);
        guard.set_workspace_binding(Some(binding));
        let target = ws.join("note.txt");
        fs::write(&target, "ok").unwrap();
        let lease = guard.issue_lease(
            "fs.write",
            &target.to_string_lossy(),
            60_000,
            Some("s1".into()),
            None,
        );
        assert!(
            lease.workspace_binding.is_some(),
            "issued lease must stamp workspace binding"
        );
        // Rename-swap the workspace root (rmdir+mkdir often reuses inodes).
        fs::rename(&ws, parent.join("ws.old")).unwrap();
        fs::rename(&decoy, &ws).unwrap();
        fs::write(&target, "swapped").unwrap();
        let decision = guard
            .check(
                &GuardAction {
                    kind: "fs.write".to_string(),
                    target: target.to_string_lossy().into_owned(),
                },
                Some("workspace"),
                &[],
                Some("s1"),
            )
            .expect("check");
        // Policy may still mint a *fresh* allow citation; the burned held lease
        // must not appear as the authorizing token.
        assert!(
            !decision.reason.contains(&lease.lease_id),
            "stale held lease must not authorize after remount; got {}",
            decision.reason
        );
        assert!(
            !decision.reason.contains("(consumed)"),
            "must not consume under swapped identity: {}",
            decision.reason
        );
        let _ = fs::remove_dir_all(&parent);
    }

    #[test]
    fn execpolicy_allow_rejects_shell_control_metacharacters() {
        let dir = scratch("execpolicy-metachar");
        fs::create_dir_all(&dir).unwrap();
        let allowlist = r#"[{"program":"git","args":["status"],"decision":"allow"}]"#;
        fs::write(dir.join(execpolicy::ALLOWLIST_FILE), allowlist).unwrap();
        let guard = Guard::new(&dir);

        let plain = guard
            .check(
                &GuardAction {
                    kind: "shell.exec".to_string(),
                    target: "git status".to_string(),
                },
                Some("workspace"),
                &[],
                None,
            )
            .unwrap();
        assert_eq!(plain.decision, "ask", "plain allowlisted command should admit via G1 ask + lease");
        assert!(plain.lease_id.as_deref().is_some_and(|s| !s.is_empty()), "plain allowlisted command must mint leaseId");

        for compound in [
            "git status; rm -rf /",
            "git status && id",
            "git status | cat",
            "git status `id`",
            "git status $(id)",
            "git status > /tmp/pwn",
            "git status < /etc/passwd",
            "git status\nid",
            "git status\rid",
            "git status 'foo'",
            "git status \"foo\"",
            "git status \\n",
        ] {
            let decision = guard
                .check(
                    &GuardAction {
                        kind: "shell.exec".to_string(),
                        target: compound.to_string(),
                    },
                    Some("workspace"),
                    &[],
                    None,
                )
                .unwrap();
            assert_eq!(
                decision.decision, "ask",
                "compound command {:?} must fall through to ask, got {:?}",
                compound, decision
            );
        }
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn is_sensitive_write_is_case_insensitive_and_covers_new_dotfiles() {
        for p in [
            "/ws/MAKEFILE",
            "/ws/Dockerfile",
            "/ws/DOCKERFILE",
            "/ws/CARGO.LOCK",
            "/ws/.ENV",
            "/ws/.Env.local",
            "/ws/.GIT/HOOKS/pre-commit",
            "/ws/.GIT/CONFIG",
            "/ws/.GITHUB/WORKFLOWS/ci.yml",
            "/ws/.npmrc",
            "/ws/.NPMRC",
            "/ws/.pypirc",
            "/ws/.netrc",
            "/ws/.gitmodules",
            "/ws/.husky/pre-commit",
            "/ws/.HUSKY/commit-msg",
            "/ws/.bash_profile",
            "/ws/.zprofile",
            "/ws/.zshenv",
        ] {
            assert!(
                is_sensitive_write(Path::new(p)),
                "expected sensitive write for {p}"
            );
        }
        assert!(!is_sensitive_write(Path::new("/ws/src/main.rs")));
    }
}

#[cfg(test)]
mod track1_hardening_tests {
    use super::*;
    use std::fs;

    fn unique_scratch(tag: &str) -> PathBuf {
        let dir = env::temp_dir().join(format!(
            "hz-guard-track1-{}-{}",
            tag,
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).expect("scratch dir");
        dir
    }

    #[cfg(unix)]
    #[test]
    fn p1_1_memory_manifest_blocks_symlink_alias_existing_and_dangling() {
        use std::os::unix::fs::symlink;

        let root = unique_scratch("mem-symlink");
        let state_dir = root.join(".hz").join("state").join("kernel");
        fs::create_dir_all(&state_dir).unwrap();
        let manifest = root.join(".hz").join("MEMORY.md");

        // Dangling symlink notes.txt -> .hz/MEMORY.md must be caught.
        let dangling_alias = root.join("notes.txt");
        symlink(&manifest, &dangling_alias).unwrap();
        assert!(
            is_memory_manifest_write(&state_dir, &dangling_alias),
            "dangling symlink to .hz/MEMORY.md must be blocked"
        );

        // Existing target symlink notes2.txt -> .hz/MEMORY.md must also be caught.
        fs::write(&manifest, "# memory\n").unwrap();
        let existing_alias = root.join("notes2.txt");
        symlink(&manifest, &existing_alias).unwrap();
        assert!(
            is_memory_manifest_write(&state_dir, &existing_alias),
            "existing symlink to .hz/MEMORY.md must be blocked"
        );

        // Unrelated file in workspace must not trigger.
        let benign = root.join("plain.txt");
        fs::write(&benign, "ok").unwrap();
        assert!(!is_memory_manifest_write(&state_dir, &benign));

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn p1_2_and_p2_sensitive_write_covers_build_container_vscode_and_gitconfig() {
        let root = unique_scratch("sensitive-writes");
        let sensitive = [
            root.join("GNUmakefile"),
            root.join("Cargo.toml"),
            root.join("build.rs"),
            root.join("pyproject.toml"),
            root.join("Dockerfile.prod"),
            root.join("Dockerfile.dev"),
            root.join("docker-compose.yml"),
            root.join(".vscode").join("tasks.json"),
            root.join(".gitconfig"),
        ];
        for path in &sensitive {
            assert!(
                is_sensitive_write(path),
                "expected sensitive write protection for {}",
                path.display()
            );
        }
        assert!(!is_sensitive_write(&root.join("src").join("lib.rs")));
        assert!(!is_sensitive_write(&root.join(".vscode").join("settings.json")));
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn p1_3_kernel_state_protected_handles_windows_case_drives_quotes_and_globs() {
        let win_state = Path::new(r"C:\Users\Alice\Repo\.hz\state\kernel");
        // Case-insensitive path containment with mixed slashes and drive casing.
        assert!(path_starts_with_case(
            Path::new(r"c:/users/alice/repo/.hz/state/kernel/policy.json"),
            win_state,
            true
        ));
        assert!(path_starts_with_case(
            Path::new(r"C:\USERS\ALICE\REPO\.HZ\STATE\KERNEL\events.jsonl"),
            win_state,
            true
        ));
        assert!(!path_starts_with_case(
            Path::new(r"C:\Users\Alice\Repo\.hz\state\kernel2\policy.json"),
            win_state,
            true
        ));

        // Shell checks: case-insensitive Windows drive paths.
        assert!(shell_references_kernel_state_with_case(
            r"type C:\USERS\ALICE\REPO\.HZ\STATE\KERNEL\policy.json",
            win_state,
            true
        ));
        assert!(shell_references_kernel_state_with_case(
            r"cat c:/users/alice/repo/.hz/state/kernel/policy.json",
            win_state,
            true
        ));

        // Quoted / escaped references to .hz/state/kernel.
        let unix_state = Path::new("/tmp/ws/.hz/state/kernel");
        assert!(shell_references_kernel_state_with_case(
            r#"cat ".hz"/state/kernel/policy.json"#,
            unix_state,
            false
        ));
        assert!(shell_references_kernel_state_with_case(
            r#"echo x > .hz/'state'/"kernel"/policy.json"#,
            unix_state,
            false
        ));
        assert!(shell_references_kernel_state_with_case(
            r#"cat .hz/stat\e/kernel/policy.json"#,
            unix_state,
            false
        ));

        // Globbed references to .hz/state/kernel.
        assert!(shell_references_kernel_state_with_case(
            "cat .hz/state/kern*/policy.json",
            unix_state,
            false
        ));
        assert!(shell_references_kernel_state_with_case(
            "rm -rf .hz/*/kernel",
            unix_state,
            false
        ));
        assert!(shell_references_kernel_state_with_case(
            "cat .hz/stat?/k[e]rnel/policy.json",
            unix_state,
            false
        ));
        assert!(shell_references_kernel_state_with_case(
            "rm -rf .hz/state/*",
            unix_state,
            false
        ));

        // Non-matching benign commands must not false-positive.
        assert!(!shell_references_kernel_state_with_case(
            "ls -la src/*.rs",
            unix_state,
            false
        ));
        assert!(!shell_references_kernel_state_with_case(
            "echo */*/*",
            unix_state,
            false
        ));
    }
}
