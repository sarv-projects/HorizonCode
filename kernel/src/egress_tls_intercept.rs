//! TLS intercept stub honesty & unprivileged netns egress capability probe
//! (docs/33 §5.2 — never claim enforced without OS-level egress confinement).
//!
//! `HZ_EGRESS_TLS_INTERCEPT=1` documents intent only; terminate/re-encrypt requires
//! `HZ_EGRESS_TLS_INTERCEPT_CA` (hermetic tests).

#![allow(dead_code)]

use serde::{Deserialize, Serialize};

/// Whether the intercept stub flag is set (not enforcement).
pub fn intercept_enabled_from_env() -> bool {
    match std::env::var("HZ_EGRESS_TLS_INTERCEPT") {
        Ok(raw) => {
            let s = raw.trim();
            s == "1" || s.eq_ignore_ascii_case("true")
        }
        Err(_) => false,
    }
}

pub fn intercept_ca_configured() -> bool {
    match std::env::var("HZ_EGRESS_TLS_INTERCEPT_CA") {
        Ok(raw) => !raw.trim().is_empty(),
        Err(_) => false,
    }
}

/// Human-readable posture for doctor/kernel parity (advisory only).
pub fn intercept_posture_detail() -> String {
    if !intercept_enabled_from_env() {
        return "HZ_EGRESS_TLS_INTERCEPT unset: TLS terminate/re-encrypt stub not armed (peek-only or passthrough)".to_string();
    }
    if !intercept_ca_configured() {
        return "HZ_EGRESS_TLS_INTERCEPT=1 without HZ_EGRESS_TLS_INTERCEPT_CA: intercept unavailable (no CA material; doctor WARN advisory only)".to_string();
    }
    if terminate_enabled_from_env() {
        return "HZ_EGRESS_TLS_TERMINATE=1: CONNECT terminate precursor armed; TS may TLS pipe to upstream when forward is on — still advisory, never shell-net enforced".to_string();
    }
    "HZ_EGRESS_TLS_INTERCEPT_CA set: CONNECT forward refuses fail-closed until HZ_EGRESS_TLS_TERMINATE=1 — still advisory, never shell-net enforced".to_string()
}

pub const INTERCEPT_REFUSE_BODY: &str = "HZ_EGRESS_TLS_INTERCEPT: CA configured but TLS terminate/re-encrypt is not implemented; refusing CONNECT (fail-closed; advisory only)";

/// `HZ_EGRESS_TLS_TERMINATE=1` — opt-in hermetic terminate precursor (advisory only).
pub fn terminate_enabled_from_env() -> bool {
    match std::env::var("HZ_EGRESS_TLS_TERMINATE") {
        Ok(raw) => {
            let s = raw.trim();
            s == "1" || s.eq_ignore_ascii_case("true")
        }
        Err(_) => false,
    }
}

/// Fail-closed CONNECT when intercept is armed and CA material is configured (terminate off).
pub fn intercept_refuse_forward_from_env() -> bool {
    intercept_enabled_from_env() && intercept_ca_configured() && !terminate_enabled_from_env()
}

/// Honest OS-level unprivileged network namespace egress confinement capability.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum EgressNetnsCapability {
    PastaAvailable,
    Slirp4netnsAvailable,
    InProcessUsernsNetns,
    AdvisoryOnly { reason: String },
}

impl EgressNetnsCapability {
    /// Whether this host can confine child egress inside an unprivileged network namespace.
    pub fn can_confine_egress(&self) -> bool {
        !matches!(self, Self::AdvisoryOnly { .. })
    }

    /// Human-readable posture description.
    pub fn posture_detail(&self) -> String {
        match self {
            Self::PastaAvailable => {
                "unprivileged userns+netns available with `pasta` in PATH".to_string()
            }
            Self::Slirp4netnsAvailable => {
                "unprivileged userns+netns available with `slirp4netns` in PATH".to_string()
            }
            Self::InProcessUsernsNetns => {
                "unprivileged userns+netns available in-process (no pasta/slirp4netns helper in PATH)"
                    .to_string()
            }
            Self::AdvisoryOnly { reason } => format!("advisory only: {reason}"),
        }
    }
}

/// Pure classifier for Linux/WSL2 unprivileged userns/netns capability (unit-testable).
pub fn classify_netns_capability(
    apparmor_restrict_unprivileged_userns: Option<&str>,
    unprivileged_userns_clone: Option<&str>,
    has_pasta: bool,
    has_slirp4netns: bool,
    ns_files_present: bool,
) -> EgressNetnsCapability {
    if let Some(raw) = apparmor_restrict_unprivileged_userns {
        if raw.trim() == "1" {
            return EgressNetnsCapability::AdvisoryOnly {
                reason: "kernel.apparmor_restrict_unprivileged_userns=1 restricts unprivileged user namespaces".to_string(),
            };
        }
    }
    if let Some(raw) = unprivileged_userns_clone {
        if raw.trim() == "0" {
            return EgressNetnsCapability::AdvisoryOnly {
                reason: "kernel.unprivileged_userns_clone=0 disables unprivileged user namespaces"
                    .to_string(),
            };
        }
    }
    if !ns_files_present {
        return EgressNetnsCapability::AdvisoryOnly {
            reason: "/proc/self/ns/{user,net} unavailable on this kernel".to_string(),
        };
    }
    if has_pasta {
        return EgressNetnsCapability::PastaAvailable;
    }
    if has_slirp4netns {
        return EgressNetnsCapability::Slirp4netnsAvailable;
    }
    EgressNetnsCapability::InProcessUsernsNetns
}

