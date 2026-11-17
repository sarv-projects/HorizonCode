/**
 * swebench-official-harness.test.ts — J-1 official argv adapter (hermetic).
 * No harness, dataset or credentials are present here: a fake `python` script
 * records the exact argv, and a missing-command case proves fail-closed.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import {
  buildOfficialHarnessArgv,
  OFFICIAL_HARNESS_MODULE,
  OFFICIAL_HARNESS_REASON,
  resolveOfficialPython,
  submitWithOfficialHarness,
  type OfficialHarnessExec,
} from "../../src/core/swebench-official-harness";
import { SubmitError } from "../../src/core/swebench-submit";
import { cleanupTemps, tempDir } from "./helpers";

afterAll(cleanupTemps);

function predsFile(dir: string): string {
  const file = path.join(dir, "preds.json");
  writeFileSync(file, JSON.stringify({ "inst-1": { instance_id: "inst-1", model_name_or_path: "m", model_patch: "" } }), "utf8");
  return file;
}

/** A fake interpreter that behaves like the official harness argv surface. */
function fakePython(dir: string): { path: string; argvOut: string } {
  const exe = path.join(dir, "fake-python");
  const argvOut = path.join(dir, "argv.txt");
  writeFileSync(
    exe,
    `#!/bin/sh\n{\n  for a in "$@"; do printf '%s\\n' "$a"; done\n} > "$HZ_FAKE_PY_ARGV_OUT"\nprintf 'fake official harness\\n'\nexit 0\n`,
    "utf8",
  );
  chmodSync(exe, 0o700);
  return { path: exe, argvOut };
}

const recordingExec = (captured: { argv?: readonly string[]; reason?: string }): OfficialHarnessExec => async (argv, reason) => {
  captured.argv = argv;
  captured.reason = reason;
  return { status: 0, stdout: "", stderr: "" };
};

describe("J-1 official SWE-bench harness adapter", () => {
  test("buildOfficialHarnessArgv is the exact official invocation (incl. instance filter)", () => {
    expect(buildOfficialHarnessArgv({ predsPath: "/p.json", dataset: "d", split: "test" })).toEqual([
      "-m", OFFICIAL_HARNESS_MODULE, "--predictions_path", "/p.json", "--dataset_name", "d", "--split", "test",
    ]);
    expect(buildOfficialHarnessArgv({ predsPath: "/p.json", dataset: "d", split: "test", instanceIds: ["a", "b"] })).toEqual([
      "-m", OFFICIAL_HARNESS_MODULE, "--predictions_path", "/p.json", "--dataset_name", "d", "--split", "test",
      "--instance_ids", "a", "b",
    ]);
  });

  test("wrong-shaped argv fields fail closed", () => {
    expect(() => buildOfficialHarnessArgv({ predsPath: "", dataset: "d", split: "test" })).toThrow(SubmitError);
    expect(() => buildOfficialHarnessArgv({ predsPath: "/p", dataset: "d", split: "test", instanceIds: [""] })).toThrow(SubmitError);
  });

  test("injected exec receives exact argv and the reason rides along as the spawn label", async () => {
    const dir = tempDir("hz-official-harness-");
    const preds = predsFile(dir);
    const captured: { argv?: readonly string[]; reason?: string } = {};
    const result = await submitWithOfficialHarness({
      predsFile: preds,
      dataset: "org/dataset",
      split: "validation",
      instanceIds: ["inst-1"],
      python: "/bin/sh",
      exec: recordingExec(captured),
    });
    expect(result.submitted).toBe(true);
    expect(result.predictionCount).toBe(1);
    expect(captured.reason).toBe(OFFICIAL_HARNESS_REASON);
    expect(captured.argv).toEqual([
      "-m", "swebench.harness.run_evaluation", "--predictions_path", preds,
      "--dataset_name", "org/dataset", "--split", "validation", "--instance_ids", "inst-1",
    ]);
  });

  test("a fake python subprocess sees the exact argv after the interpreter", async () => {
    const dir = tempDir("hz-official-fakepy-");
    const preds = predsFile(dir);
    const fake = fakePython(dir);
    const exec: OfficialHarnessExec = async (argv) => {
      const r = spawnSync(fake.path, [...argv], {
        encoding: "utf8",
        env: { ...process.env, HZ_FAKE_PY_ARGV_OUT: fake.argvOut },
      });
      return { status: r.status, error: r.error, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
    };
    const result = await submitWithOfficialHarness({
      predsFile: preds,
      dataset: "org/ds",
      split: "test",
      python: fake.path,
      exec,
    });
    expect(result.submitted).toBe(true);
    expect(result.stdout).toContain("fake official harness");
    const seen = readFileSync(fake.argvOut, "utf8").trim().split("\n");
    expect(seen).toEqual([
      "-m", "swebench.harness.run_evaluation", "--predictions_path", preds,
      "--dataset_name", "org/ds", "--split", "test",
    ]);
  });

  test("missing interpreter fails closed (no fabricated submission)", () => {
    expect(() => resolveOfficialPython({ python: "", env: {} })).toThrow(/no official SWE-bench harness interpreter/);
    expect(() => resolveOfficialPython({ python: "definitely-not-a-real-python", env: { PATH: "/nonexistent" } })).toThrow(
      /is not present/,
    );
  });

  test("a spawn ENOENT and a nonzero harness exit both refuse", async () => {
    const dir = tempDir("hz-official-refuse-");
    const preds = predsFile(dir);
    const options = {
      predsFile: preds,
      python: "/bin/sh",
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
    };
    const enoent: OfficialHarnessExec = async () => ({ status: null, error: Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" }), stdout: "", stderr: "" });
    await expect(submitWithOfficialHarness({ ...options, exec: enoent })).rejects.toThrow(/could not start official harness/);
    const failing: OfficialHarnessExec = async () => ({ status: 2, stdout: "", stderr: "ModuleNotFoundError: swebench" });
    await expect(submitWithOfficialHarness({ ...options, exec: failing })).rejects.toThrow(/exited 2/);
  });
});
