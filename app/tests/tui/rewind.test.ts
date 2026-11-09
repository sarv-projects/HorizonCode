/**
 * rewind.test.ts — the /rewind command: the checkpoint list and the rewind hook.
 *
 * The commands are unit-level calls to the same handler runInteractive's
 * command table calls (the plan-mode.test.ts pattern): a stub runtime stands in
 * for the core, because a spawned app cannot take a stub and the real core may
 * not expose the rewind hooks yet. Every optional method is tested present,
 * absent and throwing — an old runtime must print one typed line, never crash.
 * One pty case then drives the real chat bar end to end to prove /rewind is
 * reachable there instead of answering "unknown command".
 */

import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import * as path from "node:path";
import type { Runtime } from "../../src/contracts";
import { runRewindCommand, type CheckpointView } from "../../src/tui/interactive";
import { createRenderer } from "../../src/tui/render";
import { strip } from "../../src/tui/style";
import {
  APP_DIR,
  BUN_BIN,
  createWorkspacePool,
  flatten,
  killAllProcesses,
  shellQuote,
  spawnProcess,
  waitFor,
} from "./harness";

interface StubMethods {
  checkpoints?: () => ReadonlyArray<CheckpointView>;
  rewindTo?: (n: number) => Promise<string> | string;
}

/** A checkpoint view with `changes` sized to `count` journal entry ids. */
function view(n: number, at: number, label: string, count: number): CheckpointView {
  return { n, at, label, changes: Array.from({ length: count }, (_, i) => `e${n}-${i}`) };
}

/** Capture the notices and drive the command exactly as runInteractive does. */
function harness(methods: StubMethods = {}) {
  const chunks: string[] = [];
  const renderer = createRenderer({ wrap: false, out: (chunk: string) => void chunks.push(chunk) });
  const runtime = { sessionId: "rewind-tui-test", ...methods } as unknown as Runtime;
  return {
    text: () => chunks.join(""),
    plain: () => strip(chunks.join("")),
    run: (arg = "") => runRewindCommand("rewind", arg, runtime, renderer),
  };
}

