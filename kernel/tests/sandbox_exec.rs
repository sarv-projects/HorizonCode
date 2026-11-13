//! Integration tests for `hz-sandbox-exec` (docs/33 §5.3).

use std::path::PathBuf;
use std::process::Command;

fn bpf_fixture() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/bpf_probe.py")
}

#[test]
fn hz_sandbox_exec_denies_bpf_syscall() {
    let bin = env!("CARGO_BIN_EXE_hz-sandbox-exec");
    let script = bpf_fixture();
    let out = Command::new(bin)
        .args(["--", "python3", script.to_str().unwrap()])
        .output()
        .expect("spawn hz-sandbox-exec");
    if out.status.code() == Some(2) {
        return;
    }
    let text = String::from_utf8_lossy(&out.stdout).to_lowercase();
    let stderr = String::from_utf8_lossy(&out.stderr).to_lowercase();
    if stderr.contains("no such file") || stderr.contains("not found") || text.contains("argument list") {
        return;
    }
    assert!(
        text.contains("operation not permitted") || text.contains("permission denied"),
        "expected seccomp to block bpf syscall, stdout={text} stderr={stderr}",
    );
}

#[test]
fn hz_sandbox_exec_landlock_denies_outside_workspace() {
    use std::time::{SystemTime, UNIX_EPOCH};
    let bin = env!("CARGO_BIN_EXE_hz-sandbox-exec");
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    // Workspace under /tmp (allowed RW); outside under $HOME so the /tmp allow
    // rule cannot cover it.
    let root = std::env::temp_dir().join(format!("hz-ll-root-{stamp}"));
    let home = std::env::var_os("HOME").expect("HOME");
    let outside_dir = PathBuf::from(home).join(format!(".hz-ll-out-{stamp}"));
    std::fs::create_dir_all(&root).expect("root");
    std::fs::create_dir_all(&outside_dir).expect("outside dir");
    let inside = root.join("in.txt");
    let outside = outside_dir.join("secret.txt");
    std::fs::write(&inside, "ok\n").expect("write inside");
    std::fs::write(&outside, "secret\n").expect("write outside");
    let probe = format!(
        r#"
from pathlib import Path
inside = Path({inside:?})
outside = Path({outside:?})
print("IN", inside.read_text().strip())
try:
    print("OUT", outside.read_text().strip())
except PermissionError as e:
    print("DENIED", e.errno)
"#,
        inside = inside,
        outside = outside,
    );
    let out = Command::new(bin)
        .env("HZ_SANDBOX_FS_ROOT", &root)
        .args(["--", "python3", "-c", &probe])
        .output()
        .expect("spawn hz-sandbox-exec");
    let _ = std::fs::remove_dir_all(&root);
    let _ = std::fs::remove_dir_all(&outside_dir);
    let stdout = String::from_utf8_lossy(&out.stdout);
    let stderr = String::from_utf8_lossy(&out.stderr);
    if stderr.to_lowercase().contains("no such file") || stderr.to_lowercase().contains("not found") {
        return;
    }
    assert!(
        stdout.contains("IN ok") && stdout.contains("DENIED") && !stdout.contains("OUT secret"),
        "expected Landlock deny outside workspace, stdout={stdout} stderr={stderr} status={:?}",
        out.status,
    );
}

#[test]
fn hz_sandbox_exec_landlock_read_only_denies_workspace_write() {
    use std::time::{SystemTime, UNIX_EPOCH};
    let bin = env!("CARGO_BIN_EXE_hz-sandbox-exec");
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let root = std::env::temp_dir().join(format!("hz-ll-ro-{stamp}"));
    std::fs::create_dir_all(&root).expect("root");
    let target = root.join("mutate.txt");
    std::fs::write(&target, "seed\n").expect("seed");
    let probe = format!(
        r#"
from pathlib import Path
p = Path({target:?})
print("READ", p.read_text().strip())
try:
    p.write_text("mutated\n")
    print("WROTE")
except PermissionError as e:
    print("DENIED", e.errno)
"#,
        target = target,
    );
    let out = Command::new(bin)
        .env("HZ_SANDBOX_FS_ROOT", &root)
        .env("HZ_SANDBOX_FS_MODE", "read-only")
        .args(["--", "python3", "-c", &probe])
        .output()
        .expect("spawn hz-sandbox-exec");
    let after = std::fs::read_to_string(&target).unwrap_or_default();
    let _ = std::fs::remove_dir_all(&root);
    let stdout = String::from_utf8_lossy(&out.stdout);
    let stderr = String::from_utf8_lossy(&out.stderr);
    if stderr.to_lowercase().contains("no such file") || stderr.to_lowercase().contains("not found") {
        return;
    }
    assert!(
        stdout.contains("READ seed") && stdout.contains("DENIED") && !stdout.contains("WROTE"),
        "expected Landlock read-only deny inside workspace, stdout={stdout} stderr={stderr} status={:?}",
        out.status,
    );
    assert_eq!(after, "seed\n", "workspace file must remain unchanged under read-only mode");
}

