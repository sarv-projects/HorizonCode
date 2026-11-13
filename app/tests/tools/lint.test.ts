import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { lintTool } from "../../src/tools/lint";
import { getTool } from "../../src/tools/index";
import type { ToolContext, GuardDecision, GuardAction } from "../../src/contracts";
import { admitUserLintCommand } from "../../src/tools/lint";

describe("lint tool", () => {
  test("registered with path-only schema", () => {
    const tool = getTool("lint");
    expect(tool?.name).toBe("lint");
    expect(tool?.parameters.required).toEqual(["path"]);
  });

  test("lint.execute refuses a configured shell without spawning it", async () => {
    const home = mkdtempSync(path.join(tmpdir(), "hz-lint-auth-"));
    const priorHome = process.env.HOME;
    const conf = path.join(home, ".config", "horizon");
    const source = path.join(home, "source.ts");
    const spawned = path.join(home, "unexpected-side-effect.txt");
    mkdirSync(conf, { recursive: true });
    writeFileSync(source, "const a = 1;\n");
    writeFileSync(path.join(conf, "config.json"), JSON.stringify({
      lint: { commands: [{ extensions: ["ts"], command: `printf EXECUTED > "${spawned}"; cat {file}` }] },
    }));
    const seen: GuardAction[] = [];
    try {
      process.env.HOME = home;
      const ctx = {
        cwd: home, workspace: home, sessionId: "lint-auth", signal: new AbortController().signal,
        guard: async (action: GuardAction): Promise<GuardDecision> => {
          seen.push(action);
          return { decision: action.kind === "shell.exec" ? "deny" : "allow" };
        },
        approve: async () => false,
        receipt: async () => { throw new Error("no receipt expected"); },
      } as unknown as ToolContext;
      const result = await lintTool.execute({ path: "source.ts" }, ctx);
      expect(result.ok).toBe(false);
      expect(result.error).toContain("denied or declined");
      expect(seen.some((action) => action.kind === "shell.exec")).toBe(true);
      expect(existsSync(spawned)).toBe(false);
    } finally {
      if (priorHome === undefined) delete process.env.HOME;
      else process.env.HOME = priorHome;
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("user-supplied lint shell checks actual command before spawning and refuses denial", async () => {
    const seen: GuardAction[] = [];
    let approved = 0;
    const ctx = {
      guard: async (action: GuardAction): Promise<GuardDecision> => {
        seen.push(action);
        return { decision: "deny", reason: "no shell" };
      },
      approve: async () => { approved++; return true; },
    } as unknown as ToolContext;
    const admitted = await admitUserLintCommand("rm -rf /tmp/anything", ctx);
    expect(admitted).toBe(false);
    expect(seen).toEqual([{ kind: "shell.exec", target: "rm -rf /tmp/anything" }]);
    expect(approved).toBe(0);
  });

  test("user-supplied lint shell requires approval when guard asks", async () => {
    const seen: GuardAction[] = [];
    const approvals: string[] = [];
    const ctx = {
      guard: async (action: GuardAction): Promise<GuardDecision> => {
        seen.push(action);
        return { decision: "ask" };
      },
      approve: async (req: { title: string }) => {
        approvals.push(req.title);
        return false;
      },
    } as unknown as ToolContext;
    expect(await admitUserLintCommand("eslint source.ts", ctx)).toBe(false);
    expect(seen).toEqual([{ kind: "shell.exec", target: "eslint source.ts" }]);
    expect(approvals).toEqual(["Run lint command"]);
  });
});
