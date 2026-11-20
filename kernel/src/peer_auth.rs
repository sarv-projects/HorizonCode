//! H-29 / C16 (partial) — OS-level peer identity before socket NDJSON.
//!
//! Unix: `SO_PEERCRED` same-effective-UID gate on each accepted Unix socket (ruling **645**).
//! Non-Unix: `--socket` / `HZ_KERNEL_SOCKET` are refused at startup; this module never claims a
//! peer-proven detach lease (Windows named-pipe impersonation is **not** implemented).

use serde_json::{json, Value};

/// Honest product wire for `ping.socketPeerAuth` (no secrets).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SocketPeerAuthPosture {
    pub platform: &'static str,
    pub method: &'static str,
    /// True only when the build can perform an OS peer check on socket accept (Unix SO_PEERCRED).
    pub peer_check_on_accept: bool,
    /// True when `hz-kernel --socket` / `HZ_KERNEL_SOCKET` may bind on this OS.
    pub socket_serve_available: bool,
}

pub fn socket_peer_auth_posture() -> SocketPeerAuthPosture {
    #[cfg(unix)]
    {
        SocketPeerAuthPosture {
            platform: "unix",
            method: "SO_PEERCRED_same_uid",
            peer_check_on_accept: true,
            socket_serve_available: true,
        }
    }
    #[cfg(not(unix))]
    {
        SocketPeerAuthPosture {
            platform: "non_unix",
            method: "unavailable",
            peer_check_on_accept: false,
            socket_serve_available: false,
        }
    }
}

pub fn socket_peer_auth_json() -> Value {
    let p = socket_peer_auth_posture();
    json!({
        "platform": p.platform,
        "method": p.method,
        "peerCheckOnAccept": p.peer_check_on_accept,
        "socketServeAvailable": p.socket_serve_available,
    })
}

#[cfg(unix)]
pub fn authorize_same_uid_unix_stream(stream: &std::os::unix::net::UnixStream) -> Result<(), String> {
    use std::os::unix::io::AsRawFd;

    let fd = stream.as_raw_fd();
    let mut cred: libc::ucred = unsafe { std::mem::zeroed() };
    let mut len = std::mem::size_of_val(&cred) as libc::socklen_t;
    let rc = unsafe {
        libc::getsockopt(
            fd,
            libc::SOL_SOCKET,
            libc::SO_PEERCRED,
            &mut cred as *mut _ as *mut libc::c_void,
            &mut len,
        )
    };
    if rc != 0 {
        return Err("SO_PEERCRED unavailable".into());
    }
    let self_uid = unsafe { libc::getuid() };
    if cred.uid != self_uid {
        return Err(format!(
            "peer uid {} != kernel uid {} (SO_PEERCRED)",
            cred.uid, self_uid
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn socket_peer_auth_posture_matches_platform() {
        let p = socket_peer_auth_posture();
        let j = socket_peer_auth_json();
        assert_eq!(j["platform"], p.platform);
        assert_eq!(j["method"], p.method);
        assert_eq!(j["peerCheckOnAccept"], p.peer_check_on_accept);
        assert_eq!(j["socketServeAvailable"], p.socket_serve_available);
        #[cfg(unix)]
        {
            assert!(p.peer_check_on_accept);
            assert!(p.socket_serve_available);
            assert_eq!(p.method, "SO_PEERCRED_same_uid");
        }
        #[cfg(not(unix))]
        {
            assert!(!p.peer_check_on_accept);
            assert!(!p.socket_serve_available);
            assert_eq!(p.method, "unavailable");
        }
    }
}