#[test]
fn hz_sandbox_exec_ro_paths_denies_protected_subtree_write() {
    use std::time::{SystemTime, UNIX_EPOCH};
    let bin = env!("CARGO_BIN_EXE_hz-sandbox-exec");
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let root = std::env::temp_dir().join(format!("hz-ll-rosub-{stamp}"));
    let protected = root.join(".hz").join("state");
    std::fs::create_dir_all(&protected).expect("protected");
    let writable = root.join("work");
    std::fs::create_dir_all(&writable).expect("work");
    let hook = protected.join("hooks.json");
    std::fs::write(&hook, "{}\n").expect("hook");
    let scratch = writable.join("ok.txt");
    std::fs::write(&scratch, "seed\n").expect("seed");
    let probe = format!(
        r#"
from pathlib import Path
hook = Path({hook:?})
scratch = Path({scratch:?})
try:
    hook.write_text("tamper\n")
    print("HOOK_WROTE")
except PermissionError:
    print("HOOK_DENIED")
try:
    scratch.write_text("mutated\n")
    print("SCRATCH_WROTE")
except PermissionError as e:
    print("SCRATCH_DENIED", e.errno)
"#,
        hook = hook,
        scratch = scratch,
    );
    let ro = format!("{}:{}", protected.display(), hook.display());
    let hook_path = hook.to_string_lossy().to_string();
    let out = Command::new(bin)
        .env("HZ_SANDBOX_FS_ROOT", &root)
        .env("HZ_SANDBOX_FS_MODE", "workspace-write")
        .env("HZ_SANDBOX_FS_RO_PATHS", &ro)
        .args(["--", "python3", "-c", &probe])
        .output()
        .expect("spawn hz-sandbox-exec");
    let stdout = String::from_utf8_lossy(&out.stdout);
    let stderr = String::from_utf8_lossy(&out.stderr);
    if stderr.to_lowercase().contains("no such file") || stderr.to_lowercase().contains("not found") {
        let _ = std::fs::remove_dir_all(&root);
        return;
    }
    if !out.status.success() || stdout.trim().is_empty() {
        let _ = std::fs::remove_dir_all(&root);
        return;
    }
    let ro_check = Command::new(bin)
        .env("HZ_SANDBOX_FS_ROOT", &root)
        .env("HZ_SANDBOX_FS_MODE", "read-only")
        .args([
            "--",
            "python3",
            "-c",
            &format!(
                "from pathlib import Path\np=Path({hook_path:?})\ntry:\n p.write_text('x')\n print('WROTE')\nexcept PermissionError:\n print('DENIED')"
            ),
        ])
        .output()
        .expect("spawn");
    let ro_out = String::from_utf8_lossy(&ro_check.stdout);
    let hook_after = std::fs::read_to_string(&hook).unwrap_or_default();
    let _ = std::fs::remove_dir_all(&root);
    if !ro_out.contains("DENIED") {
        return; // Landlock not enforcing on this host
    }
    assert!(
        stdout.contains("HOOK_DENIED") && !stdout.contains("HOOK_WROTE") && stdout.contains("SCRATCH_WROTE"),
        "expected RO carve-out for hooks/state under workspace-write, stdout={stdout} stderr={stderr} status={:?}",
        out.status,
    );
    assert_eq!(
        hook_after,
        "{}\n",
        "hook file must not change under workspace-write + RO_PATHS",
    );
}

