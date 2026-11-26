//! Rust Selective TLS MITM, Ephemeral Session CA & Credential Broker (Wave B / Track B3).
//!
//! - `EphemeralCa`: generates an in-memory per-session root CA via `rcgen` (private key never
//!   touches disk), writes ONLY the public CA certificate PEM to a temp file (`0600` on Unix),
//!   exports standard CA bundle env vars, and mints per-host leaf certs cached in a bounded
//!   128-entry LRU `Mutex<LeafCertCache>`.
//! - `CredentialBroker`: selective MITM (`should_terminate_host`) + fail-closed HTTP/1.1
//!   request rewriter (`rewrite_http1_request`) that substitutes placeholders ONLY when
//!   host/method/path-prefix policy matches, refuses compressed bodies (`Content-Encoding`) and
//!   chunked trailers, and rewrites `Connection: keep-alive` -> `Connection: close`.
//! - `TerminateRuntimeState` & `kernel_terminate_owns_connect*`: strict honesty gating — never
//!   claims `enforced` or CONNECT ownership unless BOTH the Rust TLS terminator AND OS-level
//!   egress confinement are verified active.

#![allow(dead_code)]

use std::collections::{HashMap, VecDeque};
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use rcgen::{
    BasicConstraints, Certificate, CertificateParams, DistinguishedName, DnType,
    ExtendedKeyUsagePurpose, IsCa, KeyPair, KeyUsagePurpose,
};
use rustls::pki_types::{CertificateDer, PrivateKeyDer};
use rustls::ServerConfig;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

pub use crate::egress_tls_intercept::terminate_enabled_from_env;

/// Maximum number of per-host leaf certificates cached in memory.
pub const LEAF_CERT_CACHE_CAPACITY: usize = 128;

/// Standard environment variables used by TLS clients/runtimes to trust an extra CA bundle.
pub const STANDARD_CA_ENV_VARS: &[&str] = &[
    "SSL_CERT_FILE",
    "NODE_EXTRA_CA_CERTS",
    "REQUESTS_CA_BUNDLE",
    "CURL_CA_BUNDLE",
    "PIP_CERT",
    "GIT_SSL_CAINFO",
    "CARGO_HTTP_CAINFO",
    "AWS_CA_BUNDLE",
    "GRPC_DEFAULT_SSL_ROOTS_FILE_PATH",
    "npm_config_cafile",
    "BUNDLE_SSL_CA_CERT",
];

/// Runtime state for the Rust TLS terminate / credential broker path.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct TerminateRuntimeState {
    pub os_egress_confined: bool,
    pub terminator_active: bool,
    pub ca_cert_path: Option<PathBuf>,
    pub brokered_hosts: Vec<String>,
}

impl TerminateRuntimeState {
    pub fn new(
        os_egress_confined: bool,
        terminator_active: bool,
        ca_cert_path: Option<PathBuf>,
        brokered_hosts: Vec<String>,
    ) -> Self {
        Self {
            os_egress_confined,
            terminator_active,
            ca_cert_path,
            brokered_hosts,
        }
    }

    /// Returns `true` ONLY when BOTH the Rust TLS terminator AND OS-level egress confinement
    /// are verified active.
    pub fn owns_connect(&self) -> bool {
        kernel_terminate_owns_connect_when(self.os_egress_confined, self.terminator_active)
    }

    /// Honest posture string — never claims `enforced` without OS-level egress confinement.
    pub fn posture(&self) -> &'static str {
        if self.owns_connect() {
            "enforced"
        } else if self.terminator_active {
            "advisory_unconfined"
        } else {
            "advisory_inactive"
        }
    }
}

/// Zero-arg default: kernel CONNECT listener does NOT claim ownership without verified
/// OS-level egress confinement and an active terminator (preserves existing honesty tests).
pub fn kernel_terminate_owns_connect() -> bool {
    false
}

/// Returns `true` ONLY when BOTH OS-level egress confinement AND the Rust TLS terminator
/// are verified active. Never claims shell-net `enforced` without confinement.
pub fn kernel_terminate_owns_connect_when(
    os_egress_confined: bool,
    terminator_active: bool,
) -> bool {
    os_egress_confined && terminator_active
}

/// Normalize a host string (strip optional `[brackets]`, `:port`, trailing `.`, lowercase).
pub fn normalize_host(raw: &str) -> String {
    let trimmed = raw.trim();
    let without_port = if let Some(rest) = trimmed.strip_prefix('[') {
        match rest.split_once(']') {
            Some((ipv6, _)) => ipv6,
            None => trimmed,
        }
    } else if trimmed.matches(':').count() == 1 {
        trimmed.split(':').next().unwrap_or(trimmed)
    } else {
        trimmed
    };
    without_port.trim_end_matches('.').to_ascii_lowercase()
}

/// Cached per-host leaf certificate material + ready-to-use `rustls::ServerConfig`.
#[derive(Clone)]
pub struct CachedLeafCert {
    pub host: String,
    pub cert_chain: Vec<CertificateDer<'static>>,
    pub server_config: Arc<ServerConfig>,
}

/// Bounded LRU cache for minted per-host leaf certificates.
pub struct LeafCertCache {
    capacity: usize,
    entries: HashMap<String, Arc<CachedLeafCert>>,
    order: VecDeque<String>,
}

impl LeafCertCache {
    pub fn new(capacity: usize) -> Self {
        let cap = capacity.max(1);
        Self {
            capacity: cap,
            entries: HashMap::with_capacity(cap),
            order: VecDeque::with_capacity(cap),
        }
    }

