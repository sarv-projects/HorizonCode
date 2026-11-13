import { describe, expect, test } from "bun:test";
import { runBatchCli } from "../../src/batch-run";
import { mkdtempSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

describe("batch-run cli", () => {
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
