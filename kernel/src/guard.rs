//! Guard: authority evaluation (deny > lease > ask > allow) plus in-memory leases.
//!
//! Policy comes from `<state-dir>/policy.json` when present and well formed,
//! otherwise from `DEFAULT_POLICY` (replicated verbatim from contracts.ts).
//!
//! Evaluation, per docs/11-authority-safety.md R1 (deny > ask > allow):
//!   0. a structural, hard-coded rule denies any `fs.write` whose target
//!      resolves inside the kernel state directory (`kernel-state-protected`);
//!      it is evaluated before policy rules and leases and cannot be lifted by
//!      policy.json (the model must never be able to rewrite its own policy);
//!   1. any matching `deny` rule wins;
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
}

/// The action kinds this kernel's guard vocabulary knows. The protocol refuses
/// anything else before evaluation: the structural state-dir rule below is keyed
/// to the exact mutating kind (`fs.write`), so an unrecognised kind (say a raw
/// client's `fs.edit`) would otherwise reach the policy as an unknown rule and
/// land on the fallback answer. Keep this list in step with `parse_rule` and
/// the TS `GuardKind`.
pub const KNOWN_KINDS: [&str; 6] = ["fs.read", "fs.write", "shell.exec", "net.fetch", "spawn", "mcp.invoke"];

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
}

