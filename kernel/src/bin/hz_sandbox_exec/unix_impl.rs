//! hz-sandbox-exec — reduced portable confinement before exec (docs/33 §5.3).
//!
//! Order: `PR_SET_NO_NEW_PRIVS` → rlimits → user+net isolation
//! (fresh netns, or `HZ_SANDBOX_VETH_JOIN=1` join + userns only when child net off) → seccomp
//! deny-list → Landlock FS (+ TCP net when ABI≥4) → exec.
//!
//! **Reduced in-wrapper join (324):** when `HZ_SANDBOX_VETH_JOIN=1` and
//! `HZ_SANDBOX_CHILD_NET` is off, join a parent-prepared netns via
//! `HZ_SANDBOX_VETH_NETNS` (absolute path or name under `/var/run/netns`) and
//! isolate user namespace only — fail-closed if join is requested but the netns
//! path is missing or `setns` fails. Does **not** create veth/bridge; full
//! product routed egress still open (**321** residual).
//!
//! **Reduced in-wrapper create (329):** when `HZ_SANDBOX_VETH_CREATE=1` and
//! `HZ_SANDBOX_CHILD_NET` is off, after user+net unshare create a veth pair and move
//! the peer into the saved parent netns when CAP_NET_ADMIN is available — fail-closed
//! when unsupported. Mutually exclusive with `HZ_SANDBOX_VETH_JOIN`. Bridge/routed
//! product egress still open; never shell-net enforced.
//!
//! **Reduced in-wrapper plumb (331):** optional `HZ_SANDBOX_VETH_HOST_ADDR` (child host
//! leg), `HZ_SANDBOX_VETH_PEER_ADDR` (parent peer leg), and `HZ_SANDBOX_VETH_DEFAULT_ROUTE=1`
//! (+ optional `HZ_SANDBOX_VETH_DEFAULT_ROUTE_GW`) after successful CREATE. ADDR/route
//! env without CREATE fails closed. Product CONNECT via spawnOwned CREATE+ADDR
//! without parent plumb is ruling **332** (TS hermetic); never enforced.
//!
//! **Ruled residual (321):** parent-side veth plumbing + spawn ROUTED env is proven
//! hermetically in TS only; never shell-net enforced.
//!
//! `HZ_SANDBOX_CHILD_NET=off` (set by `spawnOwned` when config/env requests child
//! net lockdown) forces userns+netns isolation. `on` skips netns (debug only).
//!
//! Landlock: `HZ_SANDBOX_FS_ROOT` (default `.`) is the workspace fence;
//! `HZ_SANDBOX_FS_MODE=read-only|workspace-write` (default workspace-write)
//! chooses RO vs RW access on that root;
//! `HZ_SANDBOX_FS_RO_PATHS` (optional, `:`-separated) keeps named subtrees
//! read-only under workspace-write by granting RW only on sibling trees;
//! common system prefixes are read+exec so interpreters can start. Fails closed
//! if Landlock cannot be applied on this host.

#[path = "../../sandbox_veth_netlink.rs"]
mod sandbox_veth_netlink;

use std::env;
use std::ffi::CString;
use std::fs::OpenOptions;
use std::io::{self, Write};
use std::os::fd::RawFd;
use std::os::unix::fs::OpenOptionsExt;
use std::os::unix::io::AsRawFd;
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::Command;

const SECCOMP_MODE_FILTER: i32 = 2;
const SECCOMP_RET_KILL_PROCESS: u32 = 0x8000_0000;
const SECCOMP_RET_ALLOW: u32 = 0x7fff0000;
const SECCOMP_RET_ERRNO: u32 = 0x00050000;

const BPF_LD: u16 = 0x00;
const BPF_W: u16 = 0x00;
const BPF_ABS: u16 = 0x20;
const BPF_JMP: u16 = 0x05;
const BPF_JEQ: u16 = 0x10;
const BPF_JGE: u16 = 0x30;
const BPF_JSET: u16 = 0x40;
const BPF_K: u16 = 0x00;
const BPF_RET: u16 = 0x06;

#[cfg(target_arch = "x86_64")]
const X32_SYSCALL_BIT: u32 = 0x4000_0000;

#[cfg(target_arch = "x86_64")]
const SYS_CLONE_NR: u32 = 56;
#[cfg(target_arch = "aarch64")]
const SYS_CLONE_NR: u32 = 220;
const CLONE_NEWUSER_FLAG: u32 = 0x1000_0000;

#[cfg(any(target_arch = "x86_64", target_arch = "aarch64"))]
const SYS_LANDLOCK_CREATE_RULESET: i64 = 444;
#[cfg(any(target_arch = "x86_64", target_arch = "aarch64"))]
const SYS_LANDLOCK_ADD_RULE: i64 = 445;
#[cfg(any(target_arch = "x86_64", target_arch = "aarch64"))]
const SYS_LANDLOCK_RESTRICT_SELF: i64 = 446;

