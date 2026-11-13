//! Minimal veth create + peer move via `ip` (ruling **329** reduced slice).
//! Optional link addresses + child default route after create (ruling **331**).
//! Used from `hz-sandbox-exec` pre_exec after user+net unshare when
//! `HZ_SANDBOX_VETH_CREATE=1` and CAP_NET_ADMIN is available in the user ns.

use std::io;
use std::os::unix::io::AsRawFd;
use std::path::Path;
use std::process::Command;

const CAP_NET_ADMIN: u32 = 12;
const _LINUX_CAPABILITY_VERSION_3: u32 = 0x20080522;

#[repr(C)]
struct CapUserHeader {
    version: u32,
    pid: i32,
}

#[repr(C)]
struct CapUserData {
    effective: u32,
    permitted: u32,
    inheritable: u32,
}

#[cfg(target_os = "linux")]
pub fn has_cap_net_admin() -> bool {
    #[cfg(target_arch = "x86_64")]
    const SYS_CAPGET: i64 = 125;
    #[cfg(target_arch = "aarch64")]
    const SYS_CAPGET: i64 = 90;
    #[cfg(not(any(target_arch = "x86_64", target_arch = "aarch64")))]
    return false;

    let mut hdr = CapUserHeader {
        version: _LINUX_CAPABILITY_VERSION_3,
        pid: 0,
    };
    let mut data = [
        CapUserData {
            effective: 0,
            permitted: 0,
            inheritable: 0,
        },
        CapUserData {
            effective: 0,
            permitted: 0,
            inheritable: 0,
        },
    ];
    let ret: i64;
    unsafe {
        std::arch::asm!(
            "syscall",
            inlateout("rax") SYS_CAPGET => ret,
            in("rdi") &mut hdr as *mut _ as u64,
            in("rsi") data.as_mut_ptr() as u64,
            out("rcx") _,
            out("r11") _,
            options(nostack),
        );
    }
    if ret != 0 {
        return false;
    }
    let idx = (CAP_NET_ADMIN / 32) as usize;
    let bit = 1u32 << (CAP_NET_ADMIN % 32);
    (data[idx].effective & bit) != 0
}

#[cfg(not(target_os = "linux"))]
pub fn has_cap_net_admin() -> bool {
    false
}

fn run_ip(args: &[&str]) -> io::Result<()> {
    let out = Command::new("ip").args(args).output().map_err(io::Error::other)?;
    if out.status.success() {
        return Ok(());
    }
    Err(io::Error::other(format!(
        "ip {} failed: {}",
        args.join(" "),
        String::from_utf8_lossy(&out.stderr).trim()
    )))
}

fn ip_available() -> bool {
    Command::new("ip")
        .arg("-V")
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

/// Create a veth pair in the current (child) netns and move the peer into `parent_net_fd`.
pub fn create_veth_move_peer_to_parent(
    parent_net_fd: &impl AsRawFd,
    host_if: &str,
    peer_if: &str,
) -> io::Result<()> {
    if !ip_available() {
        return Err(io::Error::new(
            io::ErrorKind::Unsupported,
            "HZ_SANDBOX_VETH_CREATE=1: `ip` utility unavailable",
        ));
    }
    if !has_cap_net_admin() {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "HZ_SANDBOX_VETH_CREATE=1: CAP_NET_ADMIN unavailable in user namespace",
        ));
    }
    if host_if.is_empty() || peer_if.is_empty() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "HZ_SANDBOX_VETH_CREATE: interface names must be non-empty",
        ));
    }
    run_ip(&[
        "link",
        "add",
        host_if,
        "type",
        "veth",
        "peer",
        "name",
        peer_if,
    ])?;
    let ns_path = format!("/proc/self/fd/{}", parent_net_fd.as_raw_fd());
    if !Path::new(&ns_path).exists() {
        let _ = run_ip(&["link", "del", host_if]);
        return Err(io::Error::new(
            io::ErrorKind::NotFound,
            "HZ_SANDBOX_VETH_CREATE: parent netns fd path missing",
        ));
    }
    run_ip(&["link", "set", peer_if, "netns", &ns_path]).inspect_err(|_| {
        let _ = run_ip(&["link", "del", host_if]);
    })?;
    Ok(())
}

