import { describe, expect, test } from "bun:test";
import { EffectHost, createEffectId } from "../../src/core/effect-host";
import { childEffectIdsFromRecord } from "../../src/core/receipt-child-list";

describe("subagent childEffectIds (ruling 295)", () => {
  test("parent agent execute step records child ids from nested host", () => {
    const host = new EffectHost();
    const parent = createEffectId();
    const child = createEffectId();
    host.begin(parent, "agent", "call-parent");
    host.recordAllow(parent);
    host.begin(child, "grep", "call-child");
    host.recordAllow(child);
    host.recordExecute(child, { ok: true });
    host.recordExecute(parent, { ok: true, childEffectIds: [child] });
    expect(childEffectIdsFromRecord(host.getRecord(parent))).toEqual([child]);
  });
});
