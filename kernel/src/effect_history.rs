//! Bounded historical evidence for direct kernel-owned file effects (P0-2 slice).
//! Store immutable content-addressed postimages BEFORE issuing a settled
//! receipt. This is not observation of ambient Bun, shell, network, or old rows.
//! A failed archive operation turns the executing effect into durable UNKNOWN.
use serde_json::{json, Value};
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

const MAX_SNAPSHOT_BYTES: u64 = 64 * 1024 * 1024;

fn valid_digest(s: &str) -> bool {
    s.len() == 64
        && s.bytes()
            .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
}

fn archive_path(state_dir: &Path, digest: &str) -> PathBuf {
    state_dir
        .join("owner-postimages")
        .join(&digest[..2])
        .join(format!("{digest}.blob"))
}

fn read_regular(path: &Path) -> Result<Vec<u8>, String> {
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC);
    }
    let mut file = options
        .open(path)
        .map_err(|e| format!("HZ_PRECONDITION_FAILED: archived postimage inaccessible: {e}"))?;
    let meta = file
        .metadata()
        .map_err(|e| format!("HZ_PRECONDITION_FAILED: archived postimage stat failed: {e}"))?;
    if !meta.is_file() || meta.len() > MAX_SNAPSHOT_BYTES {
        return Err(
            "HZ_PRECONDITION_FAILED: archived postimage not regular or exceeds 64 MiB".into(),
        );
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if meta.nlink() != 1 {
            return Err("HZ_PRECONDITION_FAILED: archived postimage hardlink refused".into());
        }
    }
    let mut bytes = Vec::new();
    file.read_to_end(&mut bytes)
        .map_err(|e| format!("HZ_PRECONDITION_FAILED: archived postimage read failed: {e}"))?;
    if bytes.len() as u64 > MAX_SNAPSHOT_BYTES {
        return Err("HZ_PRECONDITION_FAILED: archived postimage grew beyond 64 MiB".into());
    }
    Ok(bytes)
}

fn check_archive(path: &Path, digest: &str) -> Result<usize, String> {
    // A final-component O_NOFOLLOW is not enough: reject pre-existing links
    // in the archive root and shard too. Race-free pathname traversal still
    // requires openat2/dirfd ownership and remains outside this slice.
    let shard = path
        .parent()
        .ok_or_else(|| "HZ_PRECONDITION_FAILED: archive shard missing".to_string())?;
    let root = shard
        .parent()
        .ok_or_else(|| "HZ_PRECONDITION_FAILED: archive root missing".to_string())?;
    for ancestor in [root, shard] {
        let meta = fs::symlink_metadata(ancestor)
            .map_err(|e| format!("HZ_PRECONDITION_FAILED: archive ancestor inaccessible: {e}"))?;
        if !meta.is_dir() || meta.file_type().is_symlink() {
            return Err("HZ_PRECONDITION_FAILED: archive ancestor symlink/refusal".into());
        }
    }
    // Two independently opened descriptors, with no symlink-follow on Unix.
    let bytes = read_regular(path)?;
    let confirm = read_regular(path)?;
    if bytes != confirm || crate::canon::sha256_bytes(&bytes) != digest {
        return Err("HZ_PRECONDITION_FAILED: historical archive missing digest stability".into());
    }
    Ok(bytes.len())
}

