/**
 * logging-hardening.test.ts — wave-12: the audit trail may not fail silently.
 *
 * A log-event append failure used to be swallowed by an empty catch: with a
 * read-only kernel state dir a whole turn produced zero event files and the run
 * still reported exit=succeeded (only a receipt notice surfaced). The run was
 * structurally blind to its own lost audit trail. A receipt-issuance failure
 * had the same shape (notice, then a triumphant exit). Both now count against
 * the run:
 *
 *  - the FIRST event-log failure is noticed once, naming the error, and the
 *    count keeps growing silently behind it;
 *  - when the turn ends, any lost event, receipt or transcript row makes the
 *    exit terminal=failed / detail=internal_error — the closed, machine-
 *    readable vocabulary of `RunExit` — and the run-level message names every
 *    count with its first underlying error ("event log append failed N time(s):
 *    <err>", "receipt issuance failed N time(s): <err>").
 *
 * A healthy run is unchanged: succeeded, no notices, the event chain written.
 * The read-only scenarios are Unix-only (they need POSIX modes).
 */

import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import type { Provider, ProviderEvent, RuntimeEvent } from "../../src/contracts";
import { KernelClient } from "../../src/core/kernel";
import type { LoopDeps } from "../../src/core/loop";
import { runTurn } from "../../src/core/loop";
import { kernelStateDir } from "../../src/core/paths";
import { SessionStore } from "../../src/core/session";

const onUnix = process.platform !== "win32";
const dirs: string[] = [];

function scratchDir(prefix: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

function scriptedProvider(turns: ProviderEvent[][]): Provider {
  let index = 0;
  return {
    name: "scripted",
    async *stream() {
      const events = turns[Math.min(index, turns.length - 1)] ?? [];
      index += 1;
      for (const event of events) yield event;
    },
  };
}

/** This file's one scripted shape: read a file, then end. */
function readThenEnd(file: string): ProviderEvent[][] {
  return [
    [
      { type: "tool_call", id: "call_1", name: "read", arguments: JSON.stringify({ path: file }) },
      { type: "done", stopReason: "tool_use" },
    ],
    [{ type: "done", stopReason: "end" }],
  ];
}

/**
 * Scripted shape for the read-only-dir repro: one assistant turn, no tool call.
 * No tool call means no receipt attempt — and `LocalKernel.issueReceipt` calls
 * `privateDir(stateDir)` (a chmod 0700) before its own append, which would
 * silently restore write access mid-run. The no-tool turn keeps every append
 * failing, which is exactly the confirmed repro (a whole turn, zero event
 * files).
 */
function textThenEnd(text: string): ProviderEvent[][] {
  return [
    [
      { type: "text", text },
      { type: "done", stopReason: "end" },
    ],
  ];
}

interface Harness {
  deps: LoopDeps;
  kernel: KernelClient;
  store: SessionStore;
  events: RuntimeEvent[];
  messages: (type: RuntimeEvent["type"]) => string[];
}

function harness(workspace: string, provider: Provider): Harness {
  const kernel = new KernelClient({ workspace });
  const store = new SessionStore(workspace);
  const events: RuntimeEvent[] = [];
  const deps: LoopDeps = {
    workspace,
    sessionId: store.createSession("logging-hardening").id,
    model: "scripted-1",
    provider,
    kernel,
    store,
    signal: new AbortController().signal,
    callbacks: { onEvent: (ev) => events.push(ev) },
    sessionLeases: [],
    approve: async () => true,
    budget: { maxSteps: 5 },
  };
  const messages = (type: RuntimeEvent["type"]): string[] =>
    events
      .filter((ev) => ev.type === type)
      .map((ev) => ("message" in ev ? ev.message : ""));
  return { deps, kernel, store, events, messages };
}

async function closeAll(h: Harness): Promise<void> {
  await h.kernel.close();
  h.store.close();
}

afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop() as string, { recursive: true, force: true });
});

/* --------------------------- a healthy run --------------------------- */