describe("/rewind", () => {
  test("bare /rewind lists the newest checkpoints, numbered, newest first", async () => {
    const fourteen = Array.from({ length: 14 }, (_, i) =>
      view(i + 1, 1_700_000_000_000 + i * 1000, `after turn ${i + 1}`, i === 0 ? 1 : 2),
    );
    const h = harness({ checkpoints: () => fourteen });

    expect(await h.run()).toBe(true);
    const out = h.plain();

    expect(out).toContain("checkpoints (newest first, 14 total):");
    expect(out).toContain("1 change"); // the singular
    expect(out).toContain("2 changes");
    // Newest first: n=1's label precedes n=10's, and the two oldest are not listed.
    expect(out.indexOf("after turn 1")).toBeLessThan(out.indexOf("after turn 10"));
    expect(out).not.toContain("after turn 13");
    expect(out).not.toContain("after turn 14");
    expect(out).toContain("4 older checkpoint(s)");
    const lines = out.split("\n").filter((line) => /^\s+\d+\) /.test(line));
    expect(lines.length).toBe(10);
    expect(lines[0]).toMatch(/^\s+1\) \d{4}-\d{2}-\d{2} \d{2}:\d{2} \u2014 after turn 1, 1 change$/);
    expect(lines[9]).toMatch(/^\s+10\) .* after turn 10, 2 changes$/);
  });

  test("an unlabelled checkpoint prints (no label), and an empty store says so", async () => {
    const unlabelled = harness({ checkpoints: () => [view(1, 1_700_000_000_000, "", 0)] });
    await unlabelled.run();
    expect(unlabelled.plain()).toContain("(no label), 0 changes");

    const empty = harness({ checkpoints: () => [] });
    await empty.run();
    expect(empty.plain()).toContain("no checkpoints yet");
  });

  test("/rewind 2 calls the runtime with n and prints the runtime's summary", async () => {
    const calls: number[] = [];
    const h = harness({
      rewindTo: async (n) => {
        calls.push(n);
        return "restored 3 file(s) to checkpoint 2; 1 skipped (nonRestorable)";
      },
    });

    expect(await h.run("2")).toBe(true);
    expect(calls).toEqual([2]);
    expect(h.plain()).toContain("rewound: restored 3 file(s) to checkpoint 2; 1 skipped (nonRestorable)");
  });

  test("/rewind without a summary still reports the target", async () => {
    const h = harness({ rewindTo: async () => "" });
    await h.run("3");
    expect(h.plain()).toContain("rewound: checkpoint 3");
  });

  test("a bad number is a usage line and no hook is called", async () => {
    const calls: number[] = [];
    const h = harness({
      rewindTo: (n) => {
        calls.push(n);
        return "x";
      },
    });

    await h.run("0");
    await h.run("x");
    await h.run("-2");
    expect(h.plain()).toContain("usage: /rewind <n>");
    expect(calls).toEqual([]);
  });

  test("an absent list hook degrades typed", async () => {
    const h = harness();
    expect(await h.run()).toBe(true);
    expect(h.plain()).toContain("not supported by this runtime: checkpoints");
  });

  test("an absent rewind hook degrades typed and never crashes", async () => {
    const h = harness({ checkpoints: () => [view(1, 1, "one", 1)] });
    expect(await h.run("1")).toBe(true);
    expect(h.plain()).toContain("not supported by this runtime: rewindTo");
  });

  test("throwing hooks are reported, not fatal", async () => {
    const list = harness({
      checkpoints: () => {
        throw new Error("store gone");
      },
    });
    await list.run();
    expect(list.plain()).toContain("could not list checkpoints: store gone");

    const rewind = harness({
      rewindTo: async () => {
        throw new Error("journal corrupt");
      },
    });
    await rewind.run("1");
    expect(rewind.plain()).toContain("could not rewind: journal corrupt");
  });

  test("a name that is not the rewind command is left to the caller", async () => {
    const chunks: string[] = [];
    const renderer = createRenderer({ wrap: false, out: (chunk: string) => void chunks.push(chunk) });
    const runtime = { sessionId: "rewind-tui-test" } as unknown as Runtime;

    expect(await runRewindCommand("plan", "", runtime, renderer)).toBe(false);
    expect(chunks.join("")).toBe("");
  });
});

/* ------------------------- the real chat bar ------------------------- */

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

/** Start `hzcode` inside a pty, with the pty's input coming from our pipe. */
function startChat(workspace: string) {
  const command = [
    "exec",
    shellQuote(BUN_BIN),
    "run",
    shellQuote(path.join(APP_DIR, "src", "main.ts")),
    "--workspace",
    shellQuote(workspace),
    "--mock",
  ].join(" ");
  return spawnProcess({
    file: SCRIPT as string,
    args: ["-qec", command, "/dev/null"],
    cwd: APP_DIR,
    env: { NO_COLOR: "1", TERM: "xterm-256color" },
    timeoutMs: PTY_TIMEOUT_MS,
  });
}

if (!SCRIPT) {
  test.skip("chat bar: /rewind is reachable and never crashes (needs util-linux `script`)", () => {});
} else {
  test(
    "chat bar: /rewind is reachable and never crashes",
    async () => {
      const ws = pool.make();
      const proc = startChat(ws);

      proc.write("/help\n");
      expect(await waitFor(proc, "/rewind [n]")).toBe(true);

      proc.write("/rewind\n");
      // With the hooks wired this is a list (empty here: no turns ran); without
      // them the command says so. Both are a pass: the requirement is that it
      // never crashes and never looks like an unknown command.
      expect(
        await waitFor(proc, /no checkpoints yet|checkpoints \(newest first|not supported by this runtime: checkpoints/),
      ).toBe(true);

      proc.write("/exit\n");
      const run = await proc.done;
      const out = flatten(run.stdout);

      expect(run.timedOut).toBe(false);
      expect(run.signal).toBeNull();
      expect(run.code).toBe(0);
      expect(out).not.toContain("unknown command /rewind");
    },
    PTY_TIMEOUT_MS + 5_000,
  );
}
