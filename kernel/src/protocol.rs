//! Kernel protocol: NDJSON stdio request/response dispatch.
//!
//! One request per line: `{"id":<number>,"method":"...","params":{...}}`
//! Exactly one response line per request:
//!   `{"id":<number>,"result":{...}}` or `{"id":<number>,"error":{"message":"..."}}`
//! Malformed lines answer with `"id": null` and the kernel never exits on bad input.

use std::path::Path;

use serde_json::{json, Value};

use crate::canon::error_response;
use crate::eventlog::{AnchorConfig, EventLog};
use crate::guard::{self, Guard, GuardAction, Lease};
use crate::receipts::Receipts;

pub const VERSION: &str = env!("CARGO_PKG_VERSION");

pub struct Kernel {
    events: EventLog,
    receipts: Receipts,
    guard: Guard,
}

impl Kernel {
    pub fn new_with_anchor(state_dir: &Path, anchor: AnchorConfig) -> Self {
        Kernel {
            events: EventLog::new_with_anchor(state_dir, anchor.clone()),
            receipts: Receipts::new_with_anchor(state_dir, anchor),
            guard: Guard::new(state_dir),
        }
    }

    /// Never panics: any bad input becomes an `error` response.
    pub fn handle(&self, request: &Value) -> Value {
        let Some(object) = request.as_object() else {
            return error_response(Value::Null, "request must be a JSON object");
        };
        let id = match object.get("id") {
            Some(Value::Number(n)) => Value::Number(n.clone()),
            _ => Value::Null,
        };
        let Some(method) = object.get("method").and_then(|m| m.as_str()) else {
            return error_response(id, "request.method must be a string");
        };
        let params = object.get("params").cloned().unwrap_or(Value::Null);
        match self.dispatch(method, &params) {
            Ok(result) => json!({ "id": id, "result": result }),
            Err(message) => error_response(id, &message),
        }
    }

    fn dispatch(&self, method: &str, params: &Value) -> Result<Value, String> {
        match method {
            "ping" => Ok(json!({ "version": VERSION })),

            "log.append" => {
                let stream = string_param(params, "stream")?;
                let event = params
                    .get("event")
                    .ok_or_else(|| "log.append.event is required".to_string())?;
                self.events.append(&stream, event)
            }

            "log.read" => {
                let stream = string_param(params, "stream")?;
                let events = self.events.read(
                    &stream,
                    number_param(params, "fromSeq"),
                    number_param(params, "limit").map(|n| n as usize),
                )?;
                Ok(json!({ "events": events }))
            }

            "log.verify" => {
                let stream = string_param(params, "stream")?;
                Ok(self.events.verify(&stream)?.to_json())
            }

            "receipt.issue" => self.receipts.issue(params),

            "receipt.verify" => Ok(self.receipts.verify()?.to_json()),

            "guard.check" => {
                let action = params
                    .get("action")
                    .and_then(|a| a.as_object())
                    .ok_or_else(|| "guard.check.action must be an object".to_string())?;
                let kind = action
                    .get("kind")
                    .and_then(|v| v.as_str())
                    .filter(|s| !s.is_empty())
                    .ok_or_else(|| "guard.check.action.kind must be a non-empty string".to_string())?
                    .to_string();
                // Fail closed before evaluation: an unknown kind (a raw
                // client's "fs.edit") must never reach the policy as an
                // unrecognised action (guard.rs keeps the structural state-dir
                // rule keyed to the exact mutating kind).
                if !guard::known_kind(&kind) {
                    return Err(guard::unknown_kind_refusal(&kind));
                }
                let target = action
                    .get("target")
                    .and_then(|v| v.as_str())
                    .ok_or_else(|| "guard.check.action.target must be a string".to_string())?
                    .to_string();
                let scope = params
                    .get("scope")
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string());
                // Additive sessionId: when present, owner-scoped leases only
                // cover checks carrying the same id (a subagent child's check
                // must not inherit its parent session's "always" grant).
                let session_id = session_param(params);
                let leases = lease_list(params.get("leases"))?;
                let decision = self
                    .guard
                    .check(
                        &GuardAction { kind, target },
                        scope.as_deref(),
                        &leases,
                        session_id.as_deref(),
                    )
                    .map_err(|e| e.to_string())?;
                Ok(decision.to_json())
            }

            "guard.lease" => {
                let kind = string_param(params, "kind")?;
                // The same vocabulary rule as guard.check: a lease for a kind
                // the guard does not know could never be consulted, so minting
                // one is refused rather than silently held.
                if !guard::known_kind(&kind) {
                    return Err(guard::unknown_kind_refusal(&kind));
                }
                let pattern = string_param(params, "pattern")?;
                let ttl_ms = number_param(params, "ttlMs")
                    .ok_or_else(|| "guard.lease.ttlMs must be a number".to_string())?;
                // Additive: a client that supplies sessionId mints a lease owned
                // by that session; one that does not mints a legacy owner-less
                // lease, which stays globally consultable (documented legacy).
                let owner = session_param(params);
                let lease = self.guard.issue_lease(&kind, &pattern, ttl_ms, owner);
                serde_json::to_value(lease).map_err(|e| format!("cannot serialize lease: {}", e))
            }

            // docs/11 L7 reduced form (ruling 32): "always" mints a session
            // GRANT, not a reusable lease. Same validation and wire shape as
            // guard.lease; the guard consults grants only where the answer
            // would be `ask`, and each matching check mints a fresh one-use
            // lease bound to that exact effect (the receipt cites that lease).
            "guard.grant" => {
                let kind = string_param(params, "kind")?;
                if !guard::known_kind(&kind) {
                    return Err(guard::unknown_kind_refusal(&kind));
                }
                let pattern = string_param(params, "pattern")?;
                let ttl_ms = number_param(params, "ttlMs")
                    .ok_or_else(|| "guard.grant.ttlMs must be a number".to_string())?;
                let owner = session_param(params);
                let grant = self.guard.issue_grant(&kind, &pattern, ttl_ms, owner);
                serde_json::to_value(grant).map_err(|e| format!("cannot serialize grant: {}", e))
            }

            other => Err(format!("unknown method: {}", other)),
        }
    }
}

fn string_param(params: &Value, key: &str) -> Result<String, String> {
    params
        .get(key)
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string())
        .ok_or_else(|| format!("{} must be a non-empty string", key))
}

fn number_param(params: &Value, key: &str) -> Option<u64> {
    let value = params.get(key)?;
    value
        .as_u64()
        .or_else(|| value.as_f64().filter(|f| f.is_finite() && *f >= 0.0).map(|f| f as u64))
}

/// The optional `sessionId` an owner-scoped method may carry; absent, null or
/// an empty/blank string all mean "no session" (legacy, owner-less semantics).
fn session_param(params: &Value) -> Option<String> {
    params
        .get("sessionId")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string())
}

fn lease_list(value: Option<&Value>) -> Result<Vec<Lease>, String> {
    match value {
        None | Some(Value::Null) => Ok(Vec::new()),
        Some(Value::Array(items)) => items
            .iter()
            .enumerate()
            .map(|(i, item)| {
                serde_json::from_value::<Lease>(item.clone())
                    .map_err(|e| format!("leases[{}] is not a valid lease: {}", i, e))
            })
            .collect(),
        Some(_) => Err("guard.check.leases must be an array".to_string()),
    }
}
