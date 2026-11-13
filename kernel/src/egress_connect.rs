//! Loopback CONNECT proxy stub (docs/33 §5.2 stage 1 reduced).
//!
//! Consults `<state-dir>/egress.json` via `egress::EgressPolicy` — byte-aligned
//! with TS `egress-connect-proxy.ts`. Advisory only: does NOT prove shell-net
//! enforcement. Optional TCP forward when `HZ_EGRESS_FORWARD=1`.

use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread::{self, JoinHandle};

use crate::egress::{self, EgressDecision, EgressPolicy, Origin};
use crate::egress_tls_intercept::{intercept_refuse_forward_from_env, INTERCEPT_REFUSE_BODY};
use crate::egress_tls_terminate;
use crate::egress_tls_peek::{parse_tls_client_hello_sni, tls_peek_enabled_from_env};

/// Whether outbound CONNECT tunnels are piped when policy admits (TS mirror).
pub fn forward_enabled_from_env() -> bool {
    match std::env::var("HZ_EGRESS_FORWARD") {
        Ok(raw) => {
            let s = raw.trim();
            s == "1" || s.eq_ignore_ascii_case("true")
        }
        Err(_) => false,
    }
}

/// CONNECT authority `host:port` → `https://host:port` origin (TS mirror).
pub fn origin_from_connect_authority(authority: &str) -> Option<Origin> {
    let trimmed = authority.trim();
    if trimmed.is_empty() || trimmed.chars().any(char::is_whitespace) {
        return None;
    }
    match trimmed.rfind(':') {
        None => egress::parse_origin(&format!("https://{}:443", trimmed)).ok(),
        Some(colon) => {
            let host_part = &trimmed[..colon];
            let port_part = &trimmed[colon + 1..];
            if host_part.is_empty() || !port_part.bytes().all(|b| b.is_ascii_digit()) {
                return None;
            }
            egress::parse_origin(&format!("https://{}:{}", host_part, port_part)).ok()
        }
    }
}

fn parse_connect_target(authority: &str) -> Option<(String, u16)> {
    let trimmed = authority.trim();
    if trimmed.is_empty() || trimmed.chars().any(char::is_whitespace) {
        return None;
    }
    match trimmed.rfind(':') {
        None => Some((trimmed.to_string(), 443)),
        Some(colon) => {
            let host = trimmed[..colon].to_string();
            let port_part = &trimmed[colon + 1..];
            if host.is_empty() || !port_part.bytes().all(|b| b.is_ascii_digit()) {
                return None;
            }
            let port: u16 = port_part.parse().ok()?;
            Some((host, port))
        }
    }
}

pub fn connect_admits(decision: EgressDecision) -> bool {
    matches!(
        decision,
        EgressDecision::Allow | EgressDecision::AllowAndRecord { .. }
    )
}

fn write_http_response(stream: &mut TcpStream, status: u16, body: &str) {
    let payload = if body.ends_with('\n') {
        body.to_string()
    } else {
        format!("{}\n", body)
    };
    let _ = write!(
        stream,
        "HTTP/1.1 {} \r\nContent-Length: {}\r\n\r\n{}",
        status,
        payload.len(),
        payload
    );
    let _ = stream.flush();
}

fn decide_authority(policy: &EgressPolicy, authority: &str) -> Result<EgressDecision, &'static str> {
    let origin = origin_from_connect_authority(authority).ok_or("unparseable")?;
    Ok(policy.decide(&origin))
}

const TLS_PEEK_ACCUM_MAX: usize = 16 * 1024;

