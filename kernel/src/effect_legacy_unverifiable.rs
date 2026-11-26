//! Explicit legacy unverifiable postimage classification (P0-2 partial; **709**).
//!
//! Rows and settlements lacking digest/CAS/stream evidence are named
//! `legacy_unverifiable` with fail-closed verify — never silently OK.
//! Retroactive CAS backfill is refused (pre-archive OwnerLog rows).

use serde_json::{json, Value};
use std::path::Path;

fn valid_digest(s: &str) -> bool {
    s.len() == 64
        && s.bytes()
            .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
}

pub fn row_entry(effect_id: &str, path: Option<&str>, reason: &str, verify_ok: bool) -> Value {
    json!({
        "effectId": effect_id,
        "path": path,
        "classification": "legacy_unverifiable",
        "reason": reason,
        "ok": verify_ok,
        "backfillRefused": true,
        "backfillRefusalReason": "pre_archive_ownerlog_rows_cannot_receive_cas_at_verify",
    })
}

/// Returns explicit legacy rows matching `verify_history` / latest-verify counters.
pub fn collect_legacy_unverifiable_rows(owner_events: &[Value]) -> Vec<Value> {
    let mut rows = Vec::new();
    for event in owner_events {
        if event["type"] != "owner.settled" {
            continue;
        }
        let id = event["payload"]["effectId"].as_str().unwrap_or("");
        if id.is_empty() {
            continue;
        }
        let details = &event["payload"]["details"];
        let postimages = details.get("postimages");
        let stream = details.get("streamEvidence");
        if postimages.is_none() {
            // No postimages sidecar — entire settlement unverifiable unless handled elsewhere.
            if stream.is_none() {
                rows.push(row_entry(
                    id,
                    None,
                    "settlement_missing_postimages_and_stream",
                    false,
                ));
            } else {
                rows.push(row_entry(
                    id,
                    None,
                    "settlement_missing_postimages_sidecar",
                    false,
                ));
            }
            continue;
        }
        let Some(pi_rows) = postimages.and_then(Value::as_array) else {
            continue;
        };
        for row in pi_rows {
            if row["state"].as_str() != Some("present") {
                continue;
            }
            let digest = row["digest"].as_str().unwrap_or("");
            let archive = row["archive"].as_str().unwrap_or("");
            if row.get("entryKind").and_then(|v| v.as_str()) == Some("directory")
                && digest == crate::effect_evidence::DIRECTORY_POSTIMAGE_DIGEST
                && archive.is_empty()
            {
                continue;
            }
            if !valid_digest(digest) {
                rows.push(row_entry(
                    id,
                    row["path"].as_str(),
                    "present_row_missing_valid_digest",
                    false,
                ));
                continue;
            }
            if archive.is_empty() {
                rows.push(row_entry(
                    id,
                    row["path"].as_str(),
                    "present_row_missing_cas_archive",
                    false,
                ));
            } else if archive != digest {
                rows.push(row_entry(
                    id,
                    row["path"].as_str(),
                    "present_row_archive_binding_mismatch",
                    false,
                ));
            }
        }
    }
    rows
}

pub fn legacy_row_count(owner_events: &[Value]) -> usize {
    let mut count = 0usize;
    for event in owner_events {
        if event["type"] != "owner.settled" {
            continue;
        }
        let Some(rows) = event["payload"]["details"]["postimages"].as_array() else {
            count += 1;
            continue;
        };
        for row in rows {
            if row["state"].as_str() != Some("present") {
                continue;
            }
            let digest = row["digest"].as_str().unwrap_or("");
            let archive = row["archive"].as_str().unwrap_or("");
            if row.get("entryKind").and_then(|v| v.as_str()) == Some("directory")
                && digest == crate::effect_evidence::DIRECTORY_POSTIMAGE_DIGEST
                && archive.is_empty()
            {
                continue;
            }
            if !valid_digest(digest) {
                count += 1;
                continue;
            }
            if archive.is_empty() {
                count += 1;
            }
        }
    }
    count
}

