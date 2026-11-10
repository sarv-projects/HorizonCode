/**
 * gate-startup-latency.test.ts - T-11: the startup-latency gate in ops/gates.sh.
 *
 * The runner is sourced (it defines its functions and runs nothing when
 * sourced), so one gate is driven in isolation. The pass path uses a huge
 * ceiling so a loaded machine cannot flake it; the fail path uses a 1 ms
 * ceiling that no process can meet. Together they prove the gate measures and
 * that it fails above the threshold.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import * as path from "node:path";

const root = path.resolve(import.meta.dir, "../../..");
const gates = path.join(root, "ops", "gates.sh");

function runGate(env: Record<string, string>) {
  const r = Bun.spawnSync(
    ["bash", "-c", `source "${gates}"; if run_gate 0 startup-latency gate_startup_latency; then echo rc=0; else echo rc=1; fi`],
    { env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", ...env }, stdout: "pipe", stderr: "pipe" },
  );
  return { out: r.stdout.toString(), err: r.stderr.toString(), code: r.exitCode };
}

describe("startup-latency gate", () => {
  test("is registered in the runner, last, and sourcing the runner does not execute it", () => {
    const text = readFileSync(gates, "utf8");
    const list = /GATES=\(([\s\S]*?)\n\)/.exec(text)?.[1] ?? "";
    const names = list.split("\n").map((l) => l.trim()).filter((l) => l !== "");
    expect(names.at(-1)).toBe("startup-latency");
    expect(names).toHaveLength(8);
    const r = Bun.spawnSync(["bash", "-c", `source "${gates}"; echo sourced-quietly`], { stdout: "pipe", stderr: "pipe" });
    expect(r.stdout.toString().trim()).toBe("sourced-quietly");
  });

  test("passes with a generous ceiling and reports both medians with their samples", () => {
    const r = runGate({ HZ_LATENCY_VERSION_MS: "60000", HZ_LATENCY_TURN_MS: "60000" });
    expect(r.out).toContain("ok    startup-latency");
    expect(r.out).toContain("rc=0");
  }, 60_000);

  test("fails above the ceiling and names the measured median and the limit", () => {
    const r = runGate({ HZ_LATENCY_VERSION_MS: "1" });
    expect(r.out).toContain("FAIL  startup-latency");
    expect(r.out).toMatch(/version: median \d+ ms \(ceiling 1 ms\); samples (\d+ ){5}/);
    expect(r.out).toMatch(/version median \d+ ms exceeds the 1 ms ceiling/);
    expect(r.out).toContain("rc=1");
  }, 60_000);

  test("the turn measurement has its own ceiling", () => {
    const r = runGate({ HZ_LATENCY_VERSION_MS: "60000", HZ_LATENCY_TURN_MS: "1" });
    expect(r.out).toContain("FAIL  startup-latency");
    expect(r.out).toMatch(/mock-turn median \d+ ms exceeds the 1 ms ceiling/);
  }, 60_000);

  test("the shipped default ceilings are the documented ones", () => {
    const text = readFileSync(gates, "utf8");
    expect(text).toContain('LATENCY_VERSION_MS="${HZ_LATENCY_VERSION_MS:-500}"');
    expect(text).toContain('LATENCY_TURN_MS="${HZ_LATENCY_TURN_MS:-1000}"');
    const cat = readFileSync(path.join(root, "ops", "gate-catalogue.md"), "utf8");
    expect(cat).toContain("`startup-latency`");
    expect(cat).toContain("500 ms");
    expect(cat).toContain("1000 ms");
  });
});
