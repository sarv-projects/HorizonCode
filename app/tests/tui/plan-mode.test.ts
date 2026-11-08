/**
 * plan-mode.test.ts — the /plan, /changes, /apply and /discard commands, and
 * the diff they print.
 *
 * The commands are unit-level calls to the same handler runInteractive's
 * command table calls (the approval.test.ts pattern): a stub runtime stands in
 * for the core, because a spawned app cannot take a stub and the real core may
 * not expose the plan hooks yet. Every optional method is tested both present
 * and absent — an old runtime must print one typed line, never crash. One pty
 * case then drives the real chat bar end to end to prove the commands are
 * reachable there and that the help text names them.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import * as path from "node:path";
import type { ApprovalRequest, Runtime, RuntimeEvent } from "../../src/contracts";
import { unifiedDiff } from "../../src/core/plan";
import { createApprovalHandler, type ApprovalUi } from "../../src/tui/approval";
import { planPrompt, runPlanCommand, type StagedChangeView } from "../../src/tui/interactive";
import { createRenderer, diffBlock, previewOf } from "../../src/tui/render";
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
  setPlanMode?: (on: boolean) => unknown;
  planMode?: () => boolean;
  stagedChanges?: () => ReadonlyArray<StagedChangeView>;
  applyPlan?: () => Promise<string>;
  discardPlan?: () => number;
}

/** Capture the notices and drive the command exactly as runInteractive does. */
function harness(methods: StubMethods = {}) {
  const chunks: string[] = [];
  const renderer = createRenderer({ wrap: false, out: (chunk: string) => void chunks.push(chunk) });
  const runtime = { sessionId: "plan-tui-test", ...methods } as unknown as Runtime;
  const state = { on: false };
  return {
    state,
    text: () => chunks.join(""),
    plain: () => strip(chunks.join("")),
    run: (name: string, arg = "") => runPlanCommand(name, arg, runtime, renderer, state),
  };
}

describe("/plan", () => {
  test("toggles through the runtime hook, and the badge follows the reported mode", async () => {
    const toggles: boolean[] = [];
    const h = harness({
      setPlanMode: (on: boolean) => void toggles.push(on),
      planMode: () => toggles.at(-1) ?? false,
    });

    expect(await h.run("plan")).toBe(true);
    expect(toggles).toEqual([true]);
    expect(h.state.on).toBe(true);
    expect(h.plain()).toContain("plan mode on");

    expect(await h.run("plan")).toBe(true);
    expect(toggles).toEqual([true, false]);
    expect(h.state.on).toBe(false);
    expect(h.plain()).toContain("plan mode off");
  });

  test("on and off set the mode explicitly; anything else is a usage line", async () => {
    const toggles: boolean[] = [];
    const h = harness({ setPlanMode: (on: boolean) => void toggles.push(on), planMode: () => toggles.at(-1) ?? false });

    await h.run("plan", "on");
    await h.run("plan", "on");
    expect(toggles).toEqual([true, true]);
    await h.run("plan", "off");
    expect(toggles).toEqual([true, true, false]);
    expect(h.state.on).toBe(false);

    await h.run("plan", "maybe");
    expect(h.plain()).toContain("usage: /plan [on|off]");
    expect(toggles).toEqual([true, true, false]);
  });

  test("the badge is exactly the PLAN marker while the mode is on", () => {
    expect(strip(planPrompt(true))).toBe("PLAN \u276f ");
    expect(strip(planPrompt(false))).toBe("\u276f ");
  });

  test("a runtime without the hook refuses, and the badge does not lie", async () => {
    const h = harness();

    expect(await h.run("plan")).toBe(true);
    expect(h.plain()).toContain("not supported by this runtime: setPlanMode");
    expect(h.state.on).toBe(false);
  });

  test("a runtime that can set but cannot report keeps the requested mode", async () => {
    const h = harness({ setPlanMode: () => undefined });

    await h.run("plan");
    expect(h.state.on).toBe(true);
    await h.run("plan");
    expect(h.state.on).toBe(false);
  });

  test("a hook that throws is reported, not fatal", async () => {
    const h = harness({
      setPlanMode: () => {
        throw new Error("core is busy");
      },
    });

    await h.run("plan");
    expect(h.plain()).toContain("could not change plan mode: core is busy");
    expect(h.state.on).toBe(false);
  });
});

