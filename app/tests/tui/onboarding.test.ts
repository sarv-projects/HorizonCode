/**
 * onboarding.test.ts — I-8 / ruling 509: first-run guided onboarding.
 *
 * The hints must be real (`--list-models` in --help, `login` with its own
 * usage), the notice must appear only for a fresh unconfigured human at a TTY,
 * and it must never reach a pipe or -p run. The decision helpers are pure so
 * the content and the gate are asserted without driving the chat loop.
 */

import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import * as path from "node:path";
import {
  ONBOARDING_OPT_OUT_ENV,
  needsOnboarding,
  onboardingNoticeLines,
  onboardingOptedOut,
  type OnboardingSignals,
} from "../../src/tui/interactive";
import {
  APP_DIR,
  BUN_BIN,
  TUI_MOCK_ENV,
  appSpec,
  collapseWhitespace,
  createWorkspacePool,
  flatten,
  killAllProcesses,
  runApp,
  shellQuote,
  spawnProcess,
  waitFor,
  waitForPrompt,
} from "./harness";

const pool = createWorkspacePool();
afterEach(() => killAllProcesses());
afterAll(() => {
  pool.cleanup();
  killAllProcesses();
});

/** A genuinely fresh config: default mock provider, no key, no chosen model. */
const FRESH: OnboardingSignals = {
  provider: "mock",
  sources: { provider: "default", model: "default", apiKey: "none" },
};

/**
 * The host running the suite may have provider keys exported. The harness only
 * clears HZ_* vars, so explicitly drop the provider-specific ones too: without
 * this, config detects `openai` and the "unconfigured" case is not unconfigured.
 * childEnv skips undefined values.
 */
const FRESH_ENV: Record<string, string | undefined> = {
  OPENAI_API_KEY: undefined,
  ANTHROPIC_API_KEY: undefined,
  GEMINI_API_KEY: undefined,
  GOOGLE_API_KEY: undefined,
  NVIDIA_API_KEY: undefined,
  HZ_API_KEY: undefined,
  // The developer's user config may select a real provider (e.g. nvidia); a
  // genuinely fresh session must be forced back to the offline mock.
  HZ_PROVIDER: "mock",
};

/* ------------------------- pure decision helpers ------------------------- */

describe("needsOnboarding (pure)", () => {
  test("a default mock config with no key/model needs onboarding", () => {
    expect(needsOnboarding(FRESH, {})).toBe(true);
  });

  test("a key from env or from file suppresses the notice", () => {
    expect(needsOnboarding({ ...FRESH, sources: { ...FRESH.sources, apiKey: "env" } }, {})).toBe(false);
    expect(needsOnboarding({ ...FRESH, sources: { ...FRESH.sources, apiKey: "file" } }, {})).toBe(false);
  });

  test("an explicitly chosen model suppresses the notice", () => {
    expect(needsOnboarding({ ...FRESH, sources: { ...FRESH.sources, model: "env" } }, {})).toBe(false);
    expect(needsOnboarding({ ...FRESH, sources: { ...FRESH.sources, model: "file" } }, {})).toBe(false);
  });

  test("a real provider selected from config suppresses the notice", () => {
    expect(needsOnboarding({ provider: "anthropic", sources: { ...FRESH.sources, provider: "file" } }, {})).toBe(false);
  });

  test("the opt-out environment switch suppresses the notice", () => {
    for (const value of ["1", "true", "YES", "on"]) {
      expect(onboardingOptedOut({ [ONBOARDING_OPT_OUT_ENV]: value })).toBe(true);
      expect(needsOnboarding(FRESH, { [ONBOARDING_OPT_OUT_ENV]: value })).toBe(false);
    }
    expect(needsOnboarding(FRESH, { [ONBOARDING_OPT_OUT_ENV]: "0" })).toBe(true);
  });

  test("an absent sources object is handled without throwing", () => {
    expect(needsOnboarding({ provider: "mock" } as OnboardingSignals, {})).toBe(false);
  });
});

describe("onboarding notice content", () => {
  const lines = onboardingNoticeLines();
  const text = lines.join("\n");

  test("names the login command, --list-models, the zero-config mock and the opt-out", () => {
    expect(text).toContain("hzcode login");
    expect(text).toContain("--list-models");
    expect(text).toContain("--mock");
    expect(text).toContain(ONBOARDING_OPT_OUT_ENV);
  });

  test("is short, plain text and auto-sends nothing", () => {
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.length).toBeLessThanOrEqual(5);
    expect(text).not.toContain("\u001b");
    // The notice only *suggests* commands; it never performs a turn or a network call.
    expect(/hzcode login <provider>|hzcode --list-models|hzcode --mock/.test(text)).toBe(true);
  });
});

/* --------------------------- hints are real ------------------------------ */

