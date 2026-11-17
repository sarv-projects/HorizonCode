/**
 * eval-live-cost.test.ts — F-4 LIVE opt-in proof that a real provider response
 * carries token usage into an eval case with an explicit (non-`none`) cost
 * source. HIDDEN by default: the hermetic suite never touches the network.
 *
 * Opt in with `HZ_LIVE_EVAL=1`. Reads `~/.config/horizon/env` for
 * `NVIDIA_API_KEY`; the key is injected into the child runtime's environment
 * at run time and NEVER hardcoded or committed. Provider `nvidia`, model
 * `minimaxai/minimax-m3.1-flash`. If the file/key is absent the test skips with
 * a clear note rather than failing (an opt-in without credentials is not a
 * product failure).
 *
 * This test does not assert a specific USD amount — the harness price table is
 * an estimate, not billing truth. It asserts the honest *provenance*: usage is
 * captured, the cost source is `harness-estimate` (or `reported`), and the
 * network was genuinely used (the opt-in flag). No shell egress is enforced.
 */

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import * as path from "node:path";
import { makeRuntimeExecutor } from "../../src/core/eval-executor";
import { runEvalCase } from "../../src/core/evals";

function readDotEnv(file: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq < 0) continue;
    const key = trimmed.slice(0, eq).trim().replace(/^export\s+/, "");
    let value = trimmed.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (key !== "") out[key] = value;
  }
  return out;
}

const MODEL = "minimaxai/minimax-m3.1-flash";

describe("F-4 live provider cost capture (opt-in)", () => {
  test.skipIf(process.env.HZ_LIVE_EVAL !== "1")(
    "captures real NVIDIA usage with a non-none cost source",
    async () => {
      const envPath = path.join(homedir(), ".config", "horizon", "env");
      if (!existsSync(envPath)) {
        console.log(`F-4 live test skipped: no ${envPath} (NVIDIA_API_KEY not configured)`);
        return;
      }
      const dotenv = readDotEnv(envPath);
      const key = dotenv.NVIDIA_API_KEY;
      if (key === undefined || key.trim() === "") {
        console.log(`F-4 live test skipped: NVIDIA_API_KEY absent in ${envPath}`);
        return;
      }
      const saved = {
        NVIDIA_API_KEY: process.env.NVIDIA_API_KEY,
        HZ_PROVIDER: process.env.HZ_PROVIDER,
        HZ_MODEL: process.env.HZ_MODEL,
      };
      process.env.NVIDIA_API_KEY = key;
      process.env.HZ_PROVIDER = "nvidia";
      process.env.HZ_MODEL = MODEL;
      try {
        const handle = makeRuntimeExecutor({ mock: false, model: MODEL });
        const graded = await runEvalCase(
          {
            id: "live-cost-1",
            from: "live",
            task: "Reply with the single word: ping",
            setup: { tools: [] },
            assertions: [{ kind: "terminal", value: "succeeded" }],
          },
          { executor: handle.executor, forbiddenTexts: ["SECRET-NEVER-PRESENT"] },
        );
        const obs = handle.observations()[0]!;
        // Provenance, not a price: real usage was reported and attributed.
        expect(obs.usage).toBeDefined();
        expect((obs.usage?.inputTokens ?? 0) + (obs.usage?.outputTokens ?? 0)).toBeGreaterThan(0);
        expect(graded.metrics.costSource).not.toBe("none");
        expect(graded.metrics.usage).toBeDefined();
      } finally {
        for (const [k, v] of Object.entries(saved)) {
          if (v === undefined) delete process.env[k];
          else process.env[k] = v;
        }
      }
    },
    60000,
  );
});
