//! TLS terminate precursor stub (ruling **283**) — advisory only.
//!
//! Production CONNECT terminate is implemented in TypeScript (`egress-tls-terminate.ts`).
//! This module holds env gates and a rustls handshake smoke test proving the acceptor path.

pub use crate::egress_tls_intercept::terminate_enabled_from_env;

/// Kernel CONNECT listener does not terminate TLS in-process yet; TS owns the precursor.
pub fn kernel_terminate_owns_connect() -> bool {
    false
}

#[cfg(test)]
mod tests {
    use std::io::Write;
    use std::net::TcpListener;
    use std::sync::Arc;
    use std::thread;

    use rustls::pki_types::{CertificateDer, PrivateKeyDer};
    use rustls::{ClientConfig, RootCertStore, ServerConfig, ServerConnection};
    use rustls::client::ClientConnection;

    #[test]
    fn rustls_acceptor_completes_handshake_with_test_client() {
        let issued = rcgen::generate_simple_self_signed(vec!["localhost".to_string()]).expect("cert");
        let cert_der = CertificateDer::from(issued.cert.der().to_vec());
        let key_der = PrivateKeyDer::try_from(issued.key_pair.serialize_der()).expect("key");
        let server_cfg = Arc::new(
            ServerConfig::builder()
                .with_no_client_auth()
                .with_single_cert(vec![cert_der.clone()], key_der)
                .expect("server config"),
        );

        let mut roots = RootCertStore::empty();
        roots.add(cert_der).expect("trust anchor");
        let client_cfg = Arc::new(
            ClientConfig::builder()
                .with_root_certificates(roots)
                .with_no_client_auth(),
        );

        let listener = TcpListener::bind("127.0.0.1:0").expect("listen");
        let port = listener.local_addr().expect("addr").port();

        let server_cfg_thread = server_cfg.clone();
        let server = thread::spawn(move || {
            let (mut tcp, _) = listener.accept().expect("accept");
            let mut tls = ServerConnection::new(server_cfg_thread).expect("server tls");
            while tls.is_handshaking() {
                tls.complete_io(&mut tcp).expect("server handshake io");
            }
        });

        let mut tcp = std::net::TcpStream::connect(("127.0.0.1", port)).expect("connect");
        let server_name = rustls::pki_types::ServerName::try_from("localhost").expect("sni");
        let mut client = ClientConnection::new(client_cfg, server_name).expect("client tls");
        client
            .writer()
            .write_all(b"GET /hermetic HTTP/1.1\r\n\r\n")
            .expect("write");
        while client.is_handshaking() {
            client.complete_io(&mut tcp).expect("client handshake io");
        }
        assert!(!client.is_handshaking());
        server.join().expect("server thread");
    }
}
