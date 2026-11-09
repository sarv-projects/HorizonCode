//! Egress: a per-origin network-authority decider for `net.fetch` admission.
//!
//! Modeled on grok's egress proxy decider (research/compare-codex-grok.md §2.1,
//! L103-110): a `Decider` that maps `(origin, call) -> EgressDecision` where an
//! origin is `(scheme, host, port)` and the four outcomes are
//! `{Allow, Deny, Ask, AllowAndRecord{would: WouldBe}}`. Per-origin rules
//! default to DENY (docs/11 N1: egress MUST default to deny; N2: decided by
//! scheme/host/port, not a boolean). Observe mode records what enforce mode
//! WOULD have done (`AllowAndRecord{would}`) without blocking — a safe
//! policy-rollout path. A two-level hold budget (proxy-wide + per command tag)
//! models grok's `503 overloaded before a card` ceiling as PURE data. Records
//! are content-free (`BlockedRequest{host, port, call, decided, hold_ms,
//! deadline_unix}` — NO path/headers/body).
//!
//! SCOPE. This module is the DECIDER and its POLICY — pure, fully unit-testable
//! logic. The real connection parking (grok's `hold()` returning a
//! `oneshot::Receiver<bool>`), the async MITM/routed-proxy that enforces N10,
//! and DNS pinning / rebind re-check (N4) are OUT of scope and DEFERRED
//! (recorded in docs/28 as residuals). The hold budget here is the accounting
//! half only (how many concurrent holds are allowed and when a request is
//! rejected over-budget); no connection is actually parked.
//!
//! LAW reuse: nothing here invents a hash. Where a digest or canonical form is
//! needed (`to_json`) it goes through `canon::canonical_json` — the SAME
//! canonical-JSON contract the event and receipt chains use.
//!
//! Composition with the policy layer (documented so it is unambiguous):
//!   - `guard.rs::check` consults this decider for `net.fetch` BEFORE the policy
//!     rules (the FEAT-002 pattern). A decider `Deny` returns deny; a decider
//!     `Allow` admits; an `Ask` or `AllowAndRecord` falls through to the
//!     EXISTING `net.fetch` policy flow (default `ask`). So with NO egress
//!     policy file present (`<state-dir>/egress.json` absent) the decider is
//!     NOT consulted at all and `net.fetch` behaves EXACTLY as today (ask at the
//!     policy layer). The decider's own default-deny (N1) only takes effect
//!     once an egress policy file EXISTS (enforce mode) — at which point an
//!     unmatched origin denies. That two-layer split is deliberate: absence of
//!     config is ask (the shipped behaviour), presence of config is deny-by-
//!     default (the confined profile N1 demands).

// Dead-code note: the `HoldBudget`, `BlockedRequest`, the observe-mode
// `WouldBe`/`DenySource` accessors and the `DEFAULT_*` / `BLOCKED_REQUEST_CAPACITY`
// constants are the PURE, fully unit-tested model of grok's hold mechanism and
// content-free records. Their only live consumer — the async MITM/routed-proxy
// that actually parks connections and broadcasts records to a UI channel — is
// DEFERRED (see the module header and docs/28 ruling 43). They are exercised by
// the `#[cfg(test)]` suite below; `allow(dead_code)` documents that they are
// policy-and-data now, wiring later, rather than accidentally unused.
#![allow(dead_code)]

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};

use serde_json::{json, Value};

/* --------------------------------- Origin ---------------------------------- */

/// A network origin: the `(scheme, host, port)` triple a rule is keyed on
/// (docs/11 N2). `host` is a normalized bare host (lowercased, no scheme/path/
/// port/userinfo), `port` is explicit (defaulted per scheme when the URL omits
/// it).
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct Origin {
    pub scheme: String,
    pub host: String,
    pub port: u16,
}

impl Origin {
    /// `scheme://host:port` for reasons/records (never carries a path).
    pub fn display(&self) -> String {
        format!("{}://{}:{}", self.scheme, self.host, self.port)
    }
}

/// The default port for a scheme, or `None` for a scheme with no well-known
/// port (then an explicit `:port` is required).
fn default_port(scheme: &str) -> Option<u16> {
    match scheme {
        "https" => Some(443),
        "http" => Some(80),
        _ => None,
    }
}

