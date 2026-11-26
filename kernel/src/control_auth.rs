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

/// Windows launch path: the controlling parent writes the same 256-bit secret to
/// a private file inside the kernel state dir and passes its path. The file is
/// read once and REMOVED before serving, so the credential does not outlive the
/// launch. This is weaker than fd 3 (a same-user process can read it in the
/// window before deletion) and is only used where fd inheritance is unavailable;
/// the honest boundary is recorded in docs/28 ruling 908.
pub fn read_from_file(path: &std::path::Path) -> Result<String, String> {
    let file = std::fs::File::open(path).map_err(|_| {
        "HZ_PRECONDITION_FAILED: private kernel control file unavailable".to_string()
    })?;
    let mut content = String::new();
    file.take((SECRET_BYTES + 3) as u64)
        .read_to_string(&mut content)
        .map_err(|_| "HZ_PRECONDITION_FAILED: invalid private kernel control file".to_string())?;
    // The file is a one-shot credential: delete it even when validation fails.
    let _ = std::fs::remove_file(path);
    let value = content.trim_end_matches(['\n', '\r']);
    validate_secret(value)?;
    Ok(value.to_string())
}

/// Stronger Windows launch path (H-29): the controlling parent owns a named pipe
/// and writes the same 256-bit secret to it right after the kernel connects.
/// Nothing touches disk; the name is random per launch and the parent writes only
/// to the first connection. A same-user process that raced the name could still
/// win, so this is a reduction toward fd 3, not equality (ruling 917).
#[cfg(windows)]
pub fn read_from_pipe(pipe_path: &str) -> Result<String, String> {
    let mut file = std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .open(pipe_path)
        .map_err(|_| {
            "HZ_PRECONDITION_FAILED: private kernel control pipe unavailable".to_string()
        })?;
    let mut content = String::new();
    file.take((SECRET_BYTES + 3) as u64)
        .read_to_string(&mut content)
        .map_err(|_| "HZ_PRECONDITION_FAILED: invalid private kernel control pipe".to_string())?;
    let value = content.trim_end_matches(['\n', '\r']);
    validate_secret(value)?;
    Ok(value.to_string())
}

/// Kernel-owned launch control channel (H-29, phase 2). The kernel creates the
/// named pipe, then verifies the CLIENT process id before accepting the secret.
/// A racing same-user process cannot pass the pid check even if it guesses the
/// pipe name. The default DACL (owner + system) is used; no ACL is widened.
#[cfg(windows)]
pub struct PipeControlServer {
    handle: windows_sys::Win32::Foundation::HANDLE,
}

#[cfg(windows)]
const CONTROL_PIPE_MODE: u32 = windows_sys::Win32::System::Pipes::PIPE_TYPE_BYTE
    | windows_sys::Win32::System::Pipes::PIPE_READMODE_BYTE
    | windows_sys::Win32::System::Pipes::PIPE_WAIT
    | windows_sys::Win32::System::Pipes::PIPE_REJECT_REMOTE_CLIENTS;

#[cfg(windows)]
impl PipeControlServer {
    pub fn create(pipe_path: &str) -> Result<Self, String> {
        use windows_sys::Win32::Foundation::INVALID_HANDLE_VALUE;
        use windows_sys::Win32::Storage::FileSystem::{
            FILE_FLAG_FIRST_PIPE_INSTANCE, PIPE_ACCESS_INBOUND,
        };
        use windows_sys::Win32::System::Pipes::CreateNamedPipeW;
        let wide: Vec<u16> = pipe_path.encode_utf16().chain(std::iter::once(0)).collect();
        let handle = unsafe {
            CreateNamedPipeW(
                wide.as_ptr(),
                PIPE_ACCESS_INBOUND | FILE_FLAG_FIRST_PIPE_INSTANCE,
                CONTROL_PIPE_MODE,
                1,
                256,
                256,
                0,
                std::ptr::null(),
            )
        };
        if handle == INVALID_HANDLE_VALUE {
            return Err(format!(
                "HZ_PRECONDITION_FAILED: could not create control pipe: {}",
                std::io::Error::last_os_error()
            ));
        }
        Ok(Self { handle })
    }

    /// Block until one client connects, prove its pid, then read the credential.
    pub fn accept_and_read(&self, expected_pid: u32) -> Result<String, String> {
        use windows_sys::Win32::Foundation::{
            GetLastError, ERROR_BROKEN_PIPE, ERROR_PIPE_CONNECTED,
        };
        use windows_sys::Win32::Storage::FileSystem::ReadFile;
        use windows_sys::Win32::System::Pipes::{ConnectNamedPipe, GetNamedPipeClientProcessId};
        if unsafe { ConnectNamedPipe(self.handle, std::ptr::null_mut()) } == 0 {
            let err = unsafe { GetLastError() };
            if err != ERROR_PIPE_CONNECTED {
                return Err(format!(
                    "HZ_PRECONDITION_FAILED: control pipe connect failed: {}",
                    std::io::Error::from_raw_os_error(err as i32)
                ));
            }
        }
        let mut client_pid: u32 = 0;
        if unsafe { GetNamedPipeClientProcessId(self.handle, &mut client_pid) } == 0 {
            return Err("HZ_PRECONDITION_FAILED: control pipe client pid unavailable".into());
        }
        if client_pid != expected_pid {
            return Err(format!("HZ_PRECONDITION_FAILED: control pipe client pid {client_pid} is not the expected {expected_pid}"));
        }
        let max_len = SECRET_BYTES + 3;
        let mut buf = Vec::with_capacity(max_len);
        let mut chunk = [0u8; SECRET_BYTES + 3];
        while buf.len() < max_len {
            let remaining = (max_len - buf.len()) as u32;
            let mut read: u32 = 0;
            let ok = unsafe {
                ReadFile(
                    self.handle,
                    chunk.as_mut_ptr(),
                    remaining,
                    &mut read,
                    std::ptr::null_mut(),
                )
            };
            if ok == 0 {
                let err = unsafe { GetLastError() };
                if err == ERROR_BROKEN_PIPE {
                    break;
                }
                return Err(format!(
                    "HZ_PRECONDITION_FAILED: control pipe read failed: {}",
                    std::io::Error::from_raw_os_error(err as i32)
                ));
            }
            if read == 0 {
                break;
            }
            buf.extend_from_slice(&chunk[..read as usize]);
        }
        let text = String::from_utf8_lossy(&buf);
        let value = text.trim_end_matches(['\n', '\r']);
        validate_secret(value)?;
        Ok(value.to_string())
    }
}