const LANDLOCK_ACCESS_FS_EXECUTE: u64 = 1 << 0;
const LANDLOCK_ACCESS_FS_WRITE_FILE: u64 = 1 << 1;
const LANDLOCK_ACCESS_FS_READ_FILE: u64 = 1 << 2;
const LANDLOCK_ACCESS_FS_READ_DIR: u64 = 1 << 3;
const LANDLOCK_ACCESS_FS_REMOVE_DIR: u64 = 1 << 4;
const LANDLOCK_ACCESS_FS_REMOVE_FILE: u64 = 1 << 5;
const LANDLOCK_ACCESS_FS_MAKE_CHAR: u64 = 1 << 6;
const LANDLOCK_ACCESS_FS_MAKE_DIR: u64 = 1 << 7;
const LANDLOCK_ACCESS_FS_MAKE_REG: u64 = 1 << 8;
const LANDLOCK_ACCESS_FS_MAKE_SOCK: u64 = 1 << 9;
const LANDLOCK_ACCESS_FS_MAKE_FIFO: u64 = 1 << 10;
const LANDLOCK_ACCESS_FS_MAKE_BLOCK: u64 = 1 << 11;
const LANDLOCK_ACCESS_FS_MAKE_SYM: u64 = 1 << 12;
const LANDLOCK_ACCESS_FS_REFER: u64 = 1 << 13;
const LANDLOCK_ACCESS_FS_TRUNCATE: u64 = 1 << 14;

const HANDLED_ACCESS_FS: u64 = LANDLOCK_ACCESS_FS_EXECUTE
    | LANDLOCK_ACCESS_FS_WRITE_FILE
    | LANDLOCK_ACCESS_FS_READ_FILE
    | LANDLOCK_ACCESS_FS_READ_DIR
    | LANDLOCK_ACCESS_FS_REMOVE_DIR
    | LANDLOCK_ACCESS_FS_REMOVE_FILE
    | LANDLOCK_ACCESS_FS_MAKE_CHAR
    | LANDLOCK_ACCESS_FS_MAKE_DIR
    | LANDLOCK_ACCESS_FS_MAKE_REG
    | LANDLOCK_ACCESS_FS_MAKE_SOCK
    | LANDLOCK_ACCESS_FS_MAKE_FIFO
    | LANDLOCK_ACCESS_FS_MAKE_BLOCK
    | LANDLOCK_ACCESS_FS_MAKE_SYM
    | LANDLOCK_ACCESS_FS_REFER
    | LANDLOCK_ACCESS_FS_TRUNCATE;

const ACCESS_RO: u64 = LANDLOCK_ACCESS_FS_EXECUTE
    | LANDLOCK_ACCESS_FS_READ_FILE
    | LANDLOCK_ACCESS_FS_READ_DIR;

const ACCESS_RW: u64 = ACCESS_RO
    | LANDLOCK_ACCESS_FS_WRITE_FILE
    | LANDLOCK_ACCESS_FS_REMOVE_DIR
    | LANDLOCK_ACCESS_FS_REMOVE_FILE
    | LANDLOCK_ACCESS_FS_MAKE_DIR
    | LANDLOCK_ACCESS_FS_MAKE_REG
    | LANDLOCK_ACCESS_FS_MAKE_SYM
    | LANDLOCK_ACCESS_FS_REFER
    | LANDLOCK_ACCESS_FS_TRUNCATE;

const LANDLOCK_RULE_PATH_BENEATH: u32 = 1;
const LANDLOCK_CREATE_RULESET_VERSION: u64 = 1 << 0;

/// ABI ≥ 4 network accesses (deny when handled with no port allow-rules).
const LANDLOCK_ACCESS_NET_BIND_TCP: u64 = 1 << 0;
const LANDLOCK_ACCESS_NET_CONNECT_TCP: u64 = 1 << 1;
const HANDLED_ACCESS_NET: u64 = LANDLOCK_ACCESS_NET_BIND_TCP | LANDLOCK_ACCESS_NET_CONNECT_TCP;

#[repr(C)]
struct LandlockRulesetAttr {
    handled_access_fs: u64,
}

#[repr(C)]
struct LandlockRulesetAttrV4 {
    handled_access_fs: u64,
    handled_access_net: u64,
}

#[repr(C)]
struct LandlockPathBeneathAttr {
    allowed_access: u64,
    parent_fd: i32,
}

#[repr(C)]
struct SockFilter {
    code: u16,
    jt: u8,
    jf: u8,
    k: u32,
}

#[repr(C)]
struct SockFprog {
    len: u16,
    filter: *const SockFilter,
}

fn stmt(code: u16, k: u32) -> SockFilter {
    SockFilter {
        code,
        jt: 0,
        jf: 0,
        k,
    }
}

fn jump(code: u16, k: u32, jt: u8, jf: u8) -> SockFilter {
    SockFilter { code, jt, jf, k }
}

#[cfg(target_arch = "x86_64")]
const AUDIT_ARCH_NATIVE: u32 = 0xc000_003e;
#[cfg(target_arch = "aarch64")]
const AUDIT_ARCH_NATIVE: u32 = 0xc000_00b7;

#[cfg(target_arch = "x86_64")]
const DENY_SYSCALLS: &[i64] = &[
    101, // ptrace
    155, // pivot_root
    165, // mount
    246, // kexec_load
    272, // unshare
    304, // open_by_handle_at
    310, // process_vm_readv
    311, // process_vm_writev
    320, // kexec_file_load
    321, // bpf
    323, // userfaultfd
    425, // io_uring_setup
    426, // io_uring_enter
    427, // io_uring_register
];
#[cfg(target_arch = "aarch64")]
const DENY_SYSCALLS: &[i64] = &[
    40,  // mount
    41,  // pivot_root
    97,  // unshare
    104, // kexec_load
    117, // ptrace
    265, // open_by_handle_at
    270, // process_vm_readv
    271, // process_vm_writev
    280, // bpf
    282, // userfaultfd
    294, // kexec_file_load
    425, // io_uring_setup
    426, // io_uring_enter
    427, // io_uring_register
];