    pub fn capacity(&self) -> usize {
        self.capacity
    }

    pub fn len(&self) -> usize {
        self.entries.len()
    }

    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    pub fn contains(&self, host: &str) -> bool {
        self.entries.contains_key(host)
    }

    pub fn get(&mut self, host: &str) -> Option<Arc<CachedLeafCert>> {
        let value = self.entries.get(host)?.clone();
        self.touch(host);
        Some(value)
    }

    pub fn insert(&mut self, host: String, value: Arc<CachedLeafCert>) {
        if self.entries.contains_key(&host) {
            self.entries.insert(host.clone(), value);
            self.touch(&host);
            return;
        }
        while self.entries.len() >= self.capacity {
            if let Some(evicted) = self.order.pop_front() {
                self.entries.remove(&evicted);
            } else {
                break;
            }
        }
        self.order.push_back(host.clone());
        self.entries.insert(host, value);
    }

    fn touch(&mut self, host: &str) {
        if let Some(pos) = self.order.iter().position(|k| k == host) {
            self.order.remove(pos);
        }
        self.order.push_back(host.to_string());
    }
}

/// Ephemeral per-session root CA held strictly in Rust memory.
///
/// Only the public root CA certificate PEM is written to a temp file (`0600` on Unix);
/// the CA private key never touches disk.
pub struct EphemeralCa {
    ca_cert: Certificate,
    ca_key: KeyPair,
    ca_pem: String,
    ca_pem_path: PathBuf,
    leaf_cache: Mutex<LeafCertCache>,
}

impl EphemeralCa {
    /// Generate a fresh per-session root CA in memory and write ONLY the public CA cert PEM
    /// to a temporary file (`0600` permissions on Unix).
    pub fn new() -> Result<Self, String> {
        Self::with_cache_capacity(LEAF_CERT_CACHE_CAPACITY)
    }

    /// Generate a fresh per-session root CA with a custom leaf cache capacity.
    pub fn with_cache_capacity(capacity: usize) -> Result<Self, String> {
        let mut params = CertificateParams::default();
        params.is_ca = IsCa::Ca(BasicConstraints::Unconstrained);
        params.key_usages = vec![
            KeyUsagePurpose::KeyCertSign,
            KeyUsagePurpose::CrlSign,
            KeyUsagePurpose::DigitalSignature,
        ];
        let mut dn = DistinguishedName::new();
        dn.push(DnType::CommonName, "HorizonCode Ephemeral Session CA");
        dn.push(DnType::OrganizationName, "HorizonCode");
        params.distinguished_name = dn;

        let ca_key =
            KeyPair::generate().map_err(|e| format!("failed to generate ephemeral CA key: {e}"))?;
        let ca_cert = params
            .self_signed(&ca_key)
            .map_err(|e| format!("failed to self-sign ephemeral CA cert: {e}"))?;
        let ca_pem = ca_cert.pem();

        let ca_pem_path =
            std::env::temp_dir().join(format!("hz-ephemeral-ca-{}.pem", Uuid::new_v4()));
        write_public_pem_0600(&ca_pem_path, ca_pem.as_bytes())?;

        Ok(Self {
            ca_cert,
            ca_key,
            ca_pem,
            ca_pem_path,
            leaf_cache: Mutex::new(LeafCertCache::new(capacity)),
        })
    }

    /// Public root CA certificate PEM (never contains the private key).
    pub fn ca_pem(&self) -> &str {
        &self.ca_pem
    }

    /// Path to the temp file containing ONLY the public root CA certificate PEM.
    pub fn ca_pem_path(&self) -> &Path {
        &self.ca_pem_path
    }

    /// Public root CA certificate in DER format.
    pub fn ca_cert_der(&self) -> CertificateDer<'static> {
        CertificateDer::from(self.ca_cert.der().to_vec())
    }

    /// Standard CA environment variables pointing to the temp public CA PEM file.
    pub fn ca_env_vars(&self) -> Vec<(&'static str, String)> {
        let path_str = self.ca_pem_path.to_string_lossy().into_owned();
        STANDARD_CA_ENV_VARS
            .iter()
            .map(|&name| (name, path_str.clone()))
            .collect()
    }

    /// Current number of cached leaf certificates.
    pub fn cache_len(&self) -> usize {
        self.leaf_cache.lock().map(|c| c.len()).unwrap_or(0)
    }

    /// Mint or retrieve a cached leaf certificate + `ServerConfig` for `host`.
    pub fn mint_or_get_leaf_cert(&self, host: &str) -> Result<Arc<CachedLeafCert>, String> {
        let normalized = normalize_host(host);
        if normalized.is_empty() {
            return Err("cannot mint leaf certificate for empty host".to_string());
        }

        {
            let mut cache = self
                .leaf_cache
                .lock()
                .map_err(|_| "leaf cert cache lock poisoned".to_string())?;
            if let Some(hit) = cache.get(&normalized) {
                return Ok(hit);
            }
        }

        let mut leaf_params = CertificateParams::new(vec![normalized.clone()])
            .map_err(|e| format!("invalid host SAN '{normalized}': {e}"))?;
        leaf_params.is_ca = IsCa::NoCa;
        leaf_params.key_usages = vec![
            KeyUsagePurpose::DigitalSignature,
            KeyUsagePurpose::KeyEncipherment,
        ];
        leaf_params.extended_key_usages = vec![ExtendedKeyUsagePurpose::ServerAuth];
        let mut dn = DistinguishedName::new();
        dn.push(DnType::CommonName, normalized.clone());
        leaf_params.distinguished_name = dn;

        let leaf_key =
            KeyPair::generate().map_err(|e| format!("failed to generate leaf key: {e}"))?;
        let leaf_cert = leaf_params
            .signed_by(&leaf_key, &self.ca_cert, &self.ca_key)
            .map_err(|e| format!("failed to sign leaf cert for '{normalized}': {e}"))?;

        let leaf_der = CertificateDer::from(leaf_cert.der().to_vec());
        let ca_der = self.ca_cert_der();
        let cert_chain = vec![leaf_der, ca_der];

        let key_der = PrivateKeyDer::try_from(leaf_key.serialize_der())
            .map_err(|e| format!("failed to encode leaf private key DER: {e}"))?;
        let server_cfg = ServerConfig::builder()
            .with_no_client_auth()
            .with_single_cert(cert_chain.clone(), key_der)
            .map_err(|e| format!("failed to build rustls ServerConfig for '{normalized}': {e}"))?;

        let cached = Arc::new(CachedLeafCert {
            host: normalized.clone(),
            cert_chain,
            server_config: Arc::new(server_cfg),
        });

        let mut cache = self
            .leaf_cache
            .lock()
            .map_err(|_| "leaf cert cache lock poisoned".to_string())?;
        cache.insert(normalized, cached.clone());
        Ok(cached)
    }
}

