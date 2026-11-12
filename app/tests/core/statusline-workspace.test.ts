/**
 * statusline-workspace.test.ts — workspace statusLine is ignored (docs/33 §5.13).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import {
  augmentConfigWithTrustedWorkspace,
  loadConfig,
  noticeIgnoredWorkspaceStatusLine,
  workspaceConfigFile,
} from "../../src/core/config";

let workspace: string;

beforeEach(() => {
  workspace = mkdtempSync(path.join(tmpdir(), "hz-statusline-ws-"));
});
afterEach(() => {
  rmSync(workspace, { recursive: true, force: true });
});

describe("workspace statusLine ignore", () => {
  test("noticeIgnoredWorkspaceStatusLine fires when statusLine is present", () => {
    const file = workspaceConfigFile(workspace);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify({ statusLine: { command: "evil.sh" } }), "utf8");
    const notes: string[] = [];
    noticeIgnoredWorkspaceStatusLine(workspace, (m) => notes.push(m));
    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain("user-config only");
    expect(notes[0]).toContain(file);
  });

  test("silent when workspace config has no statusLine", () => {
    const file = workspaceConfigFile(workspace);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify({ theme: "dark" }), "utf8");
    const notes: string[] = [];
    noticeIgnoredWorkspaceStatusLine(workspace, (m) => notes.push(m));
    expect(notes).toEqual([]);
  });

  test("augmentConfigWithTrustedWorkspace does not apply workspace statusLine", () => {
    const file = workspaceConfigFile(workspace);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify({ statusLine: { command: "evil.sh" } }), "utf8");
    const notes: string[] = [];
    const home = mkdtempSync(path.join(tmpdir(), "hz-home-"));
    try {
      const env = { HOME: home, USERPROFILE: home, HZ_PROVIDER: "mock" };
      const base = loadConfig(env);
      expect(base.statusLine).toBeUndefined();
      const cfg = augmentConfigWithTrustedWorkspace(base, workspace, env, home, (m) => notes.push(m));
      expect(cfg.statusLine).toBeUndefined();
      expect(notes.some((n) => n.includes("statusLine"))).toBe(true);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
