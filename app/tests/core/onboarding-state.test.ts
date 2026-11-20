import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import {
  ONBOARDING_SEEN_VERSION,
  admitOnboardingSeenWrite,
  hasSeenOnboarding,
  markOnboardingSeen,
  onboardingSeenFile,
  parseOnboardingSeen,
} from "../../src/core/onboarding-state";
import { workspaceStateDir } from "../../src/core/paths";
import { needsOnboarding, type OnboardingSignals } from "../../src/tui/interactive";
import { makeWorkspace } from "../tools/helpers";

describe("onboarding seen-once state (I-8 residual)", () => {
  test("parse is strict about version and seen flag", () => {
    expect(parseOnboardingSeen(JSON.stringify({ version: ONBOARDING_SEEN_VERSION, seen: true }))).toBe(true);
    expect(parseOnboardingSeen(JSON.stringify({ version: ONBOARDING_SEEN_VERSION, seen: false }))).toBe(false);
    expect(parseOnboardingSeen(JSON.stringify({ version: 999, seen: true }))).toBe(false);
    expect(parseOnboardingSeen("not json")).toBe(false);
  });

  test("not seen by default; seen once after marking", async () => {
    const ws = makeWorkspace();
    expect(hasSeenOnboarding(ws)).toBe(false);
    await markOnboardingSeen(ws);
    expect(hasSeenOnboarding(ws)).toBe(true);
    // Idempotent.
    await markOnboardingSeen(ws);
    expect(hasSeenOnboarding(ws)).toBe(true);
    expect(onboardingSeenFile(ws).startsWith(workspaceStateDir(ws))).toBe(true);
  }, 20_000);

  test("corrupt marker degrades to not-seen", async () => {
    const ws = makeWorkspace();
    await markOnboardingSeen(ws);
    const file = onboardingSeenFile(ws);
    writeFileSync(file, "{corrupt");
    expect(hasSeenOnboarding(ws)).toBe(false);
  }, 20_000);

  test("persists with 0700 dir and 0600 file (Unix)", async () => {
    if (process.platform === "win32") return;
    const ws = makeWorkspace();
    await markOnboardingSeen(ws);
    const file = onboardingSeenFile(ws);
    expect(statSync(path.dirname(file)).mode & 0o777).toBe(0o700);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(readFileSync(file, "utf8")).toContain('"seen":true');
  }, 20_000);

  test("admitOnboardingSeenWrite refuses deny before persist (ruling 587)", async () => {
    const ws = makeWorkspace();
    const prevBin = process.env.HZ_KERNEL_BIN;
    process.env.HZ_KERNEL_BIN = path.join(ws, "no-such-hz-kernel");
    try {
      const kernelState = path.join(ws, ".hzcode", "kernel");
      mkdirSync(kernelState, { recursive: true });
      writeFileSync(
        path.join(kernelState, "policy.json"),
        JSON.stringify([{ kind: "fs.write", scope: "workspace", decision: "deny", reason: "test-deny-onboarding" }]),
        "utf8",
      );
      const refused = await admitOnboardingSeenWrite(ws);
      expect(refused).toMatch(/denied|test-deny-onboarding|onboarding-seen/i);
      const markRefused = await markOnboardingSeen(ws);
      expect(markRefused).toMatch(/denied|test-deny-onboarding|onboarding-seen/i);
      expect(hasSeenOnboarding(ws)).toBe(false);
      expect(existsSync(onboardingSeenFile(ws))).toBe(false);
    } finally {
      if (prevBin === undefined) delete process.env.HZ_KERNEL_BIN;
      else process.env.HZ_KERNEL_BIN = prevBin;
    }
  }, 20_000);

  test("opt-out gate still suppresses regardless of seen state", () => {
    const fresh: OnboardingSignals = {
      provider: "mock",
      sources: { provider: "default", model: "default", apiKey: "none" },
    };
    expect(needsOnboarding(fresh, { HZ_NO_ONBOARDING: "1" })).toBe(false);
  });
});
