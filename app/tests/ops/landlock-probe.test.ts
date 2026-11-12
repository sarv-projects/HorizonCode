/**
 * ops/landlock-probe.sh — deployment gate smoke (docs/33 §5.3 honest reporting).
 */

import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import * as path from "node:path";

const repoRoot = path.join(import.meta.dir, "..", "..", "..");
const probe = path.join(repoRoot, "ops/landlock-probe.sh");

describe("landlock probe", () => {
  test("exits 0 (usable) or 3 (not usable), never crashes", () => {
    const result = spawnSync("sh", [probe], { encoding: "utf8" });
    expect(result.error).toBeUndefined();
    expect([0, 3]).toContain(result.status);
    expect(result.stdout ?? "").toContain("landlock probe");
  });
});
