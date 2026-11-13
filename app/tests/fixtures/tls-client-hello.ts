/** Hermetic TLS 1.2 ClientHello with a single host_name SNI entry (test fixture). */
export function tlsClientHelloWithSni(hostname: string): Buffer {
  const hostBytes = Buffer.from(hostname, "utf8");
  const sniEntry = Buffer.alloc(3 + hostBytes.length);
  sniEntry[0] = 0;
  sniEntry.writeUInt16BE(hostBytes.length, 1);
  hostBytes.copy(sniEntry, 3);

  const sniList = Buffer.alloc(2 + sniEntry.length);
  sniList.writeUInt16BE(sniEntry.length, 0);
  sniEntry.copy(sniList, 2);

  const sniExt = Buffer.alloc(4 + sniList.length);
  sniExt.writeUInt16BE(0, 0);
  sniExt.writeUInt16BE(sniList.length, 2);
  sniList.copy(sniExt, 4);

  const sessionId = Buffer.alloc(0);
  const cipherSuites = Buffer.from([0x13, 0x01]);
  const compression = Buffer.from([0x00]);

  const extensions = sniExt;
  const helloBody = Buffer.alloc(
    2 + 32 + 1 + sessionId.length + 2 + cipherSuites.length + 1 + compression.length + 2 + extensions.length,
  );
  let o = 0;
  helloBody.writeUInt16BE(0x0303, o);
  o += 2;
  Buffer.alloc(32, 0xab).copy(helloBody, o);
  o += 32;
  helloBody[o++] = sessionId.length;
  sessionId.copy(helloBody, o);
  o += sessionId.length;
  helloBody.writeUInt16BE(cipherSuites.length, o);
  o += 2;
  cipherSuites.copy(helloBody, o);
  o += cipherSuites.length;
  helloBody[o++] = compression.length;
  compression.copy(helloBody, o);
  o += compression.length;
  helloBody.writeUInt16BE(extensions.length, o);
  o += 2;
  extensions.copy(helloBody, o);

  const handshake = Buffer.alloc(4 + helloBody.length);
  handshake[0] = 0x01;
  handshake[1] = (helloBody.length >> 16) & 0xff;
  handshake[2] = (helloBody.length >> 8) & 0xff;
  handshake[3] = helloBody.length & 0xff;
  helloBody.copy(handshake, 4);

  const record = Buffer.alloc(5 + handshake.length);
  record[0] = 0x16;
  record[1] = 0x03;
  record[2] = 0x01;
  record.writeUInt16BE(handshake.length, 3);
  handshake.copy(record, 5);
  return record;
}