/// Probe Linux/WSL2 unprivileged `userns` sysctls (`apparmor_restrict_unprivileged_userns`,
/// `unprivileged_userns_clone`) and check for `pasta` / `slirp4netns` in `PATH`.
pub fn probe_unprivileged_netns_egress() -> EgressNetnsCapability {
    #[cfg(not(target_os = "linux"))]
    {
        EgressNetnsCapability::AdvisoryOnly {
            reason: format!(
                "unprivileged netns egress confinement requires Linux/WSL2 (current target: {})",
                std::env::consts::OS
            ),
        }
    }

    #[cfg(target_os = "linux")]
    {
        let apparmor =
            std::fs::read_to_string("/proc/sys/kernel/apparmor_restrict_unprivileged_userns").ok();
        let userns_clone =
            std::fs::read_to_string("/proc/sys/kernel/unprivileged_userns_clone").ok();
        let ns_files_present = std::path::Path::new("/proc/self/ns/user").exists()
            && std::path::Path::new("/proc/self/ns/net").exists();
        let has_pasta = find_executable_in_path("pasta");
        let has_slirp4netns = find_executable_in_path("slirp4netns");

        classify_netns_capability(
            apparmor.as_deref(),
            userns_clone.as_deref(),
            has_pasta,
            has_slirp4netns,
            ns_files_present,
        )
    }
}

#[cfg(target_os = "linux")]
fn find_executable_in_path(binary: &str) -> bool {
    use std::os::unix::fs::PermissionsExt;

    let Some(path_var) = std::env::var_os("PATH") else {
        return false;
    };
    for dir in std::env::split_paths(&path_var) {
        let candidate = dir.join(binary);
        if let Ok(meta) = std::fs::metadata(&candidate) {
            if meta.is_file() && (meta.permissions().mode() & 0o111 != 0) {
                return true;
            }
        }
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn intercept_detail_without_ca_mentions_unavailable() {
        let detail = intercept_posture_detail();
        assert!(!detail.to_lowercase().contains("enforced"));
    }

    #[test]
    fn intercept_refuse_forward_requires_both_flags() {
        assert!(!intercept_refuse_forward_from_env());
    }

    #[test]
    fn classify_netns_capability_covers_all_postures_honestly() {
        // AppArmor restriction -> AdvisoryOnly even if helpers exist
        let aa = classify_netns_capability(Some("1\n"), Some("1\n"), true, true, true);
        assert!(matches!(aa, EgressNetnsCapability::AdvisoryOnly { .. }));
        assert!(!aa.can_confine_egress());

        // unprivileged_userns_clone=0 -> AdvisoryOnly
        let no_clone = classify_netns_capability(Some("0\n"), Some("0\n"), true, true, true);
        assert!(matches!(no_clone, EgressNetnsCapability::AdvisoryOnly { .. }));
        assert!(!no_clone.can_confine_egress());

        // pasta preferred over slirp4netns
        let pasta = classify_netns_capability(Some("0"), Some("1"), true, true, true);
        assert_eq!(pasta, EgressNetnsCapability::PastaAvailable);
        assert!(pasta.can_confine_egress());

        // slirp4netns fallback
        let slirp = classify_netns_capability(None, None, false, true, true);
        assert_eq!(slirp, EgressNetnsCapability::Slirp4netnsAvailable);
        assert!(slirp.can_confine_egress());

        // in-process userns+netns fallback when neither helper is installed
        let in_proc = classify_netns_capability(Some("0"), None, false, false, true);
        assert_eq!(in_proc, EgressNetnsCapability::InProcessUsernsNetns);
        assert!(in_proc.can_confine_egress());

        // missing /proc/self/ns/{user,net} -> AdvisoryOnly
        let no_ns = classify_netns_capability(None, None, true, true, false);
        assert!(matches!(no_ns, EgressNetnsCapability::AdvisoryOnly { .. }));
        assert!(!no_ns.can_confine_egress());
    }

    #[test]
    fn probe_unprivileged_netns_egress_returns_valid_posture() {
        let cap = probe_unprivileged_netns_egress();
        let summary = cap.posture_detail();
        assert!(!summary.is_empty());
        if let EgressNetnsCapability::AdvisoryOnly { ref reason } = cap {
            assert!(!reason.is_empty());
            assert!(!cap.can_confine_egress());
        } else {
            assert!(cap.can_confine_egress());
        }
    }
}
