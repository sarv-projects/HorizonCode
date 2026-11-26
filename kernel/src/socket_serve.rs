//! H-29 / ruling 625: Unix-domain socket NDJSON serve so `hzk` can outlive
//! the agent runtime's stdio pipe (parent death → stdin EOF).
//!
//! H-30 / ruling 634: each fresh bind advances `hzk.epoch` and publishes it on
//! `ping.supervisorEpoch` so reattach clients detect a restarted kernel.
//!
//! CB-6 / ruling 635: exclusive `hzk.supervisor.lock` flock before bind so a
//! second live `--socket` owner fails closed without stealing the socket.
//!
//! H-30 / ruling **710**: each bind seals the running image digest in
//! `hzk.binary` for binary-upgrade honesty on reattach.
//!
//! Ruling **645**: one thread per accepted connection (second client no longer
//! hangs); `chmod 0600` on `hzk.sock`; `peer_auth` / `SO_PEERCRED` same-UID check.

use std::fs;
use std::io::{BufRead, BufReader, BufWriter, Read, Write};
use std::os::unix::fs::PermissionsExt;
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::Path;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;

/// Maximum NDJSON request line length accepted over the Unix domain socket (2 MiB).
const MAX_SOCKET_LINE_BYTES: usize = 2 * 1024 * 1024;
/// Maximum simultaneous socket client threads.
const MAX_CONCURRENT_CONNECTIONS: usize = 64;

struct ConnectionPermit {
    active: Arc<AtomicUsize>,
}

impl Drop for ConnectionPermit {
    fn drop(&mut self) {
        self.active.fetch_sub(1, Ordering::AcqRel);
    }
}

fn try_acquire_connection(
    active: &Arc<AtomicUsize>,
    max_connections: usize,
) -> Option<ConnectionPermit> {
    let mut current = active.load(Ordering::Acquire);
    loop {
        if current >= max_connections {
            return None;
        }
        match active.compare_exchange_weak(
            current,
            current + 1,
            Ordering::AcqRel,
            Ordering::Acquire,
        ) {
            Ok(_) => {
                return Some(ConnectionPermit {
                    active: Arc::clone(active),
                })
            }
            Err(actual) => current = actual,
        }
    }
}

#[derive(Debug)]
enum BoundedLineError {
    TooLong,
    InvalidUtf8(String),
    Io(String),
}

fn read_bounded_line<R: BufRead>(
    reader: &mut R,
    max_bytes: usize,
) -> Result<Option<String>, BoundedLineError> {
    let mut buf = Vec::new();
    let n = reader
        .take((max_bytes + 1) as u64)
        .read_until(b'\n', &mut buf)
        .map_err(|e| BoundedLineError::Io(e.to_string()))?;
    if n == 0 {
        return Ok(None);
    }
    if buf.len() > max_bytes {
        return Err(BoundedLineError::TooLong);
    }
    if buf.last() == Some(&b'\n') {
        buf.pop();
        if buf.last() == Some(&b'\r') {
            buf.pop();
        }
    }
    String::from_utf8(buf)
        .map(Some)
        .map_err(|e| BoundedLineError::InvalidUtf8(e.to_string()))
}

use serde_json::Value;

use crate::canon;
use crate::protocol::Kernel;
use crate::supervisor_lease::SupervisorLease;