fn pipe_forward_with_optional_tls_peek(
    mut client: TcpStream,
    mut upstream: TcpStream,
    initial_body: &[u8],
    tls_peek: bool,
    authority: &str,
) {
    let authority_log = authority.to_string();
    let _ = client.set_nonblocking(false);
    let _ = upstream.set_nonblocking(false);
    let initial_owned: Vec<u8> = initial_body.to_vec();
    if !initial_owned.is_empty() {
        let _ = upstream.write_all(&initial_owned);
    }
    let (mut c_read, mut u_write, mut u_read, mut c_write) = match (
        client.try_clone(),
        upstream.try_clone(),
        upstream.try_clone(),
        client.try_clone(),
    ) {
        (Ok(a), Ok(b), Ok(c), Ok(d)) => (a, b, c, d),
        _ => return,
    };
    let peek_flag = tls_peek;
    thread::spawn(move || {
        let mut peek_buf = Vec::new();
        let mut sni_logged = false;
        let mut buf = [0u8; 4096];
        if peek_flag && !initial_owned.is_empty() {
            peek_buf.extend_from_slice(&initial_owned);
            if let Some(sni) = parse_tls_client_hello_sni(&peek_buf) {
                sni_logged = true;
                eprintln!(
                    "[egress.tls.peek] authority={} sni={sni}",
                    authority_log
                );
            }
        }
        loop {
            match c_read.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    let chunk = &buf[..n];
                    if peek_flag && !sni_logged && peek_buf.len() < TLS_PEEK_ACCUM_MAX {
                        peek_buf.extend_from_slice(chunk);
                        if let Some(sni) = parse_tls_client_hello_sni(&peek_buf) {
                            sni_logged = true;
                            eprintln!(
                                "[egress.tls.peek] authority={} sni={sni}",
                                authority_log
                            );
                        }
                    }
                    if u_write.write_all(chunk).is_err() {
                        break;
                    }
                }
                Err(_) => break,
            }
        }
        let _ = u_write.shutdown(std::net::Shutdown::Write);
    });
    let _ = std::io::copy(&mut u_read, &mut c_write);
}

fn handle_client(mut client: TcpStream, policy: Option<Arc<EgressPolicy>>, forward: bool, tls_peek: bool) {
    let _ = client.set_read_timeout(Some(std::time::Duration::from_secs(30)));
    let _ = client.set_write_timeout(Some(std::time::Duration::from_secs(30)));
    let mut buf = Vec::new();
    let mut chunk = [0u8; 4096];
    loop {
        match client.read(&mut chunk) {
            Ok(0) => return,
            Ok(n) => {
                buf.extend_from_slice(&chunk[..n]);
                if buf.windows(4).any(|w| w == b"\r\n\r\n") {
                    break;
                }
                if buf.len() > 64 * 1024 {
                    write_http_response(&mut client, 431, "CONNECT header too large");
                    return;
                }
            }
            Err(_) => return,
        }
    }

    let header_end = buf
        .windows(4)
        .position(|w| w == b"\r\n\r\n")
        .map(|i| i + 4)
        .unwrap_or(buf.len());
    let header_text = String::from_utf8_lossy(&buf[..header_end.saturating_sub(4)]);
    let body = buf[header_end..].to_vec();

    let first_line = header_text.lines().next().unwrap_or_default();
    let parts: Vec<&str> = first_line.split_whitespace().collect();
    let authority = if parts.len() >= 2 && parts[0].eq_ignore_ascii_case("CONNECT") {
        let token = parts[1];
        if token.is_empty() || token == "/" {
            header_text
                .lines()
                .find(|l| l.to_ascii_lowercase().starts_with("host:"))
                .map(|l| l["host:".len()..].trim().to_string())
                .unwrap_or_default()
        } else {
            token.to_string()
        }
    } else {
        write_http_response(&mut client, 501, "egress connect proxy: CONNECT only");
        return;
    };

    if authority.is_empty() {
        write_http_response(&mut client, 400, "CONNECT missing authority");
        return;
    }

    let Some(policy) = policy else {
        write_http_response(&mut client, 503, "egress policy not loaded (egress.json absent)");
        return;
    };

    let decision = match decide_authority(&policy, &authority) {
        Ok(d) => d,
        Err(_) => {
            write_http_response(&mut client, 403, "CONNECT authority not allowed (unparseable)");
            return;
        }
    };

    if !connect_admits(decision) {
        let kind = decision.outcome_tag();
        write_http_response(&mut client, 403, &format!("CONNECT denied ({})", kind));
        return;
    }

    if !forward {
        write_http_response(
            &mut client,
            502,
            "CONNECT allowed by policy; forward tunnel not enabled (set HZ_EGRESS_FORWARD=1; MITM still open)",
        );
        return;
    }

    if intercept_refuse_forward_from_env() {
        write_http_response(&mut client, 502, INTERCEPT_REFUSE_BODY);
        return;
    }

    if egress_tls_terminate::terminate_enabled_from_env()
        && crate::egress_tls_intercept::intercept_ca_configured()
        && crate::egress_tls_intercept::intercept_enabled_from_env()
    {
        if !egress_tls_terminate::kernel_terminate_owns_connect() {
            write_http_response(
                &mut client,
                502,
                "HZ_EGRESS_TLS_TERMINATE: kernel CONNECT listener defers TLS terminate to TS proxy; still advisory",
            );
            return;
        }
    }

    let Some((host, port)) = parse_connect_target(&authority) else {
        write_http_response(&mut client, 403, "CONNECT authority not allowed (unparseable)");
        return;
    };

    let upstream = match TcpStream::connect((host.as_str(), port)) {
        Ok(s) => s,
        Err(_) => {
            write_http_response(&mut client, 502, "CONNECT upstream failed");
            return;
        }
    };

    let _ = write!(client, "HTTP/1.1 200 Connection Established\r\n\r\n");
    let _ = client.flush();
    pipe_forward_with_optional_tls_peek(client, upstream, &body, tls_peek && forward, &authority);
}