fn create_archive(state_dir: &Path, digest: &str, bytes: &[u8]) -> Result<(), String> {
    let destination = archive_path(state_dir, digest);
    let dir = destination.parent().ok_or_else(|| {
        "HZ_PRECONDITION_FAILED: historical archive path has no parent".to_string()
    })?;
    // Never call create_dir_all on an attacker-replaceable path: that can
    // follow an already present symlink and create files outside kernel state
    // before the post-creation symlink check. Create/check each component.
    for protected in [state_dir.join("owner-postimages"), dir.to_path_buf()] {
        match fs::symlink_metadata(&protected) {
            Ok(_) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                match fs::create_dir(&protected) {
                    Ok(()) => {}
                    Err(race) if race.kind() == std::io::ErrorKind::AlreadyExists => {}
                    Err(error) => {
                        return Err(format!(
                            "HZ_PRECONDITION_FAILED: history dir create: {error}"
                        ))
                    }
                }
            }
            Err(error) => {
                return Err(format!(
                    "HZ_PRECONDITION_FAILED: history dir inaccessible: {error}"
                ))
            }
        }
        let meta = fs::symlink_metadata(&protected)
            .map_err(|e| format!("HZ_PRECONDITION_FAILED: cannot inspect history dir: {e}"))?;
        if !meta.is_dir() || meta.file_type().is_symlink() {
            return Err(
                "HZ_PRECONDITION_FAILED: history directory is not a plain directory".into(),
            );
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&protected, fs::Permissions::from_mode(0o700))
                .map_err(|e| format!("HZ_PRECONDITION_FAILED: history dir chmod: {e}"))?;
        }
    }
    let temp = dir.join(format!(".pending-{}", uuid::Uuid::new_v4()));
    let mut opts = OpenOptions::new();
    opts.create_new(true).write(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.mode(0o600)
            .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC);
    }
    let result = (|| -> Result<(), String> {
        let mut file = opts
            .open(&temp)
            .map_err(|e| format!("HZ_PRECONDITION_FAILED: history temp create: {e}"))?;
        file.write_all(bytes)
            .map_err(|e| format!("HZ_PRECONDITION_FAILED: history temp write: {e}"))?;
        file.sync_all()
            .map_err(|e| format!("HZ_PRECONDITION_FAILED: history temp fsync: {e}"))?;
        drop(file);
        // Hard-link is an atomic NO-CLOBBER publication; a pre-existing blob
        // must independently hash correctly, never be silently replaced.
        match fs::hard_link(&temp, &destination) {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {}
            Err(e) => return Err(format!("HZ_PRECONDITION_FAILED: history publish: {e}")),
        }
        fs::remove_file(&temp)
            .map_err(|e| format!("HZ_PRECONDITION_FAILED: history temp unlink: {e}"))?;
        let verified = check_archive(&destination, digest)?;
        if verified != bytes.len() {
            return Err("HZ_PRECONDITION_FAILED: published archive length mismatch".into());
        }
        // POSIX directory fsync makes the hard-link publication durable. Windows
        // refuses to open a directory handle for sync_all (Access denied), so
        // that durability step is unavailable there; report it honestly rather
        // than failing every CAS archive on that host.
        #[cfg(unix)]
        File::open(dir)
            .and_then(|parent| parent.sync_all())
            .map_err(|e| format!("HZ_PRECONDITION_FAILED: history directory fsync: {e}"))?;
        Ok(())
    })();
    let _ = fs::remove_file(&temp);
    result
}

/// Archive capped shell stdout/stderr bytes under the same content-addressed
/// CAS as file postimages. Digest must already match `bytes` (caller observes).
pub fn archive_captured_bytes(state_dir: &Path, digest: &str, bytes: &[u8]) -> Result<(), String> {
    if !valid_digest(digest) {
        return Err("HZ_PRECONDITION_FAILED: stream archive digest invalid".into());
    }
    if bytes.len() as u64 > MAX_SNAPSHOT_BYTES {
        return Err("HZ_PRECONDITION_FAILED: stream archive exceeds 64 MiB".into());
    }
    if crate::canon::sha256_bytes(bytes) != digest {
        return Err("HZ_PRECONDITION_FAILED: stream archive digest mismatch".into());
    }
    create_archive(state_dir, digest, bytes)
}

/// Independently verify archived shell streamEvidence rows (stdout/stderr).
/// Returns the number of stream blobs checked. Missing/invalid archive fails.
pub fn verify_stream_evidence(state_dir: &Path, stream: &Value) -> Result<usize, String> {
    let mut checked = 0usize;
    for key in ["stdout", "stderr"] {
        let Some(row) = stream.get(key) else {
            continue;
        };
        let digest = row["digest"]
            .as_str()
            .filter(|s| valid_digest(s))
            .ok_or_else(|| {
                format!("HZ_PRECONDITION_FAILED: streamEvidence.{key} digest invalid")
            })?;
        let archive = row["archive"].as_str().unwrap_or("");
        if archive.is_empty() {
            return Err(format!(
                "HZ_PRECONDITION_FAILED: streamEvidence.{key} archive missing"
            ));
        }
        if archive != digest {
            return Err(format!(
                "HZ_PRECONDITION_FAILED: streamEvidence.{key} archive binding mismatch"
            ));
        }
        let bytes = check_archive(&archive_path(state_dir, digest), digest)?;
        if row["archivedBytes"].as_u64() != Some(bytes as u64) {
            return Err(format!(
                "HZ_PRECONDITION_FAILED: streamEvidence.{key} archive length mismatch"
            ));
        }
        checked += 1;
    }
    if checked == 0 {
        return Err("HZ_PRECONDITION_FAILED: streamEvidence has no stdout/stderr rows".into());
    }
    let _ = stream
        .get("exitCode")
        .and_then(Value::as_i64)
        .ok_or_else(|| "HZ_PRECONDITION_FAILED: streamEvidence missing exitCode".to_string())?;
    Ok(checked)
}

