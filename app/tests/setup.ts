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
delete process.env.HZ_EFFECT_HOST_KERNEL;
delete process.env.HZ_ANCHOR_KEY;
delete process.env.HZ_KERNEL_BIN;
delete process.env.HZ_KERNEL_SHA256;
delete process.env.HZ_KERNEL_PIN;
// Bun can search parent directories for `.env`; the repo root has a developer
// .env. Never let it choose the test provider/model.
delete process.env.HZ_MODEL;
delete process.env.HZ_PROVIDER;
delete process.env.HZ_BASE_URL;
delete process.env.HZ_API_KEY;

process.on("exit", () => {
  try {
    rmSync(home, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
});

// `createRuntime` projects `HZ_EFFECT_HOST_KERNEL=default` onto `process.env`
// when the Linux sandbox wrap is active (correct for one product process). Bun
// runs test files in ONE process, so that projection leaked into later files
// and silently changed which execution path they exercised. Clear it per test;
// a file that wants the routed path sets it itself.
afterEach(() => {
  delete process.env.HZ_EFFECT_HOST_KERNEL;
});