struct RunningListener {
    stop: Arc<AtomicBool>,
    join: JoinHandle<()>,
    port: u16,
}

pub struct ListenerSlot {
    running: Option<RunningListener>,
}

impl ListenerSlot {
    pub fn new() -> Self {
        ListenerSlot { running: None }
    }

    pub fn start(
        &mut self,
        state_dir: &Path,
        port: u16,
        forward: Option<bool>,
        tls_peek: Option<bool>,
    ) -> Result<serde_json::Value, String> {
        if self.running.is_some() {
            return Err("egress.connect.listen: listener already running; stop first".to_string());
        }
        let policy = match egress::load(state_dir).map_err(|e| e.to_string())? {
            Some(p) => Some(Arc::new(p)),
            None => None,
        };
        let forward = forward.unwrap_or_else(forward_enabled_from_env);
        let tls_peek = tls_peek.unwrap_or_else(|| forward && tls_peek_enabled_from_env());
        let listener = TcpListener::bind(("127.0.0.1", port)).map_err(|e| e.to_string())?;
        let bound_port = listener.local_addr().map_err(|e| e.to_string())?.port();
        let stop = Arc::new(AtomicBool::new(false));
        let stop_accept = stop.clone();
        let join = thread::spawn(move || {
            let _ = listener.set_nonblocking(true);
            while !stop_accept.load(Ordering::Relaxed) {
                match listener.accept() {
                    Ok((stream, _)) => {
                        let policy = policy.clone();
                        let peek = tls_peek;
                        thread::spawn(move || handle_client(stream, policy, forward, peek));
                    }
                    Err(ref e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                        thread::sleep(std::time::Duration::from_millis(10));
                    }
                    Err(_) => break,
                }
            }
        });
        let url = format!("http://127.0.0.1:{}", bound_port);
        self.running = Some(RunningListener {
            stop,
            join,
            port: bound_port,
        });
        Ok(serde_json::json!({
            "url": url,
            "port": bound_port,
            "forward": forward,
            "tlsPeek": tls_peek,
        }))
    }

    pub fn stop(&mut self) -> Result<serde_json::Value, String> {
        let Some(running) = self.running.take() else {
            return Ok(serde_json::json!({ "stopped": false, "reason": "not_running" }));
        };
        running.stop.store(true, Ordering::Relaxed);
        let _ = running.join.join();
        Ok(serde_json::json!({ "stopped": true, "port": running.port }))
    }
}