#[cfg(windows)]
impl Drop for PipeControlServer {
    fn drop(&mut self) {
        unsafe {
            windows_sys::Win32::Foundation::CloseHandle(self.handle);
        }
    }
}

#[cfg(all(test, windows))]
mod pipe_server_tests {
    use super::*;
    use std::io::Write;

    fn pipe_path(tag: &str) -> String {
        format!(
            r"\\.\pipe\hz-kctl-{}-{}-{}",
            std::process::id(),
            tag,
            uuid::Uuid::new_v4()
        )
    }

    #[test]
    fn kernel_owned_pipe_accepts_only_the_expected_client() {
        let path = pipe_path("ok");
        let server = PipeControlServer::create(&path).expect("create pipe");
        let secret = "a".repeat(SECRET_BYTES);
        let writer = std::thread::spawn({
            let path = path.clone();
            let secret = secret.clone();
            move || {
                let mut client = std::fs::OpenOptions::new()
                    .write(true)
                    .open(&path)
                    .expect("connect");
                client
                    .write_all(format!("{secret}\n").as_bytes())
                    .expect("write");
            }
        });
        let got = server
            .accept_and_read(std::process::id())
            .expect("read secret");
        assert_eq!(got, secret);
        writer.join().expect("client thread");
    }

    #[test]
    fn kernel_owned_pipe_handles_preconnected_client_and_chunked_writes() {
        let path = pipe_path("preconn-chunked");
        let server = PipeControlServer::create(&path).expect("create pipe");
        let secret = "b".repeat(SECRET_BYTES);
        // Connect BEFORE accept_and_read to exercise ERROR_PIPE_CONNECTED (535).
        let mut client = std::fs::OpenOptions::new()
            .write(true)
            .open(&path)
            .expect("preconnect");
        let writer = std::thread::spawn({
            let secret = secret.clone();
            move || {
                client.write_all(&secret.as_bytes()[..32]).expect("chunk 1");
                client.flush().expect("flush 1");
                std::thread::sleep(std::time::Duration::from_millis(15));
                client.write_all(&secret.as_bytes()[32..]).expect("chunk 2");
                client.write_all(b"\n").expect("newline");
                client.flush().expect("flush 2");
            }
        });
        let got = server
            .accept_and_read(std::process::id())
            .expect("read preconnected chunked secret");
        assert_eq!(got, secret);
        writer.join().expect("client thread");
    }

    #[test]
    fn kernel_owned_pipe_refuses_a_foreign_client_pid() {
        let path = pipe_path("bad");
        let server = PipeControlServer::create(&path).expect("create pipe");
        let writer = std::thread::spawn({
            let path = path.clone();
            move || {
                let mut client = std::fs::OpenOptions::new()
                    .write(true)
                    .open(&path)
                    .expect("connect");
                let _ = client.write_all(format!("{}\n", "a".repeat(SECRET_BYTES)).as_bytes());
            }
        });
        let err = server
            .accept_and_read(0)
            .expect_err("foreign pid must be refused");
        assert!(err.contains("client pid"), "{err}");
        writer.join().expect("client thread");
    }

    #[test]
    fn kernel_owned_pipe_enforces_reject_remote_clients() {
        const PIPE_REJECT_REMOTE_CLIENTS_BIT: u32 = 0x0000_0008;
        assert_ne!(
            CONTROL_PIPE_MODE & PIPE_REJECT_REMOTE_CLIENTS_BIT,
            0,
            "CreateNamedPipeW must enforce PIPE_REJECT_REMOTE_CLIENTS"
        );
        let path = pipe_path("reject-remote");
        let _server = PipeControlServer::create(&path).expect("create pipe with reject remote");
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
    fn control_file_is_read_once_and_removed() {
        let path = std::env::temp_dir().join(format!(
            "hz-control-{}-{}.txt",
            std::process::id(),
            uuid::Uuid::new_v4()
        ));
        std::fs::write(&path, format!("{}\n", "a".repeat(64))).expect("write control file");
        let secret = read_from_file(&path).expect("read control file");
        assert_eq!(secret, "a".repeat(64));
        assert!(!path.exists(), "the one-shot credential must be removed");

        let bad = std::env::temp_dir().join(format!(
            "hz-control-bad-{}-{}.txt",
            std::process::id(),
            uuid::Uuid::new_v4()
        ));
        std::fs::write(&bad, "not-a-secret").expect("write bad control file");
        assert!(read_from_file(&bad).is_err());
        assert!(!bad.exists(), "a refused credential is still removed");
    }

    #[test]
    fn only_lowercase_256_bit_hex_is_accepted_at_boot() {
        assert!(validate_secret(&"f".repeat(64)).is_ok());
        assert!(validate_secret(&"F".repeat(64)).is_err());
        assert!(validate_secret("abcd").is_err());
        assert!(validate_secret(&"g".repeat(64)).is_err());
    }
}