/// Archive every independently observed present file. Content is read twice,
/// compared to the Rust effect's digest and only then published. Absent records
/// retain the signed historical absence FACT, not a reconstructable byte blob.
pub fn archive_postimages(state_dir: &Path, postimages: &Value) -> Result<Value, String> {
    let rows = postimages.as_array().ok_or_else(|| {
        "HZ_PRECONDITION_FAILED: historical postimages must be an array".to_string()
    })?;
    let mut output = Vec::with_capacity(rows.len());
    for row in rows {
        crate::effect_legacy_unverifiable::refuse_retroactive_cas_backfill(row)?;
        let mut item = row.clone();
        match row["state"].as_str() {
            Some("absent") => {}
            Some("present") => {
                let digest = row["digest"]
                    .as_str()
                    .filter(|s| valid_digest(s))
                    .ok_or_else(|| "HZ_PRECONDITION_FAILED: archive digest invalid".to_string())?;
                if row.get("entryKind").and_then(|v| v.as_str()) == Some("directory") {
                    // Shell mkdir metadata-only observe — no byte CAS archive (P0-2 reduced).
                    if digest != crate::effect_evidence::DIRECTORY_POSTIMAGE_DIGEST {
                        return Err(
                            "HZ_PRECONDITION_FAILED: directory postimage digest invalid".into()
                        );
                    }
                    output.push(item);
                    continue;
                }
                let path = row["path"]
                    .as_str()
                    .filter(|s| Path::new(s).is_absolute())
                    .ok_or_else(|| {
                        "HZ_PRECONDITION_FAILED: archive source path invalid".to_string()
                    })?;
                let bytes = read_regular(Path::new(path))?;
                let confirm = read_regular(Path::new(path))?;
                if bytes != confirm || crate::canon::sha256_bytes(&bytes) != digest {
                    return Err("HZ_PRECONDITION_FAILED: historical postimage read changed or differs from execution".into());
                }
                create_archive(state_dir, digest, &bytes)?;
                item["archive"] = json!(digest);
                item["archivedBytes"] = json!(bytes.len());
            }
            _ => return Err("HZ_PRECONDITION_FAILED: historical postimage state invalid".into()),
        }
        output.push(item);
    }
    Ok(json!(output))
}

/// Classify archived *present* postimages that are no longer the latest for
/// their path — ruling **654** historical overwrite replay (CAS only; not disk).
pub fn replay_superseded_from_cas(state_dir: &Path, owner_events: &[Value]) -> Value {
    use std::collections::BTreeMap;
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
    let mut replayed = Vec::new();
    let mut failures = Vec::new();
    for event in owner_events {
        if event["type"] != "owner.settled" {
            continue;
        }
        let id = event["payload"]["effectId"].as_str().unwrap_or("");
        let Some(rows) = event["payload"]["details"]["postimages"].as_array() else {
            continue;
        };
        for row in rows {
            if row["state"].as_str() != Some("present") {
                continue;
            }
            let Some(path) = row["path"].as_str() else {
                continue;
            };
            // Still the latest for this path → latest-disk verify owns it; skip.
            if latest.get(path).map(String::as_str) == Some(id) {
                continue;
            }
            let digest = row["digest"].as_str().unwrap_or("");
            let archive = row["archive"].as_str().unwrap_or("");
            if !valid_digest(digest) || archive.is_empty() || archive != digest {
                // legacy / unbound — counted elsewhere as legacyUnverifiable; skip claim
                continue;
            }
            match check_archive(&archive_path(state_dir, digest), digest) {
                Ok(bytes) if row["archivedBytes"].as_u64() == Some(bytes as u64) => {
                    replayed.push(json!({
                        "effectId": id,
                        "path": path,
                        "digest": digest,
                        "archivedBytes": bytes,
                        "source": "cas",
                        "superseded": true,
                    }));
                }
                Ok(_) => failures.push(json!({
                    "effectId": id,
                    "path": path,
                    "reason": "archive_length_mismatch",
                })),
                Err(err) => failures.push(json!({
                    "effectId": id,
                    "path": path,
                    "reason": err,
                })),
            }
        }
    }
    json!({
        "ok": failures.is_empty(),
        "checked": replayed.len(),
        "replayed": replayed,
        "failures": failures,
        "scope": "superseded_cas_present_postimages_only"
    })
}

