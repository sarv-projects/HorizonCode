//! hz-sandbox-exec — reduced portable confinement before exec (docs/33 §5.3).
//!
//! Linux (incl. WSL) only. On other targets this binary refuses at startup
//! so `cargo check --locked` stays green on native Windows MSVC and macOS (ruling **645**).

#[cfg(not(unix))]
fn main() {
    eprintln!("hz-sandbox-exec: Linux (incl. WSL) only");
    std::process::exit(2);
}

#[cfg(all(unix, not(target_os = "linux")))]
fn main() {
    eprintln!("hz-sandbox-exec: Linux (incl. WSL) only; Landlock/seccomp confinement is unavailable on this Unix target");
    std::process::exit(2);
}

#[cfg(target_os = "linux")]
mod unix_impl;

#[cfg(target_os = "linux")]
fn main() {
    unix_impl::entry();
}
