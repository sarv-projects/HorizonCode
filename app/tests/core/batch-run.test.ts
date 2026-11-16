import { describe, expect, test } from "bun:test";
import { runBatchCli } from "../../src/batch-run";
import { assertPublishedNumber } from "../../src/core/metrics";
import { defaultBatchRunnerConfigPath, loadBatchRunnerConfig } from "../../src/core/batch-runner";
import { existsSync, mkdtempSync, writeFileSync, readFileSync } from "node:fs";
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

  test("J-2 CLI writes runner-config and --resume restores filter/slice without re-specifying", async () => {
    const file = path.join(mkdtempSync(path.join(os.tmpdir(), "batch-resume-")), "job.jsonl");
    writeFileSync(file, [
      { id: "a", task: "Build API", status: "done" },
      { id: "b", task: "Fix tests", status: "pending" },
      { id: "c", task: "Build UI", status: "pending" },
      { id: "d", task: "Build docs", status: "failed" },
    ].map((row) => JSON.stringify(row)).join("\n") + "\n");
    const cfg = defaultBatchRunnerConfigPath(file);
    const writeOut: string[] = [];
    const writeExit = await runBatchCli(
      ["--job", file, "--filter", "BUILD", "--slice", "1:3", "--write-config"],
      { out: (line) => writeOut.push(line), err: () => undefined },
    );
    expect(writeExit).toBe(0);
    expect(existsSync(cfg)).toBe(true);
    expect(writeOut.some((line) => line.includes("wrote") && line.includes("runner-config"))).toBe(true);
    const snap = loadBatchRunnerConfig(cfg);
    expect(snap.filter).toBe("BUILD");
    expect(snap.slice).toEqual({ start: 1, end: 3 });

    const resumeOut: string[] = [];
    const resumeExit = await runBatchCli(["--job", file, "--resume", "--dry-run"], {
      out: (line) => resumeOut.push(line),
      err: () => undefined,
    });
    expect(resumeExit).toBe(0);
    expect(resumeOut.some((line) => line.includes("loaded runner-config"))).toBe(true);
    expect(resumeOut.filter((line) => line.startsWith("would run:"))).toEqual(["would run: c · Build UI"]);
  });

  test("J-2 CLI --resume refuses a conflicting restated filter", async () => {
    const file = path.join(mkdtempSync(path.join(os.tmpdir(), "batch-conflict-")), "job.jsonl");
    writeFileSync(file, JSON.stringify({ id: "a", task: "Build", status: "pending" }) + "\n");
    await runBatchCli(["--job", file, "--filter", "Build", "--write-config"], {
      out: () => undefined, err: () => undefined,
    });
    const errors: string[] = [];
    const exit = await runBatchCli(["--job", file, "--resume", "--filter", "other", "--dry-run"], {
      out: () => undefined, err: (line) => errors.push(line),
    });
    expect(exit).toBe(2);
    expect(errors.some((line) => /disagrees/i.test(line))).toBe(true);
  });

  test("J-4 CLI --arm write-config + --resume --status without re-spec", async () => {
    const file = path.join(mkdtempSync(path.join(os.tmpdir(), "batch-arm-")), "job.jsonl");
    writeFileSync(
      file,
      [
        { id: "eval-1", task: "case a", status: "done" },
        { id: "eval-2", task: "case b", status: "pending" },
        { id: "lint-1", task: "case c", status: "pending" },
      ]
        .map((row) => JSON.stringify(row))
        .join("\n") + "\n",
    );
    const writeExit = await runBatchCli(
      ["--job", file, "--arm", "eval", "--write-config"],
      { out: () => undefined, err: () => undefined },
    );
    expect(writeExit).toBe(0);
    const snap = loadBatchRunnerConfig(defaultBatchRunnerConfigPath(file));
    expect(snap.arm).toBe("eval");

    const out: string[] = [];
    const exit = await runBatchCli(["--job", file, "--resume", "--status"], {
      out: (line) => out.push(line),
      err: () => undefined,
    });
    expect(exit).toBe(0);
    expect(out.some((line) => line.includes("loaded runner-config"))).toBe(true);
    expect(out.some((line) => /eval:.*1\/2 done/.test(line))).toBe(true);
    expect(out.some((line) => line.includes("lint:"))).toBe(false);
  });
});


