import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { disposeAllLiveDapSessions } from "../../src/core/dap/registry";
import { debugLaunchActions } from "../../src/core/dap/client";
import { admissionFor, guardActionFor } from "../../src/core/loop";
import { modeRefusal } from "../../src/core/permission-mode";
import { debugTool } from "../../src/tools/debug";
import { mockToolContext } from "./helpers";

const fixture = path.join(path.dirname(fileURLToPath(import.meta.url)), "../fixtures/fake-dap-server.ts");

describe("debug tool", () => {
  afterEach(async () => {
    await disposeAllLiveDapSessions();
  });

  test("guardActionFor admits spawn from command digest", () => {
    const action = guardActionFor("debug", { op: "stack", command: "bun", args: ["x.ts"] }, "/ws");
    expect(action?.kind).toBe("spawn");
    expect(action?.target).toMatch(/^debug /);
  });

  test("future launch op admits shell.exec on program", () => {
    const action = guardActionFor("debug", { op: "launch", program: "node app.js", command: "dap" }, "/ws");
    expect(action?.kind).toBe("shell.exec");
    expect(action?.target).toBe("node app.js");
  });

  test("debug.launch dual admission: shell.exec + spawn", () => {
    const dual = debugLaunchActions("node app.js", "dap", []);
    expect(dual.map((a) => a.kind)).toEqual(["shell.exec", "spawn"]);
    const admission = admissionFor(
      "debug",
      { op: "launch", program: "node app.js", command: "bun", args: ["x.ts"] },
      "/ws",
    );
    expect(admission?.kind).toBe("guard");
    if (admission?.kind !== "guard") return;
    expect(admission.action.kind).toBe("shell.exec");
    expect(admission.also?.length).toBe(1);
    expect(admission.also?.[0]?.kind).toBe("spawn");
  });

  test("step ops admit shell.exec on program", () => {
    for (const op of ["continue", "next", "stepIn", "stepOut"] as const) {
      const action = guardActionFor("debug", { op, program: "node app.js", command: "dap" }, "/ws");
      expect(action?.kind).toBe("shell.exec");
      expect(modeRefusal("read-only", action!)).toContain("read-only");
    }
  });

  test("read-only mode refuses launch program (shell.exec)", () => {
    const action = guardActionFor("debug", { op: "launch", program: "node app.js", command: "dap" }, "/ws");
    expect(action).toBeDefined();
    expect(modeRefusal("read-only", action!)).toContain("read-only");
  });

  test("read-only mode refuses stack adapter spawn", () => {
    const action = guardActionFor("debug", { op: "stack", command: "bun", args: ["x.ts"] }, "/ws");
    expect(action?.kind).toBe("spawn");
    expect(modeRefusal("read-only", action!)).toContain("read-only");
  });

  test("stack op against fake adapter", async () => {
    const ctx = mockToolContext({ decision: "allow" });
    const result = await debugTool.execute({ op: "stack", command: "bun", args: [fixture] }, ctx);
    expect(result.ok).toBe(true);
    expect(result.output).toContain("main");
  });

  test("launch connects adapter after in-tool spawn admit", async () => {
    const ctx = mockToolContext({ decision: "allow" });
    const result = await debugTool.execute(
      { op: "launch", program: "node app.js", command: "bun", args: [fixture] },
      ctx,
    );
    expect(result.ok).toBe(true);
    expect(result.output).toContain("DAP launch ok");
    expect(result.output).toContain("status=stopped");
    expect(result.output).toContain("main");
    expect(result.output).toContain("node app.js");
    expect(ctx.guardCalls.some((a) => a.kind === "spawn")).toBe(true);
  });

  test("variables op returns locals", async () => {
    const ctx = mockToolContext({ decision: "allow" });
    const result = await debugTool.execute({ op: "variables", command: "bun", args: [fixture] }, ctx);
    expect(result.ok).toBe(true);
    expect(result.output).toContain("x = 42");
  });

  test("next op launches then steps over", async () => {
    const ctx = mockToolContext({ decision: "allow" });
    const result = await debugTool.execute(
      { op: "next", program: "node app.js", command: "bun", args: [fixture] },
      ctx,
    );
    expect(result.ok).toBe(true);
    expect(result.output).toContain("DAP next ok");
    expect(result.output).toContain("stopReason=step");
  });

  test("attach op admits shell.exec on attach target", () => {
    const action = guardActionFor("debug", { op: "attach", pid: 99, command: "dap" }, "/ws");
    expect(action?.kind).toBe("shell.exec");
    expect(action?.target).toBe("attach:pid=99");
    expect(modeRefusal("read-only", action!)).toContain("read-only");
  });

  test("attach connects adapter with pid", async () => {
    const ctx = mockToolContext({ decision: "allow" });
    const result = await debugTool.execute(
      { op: "attach", pid: 4242, command: "bun", args: [fixture] },
      ctx,
    );
    expect(result.ok).toBe(true);
    expect(result.output).toContain("DAP attach ok");
    expect(result.output).toContain("attach:pid=4242");
    expect(result.output).toContain("status=stopped");
    expect(result.output).toContain("session kept live");
  });

  test("launch then next reuses the live adapter session", async () => {
    const ctx = mockToolContext({ decision: "allow" });
    const launched = await debugTool.execute(
      { op: "launch", program: "node app.js", command: "bun", args: [fixture] },
      ctx,
    );
    expect(launched.ok).toBe(true);
    expect(launched.output).toContain("session kept live");
    const stepped = await debugTool.execute(
      { op: "next", program: "node app.js", command: "bun", args: [fixture] },
      ctx,
    );
    expect(stepped.ok).toBe(true);
    expect(stepped.output).toContain("live session reused");
    expect(stepped.output).toContain("stopReason=step");
    const closed = await debugTool.execute({ op: "close", command: "bun" }, ctx);
    expect(closed.ok).toBe(true);
    expect(closed.output).toContain("DAP session closed");
  });

  test("close with no session is ok", async () => {
    const ctx = mockToolContext({ decision: "allow" });
    const result = await debugTool.execute({ op: "close" }, ctx);
    expect(result.ok).toBe(true);
    expect(result.output).toContain("no live DAP session");
  });

  test("adapter name resolves to PATH binary for launch", async () => {
    const ctx = mockToolContext({ decision: "allow" });
    const dir = mkdtempSync(path.join(tmpdir(), "hz-debug-adapter-"));
    mkdirSync(path.join(dir, ".hz"), { recursive: true });
    writeFileSync(
      path.join(dir, ".hz", "dap.json"),
      JSON.stringify({
        adapters: {
          fake: { command: "bun", args: [fixture], languages: ["javascript"], fileTypes: [".js"] },
        },
      }),
    );
    const localCtx = { ...ctx, cwd: dir, workspace: dir };
    const result = await debugTool.execute(
      { op: "launch", program: "node app.js", adapter: "fake" },
      localCtx,
    );
    expect(result.ok).toBe(true);
    expect(result.output).toContain("DAP launch ok");
    await disposeAllLiveDapSessions();
  });
});
