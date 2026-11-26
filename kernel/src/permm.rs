//! Filesystem hardening: owner-only state directories and state files.
//!
//! The kernel state dir holds event payloads, receipts and leases — nothing in
//! it is meant to be world-readable. New directories are created 0700 and new
//! files 0600 on unix. On Windows the same intent is applied by setting an
//! explicit DACL (inheritance removed) that grants only the current user, via
//! the OS icacls utility. Permission failures are returned to the caller, which
//! must fail closed when securing state. Other platforms are a no-op
//! (documented, never claimed as enforcement).

use std::fs::OpenOptions;
use std::path::Path;

/// Restrict a directory to its owner (0700 on unix, an owner-only DACL on windows).
pub fn private_dir(path: &Path) -> std::io::Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700))?;
    }
    #[cfg(windows)]
    {
        set_owner_only_dacl(path, true)?;
    }
    #[cfg(not(any(unix, windows)))]
    {
        let _ = path;
    }
    Ok(())
}

/// Tighten a non-root, explicit parent before creating a sensitive state file.
/// Avoid changing the process working directory or a filesystem root when callers
/// pass a bare filename or a file directly under a root.
fn private_file_parent(path: &Path) -> std::io::Result<()> {
    let Some(parent) = path.parent() else {
        return Ok(());
    };
    if parent.as_os_str().is_empty() || parent == Path::new(".") || parent.parent().is_none() {
        return Ok(());
    }
    private_dir(parent)
}

#[cfg(all(test, any(unix, windows)))]
mod acl_error_tests {
    use super::*;

