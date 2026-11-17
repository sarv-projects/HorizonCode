import { describe, expect, test } from "bun:test";
import { readFileSync, statSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import {
  ONBOARDING_SEEN_VERSION,
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

  test("not seen by default; seen once after marking", () => {
    const ws = makeWorkspace();
    expect(hasSeenOnboarding(ws)).toBe(false);
    markOnboardingSeen(ws);
    expect(hasSeenOnboarding(ws)).toBe(true);
    // Idempotent.
    markOnboardingSeen(ws);
    expect(hasSeenOnboarding(ws)).toBe(true);
    expect(onboardingSeenFile(ws).startsWith(workspaceStateDir(ws))).toBe(true);
  });

  test("corrupt marker degrades to not-seen", () => {
    const ws = makeWorkspace();
    markOnboardingSeen(ws);
    const file = onboardingSeenFile(ws);
    writeFileSync(file, "{corrupt");
    expect(hasSeenOnboarding(ws)).toBe(false);
  });

  test("persists with 0700 dir and 0600 file (Unix)", () => {
    if (process.platform === "win32") return;
    const ws = makeWorkspace();
    markOnboardingSeen(ws);
    const file = onboardingSeenFile(ws);
    expect(statSync(path.dirname(file)).mode & 0o777).toBe(0o700);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(readFileSync(file, "utf8")).toContain('"seen":true');
  });

  test("opt-out gate still suppresses regardless of seen state", () => {
    const fresh: OnboardingSignals = {
      provider: "mock",
      sources: { provider: "default", model: "default", apiKey: "none" },
    };
    expect(needsOnboarding(fresh, { HZ_NO_ONBOARDING: "1" })).toBe(false);
  });
});