describe("/changes", () => {
  test("lists each staged file and shows its diff", async () => {
    const h = harness({
      stagedChanges: () => [
        { rel: "a.txt", before: "one\n", after: "ONE\n" },
        { rel: "b.txt", before: null, after: "new\n" },
      ],
    });

    await h.run("changes");
    const out = h.plain();

    expect(out).toContain("staged changes (2):");
    expect(out).toContain("a.txt");
    expect(out).toContain("b.txt");
    expect(out).toContain("-one");
    expect(out).toContain("+ONE");
    expect(out).toContain("--- /dev/null");
    expect(out).toContain("+new");
    // The diff lines carry the card indent, the same look as the event renderer.
    expect(out).toContain("  --- a.txt");
  });

  test("a long diff is capped with the explicit marker", async () => {
    const before = Array.from({ length: 40 }, (_, i) => `old ${i}`).join("\n") + "\n";
    const after = Array.from({ length: 40 }, (_, i) => `new ${i}`).join("\n") + "\n";
    const h = harness({ stagedChanges: () => [{ rel: "big.txt", before, after }] });

    await h.run("changes");
    const out = h.plain();

    expect(out).toMatch(/\.\.\. \d+ more lines/);
    // /changes promises about 20 diff lines per file; the marker is one of them.
    const tail = out.split("big.txt")[1] ?? "";
    expect(tail.split("\n").filter((line) => line.trim() !== "").length).toBeLessThanOrEqual(20);
  });

  test("a precomputed diff is used as-is; a bare name still lists", async () => {
    const h = harness({
      stagedChanges: () => [
        { rel: "c.txt", diff: "--- c.txt\n+++ c.txt\n@@ -1,1 +1,1 @@\n-x\n+y\n" },
        { rel: "d.txt" },
      ],
    });

    await h.run("changes");
    expect(h.plain()).toContain("+y");
    expect(h.plain()).toContain("d.txt");
  });

  test("nothing staged says so; an absent hook and a throwing hook degrade", async () => {
    const empty = harness({ stagedChanges: () => [] });
    await empty.run("changes");
    expect(empty.plain()).toContain("no staged changes");

    const missing = harness();
    await missing.run("changes");
    expect(missing.plain()).toContain("not supported by this runtime: stagedChanges");

    const broken = harness({
      stagedChanges: () => {
        throw new Error("store gone");
      },
    });
    await broken.run("changes");
    expect(broken.plain()).toContain("could not list staged changes: store gone");
  });
});

describe("/apply and /discard", () => {
  test("/apply prints the runtime's summary line", async () => {
    const h = harness({ applyPlan: async () => "wrote 2 file(s) from the staged plan" });

    expect(await h.run("apply")).toBe(true);
    expect(h.plain()).toContain("applied: wrote 2 file(s) from the staged plan");
  });

  test("/apply without a summary still reports that it applied", async () => {
    const h = harness({ applyPlan: async () => "" });

    await h.run("apply");
    expect(h.plain()).toContain("applied: the staged plan is applied");
  });

  test("/apply failures and an absent hook are announced, not thrown", async () => {
    const broken = harness({
      applyPlan: async () => {
        throw new Error("disk full");
      },
    });
    await broken.run("apply");
    expect(broken.plain()).toContain("could not apply the staged plan: disk full");

    const missing = harness();
    await missing.run("apply");
    expect(missing.plain()).toContain("not supported by this runtime: applyPlan");
  });

  test("/discard reports the count it dropped", async () => {
    const three = harness({ discardPlan: () => 3 });
    await three.run("discard");
    expect(three.plain()).toContain("discarded 3 staged changes");

    const one = harness({ discardPlan: () => 1 });
    await one.run("discard");
    expect(one.plain()).toContain("discarded 1 staged change");

    const none = harness({ discardPlan: () => 0 });
    await none.run("discard");
    expect(none.plain()).toContain("nothing to discard");
  });

  test("/discard failures and an absent hook are announced, not thrown", async () => {
    const broken = harness({
      discardPlan: () => {
        throw new Error("store gone");
      },
    });
    await broken.run("discard");
    expect(broken.plain()).toContain("could not discard the staged plan: store gone");

    const missing = harness();
    await missing.run("discard");
    expect(missing.plain()).toContain("not supported by this runtime: discardPlan");
  });

  test("a name that is not a plan command is left to the caller", async () => {
    const h = harness();

    expect(await h.run("nope")).toBe(false);
    expect(h.text()).toBe("");
  });
});

describe("graceful degradation", () => {
  test("every command with a bare runtime prints a typed line and nothing crashes", async () => {
    const h = harness();

    for (const name of ["plan", "changes", "apply", "discard"]) {
      expect(await h.run(name)).toBe(true);
    }
    const out = h.plain();
    for (const method of ["setPlanMode", "stagedChanges", "applyPlan", "discardPlan"]) {
      expect(out).toContain(`not supported by this runtime: ${method}`);
    }
    expect(h.state.on).toBe(false);
  });
});

