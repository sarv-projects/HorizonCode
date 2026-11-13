import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import {
  isReadOnlyProbeArgv,
  probeWorkspaceTerminalReadOnly,
  refuseReadOnlyProbeArgv,
  runReadOnlyProbeArgv,
} from "../../src/core/effect-reconcile-probe-terminal";

describe("effect-reconcile-probe-terminal (ruling 292)", () => {
  test("allow-list accepts fixed argv only (fail-closed)", () => {
    expect(isReadOnlyProbeArgv(["true"])).toBe(true);
    expect(isReadOnlyProbeArgv(["pwd"])).toBe(true);
    expect(isReadOnlyProbeArgv(["git", "rev-parse", "--is-inside-work-tree"])).toBe(true);
    expect(isReadOnlyProbeArgv(["rm", "-rf", "/"])).toBe(false);
    expect(isReadOnlyProbeArgv(["git", "status", "--porcelain"])).toBe(false);
    expect(refuseReadOnlyProbeArgv(["bash", "-c", "echo hi"])).toContain("not allowlisted");
  });

  test("runReadOnlyProbeArgv refuses non-allowlisted argv without spawning", () => {
    let spawned = false;
    const row = runReadOnlyProbeArgv(["curl", "example.com"], "/tmp", {
      run: () => {
        spawned = true;
        return { ok: true, exitCode: 0, stdout: "", stderr: "" };
      },
    });
    expect(row.refused).toBe(true);
    expect(spawned).toBe(false);
  });

  test("probeWorkspaceTerminalReadOnly uses injected runner", () => {
    const ws = mkdtempSync(path.join(tmpdir(), "hz-term-probe-"));
    try {
      const snap = probeWorkspaceTerminalReadOnly(ws, {
        probes: [["true"], ["pwd"]],
        run: (argv) => ({
          ok: true,
          exitCode: 0,
          stdout: argv[0] === "pwd" ? ws : "",
          stderr: "",
        }),
      });
      expect(snap.probes.length).toBe(2);
      expect(snap.probes.every((p) => p.ok && !p.refused)).toBe(true);
      expect(snap.probes[1]?.stdoutPreview).toContain(path.basename(ws));
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });
});