/// Parse a URL into an `Origin`, fail-closed. Reuses the
/// `execpolicy::normalize_network_rule_host` style (lowercase host, strip
/// userinfo/path, reject wildcards and whitespace) and adds scheme + port.
///
/// Returns `Err(detail)` for anything unparseable — the caller treats an
/// unparseable target as a DENY candidate (an origin it cannot name cannot be
/// allowed, N1). Never returns an origin that would silently widen authority.
pub fn parse_origin(url: &str) -> Result<Origin, String> {
    let s = url.trim();
    if s.is_empty() {
        return Err("url is empty".to_string());
    }
    if s.chars().any(char::is_whitespace) {
        return Err(format!("url {:?} contains whitespace", url));
    }
    // scheme
    let (scheme_raw, after_scheme) = match s.split_once("://") {
        Some((scheme, rest)) => (scheme, rest),
        None => return Err(format!("url {:?} has no scheme://", url)),
    };
    let scheme = scheme_raw.to_ascii_lowercase();
    if scheme.is_empty()
        || !scheme
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'+' || b == b'-' || b == b'.')
    {
        return Err(format!("url {:?} has an invalid scheme", url));
    }
    // authority = up to the first '/', '?' or '#'
    let authority_end = after_scheme
        .find(['/', '?', '#'])
        .unwrap_or(after_scheme.len());
    let authority = &after_scheme[..authority_end];
    if authority.is_empty() {
        return Err(format!("url {:?} has an empty authority", url));
    }
    // strip userinfo (user:pass@host)
    let host_port = match authority.rfind('@') {
        Some(idx) => &authority[idx + 1..],
        None => authority,
    };
    if host_port.is_empty() {
        return Err(format!("url {:?} has an empty host", url));
    }
    // split host:port — only a trailing :digits is a port (not an IPv6 group)
    let (host_raw, port) = match host_port.rfind(':') {
        Some(idx) => {
            let tail = &host_port[idx + 1..];
            if !tail.is_empty() && tail.bytes().all(|b| b.is_ascii_digit()) {
                let port: u16 = tail
                    .parse()
                    .map_err(|_| format!("url {:?} has an out-of-range port", url))?;
                (&host_port[..idx], port)
            } else {
                // a ':' that is not a numeric port (e.g. a bare IPv6 group) — no
                // explicit port, fall back to the scheme default below
                (
                    host_port,
                    0, // sentinel, replaced below
                )
            }
        }
        None => (host_port, 0),
    };
    let port = if port != 0 {
        port
    } else {
        default_port(&scheme)
            .ok_or_else(|| format!("url {:?} has no port and scheme {:?} has no default", url, scheme))?
    };
    let host = host_raw.to_ascii_lowercase();
    if host.is_empty() {
        return Err(format!("url {:?} has an empty host", url));
    }
    if host.contains('*') {
        return Err(format!("url {:?} host contains a wildcard", url));
    }
    Ok(Origin { scheme, host, port })
}

/* ------------------------------ EgressDecision ----------------------------- */

/// Where a deny came from (grok's `DenySource`): a per-host deny ROW in the
/// policy, or the org-level `disallowed_web_fetch_domains` denylist.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DenySource {
    DenyRow,
    WebFetchDenylist,
}

impl DenySource {
    pub fn as_str(self) -> &'static str {
        match self {
            DenySource::DenyRow => "deny_row",
            DenySource::WebFetchDenylist => "web_fetch_denylist",
        }
    }
}

/// What enforce mode WOULD have done, recorded by observe mode without blocking
/// (grok's `WouldBe`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WouldBe {
    Allowed,
    Denied(DenySource),
    Asked,
}

impl WouldBe {
    pub fn as_str(self) -> &'static str {
        match self {
            WouldBe::Allowed => "allowed",
            WouldBe::Denied(_) => "denied",
            WouldBe::Asked => "asked",
        }
    }
}

/// The four decider outcomes (grok's `Decision`).
/// `AllowAndRecord{would}` is observe mode: it ADMITS (never blocks) but records
/// what enforce mode would have decided.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EgressDecision {
    Allow,
    Deny(DenySource),
    Ask,
    AllowAndRecord { would: WouldBe },
}

impl EgressDecision {
    /// The stable outcome tag that appears in a `BlockedRequest` record and in
    /// the guard reason — byte-identical to the contracts.ts `EgressOutcome`.
    pub fn outcome_tag(self) -> &'static str {
        match self {
            EgressDecision::Allow => "allow",
            EgressDecision::Deny(_) => "deny",
            EgressDecision::Ask => "ask",
            EgressDecision::AllowAndRecord { .. } => "allow_and_record",
        }
    }

    /// `true` for the two outcomes that let the request proceed (an `Allow` or
    /// an observe-mode `AllowAndRecord`).
    pub fn admits(self) -> bool {
        matches!(
            self,
            EgressDecision::Allow | EgressDecision::AllowAndRecord { .. }
        )
    }
}

/* --------------------------------- Policy ---------------------------------- */

/// A base decision a per-origin rule carries (no observe-mode variant here;
/// observe mode is a POLICY-level flag that wraps any base decision into
/// `AllowAndRecord{would}`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BaseDecision {
    Allow,
    Deny,
    Ask,
}

impl BaseDecision {
    fn parse(s: &str) -> Option<BaseDecision> {
        match s {
            "allow" => Some(BaseDecision::Allow),
            "deny" => Some(BaseDecision::Deny),
            "ask" => Some(BaseDecision::Ask),
            _ => None,
        }
    }
}