impl Drop for EphemeralCa {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.ca_pem_path);
    }
}

fn write_public_pem_0600(path: &Path, pem_bytes: &[u8]) -> Result<(), String> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
        let mut file = OpenOptions::new()
            .create_new(true)
            .write(true)
            .mode(0o600)
            .open(path)
            .map_err(|e| format!("failed to create ephemeral CA PEM file: {e}"))?;
        file.write_all(pem_bytes)
            .map_err(|e| format!("failed to write ephemeral CA PEM file: {e}"))?;
        fs::set_permissions(path, fs::Permissions::from_mode(0o600))
            .map_err(|e| format!("failed to chmod 0600 on ephemeral CA PEM file: {e}"))?;
    }
    #[cfg(not(unix))]
    {
        let mut file = OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(path)
            .map_err(|e| format!("failed to create ephemeral CA PEM file: {e}"))?;
        file.write_all(pem_bytes)
            .map_err(|e| format!("failed to write ephemeral CA PEM file: {e}"))?;
    }
    Ok(())
}

/// Scoped credential injection rule (OpenAI Codex `credential_broker.rs` pattern).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CredentialRule {
    pub host: String,
    pub methods: Vec<String>,
    pub path_prefix: String,
    pub placeholder: String,
    pub real_secret: String,
}

/// Selective TLS MITM & fail-closed HTTP/1.1 credential broker.
#[derive(Debug, Clone, Default)]
pub struct CredentialBroker {
    rules: Vec<CredentialRule>,
}

impl CredentialBroker {
    pub fn new(rules: Vec<CredentialRule>) -> Self {
        Self { rules }
    }

    pub fn rules(&self) -> &[CredentialRule] {
        &self.rules
    }

    /// Selective MITM gate: returns `true` ONLY for hosts with active credential-injection
    /// rules. All other hosts tunnel via opaque `CONNECT`.
    pub fn should_terminate_host(&self, host: &str) -> bool {
        let target = normalize_host(host);
        if target.is_empty() {
            return false;
        }
        self.rules
            .iter()
            .any(|rule| !rule.placeholder.is_empty() && normalize_host(&rule.host) == target)
    }

