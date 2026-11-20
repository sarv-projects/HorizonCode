import { afterEach, describe, expect, test } from "bun:test";
import { runDoctor, type DoctorCheck, type DoctorEnv } from "../../src/core/doctor";
import {
  applyProductNetnsCapableDefault,
  assessProductNetnsCapability,
  formatProductNetnsCapabilityDoctorDetail,
  productNetnsHonestyEnvUnset,
  projectProductNetnsDoctorEnv,
  setProductNetnsCapProbeForTests,
  textClaimsBareShellNetEnforced,
} from "../../src/core/sandbox-netns-runtime";
import { sandboxNetnsHonestyFlag } from "../../src/core/sandbox-netns-route";

function fakeEnv(over: Partial<DoctorEnv> = {}): DoctorEnv {
  return {
    env: { LANG: "en_US.UTF-8", HZ_PROVIDER: "mock", HZ_KERNEL_PIN: "off", HZ_SANDBOX_EXEC: "1" },
    workspace: "/tmp/ws",
    home: "/tmp",
    bunVersion: "1.2.14",
    stdinIsTTY: false,
    stdoutIsTTY: false,
    run: () => ({ ok: true, status: 0, stdout: "", stderr: "" }),
    kernelBinary: "/fake/hz-kernel",
    ...over,
  };
}

const byId = (checks: DoctorCheck[], id: string): DoctorCheck => {
  const c = checks.find((x) => x.id === id);
  if (c === undefined) throw new Error(`no check ${id}`);
  return c;
};

const capableProbe = {
  capable: true,
  reason: "capable" as const,
  wsl: false,
  sandboxExec: true,
  unshareOk: true,
  capNetAdmin: true,
  detail: "test-capable",
};

const incapableWsl = {
  capable: false,
  reason: "wsl" as const,
  wsl: true,
  sandboxExec: true,
  unshareOk: false,
  capNetAdmin: false,
  detail: "WSL2: unshare(CLONE_NEWNET) not permitted",
};

afterEach(() => {
  setProductNetnsCapProbeForTests(undefined);
});

describe("sandbox-netns-runtime (P0-4 / ruling 672)", () => {
  test("productNetnsHonestyEnvUnset respects explicit pins", () => {
    expect(productNetnsHonestyEnvUnset({})).toBe(true);
    expect(productNetnsHonestyEnvUnset({ HZ_SANDBOX_NETNS: "1" })).toBe(false);
    expect(productNetnsHonestyEnvUnset({ HZ_SANDBOX_NETNS: "0" })).toBe(false);
  });

  test("assessProductNetnsCapability uses injected probe", () => {
    setProductNetnsCapProbeForTests(true);
    expect(assessProductNetnsCapability().capable).toBe(true);
    setProductNetnsCapProbeForTests(false);
    expect(assessProductNetnsCapability().capable).toBe(false);
  });

  test("applyProductNetnsCapableDefault sets NETNS when trusted + capable + env unset", () => {
    setProductNetnsCapProbeForTests(true);
    const env: Record<string, string | undefined> = {};
    const res = applyProductNetnsCapableDefault(env, {
      kernelTrusted: true,
      capability: capableProbe,
    });
    if (process.platform === "linux") {
      expect(res.applied).toBe("capable-default");
      expect(env.HZ_SANDBOX_NETNS).toBe("1");
      expect(env.HZ_SANDBOX_CHILD_NET).toBe("off");
      expect(res.notice).toContain("never shell-net enforced");
      expect(res.notice).toContain("TLS MITM");
    } else {
      expect(res.applied).toBeUndefined();
    }
  });

  test("apply skips when untrusted, explicit env, or probe fails", () => {
    const env: Record<string, string | undefined> = {};
    expect(applyProductNetnsCapableDefault(env, { kernelTrusted: false, capability: capableProbe }).applied).toBe(
      undefined,
    );

    const explicit: Record<string, string | undefined> = { HZ_SANDBOX_NETNS: "0" };
    expect(
      applyProductNetnsCapableDefault(explicit, { kernelTrusted: true, capability: capableProbe }).applied,
    ).toBeUndefined();

    const offCap: Record<string, string | undefined> = {};
    expect(
      applyProductNetnsCapableDefault(offCap, { kernelTrusted: true, capability: incapableWsl }).applied,
    ).toBeUndefined();
    expect(offCap.HZ_SANDBOX_NETNS).toBeUndefined();
    expect(
      applyProductNetnsCapableDefault(offCap, { kernelTrusted: true, capability: incapableWsl }).notice,
    ).toContain("reason=wsl");
  });

  test("projectProductNetnsDoctorEnv only when capable and unset", () => {
    expect(projectProductNetnsDoctorEnv({}, capableProbe).HZ_SANDBOX_NETNS).toBe("1");
    expect(projectProductNetnsDoctorEnv({ HZ_SANDBOX_NETNS: "0" }, capableProbe).HZ_SANDBOX_NETNS).toBe("0");
    expect(projectProductNetnsDoctorEnv({}, incapableWsl).HZ_SANDBOX_NETNS).toBeUndefined();
  });

  test("WSL posture when wsl host flag set (live probe path)", () => {
    setProductNetnsCapProbeForTests(undefined);
    const cap = assessProductNetnsCapability({
      wsl: true,
      env: { HZ_SANDBOX_EXEC: "1" },
      run: () => ({ ok: false, status: 1, stdout: "", stderr: "" }),
    });
    expect(cap.capable).toBe(false);
    expect(cap.wsl).toBe(true);
    expect(cap.reason).toBe("wsl");
    expect(cap.detail.toLowerCase()).toContain("wsl");
  });

  test("textClaimsBareShellNetEnforced allows negated honesty", () => {
    expect(textClaimsBareShellNetEnforced("never claim shell-net enforced")).toBe(false);
    expect(textClaimsBareShellNetEnforced("routed netns egress not enforced")).toBe(false);
    expect(textClaimsBareShellNetEnforced("shell-net egress enforced")).toBe(true);
  });

  test("assess exposes named reason for CAP gap", () => {
    setProductNetnsCapProbeForTests(undefined);
    const cap = assessProductNetnsCapability({
      wsl: false,
      env: { HZ_SANDBOX_EXEC: "1" },
      run: (cmd, args) => {
        if (cmd === "unshare") return { ok: true, status: 0, stdout: "", stderr: "" };
        return { ok: false, status: 1, stdout: "", stderr: "" };
      },
    });
    if (process.platform !== "linux") return;
    expect(cap.capable).toBe(false);
    expect(cap.reason).toBe("no-cap-net-admin");
    expect(cap.unshareOk).toBe(true);
    expect(cap.capNetAdmin).toBe(false);
  });
});

