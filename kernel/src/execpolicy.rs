//! Execpolicy: a declarative command allowlist for `shell.exec` admission.
//!
//! Modeled on codex's execpolicy (research/compare-codex-grok.md §1.2): a
//! `Policy` keyed by the first program token, `PrefixRule`s whose trailing args
//! match a pattern, `NetworkRule`s with a normalized host, an order-independent
//! `fingerprint()`, and a runtime `amend` path under a file lock. This module is
//! PURE LOGIC (the matcher does no I/O) plus a fail-closed on-disk loader, so it
//! is fully unit-testable here regardless of LSM availability (context.json: the
//! command allowlist is one of the two pure-logic pieces to cover deeply).
//!
//! LAW reuse: `fingerprint()` hashes through `canon::canonical_json` +
//! `canon::sha256_hex` — the SAME canonical-JSON + SHA-256 contract the event
//! and receipt chains use. NO new hash scheme is introduced (context.json
//! contribution rule).
//!
//! Decision precedence is most-restrictive-wins: `Decision` has an `Ord` where
//! `Deny > Ask > Allow`, so the maximum over all matching rules is the answer.
//! That is consistent with docs/11 R1 (deny > ask > allow); the guard wires an
//! allowlist `Deny` BEFORE its policy rules so an allowlist deny wins (R1), and
//! an allowlist `Allow` admits. A command with no matching rule yields `None`
//! ("no allowlist opinion") and the guard falls through to its existing flow
//! unchanged — so `shell.exec` with no allowlist file present behaves EXACTLY
//! as today (ask).
//!
//! Reduced form (documented per the house style):
//!  - `canonical_key` uses Unicode NFC-less simple lowercasing (`char::to_lowercase`
//!    over the whole string). Full Unicode case-folding + NFD would need a
//!    unicode-normalization dependency; simple lowercasing is the reduced form
//!    and is sufficient for the ASCII/Latin command names in practice. Documented
//!    here as the residual; the index and the matcher use the SAME reduced key so
//!    they never disagree.
//!  - a malformed allowlist file FAILS CLOSED as a typed `AllowlistError`
//!    (`HZ_PRECONDITION_FAILED` class), mirroring `guard.rs::read_policy_rules`.

use std::collections::BTreeMap;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

use serde_json::{json, Value};

use crate::canon;

/* --------------------------------- Decision -------------------------------- */

/// The three guard answers an allowlist rule can carry. `Ord` is
/// `Allow < Ask < Deny` so a `max` over matching rules is most-restrictive-wins
/// (the docs/11 R1 spirit).
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum Decision {
    Allow,
    Ask,
    Deny,
}

impl Decision {
    /// The wire string the guard already uses.
    pub fn as_str(self) -> &'static str {
        match self {
            Decision::Allow => "allow",
            Decision::Ask => "ask",
            Decision::Deny => "deny",
        }
    }

    fn parse(s: &str) -> Option<Decision> {
        match s {
            "allow" => Some(Decision::Allow),
            "ask" => Some(Decision::Ask),
            "deny" => Some(Decision::Deny),
            _ => None,
        }
    }
}

/// Most-restrictive-wins aggregation over a set of matching decisions: the max
/// (`Deny` beats `Ask` beats `Allow`). `None` when nothing matched.
pub fn from_matches<I: IntoIterator<Item = Decision>>(matches: I) -> Option<Decision> {
    matches.into_iter().max()
}

/* ------------------------------- PatternToken ------------------------------ */

/// One token position in a prefix pattern's trailing args.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PatternToken {
    /// Exactly this literal (subject to the pattern's canonical-matching flag).
    Single(String),
    /// Any one of these literals.
    Alts(Vec<String>),
}

impl PatternToken {
    fn matches(&self, arg: &str, canonical_matching: bool) -> bool {
        match self {
            PatternToken::Single(s) => token_eq(s, arg, canonical_matching),
            PatternToken::Alts(alts) => {
                alts.iter().any(|alt| token_eq(alt, arg, canonical_matching))
            }
        }
    }

    fn debug_key(&self) -> String {
        match self {
            PatternToken::Single(s) => format!("S:{}", s),
            PatternToken::Alts(alts) => format!("A:{}", alts.join("|")),
        }
    }
}

/// `canonical_key` of a string: the reduced-form Unicode-caseless key (simple
/// lowercasing over the whole string). See the module header for why this is the
/// reduced form (no unicode-normalization dependency) and that the index and the
/// matcher share it.
pub fn canonical_key(s: &str) -> String {
    s.chars().flat_map(char::to_lowercase).collect()
}

fn token_eq(pattern: &str, arg: &str, canonical_matching: bool) -> bool {
    if canonical_matching {
        canonical_key(pattern) == canonical_key(arg)
    } else {
        pattern == arg
    }
}

/* ------------------------------ PrefixPattern ------------------------------ */