/// Reconstruct the bytes a deleted file had immediately before deletion, when
/// that version was independently archived in CAS by an earlier present
/// postimage (P0-2 partial: no CAS => no reconstruction claim). The walk is
/// chronological: a recreated file establishes a new last-present version.
pub fn reconstruct_deleted_from_cas(state_dir: &Path, owner_events: &[Value]) -> Value {
    use std::collections::BTreeMap;
    // Keep EVERY archived version per path so all superseded versions of a
    // deleted file reconstruct (P0-2 residual; ruling 752/767 partial). A
    // recreation starts a fresh Vec; a second absence re-claims nothing.
    let mut last_present: BTreeMap<String, Vec<(String, Option<u64>)>> = BTreeMap::new();
    let mut reconstructed = Vec::new();
    let mut failures = Vec::new();
    let mut checked = 0usize;
    for event in owner_events {
        if event["type"] != "owner.settled" {
            continue;
        }
        let effect_id = event["payload"]["effectId"].as_str().unwrap_or("");
        let Some(rows) = event["payload"]["details"]["postimages"].as_array() else {
            continue;
        };
        for row in rows {
            let Some(path) = row["path"].as_str().filter(|p| Path::new(p).is_absolute()) else {
                continue;
            };
            match row["state"].as_str() {
                Some("present") => {
                    let digest = row["digest"].as_str().unwrap_or("");
                    let archive = row["archive"].as_str().unwrap_or("");
                    if valid_digest(digest) && archive == digest {
                        last_present
                            .entry(path.to_string())
                            .or_default()
                            .push((digest.to_string(), row["archivedBytes"].as_u64()));
                    }
                }
                Some("absent") => {
                    // Take the whole vector so a back-to-back second absence
                    // cannot re-claim the same digests.
                    let Some(versions) = last_present.remove(path) else {
                        continue;
                    };
                    for (digest, expected_bytes) in versions {
                        checked += 1;
                        match check_archive(&archive_path(state_dir, &digest), &digest) {
                            Ok(bytes) if expected_bytes.map_or(true, |n| n as usize == bytes) => {
                                reconstructed.push(json!({
                                    "effectId": effect_id,
                                    "path": path,
                                    "digest": digest,
                                    "archivedBytes": bytes,
                                    "reconstructed": true,
                                    "source": "cas",
                                }));
                            }
                            Ok(_) => failures.push(json!({"effectId": effect_id, "path": path, "reason": "archive_length_mismatch"})),
                            Err(err) => failures.push(json!({"effectId": effect_id, "path": path, "reason": err})),
                        }
                    }
                }
                _ => {}
            }
        }
    }
    json!({
        "ok": failures.is_empty(),
        "checked": checked,
        "reconstructed": reconstructed,
        "failures": failures,
        "scope": "archived_prior_version_of_deleted_paths_only"
    })
}

