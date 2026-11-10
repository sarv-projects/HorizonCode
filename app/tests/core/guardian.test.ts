/**
 * guardian.test.ts — Tier-3 guardian: deterministic verdicts, advisory by
 * default, opt-in enforcing, capability-detected fallback (docs/28 ruling 48).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import {
  createGuardianClassifier,
  deterministicClassifier,
  GuardianError,
  guardianModeFromEnv,
  reviewAction,
  type ProposedAction,
} from "../../src/core/guardian";

let ws: string;
beforeEach(() => {
  ws = mkdtempSync(path.join(tmpdir(), "guardian-"));
});
afterEach(() => rmSync(ws, { recursive: true, force: true }));

const shell = (target: string): ProposedAction => ({ tool: "shell", kind: "shell.exec", target });

describe("deterministic classifier", () => {
  test("returns allow / flag / deny on controlled inputs", () => {
    expect(deterministicClassifier.classify(shell("ls -la"), "t")).toMatchObject({ verdict: "allow" });
    expect(deterministicClassifier.classify(shell("sudo apt install x"), "t")).toMatchObject({ verdict: "flag" });
    expect(deterministicClassifier.classify(shell("rm -rf /"), "t")).toMatchObject({ verdict: "deny" });
    expect(
      deterministicClassifier.classify({ tool: "write", kind: "fs.write", target: path.join(ws, ".env") }, "t"),
    ).toMatchObject({ verdict: "deny" });
  });
});

describe("advisory by default", () => {
  test("a deny is reported but does not veto when mode is unset or advisory", async () => {
    const unset = await reviewAction(shell("rm -rf /"), "t");
    expect(unset.judgment.verdict).toBe("deny");
    expect(unset.mode).toBe("advisory");
    expect(unset.blocked).toBe(false);
    expect(unset.surfaced).toBe(true);
    const adv = await reviewAction(shell("rm -rf /"), "t", deterministicClassifier, { mode: "advisory" });
    expect(adv.blocked).toBe(false);
    expect(guardianModeFromEnv({})).toBe("advisory");
  });

  test("a throwing classifier fails OPEN in advisory mode and CLOSED in enforce mode (ruling 66)", async () => {
    const boom = { name: "boom", classify: () => { throw new Error("x"); } };
    const adv = await reviewAction(shell("ls"), "t", boom, { mode: "advisory" });
    expect(adv.blocked).toBe(false);
    expect(adv.judgment.verdict).toBe("flag");
    const unset = await reviewAction(shell("ls"), "t", boom);
    expect(unset.blocked).toBe(false);
    const enf = await reviewAction(shell("ls"), "t", boom, { mode: "enforce" });
    expect(enf.blocked).toBe(true);
    expect(enf.judgment.verdict).toBe("deny");
    expect(enf.judgment.reason).toContain("classifier-error:unexpected");
    expect(enf.judgment.reason).toContain("fails closed");
  });

  test("invalid input raises a typed error", async () => {
    await expect(reviewAction({ tool: "", kind: "fs.read", target: "x" }, "t")).rejects.toMatchObject({ reason: "invalid-input" });
  });
});

describe("enforcing mode", () => {
  test("a deny blocks only when explicitly enforcing; flag never blocks", async () => {
    const deny = await reviewAction(shell("rm -rf /"), "t", deterministicClassifier, { mode: "enforce" });
    expect(deny.blocked).toBe(true);
    const flag = await reviewAction(shell("sudo ls"), "t", deterministicClassifier, { mode: "enforce" });
    expect(flag.judgment.verdict).toBe("flag");
    expect(flag.blocked).toBe(false);
    expect(guardianModeFromEnv({ HORIZON_GUARDIAN: "enforce" })).toBe("enforce");
  });
});

describe("capability-detected factory", () => {
  test("falls back to the deterministic classifier with no model capability", () => {
    expect(createGuardianClassifier()).toBe(deterministicClassifier);
    expect(createGuardianClassifier({ model: null })).toBe(deterministicClassifier);
  });

  test("uses the model-backed classifier when a capability is present", async () => {
    const model = { complete: async () => '{"verdict":"deny","reason":"off task"}' };
    const c = createGuardianClassifier({ model });
    expect(c.name).toBe("model");
    const r = await reviewAction(shell("ls"), "t", c, { mode: "enforce" });
    expect(r.judgment).toMatchObject({ verdict: "deny", reason: "off task" });
    expect(r.blocked).toBe(true);
  });

  test("malformed model output is a flag in advisory mode and a closed deny in enforce mode", async () => {
    const c = createGuardianClassifier({ model: { complete: async () => "nope" } });
    const adv = await reviewAction(shell("ls"), "t", c, { mode: "advisory" });
    expect(adv.judgment.reason).toBe("classifier-error:invalid-model-output");
    expect(adv.blocked).toBe(false);
    const r = await reviewAction(shell("ls"), "t", c, { mode: "enforce" });
    expect(r.judgment.reason).toContain("classifier-error:invalid-model-output");
    expect(r.blocked).toBe(true);
    expect(new GuardianError("capability-absent", "d").reason).toBe("capability-absent");
  });
});
