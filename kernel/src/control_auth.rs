//! One launch-scoped parent-control credential for permission-minting RPCs.
//!
//! Product runtimes supply a freshly generated 256-bit hex credential through
//! an inherited PRIVATE pipe (fd 3), not through the environment, argv,
//! policy file, log, or a JSON response. This authenticates the controlling
//! parent process, NOT a particular human approval. A same-UID process that
//! can ptrace or duplicate the parent's descriptors is out of this boundary.
//!
//! Legacy standalone kernels without --control-fd remain explicitly unbound.

use std::io::Read;

const SECRET_BYTES: usize = 64;

pub fn read_from_fd(fd: u32) -> Result<String, String> {
    #[cfg(not(unix))]
    {
        let _ = fd;
        return Err(
            "HZ_PRECONDITION_FAILED: private kernel control pipe is unsupported on this OS".into(),
        );
    }
    #[cfg(unix)]
    {
        use std::os::fd::FromRawFd;
        // Creating File from a *closed* inherited descriptor triggers Rust's
        // IO-safety abort in debug builds, rather than an ordinary startup
        // refusal. Check the descriptor first; the kernel is single-threaded
        // at boot so it cannot be closed by a competing kernel thread.
        if unsafe { libc::fcntl(fd as i32, libc::F_GETFD) } < 0 {
            return Err("HZ_PRECONDITION_FAILED: private kernel control pipe unavailable".into());
        }
        // The fourth Node/Bun stdio pipe is implemented as a Unix socket.
        // Reopening /proc/self/fd/3 returns ENXIO for sockets; adopt the
        // inherited fd directly. This is its sole reader/owner.
        // SAFETY: CLI accepts only the explicit inherited fd 3. The trusted
        // parent gives ownership of its child-side endpoint to this process.
        let file = unsafe { std::fs::File::from_raw_fd(fd as i32) };
        // Do not read unbounded input. The parent MUST close its write end
        // after sending exactly 64 ASCII hex chars and an optional newline.
        let mut content = String::new();
        file.take((SECRET_BYTES + 3) as u64)
            .read_to_string(&mut content)
            .map_err(|_| {
                "HZ_PRECONDITION_FAILED: invalid private kernel control pipe".to_string()
            })?;
        let value = content.strip_suffix('\n').unwrap_or(&content);
        validate_secret(value)?;
        Ok(value.to_string())
    }
}

fn validate_secret(value: &str) -> Result<(), String> {
    if value.len() != SECRET_BYTES
        || !value
            .bytes()
            .all(|ch| ch.is_ascii_digit() || (b'a'..=b'f').contains(&ch))
    {
        return Err("HZ_PRECONDITION_FAILED: invalid private kernel control credential".into());
    }
    Ok(())
}

/// Require the launcher-owned control credential in product-bound kernels
/// before minting or widening permissions. Unbound standalone kernels remain
/// legacy-compatible and explicitly do NOT provide authenticated approvals.
pub fn authorize_mint(bound: Option<&str>, supplied: Option<&str>) -> Result<(), String> {
    let Some(expected) = bound else {
        return Ok(());
    };
    let Some(candidate) = supplied else {
        return Err(
            "HZ_PRECONDITION_FAILED: kernel permission mint requires authenticated parent control"
                .into(),
        );
    };
    // A fixed-length byte comparison avoids a content-dependent early exit.
    if candidate.len() != SECRET_BYTES || expected.len() != SECRET_BYTES {
        return Err("HZ_PRECONDITION_FAILED: invalid authenticated parent control".into());
    }
    let mut difference = 0u8;
    for (a, b) in expected.bytes().zip(candidate.bytes()) {
        difference |= a ^ b;
    }
    if difference != 0 {
        return Err("HZ_PRECONDITION_FAILED: invalid authenticated parent control".into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn control_mint_accepts_only_exact_private_token_in_bound_mode() {
        let secret = "a".repeat(64);
        assert!(authorize_mint(Some(&secret), Some(&secret)).is_ok());
        assert!(authorize_mint(Some(&secret), None).is_err());
        assert!(authorize_mint(Some(&secret), Some(&"b".repeat(64))).is_err());
        assert!(authorize_mint(Some(&secret), Some(&"a".repeat(63))).is_err());
        // Standalone legacy mode is not falsely represented as authenticated.
        assert!(authorize_mint(None, None).is_ok());
    }

    #[cfg(unix)]
    #[test]
    fn a_closed_control_descriptor_returns_an_error_not_a_rust_io_safety_abort() {
        let error = read_from_fd(u32::MAX).unwrap_err();
        assert!(
            error.contains("private kernel control pipe unavailable"),
            "{error}"
        );
    }

    #[test]
    fn only_lowercase_256_bit_hex_is_accepted_at_boot() {
        assert!(validate_secret(&"f".repeat(64)).is_ok());
        assert!(validate_secret(&"F".repeat(64)).is_err());
        assert!(validate_secret("abcd").is_err());
        assert!(validate_secret(&"g".repeat(64)).is_err());
    }
}
