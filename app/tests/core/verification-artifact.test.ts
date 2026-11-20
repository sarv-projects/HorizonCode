import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import {
  buildVerificationArtifact,
  screenshotEntry,
  writeVerificationArtifact,
} from "../../src/core/verification-artifact";
import { captureBrowserScreenshot } from "../../src/core/browser-cdp";

describe("verification-artifact + browser CDP (ruling 643)", () => {
  test("buildVerificationArtifact digests stably", () => {
    const a = buildVerificationArtifact({
      goal: "fix login",
      plan: "1. reproduce\n2. patch",
      diffSummary: "app/login.ts +12/-3",
      testOutput: "ok 3 passed",
      receiptChain: [{ receiptId: "r1", digest: "abc" }],
      createdAt: "2026-11-19T00:00:00.000Z",
    });
    expect(a.schema).toBe("hz.verification.artifact.v1");
    expect(a.artifactDigest).toMatch(/^[a-f0-9]{64}$/);
    const b = buildVerificationArtifact({
      goal: "fix login",
      plan: "1. reproduce\n2. patch",
      diffSummary: "app/login.ts +12/-3",
      testOutput: "ok 3 passed",
      receiptChain: [{ receiptId: "r1", digest: "abc" }],
      createdAt: "2026-11-19T00:00:00.000Z",
    });
    expect(b.artifactDigest).toBe(a.artifactDigest);
  });

  test("writeVerificationArtifact persists JSON", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "hz-va-"));
    try {
      const artifact = buildVerificationArtifact({ goal: "ship proof" });
      const out = await writeVerificationArtifact(dir, artifact);
      const loaded = JSON.parse(readFileSync(out, "utf8"));
      expect(loaded.artifactDigest).toBe(artifact.artifactDigest);
      expect(screenshotEntry("x.png", Buffer.from("png")).sha256).toMatch(/^[a-f0-9]{64}$/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("captureBrowserScreenshot rejects traversal fileName", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "hz-cdp-trav-"));
    try {
      const pngB64 = Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString("base64");
      type Handler = (ev: { data?: unknown }) => void;
      const handlers: Record<string, Handler[]> = {};
      const ws = {
        readyState: 1,
        send(data: string) {
          const req = JSON.parse(data) as { id: number; method: string };
          const result = req.method === "Page.captureScreenshot" ? { data: pngB64 } : {};
          for (const h of handlers.message ?? []) {
            h({ data: JSON.stringify({ id: req.id, result }) });
          }
        },
        close() {},
        addEventListener(type: string, fn: Handler) {
          (handlers[type] ??= []).push(fn);
        },
      };
      const res = await captureBrowserScreenshot({
        workspace: dir,
        endpoint: "http://cdp.test",
        fileName: "../../outside.png",
        fetchImpl: (async () =>
          ({
            ok: true,
            json: async () => [
              {
                id: "1",
                title: "t",
                url: "http://localhost/",
                type: "page",
                webSocketDebuggerUrl: "ws://cdp.test/devtools",
              },
            ],
          }) as Response) as typeof fetch,
        openWebSocket: () => ws,
        timeoutMs: 2000,
      });
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.error).toContain("not allowed");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("captureBrowserScreenshot fails closed when CDP missing", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "hz-cdp-"));
    try {
      const res = await captureBrowserScreenshot({
        workspace: dir,
        endpoint: "http://127.0.0.1:1",
        fetchImpl: (async () => {
          throw new Error("ECONNREFUSED");
        }) as typeof fetch,
        timeoutMs: 500,
      });
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.error).toContain("CDP");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("captureBrowserScreenshot with injected WebSocket", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "hz-cdp-ok-"));
    try {
      const pngB64 = Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString("base64");
      type Handler = (ev: { data?: unknown }) => void;
      const handlers: Record<string, Handler[]> = {};
      const ws = {
        readyState: 1,
        send(data: string) {
          const req = JSON.parse(data) as { id: number; method: string };
          const result =
            req.method === "Page.captureScreenshot" ? { data: pngB64 } : {};
          for (const h of handlers.message ?? []) {
            h({ data: JSON.stringify({ id: req.id, result }) });
          }
        },
        close() {},
        addEventListener(type: string, fn: Handler) {
          (handlers[type] ??= []).push(fn);
        },
      };
      const res = await captureBrowserScreenshot({
        workspace: dir,
        endpoint: "http://cdp.test",
        fetchImpl: (async () =>
          ({
            ok: true,
            json: async () => [
              {
                id: "1",
                title: "t",
                url: "http://localhost/",
                type: "page",
                webSocketDebuggerUrl: "ws://cdp.test/devtools",
              },
            ],
          }) as Response) as typeof fetch,
        openWebSocket: () => ws,
        timeoutMs: 2000,
      });
      expect(res.ok).toBe(true);
      if (res.ok) {
        expect(res.bytes).toBe(4);
        expect(res.sha256).toMatch(/^[a-f0-9]{64}$/);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
