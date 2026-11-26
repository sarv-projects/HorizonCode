import { describe, expect, test } from "bun:test";
import { LocalKernel } from "../../src/core/kernel";
import { applyGuardG1Wire, guardEffectivelyAllows, guardG1WireEnabled } from "../../src/core/guard-g1-wire";
import {
  guardG1LegacyWireMismatchNotice,
  guardG1WireHonesty,
} from "../../src/core/guard-g1-wire-honesty";
import { checkGuardG1WireHonesty } from "../../src/core/doctor";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

describe("G1 wire protocol V2 (HZ_GUARD_G1_WIRE)", () => {
  test("applyGuardG1Wire: always stamps G1 ask + preserves leaseId even when env unset", () => {
    const prev = process.env.HZ_GUARD_G1_WIRE;
    delete process.env.HZ_GUARD_G1_WIRE;
    const out = applyGuardG1Wire(
      { decision: "ask", leaseId: "lease-1", reason: "policy allow" },
      process.env,
    );
    if (prev !== undefined) process.env.HZ_GUARD_G1_WIRE = prev;
    expect(out.decision).toBe("ask");
    expect(out.g1).toBe("ask");
    expect(out.leaseId).toBe("lease-1");
  });

  test("applyGuardG1Wire: HZ_GUARD_G1_WIRE=1 keeps decision ask + leaseId", () => {
    const prev = process.env.HZ_GUARD_G1_WIRE;
    process.env.HZ_GUARD_G1_WIRE = "1";
    const out = applyGuardG1Wire(
      { decision: "ask", leaseId: "lease-2", reason: "policy allow" },
      process.env,
    );
    if (prev !== undefined) process.env.HZ_GUARD_G1_WIRE = prev;
    else delete process.env.HZ_GUARD_G1_WIRE;
    expect(out.decision).toBe("ask");
    expect(out.g1).toBe("ask");
    expect(out.leaseId).toBe("lease-2");
  });

  test("guardEffectivelyAllows: G1 ask with non-empty leaseId is the sole admission", () => {
    expect(guardEffectivelyAllows({ decision: "ask", leaseId: "l1", g1: "ask" })).toBe(true);
    expect(guardEffectivelyAllows({ decision: "ask", leaseId: "", g1: "ask" })).toBe(false);
    expect(guardEffectivelyAllows({ decision: "ask", g1: "ask" })).toBe(false);
    expect(guardEffectivelyAllows({ decision: "deny", g1: "deny" })).toBe(false);
  });

  test("applyGuardG1Wire: deny unchanged under V2", () => {
    process.env.HZ_GUARD_G1_WIRE = "1";
    const out = applyGuardG1Wire({ decision: "deny", reason: "denied" }, process.env);
    delete process.env.HZ_GUARD_G1_WIRE;
    expect(out.decision).toBe("deny");
    expect(out.g1).toBe("deny");
  });

  test("LocalKernel.checkGuard always emits G1 ask + leaseId regardless of HZ_GUARD_G1_WIRE", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "hz-g1-wire-"));
    const state = path.join(root, "state");
    fs.mkdirSync(path.join(state, "events"), { recursive: true });
    fs.writeFileSync(
      path.join(state, "policy.json"),
      JSON.stringify([{ kind: "fs.write", scope: "workspace", decision: "allow" }]),
    );
    const ws = path.join(root, "ws");
    fs.mkdirSync(ws);
    const kernel = new LocalKernel({
      stateDir: state,
      policy: [{ kind: "fs.write", scope: "workspace", decision: "allow" }],
    });
    const target = path.join(ws, "note.txt");

    const prev = process.env.HZ_GUARD_G1_WIRE;
    delete process.env.HZ_GUARD_G1_WIRE;
    const unset = await kernel.checkGuard({ kind: "fs.write", target }, "workspace");
    expect(unset.decision).toBe("ask");
    expect(unset.g1).toBe("ask");
    expect(guardEffectivelyAllows(unset)).toBe(true);

    process.env.HZ_GUARD_G1_WIRE = "1";
    expect(guardG1WireEnabled(process.env)).toBe(true);
    const v2 = await kernel.checkGuard({ kind: "fs.write", target: path.join(ws, "other.txt") }, "workspace");
    if (prev !== undefined) process.env.HZ_GUARD_G1_WIRE = prev;
    else delete process.env.HZ_GUARD_G1_WIRE;
    expect(v2.decision).toBe("ask");
    expect(v2.g1).toBe("ask");
    expect(guardEffectivelyAllows(v2)).toBe(true);

    fs.rmSync(root, { recursive: true, force: true });
  });
});

describe("G1 wire honesty (ruling 716)", () => {
  test("guardG1WireHonesty names legacy vs protocol-v2", () => {
    expect(guardG1WireHonesty({}).mode).toBe("legacy-allow");
    expect(guardG1WireHonesty({ HZ_GUARD_G1_WIRE: "1" }).mode).toBe("protocol-v2");
  });

  test("legacy mismatch notice only when V2 off and stale wire emits allow", () => {
    const decision = { decision: "allow" as unknown as "ask", g1: "ask" as const, leaseId: "l" };
    expect(guardG1LegacyWireMismatchNotice(decision, {})).toContain('decision remains "allow"');
    expect(guardG1LegacyWireMismatchNotice(decision, { HZ_GUARD_G1_WIRE: "1" })).toBeUndefined();
  });

  test("doctor guard.g1.wire warns when V2 unset", () => {
    const check = checkGuardG1WireHonesty({
      home: os.tmpdir(),
      workspace: os.tmpdir(),
      env: { HZ_KERNEL_PIN: "off" },
    } as never);
    expect(check.id).toBe("guard.g1.wire");
    expect(check.status).toBe("warn");
  });
});