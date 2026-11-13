/**
 * Read-only TLS ClientHello SNI peek (docs/33 §5.2 — doctor / logging only).
 *
 * Does not terminate TLS, decrypt payload, or enforce egress. Parses the
 * cleartext ClientHello prefix when present on a CONNECT byte stream.
 */

const TLS_CONTENT_HANDSHAKE = 0x16;
const HANDSHAKE_CLIENT_HELLO = 0x01;
const EXT_SERVER_NAME = 0x0000;
const SNI_HOST_NAME = 0;

export function egressTlsPeekEnabled(env: Record<string, string | undefined> = process.env): boolean {
  const raw = env.HZ_EGRESS_TLS_PEEK;
  if (raw === "1") return true;
  if (typeof raw === "string" && raw.trim().toLowerCase() === "true") return true;
  return false;
}

/**
 * Best-effort SNI hostname from a TLS record buffer (may include multiple records;
 * only the first Handshake record is inspected). Returns undefined when bytes are
 * incomplete, not a ClientHello, or carry no host_name entry.
 */
export function parseTlsClientHelloSni(bytes: Uint8Array | Buffer): string | undefined {
  const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  if (buf.length < 5) return undefined;
  if (buf[0] !== TLS_CONTENT_HANDSHAKE) return undefined;

  const recordLen = buf.readUInt16BE(3);
  if (buf.length < 5 + recordLen) return undefined;

  const handshake = buf.subarray(5, 5 + recordLen);
  if (handshake.length < 4 || handshake[0] !== HANDSHAKE_CLIENT_HELLO) return undefined;

  const helloLen = (handshake[1]! << 16) | (handshake[2]! << 8) | handshake[3]!;
  if (handshake.length < 4 + helloLen) return undefined;

  const body = handshake.subarray(4, 4 + helloLen);
  let offset = 0;
  if (body.length < 2 + 32 + 1) return undefined;
  offset += 2; // client_version
  offset += 32; // random
  const sessionIdLen = body[offset]!;
  offset += 1 + sessionIdLen;
  if (body.length < offset + 2) return undefined;
  const cipherSuitesLen = body.readUInt16BE(offset);
  offset += 2 + cipherSuitesLen;
  if (body.length < offset + 1) return undefined;
  const compressionLen = body[offset]!;
  offset += 1 + compressionLen;
  if (body.length < offset + 2) return undefined;
  const extensionsLen = body.readUInt16BE(offset);
  offset += 2;
  const extensionsEnd = offset + extensionsLen;
  if (body.length < extensionsEnd) return undefined;

  while (offset + 4 <= extensionsEnd) {
    const extType = body.readUInt16BE(offset);
    offset += 2;
    const extDataLen = body.readUInt16BE(offset);
    offset += 2;
    if (offset + extDataLen > extensionsEnd) return undefined;
    if (extType === EXT_SERVER_NAME) {
      const host = parseServerNameExtension(body.subarray(offset, offset + extDataLen));
      if (host !== undefined) return host;
    }
    offset += extDataLen;
  }
  return undefined;
}

function parseServerNameExtension(extData: Buffer): string | undefined {
  if (extData.length < 2) return undefined;
  const listLen = extData.readUInt16BE(0);
  if (extData.length < 2 + listLen) return undefined;
  let pos = 2;
  const listEnd = 2 + listLen;
  while (pos + 3 <= listEnd) {
    const nameType = extData[pos]!;
    pos += 1;
    const nameLen = extData.readUInt16BE(pos);
    pos += 2;
    if (pos + nameLen > listEnd) return undefined;
    if (nameType === SNI_HOST_NAME) {
      return extData.subarray(pos, pos + nameLen).toString("utf8");
    }
    pos += nameLen;
  }
  return undefined;
}