/// A per-origin rule: a host (and optional scheme/port) mapped to a base
/// decision. A `None` scheme/port matches any; a `Some` must match exactly.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OriginRule {
    pub host: String,
    pub scheme: Option<String>,
    pub port: Option<u16>,
    pub decision: BaseDecision,
}

impl OriginRule {
    fn matches(&self, origin: &Origin) -> bool {
        self.host == origin.host
            && self.scheme.as_deref().map(|s| s == origin.scheme).unwrap_or(true)
            && self.port.map(|p| p == origin.port).unwrap_or(true)
    }
}

/// The egress policy: per-origin rules + the org-level web-fetch denylist, plus
/// the observe-mode flag.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct EgressPolicy {
    pub rules: Vec<OriginRule>,
    /// Hosts the org forbids outright; a match here denies with
    /// `DenySource::WebFetchDenylist` (grok's `disallowed_web_fetch_domains`).
    pub disallowed_web_fetch_domains: Vec<String>,
    /// Observe mode (grok's safe-rollout path): every enforce-mode answer is
    /// instead returned as `AllowAndRecord{would}` so nothing is blocked while a
    /// new policy is evaluated.
    pub observe: bool,
}

/// The on-disk file name under the state dir.
pub const EGRESS_FILE: &str = "egress.json";

/// Why an egress policy file could not be used. Every variant is a refusal
/// (FAIL CLOSED), mirroring `execpolicy::AllowlistError` /
/// `guard.rs::PolicyError`: the kernel never silently drops a rule it did not
/// understand (a dropped `deny` rule would be a fail-open).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum EgressError {
    Unreadable(String),
    Shape(String),
    Rule { index: usize, detail: String },
}

impl std::fmt::Display for EgressError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            EgressError::Unreadable(detail) => write!(
                f,
                "HZ_PRECONDITION_FAILED: egress.json cannot be read: {}",
                detail
            ),
            EgressError::Shape(detail) => write!(
                f,
                "HZ_PRECONDITION_FAILED: egress.json is malformed: {}",
                detail
            ),
            EgressError::Rule { index, detail } => write!(
                f,
                "HZ_PRECONDITION_FAILED: egress.json rule {} is malformed: {}",
                index, detail
            ),
        }
    }
}

impl std::error::Error for EgressError {}

fn egress_path(state_dir: &Path) -> PathBuf {
    state_dir.join(EGRESS_FILE)
}

/// Load the egress policy from `<state-dir>/egress.json`. `Ok(None)` when the
/// file is genuinely absent — NO egress policy, the decider is not consulted and
/// `net.fetch` keeps its policy-layer `ask` (see the module header). Any other
/// problem is a typed refusal (FAIL CLOSED), exactly like `execpolicy::load`.
pub fn load(state_dir: &Path) -> Result<Option<EgressPolicy>, EgressError> {
    let path = egress_path(state_dir);
    let text = match fs::read_to_string(&path) {
        Ok(text) => text,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(EgressError::Unreadable(e.to_string())),
    };
    parse_policy(&text).map(Some)
}

/// Parse an egress policy document: an object
/// `{ "rules": [...], "disallowedWebFetchDomains": [...], "observe": bool }`,
/// or a bare array of rule objects (then no denylist, enforce mode).
pub fn parse_policy(text: &str) -> Result<EgressPolicy, EgressError> {
    let parsed: Value = serde_json::from_str(text)
        .map_err(|e| EgressError::Shape(format!("not valid JSON: {}", e)))?;

    let (rule_items, denylist_items, observe) = match parsed {
        Value::Array(items) => (items, Vec::new(), false),
        Value::Object(map) => {
            let rules = match map.get("rules") {
                Some(Value::Array(items)) => items.clone(),
                None => Vec::new(),
                _ => return Err(EgressError::Shape("\"rules\" must be an array".to_string())),
            };
            let denylist = match map.get("disallowedWebFetchDomains") {
                Some(Value::Array(items)) => {
                    let mut hosts = Vec::with_capacity(items.len());
                    for (i, item) in items.iter().enumerate() {
                        let raw = item.as_str().ok_or_else(|| EgressError::Shape(format!(
                            "disallowedWebFetchDomains[{}] must be a string",
                            i
                        )))?;
                        let host = crate::execpolicy::normalize_network_rule_host(raw)
                            .map_err(EgressError::Shape)?;
                        hosts.push(host);
                    }
                    hosts
                }
                None => Vec::new(),
                _ => {
                    return Err(EgressError::Shape(
                        "\"disallowedWebFetchDomains\" must be an array".to_string(),
                    ))
                }
            };
            let observe = match map.get("observe") {
                None => false,
                Some(Value::Bool(b)) => *b,
                Some(_) => return Err(EgressError::Shape("\"observe\" must be a boolean".to_string())),
            };
            return finish_policy(rules, denylist, observe);
        }
        _ => {
            return Err(EgressError::Shape(
                "expected a JSON array of rules or an object with \"rules\"".to_string(),
            ))
        }
    };

    finish_policy(rule_items, denylist_items, observe)
}