    /// Parse and rewrite an HTTP/1.1 request, substituting `placeholder` -> `real_secret`
    /// ONLY when host, method, and path-prefix policy match.
    ///
    /// Fail-closed invariants:
    /// - Requires a complete `\r\n\r\n` header boundary.
    /// - Refuses compressed request bodies (`Content-Encoding`).
    /// - Refuses `Transfer-Encoding: chunked` trailers (and any `Trailer` header).
    /// - Refuses mismatched `Host` header, host, method, or path-prefix.
    /// - Strips `Connection: keep-alive` (and `Proxy-Connection`) and emits `Connection: close`
    ///   so subsequent requests on a reused socket cannot bypass inspection.
    pub fn rewrite_http1_request(&self, host: &str, raw_request: &[u8]) -> Result<Vec<u8>, String> {
        let target_host = normalize_host(host);
        if target_host.is_empty() {
            return Err("empty target host".to_string());
        }

        let boundary = find_subsequence(raw_request, b"\r\n\r\n")
            .ok_or_else(|| "incomplete HTTP/1.1 headers: missing \\r\\n\\r\\n boundary".to_string())?;
        let head_bytes = &raw_request[..boundary];
        let body_bytes = &raw_request[boundary + 4..];

        let head_str = std::str::from_utf8(head_bytes)
            .map_err(|_| "invalid UTF-8 in HTTP/1.1 request headers".to_string())?;
        if head_bytes.contains(&0) {
            return Err("fail-closed: NUL byte in HTTP/1.1 request head".to_string());
        }
        let mut lines = head_str.split("\r\n");
        let request_line = lines
            .next()
            .ok_or_else(|| "missing HTTP/1.1 request line".to_string())?;
        if request_line.contains('\r') || request_line.contains('\n') {
            return Err("fail-closed: bare CR or LF in HTTP/1.1 request line".to_string());
        }

        let mut req_parts = request_line.split_whitespace();
        let method = req_parts
            .next()
            .ok_or_else(|| "missing HTTP method".to_string())?;
        let target = req_parts
            .next()
            .ok_or_else(|| "missing HTTP request target".to_string())?;
        let version = req_parts
            .next()
            .ok_or_else(|| "missing HTTP version".to_string())?;
        if req_parts.next().is_some() || !version.starts_with("HTTP/1.") {
            return Err(format!("unsupported or malformed HTTP request line: {request_line}"));
        }

        let req_path = extract_and_validate_request_path(target, &target_host)?;

        let mut headers: Vec<(String, String)> = Vec::new();
        let mut host_header_count = 0usize;
        let mut content_length_count = 0usize;
        let mut content_length_value: Option<usize> = None;
        let mut has_transfer_encoding = false;
        let mut is_chunked = false;

        for line in lines {
            if line.contains('\r') || line.contains('\n') {
                return Err("fail-closed: bare CR or LF in HTTP/1.1 header line".to_string());
            }
            if line.is_empty() {
                continue;
            }
            let (name, val) = line
                .split_once(':')
                .ok_or_else(|| format!("malformed HTTP header line: {line}"))?;
            let name_trimmed = name.trim();
            let val_trimmed = val.trim();
            if name_trimmed.is_empty() {
                return Err("empty HTTP header name".to_string());
            }

            if name_trimmed.eq_ignore_ascii_case("content-encoding") {
                return Err(format!(
                    "fail-closed: compressed request body refused (Content-Encoding: {val_trimmed})"
                ));
            }
            if name_trimmed.eq_ignore_ascii_case("trailer") {
                return Err(
                    "fail-closed: HTTP/1.1 Trailer header refused on brokered request".to_string(),
                );
            }
            if name_trimmed.eq_ignore_ascii_case("content-length") {
                content_length_count += 1;
                if content_length_count > 1 {
                    return Err("fail-closed: duplicate Content-Length header".to_string());
                }
                if val_trimmed.is_empty() || !val_trimmed.bytes().all(|b| b.is_ascii_digit()) {
                    return Err(format!(
                        "fail-closed: malformed Content-Length header '{val_trimmed}'"
                    ));
                }
                let parsed = val_trimmed.parse::<usize>().map_err(|_| {
                    format!("fail-closed: invalid Content-Length header '{val_trimmed}'")
                })?;
                content_length_value = Some(parsed);
            }
            if name_trimmed.eq_ignore_ascii_case("transfer-encoding") {
                has_transfer_encoding = true;
                let tokens: Vec<String> = val_trimmed
                    .split(',')
                    .map(|t| t.trim().to_ascii_lowercase())
                    .collect();
                if tokens.is_empty() || tokens.iter().any(|t| t.is_empty()) {
                    return Err("fail-closed: malformed Transfer-Encoding header".to_string());
                }
                for tok in &tokens {
                    if tok != "chunked" {
                        return Err(format!(
                            "fail-closed: unsupported Transfer-Encoding '{tok}' refused"
                        ));
                    }
                    if is_chunked {
                        return Err(
                            "fail-closed: duplicate chunked Transfer-Encoding refused".to_string()
                        );
                    }
                    is_chunked = true;
                }
            }
            if name_trimmed.eq_ignore_ascii_case("host") {
                host_header_count += 1;
                if host_header_count > 1 {
                    return Err("fail-closed: duplicate Host header".to_string());
                }
                if normalize_host(val_trimmed) != target_host {
                    return Err(format!(
                        "fail-closed: Host header '{}' does not match target host '{}'",
                        val_trimmed, target_host
                    ));
                }
            }

            headers.push((name_trimmed.to_string(), val_trimmed.to_string()));
        }

        if host_header_count != 1 {
            return Err("fail-closed: missing Host header".to_string());
        }
        if has_transfer_encoding && content_length_count > 0 {
            return Err(
                "fail-closed: Transfer-Encoding and Content-Length together are refused (smuggling)"
                    .to_string(),
            );
        }
        if let Some(cl) = content_length_value {
            if cl != body_bytes.len() {
                return Err(format!(
                    "fail-closed: Content-Length ({cl}) does not match body length ({})",
                    body_bytes.len()
                ));
            }
        }

        let decoded_chunked_body = if is_chunked {
            Some(decode_chunked_without_trailers(body_bytes)?)
        } else {
            None
        };

        // Match rules strictly by host, method, and path_prefix.
        let matching_rules: Vec<&CredentialRule> = self
            .rules
            .iter()
            .filter(|rule| {
                !rule.placeholder.is_empty()
                    && normalize_host(&rule.host) == target_host
                    && rule.methods.iter().any(|m| m.eq_ignore_ascii_case(method))
                    && req_path.starts_with(&rule.path_prefix)
            })
            .collect();

        if matching_rules.is_empty() {
            return Err(format!(
                "fail-closed: no credential broker policy matches {method} {target_host}{req_path}"
            ));
        }

        // Substitute placeholder -> real_secret in header values and body ONLY for matching rules.
        // For chunked requests, refuse fail-closed if any matching placeholder appears in the
        // body so raw byte replacement can never corrupt chunk-size framing.
        let rewritten_body = if let Some(ref decoded) = decoded_chunked_body {
            for rule in &matching_rules {
                if find_subsequence(decoded, rule.placeholder.as_bytes()).is_some()
                    || find_subsequence(body_bytes, rule.placeholder.as_bytes()).is_some()
                {
                    return Err(
                        "fail-closed: Transfer-Encoding: chunked body mutation refused".to_string(),
                    );
                }
            }
            body_bytes.to_vec()
        } else {
            let mut body_out = body_bytes.to_vec();
            for rule in &matching_rules {
                body_out = replace_bytes(
                    &body_out,
                    rule.placeholder.as_bytes(),
                    rule.real_secret.as_bytes(),
                );
            }
            body_out
        };

        let mut out_headers: Vec<(String, String)> = Vec::with_capacity(headers.len() + 1);
        let mut has_content_length = false;

        for (name, mut value) in headers {
            if name.eq_ignore_ascii_case("connection")
                || name.eq_ignore_ascii_case("proxy-connection")
            {
                continue;
            }
            for rule in &matching_rules {
                if value.contains(&rule.placeholder) {
                    value = value.replace(&rule.placeholder, &rule.real_secret);
                }
            }
            if name.eq_ignore_ascii_case("content-length") {
                has_content_length = true;
                out_headers.push((name, rewritten_body.len().to_string()));
            } else {
                out_headers.push((name, value));
            }
        }

        // Always force `Connection: close` so subsequent requests on a reused socket cannot
        // bypass inspection.
        out_headers.push(("Connection".to_string(), "close".to_string()));

        // Preserve Content-Length accuracy if body was present and Content-Length was set.
        let _ = has_content_length;

        let mut out = Vec::with_capacity(raw_request.len() + 64);
        out.extend_from_slice(request_line.as_bytes());
        out.extend_from_slice(b"\r\n");
        for (name, value) in out_headers {
            out.extend_from_slice(name.as_bytes());
            out.extend_from_slice(b": ");
            out.extend_from_slice(value.as_bytes());
            out.extend_from_slice(b"\r\n");
        }
        out.extend_from_slice(b"\r\n");
        out.extend_from_slice(&rewritten_body);

        Ok(out)
    }
}

