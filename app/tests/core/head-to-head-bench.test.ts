import { describe, expect, test } from "bun:test";
import {
  defaultH2HTasks,
  discoverH2HCompetitors,
  runHeadToHeadBench,
  writeH2HReport,
} from "../../src/core/head-to-head-bench";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";

describe("head-to-head-bench (ruling 644)", () => {
  test("default matrix is 25 tasks with SWE + engineering mix", () => {
    const tasks = defaultH2HTasks(25);
    expect(tasks).toHaveLength(25);
    expect(tasks.filter((t) => t.kind === "swebench-verified").length).toBe(20);
    expect(tasks.filter((t) => t.kind === "multi-file-engineering").length).toBe(5);
  });

  test("dry-run plans all competitor×task arms without inventing pass rates", () => {
    const competitors = discoverH2HCompetitors().map((c) => ({
      ...c,
      available: c.id === "horizoncode",
      detail: c.id === "horizoncode" ? "forced" : c.detail,
    }));
    const report = runHeadToHeadBench({
      tasks: defaultH2HTasks(3),
      competitors,
      live: false,
    });
    expect(report.live).toBe(false);
    expect(report.results).toHaveLength(3 * competitors.length);
    expect(report.results.every((r) => r.status === "dry_run")).toBe(true);
    expect(report.results.every((r) => r.pass === undefined)).toBe(true);
  });

  test("live mode skips missing binaries honestly", () => {
    const report = runHeadToHeadBench({
      tasks: defaultH2HTasks(2),
      competitors: [
        { id: "claude-code", available: false, detail: "missing" },
        { id: "codex", available: false, detail: "missing" },
      ],
      live: true,
    });
    expect(report.results.every((r) => r.status === "skipped_missing_binary")).toBe(true);
  });

  test("writeH2HReport persists JSON", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "hz-h2h-"));
    try {
      const report = runHeadToHeadBench({ tasks: defaultH2HTasks(2), live: false });
      const out = await writeH2HReport(dir, report);
      const loaded = JSON.parse(readFileSync(out, "utf8"));
      expect(loaded.schema).toBe("hz.h2h.bench.v1");
      expect(loaded.taskCount).toBe(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
