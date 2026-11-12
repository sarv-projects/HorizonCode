//! hz-sandbox-exec — reduced portable confinement before exec (docs/33 §5.3).
//!
//! Order: `PR_SET_NO_NEW_PRIVS` → rlimits → unprivileged user+net namespace
//! (network-off) → seccomp deny-list → Landlock FS (+ TCP net when ABI≥4) → exec.
//!
//! Landlock: `HZ_SANDBOX_FS_ROOT` (default `.`) is the workspace fence;
//! `HZ_SANDBOX_FS_MODE=read-only|workspace-write` (default workspace-write)
//! chooses RO vs RW access on that root;
//! common system prefixes are read+exec so interpreters can start. Fails closed
//! if Landlock cannot be applied on this host.

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
const SECCOMP_RET_ALLOW: u32 = 0x7fff0000;
const SECCOMP_RET_ERRNO: u32 = 0x00050000;

const BPF_LD: u16 = 0x00;
const BPF_W: u16 = 0x00;
const BPF_ABS: u16 = 0x20;
const BPF_JMP: u16 = 0x05;
const BPF_JEQ: u16 = 0x10;
const BPF_K: u16 = 0x00;
const BPF_RET: u16 = 0x06;

#[cfg(target_arch = "x86_64")]
const SYS_LANDLOCK_CREATE_RULESET: i64 = 444;
#[cfg(target_arch = "x86_64")]
const SYS_LANDLOCK_ADD_RULE: i64 = 445;
#[cfg(target_arch = "x86_64")]
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
const DENY_SYSCALLS: &[i64] = &[101, 165, 321, 246]; // ptrace, mount, bpf, kexec_load
#[cfg(target_arch = "aarch64")]
const DENY_SYSCALLS: &[i64] = &[117, 40, 280, 104];