fn extract_and_validate_request_path<'a>(
    target: &'a str,
    target_host: &str,
) -> Result<&'a str, String> {
    let path_and_query = if let Some(rest) = target
        .strip_prefix("http://")
        .or_else(|| target.strip_prefix("https://"))
    {
        let (authority, path) = match rest.find('/') {
            Some(idx) => (&rest[..idx], &rest[idx..]),
            None => return Err(format!("malformed absolute-form HTTP request target: {target}")),
        };
        if authority.is_empty() || authority.contains('@') {
            return Err(format!(
                "fail-closed: invalid absolute-form URI authority '{authority}'"
            ));
        }
        if normalize_host(authority) != target_host {
            return Err(format!(
                "fail-closed: absolute-form URI authority '{authority}' does not match target host '{target_host}'"
            ));
        }
        path
    } else if target.starts_with('/') {
        target
    } else {
        return Err(format!("malformed HTTP request target: {target}"));
    };

    if path_and_query.contains('#') {
        return Err("fail-closed: fragment '#' not permitted in HTTP request target".to_string());
    }
    let path = path_and_query.split('?').next().unwrap_or(path_and_query);
    if path.contains('\\') {
        return Err("fail-closed: backslash path traversal refused".to_string());
    }
    for segment in path.split('/') {
        if segment == ".." || segment == "." {
            return Err(format!(
                "fail-closed: dot-segment path traversal refused in '{path}'"
            ));
        }
    }
    // Reject percent-encoded dots (%2e), slashes (%2f), backslashes (%5c), NUL (%00), or
    // malformed percent escapes so encoded traversal cannot bypass path_prefix matching.
    let bytes = path.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            if i + 2 >= bytes.len() {
                return Err(format!(
                    "fail-closed: malformed percent-encoding in request path '{path}'"
                ));
            }
            let hi = (bytes[i + 1] as char).to_digit(16);
            let lo = (bytes[i + 2] as char).to_digit(16);
            let Some((h, l)) = hi.zip(lo) else {
                return Err(format!(
                    "fail-closed: malformed percent-encoding in request path '{path}'"
                ));
            };
            let decoded = ((h << 4) | l) as u8;
            if matches!(decoded, b'.' | b'/' | b'\\' | 0) {
                return Err(format!(
                    "fail-closed: percent-encoded path traversal refused in '{path}'"
                ));
            }
            i += 3;
        } else {
            i += 1;
        }
    }
    Ok(path)
}

fn decode_chunked_without_trailers(body: &[u8]) -> Result<Vec<u8>, String> {
    let mut cursor = 0usize;
    let mut decoded = Vec::new();
    loop {
        let rel_crlf = find_subsequence(&body[cursor..], b"\r\n")
            .ok_or_else(|| "fail-closed: malformed chunked body (missing chunk size CRLF)".to_string())?;
        let size_line = std::str::from_utf8(&body[cursor..cursor + rel_crlf])
            .map_err(|_| "fail-closed: non-UTF8 chunk size line".to_string())?;
        let size_hex = size_line.split(';').next().unwrap_or("").trim();
        let chunk_size = usize::from_str_radix(size_hex, 16)
            .map_err(|_| format!("fail-closed: invalid chunk size '{size_hex}'"))?;
        cursor += rel_crlf + 2;

        if chunk_size == 0 {
            // Only an immediate `\r\n` with zero trailer headers is permitted.
            if &body[cursor..] == b"\r\n" {
                return Ok(decoded);
            }
            return Err(
                "fail-closed: Transfer-Encoding: chunked trailers are refused".to_string(),
            );
        }

        if cursor.checked_add(chunk_size).and_then(|n| n.checked_add(2)).map_or(true, |end| end > body.len()) {
            return Err("fail-closed: truncated chunked body".to_string());
        }
        if &body[cursor + chunk_size..cursor + chunk_size + 2] != b"\r\n" {
            return Err("fail-closed: missing CRLF after chunk payload".to_string());
        }
        decoded.extend_from_slice(&body[cursor..cursor + chunk_size]);
        cursor += chunk_size + 2;
    }
}

