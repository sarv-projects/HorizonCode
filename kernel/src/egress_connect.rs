//! Loopback CONNECT proxy stub (docs/33 §5.2 stage 1 reduced).
//!
//! Consults `<state-dir>/egress.json` via `egress::EgressPolicy` — byte-aligned
//! with TS `egress-connect-proxy.ts`. Advisory only: does NOT prove shell-net
//! enforcement. Optional TCP forward when `HZ_EGRESS_FORWARD=1`.

use std::fs;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{IpAddr, SocketAddr, TcpListener, TcpStream, ToSocketAddrs};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::{Duration, SystemTime};

use crate::egress::{self, EgressDecision, EgressPolicy, Origin};
use crate::egress_tls_intercept::{intercept_refuse_forward_from_env, INTERCEPT_REFUSE_BODY};
use crate::egress_tls_peek::{parse_tls_client_hello_sni, tls_peek_enabled_from_env};
use crate::egress_tls_terminate;

const MAX_REQUEST_LINE_BYTES: usize = 8 * 1024;
const MAX_HEADER_BYTES: usize = 64 * 1024;
const DEFAULT_MAX_CONCURRENT_CONNECTIONS: usize = 64;
const TLS_PEEK_ACCUM_MAX: usize = 16 * 1024;

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

fn proxy_auth_token_from_env() -> Option<String> {
    std::env::var("HZ_EGRESS_PROXY_AUTH")
        .ok()
        .or_else(|| std::env::var("HZ_EGRESS_PROXY_TOKEN").ok())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

fn allow_private_ips_from_env() -> bool {
    std::env::var("HZ_EGRESS_ALLOW_PRIVATE_IPS")
        .ok()
        .map(|s| {
            let t = s.trim();
            t == "1" || t.eq_ignore_ascii_case("true")
        })
        .unwrap_or(false)
}

/// CONNECT authority `host:port` → `https://host:port` origin (TS mirror).
/// Strips `[...]` brackets on IPv6 authorities like `[::1]:443`.
pub fn origin_from_connect_authority(authority: &str) -> Option<Origin> {
    let trimmed = authority.trim();
    if trimmed.is_empty() || trimmed.chars().any(char::is_whitespace) {
        return None;
    }
    if trimmed.starts_with('[') {
        let close = trimmed.find(']')?;
        let ipv6_str = &trimmed[1..close];
        if ipv6_str.is_empty() || ipv6_str.parse::<std::net::Ipv6Addr>().is_err() {
            return None;
        }
        let rest = &trimmed[close + 1..];
        let port = if rest.is_empty() {
            443
        } else {
            let port_part = rest.strip_prefix(':')?;
            if port_part.is_empty() || !port_part.bytes().all(|b| b.is_ascii_digit()) {
                return None;
            }
            let p: u16 = port_part.parse().ok()?;
            if p == 0 {
                return None;
            }
            p
        };
        return Some(Origin {
            scheme: "https".to_string(),
            host: ipv6_str.to_ascii_lowercase(),
            port,
        });
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
    if trimmed.starts_with('[') {
        let close = trimmed.find(']')?;
        let host = trimmed[1..close].to_string();
        if host.is_empty() {
            return None;
        }
        let rest = &trimmed[close + 1..];
        if rest.is_empty() {
            return Some((host, 443));
        }
        let port_part = rest.strip_prefix(':')?;
        if port_part.is_empty() || !port_part.bytes().all(|b| b.is_ascii_digit()) {
            return None;
        }
        let port: u16 = port_part.parse().ok()?;
        return Some((host, port));
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

/// Reject loopback, RFC1918, link-local, CGNAT (`100.64.0.0/10`), ULA (`fc00::/7`),
/// multicast, unspecified, broadcast, reserved, and IPv4-mapped private IPv6 addresses.
pub fn is_private_or_reserved_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => {
            let o = v4.octets();
            v4.is_loopback()
                || v4.is_private()
                || v4.is_link_local()
                || v4.is_multicast()
                || v4.is_unspecified()
                || v4.is_broadcast()
                // CGNAT 100.64.0.0/10
                || (o[0] == 100 && (o[1] & 0b1100_0000) == 64)
                // "This network" 0.0.0.0/8
                || o[0] == 0
                // Reserved 240.0.0.0/4
                || o[0] >= 240
                // IETF protocol assignments 192.0.0.0/24 & TEST-NET-1 192.0.2.0/24
                || (o[0] == 192 && o[1] == 0 && (o[2] == 0 || o[2] == 2))
                // Benchmarking 198.18.0.0/15
                || (o[0] == 198 && (o[1] == 18 || o[1] == 19))
                // TEST-NET-2 198.51.100.0/24
                || (o[0] == 198 && o[1] == 51 && o[2] == 100)
                // TEST-NET-3 203.0.113.0/24
                || (o[0] == 203 && o[1] == 0 && o[2] == 113)
        }
        IpAddr::V6(v6) => {
            if let Some(v4) = v6.to_ipv4_mapped() {
                return is_private_or_reserved_ip(IpAddr::V4(v4));
            }
            let seg = v6.segments();
            v6.is_loopback()
                || v6.is_unspecified()
                || v6.is_multicast()
                // ULA fc00::/7
                || (seg[0] & 0xfe00) == 0xfc00
                // Link-local fe80::/10
                || (seg[0] & 0xffc0) == 0xfe80
                // Site-local (deprecated) fec0::/10
                || (seg[0] & 0xffc0) == 0xfec0
                // NAT64 well-known 64:ff9b::/96 (RFC 6052) and local-use 64:ff9b:1::/48 (RFC 8215)
                || (seg[0] == 0x0064
                    && seg[1] == 0xff9b
                    && ((seg[2] == 0 && seg[3] == 0 && seg[4] == 0 && seg[5] == 0)
                        || seg[2] == 0x0001))
                // Discard-only 100::/64 (RFC 6666)
                || (seg[0] == 0x0100 && seg[1] == 0 && seg[2] == 0 && seg[3] == 0)
                // Documentation 2001:db8::/32 (RFC 3849)
                || (seg[0] == 0x2001 && seg[1] == 0x0db8)
        }
    }
}

/// Resolve `(host, port)` once, validate all returned IPs against private/reserved
/// ranges, and return the pinned `SocketAddr` so the subsequent TCP connect cannot
/// re-resolve to a different address (DNS pinning).
fn resolve_and_pin_target(
    host: &str,
    port: u16,
    allow_private_ips: bool,
) -> Result<SocketAddr, (u16, &'static str)> {
    let addrs: Vec<SocketAddr> = (host, port)
        .to_socket_addrs()
        .map_err(|_| (502, "CONNECT upstream DNS resolution failed"))?
        .collect();
    if addrs.is_empty() {
        return Err((502, "CONNECT upstream DNS resolution returned no addresses"));
    }
    if !allow_private_ips && addrs.iter().any(|a| is_private_or_reserved_ip(a.ip())) {
        return Err((403, "CONNECT target resolves to private or reserved IP"));
    }
    Ok(addrs[0])
}

fn ct_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut diff = 0u8;
    for (x, y) in a.iter().zip(b.iter()) {
        diff |= x ^ y;
    }
    diff == 0
}

fn decode_base64_simple(input: &str) -> Option<Vec<u8>> {
    let clean: Vec<u8> = input
        .bytes()
        .filter(|b| !b.is_ascii_whitespace())
        .collect();
    if clean.len() % 4 != 0 {
        return None;
    }
    let mut out = Vec::with_capacity((clean.len() / 4) * 3);
    let val = |b: u8| -> Option<u8> {
        match b {
            b'A'..=b'Z' => Some(b - b'A'),
            b'a'..=b'z' => Some(b - b'a' + 26),
            b'0'..=b'9' => Some(b - b'0' + 52),
            b'+' => Some(62),
            b'/' => Some(63),
            _ => None,
        }
    };
    for chunk in clean.chunks_exact(4) {
        let a = val(chunk[0])?;
        let b = val(chunk[1])?;
        out.push((a << 2) | (b >> 4));
        if chunk[2] != b'=' {
            let c = val(chunk[2])?;
            out.push((b << 4) | (c >> 2));
            if chunk[3] != b'=' {
                let d = val(chunk[3])?;
                out.push((c << 6) | d);
            }
        } else if chunk[3] != b'=' {
            return None;
        }
    }
    Some(out)
}

fn validate_proxy_authorization(headers: &[String], expected_token: &str) -> bool {
    let expected = expected_token.as_bytes();
    for line in headers {
        let Some((name, raw_val)) = line.split_once(':') else {
            continue;
        };
        if !name.trim().eq_ignore_ascii_case("proxy-authorization") {
            continue;
        }
        let val = raw_val.trim();
        if ct_eq(val.as_bytes(), expected) {
            return true;
        }
        if let Some((scheme, cred)) = val.split_once(char::is_whitespace) {
            let cred = cred.trim();
            if scheme.eq_ignore_ascii_case("bearer") {
                if ct_eq(cred.as_bytes(), expected) {
                    return true;
                }
            } else if scheme.eq_ignore_ascii_case("basic") {
                if ct_eq(cred.as_bytes(), expected) {
                    return true;
                }
                if let Some(decoded) = decode_base64_simple(cred) {
                    if ct_eq(&decoded, expected) {
                        return true;
                    }
                    if let Some(colon) = decoded.iter().position(|&b| b == b':') {
                        if ct_eq(&decoded[colon + 1..], expected) {
                            return true;
                        }
                    }
                }
            }
        }
    }
    false
}

fn write_http_response_with_extra(
    stream: &mut TcpStream,
    status: u16,
    extra_headers: &str,
    body: &str,
) {
    let payload = if body.ends_with('\n') {
        body.to_string()
    } else {
        format!("{}\n", body)
    };
    let _ = write!(
        stream,
        "HTTP/1.1 {} \r\n{}Content-Length: {}\r\n\r\n{}",
        status,
        extra_headers,
        payload.len(),
        payload
    );
    let _ = stream.flush();
}

fn write_http_response(stream: &mut TcpStream, status: u16, body: &str) {
    write_http_response_with_extra(stream, status, "", body);
}

fn decide_authority(
    policy: &EgressPolicy,
    authority: &str,
) -> Result<EgressDecision, &'static str> {
    let origin = origin_from_connect_authority(authority).ok_or("unparseable")?;
    Ok(policy.decide(&origin))
}