fn install_seccomp_denylist() -> io::Result<()> {
    const OFF_NR: u32 = 0;
    const OFF_ARCH: u32 = 4;

    let mut filters: Vec<SockFilter> = Vec::new();
    filters.push(stmt(BPF_LD | BPF_W | BPF_ABS, OFF_ARCH));
    filters.push(jump(
        BPF_JMP | BPF_JEQ | BPF_K,
        AUDIT_ARCH_NATIVE,
        1,
        0,
    ));
    filters.push(stmt(BPF_RET | BPF_K, SECCOMP_RET_ALLOW));
    filters.push(stmt(BPF_LD | BPF_W | BPF_ABS, OFF_NR));
    let deny_pos = filters.len() + DENY_SYSCALLS.len() + 1;
    for &nr in DENY_SYSCALLS.iter() {
        let dist = deny_pos - filters.len() - 1;
        filters.push(jump(
            BPF_JMP | BPF_JEQ | BPF_K,
            nr as u32,
            dist as u8,
            0,
        ));
    }
    filters.push(stmt(BPF_RET | BPF_K, SECCOMP_RET_ALLOW));
    filters.push(stmt(
        BPF_RET | BPF_K,
        SECCOMP_RET_ERRNO | (libc::EPERM as u32),
    ));

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

fn isolate_network() -> io::Result<()> {
    let uid = unsafe { libc::getuid() };
    let gid = unsafe { libc::getgid() };
    let flags = libc::CLONE_NEWUSER | libc::CLONE_NEWNET;
    if unsafe { libc::unshare(flags) } != 0 {
        return Err(io::Error::last_os_error());
    }
    let _ = write_proc("/proc/self/setgroups", "deny\n");
    write_proc("/proc/self/uid_map", &format!("0 {uid} 1\n"))?;
    write_proc("/proc/self/gid_map", &format!("0 {gid} 1\n"))?;
    Ok(())
}

#[cfg(target_arch = "x86_64")]
fn landlock_abi_version() -> i64 {
    let ret: i64;
    unsafe {
        std::arch::asm!(
            "syscall",
            inlateout("rax") SYS_LANDLOCK_CREATE_RULESET => ret,
            in("rdi") 0u64,
            in("rsi") 0u64,
            in("rdx") LANDLOCK_CREATE_RULESET_VERSION,
            out("rcx") _,
            out("r11") _,
            options(nostack),
        );
    }
    ret
}

#[cfg(target_arch = "x86_64")]
fn landlock_create_ruleset() -> io::Result<RawFd> {
    let abi = landlock_abi_version();
    let ret: i64;
    if abi >= 4 {
        let attr = LandlockRulesetAttrV4 {
            handled_access_fs: HANDLED_ACCESS_FS,
            handled_access_net: HANDLED_ACCESS_NET,
        };
        unsafe {
            std::arch::asm!(
                "syscall",
                inlateout("rax") SYS_LANDLOCK_CREATE_RULESET => ret,
                in("rdi") &attr as *const _ as u64,
                in("rsi") std::mem::size_of::<LandlockRulesetAttrV4>() as u64,
                in("rdx") 0u64,
                out("rcx") _,
                out("r11") _,
                options(nostack),
            );
        }
    } else {
        let attr = LandlockRulesetAttr {
            handled_access_fs: HANDLED_ACCESS_FS,
        };
        unsafe {
            std::arch::asm!(
                "syscall",
                inlateout("rax") SYS_LANDLOCK_CREATE_RULESET => ret,
                in("rdi") &attr as *const _ as u64,
                in("rsi") std::mem::size_of::<LandlockRulesetAttr>() as u64,
                in("rdx") 0u64,
                out("rcx") _,
                out("r11") _,
                options(nostack),
            );
        }
    }
    if ret < 0 {
        return Err(io::Error::from_raw_os_error((-ret) as i32));
    }
    Ok(ret as RawFd)
}

#[cfg(target_arch = "x86_64")]
fn landlock_add_path(ruleset: RawFd, path: &Path, access: u64) -> io::Result<()> {
    let file = OpenOptions::new().read(true).custom_flags(libc::O_PATH).open(path)?;
    let attr = LandlockPathBeneathAttr {
        allowed_access: access,
        parent_fd: file.as_raw_fd(),
    };
    let ret: i64;
    unsafe {
        std::arch::asm!(
            "syscall",
            inlateout("rax") SYS_LANDLOCK_ADD_RULE => ret,
            in("rdi") ruleset as u64,
            in("rsi") LANDLOCK_RULE_PATH_BENEATH as u64,
            in("rdx") &attr as *const _ as u64,
            in("r10") 0u64,
            out("rcx") _,
            out("r11") _,
            options(nostack),
        );
    }
    if ret < 0 {
        return Err(io::Error::from_raw_os_error((-ret) as i32));
    }
    Ok(())
}

#[cfg(target_arch = "x86_64")]
fn landlock_restrict_self(ruleset: RawFd) -> io::Result<()> {
    let ret: i64;
    unsafe {
        std::arch::asm!(
            "syscall",
            inlateout("rax") SYS_LANDLOCK_RESTRICT_SELF => ret,
            in("rdi") ruleset as u64,
            in("rsi") 0u64,
            out("rcx") _,
            out("r11") _,
            options(nostack),
        );
    }
    if ret < 0 {
        return Err(io::Error::from_raw_os_error((-ret) as i32));
    }
    Ok(())
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum FsMode {
    ReadOnly,
    WorkspaceWrite,
}

fn resolve_fs_mode() -> FsMode {
    match env::var("HZ_SANDBOX_FS_MODE").ok().as_deref() {
        Some("read-only") | Some("readonly") | Some("ro") => FsMode::ReadOnly,
        _ => FsMode::WorkspaceWrite,
    }
}

#[cfg(not(target_arch = "x86_64"))]
fn apply_landlock(_fs_root: &Path, _mode: FsMode) -> io::Result<()> {
    Err(io::Error::new(
        io::ErrorKind::Unsupported,
        "Landlock apply is only implemented on x86_64",
    ))
}

#[cfg(target_arch = "x86_64")]
fn apply_landlock(fs_root: &Path, mode: FsMode) -> io::Result<()> {
    // ABI ≥ 4: handled_access_net is set with no LANDLOCK_RULE_NET_PORT allows,
    // so TCP bind/connect are denied (complements userns+netns network-off).
    let ruleset = landlock_create_ruleset()?;
    let root_access = match mode {
        FsMode::ReadOnly => ACCESS_RO,
        FsMode::WorkspaceWrite => ACCESS_RW,
    };
    landlock_add_path(ruleset, fs_root, root_access)?;
    // System prefixes so dynamic loaders / interpreters can run.
    // In read-only mode keep /tmp and /dev RO too so the child cannot stage
    // writes outside the workspace via those prefixes.
    for prefix in [
        "/usr", "/bin", "/sbin", "/lib", "/lib64", "/etc", "/dev", "/proc", "/tmp",
    ] {
        let p = Path::new(prefix);
        if p.exists() {
            let access = if mode == FsMode::WorkspaceWrite && (prefix == "/tmp" || prefix == "/dev")
            {
                ACCESS_RW
            } else {
                ACCESS_RO
            };
            let _ = landlock_add_path(ruleset, p, access);
        }
    }
    landlock_restrict_self(ruleset)?;
    unsafe {
        libc::close(ruleset);
    }
    Ok(())
}

fn resolve_fs_root() -> PathBuf {
    let raw = env::var("HZ_SANDBOX_FS_ROOT").unwrap_or_else(|_| ".".to_string());
    PathBuf::from(raw)
        .canonicalize()
        .unwrap_or_else(|_| PathBuf::from("."))
}

fn pre_exec_confine() -> io::Result<()> {
    if unsafe { libc::prctl(libc::PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) } != 0 {
        return Err(io::Error::last_os_error());
    }
    apply_rlimits()?;
    isolate_network()?;
    install_seccomp_denylist()?;
    apply_landlock(&resolve_fs_root(), resolve_fs_mode())?;
    Ok(())
}

fn main() {
    let args: Vec<String> = env::args().collect();
    let sep = args.iter().position(|a| a == "--");
    if sep.is_none() || sep == Some(args.len() - 1) {
        eprintln!("usage: hz-sandbox-exec -- <program> [args...]");
        std::process::exit(2);
    }
    let idx = sep.unwrap() + 1;
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