describe("a run whose stores are writable", () => {
  test("writes the event chain, leaves zero notices and exits succeeded", async () => {
    const workspace = scratchDir("hz-log-ok-");
    writeFileSync(path.join(workspace, "note.txt"), "hello\n", "utf8");
    const h = harness(workspace, scriptedProvider(readThenEnd("note.txt")));
    try {
      const result = await runTurn(h.deps, "read the note");
      expect(result.exit.terminal).toBe("succeeded");
      expect(result.exit.detail).toBe("turn_end");

      // Nothing to report: no notice, no error event, and the final render ran.
      expect(h.messages("notice")).toEqual([]);
      expect(h.messages("error")).toEqual([]);
      expect(h.events[h.events.length - 1]?.type).toBe("turn.done");

      // The audit trail is really there and verifies.
      const chain = await h.kernel.verifyEventChain(`session:${h.deps.sessionId}`);
      expect(chain.ok).toBe(true);
      expect(chain.count).toBeGreaterThan(0);
      const logged = await h.kernel.readEvents(`session:${h.deps.sessionId}`);
      expect(logged.some((e) => e.type === "tool.result")).toBe(true);
      expect(logged.some((e) => e.type === "receipt.issued")).toBe(true);

      // ...and the receipt is on its own verifying chain.
      const receipts = await h.kernel.verifyReceipts();
      expect(receipts.ok).toBe(true);
      expect(receipts.count).toBe(1);

      // The transcript row (the append path item 2 hardens) landed too.
      expect(h.store.history(h.deps.sessionId).some((m) => m.role === "tool" && m.toolName === "read")).toBe(true);
    } finally {
      await closeAll(h);
    }
  });
});

/* ---------------- a read-only kernel state dir (the finding) ---------------- */

describe.skipIf(!onUnix)("a read-only kernel state dir", () => {
  test("completes the turn, notices the first append failure once, and never exits succeeded", async () => {
    const workspace = scratchDir("hz-log-ro-");
    const stateDir = kernelStateDir(workspace);
    mkdirSync(stateDir, { recursive: true });
    // Every event append fails EACCES from here on.
    chmodSync(stateDir, 0o500);

    // The kernel client is built while the dir is read-only: policy loading is a
    // read, so construction still succeeds — the appends are what fail.
    const h = harness(workspace, scriptedProvider(textThenEnd("nothing to run")));
    try {
      const result = await runTurn(h.deps, "run against a read-only kernel state dir");

      // The turn completed (the assistant text came back, the render saw its
      // sentinel) but the exit cannot claim success: the audit trail it depends
      // on was lost.
      expect(result.text).toBe("nothing to run");
      expect(h.events[h.events.length - 1]?.type).toBe("turn.done");
      expect(result.exit.terminal).toBe("failed");
      expect(result.exit.detail).toBe("internal_error");

      // The FIRST failure is noticed once, naming the underlying error.
      const appendNotices = h.messages("notice").filter((m) => m.includes("event log append failed"));
      expect(appendNotices).toHaveLength(1);
      expect(appendNotices[0]).toContain("EACCES");

      // The run-level failure names the count and the underlying error.
      const errors = h.messages("error");
      expect(errors.some((m) => /event log append failed \d+ time\(s\): /.test(m))).toBe(true);
      expect(errors.some((m) => m.includes("EACCES"))).toBe(true);

      // The confirmed repro: a whole turn, zero event files (and no receipt
      // file — no tool ran, so no receipt was owed).
      expect(readdirSync(stateDir)).not.toContain("events");
      expect(readdirSync(stateDir)).not.toContain("receipts.jsonl");
    } finally {
      chmodSync(stateDir, 0o700);
      await closeAll(h);
    }
  });
});

/* -------------------- an unwritable receipts path -------------------- */

describe.skipIf(!onUnix)("an unwritable receipts file", () => {
  test("keeps its notice and never exits succeeded", async () => {
    const workspace = scratchDir("hz-log-receipt-");
    const stateDir = kernelStateDir(workspace);
    mkdirSync(stateDir, { recursive: true });
    const receipts = path.join(stateDir, "receipts.jsonl");
    writeFileSync(receipts, "", "utf8");
    chmodSync(receipts, 0o400);

    const h = harness(workspace, scriptedProvider(readThenEnd("missing.txt")));
    try {
      const result = await runTurn(h.deps, "run with an unwritable receipts file");

      expect(result.exit.terminal).toBe("failed");
      expect(result.exit.detail).toBe("internal_error");

      // The per-call receipt notice is kept...
      expect(h.messages("notice").some((m) => m.includes("could not issue a receipt"))).toBe(true);
      // ...and the run-level failure names the count and the error.
      const errors = h.messages("error");
      expect(errors.some((m) => /receipt issuance failed 1 time\(s\): /.test(m))).toBe(true);
      expect(errors.some((m) => m.includes("EACCES") && m.includes("receipts.jsonl"))).toBe(true);

      // The event log was healthy: no event-log failure is involved.
      expect(h.messages("notice").some((m) => m.includes("event log append failed"))).toBe(false);
      const chain = await h.kernel.verifyEventChain(`session:${h.deps.sessionId}`);
      expect(chain.ok).toBe(true);

      // The receipts bytes were never touched (the append failed first).
      expect(readFileSync(receipts, "utf8")).toBe("");
    } finally {
      chmodSync(receipts, 0o600);
      await closeAll(h);
    }
  });
});
