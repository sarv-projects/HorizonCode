//! Bounded nested child-effect postimage / streamEvidence observe (P0-2 partial).
//!
//! When a parent receipt declares `childEffectIds`, walk children within depth/node
//! budgets and independently classify each child's latest OwnerLog settlement
//! evidence. Missing or unverifiable children fail closed — not full R172.

use serde_json::{json, Value};
use std::collections::{BTreeMap, BTreeSet, VecDeque};
use std::fs;
use std::path::Path;

pub const NESTED_OBSERVE_MAX_DEPTH: usize = 4;
pub const NESTED_OBSERVE_MAX_NODES: usize = 64;

const RESIDUAL: &str =
    "full nested R172 authenticated issuer + universal child observe remain OPEN (not R172 closure)";

fn child_ids_from_receipt(row: &Value) -> Vec<String> {
    let Some(arr) = row.get("childEffectIds").and_then(Value::as_array) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    let mut seen = BTreeSet::new();
    for entry in arr {
        if let Some(id) = entry.as_str() {
            if !id.is_empty() && seen.insert(id.to_string()) {
                out.push(id.to_string());
            }
        }
    }
    out
}

/// Compare one path's settled postimage row against today's disk (per-effect scope).
fn verify_postimage_row(
    path: &str,
    expected_state: &str,
    expected_digest: &Option<String>,
    expected_entry_kind: &Option<String>,
) -> (bool, Option<String>, bool) {
    let actual_state =
        if fs::symlink_metadata(path).is_err_and(|e| e.kind() == std::io::ErrorKind::NotFound) {
            "absent"
        } else {
            "present"
        };
    let mut observed_digest = None;
    let stable = if expected_state == "present" && actual_state == "present" {
        if expected_entry_kind.as_deref() == Some("directory") {
            let probe = || match fs::symlink_metadata(path) {
                Ok(_) => Some(true),
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => Some(false),
                Err(_) => None,
            };
            probe() == Some(true) && probe() == Some(true)
        } else {
            let obs = crate::receipt_postimage::observe_file_postimage(Path::new(path));
            observed_digest = obs.digest;
            obs.observation_stable
        }
    } else if expected_state == "absent" && actual_state == "absent" {
        matches!(
            crate::effect_absent_reconstruct::classify_independent_absence(Path::new(path)),
            crate::effect_absent_reconstruct::AbsenceClassification::ExplicitAbsent
        )
    } else {
        let probe = || match fs::symlink_metadata(path) {
            Ok(_) => Some("present"),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Some("absent"),
            Err(_) => None,
        };
        probe() == Some(actual_state) && probe() == Some(actual_state)
    };
    let digest_ok = if expected_entry_kind.as_deref() == Some("directory") {
        expected_digest.as_deref() == Some(crate::effect_evidence::DIRECTORY_POSTIMAGE_DIGEST)
    } else if expected_state == "present" {
        observed_digest.as_ref() == expected_digest.as_ref()
    } else {
        true
    };
    (
        stable && actual_state == expected_state && digest_ok,
        observed_digest,
        stable,
    )
}

fn parse_postimage_row(
    row: &Value,
) -> Result<(String, String, Option<String>, Option<String>), String> {
    let p = row["path"]
        .as_str()
        .filter(|p| Path::new(p).is_absolute())
        .ok_or_else(|| {
            "HZ_PRECONDITION_FAILED: nested observe postimage path invalid".to_string()
        })?;
    let state = row["state"].as_str().ok_or_else(|| {
        "HZ_PRECONDITION_FAILED: nested observe postimage state invalid".to_string()
    })?;
    let digest = match state {
        "present" => Some(
            row["digest"]
                .as_str()
                .filter(|v| {
                    v.len() == 64
                        && v.bytes()
                            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
                })
                .ok_or_else(|| {
                    "HZ_PRECONDITION_FAILED: nested observe postimage digest invalid".to_string()
                })?
                .to_string(),
        ),
        "absent" => None,
        _ => {
            return Err("HZ_PRECONDITION_FAILED: nested observe postimage state unknown".into());
        }
    };
    let entry_kind = row
        .get("entryKind")
        .and_then(Value::as_str)
        .map(str::to_string);
    Ok((p.to_string(), state.to_string(), digest, entry_kind))
}