/// Hermetic one-shot CONNECT probe (unit/integration helpers).
#[cfg_attr(not(test), allow(dead_code))]
pub fn probe_connect_status(proxy_port: u16, authority: &str) -> Result<u16, String> {
    let req = format!(
        "CONNECT {} HTTP/1.1\r\nHost: {}\r\n\r\n",
        authority, authority
    );
    for attempt in 0..40 {
        let mut stream = match TcpStream::connect(("127.0.0.1", proxy_port)) {
            Ok(s) => s,
            Err(e) if attempt + 1 < 40 => {
                thread::sleep(std::time::Duration::from_millis(25));
                continue;
            }
            Err(e) => return Err(e.to_string()),
        };
        let _ = stream.set_read_timeout(Some(std::time::Duration::from_secs(2)));
        if stream.write_all(req.as_bytes()).and_then(|_| stream.flush()).is_err() {
            thread::sleep(std::time::Duration::from_millis(25));
            continue;
        }
        let mut buf = [0u8; 512];
        match stream.read(&mut buf) {
            Ok(0) if attempt + 1 < 40 => {
                thread::sleep(std::time::Duration::from_millis(25));
                continue;
            }
            Ok(n) => {
                let head = String::from_utf8_lossy(&buf[..n]);
                let status_line = head.lines().next().unwrap_or_default();
                let status = status_line
                    .split_whitespace()
                    .nth(1)
                    .and_then(|s| s.parse().ok())
                    .unwrap_or(0);
                if status == 0 && attempt + 1 < 40 {
                    thread::sleep(std::time::Duration::from_millis(25));
                    continue;
                }
                return Ok(status);
            }
            Err(_) if attempt + 1 < 40 => {
                thread::sleep(std::time::Duration::from_millis(25));
                continue;
            }
            Err(e) => return Err(e.to_string()),
        }
    }
    Ok(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::io::{Read, Write};
    use std::net::TcpListener as EchoListener;

    #[test]
    fn origin_from_connect_authority_matches_ts() {
        let o = origin_from_connect_authority("api.example.com:443").unwrap();
        assert_eq!(o.host, "api.example.com");
        assert_eq!(o.port, 443);
        assert!(origin_from_connect_authority("bad host:443").is_none());
    }

    #[test]
    fn hermetic_connect_denies_without_forward() {
        let dir = tempfile_unique("egress-connect-deny");
        fs::write(
            dir.join("egress.json"),
            r#"[{"host":"deny.test","decision":"deny"},{"host":"allow.test","decision":"allow"}]"#,
        )
        .unwrap();

        let mut slot = ListenerSlot::new();
        let started = slot.start(&dir, 0, Some(false), None).unwrap();
        let port = started["port"].as_u64().unwrap() as u16;
        thread::sleep(std::time::Duration::from_millis(50));

        assert_eq!(
            probe_connect_status(port, "deny.test:443").unwrap(),
            403
        );
        assert_eq!(
            probe_connect_status(port, "allow.test:443").unwrap(),
            502
        );
        let _ = slot.stop();
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn hermetic_connect_forwards_when_enabled() {
        let echo = EchoListener::bind(("127.0.0.1", 0)).unwrap();
        let echo_port = echo.local_addr().unwrap().port();
        thread::spawn(move || {
            for stream in echo.incoming().flatten() {
                thread::spawn(move || {
                    let mut s = stream;
                    let mut buf = [0u8; 64];
                    if let Ok(n) = s.read(&mut buf) {
                        let _ = s.write_all(&buf[..n]);
                    }
                });
            }
        });

        let dir = tempfile_unique("egress-connect-fwd");
        fs::write(
            dir.join("egress.json"),
            r#"[{"host":"127.0.0.1","decision":"allow"}]"#,
        )
        .unwrap();

        let mut slot = ListenerSlot::new();
        let started = slot.start(&dir, 0, Some(true), None).unwrap();
        let proxy_port = started["port"].as_u64().unwrap() as u16;
        thread::sleep(std::time::Duration::from_millis(50));

        let mut client = TcpStream::connect(("127.0.0.1", proxy_port)).unwrap();
        let req = format!(
            "CONNECT 127.0.0.1:{} HTTP/1.1\r\nHost: 127.0.0.1:{}\r\n\r\n",
            echo_port, echo_port
        );
        client.write_all(req.as_bytes()).unwrap();
        let mut resp = [0u8; 256];
        let n = client.read(&mut resp).unwrap();
        let head = String::from_utf8_lossy(&resp[..n]);
        assert!(head.contains("200"), "{}", head);

        client.write_all(b"ping").unwrap();
        let mut buf = [0u8; 8];
        let n = client.read(&mut buf).unwrap();
        assert_eq!(&buf[..n], b"ping");

        let _ = slot.stop();
        let _ = fs::remove_dir_all(&dir);
    }

    fn tempfile_unique(tag: &str) -> std::path::PathBuf {
        let dir = std::path::PathBuf::from(std::env::temp_dir()).join(format!(
            "hz-egress-connect-{}-{}",
            tag,
            std::process::id()
        ));
        let _ = fs::create_dir_all(&dir);
        dir
    }

    #[test]
    fn absent_policy_returns_503() {
        let dir = tempfile_unique("egress-connect-no-policy");
        fs::create_dir_all(&dir).unwrap();
        let mut slot = ListenerSlot::new();
        let started = slot.start(&dir, 0, Some(false), None).unwrap();
        let port = started["port"].as_u64().unwrap() as u16;
        thread::sleep(std::time::Duration::from_millis(50));
        assert_eq!(probe_connect_status(port, "any.test:443").unwrap(), 503);
        let _ = slot.stop();
        let _ = fs::remove_dir_all(&dir);
    }
}
