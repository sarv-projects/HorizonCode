//! TLS intercept stub honesty (docs/33 §5.2 — never claim enforced).
//!
//! `HZ_EGRESS_TLS_INTERCEPT=1` documents intent only; terminate/re-encrypt requires
//! `HZ_EGRESS_TLS_INTERCEPT_CA` (hermetic tests). No production MITM in this slice.

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
}