describe("doctor egress.netns default-on-when-capable", () => {
  const assertNoBareShellNetEnforced = (line: DoctorCheck) => {
    const blob = `${line.detail} ${line.hint ?? ""}`;
    expect(textClaimsBareShellNetEnforced(blob)).toBe(false);
  };

  test("egress.netns.capability surfaces capable=false reason on WSL probe", () => {
    setProductNetnsCapProbeForTests(undefined);
    const line = byId(
      runDoctor(
        fakeEnv({
          run: () => ({ ok: false, status: 1, stdout: "", stderr: "" }),
        }),
      ),
      "egress.netns.capability",
    );
    expect(line.status).toBe("warn");
    expect(line.detail).toContain("capable=");
    expect(line.detail).toContain("reason=");
    expect(line.detail).toContain("715");
    assertNoBareShellNetEnforced(line);
    const wslInjected = formatProductNetnsCapabilityDoctorDetail(incapableWsl);
    expect(wslInjected).toContain("reason=wsl");
    expect(textClaimsBareShellNetEnforced(wslInjected)).toBe(false);
  });

  test("egress.netns.route names probe gap without claiming enforced", () => {
    setProductNetnsCapProbeForTests(false);
    const line = byId(runDoctor(fakeEnv()), "egress.netns.route");
    expect(line.status).toBe("warn");
    expect(line.detail.toLowerCase()).toContain("never");
    expect(line.detail).toMatch(/default-off/i);
    expect(line.detail).toContain("TLS MITM");
    assertNoBareShellNetEnforced(line);
  });

  test("egress.netns.route projects default-on when injected capable", () => {
    setProductNetnsCapProbeForTests(true);
    const line = byId(runDoctor(fakeEnv()), "egress.netns.route");
    expect(line.detail).toContain("672");
    expect(line.detail.toLowerCase()).toContain("never claim shell-net enforced");
    expect(line.detail).toContain("TLS MITM");
    assertNoBareShellNetEnforced(line);
  });

  test("egress.netns.spawn.product merges capability note", () => {
    setProductNetnsCapProbeForTests(true);
    const projected = projectProductNetnsDoctorEnv(
      { HZ_SANDBOX_EXEC: "1", HZ_EGRESS_PROXY: "http://127.0.0.1:9" },
      capableProbe,
    );
    expect(sandboxNetnsHonestyFlag(projected)).toBe(true);
    const line = byId(
      runDoctor({
        ...fakeEnv({
          env: { HZ_SANDBOX_EXEC: "1", HZ_EGRESS_PROXY: "http://127.0.0.1:9" },
        }),
      }),
      "egress.netns.spawn.product",
    );
    expect(line.detail).toContain("672");
    expect(line.detail.toLowerCase()).toContain("never claim");
    assertNoBareShellNetEnforced(line);
  });

  test("effect.host documents product netns spine", () => {
    setProductNetnsCapProbeForTests(false);
    const off = byId(runDoctor(fakeEnv()), "effect.host");
    expect(off.detail).toContain("672");
    expect(off.detail.toLowerCase()).toContain("product netns");
  });
});