/// Bind `socket_path`, write `<state_dir>/hzk.socket` + `hzk.pid`, and accept
/// NDJSON connections forever (one request/response line pair per line).
///
/// Caller must already hold `supervisor_lease` (CB-6 / rulings **635**/**638**).
pub fn serve_forever(
    socket_path: &Path,
    state_dir: &Path,
    kernel: Arc<Kernel>,
    supervisor_lease: SupervisorLease,
    handle_gate: Arc<Mutex<()>>,
) -> i32 {
    // Keep the exclusive lease alive for the entire accept loop.
    let _lease = supervisor_lease;
    if let Some(parent) = socket_path.parent() {
        if let Err(e) = fs::create_dir_all(parent) {
            eprintln!(
                "error: cannot create socket parent {}: {}",
                parent.display(),
                e
            );
            return 2;
        }
    }
    let _ = fs::remove_file(socket_path);
    let listener = match UnixListener::bind(socket_path) {
        Ok(l) => l,
        Err(e) => {
            eprintln!("error: cannot bind socket {}: {}", socket_path.display(), e);
            return 2;
        }
    };
    if let Err(e) = fs::set_permissions(socket_path, fs::Permissions::from_mode(0o600)) {
        eprintln!("error: cannot chmod 0600 {}: {}", socket_path.display(), e);
        return 2;
    }
    let epoch = match crate::supervisor_epoch::advance_supervisor_epoch(state_dir) {
        Ok(e) => e,
        Err(e) => {
            eprintln!("error: {}", e);
            return 2;
        }
    };
    kernel.set_supervisor_epoch(epoch);
    let binary_sha = match crate::supervisor_binary_seal::seal_detach_binary(state_dir) {
        Ok(d) => d,
        Err(e) => {
            eprintln!("error: {}", e);
            return 2;
        }
    };
    kernel.set_supervisor_binary_sha(Some(binary_sha));
    if let Err(e) = write_lease_files(state_dir, socket_path) {
        eprintln!("error: {}", e);
        return 2;
    }
    eprintln!(
        "hz-kernel: listening on {} (H-29 socket serve; H-30 epoch {}; CB-6 supervisor lease; peercred+0600; stdin independence)",
        socket_path.display(),
        epoch
    );
    // Accept is concurrent (second client can connect while the first is idle);
    // request handling stays serialized via the shared `handle_gate` from main
    // (shared with stdin compat thread) so in-process caches / OwnerLog stay coherent.
    let active_conns = Arc::new(AtomicUsize::new(0));
    for conn in listener.incoming() {
        match conn {
            Ok(stream) => {
                if let Err(e) = crate::peer_auth::authorize_same_uid_unix_stream(&stream) {
                    eprintln!("hz-kernel: socket peer refused: {}", e);
                    continue;
                }
                let Some(permit) =
                    try_acquire_connection(&active_conns, MAX_CONCURRENT_CONNECTIONS)
                else {
                    eprintln!(
                        "hz-kernel: socket peer refused: max concurrent connections ({}) reached",
                        MAX_CONCURRENT_CONNECTIONS
                    );
                    continue;
                };
                let k = Arc::clone(&kernel);
                let gate = Arc::clone(&handle_gate);
                thread::spawn(move || {
                    let _permit = permit;
                    if let Err(e) = handle_connection(stream, &k, &gate) {
                        eprintln!("hz-kernel: socket client error: {}", e);
                    }
                });
            }
            Err(e) => {
                eprintln!("hz-kernel: accept error: {}", e);
            }
        }
    }
    0
}

fn write_lease_files(state_dir: &Path, socket_path: &Path) -> Result<(), String> {
    let socket_record = state_dir.join("hzk.socket");
    let pid_record = state_dir.join("hzk.pid");
    crate::permm::write_new(&socket_record, socket_path.to_string_lossy().as_bytes())
        .map_err(|e| format!("cannot write {}: {}", socket_record.display(), e))?;
    crate::permm::write_new(&pid_record, format!("{}\n", std::process::id()).as_bytes())
        .map_err(|e| format!("cannot write {}: {}", pid_record.display(), e))?;
    Ok(())
}

