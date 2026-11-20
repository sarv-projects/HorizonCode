//! hz-sandbox-exec — reduced portable confinement before exec (docs/33 §5.3).
//!
//! Unix/Linux (incl. WSL) only. On other targets this binary refuses at startup
//! so `cargo check --locked` stays green on native Windows MSVC (ruling **645**).

#[cfg(not(unix))]
fn main() {
    eprintln!("hz-sandbox-exec: Unix/Linux (incl. WSL) only");
    std::process::exit(2);
}

#[cfg(unix)]
mod unix_impl;

#[cfg(unix)]
fn main() {
    unix_impl::entry();
}