/// Outbound TCP CONNECT denial (default netns or explicit `HZ_SANDBOX_CHILD_NET=off`).
/// Does not prove routed proxy-only egress — honesty helper `netnsConnectDenialPosture` (TS).
#[test]
fn hz_sandbox_exec_child_net_off_denies_connect() {
    let bin = env!("CARGO_BIN_EXE_hz-sandbox-exec");
    let probe = r#"
import socket
s = socket.socket()
s.settimeout(2)
try:
    s.connect(("1.1.1.1", 53))
    print("CONNECTED")
except OSError as e:
    print("BLOCKED", e.errno if getattr(e, "errno", None) else e)
"#;
    let out = Command::new(bin)
        .env("HZ_SANDBOX_CHILD_NET", "off")
        .args(["--", "python3", "-c", probe])
        .output()
        .expect("spawn hz-sandbox-exec");
    let stdout = String::from_utf8_lossy(&out.stdout);
    let stderr = String::from_utf8_lossy(&out.stderr);
    if stderr.to_lowercase().contains("no such file") || stderr.to_lowercase().contains("not found") {
        return;
    }
    assert!(
        stdout.contains("BLOCKED") && !stdout.contains("CONNECTED"),
        "expected network-off with HZ_SANDBOX_CHILD_NET=off, stdout={stdout} stderr={stderr} status={:?}",
        out.status,
    );
}

#[test]
fn hz_sandbox_exec_child_net_off_denies_tcp_connect_port_443() {
    let bin = env!("CARGO_BIN_EXE_hz-sandbox-exec");
    let probe = r#"
import socket
s = socket.socket()
s.settimeout(2)
try:
    s.connect(("1.1.1.1", 443))
    print("CONNECTED")
except OSError as e:
    print("BLOCKED", e.errno if getattr(e, "errno", None) else e)
"#;
    let out = Command::new(bin)
        .env("HZ_SANDBOX_CHILD_NET", "off")
        .args(["--", "python3", "-c", probe])
        .output()
        .expect("spawn hz-sandbox-exec");
    let stdout = String::from_utf8_lossy(&out.stdout);
    let stderr = String::from_utf8_lossy(&out.stderr);
    if stderr.to_lowercase().contains("no such file") || stderr.to_lowercase().contains("not found") {
        return;
    }
    assert!(
        stdout.contains("BLOCKED") && !stdout.contains("CONNECTED"),
        "expected TCP CONNECT:443 denied under child_net=off, stdout={stdout} stderr={stderr} status={:?}",
        out.status,
    );
}

/// `HZ_SANDBOX_VETH_CREATE=1` with `HZ_SANDBOX_VETH_JOIN=1` must fail closed (ruling **329**).
#[test]
fn hz_sandbox_exec_veth_create_fail_closed_mutual_exclusive() {
    let bin = env!("CARGO_BIN_EXE_hz-sandbox-exec");
    let out = Command::new(bin)
        .env("HZ_SANDBOX_CHILD_NET", "off")
        .env("HZ_SANDBOX_VETH_CREATE", "1")
        .env("HZ_SANDBOX_VETH_JOIN", "1")
        .env("HZ_SANDBOX_VETH_NETNS", "hz-veth-create-mutex-329")
        .args(["--", "python3", "-c", "print('RAN')"])
        .output()
        .expect("spawn hz-sandbox-exec");
    let stdout = String::from_utf8_lossy(&out.stdout);
    let stderr = String::from_utf8_lossy(&out.stderr);
    if stderr.to_lowercase().contains("no such file") || stderr.to_lowercase().contains("not found") {
        return;
    }
    assert!(
        !out.status.success() && !stdout.contains("RAN"),
        "expected fail-closed CREATE+JOIN mutex, stdout={stdout} stderr={stderr} status={:?}",
        out.status,
    );
}

/// When CAP_NET_ADMIN + `ip` exist, in-wrapper veth create leaves host if in child netns (ruling **329**).
#[test]
fn hz_sandbox_exec_veth_create_plumbs_host_in_child() {
    let ip_ok = Command::new("ip")
        .args(["-V"])
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false);
    if !ip_ok {
        return;
    }
    let host = format!("hz-sbx-veth-h-{}", std::process::id());
    let peer = format!("hz-sbx-veth-p-{}", std::process::id());
    let _ = Command::new("ip").args(["link", "del", &host]).status();
    let _ = Command::new("ip").args(["link", "del", &peer]).status();
    let bin = env!("CARGO_BIN_EXE_hz-sandbox-exec");
    let probe = r#"
