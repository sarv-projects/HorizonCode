import { expect, test } from "bun:test";
import * as path from "node:path";
import { EffectHost, createEffectId } from "../../src/core/effect-host";
import { frozenUnknownResourceKeys, r170ResourceGateRefusal } from "../../src/core/effect-resource-gate";

const workspace = path.resolve("/tmp/hz-shell-bg-r170");

test("R170 refuses shell_bg kill under frozen UNKNOWN but allows inspection", () => {
  const host = new EffectHost();
  const effectId = createEffectId();
  host.begin(effectId, "write", "call-bg");
  host.recordAllow(effectId);
  host.recordObserve(effectId, {
    receiptId: "r-bg",
    receiptSeq: 1,
    resourceKey: path.resolve(workspace, "frozen.txt"),
  });
  const frozen = frozenUnknownResourceKeys(host);

  const refusal = r170ResourceGateRefusal("shell_bg", { op: "kill", pid: 1234 }, workspace, frozen, host);
  expect(typeof refusal).toBe("string");
  expect(refusal).toContain("blocked_by_unknown");
  for (const op of ["poll", "output", "list"]) {
    expect(r170ResourceGateRefusal("shell_bg", { op, pid: 1234 }, workspace, frozen, host)).toBeUndefined();
  }
  // shell_bg trims operation strings before dispatch, so the R170 classifier
  // must classify the same normalized value as mutating.
  const spacedKill = r170ResourceGateRefusal("shell_bg", { op: " kill ", pid: 1234 }, workspace, frozen, host);
  expect(typeof spacedKill).toBe("string");
  expect(spacedKill).toContain("blocked_by_unknown");
});
