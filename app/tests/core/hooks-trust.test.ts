import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { hooksConfigFiles, loadHooks } from "../../src/core/hooks";
import {
  bindWorkspaceHooksDigest,
  digestWorkspaceHooks,
  ensureWorkspaceHookTrust,
  hooksLoadOptions,
  loadTrustStore,
  resolveWorkspaceHookTrust,
  workspaceHooksTrusted,
} from "../../src/core/trust";

let workspace: string;
let home: string;
afterEach(() => {
  if (workspace) rmSync(workspace, { recursive: true, force: true });
  if (home) rmSync(home, { recursive: true, force: true });
});

function wsHooks(body?: string): void {
  mkdirSync(path.join(workspace, ".hz"), { recursive: true });
  writeFileSync(
    path.join(workspace, ".hz", "hooks.json"),
    body ?? JSON.stringify({ hooks: { sessionStart: [{ command: "true" }] } }),
  );
}

describe("workspace hook trust", () => {
  test("untrusted workspace hooks are ignored with a notice", () => {
    workspace = mkdtempSync(path.join(tmpdir(), "hz-hook-trust-"));
    home = mkdtempSync(path.join(tmpdir(), "hz-hook-home-"));
    wsHooks();
    const notes: string[] = [];
    const files = hooksConfigFiles(workspace, hooksLoadOptions(workspace, {}, (m) => notes.push(m), home));
    expect(files.some((f) => f.endsWith("hooks.json") && f.includes(".hz"))).toBe(false);
    expect(notes.join("\n")).toContain("workspace hooks ignored");
    const cfg = loadHooks(workspace, hooksLoadOptions(workspace, {}, (m) => notes.push(m), home));
    expect(cfg.state).toBe("none");
  });

  test("trusted workspace hooks load when the path is listed", () => {
    workspace = mkdtempSync(path.join(tmpdir(), "hz-hook-trust-"));
    home = mkdtempSync(path.join(tmpdir(), "hz-hook-home-"));
    wsHooks();
    const resolved = path.resolve(workspace);
    const opts = hooksLoadOptions(workspace, { trustedWorkspaceHooks: [resolved] }, undefined, home);
    const files = hooksConfigFiles(workspace, opts);
    expect(files).toContain(path.join(workspace, ".hz", "hooks.json"));
    expect(workspaceHooksTrusted(workspace, [resolved])).toBe(true);
    const cfg = loadHooks(workspace, opts);
    expect(cfg.state).toBe("ready");
    const digest = digestWorkspaceHooks(workspace);
    expect(digest).not.toBeNull();
    const store = loadTrustStore(home);
    expect(store.records.some((r) => r.hooksDigest === digest)).toBe(true);
  });

  test("digest change revokes workspace hooks until re-bound", () => {
    workspace = mkdtempSync(path.join(tmpdir(), "hz-hook-trust-"));
    home = mkdtempSync(path.join(tmpdir(), "hz-hook-home-"));
    wsHooks();
    const resolved = path.resolve(workspace);
    const digest = digestWorkspaceHooks(workspace);
    expect(digest).not.toBeNull();
    bindWorkspaceHooksDigest(home, workspace, digest!);
    wsHooks(JSON.stringify({ hooks: { sessionStart: [{ command: "false" }] } }));
    const notes: string[] = [];
    expect(
      resolveWorkspaceHookTrust(workspace, [resolved], home, (m) => notes.push(m)),
    ).toBe(false);
    expect(notes.join("\n")).toContain("digest changed");
    const files = hooksConfigFiles(
      workspace,
      hooksLoadOptions(workspace, { trustedWorkspaceHooks: [resolved] }, (m) => notes.push(m), home),
    );
    expect(files.some((f) => f.includes(".hz"))).toBe(false);
  });

  test("digest change with approval re-binds trust", async () => {
    workspace = mkdtempSync(path.join(tmpdir(), "hz-hook-trust-"));
    home = mkdtempSync(path.join(tmpdir(), "hz-hook-home-"));
    wsHooks();
    const resolved = path.resolve(workspace);
    const digest = digestWorkspaceHooks(workspace);
    expect(digest).not.toBeNull();
    bindWorkspaceHooksDigest(home, workspace, digest!);
    wsHooks(JSON.stringify({ hooks: { sessionStart: [{ command: "false" }] } }));
    const receipts: string[] = [];
    const ok = await ensureWorkspaceHookTrust(
      workspace,
      [resolved],
      home,
      async () => true,
      async (p) => {
        receipts.push(p.decision);
      },
    );
    expect(ok).toBe(true);
    expect(receipts).toEqual(["rebind"]);
    expect(resolveWorkspaceHookTrust(workspace, [resolved], home)).toBe(true);
  });

  test("digest change without approve stays untrusted", async () => {
    workspace = mkdtempSync(path.join(tmpdir(), "hz-hook-trust-"));
    home = mkdtempSync(path.join(tmpdir(), "hz-hook-home-"));
    wsHooks();
    const resolved = path.resolve(workspace);
    const digest = digestWorkspaceHooks(workspace)!;
    bindWorkspaceHooksDigest(home, workspace, digest);
    wsHooks(JSON.stringify({ hooks: { sessionStart: [{ command: "false" }] } }));
    const ok = await ensureWorkspaceHookTrust(workspace, [resolved], home);
    expect(ok).toBe(false);
  });
});
