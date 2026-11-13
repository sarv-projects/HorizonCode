//! Read-only TLS ClientHello SNI parse (TS `egress-tls-peek.ts` parity).

const TLS_CONTENT_HANDSHAKE: u8 = 0x16;
const HANDSHAKE_CLIENT_HELLO: u8 = 0x01;
const EXT_SERVER_NAME: u16 = 0x0000;
const SNI_HOST_NAME: u8 = 0;

pub fn tls_peek_enabled_from_env() -> bool {
    match std::env::var("HZ_EGRESS_TLS_PEEK") {
        Ok(raw) => {
            let s = raw.trim();
            s == "1" || s.eq_ignore_ascii_case("true")
        }
        Err(_) => false,
    }
}

/// Best-effort SNI hostname from a TLS record buffer (first ClientHello only).
pub fn parse_tls_client_hello_sni(bytes: &[u8]) -> Option<String> {
    if bytes.len() < 5 || bytes[0] != TLS_CONTENT_HANDSHAKE {
        return None;
    }
    let record_len = u16::from_be_bytes([bytes[3], bytes[4]]) as usize;
    if bytes.len() < 5 + record_len {
        return None;
    }
    let handshake = &bytes[5..5 + record_len];
    if handshake.len() < 4 || handshake[0] != HANDSHAKE_CLIENT_HELLO {
        return None;
    }
    let hello_len = ((handshake[1] as usize) << 16) | ((handshake[2] as usize) << 8) | handshake[3] as usize;
    if handshake.len() < 4 + hello_len {
        return None;
    }
    let body = &handshake[4..4 + hello_len];
    let mut offset = 0usize;
    if body.len() < 2 + 32 + 1 {
        return None;
    }
    offset += 2; // client_version
    offset += 32; // random
    let session_id_len = body[offset] as usize;
    offset += 1 + session_id_len;
    if body.len() < offset + 2 {
        return None;
    }
    let cipher_suites_len = u16::from_be_bytes([body[offset], body[offset + 1]]) as usize;
    offset += 2 + cipher_suites_len;
    if body.len() < offset + 1 {
        return None;
    }
    let compression_len = body[offset] as usize;
    offset += 1 + compression_len;
    if body.len() < offset + 2 {
        return None;
    }
    let extensions_len = u16::from_be_bytes([body[offset], body[offset + 1]]) as usize;
    offset += 2;
    let extensions_end = offset + extensions_len;
    if body.len() < extensions_end {
        return None;
    }
    while offset + 4 <= extensions_end {
        let ext_type = u16::from_be_bytes([body[offset], body[offset + 1]]);
        offset += 2;
        let ext_data_len = u16::from_be_bytes([body[offset], body[offset + 1]]) as usize;
        offset += 2;
        if offset + ext_data_len > extensions_end {
            return None;
        }
        if ext_type == EXT_SERVER_NAME {
            if let Some(host) = parse_server_name_extension(&body[offset..offset + ext_data_len]) {
                return Some(host);
            }
        }
        offset += ext_data_len;
    }
    None
}

fn parse_server_name_extension(ext_data: &[u8]) -> Option<String> {
    if ext_data.len() < 2 {
        return None;
    }
    let list_len = u16::from_be_bytes([ext_data[0], ext_data[1]]) as usize;
    if ext_data.len() < 2 + list_len {
        return None;
    }
    let mut pos = 2usize;
    let list_end = 2 + list_len;
    while pos + 3 <= list_end {
        let name_type = ext_data[pos];
        pos += 1;
        let name_len = u16::from_be_bytes([ext_data[pos], ext_data[pos + 1]]) as usize;
        pos += 2;
        if pos + name_len > list_end {
            return None;
        }
        if name_type == SNI_HOST_NAME {
            return std::str::from_utf8(&ext_data[pos..pos + name_len])
                .ok()
                .map(|s| s.to_string());
        }
        pos += name_len;
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tls_client_hello_with_sni(hostname: &str) -> Vec<u8> {
        let host_bytes = hostname.as_bytes();
        let sni_entry_len = 3 + host_bytes.len();
        let sni_list_len = 2 + sni_entry_len;
        let sni_ext_len = 4 + sni_list_len;

        let mut sni_ext = vec![0u8; sni_ext_len];
        sni_ext[0..2].copy_from_slice(&EXT_SERVER_NAME.to_be_bytes());
        sni_ext[2..4].copy_from_slice(&(sni_list_len as u16).to_be_bytes());
        sni_ext[4..6].copy_from_slice(&(sni_entry_len as u16).to_be_bytes());
        sni_ext[6] = SNI_HOST_NAME;
        sni_ext[7..9].copy_from_slice(&(host_bytes.len() as u16).to_be_bytes());
        sni_ext[9..9 + host_bytes.len()].copy_from_slice(host_bytes);

        let session_id_len = 0usize;
        let cipher_suites: [u8; 2] = [0x13, 0x01];
        let compression: [u8; 1] = [0x00];
        let hello_body_len = 2 + 32 + 1 + session_id_len + 2 + cipher_suites.len() + 1 + compression.len() + 2 + sni_ext_len;
        let mut hello_body = vec![0u8; hello_body_len];
        let mut o = 0usize;
        hello_body[o..o + 2].copy_from_slice(&0x0303u16.to_be_bytes());
        o += 2;
        hello_body[o..o + 32].fill(0xab);
        o += 32;
        hello_body[o] = session_id_len as u8;
        o += 1;
        hello_body[o..o + 2].copy_from_slice(&(cipher_suites.len() as u16).to_be_bytes());
        o += 2;
        hello_body[o..o + cipher_suites.len()].copy_from_slice(&cipher_suites);
        o += cipher_suites.len();
        hello_body[o] = compression.len() as u8;
        o += 1;
        hello_body[o..o + compression.len()].copy_from_slice(&compression);
        o += compression.len();
        hello_body[o..o + 2].copy_from_slice(&(sni_ext_len as u16).to_be_bytes());
        o += 2;
        hello_body[o..o + sni_ext_len].copy_from_slice(&sni_ext);

        let handshake_len = 4 + hello_body.len();
        let mut handshake = vec![0u8; handshake_len];
        handshake[0] = HANDSHAKE_CLIENT_HELLO;
        handshake[1] = ((hello_body.len() >> 16) & 0xff) as u8;
        handshake[2] = ((hello_body.len() >> 8) & 0xff) as u8;
        handshake[3] = (hello_body.len() & 0xff) as u8;
        handshake[4..].copy_from_slice(&hello_body);

        let mut record = vec![0u8; 5 + handshake.len()];
        record[0] = TLS_CONTENT_HANDSHAKE;
        record[1] = 0x03;
        record[2] = 0x01;
        record[3..5].copy_from_slice(&(handshake.len() as u16).to_be_bytes());
        record[5..].copy_from_slice(&handshake);
        record
    }

    #[test]
    fn parse_sni_matches_fixture_shape() {
        let host = "tls-peek.hermetic.test";
        let record = tls_client_hello_with_sni(host);
        assert_eq!(parse_tls_client_hello_sni(&record).as_deref(), Some(host));
    }

    #[test]
    fn parse_returns_none_for_short_buffer() {
        assert!(parse_tls_client_hello_sni(&[0x16, 0x03, 0x01]).is_none());
    }
}