describe("batch-run CLI guarded execution (I-5/J-2/J-4)", () => {
  test("runs a scripted batch and publishes contracted blocks", async () => {
    const file = path.join(mkdtempSync(path.join(os.tmpdir(), "batch-cli-exec-")), "job.jsonl");
    writeFileSync(file, [
      { id: "a", task: "one", status: "pending" },
      { id: "b", task: "two", status: "pending" },
    ].map((r) => JSON.stringify(r)).join("\n") + "\n");
    const out: string[] = [];
    const ran: string[] = [];
    const exit = await runBatchCli(["--job", file], {
      out: (l) => out.push(l), err: () => undefined,
    }, {
      executor: async (row) => (ran.push(row.id), { terminal: "succeeded" as const }),
    });
    expect(exit).toBe(0);
    expect(ran).toEqual(["a", "b"]);
    expect(out.some((l) => l.includes("batch row: a · done"))).toBe(true);
    expect(out.some((l) => l.includes("2 done / 0 failed of 2 selected"))).toBe(true);
    const blocks: string[] = [];
    let current: string[] = [];
    for (const line of out) {
      if (line.startsWith("metric: ")) {
        if (current.length) blocks.push(current.join("\n"));
        current = [line];
      } else if (current.length && /^(anchor|population|excludes|value|run_id): /.test(line)) {
        current.push(line);
      } else if (current.length) {
        blocks.push(current.join("\n"));
        current = [];
      }
    }
    if (current.length) blocks.push(current.join("\n"));
    expect(blocks.map((b) => b.split("\n")[0])).toEqual([
      "metric: batch rows executed",
      "metric: batch rows succeeded",
      "metric: batch rows failed",
    ]);
    for (let i = 0; i < blocks.length; i += 1) {
      const metric = ["batch rows executed", "batch rows succeeded", "batch rows failed"][i]!;
      expect(() => assertPublishedNumber(blocks[i], metric)).not.toThrow();
    }
  });

  test("resume skips completed rows when executing through the CLI", async () => {
    const file = path.join(mkdtempSync(path.join(os.tmpdir(), "batch-cli-resume-")), "job.jsonl");
    writeFileSync(file, [
      { id: "a", task: "one", status: "done", terminal: "succeeded" },
      { id: "b", task: "two", status: "pending" },
    ].map((r) => JSON.stringify(r)).join("\n") + "\n");
    const ran: string[] = [];
    const out: string[] = [];
    const exit = await runBatchCli(["--job", file], { out: (l) => out.push(l), err: () => undefined }, {
      executor: async (row) => (ran.push(row.id), { terminal: "succeeded" as const }),
    });
    expect(exit).toBe(0);
    expect(ran).toEqual(["b"]);
    expect(out.some((l) => l.includes("1 skipped"))).toBe(true);
  });

  test("a failed row makes the CLI exit 1 but does not abort the batch", async () => {
    const file = path.join(mkdtempSync(path.join(os.tmpdir(), "batch-cli-fail-")), "job.jsonl");
    writeFileSync(file, [
      { id: "a", task: "one", status: "pending" },
      { id: "b", task: "two", status: "pending" },
    ].map((r) => JSON.stringify(r)).join("\n") + "\n");
    const ran: string[] = [];
    const exit = await runBatchCli(["--job", file], { out: () => undefined, err: () => undefined }, {
      executor: async (row) => {
        ran.push(row.id);
        return { terminal: row.id === "a" ? "failed" : "succeeded" };
      },
    });
    expect(exit).toBe(1);
    expect(ran).toEqual(["a", "b"]);
  });

  test("Ctrl-C drain through the CLI settles the in-flight row and stops scheduling", async () => {
    const file = path.join(mkdtempSync(path.join(os.tmpdir(), "batch-cli-drain-")), "job.jsonl");
    writeFileSync(file, [
      { id: "a", task: "one", status: "pending" },
      { id: "b", task: "two", status: "pending" },
      { id: "c", task: "three", status: "pending" },
    ].map((r) => JSON.stringify(r)).join("\n") + "\n");
    const controller = new AbortController();
    const out: string[] = [];
    const ran: string[] = [];
    const exit = await runBatchCli(["--job", file], { out: (l) => out.push(l), err: () => undefined }, {
      signal: controller.signal,
      executor: async (row) => {
        ran.push(row.id);
        if (row.id === "a") controller.abort();
        return { terminal: "succeeded" };
      },
    });
    expect(exit).toBe(0);
    expect(ran).toEqual(["a"]);
    expect(out.some((l) => l.includes("drained"))).toBe(true);
    const statuses = readFileSync(file, "utf8").trim().split("\n").map((l) => JSON.parse(l).status);
    expect(statuses).toEqual(["done", "pending", "pending"]);
  });
});
