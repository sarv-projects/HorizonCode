/**
 * permission-mode.test.ts (tui): --permission-mode on the real entry point and
 * the /mode command with its prompt badge.
 */

import { afterAll, describe, expect, test } from "bun:test";
import type { Runtime } from "../../src/contracts";
import { planPrompt, runModeCommand } from "../../src/tui/interactive";
import { createRenderer } from "../../src/tui/render";
import { strip } from "../../src/tui/style";
import { appSpec, createWorkspacePool, killAllProcesses, runApp } from "./harness";

const pool = createWorkspacePool();
afterAll(() => {
  pool.cleanup();
  killAllProcesses();
});

const run = (args: string[], input = "") => runApp(appSpec(["--workspace", pool.make(), "--mock", ...args]), input);

describe("--permission-mode", () => {
  test("a bypass name is refused with the reason, exit 2", async () => {
    for (const name of ["yolo", "bypass", "bypassPermissions"]) {
      const r = await run(["--permission-mode", name, "-p", "hi"]);
      expect(r.code).toBe(2);
      expect(r.stderr).toContain("no bypass/yolo permission mode");
      expect(r.stdout).toBe("");
    }
  });

  test("an unknown name exits 2 and lists the valid ones", async () => {
    const r = await run(["--permission-mode", "nope", "-p", "hi"]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("default, plan, accept-edits, read-only");
  });

  test("-p with accept-edits runs, keeps stdout clean, and says the mode on stderr", async () => {
    const r = await run(["--permission-mode", "accept-edits", "-p", "hello"]);
    expect(r.code).toBe(0);
    expect(r.stdout.trim().length).toBeGreaterThan(0);
    expect(r.stdout).not.toContain("permission mode");
    expect(r.stderr).toContain("permission mode accept-edits");
  });

  test("default mode prints no mode line", async () => {
    const r = await run(["-p", "hello"]);
    expect(r.code).toBe(0);
    expect(r.stderr).not.toContain("permission mode");
  });
});

describe("/mode and the badge", () => {
  function setup(initial: string) {
    const chunks: string[] = [];
    const renderer = createRenderer({ wrap: false, out: (c: string) => void chunks.push(c) });
    let mode = initial;
    const runtime = {
      sessionId: "pm",
      permissionMode: () => mode,
      setPermissionMode: (m: string) => {
        mode = m;
      },
    } as unknown as Runtime;
    return { renderer, runtime, text: () => strip(chunks.join("")), mode: () => mode };
  }

  test("bare /mode shows the current mode", () => {
    const h = setup("read-only");
    runModeCommand("", h.runtime, h.renderer);
    expect(h.text()).toContain("read-only");
  });

  test("/mode accept-edits sets it", () => {
    const h = setup("default");
    expect(runModeCommand("accept-edits", h.runtime, h.renderer)).toBe("accept-edits");
    expect(h.mode()).toBe("accept-edits");
  });

  test("/mode yolo is refused and the mode is unchanged", () => {
    const h = setup("default");
    expect(runModeCommand("yolo", h.runtime, h.renderer)).toBe("default");
    expect(h.mode()).toBe("default");
    expect(h.text()).toContain("no bypass/yolo");
  });

  test("a runtime without the hook gets a typed not-supported line", () => {
    const chunks: string[] = [];
    const renderer = createRenderer({ wrap: false, out: (c: string) => void chunks.push(c) });
    runModeCommand("read-only", { sessionId: "x" } as unknown as Runtime, renderer);
    expect(strip(chunks.join(""))).toContain("not supported");
  });

  test("the prompt carries a loud badge for every non-default mode", () => {
    expect(strip(planPrompt(false, "accept-edits"))).toBe("ACCEPT-EDITS \u276f ");
    expect(strip(planPrompt(false, "read-only"))).toBe("READ-ONLY \u276f ");
    expect(strip(planPrompt(true, "accept-edits"))).toBe("PLAN \u276f ");
    expect(strip(planPrompt(false, "default"))).toBe("\u276f ");
  });
});
