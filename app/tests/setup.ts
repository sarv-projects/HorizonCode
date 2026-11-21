/**
 * Test preload: hermetic HOME.
 *
 * The suite previously inherited the developer's real `$HOME`: a user config
 * with `theme: light` changed TUI palette assertions, and every host skill
 * under `~/.claude/skills` / `~/.agents/skills` was discovered by tests that
 * did not pass their own home. Both are environmental, not product, failures.
 * Give every test process a fresh temporary home before any test file loads.
 */
import { afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";

const home = mkdtempSync(path.join(tmpdir(), "hz-test-home-"));
process.env.HOME = home;
process.env.USERPROFILE = home;
// Git tests create throwaway repos; a temp HOME has no ~/.gitconfig.
process.env.GIT_AUTHOR_NAME = "HorizonCode Tests";
process.env.GIT_AUTHOR_EMAIL = "tests@horizoncode.invalid";
process.env.GIT_COMMITTER_NAME = "HorizonCode Tests";
process.env.GIT_COMMITTER_EMAIL = "tests@horizoncode.invalid";
process.env.GIT_CONFIG_NOSYSTEM = "1";
// The harness sets these per spawn; clear inherited values that would otherwise
// make a test pass/fail based on the developer's shell.
delete process.env.HZ_THEME;
delete process.env.HZ_SANDBOX_REQUIRE;
delete process.env.HZ_ANCHOR_KEY;
delete process.env.HZ_KERNEL_BIN;
delete process.env.HZ_KERNEL_SHA256;
delete process.env.HZ_KERNEL_PIN;
delete process.env.HZ_EFFECT_RECONCILE_BLOCK;
delete process.env.HZ_EFFECT_R170_BUN;
delete process.env.HZ_EFFECT_R170_BUN_TIMEOUT_MS;
delete process.env.HZ_GUARD_G1_WIRE;
process.env.HZ_SUPERVISOR_LEASE = "0";
// Bun can search parent directories for `.env`; the repo root has a developer
// .env. Never let it choose the test provider/model.
delete process.env.HZ_MODEL;
delete process.env.HZ_PROVIDER;
delete process.env.HZ_BASE_URL;
delete process.env.HZ_API_KEY;

// Pin EffectHost off for the suite. `createRuntime` auto-projects `=require`
// when a trusted Rust kernel is discovered (ruling 540) and `=resource`
// reconcile-block when the spine is active (538). Leaving the env unset lets
// that projection stick for the rest of the bun process and breaks applyPlan /
// subagent / kernelless fallback tests. Explicit `0` wins over auto-projection;
// suites that need require/default set it themselves via setEnv.
process.env.HZ_EFFECT_HOST_KERNEL = "0";

process.on("exit", () => {
  try {
    rmSync(home, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
});

// Bun runs test files in ONE process. Reset spine env after every test so a
// file that opted into require/reconcile cannot poison the next file.
afterEach(() => {
  process.env.HZ_EFFECT_HOST_KERNEL = "0";
  delete process.env.HZ_EFFECT_RECONCILE_BLOCK;
delete process.env.HZ_EFFECT_R170_BUN;
delete process.env.HZ_EFFECT_R170_BUN_TIMEOUT_MS;
delete process.env.HZ_GUARD_G1_WIRE;
process.env.HZ_SUPERVISOR_LEASE = "0";
});