fn finish_policy(
    rule_items: Vec<Value>,
    denylist: Vec<String>,
    observe: bool,
) -> Result<EgressPolicy, EgressError> {
    let mut rules = Vec::with_capacity(rule_items.len());
    for (index, item) in rule_items.iter().enumerate() {
        rules.push(parse_origin_rule(index, item)?);
    }
    Ok(EgressPolicy {
        rules,
        disallowed_web_fetch_domains: denylist,
        observe,
    })
}

fn parse_origin_rule(index: usize, item: &Value) -> Result<OriginRule, EgressError> {
    let invalid = |detail: String| EgressError::Rule { index, detail };
    let obj = item
        .as_object()
        .ok_or_else(|| invalid("rule must be a JSON object".to_string()))?;

    let raw_host = obj
        .get("host")
        .and_then(|v| v.as_str())
        .ok_or_else(|| invalid("\"host\" must be a string".to_string()))?;
    let host = crate::execpolicy::normalize_network_rule_host(raw_host).map_err(invalid)?;

    let scheme = match obj.get("scheme") {
        None | Some(Value::Null) => None,
        Some(Value::String(s)) => {
            let s = s.trim().to_ascii_lowercase();
            if s.is_empty() {
                return Err(invalid("\"scheme\" must be a non-empty string".to_string()));
            }
            Some(s)
        }
        Some(_) => return Err(invalid("\"scheme\" must be a string".to_string())),
    };

    let port = match obj.get("port") {
        None | Some(Value::Null) => None,
        Some(v) => {
            let n = v
                .as_u64()
                .filter(|n| *n <= u16::MAX as u64)
                .ok_or_else(|| invalid("\"port\" must be a 0..=65535 integer".to_string()))?;
            Some(n as u16)
        }
    };

    let decision = obj
        .get("decision")
        .and_then(|v| v.as_str())
        .and_then(BaseDecision::parse)
        .ok_or_else(|| invalid("\"decision\" must be allow|deny|ask".to_string()))?;

    Ok(OriginRule {
        host,
        scheme,
        port,
        decision,
    })
}

/* --------------------------------- Decider --------------------------------- */

impl EgressPolicy {
    /// The PURE decision for an origin (docs/11 N1/N2). Precedence, enforce mode:
    ///   1. the org web-fetch denylist denies (`DenySource::WebFetchDenylist`);
    ///   2. else a matching deny row denies (`DenySource::DenyRow`) —
    ///      most-restrictive-wins, a deny row beats an allow/ask row;
    ///   3. else a matching allow row allows;
    ///   4. else a matching ask row asks;
    ///   5. else DEFAULT DENY (N1: no rule matched = deny with `DenyRow`).
    ///
    /// In observe mode every one of those answers is wrapped into
    /// `AllowAndRecord{would}` instead of being enforced (nothing is blocked).
    pub fn decide(&self, origin: &Origin) -> EgressDecision {
        let base = self.decide_enforce(origin);
        if self.observe {
            let would = match base {
                EgressDecision::Allow => WouldBe::Allowed,
                EgressDecision::Deny(src) => WouldBe::Denied(src),
                EgressDecision::Ask => WouldBe::Asked,
                // decide_enforce never returns AllowAndRecord
                EgressDecision::AllowAndRecord { would } => would,
            };
            EgressDecision::AllowAndRecord { would }
        } else {
            base
        }
    }

    /// The enforce-mode decision (never an `AllowAndRecord`).
    fn decide_enforce(&self, origin: &Origin) -> EgressDecision {
        if self
            .disallowed_web_fetch_domains
            .iter()
            .any(|h| h == &origin.host)
        {
            return EgressDecision::Deny(DenySource::WebFetchDenylist);
        }
        let mut saw_allow = false;
        let mut saw_ask = false;
        for rule in &self.rules {
            if !rule.matches(origin) {
                continue;
            }
            match rule.decision {
                // a deny row wins immediately (most-restrictive-wins, R1 spirit)
                BaseDecision::Deny => return EgressDecision::Deny(DenySource::DenyRow),
                BaseDecision::Allow => saw_allow = true,
                BaseDecision::Ask => saw_ask = true,
            }
        }
        if saw_allow {
            EgressDecision::Allow
        } else if saw_ask {
            EgressDecision::Ask
        } else {
            // N1: no rule matched -> default deny.
            EgressDecision::Deny(DenySource::DenyRow)
        }
    }