fn find_subsequence(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    if needle.is_empty() || needle.len() > haystack.len() {
        return None;
    }
    haystack.windows(needle.len()).position(|w| w == needle)
}

fn replace_bytes(input: &[u8], needle: &[u8], replacement: &[u8]) -> Vec<u8> {
    if needle.is_empty() || needle.len() > input.len() {
        return input.to_vec();
    }
    let mut out = Vec::with_capacity(input.len());
    let mut i = 0;
    while i < input.len() {
        if i + needle.len() <= input.len() && &input[i..i + needle.len()] == needle {
            out.extend_from_slice(replacement);
            i += needle.len();
        } else {
            out.push(input[i]);
            i += 1;
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{BufReader, Read, Write};
    use std::net::TcpListener;
    use std::thread;

    use rustls::client::ClientConnection;
    use rustls::{ClientConfig, RootCertStore, ServerConnection};

    #[test]
    fn ephemeral_ca_writes_public_pem_only_and_exports_standard_env_vars() {
        let ca = EphemeralCa::new().expect("ephemeral ca");
        let pem_path = ca.ca_pem_path().to_path_buf();
        assert!(pem_path.exists(), "temp CA PEM file should exist");

        let disk_pem = fs::read_to_string(&pem_path).expect("read pem");
        assert!(disk_pem.contains("BEGIN CERTIFICATE"));
        assert!(!disk_pem.contains("PRIVATE KEY"), "private key must never touch disk");

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = fs::metadata(&pem_path).expect("meta").permissions().mode() & 0o777;
            assert_eq!(mode, 0o600, "CA PEM temp file must be 0600 on Unix");
        }

        let env_vars = ca.ca_env_vars();
        assert_eq!(env_vars.len(), STANDARD_CA_ENV_VARS.len());
        let expected_names = [
            "SSL_CERT_FILE",
            "NODE_EXTRA_CA_CERTS",
            "REQUESTS_CA_BUNDLE",
            "CURL_CA_BUNDLE",
            "PIP_CERT",
            "GIT_SSL_CAINFO",
            "CARGO_HTTP_CAINFO",
            "AWS_CA_BUNDLE",
            "GRPC_DEFAULT_SSL_ROOTS_FILE_PATH",
            "npm_config_cafile",
            "BUNDLE_SSL_CA_CERT",
        ];
        for name in expected_names {
            let found = env_vars
                .iter()
                .find(|(k, _)| *k == name)
                .expect("missing standard CA env var");
            assert_eq!(found.1, pem_path.to_string_lossy());
        }

        drop(ca);
        assert!(!pem_path.exists(), "temp CA PEM file should be removed on drop");
    }

    #[test]
    fn leaf_cert_lru_cache_hits_and_evicts_at_bound() {
        let ca = EphemeralCa::with_cache_capacity(3).expect("ephemeral ca");
        let a1 = ca.mint_or_get_leaf_cert("a.example.com").expect("a");
        let a2 = ca.mint_or_get_leaf_cert("A.EXAMPLE.COM:443").expect("a hit");
        assert!(Arc::ptr_eq(&a1, &a2), "normalized host should hit LRU cache");

        let _b = ca.mint_or_get_leaf_cert("b.example.com").expect("b");
        let _c = ca.mint_or_get_leaf_cert("c.example.com").expect("c");
        assert_eq!(ca.cache_len(), 3);

        // Touch `a.example.com` so `b.example.com` becomes least-recently-used.
        let _a3 = ca.mint_or_get_leaf_cert("a.example.com").expect("a touch");
        let _d = ca.mint_or_get_leaf_cert("d.example.com").expect("d evicts b");
        assert_eq!(ca.cache_len(), 3);

        let cache = ca.leaf_cache.lock().expect("lock");
        assert!(cache.contains("a.example.com"));
        assert!(!cache.contains("b.example.com"), "LRU entry b should be evicted");
        assert!(cache.contains("c.example.com"));
        assert!(cache.contains("d.example.com"));
    }

    #[test]
    fn ephemeral_ca_minted_leaf_completes_real_localhost_rustls_handshake() {
        let ca = EphemeralCa::new().expect("ephemeral ca");
        let leaf = ca.mint_or_get_leaf_cert("localhost").expect("mint localhost leaf");
        let server_cfg = leaf.server_config.clone();

        // Parse ONLY the on-disk public CA PEM via rustls-pemfile to verify the real trust chain.
        let pem_file = fs::File::open(ca.ca_pem_path()).expect("open ca pem");
        let mut reader = BufReader::new(pem_file);
        let ca_certs: Vec<CertificateDer<'static>> = rustls_pemfile::certs(&mut reader)
            .collect::<Result<Vec<_>, _>>()
            .expect("parse ca pem");
        assert_eq!(ca_certs.len(), 1);

        let mut roots = RootCertStore::empty();
        roots.add(ca_certs[0].clone()).expect("trust ephemeral ca");
        let client_cfg = Arc::new(
            ClientConfig::builder()
                .with_root_certificates(roots)
                .with_no_client_auth(),
        );

        let listener = TcpListener::bind("127.0.0.1:0").expect("listen");
        let port = listener.local_addr().expect("addr").port();

        let server = thread::spawn(move || {
            let (mut tcp, _) = listener.accept().expect("accept");
            let mut tls = ServerConnection::new(server_cfg).expect("server tls");
            while tls.is_handshaking() {
                tls.complete_io(&mut tcp).expect("server handshake io");
            }
            let mut buf = [0u8; 64];
            let mut received = Vec::new();
            while received.is_empty() {
                tls.complete_io(&mut tcp).expect("server read io");
                if let Ok(n) = tls.reader().read(&mut buf) {
                    if n > 0 {
                        received.extend_from_slice(&buf[..n]);
                    }
                }
            }
            received
        });

        let mut tcp = std::net::TcpStream::connect(("127.0.0.1", port)).expect("connect");
        let server_name = rustls::pki_types::ServerName::try_from("localhost").expect("sni");
        let mut client = ClientConnection::new(client_cfg, server_name).expect("client tls");
        client
            .writer()
            .write_all(b"GET /hermetic HTTP/1.1\r\nHost: localhost\r\n\r\n")
            .expect("write");
        while client.is_handshaking() || client.wants_write() {
            client.complete_io(&mut tcp).expect("client io");
        }
        assert!(!client.is_handshaking());
        let received = server.join().expect("server thread");
        assert!(received.starts_with(b"GET /hermetic HTTP/1.1"));
    }

    #[test]
    fn selective_mitm_terminates_only_brokered_hosts() {
        let broker = CredentialBroker::new(vec![CredentialRule {
            host: "api.openai.com".to_string(),
            methods: vec!["POST".to_string()],
            path_prefix: "/v1/".to_string(),
            placeholder: "HZ_PLACEHOLDER_OPENAI".to_string(),
            real_secret: "sk-real-secret-value".to_string(),
        }]);

        assert!(broker.should_terminate_host("api.openai.com"));
        assert!(broker.should_terminate_host("API.OPENAI.COM:443"));
        assert!(!broker.should_terminate_host("github.com"));
        assert!(!broker.should_terminate_host("evil-api.openai.com"));
        assert!(!broker.should_terminate_host(""));
    }

    #[test]
    fn credential_broker_rewrites_matching_request_and_forces_connection_close() {
        let broker = CredentialBroker::new(vec![CredentialRule {
            host: "api.openai.com".to_string(),
            methods: vec!["POST".to_string()],
            path_prefix: "/v1/".to_string(),
            placeholder: "HZ_SECRET_TOKEN".to_string(),
            real_secret: "sk-live-1234567890".to_string(),
        }]);

        let raw = concat!(
            "POST /v1/responses HTTP/1.1\r\n",
            "Host: api.openai.com\r\n",
            "Authorization: Bearer HZ_SECRET_TOKEN\r\n",
            "Connection: keep-alive\r\n",
            "Content-Length: 27\r\n",
            "\r\n",
            "{\"token\":\"HZ_SECRET_TOKEN\"}"
        );

        let rewritten = broker
            .rewrite_http1_request("api.openai.com", raw.as_bytes())
            .expect("rewrite should succeed");
        let rewritten_str = String::from_utf8(rewritten).expect("utf8");

        assert!(rewritten_str.contains("Authorization: Bearer sk-live-1234567890\r\n"));
        assert!(rewritten_str.contains("{\"token\":\"sk-live-1234567890\"}"));
        assert!(!rewritten_str.contains("HZ_SECRET_TOKEN"));
        assert!(!rewritten_str.to_ascii_lowercase().contains("keep-alive"));
        assert!(rewritten_str.contains("Connection: close\r\n"));
        // Content-Length updated from 27 to 30 ("sk-live-1234567890" is 3 bytes longer than "HZ_SECRET_TOKEN").
        assert!(rewritten_str.contains("Content-Length: 30\r\n"));
    }

    #[test]
    fn credential_broker_fails_closed_on_mismatched_path_method_gzip_and_chunked_trailers() {
        let broker = CredentialBroker::new(vec![CredentialRule {
            host: "api.openai.com".to_string(),
            methods: vec!["POST".to_string()],
            path_prefix: "/v1/".to_string(),
            placeholder: "HZ_SECRET_TOKEN".to_string(),
            real_secret: "sk-live-1234567890".to_string(),
        }]);

        // Mismatched path prefix
        let bad_path = b"POST /v2/admin HTTP/1.1\r\nHost: api.openai.com\r\n\r\n";
        assert!(broker.rewrite_http1_request("api.openai.com", bad_path).is_err());

        // Mismatched method
        let bad_method = b"DELETE /v1/responses HTTP/1.1\r\nHost: api.openai.com\r\n\r\n";
        assert!(broker.rewrite_http1_request("api.openai.com", bad_method).is_err());

        // Compressed body (Content-Encoding: gzip) -> fail-closed
        let gzip_req = concat!(
            "POST /v1/responses HTTP/1.1\r\n",
            "Host: api.openai.com\r\n",
            "Content-Encoding: gzip\r\n",
            "\r\n",
            "compressed"
        );
        let err = broker
            .rewrite_http1_request("api.openai.com", gzip_req.as_bytes())
            .expect_err("gzip must fail closed");
        assert!(err.contains("Content-Encoding"));

        // Chunked trailers -> fail-closed
        let chunked_trailer_req = concat!(
            "POST /v1/responses HTTP/1.1\r\n",
            "Host: api.openai.com\r\n",
            "Transfer-Encoding: chunked\r\n",
            "\r\n",
            "4\r\ntest\r\n0\r\nX-Bypass: 1\r\n\r\n"
        );
        let err = broker
            .rewrite_http1_request("api.openai.com", chunked_trailer_req.as_bytes())
            .expect_err("chunked trailers must fail closed");
        assert!(err.contains("trailers"));

        // Mismatched Host header -> fail-closed
        let bad_host_hdr = b"POST /v1/responses HTTP/1.1\r\nHost: evil.example\r\n\r\n";
        assert!(broker.rewrite_http1_request("api.openai.com", bad_host_hdr).is_err());

        // Incomplete header boundary -> fail-closed
        let incomplete = b"POST /v1/responses HTTP/1.1\r\nHost: api.openai.com\r\n";
        assert!(broker.rewrite_http1_request("api.openai.com", incomplete).is_err());
    }

    #[test]
    fn kernel_terminate_owns_connect_honesty_assertions() {
        // Default zero-arg remains strictly false.
        assert!(!kernel_terminate_owns_connect());

        // Requires BOTH os_egress_confined AND terminator_active.
        assert!(!kernel_terminate_owns_connect_when(false, false));
        assert!(!kernel_terminate_owns_connect_when(true, false));
        assert!(!kernel_terminate_owns_connect_when(false, true));
        assert!(kernel_terminate_owns_connect_when(true, true));

        let unconfined = TerminateRuntimeState::new(false, true, None, vec!["api.openai.com".into()]);
        assert!(!unconfined.owns_connect());
        assert_eq!(unconfined.posture(), "advisory_unconfined");

        let confined = TerminateRuntimeState::new(true, true, None, vec!["api.openai.com".into()]);
        assert!(confined.owns_connect());
        assert_eq!(confined.posture(), "enforced");
    }

    #[test]
    fn credential_broker_blocks_http1_smuggling_and_chunked_corruption() {
        let broker = CredentialBroker::new(vec![CredentialRule {
            host: "api.openai.com".to_string(),
            methods: vec!["POST".to_string()],
            path_prefix: "/v1/".to_string(),
            placeholder: "HZ_SECRET_TOKEN".to_string(),
            real_secret: "sk-live-1234567890".to_string(),
        }]);

        // 1. Transfer-Encoding + Content-Length together
        let te_cl = concat!(
            "POST /v1/responses HTTP/1.1\r\n",
            "Host: api.openai.com\r\n",
            "Transfer-Encoding: chunked\r\n",
            "Content-Length: 5\r\n",
            "\r\n",
            "0\r\n\r\n"
        );
        assert!(broker.rewrite_http1_request("api.openai.com", te_cl.as_bytes()).is_err());

        // 2. Duplicate Content-Length
        let dup_cl = concat!(
            "POST /v1/responses HTTP/1.1\r\n",
            "Host: api.openai.com\r\n",
            "Content-Length: 4\r\n",
            "Content-Length: 4\r\n",
            "\r\n",
            "test"
        );
        assert!(broker.rewrite_http1_request("api.openai.com", dup_cl.as_bytes()).is_err());

        // 3. Content-Length != body.len()
        let bad_cl = concat!(
            "POST /v1/responses HTTP/1.1\r\n",
            "Host: api.openai.com\r\n",
            "Content-Length: 10\r\n",
            "\r\n",
            "short"
        );
        assert!(broker.rewrite_http1_request("api.openai.com", bad_cl.as_bytes()).is_err());

        // 4. Transfer-Encoding containing gzip / unknown
        let te_gzip = concat!(
            "POST /v1/responses HTTP/1.1\r\n",
            "Host: api.openai.com\r\n",
            "Transfer-Encoding: gzip, chunked\r\n",
            "\r\n",
            "0\r\n\r\n"
        );
        assert!(broker.rewrite_http1_request("api.openai.com", te_gzip.as_bytes()).is_err());

        // 5. Chunked body containing placeholder -> fail-closed (no framing corruption)
        let chunked_body_secret = concat!(
            "POST /v1/responses HTTP/1.1\r\n",
            "Host: api.openai.com\r\n",
            "Transfer-Encoding: chunked\r\n",
            "\r\n",
            "f\r\nHZ_SECRET_TOKEN\r\n0\r\n\r\n"
        );
        assert!(broker.rewrite_http1_request("api.openai.com", chunked_body_secret.as_bytes()).is_err());

        // 6. Missing Host header
        let missing_host = b"POST /v1/responses HTTP/1.1\r\nContent-Length: 0\r\n\r\n";
        assert!(broker.rewrite_http1_request("api.openai.com", missing_host).is_err());

        // 7. Dot-segment and percent-encoded path traversal
        let dot_trav = b"POST /v1/../v2/admin HTTP/1.1\r\nHost: api.openai.com\r\n\r\n";
        assert!(broker.rewrite_http1_request("api.openai.com", dot_trav).is_err());
        let pct_trav = b"POST /v1/%2e%2e/admin HTTP/1.1\r\nHost: api.openai.com\r\n\r\n";
        assert!(broker.rewrite_http1_request("api.openai.com", pct_trav).is_err());

        // 8. Mismatched absolute-form URI authority
        let abs_mismatch = b"POST https://evil.example/v1/responses HTTP/1.1\r\nHost: api.openai.com\r\n\r\n";
        assert!(broker.rewrite_http1_request("api.openai.com", abs_mismatch).is_err());

        // 9. Bare LF / bare CR in headers or request line
        let bare_lf = b"POST /v1/responses HTTP/1.1\r\nHost: api.openai.com\nX-Injected: 1\r\n\r\n";
        assert!(broker.rewrite_http1_request("api.openai.com", bare_lf).is_err());
        let bare_cr = b"POST /v1/responses HTTP/1.1\rX-Bad: 1\r\nHost: api.openai.com\r\n\r\n";
        assert!(broker.rewrite_http1_request("api.openai.com", bare_cr).is_err());
    }
}