/// Classify one child's latest `owner.settled` details from OwnerLog.
fn classify_child_settlement(effect_id: &str, details: Option<&Value>, state_dir: &Path) -> Value {
    let Some(details) = details else {
        return json!({
            "effectId": effect_id,
            "classification": "missing_in_ownerlog",
            "ok": false,
        });
    };

    let postimages = details.get("postimages").and_then(Value::as_array);
    let stream = details.get("streamEvidence");

    if postimages.is_none() && stream.is_none() {
        return json!({
            "effectId": effect_id,
            "classification": "legacy_unverifiable",
            "ok": false,
        });
    }

    if let Some(rows) = postimages {
        if rows.is_empty() {
            if let Some(stream_ev) = stream {
                return match crate::effect_history::verify_stream_evidence(state_dir, stream_ev) {
                    Ok(n) if n > 0 => json!({
                        "effectId": effect_id,
                        "classification": "stream_evidence_ok",
                        "ok": true,
                        "streamChecked": n,
                    }),
                    Ok(_) => json!({
                        "effectId": effect_id,
                        "classification": "stream_evidence_empty",
                        "ok": false,
                    }),
                    Err(reason) => json!({
                        "effectId": effect_id,
                        "classification": "stream_evidence_failed",
                        "ok": false,
                        "reason": reason,
                    }),
                };
            }
            return json!({
                "effectId": effect_id,
                "classification": "unsupported",
                "ok": false,
            });
        }

        let mut path_ok = 0usize;
        let mut absent_ok = 0usize;
        let mut failures: Vec<Value> = Vec::new();
        for row in rows {
            let parsed = match parse_postimage_row(row) {
                Ok(v) => v,
                Err(reason) => {
                    return json!({
                        "effectId": effect_id,
                        "classification": "postimage_shape_invalid",
                        "ok": false,
                        "reason": reason,
                    });
                }
            };
            let (path, state, digest, entry_kind) = parsed;
            let (ok, _observed, stable) = verify_postimage_row(&path, &state, &digest, &entry_kind);
            if ok {
                if state == "absent" {
                    absent_ok += 1;
                } else {
                    path_ok += 1;
                }
            } else {
                let mut failure = json!({
                    "path": path,
                    "expectedState": state,
                    "observationStable": stable,
                });
                if state == "absent" {
                    let classification =
                        crate::effect_absent_reconstruct::classify_independent_absence(Path::new(
                            &path,
                        ));
                    failure["absenceClassification"] = json!(
                        crate::effect_absent_reconstruct::absence_classification_label(
                            classification
                        )
                    );
                }
                failures.push(failure);
            }
        }
        if !failures.is_empty() {
            return json!({
                "effectId": effect_id,
                "classification": "postimage_mismatch",
                "ok": false,
                "failures": failures,
            });
        }
        // A child may carry both file postimages and archived shell streams.
        // Verify both; previously the stream was silently ignored in this case.
        let mut stream_checked = 0usize;
        if let Some(stream_ev) = stream {
            match crate::effect_history::verify_stream_evidence(state_dir, stream_ev) {
                Ok(n) if n > 0 => stream_checked = n,
                Ok(_) => {
                    return json!({
                        "effectId": effect_id,
                        "classification": "stream_evidence_empty",
                        "ok": false,
                    });
                }
                Err(reason) => {
                    return json!({
                        "effectId": effect_id,
                        "classification": "stream_evidence_failed",
                        "ok": false,
                        "reason": reason,
                    });
                }
            }
        }
        let classification = if stream_checked > 0 && path_ok > 0 && absent_ok > 0 {
            "file_absence_and_stream_ok"
        } else if stream_checked > 0 && path_ok > 0 {
            "file_and_stream_ok"
        } else if stream_checked > 0 && absent_ok > 0 {
            "absence_and_stream_ok"
        } else if stream_checked > 0 {
            "stream_evidence_ok"
        } else if path_ok > 0 && absent_ok > 0 {
            "file_and_absence_ok"
        } else if absent_ok > 0 {
            "absence_fact_ok"
        } else {
            "file_postimage_ok"
        };
        return json!({
            "effectId": effect_id,
            "classification": classification,
            "ok": true,
            "pathsChecked": path_ok + absent_ok,
            "absenceFacts": absent_ok,
            "streamChecked": stream_checked,
        });
    }

    if let Some(stream_ev) = stream {
        return match crate::effect_history::verify_stream_evidence(state_dir, stream_ev) {
            Ok(n) if n > 0 => json!({
                "effectId": effect_id,
                "classification": "stream_evidence_ok",
                "ok": true,
                "streamChecked": n,
            }),
            Ok(_) => json!({
                "effectId": effect_id,
                "classification": "stream_evidence_empty",
                "ok": false,
            }),
            Err(reason) => json!({
                "effectId": effect_id,
                "classification": "stream_evidence_failed",
                "ok": false,
                "reason": reason,
            }),
        };
    }

    json!({
        "effectId": effect_id,
        "classification": "legacy_unverifiable",
        "ok": false,
    })
}