    /// Convenience for a `(url, call)` admission check: parse the url and
    /// decide; an unparseable url is a DENY candidate (never Allow), fail-closed
    /// (N1). `call` is carried only for the record, not the decision.
    pub fn decide_url(&self, url: &str) -> Result<(Origin, EgressDecision), EgressDecision> {
        match parse_origin(url) {
            Ok(origin) => {
                let decision = self.decide(&origin);
                Ok((origin, decision))
            }
            // cannot even name the origin: deny (DenyRow), fail-closed.
            Err(_) => Err(EgressDecision::Deny(DenySource::DenyRow)),
        }
    }
}

/* ------------------------------- HoldBudget -------------------------------- */

/// Default proxy-wide concurrent-hold ceiling (grok `DEFAULT_MAX_HELD`).
pub const DEFAULT_MAX_HELD: u32 = 16;
/// Default per-command-tag concurrent-hold ceiling (grok
/// `DEFAULT_MAX_HELD_PER_CALL`): one command's unanswered asks can't pin every
/// slot.
pub const DEFAULT_MAX_HELD_PER_CALL: u32 = 8;
/// Default hold timeout in seconds (grok `DEFAULT_HOLD_TIMEOUT`): a held request
/// auto-denies (`403`) after this long.
pub const DEFAULT_HOLD_TIMEOUT_SECS: i64 = 600;

/// A command identifier a per-call budget is keyed on (grok's `CommandTag`).
pub type CommandTag = String;

/// Over-budget outcome (grok's `503 overloaded before a card`): a hold is
/// refused because a ceiling is already reached.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Overloaded {
    /// The proxy-wide ceiling (`max_held`) is reached.
    ProxyWide,
    /// This command tag's per-call ceiling (`max_held_per_call`) is reached.
    PerCall,
}

/// A token for one accepted hold; `release` must be given it back. Not `Copy`
/// on purpose so a caller cannot release the same hold twice by value.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HoldToken {
    tag: Option<CommandTag>,
}

/// The accounting half of grok's hold mechanism, modeled as PURE data (no real
/// connection is parked here — that async MITM proxy is DEFERRED, see the module
/// header). Tracks how many holds are outstanding proxy-wide and per command
/// tag, and refuses over-budget BEFORE a card would be raised.
#[derive(Debug, Clone)]
pub struct HoldBudget {
    max_held: u32,
    max_held_per_call: u32,
    held_total: u32,
    held_per_tag: HashMap<Option<CommandTag>, u32>,
}

impl Default for HoldBudget {
    fn default() -> Self {
        HoldBudget::new(DEFAULT_MAX_HELD, DEFAULT_MAX_HELD_PER_CALL)
    }
}

impl HoldBudget {
    pub fn new(max_held: u32, max_held_per_call: u32) -> Self {
        HoldBudget {
            max_held,
            max_held_per_call,
            held_total: 0,
            held_per_tag: HashMap::new(),
        }
    }

    /// Outstanding holds proxy-wide.
    pub fn held_total(&self) -> u32 {
        self.held_total
    }

    /// Try to take one hold for `tag`. Refuses with `Overloaded::ProxyWide` when
    /// the proxy-wide ceiling is reached, or `Overloaded::PerCall` when this
    /// tag's per-call ceiling is reached (the proxy-wide check is first, as
    /// grok's `Semaphore` gate sits before the per-credential budget).
    pub fn try_hold(&mut self, tag: Option<CommandTag>) -> Result<HoldToken, Overloaded> {
        if self.held_total >= self.max_held {
            return Err(Overloaded::ProxyWide);
        }
        let per = self.held_per_tag.get(&tag).copied().unwrap_or(0);
        if per >= self.max_held_per_call {
            return Err(Overloaded::PerCall);
        }
        self.held_total += 1;
        *self.held_per_tag.entry(tag.clone()).or_insert(0) += 1;
        Ok(HoldToken { tag })
    }

    /// Release a previously accepted hold. Saturating at zero so a double
    /// release (should not happen; the token is move-only) can never underflow.
    pub fn release(&mut self, token: HoldToken) {
        self.held_total = self.held_total.saturating_sub(1);
        if let Some(count) = self.held_per_tag.get_mut(&token.tag) {
            *count = count.saturating_sub(1);
            if *count == 0 {
                self.held_per_tag.remove(&token.tag);
            }
        }
    }

    /// The absolute deadline (`deadline_unix`, seconds) a hold taken at
    /// `now_unix_secs` auto-denies at (grok `DEFAULT_HOLD_TIMEOUT`).
    pub fn deadline_unix(now_unix_secs: i64) -> i64 {
        now_unix_secs + DEFAULT_HOLD_TIMEOUT_SECS
    }
}

/* ----------------------------- BlockedRequest ------------------------------ */

/// The bounded record-buffer capacity (grok `BLOCKED_REQUEST_CAPACITY`): the UI
/// card / log channel keeps at most this many recent records.
pub const BLOCKED_REQUEST_CAPACITY: usize = 256;

