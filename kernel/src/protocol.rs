//! Kernel protocol: NDJSON stdio request/response dispatch.
//!
//! One request per line: `{"id":<number>,"method":"...","params":{...}}`
//! Exactly one response line per request:
//!   `{"id":<number>,"result":{...}}` or `{"id":<number>,"error":{"message":"..."}}`
//! Malformed lines answer with `"id": null` and the kernel never exits on bad input.

use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;

use serde_json::{json, Value};

use crate::canon::error_response;
use crate::effect_host;
use crate::effect_owner;
use crate::egress_connect;
use crate::eventlog::{AnchorConfig, EventLog};
use crate::guard::{self, Guard, GuardAction, Lease};
use crate::human_principal;
use crate::receipts::Receipts;
use crate::sandbox;
use crate::workspace_binding::WorkspaceBinding;

pub const VERSION: &str = env!("CARGO_PKG_VERSION");

pub struct Kernel {
    events: EventLog,
    receipts: Receipts,
    guard: Guard,
    /// Private launch-scoped control credential; never exposed on the wire.
    control_secret: Option<String>,
    /// Bound at process launch, not from a caller's effect.execute params.
    /// A raw RPC may narrow to this workspace, never widen it. Standalone
    /// kernels started without the variable remain explicitly unbound.
    workspace_root: Option<std::path::PathBuf>,
    /// H-31 / ruling 623: `(root, device, inode)` captured when
    /// `HZ_KERNEL_WORKSPACE_ROOT` is set. `Err` means the env was set but
    /// identity could not be captured — mutating effects fail closed.
    workspace_binding: Result<Option<WorkspaceBinding>, String>,
    egress_connect: Mutex<egress_connect::ListenerSlot>,
    effect_hermetic: effect_host::SharedHermeticLedger,
    /// H-30 / 634: monotonic detach supervisor epoch (0 = stdio-only / unset).
    supervisor_epoch: AtomicU64,
    /// H-30 / 709: running image digest after `--socket` bind (unset on stdio-only).
    supervisor_binary_sha: Mutex<Option<String>>,
}

impl Kernel {
    pub fn new_with_anchor(state_dir: &Path, anchor: AnchorConfig) -> Self {
        Self::new_with_control(state_dir, anchor, None, None)
    }

    pub fn new_with_control(
        state_dir: &Path,
        anchor: AnchorConfig,
        control_secret: Option<String>,
        issuer_key: Option<Vec<u8>>,
    ) -> Self {
        let workspace_root = std::env::var_os("HZ_KERNEL_WORKSPACE_ROOT")
            .filter(|s| !s.is_empty())
            .map(std::path::PathBuf::from);
        let workspace_binding = match &workspace_root {
            None => Ok(None),
            Some(root) => match WorkspaceBinding::capture(root) {
                Ok(b) => Ok(Some(b)),
                Err(e) => Err(e),
            },
        };
        let mut guard = Guard::new(state_dir);
        // H-31 / 629: fold launch binding into every Guard decision digest.
        if let Ok(Some(ref binding)) = workspace_binding {
            guard.set_workspace_binding(Some(binding.clone()));
        }
        Kernel {
            events: EventLog::new_with_anchor(state_dir, anchor.clone()),
            receipts: Receipts::new_with_anchor(state_dir, anchor, issuer_key),
            guard,
            control_secret,
            workspace_root,
            workspace_binding,
            egress_connect: Mutex::new(egress_connect::ListenerSlot::new()),
            effect_hermetic: Mutex::new(effect_host::HermeticEffectLedger::default()),
            supervisor_epoch: AtomicU64::new(0),
            supervisor_binary_sha: Mutex::new(None),
        }
    }

    /// Record the detach supervisor epoch after `hzk.epoch` advances (ruling 634).
    pub fn set_supervisor_epoch(&self, epoch: u64) {
        self.supervisor_epoch.store(epoch, Ordering::SeqCst);
    }

    pub fn supervisor_epoch(&self) -> u64 {
        self.supervisor_epoch.load(Ordering::SeqCst)
    }

    /// Running image digest after `--socket` bind (H-30 partial; unset on stdio-only).
    pub fn set_supervisor_binary_sha(&self, sha: Option<String>) {
        *self.supervisor_binary_sha.lock().unwrap() = sha;
    }

