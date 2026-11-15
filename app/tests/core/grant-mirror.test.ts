import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { findActiveSessionGrant, LocalKernel, type Lease } from "../../src/core/kernel";

describe("grant mirror", () => {
  test("findActiveSessionGrant picks newest matching grant", () => {
    const grants = new Map<string, Lease & { owner?: string }>();
    const mk = (pattern: string, leaseId: string) => ({
      leaseId,
      kind: "shell.exec" as const,
      pattern,
      expiry: new Date(Date.now() + 60_000).toISOString(),
      owner: "sess-a",
    });
    grants.set("1", mk("old-cmd", "1"));
    grants.set("2", mk("npm test", "2"));
    const g = findActiveSessionGrant(grants, { kind: "shell.exec", target: "npm test" }, "sess-a");
    expect(g?.pattern).toBe("npm test");
  });

  test("activeGrantExpiryForAction on LocalKernel", async () => {
    const stateDir = mkdtempSync(path.join(tmpdir(), "hz-grant-exp-"));
    const kernel = new LocalKernel({ stateDir });
    await kernel.makeGrant("fs.read", "/tmp/x", 120_000, "sess-b");
    const expiry = kernel.activeGrantExpiryForAction({ kind: "fs.read", target: "/tmp/x" }, "sess-b");
    expect(expiry).toBeDefined();
    expect(Date.parse(expiry ?? "")).toBeGreaterThan(Date.now());
  });

  test("queryGrantForAction returns null without a matching grant", () => {
    const stateDir = mkdtempSync(path.join(tmpdir(), "hz-grant-qry-"));
    const kernel = new LocalKernel({ stateDir });
    expect(kernel.queryGrantForAction({ kind: "shell.exec", target: "missing" }, "sess-q")).toBeNull();
  });
});