/// A program (`first`) plus a pattern over its trailing args (`rest`). When
/// `canonical_matching` is true the first token AND every rest token match
/// case-insensitively via `canonical_key`; otherwise exactly.
///
/// This is consistent with, but stronger than, `guard.rs::pattern_matches`: that
/// one is a flat trailing-`*` prefix over the whole command string, whereas this
/// is a per-token match over a parsed argv (so `git commit` cannot be satisfied
/// by `git commit-amend-force` the way a raw `git commit *` prefix would).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PrefixPattern {
    pub canonical_matching: bool,
    pub first: String,
    pub rest: Vec<PatternToken>,
}

impl PrefixPattern {
    /// `true` when `argv` begins with this program and each configured rest
    /// token matches the argv token at that position. A pattern with fewer rest
    /// tokens than argv has is a PREFIX match (extra argv tokens are allowed);
    /// an argv shorter than the pattern never matches.
    pub fn matches(&self, argv: &[String]) -> bool {
        let Some(program) = argv.first() else {
            return false;
        };
        if !token_eq(&self.first, program, self.canonical_matching) {
            return false;
        }
        if argv.len() < self.rest.len() + 1 {
            return false;
        }
        self.rest
            .iter()
            .zip(argv[1..].iter())
            .all(|(tok, arg)| tok.matches(arg, self.canonical_matching))
    }

    /// The program this pattern is keyed under in the index (canonical key when
    /// canonical matching is on, else the raw first token).
    fn index_key(&self) -> String {
        if self.canonical_matching {
            canonical_key(&self.first)
        } else {
            self.first.clone()
        }
    }

    fn debug_key(&self) -> String {
        let rest = self
            .rest
            .iter()
            .map(PatternToken::debug_key)
            .collect::<Vec<_>>()
            .join(",");
        format!("c={};{};[{}]", self.canonical_matching, self.first, rest)
    }
}

/* -------------------------------- PrefixRule ------------------------------- */

/// A prefix pattern carrying the `Decision` it admits plus optional validation
/// examples (codex R8: a rule that does not pass its own examples is refused).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PrefixRule {
    pub pattern: PrefixPattern,
    pub decision: Decision,
    /// argv lines that MUST match this pattern.
    pub match_examples: Vec<Vec<String>>,
    /// argv lines that MUST NOT match this pattern.
    pub not_match_examples: Vec<Vec<String>>,
}

impl PrefixRule {
    /// Validate the rule's own examples (codex R8). Returns the failing example
    /// detail, or `Ok(())`.
    fn validate_examples(&self) -> Result<(), String> {
        for (i, ex) in self.match_examples.iter().enumerate() {
            if !self.pattern.matches(ex) {
                return Err(format!(
                    "match example {} {:?} does not match the pattern",
                    i, ex
                ));
            }
        }
        for (i, ex) in self.not_match_examples.iter().enumerate() {
            if self.pattern.matches(ex) {
                return Err(format!(
                    "not_match example {} {:?} unexpectedly matches the pattern",
                    i, ex
                ));
            }
        }
        Ok(())
    }

    fn debug_key(&self) -> String {
        format!("{}=>{}", self.pattern.debug_key(), self.decision.as_str())
    }
}

/* ------------------------------- NetworkRule ------------------------------- */

/// The transport a `NetworkRule` governs.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NetworkProtocol {
    Http,
    Https,
    Socks5Tcp,
    Socks5Udp,
}

impl NetworkProtocol {
    fn as_str(self) -> &'static str {
        match self {
            NetworkProtocol::Http => "http",
            NetworkProtocol::Https => "https",
            NetworkProtocol::Socks5Tcp => "socks5_tcp",
            NetworkProtocol::Socks5Udp => "socks5_udp",
        }
    }

    fn parse(s: &str) -> Option<NetworkProtocol> {
        match s {
            "http" => Some(NetworkProtocol::Http),
            "https" => Some(NetworkProtocol::Https),
            "socks5_tcp" => Some(NetworkProtocol::Socks5Tcp),
            "socks5_udp" => Some(NetworkProtocol::Socks5Udp),
            _ => None,
        }
    }
}

/// A rule over an egress host. `host` is a normalized bare host (see
/// `normalize_network_rule_host`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NetworkRule {
    pub host: String,
    pub protocol: NetworkProtocol,
    pub decision: Decision,
    pub justification: String,
}

impl NetworkRule {
    fn debug_key(&self) -> String {
        format!(
            "net:{}://{}=>{} ({})",
            self.protocol.as_str(),
            self.host,
            self.decision.as_str(),
            self.justification
        )
    }
}