/// Verify EVERY archived historical version independently of today's disk.
/// Missing snapshots from legacy rows remain explicitly unverifiable.
pub fn verify_history(state_dir: &Path, owner_events: &[Value], unresolved: usize) -> Value {
    let mut checked = 0usize;
    let mut absent_facts = 0usize;
    let mut unsupported_effects = 0usize;
    let mut shell_net_unverifiable = 0usize;
    let mut legacy_unverifiable = 0usize;
    let mut failures = Vec::new();
    for event in owner_events {
        if event["type"] != "owner.settled" {
            continue;
        }
        let id = event["payload"]["effectId"].as_str().unwrap_or("");
        let Some(rows) = event["payload"]["details"]["postimages"].as_array() else {
            legacy_unverifiable += 1;
            continue;
        };
        if rows.is_empty() {
            // Shell settlements with archived streamEvidence are not file
            // postimages, but they are also not "unsupported" for history
            // when the CAS blobs independently verify.
            let argv: Vec<String> = event["payload"]["details"]
                .get("argv")
                .and_then(|v| v.as_array())
                .map(|a| {
                    a.iter()
                        .filter_map(|x| x.as_str().map(str::to_string))
                        .collect()
                })
                .unwrap_or_default();
            let side = crate::effect_evidence::classify_shell_argv_side_effect(&argv);
            match event["payload"]["details"].get("streamEvidence") {
                Some(stream) => match verify_stream_evidence(state_dir, stream) {
                    Ok(n) => {
                        checked += n;
                        // Stream CAS ok still does not observe net/FS landings.
                        if side == crate::effect_evidence::ShellSideEffectClass::LikelyNet {
                            shell_net_unverifiable += 1;
                            failures.push(json!({
                                "effectId": id,
                                "path": "shell.net",
                                "reason": "likely_net_side_effect_unobserved",
                                "sideEffectClass": crate::effect_evidence::shell_side_effect_class_label(side),
                            }));
                        }
                    }
                    Err(reason) => failures.push(json!({
                        "effectId": id,
                        "path": "streamEvidence",
                        "reason": reason,
                    })),
                },
                None => {
                    if side == crate::effect_evidence::ShellSideEffectClass::LikelyNet {
                        shell_net_unverifiable += 1;
                        failures.push(json!({
                            "effectId": id,
                            "path": "shell.net",
                            "reason": "likely_net_side_effect_unobserved",
                            "sideEffectClass": crate::effect_evidence::shell_side_effect_class_label(side),
                        }));
                    } else {
                        unsupported_effects += 1;
                    }
                }
            }
        }
        for row in rows {
            match row["state"].as_str() {
                Some("absent") => {
                    // Signed absence facts (delete/rename/shell reduced rm|mv) are
                    // verifiable historical records without byte CAS (**350**, **669**).
                    absent_facts += 1;
                    checked += 1;
                }
                Some("present") => {
                    let digest = row["digest"].as_str().unwrap_or("");
                    let archive = row["archive"].as_str().unwrap_or("");
                    if !valid_digest(digest) {
                        legacy_unverifiable += 1;
                        continue;
                    }
                    if row.get("entryKind").and_then(|v| v.as_str()) == Some("directory") {
                        if digest == crate::effect_evidence::DIRECTORY_POSTIMAGE_DIGEST && archive.is_empty()
                        {
                            // Shell mkdir metadata-only observe (**669**); not a byte CAS row.
                            checked += 1;
                            continue;
                        }
                    }
                    if archive.is_empty() {
                        legacy_unverifiable += 1;
                        continue;
                    }
                    if archive != digest {
                        failures.push(json!({"effectId": id, "path": row["path"], "reason": "archive_binding_mismatch"}));
                        continue;
                    }
                    match check_archive(&archive_path(state_dir, digest), digest) {
                        Ok(bytes) if row["archivedBytes"].as_u64() == Some(bytes as u64) => { checked += 1; }
                        Ok(_) => failures.push(json!({"effectId": id, "path": row["path"], "reason": "archive_length_mismatch"})),
                        Err(err) => failures.push(json!({"effectId": id, "path": row["path"], "reason": err})),
                    }
                }
                _ => failures.push(json!({"effectId": id, "path": row["path"], "reason": "invalid_historical_state"})),
            }
        }
    }
    let legacy_classify =
        crate::effect_legacy_unverifiable::build_legacy_classify_report(owner_events);
    let legacy_named = legacy_classify["refused"].as_u64().unwrap_or(0) as usize;
    if legacy_named != legacy_unverifiable {
        legacy_unverifiable = legacy_named;
    }
    let overwrite_replay = replay_superseded_from_cas(state_dir, owner_events);
    let absence_replay =
        crate::effect_absent_reconstruct::replay_superseded_absent_facts(owner_events);
    let deleted_reconstruction = reconstruct_deleted_from_cas(state_dir, owner_events);
    let overwrite_ok = overwrite_replay["ok"] == true;
    let absence_replay_ok = absence_replay["ok"] == true;
    let deleted_ok = deleted_reconstruction["ok"] == true;
    let legacy_ok = legacy_classify["ok"] == true;
    json!({
        "ok": failures.is_empty() && legacy_unverifiable == 0 && unsupported_effects == 0 && shell_net_unverifiable == 0 && unresolved == 0 && overwrite_ok && absence_replay_ok && deleted_ok && legacy_ok,
        "checked": checked,
        "historicalAbsenceFacts": absent_facts,
        "legacyUnverifiable": legacy_unverifiable,
        "unsupportedEffects": unsupported_effects,
        "shellNetUnverifiable": shell_net_unverifiable,
        "unresolved": unresolved,
        "failures": failures,
        // Ruling **654**: superseded present versions independently re-observed from CAS.
        "overwriteReplay": overwrite_replay,
        // Ruling **698**: superseded signed absence facts (no byte CAS).
        "absenceReplay": absence_replay,
        // P0-2 partial: deleted bytes reconstructed only from a prior CAS version.
        "deletedByteReconstruction": deleted_reconstruction,
        // Ruling **709**: named legacy rows; CAS backfill refused.
        "legacyClassify": legacy_classify,
        // Scope name retained for wire stability; shell streamEvidence blobs
        // are also counted in `checked` when present (ruling 542).
        "scope": "archived_kernel_owned_file_postimages_only"
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn archived_history_survives_later_overwrite_and_reports_tamper() {
        let root = std::env::temp_dir().join(format!("hz-history-test-{}", uuid::Uuid::new_v4()));
        let state = root.join("state");
        fs::create_dir_all(&state).unwrap();
        let original = root.join("file");
        fs::write(&original, b"first").unwrap();
        let digest = crate::canon::sha256_bytes(b"first");
        let archive = archive_postimages(
            &state,
            &json!([{
                "path": original, "state": "present", "digest": digest
            }]),
        )
        .unwrap();
        assert_eq!(archive[0]["archive"], digest);
        let event = json!({"type": "owner.settled", "payload": {
            "effectId": "e1", "details": {"postimages": archive}
        }});
        fs::write(&original, b"later version").unwrap();
        let verified = verify_history(&state, &[event.clone()], 0);
        // Single version is still "latest" for its path — overwriteReplay empty.
        assert_eq!(verified["overwriteReplay"]["checked"], 0);
        assert_eq!(verified["ok"], true, "{verified}");
        assert_eq!(verified["checked"], 1);
        fs::write(archive_path(&state, &digest), b"forged").unwrap();
        let tampered = verify_history(&state, &[event], 0);
        assert_eq!(tampered["ok"], false);
        assert_eq!(tampered["failures"][0]["effectId"], "e1");
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn superseded_overwrite_replay_reports_prior_cas_version() {
        let root =
            std::env::temp_dir().join(format!("hz-history-overwrite-{}", uuid::Uuid::new_v4()));
        let state = root.join("state");
        fs::create_dir_all(&state).unwrap();
        let path = root.join("file");
        fs::write(&path, b"first").unwrap();
        let d1 = crate::canon::sha256_bytes(b"first");
        let a1 = archive_postimages(
            &state,
            &json!([{
                "path": &path, "state": "present", "digest": d1
            }]),
        )
        .unwrap();
        fs::write(&path, b"second").unwrap();
        let d2 = crate::canon::sha256_bytes(b"second");
        let a2 = archive_postimages(
            &state,
            &json!([{
                "path": &path, "state": "present", "digest": d2
            }]),
        )
        .unwrap();
        let events = vec![
            json!({"type": "owner.settled", "payload": {"effectId": "e1", "details": {"postimages": a1}}}),
            json!({"type": "owner.settled", "payload": {"effectId": "e2", "details": {"postimages": a2}}}),
        ];
        let verified = verify_history(&state, &events, 0);
        assert_eq!(verified["ok"], true, "{verified}");
        assert_eq!(verified["checked"], 2);
        assert_eq!(verified["overwriteReplay"]["checked"], 1, "{verified}");
        assert_eq!(verified["overwriteReplay"]["replayed"][0]["effectId"], "e1");
        assert_eq!(
            verified["overwriteReplay"]["replayed"][0]["superseded"],
            true
        );
        assert_eq!(verified["overwriteReplay"]["replayed"][0]["source"], "cas");
        assert_eq!(verified["overwriteReplay"]["replayed"][0]["digest"], d1);
        let _ = fs::remove_dir_all(root);
    }

    #[cfg(unix)]
    #[test]
    fn symlinked_archive_root_refuses_before_creating_external_shard() {
        let root =
            std::env::temp_dir().join(format!("hz-history-symlink-{}", uuid::Uuid::new_v4()));
        let state = root.join("state");
        let outside = root.join("outside");
        fs::create_dir_all(&state).unwrap();
        fs::create_dir_all(&outside).unwrap();
        let source = root.join("source.txt");
        fs::write(&source, b"secret").unwrap();
        std::os::unix::fs::symlink(&outside, state.join("owner-postimages")).unwrap();
        let digest = crate::canon::sha256_bytes(b"secret");
        let refused = archive_postimages(
            &state,
            &json!([{
                "path": source, "state": "present", "digest": digest
            }]),
        )
        .unwrap_err();
        assert!(
            refused.contains("history directory is not a plain directory"),
            "{refused}"
        );
        assert!(
            !outside.join(&digest[..2]).exists(),
            "must not write through symlink"
        );
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn oversized_source_refuses_before_archiving() {
        let root = std::env::temp_dir().join(format!("hz-history-size-{}", uuid::Uuid::new_v4()));
        let state = root.join("state");
        fs::create_dir_all(&state).unwrap();
        let source = root.join("oversized");
        fs::File::create(&source)
            .unwrap()
            .set_len(MAX_SNAPSHOT_BYTES + 1)
            .unwrap();
        let refused = archive_postimages(
            &state,
            &json!([{
                "path": source, "state": "present", "digest": "0".repeat(64)
            }]),
        )
        .unwrap_err();
        assert!(refused.contains("exceeds 64 MiB"), "{refused}");
        assert!(!state.join("owner-postimages").exists());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn existing_wrong_digest_blob_never_gets_replaced() {
        let root =
            std::env::temp_dir().join(format!("hz-history-existing-{}", uuid::Uuid::new_v4()));
        let state = root.join("state");
        fs::create_dir_all(&state).unwrap();
        let source = root.join("file");
        fs::write(&source, b"correct").unwrap();
        let digest = crate::canon::sha256_bytes(b"correct");
        let spec = json!([{"path": source, "state": "present", "digest": digest}]);
        archive_postimages(&state, &spec).unwrap();
        let blob = archive_path(&state, &digest);
        fs::write(&blob, b"corrupt").unwrap();
        let refused = archive_postimages(&state, &spec).unwrap_err();
        assert!(
            refused.contains("historical archive missing digest stability"),
            "{refused}"
        );
        assert_eq!(fs::read(blob).unwrap(), b"corrupt");
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn shell_stream_evidence_archives_and_verifies_without_unsupported() {
        let root = std::env::temp_dir().join(format!("hz-history-stream-{}", uuid::Uuid::new_v4()));
        let state = root.join("state");
        fs::create_dir_all(&state).unwrap();
        let stdout = b"hello\n";
        let stderr = b"";
        let out_d = crate::canon::sha256_bytes(stdout);
        let err_d = crate::canon::sha256_bytes(stderr);
        archive_captured_bytes(&state, &out_d, stdout).unwrap();
        archive_captured_bytes(&state, &err_d, stderr).unwrap();
        let stream = json!({
            "exitCode": 0,
            "stdout": {"digest": out_d, "archive": out_d, "archivedBytes": stdout.len()},
            "stderr": {"digest": err_d, "archive": err_d, "archivedBytes": stderr.len()},
        });
        assert_eq!(verify_stream_evidence(&state, &stream).unwrap(), 2);
        let event = json!({"type": "owner.settled", "payload": {
            "effectId": "shell-1",
            "details": {"postimages": [], "streamEvidence": stream},
        }});
        let verified = verify_history(&state, &[event], 0);
        assert_eq!(verified["ok"], true, "{verified}");
        assert_eq!(verified["unsupportedEffects"], 0, "{verified}");
        assert_eq!(verified["shellNetUnverifiable"], 0, "{verified}");
        assert_eq!(verified["checked"], 2, "{verified}");
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn shell_likely_net_argv_fail_closed_even_with_stream_cas() {
        let root = std::env::temp_dir().join(format!("hz-history-net-{}", uuid::Uuid::new_v4()));
        let state = root.join("state");
        fs::create_dir_all(&state).unwrap();
        let stdout = b"ok\n";
        let stderr = b"";
        let out_d = crate::canon::sha256_bytes(stdout);
        let err_d = crate::canon::sha256_bytes(stderr);
        archive_captured_bytes(&state, &out_d, stdout).unwrap();
        archive_captured_bytes(&state, &err_d, stderr).unwrap();
        let stream = json!({
            "exitCode": 0,
            "stdout": {"digest": out_d, "archive": out_d, "archivedBytes": stdout.len()},
            "stderr": {"digest": err_d, "archive": err_d, "archivedBytes": stderr.len()},
        });
        let event = json!({"type": "owner.settled", "payload": {
            "effectId": "shell-net-1",
            "details": {
                "postimages": [],
                "streamEvidence": stream,
                "argv": ["curl", "https://example.com"],
                "shellSideEffectClass": "likely_net",
            },
        }});
        let verified = verify_history(&state, &[event], 0);
        assert_eq!(verified["ok"], false, "{verified}");
        assert_eq!(verified["shellNetUnverifiable"], 1, "{verified}");
        assert_eq!(verified["unsupportedEffects"], 0, "{verified}");
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn legacy_pre356_row_fail_closed_with_named_classify() {
        let root = std::env::temp_dir().join(format!("hz-history-legacy-{}", uuid::Uuid::new_v4()));
        let state = root.join("state");
        fs::create_dir_all(&state).unwrap();
        let digest = crate::canon::sha256_bytes(b"legacy-bytes");
        let event = json!({"type": "owner.settled", "payload": {
            "effectId": "pre356",
            "details": {"postimages": [{
                "path": "/tmp/legacy.txt",
                "state": "present",
                "digest": digest
            }]}
        }});
        let verified = verify_history(&state, &[event], 0);
        assert_eq!(verified["ok"], false, "{verified}");
        assert_eq!(verified["legacyUnverifiable"], 1);
        assert_eq!(verified["legacyClassify"]["refused"], 1);
        assert_eq!(
            verified["legacyClassify"]["rows"][0]["reason"],
            "present_row_missing_cas_archive"
        );
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn deleted_bytes_reconstruct_from_prior_cas_version() {
        let root =
            std::env::temp_dir().join(format!("hz-history-deleted-{}", uuid::Uuid::new_v4()));
        let state = root.join("state");
        fs::create_dir_all(&state).unwrap();
        let path = root.join("gone.txt");
        let bytes = b"bytes before delete";
        fs::write(&path, bytes).unwrap();
        let digest = crate::canon::sha256_bytes(bytes);
        let present_rows = archive_postimages(
            &state,
            &json!([{
                "path": path, "state": "present", "digest": digest
            }]),
        )
        .unwrap();
        let present = json!({"type": "owner.settled", "payload": {
            "effectId": "w1", "details": {"postimages": present_rows}
        }});
        let absent = json!({"type": "owner.settled", "payload": {
            "effectId": "d1", "details": {"postimages": [{
                "path": path, "state": "absent"
            }]}
        }});

        let reconstructed = reconstruct_deleted_from_cas(&state, &[present, absent.clone()]);
        assert_eq!(reconstructed["ok"], true, "{reconstructed}");
        assert_eq!(reconstructed["checked"], 1);
        let row = &reconstructed["reconstructed"][0];
        assert_eq!(row["path"], path.to_string_lossy().as_ref());
        assert_eq!(row["digest"], digest);
        assert_eq!(row["archivedBytes"], bytes.len());
        assert_eq!(row["reconstructed"], true);

        let verified = verify_history(&state, &[absent], 0);
        assert_eq!(verified["deletedByteReconstruction"]["checked"], 0);
        let _ = fs::remove_dir_all(&root);
    }

    /// P0-2 residual: all SUPERSEDED archived versions of a deleted path must
    /// reconstruct, not just the last-present one (rulings 752/767 partial).
    #[test]
    fn deleted_bytes_reconstruct_all_prior_cas_versions() {
        let root =
            std::env::temp_dir().join(format!("hz-history-multiversion-{}", uuid::Uuid::new_v4()));
        let state = root.join("state");
        fs::create_dir_all(&state).unwrap();
        let path = root.join("multi.txt");

        let v1 = b"version-one";
        fs::write(&path, v1).unwrap();
        let d1 = crate::canon::sha256_bytes(v1);
        let r1 = archive_postimages(
            &state,
            &json!([{
                "path": path, "state": "present", "digest": d1
            }]),
        )
        .unwrap();

        let v2 = b"version-two";
        fs::write(&path, v2).unwrap();
        let d2 = crate::canon::sha256_bytes(v2);
        let r2 = archive_postimages(
            &state,
            &json!([{
                "path": path, "state": "present", "digest": d2
            }]),
        )
        .unwrap();

        let events = vec![
            json!({"type": "owner.settled", "payload": {"effectId": "w1", "details": {"postimages": r1}}}),
            json!({"type": "owner.settled", "payload": {"effectId": "w2", "details": {"postimages": r2}}}),
            json!({"type": "owner.settled", "payload": {"effectId": "del-1", "details": {"postimages": [{
                "path": path, "state": "absent"
            }]}}}),
            json!({"type": "owner.settled", "payload": {"effectId": "del-2", "details": {"postimages": [{
                "path": path, "state": "absent"
            }]}}}),
        ];

        let result = reconstruct_deleted_from_cas(&state, &events);
        assert_eq!(result["ok"], true, "{result}");
        assert_eq!(result["checked"], 2, "{result}");
        let rows = result["reconstructed"].as_array().unwrap();
        assert_eq!(
            rows.len(),
            2,
            "both superseded versions must reconstruct: {result}"
        );
        assert!(
            rows.iter().any(|x| x["digest"] == d1
                && x["effectId"] == "del-1"
                && x["archivedBytes"] == v1.len()
                && x["reconstructed"] == true),
            "{result}"
        );
        assert!(
            rows.iter().any(|x| x["digest"] == d2
                && x["effectId"] == "del-1"
                && x["archivedBytes"] == v2.len()
                && x["reconstructed"] == true),
            "{result}"
        );
        // A second absence with no intervening present re-claims nothing.
        assert!(rows.iter().all(|x| x["effectId"] != "del-2"), "{result}");

        let verified = verify_history(&state, &events, 0);
        assert_eq!(verified["deletedByteReconstruction"]["checked"], 2);
        assert_eq!(verified["ok"], true, "{verified}");
        let _ = fs::remove_dir_all(&root);
    }
}