/// Create veth, move peer to parent, and optionally configure addresses + child default route.
pub fn create_veth_move_peer_to_parent_with_plumb(
    parent_net_fd: &impl AsRawFd,
    host_if: &str,
    peer_if: &str,
    host_addr: Option<&str>,
    peer_addr: Option<&str>,
    default_route_gw: Option<&str>,
    default_route_requested: bool,
) -> io::Result<()> {
    create_veth_move_peer_to_parent(parent_net_fd, host_if, peer_if)?;
    let host_set = host_addr.is_some_and(|s| !s.trim().is_empty());
    let peer_set = peer_addr.is_some_and(|s| !s.trim().is_empty());
    if !host_set && !peer_set && !default_route_requested {
        return Ok(());
    }
    let gw = if default_route_requested {
        resolve_default_route_gateway(default_route_gw, peer_addr).ok_or_else(|| {
            io::Error::new(
                io::ErrorKind::InvalidInput,
                "HZ_SANDBOX_VETH_DEFAULT_ROUTE=1 requires HZ_SANDBOX_VETH_PEER_ADDR (parent) or HZ_SANDBOX_VETH_DEFAULT_ROUTE_GW",
            )
        })?
    } else {
        String::new()
    };
    let gw_ref = if default_route_requested {
        Some(gw.as_str())
    } else {
        None
    };
    configure_veth_after_create(
        parent_net_fd,
        host_if,
        peer_if,
        host_addr,
        peer_addr,
        gw_ref,
    )
    .inspect_err(|_| {
        let _ = run_ip(&["link", "del", host_if]);
    })
}

fn nsenter_available() -> bool {
    Command::new("nsenter")
        .arg("--version")
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

fn run_ip_in_parent_netns(parent_net_fd: &impl AsRawFd, args: &[&str]) -> io::Result<()> {
    if !nsenter_available() {
        return Err(io::Error::new(
            io::ErrorKind::Unsupported,
            "HZ_SANDBOX_VETH_CREATE: `nsenter` unavailable for parent netns link config",
        ));
    }
    let ns_path = format!("/proc/self/fd/{}", parent_net_fd.as_raw_fd());
    let mut full: Vec<&str> = vec!["--net", &ns_path, "ip"];
    full.extend_from_slice(args);
    let out = Command::new("nsenter").args(&full).output().map_err(io::Error::other)?;
    if out.status.success() {
        return Ok(());
    }
    Err(io::Error::other(format!(
        "nsenter ip {} failed: {}",
        args.join(" "),
        String::from_utf8_lossy(&out.stderr).trim()
    )))
}

fn gateway_from_cidr(cidr: &str) -> Option<String> {
    let ip = cidr.split('/').next()?.trim();
    if ip.is_empty() {
        return None;
    }
    Some(ip.to_string())
}

/// Bring links up, assign optional `host_addr` (child netns) / `peer_addr` (parent netns),
/// and optional child default route via `default_route_gw`.
pub fn configure_veth_after_create(
    parent_net_fd: &impl AsRawFd,
    host_if: &str,
    peer_if: &str,
    host_addr: Option<&str>,
    peer_addr: Option<&str>,
    default_route_gw: Option<&str>,
) -> io::Result<()> {
    if let Some(addr) = peer_addr {
        let addr = addr.trim();
        if !addr.is_empty() {
            run_ip_in_parent_netns(parent_net_fd, &["addr", "add", addr, "dev", peer_if])?;
            run_ip_in_parent_netns(parent_net_fd, &["link", "set", peer_if, "up"])?;
        }
    }
    if let Some(addr) = host_addr {
        let addr = addr.trim();
        if !addr.is_empty() {
            run_ip(&["addr", "add", addr, "dev", host_if])?;
            run_ip(&["link", "set", host_if, "up"])?;
        }
    }
    if let Some(gw) = default_route_gw {
        let gw = gw.trim();
        if !gw.is_empty() {
            run_ip(&["route", "add", "default", "via", gw, "dev", host_if])?;
        }
    }
    Ok(())
}

pub fn resolve_default_route_gateway(
    explicit_gw: Option<&str>,
    peer_addr_cidr: Option<&str>,
) -> Option<String> {
    explicit_gw
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string())
        .or_else(|| peer_addr_cidr.and_then(gateway_from_cidr))
}