/// Normalize an egress host for a `NetworkRule`: strip a leading scheme
/// (`https://`), any path (`/...`), and an explicit port (`:443`); reject
/// wildcards (`*`) and any whitespace; lowercase; reject empty. Returns the bare
/// lowercased host or a typed error detail.
pub fn normalize_network_rule_host(input: &str) -> Result<String, String> {
    let mut s = input.trim();
    // strip scheme
    if let Some(idx) = s.find("://") {
        s = &s[idx + 3..];
    }
    // strip path / query / fragment
    for sep in ['/', '?', '#'] {
        if let Some(idx) = s.find(sep) {
            s = &s[..idx];
        }
    }
    // strip userinfo (user@host)
    if let Some(idx) = s.rfind('@') {
        s = &s[idx + 1..];
    }
    // strip an explicit port (but not an IPv6 group: only a trailing :digits)
    if let Some(idx) = s.rfind(':') {
        let tail = &s[idx + 1..];
        if !tail.is_empty() && tail.bytes().all(|b| b.is_ascii_digit()) {
            s = &s[..idx];
        }
    }
    if s.is_empty() {
        return Err("host is empty after normalization".to_string());
    }
    if s.contains('*') {
        return Err(format!("host {:?} contains a wildcard", input));
    }
    if s.chars().any(char::is_whitespace) {
        return Err(format!("host {:?} contains whitespace", input));
    }
    Ok(s.to_ascii_lowercase())
}

/* -------------------------------- ExecPolicy ------------------------------- */

/// A compiled command allowlist: prefix rules indexed by program key, plus the
/// network rules. Two policies compiled from the same rules in different orders
/// compare equal under `fingerprint()`.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ExecPolicy {
    /// Keyed by `PrefixPattern::index_key()`; several rules may share a program.
    pub rules_by_program: BTreeMap<String, Vec<PrefixRule>>,
    pub network_rules: Vec<NetworkRule>,
}

impl ExecPolicy {
    pub fn new() -> Self {
        ExecPolicy::default()
    }

    /// Add a prefix rule, validating its examples first (codex R8). In-memory
    /// construction helper; the on-disk loader and the runtime amend path push
    /// directly, so this is exercised by the unit tests (hence `allow`).
    #[allow(dead_code)]
    pub fn add_prefix_rule(&mut self, rule: PrefixRule) -> Result<(), String> {
        rule.validate_examples()?;
        let key = rule.pattern.index_key();
        self.rules_by_program.entry(key).or_default().push(rule);
        Ok(())
    }

    pub fn add_network_rule(&mut self, rule: NetworkRule) {
        self.network_rules.push(rule);
    }

    /// The decision for `argv`, as the max over every matching prefix rule for
    /// `argv[0]` (looked up under BOTH its raw token and its canonical key, so a
    /// canonical-matching rule and an exact rule both get a chance). `None` when
    /// no rule matches — the caller treats `None` as "no allowlist opinion".
    pub fn evaluate_command(&self, argv: &[String]) -> Option<Decision> {
        let program = argv.first()?;
        let mut keys = vec![program.clone()];
        let canon = canonical_key(program);
        if canon != *program {
            keys.push(canon);
        }
        let mut matched: Vec<Decision> = Vec::new();
        for key in keys {
            if let Some(rules) = self.rules_by_program.get(&key) {
                for rule in rules {
                    if rule.pattern.matches(argv) {
                        matched.push(rule.decision);
                    }
                }
            }
        }
        from_matches(matched)
    }

    /// An order-independent content fingerprint. Build the `"{program}:{rule}"`
    /// debug strings for every prefix rule and every network rule, SORT them,
    /// wrap in a JSON array, and hash with the LAW canonical-JSON + sha256. Two
    /// policies with the same rules in different orders fingerprint equal; any
    /// changed rule changes the hash.
    pub fn fingerprint(&self) -> String {
        let mut parts: Vec<String> = Vec::new();
        for (program, rules) in &self.rules_by_program {
            for rule in rules {
                parts.push(format!("{}:{}", program, rule.debug_key()));
            }
        }
        for rule in &self.network_rules {
            parts.push(rule.debug_key());
        }
        parts.sort();
        let array = Value::Array(parts.into_iter().map(Value::String).collect());
        canon::sha256_hex(&canon::canonical_json(&array))
    }
}

/* ----------------------------- on-disk loading ----------------------------- */

/// Why an allowlist file could not be used. Every variant is a refusal: like
/// `guard.rs::PolicyError`, the kernel never silently drops a rule it did not
/// understand (a dropped `deny` rule would be a fail-open).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AllowlistError {
    Unreadable(String),
    Shape(String),
    Rule { index: usize, detail: String },
    Example { index: usize, detail: String },
}

impl std::fmt::Display for AllowlistError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            AllowlistError::Unreadable(detail) => write!(
                f,
                "HZ_PRECONDITION_FAILED: allowlist cannot be read: {}",
                detail
            ),
            AllowlistError::Shape(detail) => write!(
                f,
                "HZ_PRECONDITION_FAILED: allowlist is malformed: {}",
                detail
            ),
            AllowlistError::Rule { index, detail } => write!(
                f,
                "HZ_PRECONDITION_FAILED: allowlist rule {} is malformed: {}",
                index, detail
            ),
            AllowlistError::Example { index, detail } => write!(
                f,
                "HZ_PRECONDITION_FAILED: allowlist rule {} failed its own example: {}",
                index, detail
            ),
        }
    }
}