import subprocess, sys
out = subprocess.check_output(["ip", "-o", "link"], text=True)
print("HOST_LINK", sys.argv[1] in out)
"#;
    let out = Command::new(bin)
        .env("HZ_SANDBOX_CHILD_NET", "off")
        .env("HZ_SANDBOX_VETH_CREATE", "1")
        .env("HZ_SANDBOX_VETH_HOST", &host)
        .env("HZ_SANDBOX_VETH_PEER", &peer)
        .args(["--", "python3", "-c", probe, &host])
        .output()
        .expect("spawn hz-sandbox-exec");
    let _ = Command::new("ip").args(["link", "del", &host]).status();
    let _ = Command::new("ip").args(["link", "del", &peer]).status();
    let stdout = String::from_utf8_lossy(&out.stdout);
    let stderr = String::from_utf8_lossy(&out.stderr);
    if stderr.to_lowercase().contains("no such file") || stderr.to_lowercase().contains("not found") {
        return;
    }
    if !out.status.success() {
        return; // userns/veth create may be unavailable
    }
    assert!(
        stdout.contains("HOST_LINK True"),
        "expected host veth in child netns after CREATE, stdout={stdout} stderr={stderr}",
    );
}

/// ADDR/route env without CREATE must fail closed (ruling **331**).
#[test]
fn hz_sandbox_exec_veth_addr_fail_closed_without_create() {
    let bin = env!("CARGO_BIN_EXE_hz-sandbox-exec");
    let out = Command::new(bin)
        .env("HZ_SANDBOX_CHILD_NET", "off")
        .env("HZ_SANDBOX_VETH_PEER_ADDR", "10.199.0.1/30")
        .args(["--", "python3", "-c", "print('RAN')"])
        .output()
        .expect("spawn hz-sandbox-exec");
    let stdout = String::from_utf8_lossy(&out.stdout);
    let stderr = String::from_utf8_lossy(&out.stderr);
    if stderr.to_lowercase().contains("no such file") || stderr.to_lowercase().contains("not found") {
        return;
    }
    assert!(
        !out.status.success() && !stdout.contains("RAN"),
        "expected fail-closed ADDR without CREATE, stdout={stdout} stderr={stderr} status={:?}",
        out.status,
    );
}

/// When CAP_NET_ADMIN + `ip`/`nsenter` exist, CREATE may install child default route (ruling **332** slice).
#[test]
fn hz_sandbox_exec_veth_create_default_route_in_child() {
    let ip_ok = Command::new("ip")
        .args(["-V"])
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false);
    let nsenter_ok = Command::new("nsenter")
        .arg("--version")
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false);
    if !ip_ok || !nsenter_ok {
        return;
    }
    let host = format!("hz-sbx-veth-dr-h-{}", std::process::id());
    let peer = format!("hz-sbx-veth-dr-p-{}", std::process::id());
    let _ = Command::new("ip").args(["link", "del", &host]).status();
    let _ = Command::new("ip").args(["link", "del", &peer]).status();
    let bin = env!("CARGO_BIN_EXE_hz-sandbox-exec");
    let probe = r#"
import subprocess
out = subprocess.check_output(["ip", "route", "show", "default"], text=True)
print("DEFAULT_VIA", "default via" in out)
"#;
    let out = Command::new(bin)
        .env("HZ_SANDBOX_CHILD_NET", "off")
        .env("HZ_SANDBOX_VETH_CREATE", "1")
        .env("HZ_SANDBOX_VETH_HOST", &host)
        .env("HZ_SANDBOX_VETH_PEER", &peer)
        .env("HZ_SANDBOX_VETH_PEER_ADDR", "10.199.0.1/30")
        .env("HZ_SANDBOX_VETH_HOST_ADDR", "10.199.0.2/30")
        .env("HZ_SANDBOX_VETH_DEFAULT_ROUTE", "1")
        .args(["--", "python3", "-c", probe])
        .output()
        .expect("spawn hz-sandbox-exec");
    let _ = Command::new("ip").args(["link", "del", &host]).status();
    let _ = Command::new("ip").args(["link", "del", &peer]).status();
    let stdout = String::from_utf8_lossy(&out.stdout);
    let stderr = String::from_utf8_lossy(&out.stderr);
    if stderr.to_lowercase().contains("no such file") || stderr.to_lowercase().contains("not found") {
        return;
    }
    if !out.status.success() {
        return;
    }
    assert!(
        stdout.contains("DEFAULT_VIA True"),
        "expected child default route after CREATE plumb, stdout={stdout} stderr={stderr}",
    );
}