describe("onboarding hints are accurate", () => {
  test("--help documents --list-models and --mock; login has its own usage line", async () => {
    const help = await runApp(appSpec(["--help"]));
    expect(help.code).toBe(0);
    expect(help.stdout).toContain("--list-models");
    expect(help.stdout).toContain("--mock");

    const login = await runApp(appSpec(["login"]));
    expect(login.stderr).toContain("usage: hzcode login <provider> [--device]");
  }, 15_000);
});

/* ---------------------- no notice on scripted runs ----------------------- */

describe("headless / non-TTY runs", () => {
  test("-p with a fresh config never prints the onboarding notice", async () => {
    const ws = pool.make();
    // Drop the harness' pinned HZ_MODEL and any detected provider key so the
    // config really is "unconfigured".
    const run = await runApp(appSpec(["--workspace", ws, "-p", "hello"], { ...FRESH_ENV, HZ_MODEL: undefined }), "");
    expect(run.timedOut).toBe(false);
    expect(run.code).toBe(0);
    expect(run.stdout + run.stderr).not.toContain("no provider key or model configured");
    expect(run.stdout + run.stderr).not.toContain("hide this notice");
  }, 15_000);

  test("a piped (non-TTY) chat session never prints the onboarding notice", async () => {
    const ws = pool.make();
    const run = await runApp(appSpec(["--workspace", ws], { ...FRESH_ENV, HZ_MODEL: undefined }), "hello\n");
    expect(run.timedOut).toBe(false);
    expect(run.stdout + run.stderr).not.toContain("no provider key or model configured");
    expect(run.stdout + run.stderr).not.toContain("hide this notice");
  }, 15_000);
});

/* ------------------------- human at a real TTY --------------------------- */

function findScript(): string | null {
  try {
    const probe = spawnSync("sh", ["-c", "command -v script"], { encoding: "utf8" });
    const found = String(probe.stdout ?? "").trim();
    return probe.status === 0 && found !== "" ? found : null;
  } catch {
    return null;
  }
}

const SCRIPT = findScript();
const PTY_TIMEOUT_MS = 35_000;

/** Start `hzcode` inside a pty with a genuinely first-run config (no pinned model). */
function startChat(workspace: string, env: Record<string, string | undefined> = {}) {
  const command = [
    "exec",
    shellQuote(BUN_BIN),
    "--no-env-file",
    "run",
    shellQuote(path.join(APP_DIR, "src", "main.ts")),
    "--workspace",
    shellQuote(workspace),
  ].join(" ");
  return spawnProcess({
    file: SCRIPT as string,
    args: ["-qec", command, "/dev/null"],
    cwd: APP_DIR,
    env: { ...TUI_MOCK_ENV, ...FRESH_ENV, HZ_MODEL: undefined, ...env, TERM: "xterm-256color" },
    timeoutMs: PTY_TIMEOUT_MS,
  });
}

if (SCRIPT === null) {
  test.skip("interactive first-run notice needs util-linux `script` (PTY)", () => {});
} else {
  test("a fresh unconfigured PTY session shows the full notice", async () => {
    const proc = startChat(pool.make());
    expect(await waitFor(proc, "no provider key or model configured")).toBe(true);
    // A pty wraps long lines and streams the notice in fragments under load;
    // collapse whitespace and wait for all four hints before asserting.
    let text = "";
    for (let attempt = 0; attempt < 100; attempt += 1) {
      text = collapseWhitespace(flatten(proc.stdout()));
      if (
        text.includes("hzcode login") &&
        text.includes("--list-models") &&
        text.includes("--mock") &&
        text.includes(ONBOARDING_OPT_OUT_ENV)
      ) break;
      await Bun.sleep(100);
    }
    expect(text).toContain("hzcode login");
    expect(text).toContain("--list-models");
    expect(text).toContain("--mock");
    expect(text).toContain(ONBOARDING_OPT_OUT_ENV);
  }, 30_000);

  test("a configured PTY session keeps the banner byte-compatible (no notice)", async () => {
    const proc = startChat(pool.make(), { HZ_API_KEY: "sk-not-a-real-key" });
    expect(await waitForPrompt(proc)).toBe(true);
    const text = collapseWhitespace(flatten(proc.stdout()));
    expect(text).toContain("HzCode");
    expect(text).not.toContain("no provider key or model configured");
    expect(text).not.toContain("hide this notice");
  }, 30_000);

  test("HZ_NO_ONBOARDING opts out of the notice in a PTY session", async () => {
    const proc = startChat(pool.make(), { [ONBOARDING_OPT_OUT_ENV]: "1" });
    expect(await waitForPrompt(proc)).toBe(true);
    const text = collapseWhitespace(flatten(proc.stdout()));
    expect(text).toContain("HzCode");
    expect(text).not.toContain("no provider key or model configured");
    expect(text).not.toContain("hide this notice");
  }, 30_000);
}