impl std::error::Error for AllowlistError {}

/// The on-disk file name under the state dir.
pub const ALLOWLIST_FILE: &str = "allowlist.json";
const LOCK_FILE: &str = "allowlist.json.lock";

fn allowlist_path(state_dir: &Path) -> PathBuf {
    state_dir.join(ALLOWLIST_FILE)
}

/// Load the allowlist from `<state-dir>/allowlist.json`. `Ok(None)` when the
/// file is genuinely absent (no allowlist opinion). Any other problem — bad
/// JSON, a bad rule, or a rule that fails its own example — is a typed refusal
/// (FAIL CLOSED), exactly like `guard.rs::read_policy_rules`.
pub fn load(state_dir: &Path) -> Result<Option<ExecPolicy>, AllowlistError> {
    let path = allowlist_path(state_dir);
    let text = match fs::read_to_string(&path) {
        Ok(text) => text,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(AllowlistError::Unreadable(e.to_string())),
    };
    parse_policy(&text).map(Some)
}

/// Parse a policy document: either a bare JSON array of rule objects, or an
/// object `{ "rules": [...], "networkRules": [...] }` (the `policy.json` shape).
pub fn parse_policy(text: &str) -> Result<ExecPolicy, AllowlistError> {
    let parsed: Value = serde_json::from_str(text)
        .map_err(|e| AllowlistError::Shape(format!("not valid JSON: {}", e)))?;

    let (rule_items, net_items): (Vec<Value>, Vec<Value>) = match parsed {
        Value::Array(items) => (items, Vec::new()),
        Value::Object(map) => {
            let rules = match map.get("rules") {
                Some(Value::Array(items)) => items.clone(),
                None => Vec::new(),
                _ => {
                    return Err(AllowlistError::Shape(
                        "\"rules\" must be an array".to_string(),
                    ))
                }
            };
            let nets = match map.get("networkRules") {
                Some(Value::Array(items)) => items.clone(),
                None => Vec::new(),
                _ => {
                    return Err(AllowlistError::Shape(
                        "\"networkRules\" must be an array".to_string(),
                    ))
                }
            };
            (rules, nets)
        }
        _ => {
            return Err(AllowlistError::Shape(
                "expected a JSON array of rules or an object with \"rules\"".to_string(),
            ))
        }
    };

    let mut policy = ExecPolicy::new();
    for (index, item) in rule_items.iter().enumerate() {
        // Distinguish a network rule object (has "host") from a prefix rule
        // object (has "program") so a mixed array still parses.
        if item.get("host").is_some() && item.get("program").is_none() {
            policy.add_network_rule(parse_network_rule(index, item)?);
        } else {
            let rule = parse_prefix_rule(index, item)?;
            rule.validate_examples()
                .map_err(|detail| AllowlistError::Example { index, detail })?;
            let key = rule.pattern.index_key();
            policy.rules_by_program.entry(key).or_default().push(rule);
        }
    }
    for (offset, item) in net_items.iter().enumerate() {
        let index = rule_items.len() + offset;
        policy.add_network_rule(parse_network_rule(index, item)?);
    }
    Ok(policy)
}

/// Parse a single prefix-rule object (the runtime `amend` entry point). Same
/// shape and validation as the on-disk loader's rule objects.
pub fn prefix_rule_from_value(item: &Value) -> Result<PrefixRule, AllowlistError> {
    let rule = parse_prefix_rule(0, item)?;
    rule.validate_examples()
        .map_err(|detail| AllowlistError::Example { index: 0, detail })?;
    Ok(rule)
}

/// Parse a single network-rule object (the runtime `amend` entry point).
pub fn network_rule_from_value(item: &Value) -> Result<NetworkRule, AllowlistError> {
    parse_network_rule(0, item)
}

