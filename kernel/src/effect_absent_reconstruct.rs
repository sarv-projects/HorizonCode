//! Reduced absent-path reconstruction for postimage verify (P0-2 partial; **700**).
//!
//! Absent paths are signed OwnerLog facts, not byte CAS. At verify/observe we
//! independently double-probe ENOENT vs present; permission or TOCTOU ambiguity
//! is fail-closed `identity_uncertain`, never silent unverifiable absence.

use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::fs;
use std::path::Path;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AbsenceClassification {
    /// Two consistent `NotFound` symlinks_metadata probes.
    ExplicitAbsent,
    /// Entry exists (file, directory, symlink, etc.).
    Present,
    /// lstat failed for a reason other than NotFound — cannot prove absence.
    IdentityUncertain,
    /// Probes disagree — unstable.
    Unstable,
}

pub fn absence_classification_label(c: AbsenceClassification) -> &'static str {
    match c {
        AbsenceClassification::ExplicitAbsent => "explicit_absent",
        AbsenceClassification::Present => "present",
        AbsenceClassification::IdentityUncertain => "identity_uncertain",
        AbsenceClassification::Unstable => "unstable",
    }
}

/// Double `symlink_metadata` probe — permission errors are NOT absence proof.
pub fn classify_independent_absence(path: &Path) -> AbsenceClassification {
    let probe = || match fs::symlink_metadata(path) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Some(false),
        Ok(_) => Some(true),
        Err(_) => None,
    };
    match (probe(), probe()) {
        (Some(false), Some(false)) => AbsenceClassification::ExplicitAbsent,
        (Some(true), Some(true)) => AbsenceClassification::Present,
        (None, _) | (_, None) => AbsenceClassification::IdentityUncertain,
        _ => AbsenceClassification::Unstable,
    }
}

/// Settlement-time gate: refuse unless absence is independently proven.
pub fn independently_absent(path: &Path) -> Result<bool, String> {
    match classify_independent_absence(path) {
        AbsenceClassification::ExplicitAbsent => Ok(true),
        AbsenceClassification::Present => Ok(false),
        AbsenceClassification::IdentityUncertain => Err(
            "HZ_PRECONDITION_FAILED: cannot observe postimage absence: identity cannot be proven"
                .into(),
        ),
        AbsenceClassification::Unstable => Err(
            "HZ_PRECONDITION_FAILED: cannot observe postimage absence: unstable".into(),
        ),
    }
}

/// Non-latest `state: absent` rows — classify as signed historical facts (no byte CAS).
pub fn replay_superseded_absent_facts(owner_events: &[Value]) -> Value {
    let mut latest: BTreeMap<String, String> = BTreeMap::new();
    for event in owner_events {
        if event["type"] != "owner.settled" {
            continue;
        }
        let id = event["payload"]["effectId"].as_str().unwrap_or("");
        let Some(rows) = event["payload"]["details"]["postimages"].as_array() else {
            continue;
        };
        for row in rows {
            let Some(path) = row["path"].as_str() else {
                continue;
            };
            if !Path::new(path).is_absolute() {
                continue;
            }
            latest.insert(path.to_string(), id.to_string());
        }
    }

    let mut reconstructed = Vec::new();
    for event in owner_events {
        if event["type"] != "owner.settled" {
            continue;
        }
        let id = event["payload"]["effectId"].as_str().unwrap_or("");
        let Some(rows) = event["payload"]["details"]["postimages"].as_array() else {
            continue;
        };
        for row in rows {
            if row["state"].as_str() != Some("absent") {
                continue;
            }
            let Some(path) = row["path"].as_str() else {
                continue;
            };
            if latest.get(path).map(String::as_str) == Some(id) {
                continue;
            }
            reconstructed.push(json!({
                "effectId": id,
                "path": path,
                "classification": "signed_absence_fact",
                "source": "ownerlog",
                "superseded": true,
            }));
        }
    }

    json!({
        "ok": true,
        "checked": reconstructed.len(),
        "reconstructed": reconstructed,
        "failures": [],
        "scope": "superseded_signed_absence_facts_only",
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    #[test]
    fn explicit_absent_on_missing_path() {
        let dir = std::env::temp_dir().join(format!(
            "hz-absent-reconstruct-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let missing = dir.join("does-not-exist.txt");
        assert_eq!(
            classify_independent_absence(&missing),
            AbsenceClassification::ExplicitAbsent
        );
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn present_when_file_exists() {
        let dir = std::env::temp_dir().join(format!(
            "hz-absent-reconstruct-present-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let file = dir.join("exists.txt");
        fs::File::create(&file).unwrap().write_all(b"x").unwrap();
        assert_eq!(
            classify_independent_absence(&file),
            AbsenceClassification::Present
        );
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn superseded_absent_fact_reported_without_disk_bytes() {
        let path = "/tmp/hz-absent-reconstruct-signed-fact";
        let events = vec![
            json!({"type": "owner.settled", "payload": {
                "effectId": "e1",
                "details": {"postimages": [{"path": path, "state": "absent"}]}
            }}),
            json!({"type": "owner.settled", "payload": {
                "effectId": "e2",
                "details": {"postimages": [{"path": path, "state": "present", "digest": "0".repeat(64)}]}
            }}),
        ];
        let replay = replay_superseded_absent_facts(&events);
        assert_eq!(replay["checked"], 1);
        assert_eq!(replay["reconstructed"][0]["effectId"], "e1");
        assert_eq!(replay["reconstructed"][0]["classification"], "signed_absence_fact");
    }
}