fn build_seccomp_denylist_filters() -> Vec<SockFilter> {
    const OFF_NR: u32 = 0;
    const OFF_ARCH: u32 = 4;
    const OFF_ARG0_LO: u32 = 16;

    let mut filters: Vec<SockFilter> = Vec::new();
    filters.push(stmt(BPF_LD | BPF_W | BPF_ABS, OFF_ARCH));
    filters.push(jump(
        BPF_JMP | BPF_JEQ | BPF_K,
        AUDIT_ARCH_NATIVE,
        1,
        0,
    ));
    filters.push(stmt(BPF_RET | BPF_K, SECCOMP_RET_KILL_PROCESS));
    filters.push(stmt(BPF_LD | BPF_W | BPF_ABS, OFF_NR));

    let x32_checks = if cfg!(target_arch = "x86_64") { 1 } else { 0 };
    // 3 instructions for conditional clone(CLONE_NEWUSER) check + 1 for ALLOW.
    let deny_pos = filters.len() + x32_checks + DENY_SYSCALLS.len() + 3 + 1;

    #[cfg(target_arch = "x86_64")]
    {
        // Reject x32 ABI syscalls (nr >= __X32_SYSCALL_BIT = 0x4000_0000) so
        // callers cannot bypass the x86_64 denylist with the x32 bit set.
        let dist = deny_pos - filters.len() - 1;
        filters.push(jump(
            BPF_JMP | BPF_JGE | BPF_K,
            X32_SYSCALL_BIT,
            dist as u8,
            0,
        ));
    }

    for &nr in DENY_SYSCALLS.iter() {
        let dist = deny_pos - filters.len() - 1;
        filters.push(jump(
            BPF_JMP | BPF_JEQ | BPF_K,
            nr as u32,
            dist as u8,
            0,
        ));
    }
    // Block clone() when CLONE_NEWUSER is set in arg0 (allows normal fork/threads).
    filters.push(jump(BPF_JMP | BPF_JEQ | BPF_K, SYS_CLONE_NR, 0, 2));
    filters.push(stmt(BPF_LD | BPF_W | BPF_ABS, OFF_ARG0_LO));
    filters.push(jump(
        BPF_JMP | BPF_JSET | BPF_K,
        CLONE_NEWUSER_FLAG,
        1,
        0,
    ));
    filters.push(stmt(BPF_RET | BPF_K, SECCOMP_RET_ALLOW));
    debug_assert_eq!(filters.len(), deny_pos);
    filters.push(stmt(
        BPF_RET | BPF_K,
        SECCOMP_RET_ERRNO | (libc::EPERM as u32),
    ));
    filters
}

fn install_seccomp_denylist() -> io::Result<()> {
    let filters = build_seccomp_denylist_filters();

    let prog = SockFprog {
        len: filters.len() as u16,
        filter: filters.as_ptr(),
    };
    let rc = unsafe {
        libc::prctl(
            libc::PR_SET_SECCOMP,
            SECCOMP_MODE_FILTER as libc::c_ulong,
            &prog as *const _ as libc::c_ulong,
        )
    };
    if rc != 0 {
        return Err(io::Error::last_os_error());
    }
    std::mem::forget(filters);
    Ok(())
}

fn apply_rlimits() -> io::Result<()> {
    let set_limit = |resource: libc::__rlimit_resource_t, soft: u64, hard: u64| -> io::Result<()> {
        let lim = libc::rlimit {
            rlim_cur: soft,
            rlim_max: hard,
        };
        if unsafe { libc::setrlimit(resource, &lim) } != 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(())
    };
    set_limit(libc::RLIMIT_CPU, 300, 300)?;
    set_limit(libc::RLIMIT_AS, 2_147_483_648, 2_147_483_648)?;
    set_limit(libc::RLIMIT_FSIZE, 256 * 1024 * 1024, 256 * 1024 * 1024)?;
    set_limit(libc::RLIMIT_NOFILE, 256, 256)?;
    Ok(())
}

fn write_proc(path: &str, body: &str) -> io::Result<()> {
    let mut f = OpenOptions::new().write(true).open(path)?;
    f.write_all(body.as_bytes())?;
    Ok(())
}

fn child_network_isolation_requested() -> bool {
    match env::var("HZ_SANDBOX_CHILD_NET").ok() {
        None => true,
        Some(raw) => {
            raw.trim().to_lowercase() != "on"
        }
    }
}

fn env_flag_is_on(raw: &str) -> bool {
    matches!(
        raw.trim().to_lowercase().as_str(),
        "1" | "true" | "on" | "yes"
    )
}

fn veth_join_requested() -> bool {
    env::var("HZ_SANDBOX_VETH_JOIN")
        .ok()
        .is_some_and(|raw| env_flag_is_on(&raw))
}

fn veth_create_requested() -> bool {
    env::var("HZ_SANDBOX_VETH_CREATE")
        .ok()
        .is_some_and(|raw| env_flag_is_on(&raw))
}

