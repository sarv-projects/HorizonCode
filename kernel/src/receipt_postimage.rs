//! Independent postimage double-read (docs/28 **256**, TS `receipt-postimage.ts` mirror).
//!
//! After mutating writes, two separate file reads must agree on sha256 or observation
//! is marked unstable (fail-closed; digest omitted from settlement).

use std::fs;
use std::path::Path;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PostimageObservation {
    pub digest: Option<String>,
    pub observation_stable: bool,
    pub confirm_digest: Option<String>,
}

/// Whether two independent observation digests agree (pure).
pub fn assess_postimage_observation(
    primary_digest: Option<&str>,
    confirm_digest: Option<&str>,
) -> (bool, Option<String>) {
    let (Some(p), Some(c)) = (primary_digest, confirm_digest) else {
        return (false, None);
    };
    if p == c {
        return (true, None);
    }
    (false, Some(c.to_string()))
}

fn digest_from_read(path: &Path) -> Option<String> {
    let bytes = fs::read(path).ok()?;
    Some(crate::canon::sha256_bytes(&bytes))
}

/// Two independent reads of `path`; mismatch → unstable, digest omitted by callers.
pub fn observe_file_postimage(path: &Path) -> PostimageObservation {
    let primary = digest_from_read(path);
    let confirm = digest_from_read(path);
    let primary_s = primary.as_deref();
    let confirm_s = confirm.as_deref();
    let (observation_stable, mismatch_confirm) = assess_postimage_observation(primary_s, confirm_s);
    PostimageObservation {
        digest: if observation_stable { primary } else { None },
        observation_stable,
        confirm_digest: mismatch_confirm,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    #[test]
    fn assess_stable_when_digests_match() {
        let (stable, confirm) = assess_postimage_observation(Some("aaa"), Some("aaa"));
        assert!(stable);
        assert!(confirm.is_none());
    }

    #[test]
    fn assess_unstable_when_digests_differ() {
        let (stable, confirm) = assess_postimage_observation(Some("aaa"), Some("bbb"));
        assert!(!stable);
        assert_eq!(confirm.as_deref(), Some("bbb"));
    }

    #[test]
    fn assess_unstable_when_read_failed() {
        let (stable, _) = assess_postimage_observation(None, Some("aaa"));
        assert!(!stable);
    }

    #[test]
    fn observe_file_postimage_stable_on_disk() {
        let dir = std::env::temp_dir().join(format!(
            "hz-receipt-postimage-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("probe.bin");
        let mut f = std::fs::File::create(&file).unwrap();
        f.write_all(b"hz-postimage-stable").unwrap();
        let expected = crate::canon::sha256_bytes(b"hz-postimage-stable");
        let obs = observe_file_postimage(&file);
        assert!(obs.observation_stable);
        assert_eq!(obs.digest.as_deref(), Some(expected.as_str()));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