impl GuardDecision {
    pub fn to_json(&self) -> Value {
        let mut out = json!({ "decision": self.decision, "reason": self.reason });
        if let (Some(lease_id), Value::Object(map)) = (&self.lease_id, &mut out) {
            map.insert("leaseId".to_string(), json!(lease_id));
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
}

impl Guard {
    pub fn new(state_dir: &Path) -> Self {
        Guard {
            policy_path: state_dir.join("policy.json"),
            state_dir: state_dir.to_path_buf(),
            leases: Mutex::new(Vec::new()),
            grants: Mutex::new(Vec::new()),
        }
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

    pub fn check(
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
            });
        }

        // Structural rule, evaluated before policy rules and leases: the kernel
        // state directory holds the policy, the event log and the receipts, so
        // no fs.write may ever target it — a policy that says otherwise is
        // itself part of what this rule protects. It cannot be lifted by
        // policy.json, a caller-supplied lease, or a held lease.
        // NOTE: keyed to `fs.write`, the only mutating kind shipped. Any future
        // mutating kind must be added HERE as well as to KNOWN_KINDS.
        if action.kind == "fs.write" && resolves_inside(&self.state_dir, Path::new(&action.target)) {
            return Ok(GuardDecision {
                decision: "deny".to_string(),
                reason: format!(
                    "kernel-state-protected: {} resolves inside the kernel state directory",
                    action.target
                ),
                lease_id: None,
            });
        }

        // Command allowlist (FEAT-002, docs/11 R1): for shell.exec ONLY, consult
        // the declarative allowlist BEFORE the policy rules so an allowlist
        // `deny` wins (R1) and an allowlist `allow` can admit. A non-match or an
        // `ask` returns `None`/`Ask` and falls through to the EXISTING flow
        // unchanged — so shell.exec with no allowlist file present behaves
        // EXACTLY as today (ask). A malformed allowlist is a typed refusal
        // (fail closed), never silently ignored.
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
                            });
                        }
                        Some(Decision::Allow) => {
                            return Ok(GuardDecision {
                                decision: "allow".to_string(),
                                reason: format!(
                                    "allowlist allow: {} matches an allow rule (fingerprint {})",
                                    action.target,
                                    policy.fingerprint()
                                ),
                                lease_id: None,
                            });
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
        // flow (AllowAndRecord additionally carries a content-free record note in
        // the reason). An unparseable target is a DENY candidate (fail closed).
        // A malformed egress.json is a typed refusal (fail closed), never
        // silently ignored.
        //
        // Spawn-with-network intent is NOT cleanly derivable from a spawn
        // target here, so this consult is scoped to net.fetch; spawn-with-network
        // is a documented follow-up (docs/28 ruling 41).
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
                        });
                    }
                    egress::EgressDecision::Allow => {
                        return Ok(GuardDecision {
                            decision: "allow".to_string(),
                            reason: format!("egress allow: {} matches an allow rule", origin_label),
                            lease_id: None,
                        });
                    }
                    egress::EgressDecision::AllowAndRecord { would } => {
                        // observe mode: ADMIT at the decider, but do not short-
                        // circuit policy; fall through carrying a content-free
                        // record note (host+port+outcome only, NO path/headers/
                        // body). The policy-layer answer (ask, by default) stands.
                        // Recorded in the reason so the surface sees what enforce
                        // mode would have done.
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
            });
        }

        // Only leases this kernel issued are honoured (the held table). A
        // caller-supplied lease is a claim, not a mint: a raw client echoing
        // back `{leaseId, kind, pattern, expiry}` must not unlock anything it
        // was not issued. `caller_leases` stays in the signature for wire
        // compatibility (the protocol still validates its shape) and is
        // deliberately ignored here.
        let _ = caller_leases;
        // docs/11 L1 reduced form: a lease is consumed at most once. The first
        // matching check takes the lease OUT of the held table and returns its
        // id with the allow; a second identical action finds no lease and falls
        // back to policy (ask) or a grant — never to the spent lease.
        if let Some(lease) = self.take_matching_lease(action, session_id, now_ms) {
            return Ok(GuardDecision {
                decision: "allow".to_string(),
                reason: format!(
                    "lease {} ({}) covers {} on {} (consumed)",
                    lease.lease_id, lease.pattern, action.kind, action.target
                ),
                lease_id: Some(lease.lease_id),
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
                    decision: "allow".to_string(),
                    reason: format!(
                        "grant {} covers {} on {} (minted one-use lease {})",
                        grant.lease_id, action.kind, action.target, lease.lease_id
                    ),
                    lease_id: Some(lease.lease_id),
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
            });
        }

        if let Some(allow) = matching.iter().find(|rule| rule.decision == "allow") {
            return Ok(GuardDecision {
                decision: "allow".to_string(),
                reason: format!(
                    "policy allow: {} @ {} (action {} on {})",
                    allow.kind, allow.scope, action.kind, action.target
                ),
                lease_id: None,
            });
        }

        Ok(GuardDecision {
            decision: "ask".to_string(),
            reason: format!(
                "no allow rule or lease for {} @ {} (action {} on {})",
                action.kind, scope, action.kind, action.target
            ),
            lease_id: None,
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
    pub fn issue_lease(&self, kind: &str, pattern: &str, ttl_ms: u64, owner: Option<String>) -> Lease {
        let lease = Lease {
            lease_id: Uuid::new_v4().to_string(),
            kind: kind.to_string(),
            pattern: pattern.to_string(),
            expiry: iso_from_unix_millis(now_millis() + clamped_ttl(ttl_ms)),
            owner,
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
    pub fn issue_grant(&self, kind: &str, pattern: &str, ttl_ms: u64, owner: Option<String>) -> Grant {
        let grant = Grant {
            lease_id: Uuid::new_v4().to_string(),
            kind: kind.to_string(),
            pattern: pattern.to_string(),
            expiry: iso_from_unix_millis(now_millis() + clamped_ttl(ttl_ms)),
            owner,
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
    fn take_matching_lease(&self, action: &GuardAction, session_id: Option<&str>, now_ms: i64) -> Option<Lease> {
        let mut held = self.leases.lock().ok()?;
        held.retain(|lease| !lease.is_expired(now_ms));
        let index = held.iter().position(|lease| {
            lease_visible_to(lease, session_id)
                && lease.kind == action.kind
                && pattern_matches(&lease.pattern, &action.target)
        })?;
        Some(held.remove(index))
    }

    /// The newest active, visible, matching grant, if any. Grants are never
    /// removed by a check — they are pre-authorisations, not tokens.
    fn matching_grant(&self, action: &GuardAction, session_id: Option<&str>, now_ms: i64) -> Option<Grant> {
        let held = self.grants.lock().ok()?;
        held.iter()
            .filter(|grant| {
                !grant.is_expired(now_ms)
                    && grant_visible_to(grant, session_id)
                    && grant.kind == action.kind
                    && pattern_matches(&grant.pattern, &action.target)
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
        }
    }
}

fn rule_answer_matches(rule: &PolicyRule, kind: &str, scope: &str) -> bool {
    (rule.kind == kind || rule.kind == "*") && (rule.scope == scope || rule.scope == "*")
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
            _ => return Err(PolicyError::Shape("expected a JSON array of rules".to_string())),
        },
        _ => return Err(PolicyError::Shape("expected a JSON array of rules".to_string())),
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
    let rule: PolicyRule = serde_json::from_value(item.clone())
        .map_err(|e| invalid(e.to_string()))?;
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
fn lease_visible_to(lease: &Lease, session_id: Option<&str>) -> bool {
    match &lease.owner {
        None => true,
        Some(owner) => session_id.map(|id| id == owner).unwrap_or(false),
    }
}

/// The same visibility rule for grants (see `lease_visible_to`).
fn grant_visible_to(grant: &Grant, session_id: Option<&str>) -> bool {
    match &grant.owner {
        None => true,
        Some(owner) => session_id.map(|id| id == owner).unwrap_or(false),
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
fn resolves_inside(root: &Path, target: &Path) -> bool {
    match (resolve_lexical(root), resolve_lexical(target)) {
        (Some(root), Some(target)) => target == root || target.starts_with(&root),
        _ => true,
    }
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

/// Append a path's components to the back of the work queue.
fn enqueue_back(pending: &mut VecDeque<OsString>, path: &Path) {
    for component in path.components() {
        match component {
            Component::Prefix(prefix) => pending.push_back(prefix.as_os_str().to_os_string()),
            Component::RootDir => {
                pending.push_back(OsString::from(std::path::MAIN_SEPARATOR_STR))
            }
            Component::Normal(name) => pending.push_back(name.to_os_string()),
            Component::ParentDir => pending.push_back(OsString::from("..")),
            Component::CurDir => {}
        }
    }
}

/// Prepend a path's components to the front of the work queue (a symlink's
/// target is spliced in where the link was).
fn enqueue_front(pending: &mut VecDeque<OsString>, path: &Path) {
    let mut parts: Vec<OsString> = Vec::new();
    for component in path.components() {
        match component {
            Component::Prefix(prefix) => parts.push(prefix.as_os_str().to_os_string()),
            Component::RootDir => parts.push(OsString::from(std::path::MAIN_SEPARATOR_STR)),
            Component::Normal(name) => parts.push(name.to_os_string()),
            Component::ParentDir => parts.push(OsString::from("..")),
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
    let mut pending: VecDeque<OsString> = VecDeque::new();
    enqueue_back(&mut pending, &start);

    let mut hops = 0usize;
    while let Some(name) = pending.pop_front() {
        if name == OsStr::new(std::path::MAIN_SEPARATOR_STR) {
            // A root component restarts the walk at the filesystem root (this is
            // how an absolute symlink target is spliced in).
            out = PathBuf::from(std::path::MAIN_SEPARATOR_STR);
            continue;
        }
        if name == OsStr::new("..") {
            out.pop(); // never escapes the root: pop() is a no-op at "/"
            continue;
        }
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

    #[cfg(unix)]
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
        assert_eq!(write_decision(&guard, &alias.join("policy.json")).decision, "deny");

        // 5. a relative link target (`../../<state-name>/policy.json`)
        let nested = workspace.join("sub");
        fs::create_dir_all(&nested).expect("nested");
        let relative = nested.join("rel");
        let state_name = state.file_name().expect("state name");
        symlink(
            PathBuf::from("..").join("..").join(state_name).join("policy.json"),
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
}