fn optional_env_trim(key: &str) -> Option<String> {
    env::var(key)
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

fn veth_default_route_requested() -> bool {
    env::var("HZ_SANDBOX_VETH_DEFAULT_ROUTE")
        .ok()
        .is_some_and(|raw| env_flag_is_on(&raw))
}

fn veth_addr_or_route_env_without_create() -> bool {
    !veth_create_requested()
        && (optional_env_trim("HZ_SANDBOX_VETH_HOST_ADDR").is_some()
            || optional_env_trim("HZ_SANDBOX_VETH_PEER_ADDR").is_some()
            || veth_default_route_requested()
            || optional_env_trim("HZ_SANDBOX_VETH_DEFAULT_ROUTE_GW").is_some())
}

fn resolve_veth_iface_names() -> (String, String) {
    let host = env::var("HZ_SANDBOX_VETH_HOST")
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "hz-sbx-veth-h".to_string());
    let peer = env::var("HZ_SANDBOX_VETH_PEER")
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "hz-sbx-veth-p".to_string());
    (host, peer)
}

/// Parent-prepared netns: absolute path or name under `/var/run/netns/`.
fn resolve_veth_netns_path() -> Option<PathBuf> {
    let raw = env::var("HZ_SANDBOX_VETH_NETNS").ok()?;
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return None;
    }
    let p = Path::new(trimmed);
    if p.is_absolute() {
        Some(p.to_path_buf())
    } else {
        Some(PathBuf::from("/var/run/netns").join(trimmed))
    }
}

fn join_prepared_netns(path: &Path) -> io::Result<()> {
    let file = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_CLOEXEC)
        .open(path)?;
    let fd = file.as_raw_fd();
    if unsafe { libc::setns(fd, libc::CLONE_NEWNET) } != 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}

fn map_userns_identities(uid: libc::uid_t, gid: libc::gid_t) -> io::Result<()> {
    let _ = write_proc("/proc/self/setgroups", "deny\n");
    write_proc("/proc/self/uid_map", &format!("0 {uid} 1\n"))?;
    write_proc("/proc/self/gid_map", &format!("0 {gid} 1\n"))?;
    Ok(())
}

fn isolate_user_namespace() -> io::Result<()> {
    let uid = unsafe { libc::getuid() };
    let gid = unsafe { libc::getgid() };
    if unsafe { libc::unshare(libc::CLONE_NEWUSER) } != 0 {
        return Err(io::Error::last_os_error());
    }
    map_userns_identities(uid, gid)
}

fn isolate_network() -> io::Result<()> {
    let uid = unsafe { libc::getuid() };
    let gid = unsafe { libc::getgid() };
    let flags = libc::CLONE_NEWUSER | libc::CLONE_NEWNET;
    if unsafe { libc::unshare(flags) } != 0 {
        return Err(io::Error::last_os_error());
    }
    map_userns_identities(uid, gid)
}

fn apply_veth_create_isolation() -> io::Result<()> {
    let parent_net = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_CLOEXEC)
        .open("/proc/self/ns/net")?;
    isolate_network()?;
    let (host, peer) = resolve_veth_iface_names();
    let host_addr = optional_env_trim("HZ_SANDBOX_VETH_HOST_ADDR");
    let peer_addr = optional_env_trim("HZ_SANDBOX_VETH_PEER_ADDR");
    let route_gw = optional_env_trim("HZ_SANDBOX_VETH_DEFAULT_ROUTE_GW");
    let route_on = veth_default_route_requested();
    sandbox_veth_netlink::create_veth_move_peer_to_parent_with_plumb(
        &parent_net,
        &host,
        &peer,
        host_addr.as_deref(),
        peer_addr.as_deref(),
        route_gw.as_deref(),
        route_on,
    )
}

fn apply_child_network_isolation() -> io::Result<()> {
    if veth_addr_or_route_env_without_create() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "HZ_SANDBOX_VETH_HOST_ADDR, HZ_SANDBOX_VETH_PEER_ADDR, and HZ_SANDBOX_VETH_DEFAULT_ROUTE_* require HZ_SANDBOX_VETH_CREATE=1",
        ));
    }
    if veth_create_requested() && veth_join_requested() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "HZ_SANDBOX_VETH_CREATE and HZ_SANDBOX_VETH_JOIN are mutually exclusive",
        ));
    }
    if veth_create_requested() {
        return apply_veth_create_isolation();
    }
    if veth_join_requested() {
        let path = resolve_veth_netns_path().ok_or_else(|| {
            io::Error::new(
                io::ErrorKind::InvalidInput,
                "HZ_SANDBOX_VETH_JOIN=1 requires HZ_SANDBOX_VETH_NETNS (path or netns name)",
            )
        })?;
        if !path.exists() {
            return Err(io::Error::new(
                io::ErrorKind::NotFound,
                format!(
                    "HZ_SANDBOX_VETH_JOIN: prepared netns missing at {}",
                    path.display()
                ),
            ));
        }
        join_prepared_netns(&path)?;
        return isolate_user_namespace();
    }
    isolate_network()
}

#[cfg(target_arch = "x86_64")]
unsafe fn raw_syscall2(nr: i64, a0: u64, a1: u64) -> i64 {
    let ret: i64;
    std::arch::asm!(
        "syscall",
        inlateout("rax") nr => ret,
        in("rdi") a0,
        in("rsi") a1,
        out("rcx") _,
        out("r11") _,
        options(nostack),
    );
    ret
}

#[cfg(target_arch = "x86_64")]
unsafe fn raw_syscall3(nr: i64, a0: u64, a1: u64, a2: u64) -> i64 {
    let ret: i64;
    std::arch::asm!(
        "syscall",
        inlateout("rax") nr => ret,
        in("rdi") a0,
        in("rsi") a1,
        in("rdx") a2,
        out("rcx") _,
        out("r11") _,
        options(nostack),
    );
    ret
}