#[derive(Debug)]
enum ReadHeaderError {
    Eof,
    Io,
    RequestLineTooLong,
    HeadersTooLarge,
}

/// Read the CONNECT request line and header lines with strict byte caps so an
/// unterminated line or oversized header block cannot cause unbounded memory growth.
fn read_bounded_connect_request<R: Read>(
    stream: R,
    max_line_bytes: usize,
    max_header_bytes: usize,
) -> Result<(String, Vec<String>, Vec<u8>), ReadHeaderError> {
    let mut reader = BufReader::new(stream);
    let mut line_buf = Vec::new();
    let n = (&mut reader)
        .take((max_line_bytes + 1) as u64)
        .read_until(b'\n', &mut line_buf)
        .map_err(|_| ReadHeaderError::Io)?;
    if n == 0 {
        return Err(ReadHeaderError::Eof);
    }
    if line_buf.len() > max_line_bytes {
        return Err(ReadHeaderError::RequestLineTooLong);
    }
    let mut total_bytes = line_buf.len();
    if total_bytes > max_header_bytes {
        return Err(ReadHeaderError::HeadersTooLarge);
    }
    let first_line = String::from_utf8_lossy(&line_buf)
        .trim_end_matches(['\r', '\n'])
        .to_string();

    let mut headers = Vec::new();
    loop {
        line_buf.clear();
        let remaining = max_header_bytes.saturating_sub(total_bytes);
        let cap = remaining.min(max_line_bytes);
        let n = (&mut reader)
            .take((cap + 1) as u64)
            .read_until(b'\n', &mut line_buf)
            .map_err(|_| ReadHeaderError::Io)?;
        if n == 0 {
            return Err(ReadHeaderError::Eof);
        }
        total_bytes += n;
        if line_buf.len() > max_line_bytes || total_bytes > max_header_bytes {
            return Err(ReadHeaderError::HeadersTooLarge);
        }
        let trimmed = String::from_utf8_lossy(&line_buf)
            .trim_end_matches(['\r', '\n'])
            .to_string();
        if trimmed.is_empty() {
            break;
        }
        headers.push(trimmed);
    }

    let initial_body = reader.buffer().to_vec();
    Ok((first_line, headers, initial_body))
}