/// Add a bounded summary of deleted bytes reconstructable from CAS for the
/// child effects this report already observed. Pure additive metadata: it does
/// not change any node classification or claim full R172 observation.
pub fn enrich_nested_observe_with_deleted_reconstruction(
    report: &mut Value,
    owner_events: &[Value],
    state_dir: &Path,
) {
    let reconstructed =
        crate::effect_history::reconstruct_deleted_from_cas(state_dir, owner_events);
    let observed_ids: BTreeSet<String> = report["nodes"]
        .as_array()
        .map(|nodes| {
            nodes
                .iter()
                .filter_map(|n| n["effectId"].as_str().map(str::to_string))
                .collect()
        })
        .unwrap_or_default();
    let rows: Vec<Value> = reconstructed["reconstructed"]
        .as_array()
        .map(|arr| {
            arr.iter()
                .filter(|row| {
                    row["effectId"]
                        .as_str()
                        .map(|id| observed_ids.contains(id))
                        .unwrap_or(false)
                })
                .cloned()
                .collect()
        })
        .unwrap_or_default();
    report["deletedByteReconstruction"] = json!({
        "ok": reconstructed["ok"],
        "checked": rows.len(),
        "reconstructed": rows,
        "scope": "observed_child_absent_rows_with_prior_cas_version"
    });
}