#[cfg(target_arch = "x86_64")]
unsafe fn raw_syscall4(nr: i64, a0: u64, a1: u64, a2: u64, a3: u64) -> i64 {
    let ret: i64;
    std::arch::asm!(
        "syscall",
        inlateout("rax") nr => ret,
        in("rdi") a0,
        in("rsi") a1,
        in("rdx") a2,
        in("r10") a3,
        out("rcx") _,
        out("r11") _,
        options(nostack),
    );
    ret
}

#[cfg(target_arch = "aarch64")]
unsafe fn raw_syscall2(nr: i64, a0: u64, a1: u64) -> i64 {
    let ret: i64;
    std::arch::asm!(
        "svc #0",
        in("x8") nr,
        inlateout("x0") a0 as i64 => ret,
        in("x1") a1,
        options(nostack),
    );
    ret
}

#[cfg(target_arch = "aarch64")]
unsafe fn raw_syscall3(nr: i64, a0: u64, a1: u64, a2: u64) -> i64 {
    let ret: i64;
    std::arch::asm!(
        "svc #0",
        in("x8") nr,
        inlateout("x0") a0 as i64 => ret,
        in("x1") a1,
        in("x2") a2,
        options(nostack),
    );
    ret
}

#[cfg(target_arch = "aarch64")]
unsafe fn raw_syscall4(nr: i64, a0: u64, a1: u64, a2: u64, a3: u64) -> i64 {
    let ret: i64;
    std::arch::asm!(
        "svc #0",
        in("x8") nr,
        inlateout("x0") a0 as i64 => ret,
        in("x1") a1,
        in("x2") a2,
        in("x3") a3,
        options(nostack),
    );
    ret
}

#[cfg(any(target_arch = "x86_64", target_arch = "aarch64"))]
fn landlock_abi_version() -> i64 {
    unsafe {
        raw_syscall3(
            SYS_LANDLOCK_CREATE_RULESET,
            0,
            0,
            LANDLOCK_CREATE_RULESET_VERSION,
        )
    }
}

fn handled_access_fs_for_abi(abi: i64) -> u64 {
    let mut handled = HANDLED_ACCESS_FS;
    if abi < 2 {
        handled &= !LANDLOCK_ACCESS_FS_REFER;
    }
    if abi < 3 {
        handled &= !LANDLOCK_ACCESS_FS_TRUNCATE;
    }
    handled
}

/// On Landlock ABI ≥ 4, only enforce TCP bind/connect denial when child network
/// isolation is active (`HZ_SANDBOX_CHILD_NET != on`). When `child_net=on`,
/// `handled_access_net` MUST be 0 so TCP is not broken on Linux 6.7+/WSL2.
fn handled_access_net_for_abi(abi: i64, deny_net: bool) -> u64 {
    if abi >= 4 && deny_net {
        HANDLED_ACCESS_NET
    } else {
        0
    }
}

#[cfg(any(target_arch = "x86_64", target_arch = "aarch64"))]
fn landlock_create_ruleset(deny_net: bool) -> io::Result<(RawFd, u64)> {
    let abi = landlock_abi_version();
    if abi < 1 {
        return Err(io::Error::new(
            io::ErrorKind::Unsupported,
            format!("Landlock ABI unavailable (version {abi})"),
        ));
    }
    let handled_fs = handled_access_fs_for_abi(abi);
    let handled_net = handled_access_net_for_abi(abi, deny_net);
    let ret: i64 = if abi >= 4 {
        let attr = LandlockRulesetAttrV4 {
            handled_access_fs: handled_fs,
            handled_access_net: handled_net,
        };
        unsafe {
            raw_syscall3(
                SYS_LANDLOCK_CREATE_RULESET,
                &attr as *const _ as u64,
                std::mem::size_of::<LandlockRulesetAttrV4>() as u64,
                0,
            )
        }
    } else {
        let attr = LandlockRulesetAttr {
            handled_access_fs: handled_fs,
        };
        unsafe {
            raw_syscall3(
                SYS_LANDLOCK_CREATE_RULESET,
                &attr as *const _ as u64,
                std::mem::size_of::<LandlockRulesetAttr>() as u64,
                0,
            )
        }
    };
    if ret < 0 {
        return Err(io::Error::from_raw_os_error((-ret) as i32));
    }
    Ok((ret as RawFd, handled_fs))
}

#[cfg(any(target_arch = "x86_64", target_arch = "aarch64"))]
fn landlock_add_path(ruleset: RawFd, path: &Path, access: u64, handled_fs: u64) -> io::Result<()> {
    // O_PATH | O_NOFOLLOW ensures workspace symlinks (e.g. ws/escape -> ~/.ssh)
    // open the symlink inode itself rather than granting ACCESS_RW to targets outside.
    let file = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_PATH | libc::O_NOFOLLOW | libc::O_CLOEXEC)
        .open(path)?;
    let attr = LandlockPathBeneathAttr {
        allowed_access: access & handled_fs,
        parent_fd: file.as_raw_fd(),
    };
    let ret = unsafe {
        raw_syscall4(
            SYS_LANDLOCK_ADD_RULE,
            ruleset as u64,
            LANDLOCK_RULE_PATH_BENEATH as u64,
            &attr as *const _ as u64,
            0,
        )
    };
    if ret < 0 {
        return Err(io::Error::from_raw_os_error((-ret) as i32));
    }
    Ok(())
}

