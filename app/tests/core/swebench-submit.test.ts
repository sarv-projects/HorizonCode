/** swebench-submit.test.ts — J-1 external harness wiring (fail-closed, no fake submits). */

import { describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { upsertPredsRecord } from "../../src/core/preds-writer";
import {
  resolveSubmitCommand,
  SubmitError,
  submitPredictions,
  validatePredsFile,
} from "../../src/core/swebench-submit";

function predsFile(): string {
  const file = path.join(tmpdir(), `hz-j1-preds-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
  upsertPredsRecord(file, {
    instance_id: "org__repo-1",
    model_name_or_path: "minimaxai/minimax-m3.1-flash",
    model_patch: "diff --git a/x b/x\n",
  });
  return file;
}

describe("resolveSubmitCommand", () => {
  test("CLI flag wins over environment", () => {
    expect(resolveSubmitCommand({ submitCmd: "cli-harness", env: { HZ_SWEBENCH_HARNESS: "env-harness" } })).toBe("cli-harness");
  });
  test("falls back to HZ_SWEBENCH_HARNESS", () => {
    expect(resolveSubmitCommand({ env: { HZ_SWEBENCH_HARNESS: "env-harness" } })).toBe("env-harness");
  });
  test("undefined when neither is set", () => {
    expect(resolveSubmitCommand({ env: {} })).toBeUndefined();
  });
});

describe("validatePredsFile", () => {
  test("accepts a well-formed preds file", () => {
    const v = validatePredsFile(predsFile());
    expect(v.valid).toBe(true);
    if (v.valid) expect(v.count).toBe(1);
  });
  test("refuses empty / malformed / wrong-shaped files", () => {
    const dir = tmpdir();
    const empty = path.join(dir, `hz-j1-empty-${Date.now()}.json`);
    writeFileSync(empty, "{}", "utf8");
    expect(validatePredsFile(empty).valid).toBe(false);
    const bad = path.join(dir, `hz-j1-bad-${Date.now()}.json`);
    writeFileSync(bad, "not json", "utf8");
    expect(validatePredsFile(bad).valid).toBe(false);
    const missing = path.join(dir, `hz-j1-missing-${Date.now()}.json`);
    expect(validatePredsFile(missing).valid).toBe(false);
  });
});

describe("submitPredictions (injected fake harness records argv)", () => {
  test("appends the preds path to the harness argv and reports a real submit", () => {
    const file = predsFile();
    let seen: { exe: string; args: string[] } | undefined;
    const result = submitPredictions({
      predsFile: file,
      command: "harness --flag",
      env: {},
      run: (exe, args) => {
        seen = { exe, args };
        return { status: 0, stdout: "ok", stderr: "" };
      },
    });
    expect(result.submitted).toBe(true);
    expect(result.predictionCount).toBe(1);
    expect(seen).toEqual({ exe: "harness", args: ["--flag", file] });
  });

  test("substitutes a {preds} placeholder instead of appending", () => {
    const file = predsFile();
    let args: string[] = [];
    submitPredictions({
      predsFile: file,
      command: "harness --preds {preds}",
      env: {},
      run: (_exe, a) => {
        args = a;
        return { status: 0 };
      },
    });
    expect(args).toEqual(["--preds", file]);
  });

  test("FAIL CLOSED with no harness — never a fake submission", () => {
    expect(() => submitPredictions({ predsFile: predsFile(), command: undefined, env: {} })).toThrow(SubmitError);
    try {
      submitPredictions({ predsFile: predsFile(), env: {} });
      expect.unreachable();
    } catch (err) {
      expect((err as SubmitError).reason).toBe("missing-command");
    }
  });

  test("FAIL CLOSED when the harness exits non-zero or cannot start", () => {
    const file = predsFile();
    expect(() => submitPredictions({ predsFile: file, command: "harness", env: {}, run: () => ({ status: 2, stderr: "boom" }) })).toThrow(/harness-failed/);
    expect(() => submitPredictions({ predsFile: file, command: "harness", env: {}, run: () => ({ status: null, error: "ENOENT" }) })).toThrow(/spawn-failed/);
  });
});

describe("submitPredictions (real fake-harness subprocess)", () => {
  test("invokes the committed fake harness and it records argv", () => {
    const file = predsFile();
    const out = path.join(tmpdir(), `hz-j1-argv-${Date.now()}.txt`);
    const harness = path.resolve(import.meta.dir, "../fixtures/fake-submit-harness.sh");
    const result = submitPredictions({
      predsFile: file,
      command: `sh ${harness} --sentinel`,
      env: { ...process.env, HZ_FAKE_SUBMIT_ARGV_OUT: out },
    });
    expect(result.submitted).toBe(true);
    const recorded = readFileSync(out, "utf8").trim().split("\n");
    expect(recorded).toEqual(["--sentinel", file]);
  });
});
