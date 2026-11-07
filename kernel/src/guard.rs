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

use std::env;
use std::ffi::OsString;
use std::fs;
use std::path::{Component, Path, PathBuf};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use uuid::Uuid;

use crate::time::{iso_from_unix_millis, now_millis, parse_iso_millis};

type Rule = (&'static str, &'static str, &'static str);

/// Built-in policy used when `<state-dir>/policy.json` is absent.
pub const DEFAULT_POLICY: [Rule; 7] = [
    ("fs.read", "workspace", "allow"),
    ("fs.write", "workspace", "allow"),
    ("fs.read", "outside", "ask"),
    ("fs.write", "outside", "ask"),
    ("shell.exec", "*", "ask"),
    ("net.fetch", "*", "ask"),
    ("spawn", "*", "ask"),
];

const MAX_LEASES: usize = 1024;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Lease {
    pub lease_id: String,
    pub kind: String,
    pub pattern: String,
    /// ISO-8601 UTC.
    pub expiry: String,
}

impl Lease {
    pub fn is_expired(&self, now_ms: i64) -> bool {
        match parse_iso_millis(&self.expiry) {
            Some(expiry) => expiry <= now_ms,
            None => true, // unparseable expiry never grants authority
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

pub struct Guard {
    policy_path: PathBuf,
    state_dir: PathBuf,
    leases: Mutex<Vec<Lease>>,
}

impl Guard {
    pub fn new(state_dir: &Path) -> Self {
        Guard {
            policy_path: state_dir.join("policy.json"),
            state_dir: state_dir.to_path_buf(),
            leases: Mutex::new(Vec::new()),
        }
    }

    /// Loaded fresh on every check so policy edits apply without a restart.
    pub fn policy(&self) -> Vec<PolicyRule> {
        if let Ok(text) = fs::read_to_string(&self.policy_path) {
            if let Ok(Value::Array(items)) = serde_json::from_str::<Value>(&text) {
                let rules: Vec<PolicyRule> = items
                    .iter()
                    .filter_map(|item| serde_json::from_value::<PolicyRule>(item.clone()).ok())
                    .collect();
                return rules;
            }
        }
        DEFAULT_POLICY
            .iter()
            .map(|(kind, scope, decision)| PolicyRule {
                kind: (*kind).to_string(),
                scope: (*scope).to_string(),
                decision: (*decision).to_string(),
            })
            .collect()
    }

    pub fn check(
        &self,
        action: &GuardAction,
        scope: Option<&str>,
        caller_leases: &[Lease],
    ) -> GuardDecision {
        // Structural rule, evaluated before policy rules and leases: the kernel
        // state directory holds the policy, the event log and the receipts, so
        // no fs.write may ever target it — a policy that says otherwise is
        // itself part of what this rule protects. It cannot be lifted by
        // policy.json, a caller-supplied lease, or a held lease.
        if action.kind == "fs.write" && resolves_inside(&self.state_dir, Path::new(&action.target)) {
            return GuardDecision {
                decision: "deny".to_string(),
                reason: format!(
                    "kernel-state-protected: {} resolves inside the kernel state directory",
                    action.target
                ),
                lease_id: None,
            };
        }

        let scope = scope.filter(|s| !s.is_empty()).unwrap_or("*");
        let now_ms = now_millis();

        let matching: Vec<PolicyRule> = self
            .policy()
            .into_iter()
            .filter(|rule| rule_answer_matches(rule, &action.kind, scope))
            .collect();

        if let Some(deny) = matching.iter().find(|rule| rule.decision == "deny") {
            return GuardDecision {
                decision: "deny".to_string(),
                reason: format!(
                    "policy deny: {} @ {} (action {} on {})",
                    deny.kind, deny.scope, action.kind, action.target
                ),
                lease_id: None,
            };
        }

        let held = self.active_leases(now_ms);
        let lease = caller_leases
            .iter()
            .filter(|lease| !lease.is_expired(now_ms))
            .chain(held.iter())
            .find(|lease| {
                lease.kind == action.kind && pattern_matches(&lease.pattern, &action.target)
            });
        if let Some(lease) = lease {
            return GuardDecision {
                decision: "allow".to_string(),
                reason: format!(
                    "lease {} ({}) covers {} on {}",
                    lease.lease_id, lease.pattern, action.kind, action.target
                ),
                lease_id: Some(lease.lease_id.clone()),
            };
        }

        if let Some(ask) = matching.iter().find(|rule| rule.decision == "ask") {
            // docs/11 R1: ask outranks allow. A lease above already won over this
            // rule on purpose — lease semantics are unchanged.
            return GuardDecision {
                decision: "ask".to_string(),
                reason: format!(
                    "policy ask: {} @ {} (action {} on {})",
                    ask.kind, ask.scope, action.kind, action.target
                ),
                lease_id: None,
            };
        }

        if let Some(allow) = matching.iter().find(|rule| rule.decision == "allow") {
            return GuardDecision {
                decision: "allow".to_string(),
                reason: format!(
                    "policy allow: {} @ {} (action {} on {})",
                    allow.kind, allow.scope, action.kind, action.target
                ),
                lease_id: None,
            };
        }

        GuardDecision {
            decision: "ask".to_string(),
            reason: format!(
                "no allow rule or lease for {} @ {} (action {} on {})",
                action.kind, scope, action.kind, action.target
            ),
            lease_id: None,
        }
    }

    /// Create and remember a lease; returns it with a fresh uuid v4 id.
    pub fn issue_lease(&self, kind: &str, pattern: &str, ttl_ms: u64) -> Lease {
        let ttl = ttl_ms.min(366 * 24 * 60 * 60 * 1_000) as i64;
        let lease = Lease {
            lease_id: Uuid::new_v4().to_string(),
            kind: kind.to_string(),
            pattern: pattern.to_string(),
            expiry: iso_from_unix_millis(now_millis() + ttl),
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

    fn active_leases(&self, now_ms: i64) -> Vec<Lease> {
        match self.leases.lock() {
            Ok(held) => held
                .iter()
                .filter(|lease| !lease.is_expired(now_ms))
                .cloned()
                .collect(),
            Err(_) => Vec::new(),
        }
    }
}

fn rule_answer_matches(rule: &PolicyRule, kind: &str, scope: &str) -> bool {
    (rule.kind == kind || rule.kind == "*") && (rule.scope == scope || rule.scope == "*")
}

/* ------------------------- protected path resolution ------------------------- */

/// `true` when `target` is `root` or resolves inside it.
///
/// Both sides are resolved through symlinks for the deepest existing ancestor
/// and normalised lexically for the rest, so the answer cannot be evaded with
/// a lexical `..`, an absolute target, or a symlink that points into the state
/// directory.
fn resolves_inside(root: &Path, target: &Path) -> bool {
    let root = resolve_deepest(root);
    let target = resolve_deepest(target);
    target == root || target.starts_with(&root)
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

/// Lexical normalisation: drop `.`, collapse `a/..` to `a`'s parent, keep
/// leading `..` in a relative path.
fn lexically_clean(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                let last_is_parent = out
                    .file_name()
                    .map(|name| name == std::ffi::OsStr::new(".."))
                    .unwrap_or(false);
                if last_is_parent || (!out.pop() && !out.has_root()) {
                    out.push("..");
                }
            }
            other => out.push(other.as_os_str()),
        }
    }
    out
}

/// Resolve a path to where it really lives: canonicalize its deepest existing
/// ancestor (following symlinks), keep the remaining components verbatim, then
/// normalise lexically. A path whose tail never exists keeps its lexical form,
/// which is the best available statement of where a write would land.
fn resolve_deepest(path: &Path) -> PathBuf {
    let start = absolutize(path);
    let mut current = start.clone();
    let mut tail: Vec<OsString> = Vec::new();
    loop {
        if let Ok(real) = fs::canonicalize(&current) {
            let mut out = real;
            for name in tail.iter().rev() {
                out.push(name);
            }
            return lexically_clean(&out);
        }
        match (current.parent(), current.file_name()) {
            (Some(parent), Some(name)) if parent != current => {
                tail.push(name.to_os_string());
                current = parent.to_path_buf();
            }
            _ => return lexically_clean(&start),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pattern_matching_rules() {
        assert!(pattern_matches("*", "anything"));
        assert!(pattern_matches("echo *", "echo hi"));
        assert!(pattern_matches("/tmp/x", "/tmp/x"));
        assert!(!pattern_matches("/tmp/x", "/tmp/xy"));
        assert!(!pattern_matches("echo *", "cat echo hi"));
    }
}