#[cfg(any(target_arch = "x86_64", target_arch = "aarch64"))]
fn landlock_restrict_self(ruleset: RawFd) -> io::Result<()> {
    let ret = unsafe { raw_syscall2(SYS_LANDLOCK_RESTRICT_SELF, ruleset as u64, 0) };
    if ret < 0 {
        return Err(io::Error::from_raw_os_error((-ret) as i32));
    }
    Ok(())
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum FsMode {
    ReadOnly,
    WorkspaceWrite,
}

fn parse_fs_mode(raw: Option<&str>) -> io::Result<FsMode> {
    match raw {
        None => Ok(FsMode::WorkspaceWrite),
        Some(v) => match v.trim() {
            "read-only" | "readonly" | "ro" => Ok(FsMode::ReadOnly),
            "workspace-write" | "rw" => Ok(FsMode::WorkspaceWrite),
            other => Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                format!("unknown HZ_SANDBOX_FS_MODE: {other:?}"),
            )),
        },
    }
}

fn resolve_fs_mode() -> io::Result<FsMode> {
    match env::var("HZ_SANDBOX_FS_MODE") {
        Ok(raw) => parse_fs_mode(Some(&raw)),
        Err(env::VarError::NotPresent) => Ok(FsMode::WorkspaceWrite),
        Err(env::VarError::NotUnicode(_)) => Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "HZ_SANDBOX_FS_MODE is not valid UTF-8",
        )),
    }
}

#[cfg(not(any(target_arch = "x86_64", target_arch = "aarch64")))]
fn apply_landlock(_fs_root: &Path, _mode: FsMode, _deny_net: bool) -> io::Result<()> {
    Err(io::Error::new(
        io::ErrorKind::Unsupported,
        "Landlock apply is only implemented on x86_64 and aarch64",
    ))
}

/// Mandatory read-only paths inside writable workspaces when present.
const MANDATORY_WORKSPACE_RO_REL_PATHS: &[&str] = &[
    ".git/hooks",
    ".git/config",
    ".mcp.json",
    ".vscode",
];

/// Optional `:`-separated absolute paths that must stay read-only even when the
/// workspace fence is `workspace-write` (typically the kernel state directory),
/// plus mandatory workspace RO protections (`.git/hooks`, `.git/config`,
/// `.mcp.json`, `.vscode`) whenever present inside `fs_root`.
fn resolve_ro_paths(fs_root: &Path) -> Vec<PathBuf> {
    let mut out: Vec<PathBuf> = Vec::new();
    if let Ok(raw) = env::var("HZ_SANDBOX_FS_RO_PATHS") {
        for p in raw.split(':').filter(|p| !p.is_empty()) {
            let resolved = PathBuf::from(p)
                .canonicalize()
                .unwrap_or_else(|_| PathBuf::from(p));
            if !out.contains(&resolved) {
                out.push(resolved);
            }
        }
    }
    for rel in MANDATORY_WORKSPACE_RO_REL_PATHS {
        let candidate = fs_root.join(rel);
        if let Ok(meta) = std::fs::symlink_metadata(&candidate) {
            let target = if meta.file_type().is_symlink() {
                candidate
            } else {
                candidate.canonicalize().unwrap_or(candidate)
            };
            if !out.contains(&target) {
                out.push(target);
            }
        }
    }
    out
}

fn path_is_or_under(path: &Path, ancestor: &Path) -> bool {
    path == ancestor || path.starts_with(ancestor)
}

fn path_covers_any_ro(path: &Path, ro_paths: &[PathBuf]) -> bool {
    ro_paths.iter().any(|ro| path_is_or_under(ro, path) && path != ro)
}

fn path_is_ro_protected(path: &Path, ro_paths: &[PathBuf]) -> bool {
    ro_paths
        .iter()
        .any(|ro| path_is_or_under(path, ro))
}

/// Explicit ACCESS_RO on every entry under `dir` (files do not inherit reliably).
/// Never follows symlinks.
#[cfg(any(target_arch = "x86_64", target_arch = "aarch64"))]
fn landlock_add_ro_tree(ruleset: RawFd, dir: &Path, handled_fs: u64) {
    let _ = landlock_add_path(ruleset, dir, ACCESS_RO, handled_fs);
    let entries = match std::fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return,
    };
    for entry in entries.flatten() {
        let p = entry.path();
        if entry.file_type().map(|ft| ft.is_symlink()).unwrap_or(true) {
            continue;
        }
        let _ = landlock_add_path(ruleset, &p, ACCESS_RO, handled_fs);
        if p.is_dir() {
            landlock_add_ro_tree(ruleset, &p, handled_fs);
        }
    }
}

/// Grant RW on each directory entry under `dir`, recursing into ancestors of an
/// RO path so the protected subtree never inherits a parent RW grant.
/// Never follows symlinks.
#[cfg(any(target_arch = "x86_64", target_arch = "aarch64"))]
fn landlock_add_rw_excluding(ruleset: RawFd, dir: &Path, ro_paths: &[PathBuf], handled_fs: u64) {
    let entries = match std::fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return,
    };
    for entry in entries.flatten() {
        let p = entry.path();
        if entry.file_type().map(|ft| ft.is_symlink()).unwrap_or(true) {
            continue;
        }
        if path_is_ro_protected(&p, ro_paths) {
            if p.is_dir() {
                landlock_add_ro_tree(ruleset, &p, handled_fs);
            } else {
                let _ = landlock_add_path(ruleset, &p, ACCESS_RO, handled_fs);
            }
            continue;
        }
        if path_covers_any_ro(&p, ro_paths) {
            let _ = landlock_add_path(ruleset, &p, ACCESS_RO, handled_fs);
            landlock_add_rw_excluding(ruleset, &p, ro_paths, handled_fs);
            continue;
        }
        let _ = landlock_add_path(ruleset, &p, ACCESS_RW, handled_fs);
    }
}

