import { describe, expect, test } from "bun:test";
import { assertSnapshotCaptureScope } from "../../src/core/checkpoints";
import {
  SNAPSHOT_CAPTURE_UNAVAILABLE,
  SNAPSHOT_RESTORE_UNAVAILABLE,
  WorkspaceSnapshotError,
  parseWorkspaceSnapshotScope,
  refuseWorkspaceSnapshotCapture,
  refuseWorkspaceSnapshotRestore,
  requestWorkspaceSnapshotCapture,
  workspaceSnapshotHonesty,
} from "../../src/core/workspace-snapshot";
import { checkWorkspaceSnapshot, runDoctor } from "../../src/core/doctor";
import type { DoctorEnv } from "../../src/core/doctor";

describe("snapshot.disabled.spec (S-50)", () => {
  test("workspace scope capture refuses SNAPSHOT_CAPTURE_UNAVAILABLE", () => {
    expect(() => requestWorkspaceSnapshotCapture({ scope: "workspace" })).toThrow(WorkspaceSnapshotError);
    try {
      refuseWorkspaceSnapshotCapture("workspace");
    } catch (e) {
      expect(e).toBeInstanceOf(WorkspaceSnapshotError);
      const err = e as WorkspaceSnapshotError;
      expect(err.code).toBe(SNAPSHOT_CAPTURE_UNAVAILABLE);
      expect(err.message).toContain("SNAPSHOT_CAPTURE_UNAVAILABLE");
      expect(err.message).toContain("S-50");
    }
  });

  test("message scope does not invoke workspace capture refusal", () => {
    expect(() => requestWorkspaceSnapshotCapture({ scope: "message" })).not.toThrow();
    expect(() => assertSnapshotCaptureScope("message")).not.toThrow();
  });

  test("checkpoint seam refuses workspace scope", () => {
    expect(() => assertSnapshotCaptureScope("workspace")).toThrow(WorkspaceSnapshotError);
  });

  test("restore refuses SNAPSHOT_RESTORE_UNAVAILABLE", () => {
    expect(() => refuseWorkspaceSnapshotRestore()).toThrow(WorkspaceSnapshotError);
    try {
      refuseWorkspaceSnapshotRestore();
    } catch (e) {
      expect((e as WorkspaceSnapshotError).code).toBe(SNAPSHOT_RESTORE_UNAVAILABLE);
    }
  });

  test("parseWorkspaceSnapshotScope", () => {
    expect(parseWorkspaceSnapshotScope("workspace")).toBe("workspace");
    expect(parseWorkspaceSnapshotScope("--workspace")).toBe("workspace");
    expect(parseWorkspaceSnapshotScope(undefined)).toBe("message");
    expect(() => parseWorkspaceSnapshotScope("full-tree")).toThrow(WorkspaceSnapshotError);
  });

  test("doctor names SNAPSHOT_CAPTURE_UNAVAILABLE", () => {
    const line = checkWorkspaceSnapshot();
    expect(line.id).toBe("workspace.snapshot");
    expect(line.detail).toContain(SNAPSHOT_CAPTURE_UNAVAILABLE);
    const inRun = runDoctor(minimalDoctorEnv()).find((c) => c.id === "workspace.snapshot");
    expect(inRun?.detail).toContain(SNAPSHOT_CAPTURE_UNAVAILABLE);
  });

  test("honesty lines mention message-scope rewind", () => {
    const h = workspaceSnapshotHonesty();
    expect(h.captureEnabled).toBe(false);
    expect(h.lines.some((l) => l.includes("/rewind"))).toBe(true);
  });
});

function minimalDoctorEnv(): DoctorEnv {
  return {
    env: {},
    workspace: "/tmp",
    home: "/tmp",
    bunVersion: "1.2.0",
    stdinIsTTY: false,
    stdoutIsTTY: false,
    run: () => ({ ok: true, status: 0, stdout: "", stderr: "" }),
    kernelBinary: undefined,
  };
}