/// Walk `childEffectIds` from verified receipts; classify each child's OwnerLog settlement.
pub fn verify_nested_child_observe(
    receipt_rows: &[Value],
    settlements: &BTreeMap<String, Value>,
    state_dir: &Path,
) -> Value {
    let mut receipt_by_effect: BTreeMap<String, Value> = BTreeMap::new();
    for row in receipt_rows {
        if let Some(eid) = row.get("effectId").and_then(Value::as_str) {
            if !eid.is_empty() {
                receipt_by_effect.insert(eid.to_string(), row.clone());
            }
        }
    }

    let mut queue: VecDeque<(String, usize)> = VecDeque::new();
    for row in receipt_rows {
        for child in child_ids_from_receipt(row) {
            queue.push_back((child, 1));
        }
    }

    let mut visited: BTreeSet<String> = BTreeSet::new();
    let mut nodes: Vec<Value> = Vec::new();
    let mut ok_count = 0usize;
    let mut refused = 0usize;
    let mut node_budget_hit = false;

    while let Some((child_id, depth)) = queue.pop_front() {
        if nodes.len() >= NESTED_OBSERVE_MAX_NODES {
            node_budget_hit = true;
            break;
        }
        if visited.contains(&child_id) {
            nodes.push(json!({
                "effectId": child_id,
                "depth": depth,
                "classification": "cycle",
                "ok": false,
            }));
            refused += 1;
            continue;
        }
        visited.insert(child_id.clone());

        if depth > NESTED_OBSERVE_MAX_DEPTH {
            nodes.push(json!({
                "effectId": child_id,
                "depth": depth,
                "classification": "depth_exceeded",
                "ok": false,
            }));
            refused += 1;
            continue;
        }

        let details = settlements.get(&child_id);
        let mut node = classify_child_settlement(&child_id, details, state_dir);
        if let Some(obj) = node.as_object_mut() {
            obj.insert("depth".to_string(), json!(depth));
            if let Some(receipt) = receipt_by_effect.get(&child_id) {
                if let Some(rid) = receipt.get("id").and_then(Value::as_str) {
                    obj.insert("receiptId".to_string(), json!(rid));
                }
                if let Some(tool) = receipt.get("tool").and_then(Value::as_str) {
                    obj.insert("tool".to_string(), json!(tool));
                }
            }
        }
        let child_ok = node.get("ok").and_then(Value::as_bool) == Some(true);
        if child_ok {
            ok_count += 1;
        } else {
            refused += 1;
        }
        nodes.push(node);

        if depth < NESTED_OBSERVE_MAX_DEPTH {
            if let Some(receipt) = receipt_by_effect.get(&child_id) {
                for grandchild in child_ids_from_receipt(receipt) {
                    queue.push_back((grandchild, depth + 1));
                }
            }
        }
    }

    let has_roots = receipt_rows
        .iter()
        .any(|r| !child_ids_from_receipt(r).is_empty());
    let ok = if !has_roots {
        true
    } else {
        !node_budget_hit
            && nodes
                .iter()
                .all(|n| n.get("ok").and_then(Value::as_bool) == Some(true))
    };

    json!({
        "ok": ok,
        "visited": nodes.len(),
        "verified": ok_count,
        "refused": refused,
        "maxDepth": NESTED_OBSERVE_MAX_DEPTH,
        "nodeBudgetExceeded": node_budget_hit,
        "nodes": nodes,
        "scope": "childEffectIds_ownerlog_settlement_observe_only",
        "residual": RESIDUAL,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn missing_child_fails_closed() {
        let receipts = vec![json!({
            "effectId": "parent",
            "childEffectIds": ["missing-child"],
        })];
        let settlements = BTreeMap::new();
        let dir = std::env::temp_dir();
        let report = verify_nested_child_observe(&receipts, &settlements, &dir);
        assert_eq!(report["ok"], false);
        assert_eq!(report["refused"], 1);
        assert_eq!(report["nodes"][0]["classification"], "missing_in_ownerlog");
    }

    #[test]
    fn nested_child_with_postimages_and_stream_checks_both() {
        let root = std::env::temp_dir().join(format!("hz-nested-both-{}", uuid::Uuid::new_v4()));
        let state = root.join("state");
        fs::create_dir_all(&state).unwrap();
        let file = root.join("child.txt");
        let file_bytes = b"child postimage";
        fs::write(&file, file_bytes).unwrap();
        let file_digest = crate::canon::sha256_bytes(file_bytes);
        let stream_bytes = b"child stdout";
        let stream_digest = crate::canon::sha256_bytes(stream_bytes);
        crate::effect_history::archive_captured_bytes(&state, &stream_digest, stream_bytes)
            .unwrap();

        let receipts = vec![json!({
            "effectId": "parent",
            "childEffectIds": ["child-both"],
        })];
        let mut settlements = BTreeMap::new();
        settlements.insert(
            "child-both".to_string(),
            json!({
                "postimages": [{
                    "path": file,
                    "state": "present",
                    "digest": file_digest,
                }],
                "streamEvidence": {
                    "stdout": {
                        "digest": stream_digest,
                        "archive": stream_digest,
                        "archivedBytes": stream_bytes.len(),
                    },
                    "exitCode": 0,
                },
            }),
        );
        let report = verify_nested_child_observe(&receipts, &settlements, &state);
        assert_eq!(report["ok"], true, "{report}");
        let node = &report["nodes"][0];
        assert_eq!(node["classification"], "file_and_stream_ok", "{node}");
        assert_eq!(node["streamChecked"], 1);
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn nested_observe_reports_reconstructable_deleted_bytes() {
        let root = std::env::temp_dir().join(format!("hz-nested-deleted-{}", uuid::Uuid::new_v4()));
        let state = root.join("state");
        fs::create_dir_all(&state).unwrap();
        let path = root.join("gone.txt");
        fs::write(&path, b"child bytes").unwrap();
        let digest = crate::canon::sha256_bytes(b"child bytes");
        let archive = crate::effect_history::archive_postimages(
            &state,
            &json!([{
                "path": path, "state": "present", "digest": digest
            }]),
        )
        .unwrap();
        let present = json!({"type": "owner.settled", "payload": {
            "effectId": "child-write", "details": {"postimages": archive}
        }});
        let absent = json!({"type": "owner.settled", "payload": {
            "effectId": "child-delete", "details": {"postimages": [{
                "path": path, "state": "absent"
            }]}
        }});
        let receipts = vec![json!({
            "effectId": "parent",
            "childEffectIds": ["child-delete"],
        })];
        let mut settlements = BTreeMap::new();
        settlements.insert(
            "child-delete".to_string(),
            json!({
                "postimages": [{ "path": path, "state": "absent" }]
            }),
        );
        let mut report = verify_nested_child_observe(&receipts, &settlements, &state);
        enrich_nested_observe_with_deleted_reconstruction(&mut report, &[present, absent], &state);
        assert_eq!(
            report["deletedByteReconstruction"]["checked"], 1,
            "{report}"
        );
        assert_eq!(
            report["deletedByteReconstruction"]["reconstructed"]
                .as_array()
                .unwrap()
                .len(),
            1
        );
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn legacy_child_without_postimages_refused() {
        let receipts = vec![json!({
            "effectId": "parent",
            "childEffectIds": ["child-1"],
        })];
        let mut settlements = BTreeMap::new();
        settlements.insert("child-1".to_string(), json!({ "terminal": "succeeded" }));
        let dir = std::env::temp_dir();
        let report = verify_nested_child_observe(&receipts, &settlements, &dir);
        assert_eq!(report["ok"], false);
        assert_eq!(report["nodes"][0]["classification"], "legacy_unverifiable");
    }
}