struct PolicyCache {
    state_dir: PathBuf,
    last_stamp: Option<(Option<SystemTime>, u64)>,
    policy: Option<Arc<EgressPolicy>>,
}

impl PolicyCache {
    fn new(state_dir: PathBuf, initial: Option<Arc<EgressPolicy>>) -> Self {
        let stamp = fs::metadata(state_dir.join(egress::EGRESS_FILE))
            .ok()
            .map(|m| (m.modified().ok(), m.len()));
        PolicyCache {
            state_dir,
            last_stamp: stamp,
            policy: initial,
        }
    }

    fn current(&mut self) -> Result<Option<Arc<EgressPolicy>>, String> {
        let path = self.state_dir.join(egress::EGRESS_FILE);
        let meta = match fs::metadata(&path) {
            Ok(m) => m,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                self.last_stamp = None;
                self.policy = None;
                return Ok(None);
            }
            Err(e) => {
                self.last_stamp = None;
                self.policy = None;
                return Err(e.to_string());
            }
        };
        let stamp = (meta.modified().ok(), meta.len());
        if self.last_stamp == Some(stamp) && self.policy.is_some() {
            return Ok(self.policy.clone());
        }
        match egress::load(&self.state_dir) {
            Ok(pol) => {
                let arc = pol.map(Arc::new);
                self.last_stamp = Some(stamp);
                self.policy = arc.clone();
                Ok(arc)
            }
            Err(e) => {
                self.last_stamp = None;
                self.policy = None;
                Err(e.to_string())
            }
        }
    }
}

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

