import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { createRuntime } from "../../src/core";
import { clearMarkdownTranscriptCursors, markdownTranscriptPath } from "../../src/core/markdown-transcript";

const roots: string[] = [];
afterEach(() => {
  clearMarkdownTranscriptCursors();
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

describe("markdown transcript under-admission (ruling 575)", () => {
  test("send refuses transcript write when policy denies fs.write", async () => {
    const workspace = mkdtempSync(path.join(tmpdir(), "hz-md-tx-deny-"));
    roots.push(workspace);
    const prevBin = process.env.HZ_KERNEL_BIN;
    const prevMd = process.env.HZ_MARKDOWN_TRANSCRIPT;
    process.env.HZ_KERNEL_BIN = path.join(workspace, "no-such-hz-kernel");
    delete process.env.HZ_MARKDOWN_TRANSCRIPT;
    try {
      const kernelState = path.join(workspace, ".hzcode", "kernel");
      mkdirSync(kernelState, { recursive: true });
      writeFileSync(
        path.join(kernelState, "policy.json"),
        JSON.stringify([{ kind: "fs.write", scope: "workspace", decision: "deny", reason: "test-deny-transcript" }]),
        "utf8",
      );
      const notices: string[] = [];
      const runtime = await createRuntime({ workspace, mock: true });
      try {
        await runtime.send("hello transcript", {
          onEvent(ev) {
            if (ev.type === "notice") notices.push(ev.message);
          },
        });
        expect(notices.join("\n")).toMatch(/markdown transcript refused|denied|test-deny-transcript/i);
        expect(existsSync(markdownTranscriptPath(workspace, runtime.sessionId))).toBe(false);
      } finally {
        await runtime.close();
      }
    } finally {
      if (prevBin === undefined) delete process.env.HZ_KERNEL_BIN;
      else process.env.HZ_KERNEL_BIN = prevBin;
      if (prevMd === undefined) delete process.env.HZ_MARKDOWN_TRANSCRIPT;
      else process.env.HZ_MARKDOWN_TRANSCRIPT = prevMd;
    }
  });
});
