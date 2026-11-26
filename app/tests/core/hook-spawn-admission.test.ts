/**
 * hook-spawn-admission.test.ts — P0-1 (ruling 909): a hook process is admitted.
 *
 * The deciding hook used to spawn with no admission at all. The loop now passes
 * a guard-backed `admit` handler: a policy deny stops the spawn before any child
 * exists, and the refusal is a normal hook failure (deny at the deciding point).
 */

import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { loadHooks, runPreToolHooks } from "../../src/core/hooks";

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length > 0) {
    try {
      rmSync(dirs.pop() as string, { recursive: true, force: true });
    } catch {
      /* windows handles */
    }
  }
});

function world(marker: string): { ws: string; home: string } {
  const ws = mkdtempSync(path.join(tmpdir(), "hz-hook-admit-ws-"));
  const home = mkdtempSync(path.join(tmpdir(), "hz-hook-admit-home-"));
  dirs.push(ws, home);
  mkdirSync(path.join(ws, ".hz"), { recursive: true });
  writeFileSync(
    path.join(ws, ".hz", "hooks.json"),
    JSON.stringify({
      hooks: {
        preTool: [
          {
            command: process.execPath,
            args: [
              "-e",
              "require('fs').writeFileSync(" + JSON.stringify(marker) + ", 'ran');",
            ],
          },
        ],
      },
    }),
    "utf8",
  );
  return { ws, home };
}

const ctxFor = (ws: string, home: string) => ({
  sessionId: "s1",
  workspace: ws,
  callId: "c1",
  tool: "read",
  args: { path: "a.txt" },
});

describe("hook spawn admission", () => {
  test("a denying admission stops the hook before it starts", async () => {
    const marker = path.join(tmpdir(), "hz-hook-admit-marker-" + process.pid + ".txt");
    try {
      rmSync(marker, { force: true });
    } catch {
      /* absent */
    }
    const { ws, home } = world(marker);
    const hooks = loadHooks(ws, { home, trustWorkspaceHooks: true });
    const decision = await runPreToolHooks(hooks, {
      ...ctxFor(ws, home),
      admit: async () => ({ allow: false, reason: "denied by policy: test" }),
    });
    expect(decision.decision).toBe("deny");
    expect(decision.reason ?? "").toContain("not admitted");
    expect(existsSync(marker)).toBe(false);
    rmSync(marker, { force: true });
  });

  test("an allowing admission lets the hook run", async () => {
    const marker = path.join(tmpdir(), "hz-hook-admit-ok-" + process.pid + ".txt");
    try {
      rmSync(marker, { force: true });
    } catch {
      /* absent */
    }
    const { ws, home } = world(marker);
    const hooks = loadHooks(ws, { home, trustWorkspaceHooks: true });
    await runPreToolHooks(hooks, {
      ...ctxFor(ws, home),
      admit: async () => ({ allow: true }),
    });
    expect(existsSync(marker)).toBe(true);
    rmSync(marker, { force: true });
  });
});