fn parse_prefix_rule(index: usize, item: &Value) -> Result<PrefixRule, AllowlistError> {
    let invalid = |detail: String| AllowlistError::Rule { index, detail };
    let obj = item
        .as_object()
        .ok_or_else(|| invalid("rule must be a JSON object".to_string()))?;

    let program = obj
        .get("program")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .ok_or_else(|| invalid("\"program\" must be a non-empty string".to_string()))?
        .to_string();

    let decision = obj
        .get("decision")
        .and_then(|v| v.as_str())
        .and_then(Decision::parse)
        .ok_or_else(|| invalid("\"decision\" must be allow|ask|deny".to_string()))?;

    let canonical_matching = match obj.get("canonicalMatching") {
        None => true, // caseless by default (the stronger, safer form)
        Some(Value::Bool(b)) => *b,
        Some(_) => return Err(invalid("\"canonicalMatching\" must be a boolean".to_string())),
    };

    let rest = match obj.get("args") {
        None => Vec::new(),
        Some(Value::Array(items)) => {
            let mut toks = Vec::with_capacity(items.len());
            for (i, tok) in items.iter().enumerate() {
                toks.push(parse_pattern_token(index, i, tok)?);
            }
            toks
        }
        Some(_) => return Err(invalid("\"args\" must be an array".to_string())),
    };

    let match_examples = parse_examples(index, obj.get("match"), "match")?;
    let not_match_examples = parse_examples(index, obj.get("notMatch"), "notMatch")?;

    Ok(PrefixRule {
        pattern: PrefixPattern {
            canonical_matching,
            first: program,
            rest,
        },
        decision,
        match_examples,
        not_match_examples,
    })
}

fn parse_pattern_token(
    rule_index: usize,
    tok_index: usize,
    tok: &Value,
) -> Result<PatternToken, AllowlistError> {
    let invalid = |detail: String| AllowlistError::Rule {
        index: rule_index,
        detail,
    };
    match tok {
        Value::String(s) => Ok(PatternToken::Single(s.clone())),
        Value::Array(items) => {
            let mut alts = Vec::with_capacity(items.len());
            for alt in items {
                let s = alt.as_str().ok_or_else(|| {
                    invalid(format!("args[{}] alts must be strings", tok_index))
                })?;
                alts.push(s.to_string());
            }
            if alts.is_empty() {
                return Err(invalid(format!("args[{}] alts must be non-empty", tok_index)));
            }
            Ok(PatternToken::Alts(alts))
        }
        _ => Err(invalid(format!(
            "args[{}] must be a string or an array of strings",
            tok_index
        ))),
    }
}

fn parse_examples(
    index: usize,
    value: Option<&Value>,
    field: &str,
) -> Result<Vec<Vec<String>>, AllowlistError> {
    let invalid = |detail: String| AllowlistError::Rule { index, detail };
    match value {
        None => Ok(Vec::new()),
        Some(Value::Array(items)) => {
            let mut out = Vec::with_capacity(items.len());
            for item in items {
                let argv = item.as_array().ok_or_else(|| {
                    invalid(format!("\"{}\" examples must be argv arrays", field))
                })?;
                let mut line = Vec::with_capacity(argv.len());
                for tok in argv {
                    let s = tok.as_str().ok_or_else(|| {
                        invalid(format!("\"{}\" example tokens must be strings", field))
                    })?;
                    line.push(s.to_string());
                }
                out.push(line);
            }
            Ok(out)
        }
        Some(_) => Err(invalid(format!("\"{}\" must be an array of argv arrays", field))),
    }
}

fn parse_network_rule(index: usize, item: &Value) -> Result<NetworkRule, AllowlistError> {
    let invalid = |detail: String| AllowlistError::Rule { index, detail };
    let obj = item
        .as_object()
        .ok_or_else(|| invalid("rule must be a JSON object".to_string()))?;

    let raw_host = obj
        .get("host")
        .and_then(|v| v.as_str())
        .ok_or_else(|| invalid("\"host\" must be a string".to_string()))?;
    let host = normalize_network_rule_host(raw_host).map_err(|detail| invalid(detail))?;

    let protocol = match obj.get("protocol") {
        None => NetworkProtocol::Https, // https by default
        Some(Value::String(s)) => NetworkProtocol::parse(s)
            .ok_or_else(|| invalid(format!("unknown protocol {:?}", s)))?,
        Some(_) => return Err(invalid("\"protocol\" must be a string".to_string())),
    };

    let decision = obj
        .get("decision")
        .and_then(|v| v.as_str())
        .and_then(Decision::parse)
        .ok_or_else(|| invalid("\"decision\" must be allow|ask|deny".to_string()))?;

    let justification = obj
        .get("justification")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();

    Ok(NetworkRule {
        host,
        protocol,
        decision,
        justification,
    })
}

/* --------------------------------- amend ----------------------------------- */

/// Append a prefix rule to the on-disk allowlist, dedup-by-content, under an
/// advisory lock. Validates examples first (a bad rule is never persisted).
pub fn amend_allow_prefix_rule(
    state_dir: &Path,
    rule: &PrefixRule,
) -> Result<bool, AllowlistError> {
    rule.validate_examples()
        .map_err(|detail| AllowlistError::Example { index: 0, detail })?;
    with_lock(state_dir, |policy| {
        let key = rule.pattern.index_key();
        let bucket = policy.rules_by_program.entry(key).or_default();
        if bucket.iter().any(|existing| existing == rule) {
            return false; // dedup: already present
        }
        bucket.push(rule.clone());
        true
    })
}

