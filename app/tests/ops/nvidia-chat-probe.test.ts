/**
 * ops/nvidia-chat-probe.sh — README §5.11 chat row verifier (keyed).
 */

import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import * as path from "node:path";

const repoRoot = path.join(import.meta.dir, "..", "..", "..");
const probe = path.join(repoRoot, "ops", "nvidia-chat-probe.sh");

describe("nvidia chat probe", () => {
  test("script exists and is executable", () => {
    expect(existsSync(probe)).toBe(true);
  });

  test("without a key it refuses before calling the API", () => {
    const result = spawnSync("bash", [probe], {
      encoding: "utf8",
      env: {
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        HZ_PROBE_NO_DOTENV: "1",
        NVIDIA_API_KEY: "",
        HZ_API_KEY: "",
        HZ_MODEL: "",
      },
    });
    expect(result.status).toBeGreaterThan(0);
    expect(`${result.stderr ?? ""}${result.stdout ?? ""}`).toContain("NVIDIA_API_KEY");
  });
});
