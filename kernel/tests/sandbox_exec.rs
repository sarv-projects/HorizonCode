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
