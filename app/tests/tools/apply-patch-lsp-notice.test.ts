/**
 * apply-patch-lsp-notice.test.ts — POST-EDIT-ONLY LSP notice for apply_patch.
 *
 * The notice is opt-in, appended after a successful patch, and can never reject
 * or block the edit. These tests cover: default byte-identical output, no-config
 * no-notice, a fake diagnostic block appearing, and a failed query still
 * leaving the edit ok.
 */

import { describe, expect, test } from "bun:test";
import * as path from "node:path";
import {
  applyPatchTool,
} from "../../src/tools/apply-patch";
import {
  clearPostEditLedgers,
  createPostEditDiagnosticsNotice,
  formatPostEditDiagnosticsNotice,
} from "../../src/core/post-edit-diagnostics";
import { makeWorkspace, mockToolContext, writeFixture } from "./helpers";

const FLAG = "HZ_APPLY_PATCH_LSP_NOTICE";

function wrap(body: string): string {
  return `*** Begin Patch\n${body}\n*** End Patch\n`;
}

async function withFlagOn(fn: () => Promise<void>): Promise<void> {
  const prior = process.env[FLAG];
  process.env[FLAG] = "1";
  try {
    await fn();
  } finally {
    if (prior === undefined) delete process.env[FLAG];
    else process.env[FLAG] = prior;
  }
}

describe("apply_patch post-edit LSP notice", () => {
  test("default (flag off) keeps output byte-identical and never calls the hook", async () => {
    const prior = process.env[FLAG];
    delete process.env[FLAG];
    let called = false;
    try {
      const ctx = mockToolContext({ cwd: makeWorkspace() });
      ctx.postEditDiagnosticsNotice = async () => {
        called = true;
        return "<lsp-diagnostics>fake</lsp-diagnostics>";
      };
      const result = await applyPatchTool.execute({ input: wrap("*** Add File: a.txt\n+hello") }, ctx);
      expect(result.ok).toBe(true);
      expect(result.output).not.toContain("lsp-diagnostics");
      expect(called).toBe(false);
    } finally {
      if (prior !== undefined) process.env[FLAG] = prior;
    }
  });

  test("no config -> no notice, edit still ok", async () => {
    await withFlagOn(async () => {
      // The runtime only installs the hook when LSP config is present; no hook
      // means no notice. The core helper also no-ops on an absent config.
      const ctx = mockToolContext({ cwd: makeWorkspace() });
      const result = await applyPatchTool.execute({ input: wrap("*** Add File: a.txt\n+hello") }, ctx);
      expect(result.ok).toBe(true);
      expect(result.output).not.toContain("lsp-diagnostics");

      const notice = createPostEditDiagnosticsNotice({
        sessionId: "no-config",
        workspace: ctx.cwd,
        cwd: ctx.cwd,
        hooks: { guard: async () => ({ decision: "allow" }), approve: async () => true },
        configLoader: () => undefined,
      });
      expect(await notice([path.join(ctx.cwd, "a.txt")])).toBe("");
    });
  });

  test("with config + fake diagnostics -> compact notice appended, mutated abs paths passed", async () => {
    await withFlagOn(async () => {
      const ws = makeWorkspace({ "src/a.ts": "const a = 1;\n" });
      const ctx = mockToolContext({ cwd: ws });
      let seenPaths: readonly string[] = [];
      ctx.postEditDiagnosticsNotice = async (absPaths) => {
        seenPaths = absPaths;
        return formatPostEditDiagnosticsNotice([
          { rel: "src/a.ts", server: "fake", summary: "1 error(s)", messages: ["src/a.ts:1:1 error boom"] },
        ]);
      };
      const result = await applyPatchTool.execute(
        { input: wrap("*** Update File: src/a.ts\n@@\n-const a = 1;\n+const a = 2;") },
        ctx,
      );
      expect(result.ok).toBe(true);
      expect(result.output).toContain("<lsp-diagnostics>");
      expect(result.output).toContain("src/a.ts:1:1 error boom");
      expect(seenPaths).toEqual([path.resolve(ws, "src/a.ts")]);
    });
  });

  test("query failure -> no notice, edit still ok", async () => {
    await withFlagOn(async () => {
      const ctx = mockToolContext({ cwd: makeWorkspace() });
      ctx.postEditDiagnosticsNotice = async () => {
        throw new Error("query exploded");
      };
      const result = await applyPatchTool.execute({ input: wrap("*** Add File: a.txt\n+hello") }, ctx);
      expect(result.ok).toBe(true);
      expect(result.output).not.toContain("lsp-diagnostics");
      expect(result.output).toContain("Patch applied");
    });
  });

  test("deleted paths are excluded from the notice query", async () => {
    await withFlagOn(async () => {
      const ws = makeWorkspace();
      writeFixture(ws, "gone.txt", "bye\n");
      const ctx = mockToolContext({ cwd: ws });
      let seenPaths: readonly string[] = ["unset"];
      ctx.postEditDiagnosticsNotice = async (absPaths) => {
        seenPaths = absPaths;
        return "";
      };
      const result = await applyPatchTool.execute({ input: wrap("*** Delete File: gone.txt") }, ctx);
      expect(result.ok).toBe(true);
      expect(seenPaths).toEqual([]);
    });
  });
});

describe("post-edit diagnostics formatting", () => {
  test("empty entries produce no block; filled entries are compact and wrapped", () => {
    clearPostEditLedgers();
    expect(formatPostEditDiagnosticsNotice([])).toBe("");
    expect(formatPostEditDiagnosticsNotice([{ rel: "a.ts", server: "s", summary: "no issues", messages: [] }])).toBe("");
    const block = formatPostEditDiagnosticsNotice([
      { rel: "a.ts", server: "s", summary: "1 error(s)", messages: ["a.ts:1:1 error x"] },
    ]);
    expect(block).toBe("<lsp-diagnostics>\na.ts (s): 1 error(s)\na.ts:1:1 error x\n</lsp-diagnostics>");
  });
});