/// Append a network rule to the on-disk allowlist, dedup-by-content, under the
/// advisory lock.
pub fn amend_network_rule(
    state_dir: &Path,
    rule: &NetworkRule,
) -> Result<bool, AllowlistError> {
    with_lock(state_dir, |policy| {
        if policy.network_rules.iter().any(|existing| existing == rule) {
            return false;
        }
        policy.network_rules.push(rule.clone());
        true
    })
}

/// Run `mutate` against the current on-disk policy under an advisory file lock,
/// rewriting `allowlist.json` (0600) only when `mutate` reports a change.
///
/// The lock is an `O_CREAT|O_EXCL` sentinel file (`allowlist.json.lock`) with a
/// bounded busy-retry — no external crate, `--locked` stays intact. A stale lock
/// from a crashed writer is cleared after the retry budget so a crash cannot
/// wedge the allowlist forever (documented reduced form: this is advisory, not a
/// kernel lease).
fn with_lock<F>(state_dir: &Path, mutate: F) -> Result<bool, AllowlistError>
where
    F: FnOnce(&mut ExecPolicy) -> bool,
{
    fs::create_dir_all(state_dir).map_err(|e| AllowlistError::Unreadable(e.to_string()))?;
    let lock_path = state_dir.join(LOCK_FILE);
    let _guard = LockGuard::acquire(&lock_path)?;

    let mut policy = load(state_dir)?.unwrap_or_default();
    let changed = mutate(&mut policy);
    if changed {
        write_policy(state_dir, &policy)?;
    }
    Ok(changed)
}

/// Serialize the whole policy back to `allowlist.json` as a canonical-JSON
/// object (0600). Canonical so a byte-for-byte compare is stable across rewrites.
fn write_policy(state_dir: &Path, policy: &ExecPolicy) -> Result<(), AllowlistError> {
    let value = policy_to_value(policy);
    let body = canon::canonical_json(&value);
    let path = allowlist_path(state_dir);
    crate::permm::write_new(&path, body.as_bytes())
        .map_err(|e| AllowlistError::Unreadable(e.to_string()))
}

fn policy_to_value(policy: &ExecPolicy) -> Value {
    let mut rules: Vec<Value> = Vec::new();
    for rules_vec in policy.rules_by_program.values() {
        for rule in rules_vec {
            rules.push(prefix_rule_to_value(rule));
        }
    }
    let nets: Vec<Value> = policy.network_rules.iter().map(network_rule_to_value).collect();
    json!({ "rules": rules, "networkRules": nets })
}

fn prefix_rule_to_value(rule: &PrefixRule) -> Value {
    let args: Vec<Value> = rule
        .pattern
        .rest
        .iter()
        .map(|tok| match tok {
            PatternToken::Single(s) => Value::String(s.clone()),
            PatternToken::Alts(alts) => {
                Value::Array(alts.iter().cloned().map(Value::String).collect())
            }
        })
        .collect();
    let to_examples = |xs: &[Vec<String>]| -> Value {
        Value::Array(
            xs.iter()
                .map(|line| Value::Array(line.iter().cloned().map(Value::String).collect()))
                .collect(),
        )
    };
    json!({
        "program": rule.pattern.first,
        "canonicalMatching": rule.pattern.canonical_matching,
        "args": args,
        "decision": rule.decision.as_str(),
        "match": to_examples(&rule.match_examples),
        "notMatch": to_examples(&rule.not_match_examples),
    })
}

fn network_rule_to_value(rule: &NetworkRule) -> Value {
    json!({
        "host": rule.host,
        "protocol": rule.protocol.as_str(),
        "decision": rule.decision.as_str(),
        "justification": rule.justification,
    })
}

/// A dropped-on-drop advisory lock sentinel.
struct LockGuard {
    path: PathBuf,
}

impl LockGuard {
    fn acquire(lock_path: &Path) -> Result<LockGuard, AllowlistError> {
        use std::fs::OpenOptions;
        const MAX_TRIES: u32 = 100;
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        for attempt in 0..MAX_TRIES {
            match options.open(lock_path) {
                Ok(mut f) => {
                    let _ = f.write_all(format!("{}", std::process::id()).as_bytes());
                    return Ok(LockGuard {
                        path: lock_path.to_path_buf(),
                    });
                }
                Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
                    // Clear a stale lock near the end of the budget so a crashed
                    // writer cannot wedge the allowlist forever.
                    if attempt == MAX_TRIES - 2 {
                        let _ = fs::remove_file(lock_path);
                    }
                    std::thread::sleep(std::time::Duration::from_millis(2));
                }
                Err(e) => return Err(AllowlistError::Unreadable(e.to_string())),
            }
        }
        Err(AllowlistError::Unreadable(
            "could not acquire the allowlist lock".to_string(),
        ))
    }
}

impl Drop for LockGuard {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.path);
    }
}

/* ---------------------------------- tests ---------------------------------- */

#[cfg(test)]
mod tests {
    use super::*;
    use uuid::Uuid;

