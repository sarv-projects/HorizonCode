import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { assertPublishedNumber, parsePublishedNumber } from "../../src/core/metrics";
import { admitTuiHandoffWrite, consumeTuiHandoff, tuiRelaunchPublication, writeTuiHandoff } from "../../src/tui/handoff";

describe("tui handoff", () => {
  test("tuiRelaunchPublication contracts draft bytes (ruling 615)", () => {
    const blocks = tuiRelaunchPublication({ draftBytes: 14 });
    expect(blocks).toHaveLength(1);
    assertPublishedNumber(blocks[0]!);
    expect(parsePublishedNumber(blocks[0]!).metric).toBe("tui relaunch draft bytes");
    expect(parsePublishedNumber(blocks[0]!).value).toBe("14");
  });

  test("write then consume is one-shot", async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "hz-handoff-"));
    try {
      await writeTuiHandoff(workspace, {
        sessionId: "sess_1",
        workspace,
        draft: "partial prompt",
        mode: "scrollback",
      });
      const a = consumeTuiHandoff(workspace);
      expect(a?.draft).toBe("partial prompt");
      expect(consumeTuiHandoff(workspace)).toBeUndefined();
    } finally {
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  }, 20_000);

  test("admitTuiHandoffWrite refuses deny before persist (ruling 588)", async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "hz-handoff-deny-"));
    const prevBin = process.env.HZ_KERNEL_BIN;
    process.env.HZ_KERNEL_BIN = path.join(workspace, "no-such-hz-kernel");
    try {
      const kernelState = path.join(workspace, ".hzcode", "kernel");
      fs.mkdirSync(kernelState, { recursive: true });
      fs.writeFileSync(
        path.join(kernelState, "policy.json"),
        JSON.stringify([{ kind: "fs.write", scope: "workspace", decision: "deny", reason: "test-deny-handoff" }]),
        "utf8",
      );
      const refused = await admitTuiHandoffWrite(workspace);
      expect(refused).toMatch(/denied|test-deny-handoff|tui-handoff/i);
      const writeRefused = await writeTuiHandoff(workspace, {
        sessionId: "sess_deny",
        workspace,
        draft: "nope",
        mode: "scrollback",
      });
      expect(writeRefused).toMatch(/denied|test-deny-handoff|tui-handoff/i);
      expect(consumeTuiHandoff(workspace)).toBeUndefined();
    } finally {
      if (prevBin === undefined) delete process.env.HZ_KERNEL_BIN;
      else process.env.HZ_KERNEL_BIN = prevBin;
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  }, 20_000);
});
