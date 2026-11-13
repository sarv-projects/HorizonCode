import { describe, expect, test } from "bun:test";
import { runBatchCli } from "../../src/batch-run";
import { mkdtempSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

describe("batch-run cli", () => {
  test("J-2 CLI filters and slices the stable job population before skipping completed rows", async () => {
    const file = path.join(mkdtempSync(path.join(os.tmpdir(), "batch-filter-")), "job.jsonl");
    writeFileSync(file, [
      { id: "a", task: "Build API", status: "done" },
      { id: "b", task: "Fix tests", status: "pending" },
      { id: "c", task: "Build UI", status: "pending" },
      { id: "d", task: "Build docs", status: "failed" },
    ].map((row) => JSON.stringify(row)).join("\n") + "\n");
    const out: string[] = [];
    const err: string[] = [];
    const exit = await runBatchCli(
      ["--job", file, "--filter", "BUILD", "--slice", "1:3", "--dry-run"],
      { out: (line) => out.push(line), err: (line) => err.push(line) },
    );
    expect(exit).toBe(0);
    expect(err).toEqual([]);
    expect(out.filter((line) => line.startsWith("would run:"))).toEqual(["would run: c · Build UI"]);
    expect(out.some((line) => line.includes("selected 2 of 4"))).toBe(true);
  });

  test("J-2 CLI rejects malformed slice and missing filter instead of silently ignoring them", async () => {
    const file = path.join(mkdtempSync(path.join(os.tmpdir(), "batch-args-")), "job.jsonl");
    writeFileSync(file, JSON.stringify({ id: "a", task: "a", status: "pending" }) + "\n");
    for (const args of [["--slice", "3:2"], ["--filter"], ["--slice", "oops"]]) {
      const errors: string[] = [];
      const exit = await runBatchCli(["--job", file, ...args, "--dry-run"], {
        out: () => undefined, err: (line) => errors.push(line),
      });
      expect(exit).toBe(2);
      expect(errors.some((line) => /slice|filter/i.test(line))).toBe(true);
    }
  });

  test("J-2 distinguishes an empty filter selection from a completed batch", async () => {
    const file = path.join(mkdtempSync(path.join(os.tmpdir(), "batch-none-")), "job.jsonl");
    writeFileSync(file, JSON.stringify({ id: "x", task: "real task", status: "pending" }) + "\n");
    const out: string[] = [];
    const code = await runBatchCli(["--job", file, "--filter", "unmatched", "--dry-run"], {
      out: (line) => out.push(line), err: () => undefined,
    });
    expect(code).toBe(0);
    expect(out.some((line) => line.includes("selection matches no rows"))).toBe(true);
    expect(out.some((line) => line.includes("all rows done or failed"))).toBe(false);
  });

  test("dry-run lists pending rows", async () => {
    const file = path.join(mkdtempSync(path.join(os.tmpdir(), "batch-cli-")), "job.jsonl");
    writeFileSync(
      file,
      [JSON.stringify({ id: "1", task: "one", status: "done" }), JSON.stringify({ id: "2", task: "two", status: "pending" })].join(
        "\n",
      ) + "\n",
    );
    const lines: string[] = [];
    const code = await runBatchCli(["--job", file, "--dry-run"], {
      out: (l) => lines.push(l),
      err: () => {},
    });
    expect(code).toBe(0);
    expect(lines.some((l) => l.includes("would run: 2"))).toBe(true);
  });
});
