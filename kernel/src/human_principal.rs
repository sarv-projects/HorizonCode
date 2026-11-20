//! Human vs parent-control attribution on permission mints (rulings **682**, **719**).
//!
//! `principal:"human"` is session-attested approval-path attribution only — not
//! cryptographic human identity. When the product parent holds fd-3 (**352**),
//! raw parent-authorized mints without that stamp are labeled `principal:"parent"`.
//! Opt-in `HZ_HUMAN_PRINCIPAL_STRICT=1` refuses such mints at the kernel boundary.
//!
//! Never shell-net `enforced`.

pub const HUMAN_APPROVAL_PRINCIPAL: &str = "human";
pub const PARENT_CONTROL_PRINCIPAL: &str = "parent";
const HUMAN_PRINCIPAL_STRICT_ENV: &str = "HZ_HUMAN_PRINCIPAL_STRICT";

pub fn human_principal_strict_enabled() -> bool {
    match std::env::var(HUMAN_PRINCIPAL_STRICT_ENV) {
        Ok(raw) => {
            let v = raw.trim().to_ascii_lowercase();
            v == "1" || v == "true" || v == "yes"
        }
        Err(_) => false,
    }
}

/// When the kernel is parent-control-bound (fd-3), stamp or refuse non-human mints.
pub fn normalize_parent_control_mint_principal(
    parent_control_bound: bool,
    principal: Option<String>,
) -> Result<Option<String>, String> {
    if !parent_control_bound {
        return Ok(principal);
    }
    if principal.as_deref() == Some(HUMAN_APPROVAL_PRINCIPAL) {
        return Ok(principal);
    }
    if human_principal_strict_enabled() {
        return Err(format!(
            "HZ_PRECONDITION_FAILED: {HUMAN_PRINCIPAL_STRICT_ENV}=1 refuses parent-control guard.lease/guard.grant mint without principal:\"{HUMAN_APPROVAL_PRINCIPAL}\" — fd-3 proves controlling Bun parent only (ruling 352); cryptographic human identity remains OPEN"
        ));
    }
    Ok(Some(PARENT_CONTROL_PRINCIPAL.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Mutex, OnceLock};

    fn env_lock() -> &'static Mutex<()> {
        static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
        LOCK.get_or_init(|| Mutex::new(()))
    }

    #[test]
    fn unbound_kernel_preserves_caller_principal() {
        let _g = env_lock().lock().unwrap();
        std::env::remove_var(HUMAN_PRINCIPAL_STRICT_ENV);
        assert_eq!(
            normalize_parent_control_mint_principal(false, None).unwrap(),
            None
        );
    }

    #[test]
    fn parent_bound_stamps_parent_when_not_human() {
        let _g = env_lock().lock().unwrap();
        std::env::remove_var(HUMAN_PRINCIPAL_STRICT_ENV);
        assert_eq!(
            normalize_parent_control_mint_principal(false, Some("human".into())).unwrap(),
            Some("human".into())
        );
        assert_eq!(
            normalize_parent_control_mint_principal(true, None).unwrap(),
            Some(PARENT_CONTROL_PRINCIPAL.to_string())
        );
        assert_eq!(
            normalize_parent_control_mint_principal(true, Some("human".into())).unwrap(),
            Some("human".into())
        );
    }

    #[test]
    fn strict_refuses_non_human_parent_mint() {
        let _g = env_lock().lock().unwrap();
        std::env::set_var(HUMAN_PRINCIPAL_STRICT_ENV, "1");
        let err = normalize_parent_control_mint_principal(true, None).unwrap_err();
        assert!(err.contains(HUMAN_PRINCIPAL_STRICT_ENV), "{err}");
        assert!(err.contains("352"), "{err}");
        std::env::remove_var(HUMAN_PRINCIPAL_STRICT_ENV);
    }
}