/// Fail-closed named report for wire/session surfaces (**709**).
pub fn build_legacy_classify_report(owner_events: &[Value]) -> Value {
    let rows = collect_legacy_unverifiable_rows(owner_events);
    let refused = rows.len();
    json!({
        "ok": refused == 0,
        "refused": refused,
        "classification": "legacy_unverifiable",
        "scope": "owner_settled_without_digest_cas_or_stream_evidence",
        "backfillRefusal": {
            "allowed": false,
            "reason": "pre_archive_ownerlog_rows_cannot_receive_cas_at_verify",
        },
        "residual": "arbitrary_shell_fs_net_and_deleted_byte_reconstruction_still_open",
        "rows": rows,
    })
}

/// Honest refusal when a caller explicitly requests retroactive CAS on a legacy row.
pub fn refuse_retroactive_cas_backfill(row: &Value) -> Result<(), String> {
    if row.get("retroactiveCasBackfill").and_then(Value::as_bool) != Some(true) {
        return Ok(());
    }
    let state = row["state"].as_str().unwrap_or("");
    if state != "present" {
        return Err(
            "HZ_PRECONDITION_FAILED: retroactive CAS backfill applies only to present file rows"
                .into(),
        );
    }
    let digest = row["digest"].as_str().unwrap_or("");
    let archive = row["archive"].as_str().unwrap_or("");
    let path = row["path"].as_str().unwrap_or("");
    if valid_digest(digest) && archive.is_empty() && Path::new(path).is_absolute() {
        return Err(
            "HZ_PRECONDITION_FAILED: legacy postimage row refuses retroactive CAS backfill; re-execute effect instead".into(),
        );
    }
    Err("HZ_PRECONDITION_FAILED: retroactive CAS backfill refused for non-legacy row shape".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn settlement_without_sidecar_is_legacy_unverifiable() {
        let events = vec![json!({
            "type": "owner.settled",
            "payload": {
                "effectId": "legacy-e1",
                "details": { "kind": "fs.write" }
            }
        })];
        let report = build_legacy_classify_report(&events);
        assert_eq!(report["ok"], false);
        assert_eq!(report["refused"], 1);
        assert_eq!(report["rows"][0]["classification"], "legacy_unverifiable");
        assert_eq!(
            report["rows"][0]["reason"],
            "settlement_missing_postimages_and_stream"
        );
        assert_eq!(report["rows"][0]["backfillRefused"], true);
    }

    #[test]
    fn present_row_without_cas_archive_is_named_legacy() {
        let events = vec![json!({
            "type": "owner.settled",
            "payload": {
                "effectId": "pre356",
                "details": {
                    "postimages": [{
                        "path": "/tmp/legacy.txt",
                        "state": "present",
                        "digest": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
                    }]
                }
            }
        })];
        let report = build_legacy_classify_report(&events);
        assert_eq!(report["refused"], 1);
        assert_eq!(
            report["rows"][0]["reason"],
            "present_row_missing_cas_archive"
        );
        assert_eq!(legacy_row_count(&events), 1);
    }

    #[test]
    fn directory_metadata_row_is_not_legacy() {
        let events = vec![json!({
            "type": "owner.settled",
            "payload": {
                "effectId": "mkdir-e1",
                "details": {
                    "postimages": [{
                        "path": "/tmp/dir",
                        "state": "present",
                        "entryKind": "directory",
                        "digest": crate::effect_evidence::DIRECTORY_POSTIMAGE_DIGEST
                    }]
                }
            }
        })];
        let report = build_legacy_classify_report(&events);
        assert_eq!(report["ok"], true);
        assert_eq!(report["refused"], 0);
    }

    #[test]
    fn retroactive_cas_backfill_refused() {
        let row = json!({
            "path": "/tmp/x",
            "state": "present",
            "digest": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
            "retroactiveCasBackfill": true
        });
        let err = refuse_retroactive_cas_backfill(&row).unwrap_err();
        assert!(err.contains("refuses retroactive CAS backfill"), "{err}");
    }
}