    #[test]
    fn private_dir_reports_acl_failure_instead_of_ignoring_it() {
        let missing = std::env::temp_dir().join(format!("hz-permm-missing-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&missing);
        let outcome = private_dir(&missing);
        assert!(
            format!("{outcome:?}").starts_with("Err("),
            "private_dir must return an error when permissions cannot be applied; got {outcome:?}"
        );
    }

    #[test]
    fn resolve_icacls_path_uses_system_root_with_fallback() {
        assert_eq!(
            resolve_icacls_path_from(Some(r"D:\WinNT")),
            std::path::PathBuf::from(r"D:\WinNT\System32\icacls.exe")
        );
        assert_eq!(
            resolve_icacls_path_from(Some(r"C:\Windows\")),
            std::path::PathBuf::from(r"C:\Windows\System32\icacls.exe")
        );
        assert_eq!(
            resolve_icacls_path_from(None),
            std::path::PathBuf::from(r"C:\Windows\System32\icacls.exe")
        );
        assert_eq!(
            resolve_icacls_path_from(Some("   ")),
            std::path::PathBuf::from(r"C:\Windows\System32\icacls.exe")
        );
    }
}

/// Append-only state-file options; `open` secures an explicit parent before creation
/// and applies a file-specific owner-only ACL on Windows.
pub struct AppendOptions {
    inner: OpenOptions,
}

impl AppendOptions {
    pub fn open(&self, path: impl AsRef<Path>) -> std::io::Result<std::fs::File> {
        let path = path.as_ref();
        private_file_parent(path)?;
        let file = self.inner.open(path)?;
        #[cfg(windows)]
        set_owner_only_dacl(path, false)?;
        Ok(file)
    }
}

pub fn append_options() -> AppendOptions {
    let mut options = OpenOptions::new();
    options.create(true).append(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    AppendOptions { inner: options }
}

/// Create or replace a state file after securing its explicit parent; the file is
/// owner-only (0600 on unix, DACL on windows).
pub fn write_new(path: &Path, contents: &[u8]) -> std::io::Result<()> {
    use std::io::Write;
    let mut options = OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    private_file_parent(path)?;
    let mut file = options.open(path)?;
    #[cfg(windows)]
    set_owner_only_dacl(path, false)?;
    file.write_all(contents)?;
    file.flush()
}

#[cfg(any(windows, test))]
fn resolve_icacls_path_from(system_root: Option<&str>) -> std::path::PathBuf {
    let root = system_root
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or(r"C:\Windows");
    let trimmed = root.trim_end_matches(['\\', '/']);
    std::path::PathBuf::from(format!(r"{trimmed}\System32\icacls.exe"))
}

#[cfg(windows)]
fn resolve_icacls_path() -> std::path::PathBuf {
    let env_root = std::env::var("SystemRoot").ok();
    resolve_icacls_path_from(env_root.as_deref())
}

/// Windows: replace the DACL with one that grants the current user full control
/// and nobody else, removing inherited entries. Spawn and nonzero-exit failures
/// are returned so state callers can refuse instead of claiming hardening.
#[cfg(windows)]
fn set_owner_only_dacl(path: &Path, directory: bool) -> std::io::Result<()> {
    use std::os::windows::process::CommandExt;
    use std::process::{Command, Stdio};
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    let user = std::env::var("USERNAME").unwrap_or_default();
    if user.is_empty() {
        return Err(std::io::Error::new(
            std::io::ErrorKind::NotFound,
            "USERNAME is unavailable; cannot apply state ACL",
        ));
    }
    let domain = std::env::var("USERDOMAIN").unwrap_or_default();
    let principal = if !domain.is_empty() && !user.contains('\\') {
        format!("{domain}\\{user}")
    } else {
        user
    };
    let permissions = if directory { "(OI)(CI)F" } else { "F" };
    let grant = format!("{principal}:{permissions}");
    let status = Command::new(resolve_icacls_path())
        .arg(path)
        .arg("/inheritance:r")
        .arg("/grant:r")
        .arg(grant)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .creation_flags(CREATE_NO_WINDOW)
        .status()?;
    if !status.success() {
        return Err(std::io::Error::other(format!(
            "icacls failed to apply owner-only ACL to {} ({status})",
            path.display()
        )));
    }
    Ok(())
}

#[cfg(all(test, windows))]
mod windows_tests {
    use super::*;
    use std::process::Command;

    /// State-parent DACL must be tightened before append creates its first file.
    #[test]
    fn append_open_secures_parent_before_file_creation() {
        let dir = std::env::temp_dir().join(format!("hz-permm-parent-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("scratch dir");
        let append_file = dir.join("events.jsonl");
        drop(
            append_options()
                .open(&append_file)
                .expect("append state file"),
        );

        let acl = Command::new("icacls")
            .arg(&dir)
            .output()
            .expect("icacls must inspect append parent ACL");
        assert!(acl.status.success(), "icacls parent inspection failed");
        let text = String::from_utf8_lossy(&acl.stdout);
        assert!(
            !text.contains("(I)"),
            "append parent retains inherited ACEs before append file creation: {text}"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// `write_new` must secure an explicit parent before creating state bytes.
    #[test]
    fn write_new_secures_parent_before_file_creation() {
        let dir =
            std::env::temp_dir().join(format!("hz-permm-write-parent-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("scratch dir");
        write_new(&dir.join("secret.json"), b"state").expect("write state file");

        let acl = Command::new("icacls")
            .arg(&dir)
            .output()
            .expect("icacls must inspect write_new parent ACL");
        assert!(acl.status.success(), "icacls parent inspection failed");
        let text = String::from_utf8_lossy(&acl.stdout);
        assert!(
            !text.contains("(I)"),
            "write_new parent retains inherited ACEs before file creation: {text}"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// D-6: newly secured state directories and files must not retain inherited ACEs.
    #[test]
    fn private_dir_and_state_file_remove_inherited_aces() {
        let dir = std::env::temp_dir().join(format!("hz-permm-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("scratch dir");
        let append_file = dir.join("events.jsonl");
        drop(
            append_options()
                .open(&append_file)
                .expect("append state file"),
        );
        private_dir(&dir).expect("secure state directory");
        let file = dir.join("g.txt");
        write_new(&file, b"x").expect("write_new");

        let user = std::env::var("USERNAME").expect("USERNAME must be available");
        assert!(!user.trim().is_empty(), "USERNAME must not be empty");
        let dir_acl = Command::new("icacls")
            .arg(&dir)
            .output()
            .expect("icacls must be available for ACL inspection");
        assert!(
            dir_acl.status.success(),
            "icacls directory inspection failed"
        );
        let dir_text = String::from_utf8_lossy(&dir_acl.stdout);
        assert!(
            dir_text.contains(&user),
            "directory ACL omits owner: {dir_text}"
        );
        assert!(
            !dir_text.contains("(I)"),
            "directory retains inherited ACEs: {dir_text}"
        );

        let file_acl = Command::new("icacls")
            .arg(&file)
            .output()
            .expect("icacls must inspect state file ACL");
        assert!(file_acl.status.success(), "icacls file inspection failed");
        let file_text = String::from_utf8_lossy(&file_acl.stdout);
        assert!(
            file_text.contains(&user),
            "state-file ACL omits owner: {file_text}"
        );
        assert!(
            !file_text.contains("(I)"),
            "state file retains inherited ACEs: {file_text}"
        );

        let append_acl = Command::new("icacls")
            .arg(&append_file)
            .output()
            .expect("icacls must inspect append-file ACL");
        assert!(
            append_acl.status.success(),
            "icacls append-file inspection failed"
        );
        let append_text = String::from_utf8_lossy(&append_acl.stdout);
        assert!(
            append_text.contains(&user),
            "append-file ACL omits owner: {append_text}"
        );
        assert!(
            !append_text.contains("(I)"),
            "append-created state file retains inherited ACEs: {append_text}"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }
}