/// A CONTENT-FREE record of a decided egress request (grok's `BlockedRequest`).
/// Carries ONLY the routing triple, the call tag, the outcome, and the hold
/// timing — deliberately NO `path`, NO `headers`, NO `body`, so a record can
/// never leak a secret-bearing URL query, auth header, or request body into a UI
/// card or a log. A unit test pins that the JSON omits those fields.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BlockedRequest {
    pub host: String,
    pub port: u16,
    /// The command tag / call identifier (NOT a URL — no path/query).
    pub call: String,
    /// The outcome tag (`allow` / `deny` / `ask` / `allow_and_record`).
    pub decided: String,
    /// How long the request was held before it was decided, milliseconds.
    pub hold_ms: u64,
    /// The absolute auto-deny deadline, unix seconds.
    pub deadline_unix: i64,
}

impl BlockedRequest {
    /// Build a record from a decided origin. `decided` is taken from the
    /// `EgressDecision::outcome_tag` so it is byte-identical to the wire tag.
    pub fn new(
        origin: &Origin,
        call: &str,
        decided: EgressDecision,
        hold_ms: u64,
        deadline_unix: i64,
    ) -> Self {
        BlockedRequest {
            host: origin.host.clone(),
            port: origin.port,
            call: call.to_string(),
            decided: decided.outcome_tag().to_string(),
            hold_ms,
            deadline_unix,
        }
    }

    /// A canonical, content-free JSON object (through the LAW canonical form).
    /// The set of keys is fixed and carries no secret-bearing field.
    pub fn to_json(&self) -> Value {
        json!({
            "host": self.host,
            "port": self.port,
            "call": self.call,
            "decided": self.decided,
            "holdMs": self.hold_ms,
            "deadlineUnix": self.deadline_unix,
        })
    }

    /// The canonical-JSON string of this record (LAW reuse: `canon`).
    pub fn to_canonical_json(&self) -> String {
        crate::canon::canonical_json(&self.to_json())
    }
}

/* ----------------------------------- tests ---------------------------------- */

#[cfg(test)]
mod tests {
    use super::*;

    fn origin(scheme: &str, host: &str, port: u16) -> Origin {
        Origin {
            scheme: scheme.to_string(),
            host: host.to_string(),
            port,
        }
    }

    #[test]
    fn parse_origin_lowercases_host_and_applies_default_ports() {
        let o = parse_origin("https://API.Example.COM/v1/models?q=1").unwrap();
        assert_eq!(o, origin("https", "api.example.com", 443));
        let o = parse_origin("http://example.com").unwrap();
        assert_eq!(o, origin("http", "example.com", 80));
        // explicit port wins over the scheme default
        let o = parse_origin("https://example.com:8443/x").unwrap();
        assert_eq!(o, origin("https", "example.com", 8443));
        // userinfo is stripped, scheme lowercased
        let o = parse_origin("HTTPS://user:pw@Host.test:9000").unwrap();
        assert_eq!(o, origin("https", "host.test", 9000));
    }

    #[test]
    fn parse_origin_fails_closed_on_garbage() {
        for bad in [
            "",
            "   ",
            "not a url",            // whitespace + no scheme
            "example.com/path",     // no scheme
            "https://",             // empty authority
            "ftp://example.com",    // scheme with no default port and no explicit one
            "https://ex*ample.com", // wildcard host
            "https://example.com:999999", // out-of-range port
        ] {
            assert!(parse_origin(bad).is_err(), "expected {:?} to fail", bad);
        }
    }

    #[test]
    fn default_deny_when_no_rule_matches() {
        // N1: a policy with no matching rule denies.
        let policy = EgressPolicy {
            rules: vec![OriginRule {
                host: "allowed.test".to_string(),
                scheme: None,
                port: None,
                decision: BaseDecision::Allow,
            }],
            disallowed_web_fetch_domains: vec![],
            observe: false,
        };
        assert_eq!(
            policy.decide(&origin("https", "other.test", 443)),
            EgressDecision::Deny(DenySource::DenyRow)
        );
        // an empty policy denies everything (N1)
        let empty = EgressPolicy::default();
        assert_eq!(
            empty.decide(&origin("https", "any.test", 443)),
            EgressDecision::Deny(DenySource::DenyRow)
        );
    }

    #[test]
    fn per_origin_rule_returns_its_decision() {
        let policy = EgressPolicy {
            rules: vec![
                OriginRule {
                    host: "allow.test".to_string(),
                    scheme: None,
                    port: None,
                    decision: BaseDecision::Allow,
                },
                OriginRule {
                    host: "deny.test".to_string(),
                    scheme: None,
                    port: None,
                    decision: BaseDecision::Deny,
                },
                OriginRule {
                    host: "ask.test".to_string(),
                    scheme: None,
                    port: None,
                    decision: BaseDecision::Ask,
                },
            ],
            disallowed_web_fetch_domains: vec![],
            observe: false,
        };
        assert_eq!(
            policy.decide(&origin("https", "allow.test", 443)),
            EgressDecision::Allow
        );
        assert_eq!(
            policy.decide(&origin("https", "deny.test", 443)),
            EgressDecision::Deny(DenySource::DenyRow)
        );
        assert_eq!(
            policy.decide(&origin("https", "ask.test", 443)),
            EgressDecision::Ask
        );
    }

