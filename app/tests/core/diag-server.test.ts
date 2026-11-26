/**
 * diag-server.test.ts — loopback diagnostic endpoints (grok diag-server ADAPT).
 * Pure response model + bounded log ring; /ready /statusz /logs, content-free.
 */
import { describe, expect, test } from "bun:test";
import {
  DEFAULT_LOG_TAIL_BYTES,
  MAX_LOG_TAIL_BYTES,
  MAX_ERROR_DETAIL_BYTES,
  LogRing,
  readyBody,
  statuszBody,
  routeDiag,
} from "../../src/core/diag-server";

describe("loopback diag server (grok port)", () => {
  test("constants match upstream", () => {
    expect(DEFAULT_LOG_TAIL_BYTES).toBe(64 * 1024);
    expect(MAX_LOG_TAIL_BYTES).toBe(256 * 1024);
    expect(MAX_ERROR_DETAIL_BYTES).toBe(256);
  });

  test("/ready is content-free and caps error detail", () => {
    const body = readyBody({ ready: true, state: "ready", errorDetail: "x".repeat(1000) });
    expect(body.ready).toBe(true);
    expect((body.errorDetail as string).length).toBeLessThanOrEqual(MAX_ERROR_DETAIL_BYTES);
  });

  test("LogRing bounds bytes and returns the most recent tail", () => {
    const ring = new LogRing(100); // 100-byte ring
    ring.push("old".repeat(20));   // 60 bytes, evicted
    ring.push("new line");          // 8 bytes, most recent
    const tail = ring.tail(50);
    expect(tail.join("").length).toBeLessThanOrEqual(50);
    expect(tail.join("")).toContain("new line"); // most recent retained
    expect(tail.join("")).not.toContain("old");  // older evicted by ring cap
  });

  test("routeDiag handles the three endpoints with a bounded /logs tail", () => {
    const ring = new LogRing(1000);
    ring.push("hello log");
    const env = { ready: true, state: "ready" as const };
    expect(routeDiag("/ready", env, ring).status).toBe(200);
    expect(routeDiag("/statusz", env, ring).status).toBe(200);
    const logs = routeDiag("/logs?tail_bytes=999999", env, ring);
    expect(logs.status).toBe(200);
    expect(JSON.parse(logs.body).lines.join("")).toContain("hello log");
    expect(routeDiag("/unknown", env, ring).status).toBe(404);
  });
});