#[cfg(any(target_arch = "x86_64", target_arch = "aarch64"))]
fn apply_landlock(fs_root: &Path, mode: FsMode, deny_net: bool) -> io::Result<()> {
    // ABI ≥ 4: handled_access_net is set only when deny_net is true
    // (HZ_SANDBOX_CHILD_NET != on), so TCP bind/connect are denied when network
    // isolation is active and allowed when child_net=on (Linux 6.7+/WSL2).
    let (ruleset, handled_fs) = landlock_create_ruleset(deny_net)?;
    let ro_paths = resolve_ro_paths(fs_root);
    match mode {
        FsMode::ReadOnly => {
            landlock_add_path(ruleset, fs_root, ACCESS_RO, handled_fs)?;
        }
        FsMode::WorkspaceWrite if ro_paths.is_empty() => {
            landlock_add_path(ruleset, fs_root, ACCESS_RW, handled_fs)?;
        }
        FsMode::WorkspaceWrite => {
            // Default RO on the whole workspace, then RW grants only on paths that
            // are not under HZ_SANDBOX_FS_RO_PATHS or mandatory workspace RO paths.
            landlock_add_path(ruleset, fs_root, ACCESS_RO, handled_fs)?;
            for ro in &ro_paths {
                if path_is_or_under(ro, fs_root) {
                    if ro.is_dir() && !ro.is_symlink() {
                        landlock_add_ro_tree(ruleset, ro, handled_fs);
                    } else if !ro.is_symlink() {
                        landlock_add_path(ruleset, ro, ACCESS_RO, handled_fs)?;
                    }
                }
            }
            landlock_add_rw_excluding(ruleset, fs_root, &ro_paths, handled_fs);
        }
    }
    // System prefixes so dynamic loaders / interpreters can run.
    // Never grant broad `/tmp` ACCESS_RW (protects hz-ephemeral-ca-*.pem and
    // hz-stream-*.bin in /tmp); allow /dev/null RW in workspace-write mode so
    // shell redirects to /dev/null still work.
    for prefix in [
        "/usr", "/bin", "/sbin", "/lib", "/lib64", "/etc", "/dev", "/proc", "/tmp",
    ] {
        let p = Path::new(prefix);
        if p.exists() {
            let _ = landlock_add_path(ruleset, p, ACCESS_RO, handled_fs);
        }
    }
    if mode == FsMode::WorkspaceWrite {
        let dev_null = Path::new("/dev/null");
        if dev_null.exists() {
            let _ = landlock_add_path(ruleset, dev_null, ACCESS_RW, handled_fs);
        }
    }
    landlock_restrict_self(ruleset)?;
    unsafe {
        libc::close(ruleset);
    }
    Ok(())
}

fn resolve_fs_root() -> io::Result<PathBuf> {
    let raw = match env::var("HZ_SANDBOX_FS_ROOT") {
        Ok(v) => {
            if v.trim().is_empty() {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidInput,
                    "HZ_SANDBOX_FS_ROOT must not be empty",
                ));
            }
            v
        }
        Err(env::VarError::NotPresent) => ".".to_string(),
        Err(env::VarError::NotUnicode(_)) => {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "HZ_SANDBOX_FS_ROOT is not valid UTF-8",
            ));
        }
    };
    let canon = PathBuf::from(&raw).canonicalize().map_err(|e| {
        io::Error::new(
            e.kind(),
            format!("invalid HZ_SANDBOX_FS_ROOT {raw:?}: {e}"),
        )
    })?;
    if !canon.is_dir() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            format!("HZ_SANDBOX_FS_ROOT is not a directory: {}", canon.display()),
        ));
    }
    Ok(canon)
}

fn pre_exec_confine() -> io::Result<()> {
    if unsafe { libc::prctl(libc::PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) } != 0 {
        return Err(io::Error::last_os_error());
    }
    apply_rlimits()?;
    let deny_net = child_network_isolation_requested();
    if deny_net {
        apply_child_network_isolation()?;
    }
    install_seccomp_denylist()?;
    let fs_root = resolve_fs_root()?;
    let fs_mode = resolve_fs_mode()?;
    apply_landlock(&fs_root, fs_mode, deny_net)?;
    Ok(())
}