    #[test]
    fn deny_row_wins_over_allow_row_most_restrictive() {
        let policy = EgressPolicy {
            rules: vec![
                OriginRule {
                    host: "mixed.test".to_string(),
                    scheme: None,
                    port: None,
                    decision: BaseDecision::Allow,
                },
                OriginRule {
                    host: "mixed.test".to_string(),
                    scheme: None,
                    port: None,
                    decision: BaseDecision::Deny,
                },
            ],
            disallowed_web_fetch_domains: vec![],
            observe: false,
        };
        assert_eq!(
            policy.decide(&origin("https", "mixed.test", 443)),
            EgressDecision::Deny(DenySource::DenyRow)
        );
    }

    #[test]
    fn web_fetch_denylist_denies_with_its_source() {
        let policy = EgressPolicy {
            // even an explicit allow row cannot lift the org denylist
            rules: vec![OriginRule {
                host: "blocked.test".to_string(),
                scheme: None,
                port: None,
                decision: BaseDecision::Allow,
            }],
            disallowed_web_fetch_domains: vec!["blocked.test".to_string()],
            observe: false,
        };
        assert_eq!(
            policy.decide(&origin("https", "blocked.test", 443)),
            EgressDecision::Deny(DenySource::WebFetchDenylist)
        );
    }

    #[test]
    fn scheme_and_port_scoped_rules_match_exactly() {
        let policy = EgressPolicy {
            rules: vec![OriginRule {
                host: "scoped.test".to_string(),
                scheme: Some("https".to_string()),
                port: Some(8443),
                decision: BaseDecision::Allow,
            }],
            disallowed_web_fetch_domains: vec![],
            observe: false,
        };
        assert_eq!(
            policy.decide(&origin("https", "scoped.test", 8443)),
            EgressDecision::Allow
        );
        // wrong port -> no match -> default deny
        assert_eq!(
            policy.decide(&origin("https", "scoped.test", 443)),
            EgressDecision::Deny(DenySource::DenyRow)
        );
        // wrong scheme -> no match -> default deny
        assert_eq!(
            policy.decide(&origin("http", "scoped.test", 8443)),
            EgressDecision::Deny(DenySource::DenyRow)
        );
    }

    #[test]
    fn observe_mode_records_would_without_blocking() {
        // Each enforce answer becomes AllowAndRecord{would: ...} and ADMITS.
        let make = |decision: BaseDecision, denylist: Vec<String>| EgressPolicy {
            rules: vec![OriginRule {
                host: "obs.test".to_string(),
                scheme: None,
                port: None,
                decision,
            }],
            disallowed_web_fetch_domains: denylist,
            observe: true,
        };
        // would-Allowed
        let d = make(BaseDecision::Allow, vec![]).decide(&origin("https", "obs.test", 443));
        assert_eq!(d, EgressDecision::AllowAndRecord { would: WouldBe::Allowed });
        assert!(d.admits());
        // would-Denied(DenyRow)
        let d = make(BaseDecision::Deny, vec![]).decide(&origin("https", "obs.test", 443));
        assert_eq!(
            d,
            EgressDecision::AllowAndRecord {
                would: WouldBe::Denied(DenySource::DenyRow)
            }
        );
        assert!(d.admits());
        // would-Asked
        let d = make(BaseDecision::Ask, vec![]).decide(&origin("https", "obs.test", 443));
        assert_eq!(d, EgressDecision::AllowAndRecord { would: WouldBe::Asked });
        assert!(d.admits());
        // would-Denied(WebFetchDenylist)
        let d = make(BaseDecision::Allow, vec!["obs.test".to_string()])
            .decide(&origin("https", "obs.test", 443));
        assert_eq!(
            d,
            EgressDecision::AllowAndRecord {
                would: WouldBe::Denied(DenySource::WebFetchDenylist)
            }
        );
        assert!(d.admits());
        // and a default-deny (no rule) in observe mode would-Denies(DenyRow)
        let d = EgressPolicy {
            rules: vec![],
            disallowed_web_fetch_domains: vec![],
            observe: true,
        }
        .decide(&origin("https", "unknown.test", 443));
        assert_eq!(
            d,
            EgressDecision::AllowAndRecord {
                would: WouldBe::Denied(DenySource::DenyRow)
            }
        );
    }

    #[test]
    fn decide_url_fails_closed_on_unparseable() {
        let policy = EgressPolicy::default();
        // a parseable-but-unmatched origin -> default deny (Ok)
        assert!(matches!(
            policy.decide_url("https://unknown.test/x"),
            Ok((_, EgressDecision::Deny(DenySource::DenyRow)))
        ));
        // garbage -> deny candidate (Err), never Allow
        assert_eq!(
            policy.decide_url("not a url"),
            Err(EgressDecision::Deny(DenySource::DenyRow))
        );
    }