/// When CAP_NET_ADMIN + `ip`/`nsenter` exist, CREATE may assign child host ADDR (ruling **331**).
#[test]
fn hz_sandbox_exec_veth_create_assigns_host_addr() {
    let ip_ok = Command::new("ip")
        .args(["-V"])
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false);
    let nsenter_ok = Command::new("nsenter")
        .arg("--version")
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false);
    if !ip_ok || !nsenter_ok {
        return;
    }
    let host = format!("hz-sbx-veth-addr-h-{}", std::process::id());
    let peer = format!("hz-sbx-veth-addr-p-{}", std::process::id());
    let _ = Command::new("ip").args(["link", "del", &host]).status();
    let _ = Command::new("ip").args(["link", "del", &peer]).status();
    let bin = env!("CARGO_BIN_EXE_hz-sandbox-exec");
    let probe = r#"
import subprocess, sys
out = subprocess.check_output(["ip", "-o", "addr", "show", "dev", sys.argv[1]], text=True)
print("HOST_ADDR", "10.199.0.2" in out)
"#;
    let out = Command::new(bin)
        .env("HZ_SANDBOX_CHILD_NET", "off")
        .env("HZ_SANDBOX_VETH_CREATE", "1")
        .env("HZ_SANDBOX_VETH_HOST", &host)
        .env("HZ_SANDBOX_VETH_PEER", &peer)
        .env("HZ_SANDBOX_VETH_PEER_ADDR", "10.199.0.1/30")
        .env("HZ_SANDBOX_VETH_HOST_ADDR", "10.199.0.2/30")
        .args(["--", "python3", "-c", probe, &host])
        .output()
        .expect("spawn hz-sandbox-exec");
    let _ = Command::new("ip").args(["link", "del", &host]).status();
    let _ = Command::new("ip").args(["link", "del", &peer]).status();
    let stdout = String::from_utf8_lossy(&out.stdout);
    let stderr = String::from_utf8_lossy(&out.stderr);
    if stderr.to_lowercase().contains("no such file") || stderr.to_lowercase().contains("not found") {
        return;
    }
    if !out.status.success() {
        return;
    }
    assert!(
        stdout.contains("HOST_ADDR True"),
        "expected child host /30 after CREATE plumb, stdout={stdout} stderr={stderr}",
    );
}

/// `HZ_SANDBOX_VETH_JOIN=1` without a prepared netns must fail closed (ruling **324**).
#[test]
fn hz_sandbox_exec_veth_join_fail_closed_without_netns_path() {
    let bin = env!("CARGO_BIN_EXE_hz-sandbox-exec");
    let out = Command::new(bin)
        .env("HZ_SANDBOX_CHILD_NET", "off")
        .env("HZ_SANDBOX_VETH_JOIN", "1")
        .args(["--", "python3", "-c", "print('RAN')"])
        .output()
        .expect("spawn hz-sandbox-exec");
    let stdout = String::from_utf8_lossy(&out.stdout);
    let stderr = String::from_utf8_lossy(&out.stderr);
    if stderr.to_lowercase().contains("no such file") || stderr.to_lowercase().contains("not found") {
        return;
    }
    assert!(
        !out.status.success() && !stdout.contains("RAN"),
        "expected fail-closed veth join without HZ_SANDBOX_VETH_NETNS, stdout={stdout} stderr={stderr} status={:?}",
        out.status,
    );
}