pub fn entry() {
    let args: Vec<String> = env::args().collect();
    let Some(sep_idx) = args.iter().position(|a| a == "--") else {
        eprintln!("usage: hz-sandbox-exec -- <program> [args...]");
        std::process::exit(2);
    };
    let idx = sep_idx + 1;
    if idx >= args.len() {
        eprintln!("hz-sandbox-exec: missing program after --");
        std::process::exit(2);
    }
    let program = &args[idx];
    if CString::new(program.as_str()).is_err() {
        eprintln!("hz-sandbox-exec: program name contains NUL");
        std::process::exit(2);
    }
    let mut cmd = Command::new(program);
    cmd.args(&args[idx + 1..]);
    unsafe {
        cmd.pre_exec(|| pre_exec_confine());
    }
    let err = cmd.exec();
    eprintln!("hz-sandbox-exec: exec {}: {}", program, err);
    std::process::exit(1);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn landlock_handled_access_fs_masks_by_abi() {
        let abi1 = handled_access_fs_for_abi(1);
        assert_eq!(abi1 & LANDLOCK_ACCESS_FS_REFER, 0);
        assert_eq!(abi1 & LANDLOCK_ACCESS_FS_TRUNCATE, 0);

        let abi2 = handled_access_fs_for_abi(2);
        assert_ne!(abi2 & LANDLOCK_ACCESS_FS_REFER, 0);
        assert_eq!(abi2 & LANDLOCK_ACCESS_FS_TRUNCATE, 0);

        let abi3 = handled_access_fs_for_abi(3);
        assert_ne!(abi3 & LANDLOCK_ACCESS_FS_REFER, 0);
        assert_ne!(abi3 & LANDLOCK_ACCESS_FS_TRUNCATE, 0);
        assert_eq!(abi3, HANDLED_ACCESS_FS);
    }

    #[test]
    fn seccomp_denylist_rejects_x32_and_blocks_added_syscalls() {
        let filters = build_seccomp_denylist_filters();
        let deny_idx = filters.len() - 1;
        assert_eq!(
            filters[deny_idx].k,
            SECCOMP_RET_ERRNO | (libc::EPERM as u32)
        );
        assert_eq!(filters[deny_idx - 1].k, SECCOMP_RET_ALLOW);

        #[cfg(target_arch = "x86_64")]
        {
            // Confirm x32 bit check jumps to deny_idx.
            let x32_check = filters
                .iter()
                .enumerate()
                .find(|(_, f)| f.code == (BPF_JMP | BPF_JGE | BPF_K) && f.k == X32_SYSCALL_BIT)
                .expect("x32 syscall bit check missing");
            assert_eq!(x32_check.0 + 1 + x32_check.1.jt as usize, deny_idx);

            for expected_nr in [
                101u32, 155, 165, 246, 272, 304, 310, 311, 320, 321, 323, 425, 426, 427,
            ] {
                let found = filters
                    .iter()
                    .enumerate()
                    .find(|(_, f)| f.code == (BPF_JMP | BPF_JEQ | BPF_K) && f.k == expected_nr)
                    .unwrap_or_else(|| panic!("missing denylist rule for syscall {expected_nr}"));
                assert_eq!(found.0 + 1 + found.1.jt as usize, deny_idx);
            }
        }

        #[cfg(target_arch = "aarch64")]
        {
            for expected_nr in [
                40u32, 41, 97, 104, 117, 265, 270, 271, 280, 282, 294, 425, 426, 427,
            ] {
                let found = filters
                    .iter()
                    .enumerate()
                    .find(|(_, f)| f.code == (BPF_JMP | BPF_JEQ | BPF_K) && f.k == expected_nr)
                    .unwrap_or_else(|| panic!("missing denylist rule for syscall {expected_nr}"));
                assert_eq!(found.0 + 1 + found.1.jt as usize, deny_idx);
            }
        }

        // Confirm clone(CLONE_NEWUSER) conditional block jumps to deny_idx.
        let clone_jset = filters
            .iter()
            .enumerate()
            .find(|(_, f)| f.code == (BPF_JMP | BPF_JSET | BPF_K) && f.k == CLONE_NEWUSER_FLAG)
            .expect("clone(CLONE_NEWUSER) JSET check missing");
        assert_eq!(clone_jset.0 + 1 + clone_jset.1.jt as usize, deny_idx);
    }

    #[test]
    fn fs_mode_fails_closed_on_unknown_values() {
        assert_eq!(parse_fs_mode(None).unwrap(), FsMode::WorkspaceWrite);
        assert_eq!(parse_fs_mode(Some("read-only")).unwrap(), FsMode::ReadOnly);
        assert_eq!(parse_fs_mode(Some("workspace-write")).unwrap(), FsMode::WorkspaceWrite);
        assert!(parse_fs_mode(Some("")).is_err());
        assert!(parse_fs_mode(Some("danger-full-access")).is_err());
        assert!(parse_fs_mode(Some("bogus")).is_err());
    }

    #[test]
    fn resolve_ro_paths_includes_mandatory_workspace_protections() {
        let dir = std::env::temp_dir().join(format!(
            "hz-sbx-mandatory-ro-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join(".git/hooks")).unwrap();
        std::fs::write(dir.join(".git/config"), "[core]\n").unwrap();
        std::fs::write(dir.join(".mcp.json"), "{}\n").unwrap();
        std::fs::create_dir_all(dir.join(".vscode")).unwrap();

        let canon = dir.canonicalize().unwrap();
        let ro = resolve_ro_paths(&canon);
        assert!(ro.contains(&canon.join(".git/hooks")));
        assert!(ro.contains(&canon.join(".git/config")));
        assert!(ro.contains(&canon.join(".mcp.json")));
        assert!(ro.contains(&canon.join(".vscode")));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn landlock_handled_access_net_only_set_when_child_net_denied() {
        assert_eq!(handled_access_net_for_abi(3, true), 0);
        assert_eq!(handled_access_net_for_abi(3, false), 0);
        assert_eq!(handled_access_net_for_abi(4, true), HANDLED_ACCESS_NET);
        assert_eq!(handled_access_net_for_abi(4, false), 0);
        assert_eq!(handled_access_net_for_abi(5, true), HANDLED_ACCESS_NET);
        assert_eq!(handled_access_net_for_abi(5, false), 0);
    }
}