    pub fn supervisor_binary_sha(&self) -> Option<String> {
        self.supervisor_binary_sha.lock().unwrap().clone()
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

    /// A workspace-bound kernel must not become an unauthenticated approval
    /// mint merely because its launcher omitted the control pipe. Independent
    /// standalone kernels without a product workspace retain the documented
    /// legacy compatibility mode; product instances require the parent pipe.
    fn authorize_parent_control(&self, params: &Value) -> Result<(), String> {
        if self.workspace_root.is_some() && self.control_secret.is_none() {
            return Err(
                "HZ_PRECONDITION_FAILED: workspace-bound kernel lacks private parent control channel; permission mint refused"
                    .into(),
            );
        }
        crate::control_auth::authorize_mint(
            self.control_secret.as_deref(),
            params.get("approvalProof").and_then(Value::as_str),
        )
    }

    fn dispatch(&self, method: &str, params: &Value) -> Result<Value, String> {
        match method {
            "ping" => {
                let mut out = json!({ "version": VERSION });
                if let Some(obj) = out.as_object_mut() {
                    obj.insert(
                        "socketPeerAuth".to_string(),
                        crate::peer_auth::socket_peer_auth_json(),
                    );
                    obj.insert(
                        "hostSupervisorLease".to_string(),
                        crate::host_supervisor_lease::host_supervisor_lease_json(),
                    );
                }
                if let Ok(Some(binding)) = &self.workspace_binding {
                    if let Some(obj) = out.as_object_mut() {
                        obj.insert("workspaceBinding".to_string(), binding.to_json());
                    }
                } else if let Err(err) = &self.workspace_binding {
                    if let Some(obj) = out.as_object_mut() {
                        obj.insert(
                            "workspaceBindingError".to_string(),
                            json!(err),
                        );
                    }
                }
                let epoch = self.supervisor_epoch();
                if epoch > 0 {
                    if let Some(obj) = out.as_object_mut() {
                        obj.insert("supervisorEpoch".to_string(), json!(epoch));
                    }
                }
                if let Some(sha) = self.supervisor_binary_sha() {
                    if let Some(obj) = out.as_object_mut() {
                        obj.insert("supervisorBinarySha256".to_string(), json!(sha));
                    }
                }
                Ok(out)
            }

            "log.append" => {
                let stream = string_param(params, "stream")?;
                // The owner stream is exclusively kernel-generated. Letting
                // caller log.append forge a settlement defeats R170.
                if stream.starts_with("owner:") {
                    return Err(
                        "HZ_PRECONDITION_FAILED: owner event streams are kernel-only".into(),
                    );
                }
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

            "receipt.issue" => {
                // The OwnerLog issues its own independently observed receipts.
                // A raw NDJSON client must not mint a plausible signed receipt
                // for an effect it never executed. Product parent callers still
                // use the existing additive input contract and control proof.
                self.authorize_parent_control(params)?;
                self.receipts.issue(params)
            },

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
                    .ok_or_else(|| {
                        "guard.check.action.kind must be a non-empty string".to_string()
                    })?
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
                self.authorize_parent_control(params)?;
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
                let (owner, principal_in) = mint_owner_and_principal(params);
                let principal = human_principal::normalize_parent_control_mint_principal(
                    self.control_secret.is_some(),
                    principal_in,
                )?;
                let lease = self.guard.issue_lease(&kind, &pattern, ttl_ms, owner, principal);
                serde_json::to_value(lease).map_err(|e| format!("cannot serialize lease: {}", e))
            }

            // docs/11 L7 reduced form (ruling 32): "always" mints a session
            // GRANT, not a reusable lease. Same validation and wire shape as
            // guard.lease; the guard consults grants only where the answer
            // would be `ask`, and each matching check mints a fresh one-use
            // lease bound to that exact effect (the receipt cites that lease).
            "guard.grant" => {
                self.authorize_parent_control(params)?;
                let kind = string_param(params, "kind")?;
                if !guard::known_kind(&kind) {
                    return Err(guard::unknown_kind_refusal(&kind));
                }
                let pattern = string_param(params, "pattern")?;
                let ttl_ms = number_param(params, "ttlMs")
                    .ok_or_else(|| "guard.grant.ttlMs must be a number".to_string())?;
                let (owner, principal_in) = mint_owner_and_principal(params);
                let principal = human_principal::normalize_parent_control_mint_principal(
                    self.control_secret.is_some(),
                    principal_in,
                )?;
                let grant = self.guard.issue_grant(&kind, &pattern, ttl_ms, owner, principal);
                serde_json::to_value(grant).map_err(|e| format!("cannot serialize grant: {}", e))
            }

            // Read-only grant lookup for approval TTL hydrate (Wave C §8 #6).
            // Same action/session validation as guard.check; no parent-control mint.
            "guard.grant.query" => {
                let action = params
                    .get("action")
                    .and_then(|a| a.as_object())
                    .ok_or_else(|| "guard.grant.query.action must be an object".to_string())?;
                let kind = action
                    .get("kind")
                    .and_then(|v| v.as_str())
                    .filter(|s| !s.is_empty())
                    .ok_or_else(|| "guard.grant.query.action.kind must be a non-empty string".to_string())?
                    .to_string();
                if !guard::known_kind(&kind) {
                    return Err(guard::unknown_kind_refusal(&kind));
                }
                let target = action
                    .get("target")
                    .and_then(|v| v.as_str())
                    .ok_or_else(|| "guard.grant.query.action.target must be a string".to_string())?
                    .to_string();
                let session_id = session_param(params);
                let grant = self.guard.query_matching_grant(
                    &guard::GuardAction { kind, target },
                    session_id.as_deref(),
                );
                Ok(match grant {
                    Some(g) => json!({ "grant": g }),
                    None => json!({ "grant": Value::Null }),
                })
            }

            // FEAT-002: append a rule to the runtime command allowlist
            // (<state-dir>/allowlist.json), file-locked append-dedup. Additive,
            // mirrored in contracts.ts KERNEL_METHODS + KernelRequestMap; the
            // NDJSON envelope is unchanged. An unknown `kind` is refused the way
            // guard.lease refuses an unknown action kind. Returns
            // {changed, fingerprint}.
            "guard.allowlist.amend" => {
                self.authorize_parent_control(params)?;
                let rule = params
                    .get("rule")
                    .filter(|v| v.is_object())
                    .ok_or_else(|| "guard.allowlist.amend.rule must be an object".to_string())?;
                // Default to a prefix (command) rule; "network" for an egress rule.
                let kind = params
                    .get("kind")
                    .and_then(|v| v.as_str())
                    .unwrap_or("prefix");
                let (changed, fingerprint) = match kind {
                    "prefix" => {
                        let parsed = guard::prefix_rule_from_value(rule)
                            .map_err(|e| e.to_string())?;
                        self.guard
                            .amend_allow_prefix_rule(&parsed)
                            .map_err(|e| e.to_string())?
                    }
                    "network" => {
                        let parsed = guard::network_rule_from_value(rule)
                            .map_err(|e| e.to_string())?;
                        self.guard
                            .amend_network_rule(&parsed)
                            .map_err(|e| e.to_string())?
                    }
                    other => {
                        return Err(format!(
                            "guard.allowlist.amend.kind {:?} is unknown; expected \"prefix\" or \"network\"",
                            other
                        ))
                    }
                };
                Ok(json!({ "changed": changed, "fingerprint": fingerprint }))
            }

            // FEAT-004: report the fail-closed per-call SandboxMode enforcement
            // posture against the LIVE host capabilities AND a live
            // `hz-sandbox-exec -- /bin/true` canary. Additive, mirrored in
            // contracts.ts KERNEL_METHODS + KernelRequestMap; the NDJSON
            // envelope is unchanged. Every answer carries a `probe` object;
            // `probe.probed=false` means confinement could not be proven, and
            // no dimension is then reported `enforced`. Validates the requested
            // mode and the optional escalation args (sandbox_permissions +
            // justification must travel together, justification non-empty)
            // BEFORE anything, and FAILS CLOSED: a mode that requires FS
            // confinement unavailable here returns a typed SANDBOX_UNAVAILABLE
            // (HZ_PRECONDITION_FAILED class) — NEVER a silent 'enforced', NEVER
            // silently unconfined. A caller that can tolerate a partial boundary
            // passes {"allowPartial":true} to receive an EnforcementReport with
            // completeness=partial instead.
            "sandbox.report" => {
                let mode = sandbox_mode_param(params, "mode")?;

                // Validate the escalation pairing up front (dsh
                // validateEscalationArgs): sandbox_permissions + justification
                // travel together, justification non-empty. Applying the
                // one-shot widen itself needs an approver/UI the kernel does not
                // own, so the kernel validates-and-reports; the effective mode
                // reported is the requested mode (the widen is a runtime seam).
                let raw_permissions = match params.get("sandboxPermissions") {
                    None | Some(Value::Null) => None,
                    Some(v) => {
                        let s = v.as_str().ok_or_else(|| {
                            "sandbox.report.sandboxPermissions must be a string".to_string()
                        })?;
                        Some(sandbox::SandboxMode::parse(s).ok_or_else(|| {
                            format!(
                                "sandbox.report.sandboxPermissions {:?} is not a known mode",
                                s
                            )
                        })?)
                    }
                };
                let raw_justification = match params.get("justification") {
                    None | Some(Value::Null) => None,
                    Some(v) => Some(v.as_str().ok_or_else(|| {
                        "sandbox.report.justification must be a string".to_string()
                    })?),
                };
                // Only validate the pairing when either half was supplied: a
                // bare report (no escalation) is legal.
                if raw_permissions.is_some() || raw_justification.is_some() {
                    sandbox::validate_escalation_args(raw_permissions, raw_justification)
                        .map_err(|e| e.to_string())?;
                }

                // An FS-confined mode demands full FS enforcement unless the
                // caller opts into a partial boundary.
                let allow_partial = match params.get("allowPartial") {
                    None | Some(Value::Null) => false,
                    Some(Value::Bool(b)) => *b,
                    Some(_) => {
                        return Err("sandbox.report.allowPartial must be a boolean".to_string())
                    }
                };
                let demand_full = mode.requires_fs_confinement() && !allow_partial;

                let caps = sandbox::capabilities();
                let outcome = sandbox::enforce(
                    mode,
                    caps,
                    &sandbox::kernel_applied_mechanisms(),
                    demand_full,
                );
                // The probe is part of the answer, not an internal detail: a
                // report that could not be probed says `probed:false` instead of
                // implying enforcement, and a passing probe names the exact
                // child-net posture (notably the WSL `on` default).
                let mut result = outcome.to_json();
                if let Some(object) = result.as_object_mut() {
                    object.insert(
                        "probe".to_string(),
                        sandbox::probe_sandbox_exec().to_json(),
                    );
                }
                Ok(result)
            }

            // EffectHost mirror for callers not entering the direct owner seam.
            "effect.reconcile" => effect_host::reconcile_params(params),

            // Kernel-owned, cross-process five-phase effect execution.
            // The OS owner lock covers prepare, execute, postimage and settle.
            "effect.execute" => {
                if effect_owner::is_mutating(params) {
                    if let Err(err) = &self.workspace_binding {
                        return Err(err.clone());
                    }
                    if let Ok(Some(binding)) = &self.workspace_binding {
                        let supplied = params
                            .get("sandboxRoot")
                            .and_then(Value::as_str)
                            .filter(|s| !s.is_empty())
                            .ok_or_else(|| {
                                "HZ_PRECONDITION_FAILED: bound effect.execute requires sandboxRoot"
                                    .to_string()
                            })?;
                        if !Path::new(supplied).is_absolute() {
                            return Err("HZ_PRECONDITION_FAILED: effect.execute sandboxRoot does not equal kernel-bound workspace root".into());
                        }
                        // H-31: path text alone is insufficient — live (dev,ino)
                        // must still match the launch-time binding.
                        binding.check_path(Path::new(supplied))?;
                    } else if let Some(bound) = &self.workspace_root {
                        // Defensive: env set but binding missing should not happen.
                        let supplied = params
                            .get("sandboxRoot")
                            .and_then(Value::as_str)
                            .filter(|s| !s.is_empty())
                            .ok_or_else(|| {
                                "HZ_PRECONDITION_FAILED: bound effect.execute requires sandboxRoot"
                                    .to_string()
                            })?;
                        let bound_resolved = guard::lexical_resolve(bound).ok_or_else(|| {
                            "HZ_PRECONDITION_FAILED: kernel workspace binding could not resolve"
                                .to_string()
                        })?;
                        let requested_resolved = guard::lexical_resolve(Path::new(supplied)).ok_or_else(|| {
                            "HZ_PRECONDITION_FAILED: effect.execute sandboxRoot could not resolve".to_string()
                        })?;
                        if !Path::new(supplied).is_absolute()
                            || requested_resolved != bound_resolved
                        {
                            return Err("HZ_PRECONDITION_FAILED: effect.execute sandboxRoot does not equal kernel-bound workspace root".into());
                        }
                    }
                }
                let mut ledger = self
                    .effect_hermetic
                    .lock()
                    .map_err(|_| "effect.execute: hermetic ledger lock poisoned".to_string())?;
                effect_owner::execute(
                    &self.events,
                    &self.receipts,
                    self.guard.state_dir(),
                    params,
                    &self.guard,
                    &mut ledger,
                )
            }

            // Read-only inspection/verification. A malformed/tampered chain
            // fails closed, never turns into an empty clean status.
            "effect.owner.status" => effect_owner::status(&self.events, self.guard.state_dir()),
            "effect.owner.verify" => {
                effect_owner::verify(&self.events, &self.receipts, self.guard.state_dir())
            }
            // Independent latest settled file postimage replay (not a
            // historical snapshot and not shell/network-effect proof).
            "effect.owner.postimage.verify" => effect_owner::verify_latest_postimages(
                &self.events,
                &self.receipts,
                self.guard.state_dir(),
            ),
            // V2 OwnerLog: PREPARE-only clean release (**349**); attested
            // executed-UNKNOWN abandon (**655**); observe-settle (**714**/**721**).
            "effect.owner.recover" => {
                let effect_id = string_param(params, "effectId")?;
                let mode = params.get("mode").and_then(|v| v.as_str());
                let attestation = params.get("attestation").and_then(|v| v.as_str());
                effect_owner::recover(
                    &self.events,
                    &self.receipts,
                    self.guard.state_dir(),
                    &effect_id,
                    mode,
                    attestation,
                    Some(params),
                )
            }

            // §5.2 reduced: loopback CONNECT listener (advisory; not shell-net enforced).
            "egress.connect.listen" => {
                let action = params
                    .get("action")
                    .and_then(|v| v.as_str())
                    .unwrap_or("start");
                let mut slot = self
                    .egress_connect
                    .lock()
                    .map_err(|_| "egress.connect.listen: listener lock poisoned".to_string())?;
                match action {
                    "start" => {
                        let port = number_param(params, "port").unwrap_or(0) as u16;
                        let forward = params.get("forward").and_then(|v| v.as_bool());
                        let tls_peek = params.get("tlsPeek").and_then(|v| v.as_bool());
                        slot.start(self.guard.state_dir(), port, forward, tls_peek)
                    }
                    "stop" => slot.stop(),
                    other => Err(format!(
                        "egress.connect.listen.action {:?} is unknown; expected \"start\" or \"stop\"",
                        other
                    )),
                }
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

/// A required `SandboxMode` param (FEAT-004): a non-empty wire string that must
/// parse to a known mode, else a typed refusal (fail-closed — never a silent
/// default to a wider or narrower mode).
fn sandbox_mode_param(params: &Value, key: &str) -> Result<sandbox::SandboxMode, String> {
    let raw = params
        .get(key)
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .ok_or_else(|| format!("sandbox.report.{} must be a non-empty string", key))?;
    sandbox::SandboxMode::parse(raw)
        .ok_or_else(|| format!("sandbox.report.{} {:?} is not a known mode", key, raw))
}

fn number_param(params: &Value, key: &str) -> Option<u64> {
    let value = params.get(key)?;
    value.as_u64().or_else(|| {
        value
            .as_f64()
            .filter(|f| f.is_finite() && *f >= 0.0)
            .map(|f| f as u64)
    })
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

/// Owner + optional `principal` for approval-path mints (`principal: "human"`).
fn mint_owner_and_principal(params: &Value) -> (Option<String>, Option<String>) {
    let session = session_param(params);
    let principal = params
        .get("principal")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string());
    let owner = match (session.as_deref(), principal.as_deref()) {
        (Some(sid), Some("human")) => Some(format!("human:{sid}")),
        (Some(sid), _) => Some(sid.to_string()),
        _ => None,
    };
    (owner, principal)
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