describe("diffBlock", () => {
  test("renders headers, hunks, additions and deletions with the card indent", () => {
    const diff = unifiedDiff(
      "one\ntwo\nthree\nfour\nfive\nsix\nseven\n",
      "one\ntwo\nthree\nFOUR\nfive\nsix\nseven\n",
      "f.txt",
    );

    expect(strip(diffBlock(diff))).toBe(
      [
        "  --- f.txt",
        "  +++ f.txt",
        "  @@ -1,7 +1,7 @@",
        "   one",
        "   two",
        "   three",
        "  -four",
        "  +FOUR",
        "   five",
        "   six",
        "   seven",
      ].join("\n"),
    );
  });

  test("keeps the truncation marker as its last line", () => {
    const before = Array.from({ length: 40 }, (_, i) => `old ${i}`).join("\n") + "\n";
    const after = Array.from({ length: 40 }, (_, i) => `new ${i}`).join("\n") + "\n";
    const block = strip(diffBlock(unifiedDiff(before, after, "big.txt", 12)));

    expect(block.split("\n").length).toBe(12);
    expect(block.split("\n").at(-1)).toMatch(/^  \.\.\. \d+ more lines$/);
  });

  test("empty in, empty out; control characters are stripped", () => {
    expect(diffBlock("")).toBe("");
    expect(diffBlock("\n")).toBe("");
    expect(diffBlock("+evil\u001b[2J")).not.toContain("\u001b[2J");
    expect(diffBlock("+bell\u0007")).not.toContain("\u0007");
    expect(previewOf({})).toBe("");
    expect(previewOf({ preview: "  x" })).toBe("  x");
    expect(previewOf({ preview: 42 })).toBe("");
  });
});

describe("the event renderer's preview", () => {
  test("a tool card with a preview prints the diff under the card", () => {
    const chunks: string[] = [];
    const renderer = createRenderer({ wrap: false, out: (chunk: string) => void chunks.push(chunk) });
    const card = {
      type: "tool.card",
      callId: "call-1",
      name: "write",
      args: { path: "a.txt" },
      status: "ok",
      summary: "staged for review",
      preview: "--- a.txt\n+++ a.txt\n@@ -1,1 +1,1 @@\n-one\n+ONE\n",
    } as unknown as RuntimeEvent;

    renderer.handle(card);
    const out = strip(chunks.join(""));

    expect(out).toContain("staged for review");
    expect(out).toContain("-one");
    expect(out).toContain("+ONE");
    expect(out.indexOf("staged for review")).toBeLessThan(out.indexOf("+ONE"));
  });

  test("a card without a preview prints exactly as before", () => {
    const chunks: string[] = [];
    const renderer = createRenderer({ wrap: false, out: (chunk: string) => void chunks.push(chunk) });

    renderer.handle({ type: "tool.card", callId: "c", name: "read", args: { path: "a.txt" }, status: "ok", summary: "alpha.txt" });
    const out = strip(chunks.join(""));

    // The completion card is the summary line; nothing diff-shaped was added.
    expect(out).toContain("ok: alpha.txt");
    expect(out).not.toContain("---");
  });
});

describe("the approval prompt's preview", () => {
  test("an optional preview is shown before the question", async () => {
    const chunks: string[] = [];
    const ui: ApprovalUi = {
      interactive: true,
      ask: async () => "n",
      renderer: createRenderer({ wrap: false, out: (chunk: string) => void chunks.push(chunk) }),
    };
    const request = {
      kind: "fs.write",
      title: "write a.txt",
      detail: "/ws/a.txt",
      preview: "--- a.txt\n+++ a.txt\n@@ -1,1 +1,1 @@\n-one\n+ONE\n",
    } as unknown as ApprovalRequest;

    const approved = await createApprovalHandler(ui)(request);
    const out = strip(chunks.join(""));

    expect(approved).toBe(false);
    expect(out).toContain("Approve write a.txt?");
    expect(out).toContain("+ONE");
    expect(out.indexOf("Approve write a.txt?")).toBeLessThan(out.indexOf("+ONE"));
  });

  test("without a preview the prompt is unchanged", async () => {
    const chunks: string[] = [];
    const ui: ApprovalUi = {
      interactive: true,
      ask: async () => "y",
      renderer: createRenderer({ wrap: false, out: (chunk: string) => void chunks.push(chunk) }),
    };

    const approved = await createApprovalHandler(ui)({ kind: "fs.write", title: "write b.txt" });
    const out = strip(chunks.join(""));

    expect(approved).toBe(true);
    expect(out).toContain("Approve write b.txt?");
    expect(out).not.toContain("---");
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
  test.skip("chat bar: /plan and /changes are reachable and never crash (needs util-linux `script`)", () => {});
} else {
  test(
    "chat bar: /plan and /changes are reachable and never crash",
    async () => {
      const ws = pool.make();
      const proc = startChat(ws);

      proc.write("/help\n");
      expect(await waitFor(proc, "toggle plan mode")).toBe(true);

      proc.write("/plan\n");
      // With the hooks wired this turns the mode on; without them the command
      // says so. Both are a pass: the requirement is that it never crashes and
      // never looks like an unknown command.
      expect(await waitFor(proc, /plan mode on|not supported by this runtime: setPlanMode/)).toBe(true);

      proc.write("/changes\n");
      expect(
        await waitFor(proc, /no staged changes|staged changes \(|not supported by this runtime: stagedChanges/),
      ).toBe(true);

      proc.write("/exit\n");
      const run = await proc.done;
      const out = flatten(run.stdout);

      expect(run.timedOut).toBe(false);
      expect(run.signal).toBeNull();
      expect(run.code).toBe(0);
      expect(out).not.toContain("unknown command /plan");
      expect(out).not.toContain("unknown command /changes");
    },
    PTY_TIMEOUT_MS + 5_000,
  );
}
