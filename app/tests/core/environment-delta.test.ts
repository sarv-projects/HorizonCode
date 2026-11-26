/**
 * environment-delta.test.ts -- Codex incremental environment deltas (docs/28 §14).
 *
 * Long sessions must not resend the whole environment block every dispatch.
 * The first turn keeps the full byte-stable block; later turns send only the
 * fields that changed since that first turn. No clock, no real shell, no fs.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import type { ProviderRequest } from "../../src/contracts";
import { KernelClient } from "../../src/core/kernel";
import { runTurn, type LoopDeps } from "../../src/core/loop";
import { buildSystemPrompt } from "../../src/core/prompt";
import { SessionStore } from "../../src/core/session";
import {
  diffEnvironment,
  environmentFacts,
  environmentRefreshDue,
  hasEnvironmentDelta,
  renderEnvironmentDelta,
  type EnvironmentInfo,
} from "../../src/core/prompt/environment-delta";

const FIXED = new Date("2026-03-04T12:00:00Z");
const BASE: EnvironmentInfo = {
  workspace: "/w/proj",
  today: FIXED,
  os: "linux x64",
  shell: "bash",
  isGitRepo: true,
  kernelMode: "trusted",
  planMode: false,
  tools: ["read", "grep"],
};

describe("environment facts and diff", () => {
  test("facts keep the rendered labels and values", () => {
    const facts = environmentFacts(BASE);
    expect(facts["Working directory (workspace)"]).toBe("/w/proj");
    expect(facts.Date).toBe("2026-03-04");
    expect(facts["Plan mode"]).toBe("off");
    expect(facts.Tools).toBe("read, grep");
  });

  test("diff reports only changed fields in canonical order", () => {
    const delta = diffEnvironment(BASE, { ...BASE, planMode: true, tools: ["read", "grep", "shell"] });
    expect(delta.modified).toEqual([
      { field: "Plan mode", from: "off", to: "on" },
      { field: "Tools", from: "read, grep", to: "read, grep, shell" },
    ]);
    expect(delta.added).toEqual([]);
    expect(delta.removed).toEqual([]);
    expect(hasEnvironmentDelta(delta)).toBe(true);
  });

  test("identical environments produce an empty delta", () => {
    const delta = diffEnvironment(BASE, { ...BASE, today: new Date(FIXED) });
    expect(hasEnvironmentDelta(delta)).toBe(false);
    expect(renderEnvironmentDelta(delta)).toBe("Environment: unchanged since first turn");
  });

  test("date and kernel-mode changes are visible in the delta text", () => {
    const delta = diffEnvironment(BASE, {
      ...BASE,
      today: new Date("2026-03-05T12:00:00Z"),
      kernelMode: "untrusted",
    });
    const text = renderEnvironmentDelta(delta);
    expect(text).toContain("Environment (changes since first turn):");
    expect(text).toContain("- Date: 2026-03-04 -> 2026-03-05");
    expect(text).toContain("- Kernel: trusted -> untrusted");
    expect(text).not.toContain("/w/proj");
  });
});

describe("system prompt with a baseline", () => {
  test("first turn still renders the full environment block", () => {
    const full = buildSystemPrompt("/w/proj", FIXED, { ...BASE, tools: BASE.tools });
    expect(full).toContain("Environment:");
    expect(full).toContain("Working directory (workspace): /w/proj");
    expect(full).toContain("- Tools: read, grep");
  });

  test("later turns render the delta instead of the full block", () => {
    const next = buildSystemPrompt(
      "/w/proj",
      FIXED,
      { ...BASE, planMode: true, tools: ["read", "grep", "shell"] },
      "",
      BASE,
    );
    expect(next).toContain("Environment (changes since first turn):");
    expect(next).toContain("- Plan mode: off -> on");
    expect(next).toContain("- Tools: read, grep -> read, grep, shell");
    expect(next).not.toContain("Working directory (workspace): /w/proj");
    expect(next.endsWith("- Tools: read, grep -> read, grep, shell")).toBe(true);
  });

  test("the static prefix stays byte-identical with a baseline", () => {
    const noBaseline = buildSystemPrompt("/w/proj", FIXED, BASE);
    const withBaseline = buildSystemPrompt("/w/proj", FIXED, BASE, "", BASE);
    const split = (s: string) => s.slice(0, s.indexOf("Environment"));
    expect(split(withBaseline)).toBe(split(noBaseline));
  });
});

describe("periodic full refresh", () => {
  test("refresh is due at the configured turn interval and disabled by 0", () => {
    const env = { HZ_ENVIRONMENT_REFRESH_EVERY: "3" };
    expect(environmentRefreshDue(0, env)).toBe(false);
    expect(environmentRefreshDue(1, env)).toBe(false);
    expect(environmentRefreshDue(3, env)).toBe(true);
    expect(environmentRefreshDue(6, env)).toBe(true);
    expect(environmentRefreshDue(3, { HZ_ENVIRONMENT_REFRESH_EVERY: "0" })).toBe(false);
  });

  test("blank or invalid values fall back to the default interval", () => {
    expect(environmentRefreshDue(19, {})).toBe(false);
    expect(environmentRefreshDue(20, {})).toBe(true);
    expect(environmentRefreshDue(3, { HZ_ENVIRONMENT_REFRESH_EVERY: "nope" })).toBe(false);
  });
});

describe("wired into the turn path", () => {
  test("turn 1 sends the full block, turn 2 with a shared slot sends only the delta", async () => {
    const workspace = mkdtempSync(path.join(tmpdir(), "hz-env-delta-"));
    const systems: string[] = [];
    const fake = {
      name: "fake",
      async *stream(req: ProviderRequest) {
        systems.push(req.system);
        yield { type: "done" as const, stopReason: "end" as const };
      },
    };
    const kernel = new KernelClient({ workspace, stateDir: path.join(workspace, ".hzcode", "kernel") });
    const store = new SessionStore(workspace);
    const sessionId = store.createSession("env").id;
    const slot: { current?: EnvironmentInfo } = {};
    const baseDeps: LoopDeps = {
      workspace,
      sessionId,
      model: "fake-1",
      provider: fake,
      kernel,
      store,
      signal: new AbortController().signal,
      callbacks: { onEvent: () => undefined },
      sessionLeases: [],
      maxProviderCalls: 2,
      promptEnvironmentSlot: slot,
    };
    try {
      await runTurn({ ...baseDeps, planMode: false }, "first");
      expect(slot.current).toBeDefined();
      expect(systems[0]).toContain("Working directory (workspace):");
      expect(systems[0]).not.toContain("changes since first turn");

      await runTurn({ ...baseDeps, planMode: true }, "second");
      expect(systems[1]).toContain("Environment (changes since first turn):");
      expect(systems[1]).toContain("- Plan mode: off -> on");
      expect(systems[1]).not.toContain("Working directory (workspace):");
    } finally {
      await kernel.close();
      store.close();
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  test("a periodic refresh resends the full block and starts a new baseline", async () => {
    const previous = process.env.HZ_ENVIRONMENT_REFRESH_EVERY;
    process.env.HZ_ENVIRONMENT_REFRESH_EVERY = "2";
    const workspace = mkdtempSync(path.join(tmpdir(), "hz-env-refresh-"));
    const systems: string[] = [];
    const fake = {
      name: "fake",
      async *stream(req: ProviderRequest) {
        systems.push(req.system);
        yield { type: "done" as const, stopReason: "end" as const };
      },
    };
    const kernel = new KernelClient({ workspace, stateDir: path.join(workspace, ".hzcode", "kernel") });
    const store = new SessionStore(workspace);
    const sessionId = store.createSession("refresh").id;
    const slot: { current?: EnvironmentInfo; turns?: number } = {};
    const baseDeps: LoopDeps = {
      workspace,
      sessionId,
      model: "fake-1",
      provider: fake,
      kernel,
      store,
      signal: new AbortController().signal,
      callbacks: { onEvent: () => undefined },
      sessionLeases: [],
      maxProviderCalls: 3,
      promptEnvironmentSlot: slot,
    };
    try {
      await runTurn({ ...baseDeps }, "first");
      await runTurn({ ...baseDeps }, "second");
      // Interval 2: turn 1 baseline, turn 2 full refresh, turn 3 delta again.
      expect(systems[1]).toContain("Working directory (workspace):");
      expect(systems[1]).not.toContain("changes since first turn");
      await runTurn({ ...baseDeps }, "third");
      expect(systems[2]).toContain("Environment: unchanged since first turn");
      expect(systems[2]).not.toContain("Working directory (workspace):");
    } finally {
      await kernel.close();
      store.close();
      rmSync(workspace, { recursive: true, force: true });
      if (previous === undefined) delete process.env.HZ_ENVIRONMENT_REFRESH_EVERY;
      else process.env.HZ_ENVIRONMENT_REFRESH_EVERY = previous;
    }
  });
});