    #[test]
    fn hold_budget_refuses_at_the_proxy_wide_ceiling() {
        let mut budget = HoldBudget::new(DEFAULT_MAX_HELD, DEFAULT_MAX_HELD_PER_CALL);
        // 16 distinct tags each take one slot -> proxy-wide ceiling reached.
        let mut tokens = Vec::new();
        for i in 0..DEFAULT_MAX_HELD {
            let token = budget
                .try_hold(Some(format!("tag-{}", i)))
                .expect("under ceiling");
            tokens.push(token);
        }
        assert_eq!(budget.held_total(), DEFAULT_MAX_HELD);
        // one more (a fresh tag) is refused proxy-wide, not per-call.
        assert_eq!(
            budget.try_hold(Some("tag-overflow".to_string())),
            Err(Overloaded::ProxyWide)
        );
        // releasing one makes room again.
        budget.release(tokens.pop().unwrap());
        assert!(budget.try_hold(Some("tag-after-release".to_string())).is_ok());
    }

    #[test]
    fn hold_budget_refuses_at_the_per_call_ceiling() {
        let mut budget = HoldBudget::new(DEFAULT_MAX_HELD, DEFAULT_MAX_HELD_PER_CALL);
        let tag = Some("one-command".to_string());
        let mut tokens = Vec::new();
        for _ in 0..DEFAULT_MAX_HELD_PER_CALL {
            tokens.push(budget.try_hold(tag.clone()).expect("under per-call ceiling"));
        }
        // the per-call ceiling (8) is hit before the proxy-wide one (16).
        assert_eq!(budget.try_hold(tag.clone()), Err(Overloaded::PerCall));
        // a DIFFERENT tag still has room (per-call is per tag).
        assert!(budget.try_hold(Some("other-command".to_string())).is_ok());
        // release one of the first tag's holds -> room for that tag again.
        budget.release(tokens.pop().unwrap());
        assert!(budget.try_hold(tag).is_ok());
    }

    #[test]
    fn deadline_unix_adds_the_hold_timeout() {
        assert_eq!(HoldBudget::deadline_unix(1_000), 1_000 + DEFAULT_HOLD_TIMEOUT_SECS);
    }

    #[test]
    fn blocked_request_is_content_free() {
        let o = origin("https", "example.com", 443);
        let rec = BlockedRequest::new(&o, "web.fetch", EgressDecision::Deny(DenySource::DenyRow), 12, 1_600);
        let value = rec.to_json();
        let obj = value.as_object().expect("object");
        // EXACTLY these keys, and NONE of the secret-bearing ones.
        let mut keys: Vec<&str> = obj.keys().map(String::as_str).collect();
        keys.sort();
        assert_eq!(keys, ["call", "deadlineUnix", "decided", "holdMs", "host", "port"]);
        for forbidden in ["path", "headers", "header", "body", "url", "query"] {
            assert!(!obj.contains_key(forbidden), "record must omit {:?}", forbidden);
        }
        assert_eq!(obj["decided"], json!("deny"));
        // canonical form is stable and content-free too.
        assert!(!rec.to_canonical_json().contains("body"));
    }

    #[test]
    fn malformed_egress_policy_fails_closed() {
        // not JSON
        assert!(matches!(parse_policy("{nope"), Err(EgressError::Shape(_))));
        // a bad rule names its index
        let err = parse_policy(r#"[{"host":"x","decision":"maybe"}]"#).unwrap_err();
        assert!(matches!(err, EgressError::Rule { index: 0, .. }));
        assert!(err.to_string().contains("HZ_PRECONDITION_FAILED"));
        // a wildcard host is rejected (reused host normalization)
        assert!(parse_policy(r#"[{"host":"*.evil","decision":"deny"}]"#).is_err());
    }

    #[test]
    fn absent_egress_policy_is_none_not_error() {
        let dir = std::env::temp_dir().join(format!("hz-egress-absent-{}", std::process::id()));
        let _ = std::fs::create_dir_all(&dir);
        let _ = std::fs::remove_file(dir.join(EGRESS_FILE));
        assert_eq!(load(&dir).unwrap(), None);
    }

    #[test]
    fn object_form_parses_rules_denylist_and_observe() {
        let policy = parse_policy(
            r#"{
                "rules": [{ "host": "api.test", "scheme": "https", "port": 443, "decision": "allow" }],
                "disallowedWebFetchDomains": ["Evil.test"],
                "observe": true
            }"#,
        )
        .unwrap();
        assert!(policy.observe);
        assert_eq!(policy.disallowed_web_fetch_domains, vec!["evil.test".to_string()]);
        assert_eq!(policy.rules.len(), 1);
        assert_eq!(policy.rules[0].port, Some(443));
    }
}