fn handle_connection(
    stream: UnixStream,
    kernel: &Kernel,
    handle_gate: &Mutex<()>,
) -> Result<(), String> {
    // Split into owned reader/writer without sharing the same fd across threads
    // incorrectly: clone the stream, then use distinct ends.
    let reader_stream = stream.try_clone().map_err(|e| e.to_string())?;
    let mut reader = BufReader::new(reader_stream);
    let mut out = BufWriter::new(stream);
    loop {
        let line = match read_bounded_line(&mut reader, MAX_SOCKET_LINE_BYTES) {
            Ok(Some(line)) => line,
            Ok(None) => break,
            Err(BoundedLineError::TooLong) => {
                let response = canon::error_response(
                    Value::Null,
                    &format!(
                        "request line exceeds maximum size ({} bytes)",
                        MAX_SOCKET_LINE_BYTES
                    ),
                );
                let _ = serde_json::to_writer(&mut out, &response);
                let _ = out.write_all(b"\n");
                let _ = out.flush();
                return Err("request line exceeded maximum size".to_string());
            }
            Err(BoundedLineError::InvalidUtf8(e)) => {
                return Err(format!("invalid utf-8 in request line: {e}"));
            }
            Err(BoundedLineError::Io(e)) => return Err(e),
        };
        if line.trim().is_empty() {
            continue;
        }
        let response = {
            let _guard = handle_gate
                .lock()
                .map_err(|_| "handle gate poisoned".to_string())?;
            match serde_json::from_str::<Value>(&line) {
                Ok(request) => kernel.handle(&request),
                Err(e) => {
                    canon::error_response(Value::Null, &format!("malformed request line: {}", e))
                }
            }
        };
        serde_json::to_writer(&mut out, &response).map_err(|e| e.to_string())?;
        out.write_all(b"\n").map_err(|e| e.to_string())?;
        out.flush().map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::eventlog::AnchorConfig;
    use std::io::{BufRead, Write};
    use std::os::unix::net::UnixStream;
    use std::path::PathBuf;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn scratch(tag: &str) -> PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("hz-sock-{tag}-{nanos}"));
        fs::create_dir_all(&dir).expect("scratch dir");
        dir
    }

    #[test]
    fn socket_serve_answers_ping_after_bind() {
        let state = scratch("state");
        let sock = state.join("hzk.sock");
        let kernel = Arc::new(Kernel::new_with_anchor(&state, AnchorConfig::default()));
        let sock2 = sock.clone();
        let state2 = state.clone();
        let k2 = Arc::clone(&kernel);
        let lease = SupervisorLease::try_acquire(&state).expect("supervisor lease");
        let handle = std::thread::spawn(move || {
            serve_forever(&sock2, &state2, k2, lease, Arc::new(Mutex::new(())))
        });
        // Wait until bind + epoch + lease files are all durable.
        for _ in 0..3000 {
            if state.join("hzk.socket").exists()
                && state.join("hzk.pid").exists()
                && state.join("hzk.epoch").exists()
                && state.join("hzk.binary").exists()
                && sock.exists()
            {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
        assert!(state.join("hzk.socket").exists(), "lease file missing");
        assert!(state.join("hzk.pid").exists(), "pid file missing");
        assert!(state.join("hzk.epoch").exists(), "epoch file missing");
        assert!(sock.exists(), "unix socket missing");
        assert_eq!(
            crate::supervisor_epoch::read_supervisor_epoch(&state),
            Some(1)
        );
        let meta = fs::metadata(&sock).expect("sock meta");
        assert_eq!(meta.permissions().mode() & 0o777, 0o600);
        let mut client = UnixStream::connect(&sock).expect("connect");
        client
            .write_all(br#"{"id":1,"method":"ping","params":{}}"#)
            .expect("write");
        client.write_all(b"\n").expect("nl");
        let mut reader = BufReader::new(client);
        let mut line = String::new();
        reader.read_line(&mut line).expect("read");
        assert!(line.contains("\"id\":1"), "{line}");
        assert!(
            line.contains("version") || line.contains("result"),
            "{line}"
        );
        assert!(line.contains("supervisorEpoch"), "{line}");
        assert!(line.contains("supervisorBinarySha256"), "{line}");

        // Second concurrent client must not hang behind the first (ruling 645).
        let mut client2 = UnixStream::connect(&sock).expect("connect2");
        client2
            .write_all(br#"{"id":2,"method":"ping","params":{}}"#)
            .expect("write2");
        client2.write_all(b"\n").expect("nl2");
        client2
            .set_read_timeout(Some(std::time::Duration::from_secs(10)))
            .expect("timeout");
        let mut reader2 = BufReader::new(client2);
        let mut line2 = String::new();
        reader2.read_line(&mut line2).expect("read2");
        assert!(line2.contains("\"id\":2"), "{line2}");

        let _ = handle;
        let _ = fs::remove_dir_all(&state);
    }

    #[test]
    fn bounded_line_reader_rejects_oversized_lines() {
        let ok_input = b"{\"id\":1}\n";
        let mut ok_reader = BufReader::new(&ok_input[..]);
        assert_eq!(
            read_bounded_line(&mut ok_reader, 32).unwrap().as_deref(),
            Some("{\"id\":1}")
        );
        assert_eq!(read_bounded_line(&mut ok_reader, 32).unwrap(), None);

        let big = format!("{}\n", "x".repeat(64));
        let mut big_reader = BufReader::new(big.as_bytes());
        assert!(matches!(
            read_bounded_line(&mut big_reader, 32),
            Err(BoundedLineError::TooLong)
        ));
    }

    #[test]
    fn socket_connection_cap_enforces_limit_and_releases() {
        let active = Arc::new(AtomicUsize::new(0));
        let p1 = try_acquire_connection(&active, 2).expect("permit 1");
        let p2 = try_acquire_connection(&active, 2).expect("permit 2");
        assert!(try_acquire_connection(&active, 2).is_none());
        drop(p1);
        let p3 = try_acquire_connection(&active, 2).expect("permit 3");
        drop(p2);
        drop(p3);
        assert_eq!(active.load(Ordering::Acquire), 0);
    }
}
