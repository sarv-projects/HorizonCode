import { describe, expect, test } from "bun:test";
import { egressTlsPeekEnabled, parseTlsClientHelloSni } from "../../src/core/egress-tls-peek";
import { tlsClientHelloWithSni } from "../fixtures/tls-client-hello";

describe("egress TLS ClientHello SNI peek", () => {
  test("parses SNI from fixture ClientHello", () => {
    const hello = tlsClientHelloWithSni("api.example.test");
    expect(parseTlsClientHelloSni(hello)).toBe("api.example.test");
  });

  test("returns undefined for truncated or non-TLS bytes", () => {
    const hello = tlsClientHelloWithSni("short.test");
    expect(parseTlsClientHelloSni(hello.subarray(0, 4))).toBeUndefined();
    expect(parseTlsClientHelloSni(Buffer.from("GET / HTTP/1.1\r\n"))).toBeUndefined();
  });

  test("HZ_EGRESS_TLS_PEEK env gate", () => {
    expect(egressTlsPeekEnabled({})).toBe(false);
    expect(egressTlsPeekEnabled({ HZ_EGRESS_TLS_PEEK: "1" })).toBe(true);
    expect(egressTlsPeekEnabled({ HZ_EGRESS_TLS_PEEK: "true" })).toBe(true);
  });
});
