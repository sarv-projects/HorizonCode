import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import {
  postimageReplayActive,
  postimageReplayDoctorPosture,
  probePostimageReplay,
} from "../../src/core/effect-postimage-replay";
import { probeEffectEvidence } from "../../src/core/effect-evidence-gate";
import { receiptsPath } from "../../src/core/session-kernel-reconcile";

describe("effect-postimage-replay (ruling 297 / 301)", () => {
  let workspace: string;
  const envKey = "HZ_VERIFY_POSTIMAGE_REPLAY";
  const hostKey = "HZ_EFFECT_HOST_KERNEL";

  beforeEach(() => {
    workspace = mkdtempSync(path.join(tmpdir(), "hz-replay-"));
    mkdirSync(path.dirname(receiptsPath(workspace)), { recursive: true });
    process.env[envKey] = "1";
  });

  afterEach(() => {
    delete process.env[envKey];
    delete process.env[hostKey];
    rmSync(workspace, { recursive: true, force: true });
  });

  test("require mode auto-enables replay without explicit env", () => {
    delete process.env[envKey];
    process.env[hostKey] = "require";
    expect(postimageReplayActive()).toBe(true);
    expect(postimageReplayDoctorPosture().requireAuto).toBe(true);
  });

  test("doctor names ast_edit/kernel-routed replay scope (ruling 320 P0)", () => {
    const posture = postimageReplayDoctorPosture();
    expect(posture.detail.toLowerCase()).toContain("ast_edit");
    expect(posture.detail.toLowerCase()).toContain("not full rust observe");
  });

  test("matching digest passes replay", () => {
    const file = path.join(workspace, "f.txt");
    const content = "hello-replay";
    writeFileSync(file, content, "utf8");
    const digest = createHash("sha256").update(content, "utf8").digest("hex");
    writeFileSync(
      receiptsPath(workspace),
      JSON.stringify({
        id: "r1",
        seq: 1,
        tool: "write",
        effectId: "eff1",
        postimagePath: file,
        postimageDigest: digest,
        resultDigest: "x",
        hash: "h",
      }) + "\n",
    );
    const report = probePostimageReplay(workspace);
    expect(report.failures).toHaveLength(0);
    const evidence = probeEffectEvidence(workspace);
    expect(evidence.failures.some((f) => f.kind.startsWith("postimage_replay"))).toBe(false);
  });

  test("mismatch surfaces replay failure and evidence gate", () => {
    const file = path.join(workspace, "f.txt");
    writeFileSync(file, "current-bytes", "utf8");
    const stored = createHash("sha256").update("old-bytes", "utf8").digest("hex");
    writeFileSync(
      receiptsPath(workspace),
      JSON.stringify({
        id: "r2",
        seq: 2,
        tool: "edit",
        effectId: "eff2",
        postimagePath: file,
        postimageDigest: stored,
        resultDigest: "x",
        hash: "h2",
      }) + "\n",
    );
    const report = probePostimageReplay(workspace);
    expect(report.failures.length).toBe(1);
    expect(report.failures[0]?.replayDigest).not.toBe(stored);
    const evidence = probeEffectEvidence(workspace);
    expect(evidence.failures.some((f) => f.kind === "postimage_replay_mismatch")).toBe(true);
  });
});
