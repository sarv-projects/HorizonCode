import { describe, expect, test } from "bun:test";
import { defaultConfigPath, persistNotifyConfig } from "../../src/core/config";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { bellOnTurnEnd, notifyPrefsMerged, runNotifyCommand } from "../../src/tui/notify";
import { createRenderer } from "../../src/tui/render";

describe("notify", () => {
  test("bell only after threshold", () => {
    let out = "";
    expect(bellOnTurnEnd(1000, {}, (c) => {
      out += c;
    })).toBe(false);
    expect(bellOnTurnEnd(60_000, {}, (c) => {
      out += c;
    })).toBe(true);
    expect(out).toContain("\u0007");
  });

  test("config merge and persist", () => {
    const home = mkdtempSync(path.join(tmpdir(), "hz-notify-"));
    try {
      persistNotifyConfig({ bell: false, minMs: 5000 }, home);
      const file = JSON.parse(readFileSync(defaultConfigPath(home), "utf8")) as {
        notify?: { bell?: boolean; minMs?: number };
      };
      expect(file.notify?.bell).toBe(false);
      expect(notifyPrefsMerged(file.notify, { HZ_NOTIFY_BELL: "1" }).bell).toBe(true);
      const lines: string[] = [];
      const r = createRenderer({ out: (c) => lines.push(c) });
      runNotifyCommand("min 12000", r, file.notify, (p) => persistNotifyConfig(p, home));
      expect(lines.join("")).toContain("notify saved");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
