import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { consumeTuiHandoff, writeTuiHandoff } from "../../src/tui/handoff";

describe("tui handoff", () => {
  test("write then consume is one-shot", () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "hz-handoff-"));
    writeTuiHandoff(workspace, {
      sessionId: "sess_1",
      workspace,
      draft: "partial prompt",
      mode: "scrollback",
    });
    const a = consumeTuiHandoff(workspace);
    expect(a?.draft).toBe("partial prompt");
    expect(consumeTuiHandoff(workspace)).toBeUndefined();
  });
});