    fn scratch(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("hz-execpolicy-{}-{}", tag, Uuid::new_v4()));
        fs::create_dir_all(&dir).expect("scratch dir");
        dir
    }

    fn argv(parts: &[&str]) -> Vec<String> {
        parts.iter().map(|s| s.to_string()).collect()
    }

    fn single(s: &str) -> PatternToken {
        PatternToken::Single(s.to_string())
    }

    fn prefix_rule(program: &str, rest: Vec<PatternToken>, decision: Decision) -> PrefixRule {
        PrefixRule {
            pattern: PrefixPattern {
                canonical_matching: true,
                first: program.to_string(),
                rest,
            },
            decision,
            match_examples: Vec::new(),
            not_match_examples: Vec::new(),
        }
    }

    #[test]
    fn canonical_key_is_caseless() {
        assert_eq!(canonical_key("GIT"), "git");
        assert_eq!(canonical_key("Git"), canonical_key("gIt"));
        // a caseless prefix rule matches a differently-cased command
        let rule = prefix_rule("GIT", vec![single("STATUS")], Decision::Allow);
        assert!(rule.pattern.matches(&argv(&["git", "status"])));
        assert!(rule.pattern.matches(&argv(&["Git", "Status"])));
        // exact matching does not
        let mut exact = rule.clone();
        exact.pattern.canonical_matching = false;
        assert!(!exact.pattern.matches(&argv(&["git", "status"])));
    }

    #[test]
    fn pattern_token_alts_match_any() {
        let rule = prefix_rule(
            "git",
            vec![PatternToken::Alts(vec!["status".into(), "diff".into()])],
            Decision::Allow,
        );
        assert!(rule.pattern.matches(&argv(&["git", "status"])));
        assert!(rule.pattern.matches(&argv(&["git", "diff"])));
        assert!(!rule.pattern.matches(&argv(&["git", "push"])));
    }

    #[test]
    fn prefix_match_allows_extra_trailing_args_but_not_shorter() {
        let rule = prefix_rule("git", vec![single("commit")], Decision::Allow);
        assert!(rule.pattern.matches(&argv(&["git", "commit", "-m", "x"])));
        assert!(!rule.pattern.matches(&argv(&["git"])));
        // a differently-spelled subcommand is not a per-token match (stronger
        // than a flat prefix `git commit*` which `commitfoo` would satisfy)
        assert!(!rule.pattern.matches(&argv(&["git", "commitfoo"])));
    }

    #[test]
    fn most_restrictive_wins_aggregation() {
        assert_eq!(
            from_matches([Decision::Allow, Decision::Ask, Decision::Deny]),
            Some(Decision::Deny)
        );
        assert_eq!(
            from_matches([Decision::Allow, Decision::Ask]),
            Some(Decision::Ask)
        );
        assert_eq!(from_matches([Decision::Allow, Decision::Allow]), Some(Decision::Allow));
        assert_eq!(from_matches(std::iter::empty()), None);

        // the same through evaluate_command: a deny and an allow on the same
        // program -> deny
        let mut policy = ExecPolicy::new();
        policy
            .add_prefix_rule(prefix_rule("rm", vec![], Decision::Allow))
            .unwrap();
        policy
            .add_prefix_rule(prefix_rule("rm", vec![single("-rf")], Decision::Deny))
            .unwrap();
        assert_eq!(policy.evaluate_command(&argv(&["rm", "-rf"])), Some(Decision::Deny));
        assert_eq!(policy.evaluate_command(&argv(&["rm", "file"])), Some(Decision::Allow));
        assert_eq!(policy.evaluate_command(&argv(&["ls"])), None);
    }

    #[test]
    fn fingerprint_is_order_independent() {
        let mut a = ExecPolicy::new();
        a.add_prefix_rule(prefix_rule("git", vec![single("status")], Decision::Allow))
            .unwrap();
        a.add_prefix_rule(prefix_rule("rm", vec![single("-rf")], Decision::Deny))
            .unwrap();

        let mut b = ExecPolicy::new();
        b.add_prefix_rule(prefix_rule("rm", vec![single("-rf")], Decision::Deny))
            .unwrap();
        b.add_prefix_rule(prefix_rule("git", vec![single("status")], Decision::Allow))
            .unwrap();

        assert_eq!(a.fingerprint(), b.fingerprint(), "order must not change the fingerprint");
        assert!(canon::is_hash(&a.fingerprint()));

        // a changed rule changes the hash
        let mut c = ExecPolicy::new();
        c.add_prefix_rule(prefix_rule("git", vec![single("status")], Decision::Ask))
            .unwrap();
        c.add_prefix_rule(prefix_rule("rm", vec![single("-rf")], Decision::Deny))
            .unwrap();
        assert_ne!(a.fingerprint(), c.fingerprint());
    }

    #[test]
    fn normalize_host_accepts_and_rejects() {
        assert_eq!(normalize_network_rule_host("Example.COM").unwrap(), "example.com");
        assert_eq!(
            normalize_network_rule_host("https://example.com:443/path?q=1").unwrap(),
            "example.com"
        );
        assert_eq!(
            normalize_network_rule_host("user@api.example.com:8080").unwrap(),
            "api.example.com"
        );
        assert!(normalize_network_rule_host("*.example.com").is_err());
        assert!(normalize_network_rule_host("bad host").is_err());
        assert!(normalize_network_rule_host("").is_err());
        assert!(normalize_network_rule_host("https://").is_err());
    }

    #[test]
    fn malformed_allowlist_fails_closed() {
        let dir = scratch("malformed");
        // not JSON
        fs::write(dir.join(ALLOWLIST_FILE), "{not json").unwrap();
        let err = load(&dir).unwrap_err();
        assert!(matches!(err, AllowlistError::Shape(_)), "{:?}", err);
        assert!(err.to_string().contains("HZ_PRECONDITION_FAILED"));

        // a bad rule names its index
        fs::write(
            dir.join(ALLOWLIST_FILE),
            r#"[{"program":"git","decision":"maybe"}]"#,
        )
        .unwrap();
        let err = load(&dir).unwrap_err();
        assert!(matches!(err, AllowlistError::Rule { index: 0, .. }), "{:?}", err);

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn absent_allowlist_is_none_not_error() {
        let dir = scratch("absent");
        assert_eq!(load(&dir).unwrap(), None);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn example_validation_refuses_a_bad_prefix_rule() {
        // a rule whose match example does NOT match the pattern is refused
        let doc = r#"[{"program":"git","args":["status"],"decision":"allow","match":[["git","push"]]}]"#;
        let err = parse_policy(doc).unwrap_err();
        assert!(matches!(err, AllowlistError::Example { index: 0, .. }), "{:?}", err);

        // a rule whose notMatch example DOES match is refused
        let doc2 = r#"[{"program":"git","args":["status"],"decision":"allow","notMatch":[["git","status"]]}]"#;
        let err2 = parse_policy(doc2).unwrap_err();
        assert!(matches!(err2, AllowlistError::Example { index: 0, .. }), "{:?}", err2);

        // a well-formed rule with passing examples loads
        let good = r#"[{"program":"git","args":["status"],"decision":"allow","match":[["git","status","-s"]],"notMatch":[["git","push"]]}]"#;
        let policy = parse_policy(good).unwrap();
        assert_eq!(policy.evaluate_command(&argv(&["git", "status"])), Some(Decision::Allow));
    }

    #[test]
    fn amend_appends_dedups_and_reload_sees_it() {
        let dir = scratch("amend");
        let rule = prefix_rule("git", vec![single("status")], Decision::Allow);

        // first amend appends
        assert!(amend_allow_prefix_rule(&dir, &rule).unwrap());
        // a second identical amend dedups (no change)
        assert!(!amend_allow_prefix_rule(&dir, &rule).unwrap());

        // a reload sees exactly one copy and it evaluates
        let policy = load(&dir).unwrap().expect("policy present after amend");
        assert_eq!(policy.evaluate_command(&argv(&["git", "status"])), Some(Decision::Allow));
        let total: usize = policy.rules_by_program.values().map(Vec::len).sum();
        assert_eq!(total, 1, "dedup must keep exactly one copy");

        // a network amend round-trips too
        let net = NetworkRule {
            host: "example.com".to_string(),
            protocol: NetworkProtocol::Https,
            decision: Decision::Allow,
            justification: "docs".to_string(),
        };
        assert!(amend_network_rule(&dir, &net).unwrap());
        assert!(!amend_network_rule(&dir, &net).unwrap());
        let policy2 = load(&dir).unwrap().unwrap();
        assert_eq!(policy2.network_rules.len(), 1);
        assert_eq!(policy2.network_rules[0].host, "example.com");

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn fingerprint_stable_across_amend_reorder() {
        // a policy built by amend (two orders) fingerprints equal
        let dir1 = scratch("fp1");
        let dir2 = scratch("fp2");
        let r1 = prefix_rule("git", vec![single("status")], Decision::Allow);
        let r2 = prefix_rule("rm", vec![single("-rf")], Decision::Deny);
        amend_allow_prefix_rule(&dir1, &r1).unwrap();
        amend_allow_prefix_rule(&dir1, &r2).unwrap();
        amend_allow_prefix_rule(&dir2, &r2).unwrap();
        amend_allow_prefix_rule(&dir2, &r1).unwrap();
        let p1 = load(&dir1).unwrap().unwrap();
        let p2 = load(&dir2).unwrap().unwrap();
        assert_eq!(p1.fingerprint(), p2.fingerprint());
        let _ = fs::remove_dir_all(&dir1);
        let _ = fs::remove_dir_all(&dir2);
    }
}
