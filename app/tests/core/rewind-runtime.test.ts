/**
 * rewind-runtime.test.ts — the /rewind runtime seam (wave-14c): a completed
 * turn records a checkpoint, and `rewindTo(n)` puts back the files the
 * workspace changed after it through the same route `undo` takes. This is the
 * cross-module integration the checkpoints slice's unit tests deliberately do
 * not cover — store + journal + runtime + real fs, no stubs.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { sha256Hex } from "../../src/core/canon";
import { __resetCheckpointsForTests } from "../../src/core/checkpoints";
import { createRuntime } from "../../src/core/index";
import { bindJournalWorkspace, recordChange } from "../../src/tools/change-journal";

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const fn of cleanups.splice(0)) await fn();
  __resetCheckpointsForTests();
});

async function runtimeIn(workspace: string) {
  const runtime = await createRuntime({ workspace, mock: true });
  cleanups.push(async () => {
    await runtime.close();
    rmSync(workspace, { recursive: true, force: true });
  });
  const sessionId = (runtime as unknown as { sessionId: string }).sessionId;
  return { runtime, sessionId };
}

/** One completed mock turn; returns nothing (the turn text is irrelevant here). */
async function turn(runtime: Awaited<ReturnType<typeof runtimeIn>>["runtime"], text: string): Promise<void> {
  await runtime.send(text, { onEvent: () => {} });
}

/** Record one change as a tool would: the file already holds the NEW bytes. */
function recordWrite(sessionId: string, ws: string, rel: string, before: string, after: string): void {
  bindJournalWorkspace(sessionId, ws);
  const target = path.join(ws, rel);
  writeFileSync(target, after);
  recordChange(sessionId, {
    at: Date.now(),
    path: target,
    rel,
    before,
    afterSha256: sha256Hex(after),
    tool: "write",
  });
}

describe("the rewind runtime seam", () => {
  test("a completed turn records a checkpoint (zero-change turns included)", async () => {
    const ws = mkdtempSync(path.join(tmpdir(), "hz-rewind-ckpt-"));
    const { runtime } = await runtimeIn(ws);

    expect(runtime.checkpoints?.() ?? []).toHaveLength(0);
    await turn(runtime, "hello world\nsecond line");

    const checkpoints = runtime.checkpoints?.() ?? [];
    expect(checkpoints).toHaveLength(1);
    expect(checkpoints[0]?.n).toBe(1);
    expect(checkpoints[0]?.label).toBe("hello world");
    expect(checkpoints[0]?.changes).toHaveLength(0);
  });

  test("rewindTo puts back a change recorded after the checkpoint, then is idempotent", async () => {
    const ws = mkdtempSync(path.join(tmpdir(), "hz-rewind-restore-"));
    const { runtime, sessionId } = await runtimeIn(ws);
    await turn(runtime, "start");
    recordWrite(sessionId, ws, "a.txt", "v1\n", "v2\n");

    const summary = await runtime.rewindTo?.(1);

    expect(summary).toContain("restored 1");
    expect(summary).toContain("a.txt");
    expect(readFileSync(path.join(ws, "a.txt"), "utf8")).toBe("v1\n");
    // The entry was tombstoned: the same checkpoint has nothing left to put back.
    const again = await runtime.rewindTo?.(1);
    expect(again).toContain("nothing to rewind");
    expect(readFileSync(path.join(ws, "a.txt"), "utf8")).toBe("v1\n");
  });

  test("a file that moved on since the recorded change is refused, never overwritten — and stays rewindable", async () => {
    const ws = mkdtempSync(path.join(tmpdir(), "hz-rewind-stale-"));
    const { runtime, sessionId } = await runtimeIn(ws);
    await turn(runtime, "start");
    recordWrite(sessionId, ws, "a.txt", "v1\n", "v2\n");
    // A human (or another program) edits the file after the recorded change.
    writeFileSync(path.join(ws, "a.txt"), "human edit\n");

    const summary = await runtime.rewindTo?.(1);

    expect(summary).toContain("refused 1");
    expect(summary).toContain("concurrent edit");
    expect(readFileSync(path.join(ws, "a.txt"), "utf8")).toBe("human edit\n");
    // The entry was NOT consumed: once the file matches again, the rewind works.
    writeFileSync(path.join(ws, "a.txt"), "v2\n");
    const retry = await runtime.rewindTo?.(1);
    expect(retry).toContain("restored 1");
    expect(readFileSync(path.join(ws, "a.txt"), "utf8")).toBe("v1\n");
  });

  test("an unknown checkpoint number is a typed refusal, not a crash", async () => {
    const ws = mkdtempSync(path.join(tmpdir(), "hz-rewind-unknown-"));
    const { runtime } = await runtimeIn(ws);
    await turn(runtime, "start");
    await expect(runtime.rewindTo?.(99)).rejects.toThrow(/no checkpoint 99/);
  });
});
