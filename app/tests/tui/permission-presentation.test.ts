import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { appendSavedAllow } from "../../src/core/saved-allows";
import {
  formatUnattendedApprovalDenial,
  permissionAlwaysLines,
  permissionPresentationForRequest,
  savedAllowStaleFootnote,
} from "../../src/tui/permission-presentation";

let workspace = "";
afterEach(() => {
  if (workspace) rmSync(workspace, { recursive: true, force: true });
  workspace = "";
});

describe("permission presentation", () => {
  test("shell shows command line", () => {
    const p = permissionPresentationForRequest({
      kind: "shell.exec",
      title: "run this command",
      detail: "npm test",
    });
    expect(p.title).toBe("Shell command");
    expect(p.lines[0]).toBe("action: shell");
    expect(p.lines[1]).toBe("resource: npm test");
    expect(p.lines[2]).toBe("$ npm test");
  });

  test("relative path when workspace set", () => {
    const p = permissionPresentationForRequest(
      { kind: "fs.read", title: "read", detail: "/tmp/ws/src/a.ts" },
      "/tmp/ws",
    );
    expect(p.title).toContain("Read");
    expect(p.lines.join("\n")).toContain("src/a.ts");
    expect(p.lines).toContain("action: read");
  });

  test("always lines name the target", () => {
    expect(permissionAlwaysLines("shell.exec", "npm test").some((l) => l.includes("npm test"))).toBe(true);
    expect(permissionAlwaysLines("shell.exec", "npm test").some((l) => l.includes("saved-allows"))).toBe(true);
    expect(permissionAlwaysLines("shell.exec", "npm test").some((l) => l.includes("15 minutes"))).toBe(true);
  });

  test("unattended denial mentions TTY and saved allows", () => {
    const p = permissionPresentationForRequest({ kind: "shell.exec", title: "run", detail: "npm test" });
    const msg = formatUnattendedApprovalDenial(p, "shell.exec");
    expect(msg).toContain("no interactive TTY");
    expect(msg).toContain("saved-allows");
    expect(msg).toContain("15 minutes");
  });

  test("compound shell marks saved segments in presentation", () => {
    workspace = mkdtempSync(path.join(tmpdir(), "hz-pres-cmp-"));
    appendSavedAllow(workspace, "shell.exec", "rm -rf build");
    const p = permissionPresentationForRequest(
      { kind: "shell.exec", title: "run", detail: "echo ok && rm -rf build" },
      workspace,
    );
    // The per-segment marker is "(saved allow)"; the file name is shown in the
    // stale footnote, not on every compound segment.
    expect(p.lines.join("\n")).toContain("saved allow");
    expect(p.lines.join("\n")).toContain("rm -rf build");
  });

  test("savedAllowStaleFootnote when row exists but grant inactive", () => {
    workspace = mkdtempSync(path.join(tmpdir(), "hz-stale-foot-"));
    appendSavedAllow(workspace, "shell.exec", "npm test");
    expect(savedAllowStaleFootnote(workspace, "shell.exec", "npm test")).toContain("saved-allows.json");
    expect(savedAllowStaleFootnote(workspace, "shell.exec", "npm test")).toContain("[a]lways");
    expect(savedAllowStaleFootnote(workspace, "shell.exec", "other cmd")).toBeUndefined();
  });

  test("workspace trust approval expands multiline detail", () => {
    const detail = "line one\nline two";
    const p = permissionPresentationForRequest({
      kind: "other",
      title: "Trust this workspace folder?",
      detail,
    });
    expect(p.icon).toBe("\u26a0");
    expect(p.lines).toEqual(["line one", "line two"]);
  });
});