fn pipe_forward_with_optional_tls_peek(
    client: TcpStream,
    mut upstream: TcpStream,
    initial_body: &[u8],
    tls_peek: bool,
    authority: &str,
    permit: ConnectionPermit,
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
    let permit_shared = Arc::new(permit);
    let permit_thread = Arc::clone(&permit_shared);
    let peek_flag = tls_peek;
    thread::spawn(move || {
        // Hold ConnectionPermit in the spawned forwarding thread until client->upstream closes.
        let _permit = permit_thread;
        let mut peek_buf = Vec::new();
        let mut sni_logged = false;
        let mut buf = [0u8; 4096];
        if peek_flag && !initial_owned.is_empty() {
            peek_buf.extend_from_slice(&initial_owned);
            if let Some(sni) = parse_tls_client_hello_sni(&peek_buf) {
                sni_logged = true;
                eprintln!("[egress.tls.peek] authority={} sni={sni}", authority_log);
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
                            eprintln!("[egress.tls.peek] authority={} sni={sni}", authority_log);
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
    drop(permit_shared);
}

#[derive(Clone)]
struct ProxyConfig {
    forward: bool,
    tls_peek: bool,
    auth_token: Option<String>,
    allow_private_ips: bool,
}

fn handle_client(
    mut client: TcpStream,
    policy_cache: Arc<Mutex<PolicyCache>>,
    config: ProxyConfig,
    permit: ConnectionPermit,
) {
    let _ = client.set_read_timeout(Some(Duration::from_secs(30)));
    let _ = client.set_write_timeout(Some(Duration::from_secs(30)));
    let reader_clone = match client.try_clone() {
        Ok(s) => s,
        Err(_) => return,
    };
    let (first_line, headers, body) = match read_bounded_connect_request(
        reader_clone,
        MAX_REQUEST_LINE_BYTES,
        MAX_HEADER_BYTES,
    ) {
        Ok(v) => v,
        Err(ReadHeaderError::RequestLineTooLong) => {
            write_http_response(&mut client, 414, "CONNECT request line too long");
            return;
        }
        Err(ReadHeaderError::HeadersTooLarge) => {
            write_http_response(&mut client, 431, "CONNECT header too large");
            return;
        }
        Err(ReadHeaderError::Eof | ReadHeaderError::Io) => return,
    };

    if let Some(ref token) = config.auth_token {
        if !validate_proxy_authorization(&headers, token) {
            write_http_response_with_extra(
                &mut client,
                407,
                "Proxy-Authenticate: Basic realm=\"hz-egress\"\r\n",
                "Proxy authentication required",
            );
            return;
        }
    }

    let parts: Vec<&str> = first_line.split_whitespace().collect();
    let authority = if parts.len() >= 2 && parts[0].eq_ignore_ascii_case("CONNECT") {
        let token = parts[1];
        if token.is_empty() || token == "/" {
            headers
                .iter()
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

    let policy = match policy_cache.lock() {
        Ok(mut guard) => match guard.current() {
            Ok(Some(p)) => p,
            Ok(None) => {
                write_http_response(
                    &mut client,
                    503,
                    "egress policy not loaded (egress.json absent)",
                );
                return;
            }
            Err(_) => {
                write_http_response(
                    &mut client,
                    503,
                    "egress policy reload failed (fail closed)",
                );
                return;
            }
        },
        Err(_) => {
            write_http_response(&mut client, 503, "egress policy cache unavailable");
            return;
        }
    };

    let decision = match decide_authority(&policy, &authority) {
        Ok(d) => d,
        Err(_) => {
            write_http_response(
                &mut client,
                403,
                "CONNECT authority not allowed (unparseable)",
            );
            return;
        }
    };

    if !connect_admits(decision) {
        let kind = decision.outcome_tag();
        write_http_response(&mut client, 403, &format!("CONNECT denied ({})", kind));
        return;
    }

    if !config.forward {
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
        write_http_response(
            &mut client,
            403,
            "CONNECT authority not allowed (unparseable)",
        );
        return;
    };

    let pinned_addr = match resolve_and_pin_target(&host, port, config.allow_private_ips) {
        Ok(addr) => addr,
        Err((status, msg)) => {
            write_http_response(&mut client, status, msg);
            return;
        }
    };

    let upstream = match TcpStream::connect_timeout(&pinned_addr, Duration::from_secs(10)) {
        Ok(s) => s,
        Err(_) => {
            write_http_response(&mut client, 502, "CONNECT upstream failed");
            return;
        }
    };

    let _ = write!(client, "HTTP/1.1 200 Connection Established\r\n\r\n");
    let _ = client.flush();
    pipe_forward_with_optional_tls_peek(
        client,
        upstream,
        &body,
        config.tls_peek && config.forward,
        &authority,
        permit,
    );
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
        self.start_internal(
            state_dir,
            port,
            forward,
            tls_peek,
            proxy_auth_token_from_env(),
            allow_private_ips_from_env(),
            DEFAULT_MAX_CONCURRENT_CONNECTIONS,
        )
    }

    fn start_internal(
        &mut self,
        state_dir: &Path,
        port: u16,
        forward: Option<bool>,
        tls_peek: Option<bool>,
        auth_token: Option<String>,
        allow_private_ips: bool,
        max_connections: usize,
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
        let policy_cache = Arc::new(Mutex::new(PolicyCache::new(
            state_dir.to_path_buf(),
            policy,
        )));
        let active_conns = Arc::new(AtomicUsize::new(0));
        let config = ProxyConfig {
            forward,
            tls_peek,
            auth_token,
            allow_private_ips,
        };
        let join = thread::spawn(move || {
            let _ = listener.set_nonblocking(true);
            while !stop_accept.load(Ordering::Relaxed) {
                match listener.accept() {
                    Ok((mut stream, _)) => {
                        let Some(permit) = try_acquire_connection(&active_conns, max_connections)
                        else {
                            write_http_response(
                                &mut stream,
                                503,
                                "egress connect proxy: max concurrent connections reached",
                            );
                            continue;
                        };
                        let cache = Arc::clone(&policy_cache);
                        let cfg = config.clone();
                        thread::spawn(move || handle_client(stream, cache, cfg, permit));
                    }
                    Err(ref e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                        thread::sleep(Duration::from_millis(10));
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
    probe_connect_status_with_headers(proxy_port, authority, "")
}

#[cfg_attr(not(test), allow(dead_code))]
fn probe_connect_status_with_headers(
    proxy_port: u16,
    authority: &str,
    extra_headers: &str,
) -> Result<u16, String> {
    let req = format!(
        "CONNECT {} HTTP/1.1\r\nHost: {}\r\n{}\r\n",
        authority, authority, extra_headers
    );
    for attempt in 0..40 {
        let mut stream = match TcpStream::connect(("127.0.0.1", proxy_port)) {
            Ok(s) => s,
            Err(_) if attempt + 1 < 40 => {
                thread::sleep(Duration::from_millis(25));
                continue;
            }
            Err(e) => return Err(e.to_string()),
        };
        let _ = stream.set_read_timeout(Some(Duration::from_secs(2)));
        if stream
            .write_all(req.as_bytes())
            .and_then(|_| stream.flush())
            .is_err()
        {
            thread::sleep(Duration::from_millis(25));
            continue;
        }
        let mut buf = [0u8; 512];
        match stream.read(&mut buf) {
            Ok(0) if attempt + 1 < 40 => {
                thread::sleep(Duration::from_millis(25));
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
                    thread::sleep(Duration::from_millis(25));
                    continue;
                }
                return Ok(status);
            }
            Err(_) if attempt + 1 < 40 => {
                thread::sleep(Duration::from_millis(25));
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
    use std::net::{Ipv4Addr, Ipv6Addr, TcpListener as EchoListener};

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
        thread::sleep(Duration::from_millis(50));

        assert_eq!(probe_connect_status(port, "deny.test:443").unwrap(), 403);
        assert_eq!(probe_connect_status(port, "allow.test:443").unwrap(), 502);
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
        let started = slot
            .start_internal(&dir, 0, Some(true), None, None, true, 16)
            .unwrap();
        let proxy_port = started["port"].as_u64().unwrap() as u16;
        thread::sleep(Duration::from_millis(50));

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

    #[test]
    fn private_and_reserved_ips_are_classified_and_rejected() {
        // Private / reserved IPv4
        assert!(is_private_or_reserved_ip(IpAddr::V4(Ipv4Addr::new(127, 0, 0, 1))));
        assert!(is_private_or_reserved_ip(IpAddr::V4(Ipv4Addr::new(10, 0, 0, 1))));
        assert!(is_private_or_reserved_ip(IpAddr::V4(Ipv4Addr::new(172, 16, 0, 1))));
        assert!(is_private_or_reserved_ip(IpAddr::V4(Ipv4Addr::new(192, 168, 1, 1))));
        assert!(is_private_or_reserved_ip(IpAddr::V4(Ipv4Addr::new(169, 254, 169, 254))));
        assert!(is_private_or_reserved_ip(IpAddr::V4(Ipv4Addr::new(100, 64, 0, 1))));
        assert!(is_private_or_reserved_ip(IpAddr::V4(Ipv4Addr::new(100, 127, 255, 254))));
        assert!(is_private_or_reserved_ip(IpAddr::V4(Ipv4Addr::new(224, 0, 0, 1))));
        assert!(is_private_or_reserved_ip(IpAddr::V4(Ipv4Addr::UNSPECIFIED)));
        // Public IPv4
        assert!(!is_private_or_reserved_ip(IpAddr::V4(Ipv4Addr::new(1, 1, 1, 1))));
        assert!(!is_private_or_reserved_ip(IpAddr::V4(Ipv4Addr::new(8, 8, 8, 8))));
        assert!(!is_private_or_reserved_ip(IpAddr::V4(Ipv4Addr::new(100, 63, 255, 255))));
        assert!(!is_private_or_reserved_ip(IpAddr::V4(Ipv4Addr::new(100, 128, 0, 1))));

        // Private / reserved IPv6
        assert!(is_private_or_reserved_ip(IpAddr::V6(Ipv6Addr::LOCALHOST)));
        assert!(is_private_or_reserved_ip(IpAddr::V6(Ipv6Addr::UNSPECIFIED)));
        assert!(is_private_or_reserved_ip(IpAddr::V6("fc00::1".parse().unwrap())));
        assert!(is_private_or_reserved_ip(IpAddr::V6("fd12:3456::1".parse().unwrap())));
        assert!(is_private_or_reserved_ip(IpAddr::V6("fe80::1".parse().unwrap())));
        assert!(is_private_or_reserved_ip(IpAddr::V6("ff02::1".parse().unwrap())));
        assert!(is_private_or_reserved_ip(IpAddr::V6("::ffff:127.0.0.1".parse().unwrap())));
        assert!(is_private_or_reserved_ip(IpAddr::V6("::ffff:10.0.0.5".parse().unwrap())));
        // NAT64 64:ff9b::/96, site-local fec0::/10, discard 100::/64, doc 2001:db8::/32
        assert!(is_private_or_reserved_ip(IpAddr::V6("64:ff9b::127.0.0.1".parse().unwrap())));
        assert!(is_private_or_reserved_ip(IpAddr::V6("64:ff9b:1::1".parse().unwrap())));
        assert!(is_private_or_reserved_ip(IpAddr::V6("fec0::1".parse().unwrap())));
        assert!(is_private_or_reserved_ip(IpAddr::V6("100::1".parse().unwrap())));
        assert!(is_private_or_reserved_ip(IpAddr::V6("2001:db8::1".parse().unwrap())));
        // Public IPv6
        assert!(!is_private_or_reserved_ip(IpAddr::V6("2606:4700:4700::1111".parse().unwrap())));

        // IPv6 authority bracket stripping
        let ipv6_origin = origin_from_connect_authority("[::1]:443").expect("ipv6 origin");
        assert_eq!(ipv6_origin.host, "::1");
        assert_eq!(ipv6_origin.port, 443);

        // Domain deny is evaluated BEFORE DNS lookup (nonexistent denied domain -> 403, not 502)
        let dir_dns = tempfile_unique("egress-connect-dns-after-allow");
        fs::write(
            dir_dns.join("egress.json"),
            r#"[{"host":"denied.nonexistent.invalid","decision":"deny"}]"#,
        )
        .unwrap();
        let mut slot_dns = ListenerSlot::new();
        let started_dns = slot_dns
            .start_internal(&dir_dns, 0, Some(true), None, None, false, 16)
            .unwrap();
        let port_dns = started_dns["port"].as_u64().unwrap() as u16;
        thread::sleep(Duration::from_millis(50));
        assert_eq!(
            probe_connect_status(port_dns, "denied.nonexistent.invalid:443").unwrap(),
            403
        );
        let _ = slot_dns.stop();
        let _ = fs::remove_dir_all(&dir_dns);

        // Default listener rejects loopback even when egress.json allows 127.0.0.1
        let dir = tempfile_unique("egress-connect-ssrf");
        fs::write(
            dir.join("egress.json"),
            r#"[{"host":"127.0.0.1","decision":"allow"}]"#,
        )
        .unwrap();
        let mut slot = ListenerSlot::new();
        let started = slot
            .start_internal(&dir, 0, Some(true), None, None, false, 16)
            .unwrap();
        let port = started["port"].as_u64().unwrap() as u16;
        thread::sleep(Duration::from_millis(50));
        assert_eq!(probe_connect_status(port, "127.0.0.1:443").unwrap(), 403);
        let _ = slot.stop();
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn proxy_authorization_enforced_when_configured() {
        let dir = tempfile_unique("egress-connect-auth");
        fs::write(
            dir.join("egress.json"),
            r#"[{"host":"deny.test","decision":"deny"}]"#,
        )
        .unwrap();
        let mut slot = ListenerSlot::new();
        let started = slot
            .start_internal(
                &dir,
                0,
                Some(false),
                None,
                Some("s3cr3t-tok".to_string()),
                false,
                16,
            )
            .unwrap();
        let port = started["port"].as_u64().unwrap() as u16;
        thread::sleep(Duration::from_millis(50));

        // Missing auth -> 407
        assert_eq!(probe_connect_status(port, "deny.test:443").unwrap(), 407);
        // Wrong auth -> 407
        assert_eq!(
            probe_connect_status_with_headers(
                port,
                "deny.test:443",
                "Proxy-Authorization: Bearer wrong\r\n"
            )
            .unwrap(),
            407
        );
        // Valid Bearer auth -> passes auth check and hits policy 403
        assert_eq!(
            probe_connect_status_with_headers(
                port,
                "deny.test:443",
                "Proxy-Authorization: Bearer s3cr3t-tok\r\n"
            )
            .unwrap(),
            403
        );
        let _ = slot.stop();
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn egress_json_reloads_on_mtime_change() {
        let dir = tempfile_unique("egress-connect-reload");
        fs::write(
            dir.join("egress.json"),
            r#"[{"host":"dyn.test","decision":"deny"}]"#,
        )
        .unwrap();
        let mut slot = ListenerSlot::new();
        let started = slot.start(&dir, 0, Some(false), None).unwrap();
        let port = started["port"].as_u64().unwrap() as u16;
        thread::sleep(Duration::from_millis(50));

        assert_eq!(probe_connect_status(port, "dyn.test:443").unwrap(), 403);

        // Update egress.json with different length (and mtime) to allow dyn.test
        thread::sleep(Duration::from_millis(20));
        fs::write(
            dir.join("egress.json"),
            r#"[{"host":"dyn.test","decision":"allow","note":"reloaded"}]"#,
        )
        .unwrap();
        assert_eq!(probe_connect_status(port, "dyn.test:443").unwrap(), 502);

        let _ = slot.stop();
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn bounded_request_line_rejects_oversized_line() {
        let huge = format!("CONNECT {} HTTP/1.1\r\n\r\n", "a".repeat(MAX_REQUEST_LINE_BYTES + 64));
        let err = read_bounded_connect_request(
            huge.as_bytes(),
            MAX_REQUEST_LINE_BYTES,
            MAX_HEADER_BYTES,
        )
        .unwrap_err();
        assert!(matches!(err, ReadHeaderError::RequestLineTooLong));
    }

    #[test]
    fn concurrent_connection_limit_is_enforced_and_released() {
        let active = Arc::new(AtomicUsize::new(0));
        let p1 = try_acquire_connection(&active, 2).expect("permit 1");
        let p2 = try_acquire_connection(&active, 2).expect("permit 2");
        assert!(try_acquire_connection(&active, 2).is_none());
        drop(p1);
        let p3 = try_acquire_connection(&active, 2).expect("permit 3 after release");
        drop(p2);
        drop(p3);
        assert_eq!(active.load(Ordering::Acquire), 0);
    }

    fn tempfile_unique(tag: &str) -> std::path::PathBuf {
        let dir = std::path::PathBuf::from(std::env::temp_dir()).join(format!(
            "hz-egress-connect-{}-{}",
            tag,
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&dir);
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
        thread::sleep(Duration::from_millis(50));
        assert_eq!(probe_connect_status(port, "any.test:443").unwrap(), 503);
        let _ = slot.stop();
        let _ = fs::remove_dir_all(&dir);
    }
}
