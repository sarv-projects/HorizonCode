/** J-1 CLI: `--harness swebench-official` on `eval-run` (hermetic, fake python). */

import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { runEvalCli, type EvalCliIo } from "../../src/eval-run";
import type { OfficialHarnessExec } from "../../src/core/swebench-official-harness";
import { cleanupTemps, tempDir } from "./helpers";

afterAll(cleanupTemps);

function capture(): { lines: string[]; errors: string[]; io: EvalCliIo } {
  const lines: string[] = [];
  const errors: string[] = [];
  return { lines, errors, io: { out: (l) => lines.push(l), err: (l) => errors.push(l) } };
}

function casesFile(dir: string): string {
  const file = path.join(dir, "cases.json");
  writeFileSync(file, JSON.stringify([
    { id: "cli-1", task: "say hi", assertions: [{ kind: "terminal", value: "succeeded" }] },
  ]), "utf8");
  return file;
}

describe("J-1 eval-run --harness swebench-official", () => {
  test("submits through the adapter, keeps --submit-cmd untouched, records exact argv", async () => {
    const dir = tempDir("hz-eval-official-");
    const fake = path.join(dir, "fake-python");
    const argvOut = path.join(dir, "argv.txt");
    writeFileSync(fake, `#!/bin/sh\n{\n for a in "$@"; do printf '%s\\n' "$a"; done\n} > "$HZ_FAKE_PY_ARGV_OUT"\nexit 0\n`, "utf8");
    chmodSync(fake, 0o700);
    const exec: OfficialHarnessExec = async (argv) => {
      const r = spawnSync(fake, [...argv], { encoding: "utf8", env: { ...process.env, HZ_FAKE_PY_ARGV_OUT: argvOut } });
      return { status: r.status, error: r.error, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
    };
    const preds = path.join(dir, "preds.json");
    const c = capture();
    const code = await runEvalCli(
      [
        "--cases", casesFile(dir), "--forbidden", "SECRET-VALUE",
        "--preds-out", preds, "--harness", "swebench-official",
        "--dataset", "org/ds", "--split", "test", "--instances", "cli-1",
      ],
      c.io,
      { officialHarnessExec: exec, officialHarnessPython: fake },
    );
    expect(code).toBe(0);
    expect(c.lines.join("\n")).toContain("swebench submit: OK");
    expect(c.lines.join("\n")).toContain("harness=swebench-official");
    const seen = readFileSync(argvOut, "utf8").trim().split("\n");
    expect(seen.slice(0, 2)).toEqual(["-m", "swebench.harness.run_evaluation"]);
    expect(seen).toContain("--predictions_path");
    expect(seen).toContain(preds);
    expect(seen).toContain("--instance_ids");
    expect(seen).toContain("cli-1");
  }, 30000);

  test("unknown harness and dataset-without-harness refuse", async () => {
    const dir = tempDir("hz-eval-official-refuse-");
    const c1 = capture();
    expect(await runEvalCli(
      ["--cases", casesFile(dir), "--forbidden", "SECRET-VALUE", "--harness", "nope"],
      c1.io,
    )).toBe(2);
    expect(c1.errors.join("\n")).toContain("unsupported");
    const c2 = capture();
    expect(await runEvalCli(
      ["--cases", casesFile(dir), "--forbidden", "SECRET-VALUE", "--dataset", "d"],
      c2.io,
    )).toBe(2);
    expect(c2.errors.join("\n")).toContain("require --harness");
  }, 30000);

  test("missing official harness interpreter fails closed at the CLI", async () => {
    const dir = tempDir("hz-eval-official-missing-");
    const c = capture();
    const code = await runEvalCli(
      [
        "--cases", casesFile(dir), "--forbidden", "SECRET-VALUE",
        "--preds-out", path.join(dir, "preds.json"), "--harness", "swebench-official",
      ],
      c.io,
      { officialHarnessPython: "definitely-not-a-real-python" },
    );
    expect(code).toBe(2);
    expect(c.errors.join("\n")).toContain("swebench submit refused");
  }, 30000);
});
