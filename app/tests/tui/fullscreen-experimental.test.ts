import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import * as path from "node:path";
import { MOCK_GREETING } from "../../src/core/providers/mock";
import { diffBuffers, encodeDiffRuns } from "../../src/tui/cellbuffer";
import {
  experimentalStatusBuffer,
  FULLSCREEN_EXPERIMENTAL_STATUS,
  type FullscreenExperimentalHooks,
} from "../../src/tui/fullscreen-experimental";
import { ENTER_ALT_SCREEN, EscapeWriter, LEAVE_ALT_SCREEN } from "../../src/tui/escape-writer";
import {
  APP_DIR,
  BUN_BIN,
  TUI_MOCK_ENV,
  createWorkspacePool,
  flatten,
  killAllProcesses,
  shellQuote,
  sleep,
  spawnProcess,
  waitFor,
} from "./harness";

const PTY_TIMEOUT_MS = 25_000;

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
const pool = createWorkspacePool();

afterAll(() => {
  pool.cleanup();
  killAllProcesses();
});

function startFullscreenChat(workspace: string) {
  const command = [
    "exec",
    shellQuote(BUN_BIN),
    "run",
    shellQuote(path.join(APP_DIR, "src", "main.ts")),
    "--workspace",
    shellQuote(workspace),
    "--mock",
    "--continue",
  ].join(" ");
  return spawnProcess({
    file: SCRIPT as string,
    args: ["-qec", command, "/dev/null"],
    cwd: APP_DIR,
    env: { ...TUI_MOCK_ENV, HZ_TUI_MODE: "fullscreen-experimental", TERM: "xterm-256color" },
    timeoutMs: PTY_TIMEOUT_MS,
  });
}

describe("fullscreen-experimental probe", () => {
  test("status buffer is one row", () => {
    const buf = experimentalStatusBuffer(80);
    expect(buf.height).toBe(1);
    expect(buf.width).toBe(80);
    const painted = encodeDiffRuns(diffBuffers(null, buf));
    expect(painted).toContain("fullscreen-experimental");
  });

  test("enter, paint, restore sequence", () => {
    const writes: string[] = [];
    let raw = false;
    const hooks: FullscreenExperimentalHooks = {
      write: (d) => writes.push(d),
      enterRawMode: () => {
        raw = true;
      },
      leaveRawMode: () => {
        raw = false;
      },
      columns: 60,
    };
    const writer = new EscapeWriter({ hooks });
    writer.enterFullscreen();
    writer.markCursorHidden();
    hooks.write(encodeDiffRuns(diffBuffers(null, experimentalStatusBuffer(60))));
    writer.restore();
    const joined = writes.join("");
    expect(joined).toContain(ENTER_ALT_SCREEN);
    expect(joined).toContain(LEAVE_ALT_SCREEN);
    expect(raw).toBe(false);
  });
});

if (!SCRIPT) {
  test.skip("fullscreen-experimental: mock turn under alt-screen (needs util-linux `script`)", () => {});
} else {
  test(
    "fullscreen-experimental: mock turn under alt-screen",
    async () => {
      const ws = pool.make({ "alpha.txt": "alpha\n" });
      const proc = startFullscreenChat(ws);
      await sleep(2_000);
      proc.write("hello\n");
      expect(await waitFor(proc, MOCK_GREETING, { timeoutMs: PTY_TIMEOUT_MS })).toBe(true);
      proc.write("\x03");
      const run = await proc.done;
      expect(run.timedOut).toBe(false);
      expect(run.code === 0 || run.code === 130).toBe(true);
      const flat = flatten(run.stdout);
      expect(flat).toContain("mock-1");
      expect(flat).toMatch(/default|mock/);
    },
    PTY_TIMEOUT_MS + 5_000,
  );
}