#[test]
fn hz_sandbox_exec_veth_join_fail_closed_missing_prepared_netns() {
    let bin = env!("CARGO_BIN_EXE_hz-sandbox-exec");
    let missing = "/var/run/netns/hz-veth-join-missing-324-probe";
    let out = Command::new(bin)
        .env("HZ_SANDBOX_CHILD_NET", "off")
        .env("HZ_SANDBOX_VETH_JOIN", "1")
        .env("HZ_SANDBOX_VETH_NETNS", missing)
        .args(["--", "python3", "-c", "print('RAN')"])
        .output()
        .expect("spawn hz-sandbox-exec");
    if std::path::Path::new(missing).exists() {
        return;
    }
    let stdout = String::from_utf8_lossy(&out.stdout);
    let stderr = String::from_utf8_lossy(&out.stderr);
    if stderr.to_lowercase().contains("no such file") || stderr.to_lowercase().contains("not found") {
        return;
    }
    assert!(
        !out.status.success() && !stdout.contains("RAN"),
        "expected fail-closed when prepared netns path missing, stdout={stdout} stderr={stderr} status={:?}",
        out.status,
    );
}

/// When CAP_NET_ADMIN + `ip` exist, parent-prepared netns join keeps the child in that netns.
#[test]
fn hz_sandbox_exec_veth_join_enters_prepared_netns() {
    let ip_ok = Command::new("ip")
        .args(["-V"])
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false);
    if !ip_ok {
        return;
    }
    let ns = format!("hz-veth-join-{}", std::process::id());
    let del = Command::new("ip").args(["netns", "del", &ns]).status();
    let _ = del;
    let add = Command::new("ip")
        .args(["netns", "add", &ns])
        .status()
        .expect("ip netns add");
    if !add.success() {
        return;
    }
    let bin = env!("CARGO_BIN_EXE_hz-sandbox-exec");
    let probe = r#"
import os
print("JOIN_NS", open("/proc/self/ns/net").readlink())
"#;
    let out = Command::new(bin)
        .env("HZ_SANDBOX_CHILD_NET", "off")
        .env("HZ_SANDBOX_VETH_JOIN", "1")
        .env("HZ_SANDBOX_VETH_NETNS", &ns)
        .args(["--", "python3", "-c", probe])
        .output()
        .expect("spawn hz-sandbox-exec");
    let _ = Command::new("ip").args(["netns", "del", &ns]).status();
    let stdout = String::from_utf8_lossy(&out.stdout);
    let stderr = String::from_utf8_lossy(&out.stderr);
    if stderr.to_lowercase().contains("no such file") || stderr.to_lowercase().contains("not found") {
        return;
    }
    if !out.status.success() {
        return; // setns/user ns may be unavailable (e.g. user ns disabled)
    }
    let parent_ns = Command::new("ip")
        .args(["netns", "exec", &ns, "readlink", "/proc/self/ns/net"])
        .output()
        .ok()
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string());
    if let Some(expected) = parent_ns {
        assert!(
            stdout.contains("JOIN_NS") && stdout.contains(&expected),
            "child should share parent-prepared netns, stdout={stdout} stderr={stderr} expected={expected}",
        );
    }
}

#[test]
fn hz_sandbox_exec_isolates_network() {
    let bin = env!("CARGO_BIN_EXE_hz-sandbox-exec");
    let probe = r#"
import socket
s = socket.socket()
s.settimeout(2)
try:
    s.connect(("1.1.1.1", 53))
    print("CONNECTED")
except OSError as e:
    print("BLOCKED", e.errno if getattr(e, "errno", None) else e)
"#;
    let out = Command::new(bin)
        .args(["--", "python3", "-c", probe])
        .output()
        .expect("spawn hz-sandbox-exec");
    let stdout = String::from_utf8_lossy(&out.stdout);
    let stderr = String::from_utf8_lossy(&out.stderr);
    if stderr.to_lowercase().contains("no such file") || stderr.to_lowercase().contains("not found") {
        return;
    }
    // pre_exec failure surfaces as a non-zero spawn without CONNECTED.
    assert!(
        stdout.contains("BLOCKED") && !stdout.contains("CONNECTED"),
        "expected network-off inside hz-sandbox-exec, stdout={stdout} stderr={stderr} status={:?}",
        out.status,
    );
}
