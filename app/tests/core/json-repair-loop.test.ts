/**
 * json-repair-loop.test.ts - T-1 wired into runTurn (NF-069).
 *
 * A malformed-but-repairable argument blob runs, the card and the durable
 * tool.call event say `repaired`, and the receipt hashes the REPAIRED args that
 * were admitted. A truncated side-effecting call is refused and nothing runs.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { canonicalJson, sha256Hex, type Provider, type ProviderEvent, type ReceiptInput, type RuntimeEvent } from "../../src/contracts";
import { KernelClient } from "../../src/core/kernel";
import { runTurn, type LoopDeps } from "../../src/core/loop";
import { SessionStore } from "../../src/core/session";

let workspace: string;
beforeEach(() => {
  workspace = mkdtempSync(path.join(tmpdir(), "hz-json-repair-loop-"));
});
afterEach(() => {
  rmSync(workspace, { recursive: true, force: true });
});

function call(name: string, rawArgs: string): ProviderEvent[] {
  return [{ type: "tool_call", id: "call_1", name, arguments: rawArgs }, { type: "done", stopReason: "tool_use" }];
}

/** Plays `first`, then ends the turn. */
function twoStepProvider(first: ProviderEvent[]): Provider {
  let n = 0;
  return {
    name: "scripted",
    async *stream() {
      n += 1;
      const events: ProviderEvent[] = n === 1 ? first : [{ type: "text", text: "done" }, { type: "done", stopReason: "end" }];
      for (const e of events) yield e;
    },
  };
}

async function run(rawName: string, rawArgs: string) {
  const events: RuntimeEvent[] = [];
  const kernel = new KernelClient({ workspace, stateDir: path.join(workspace, ".hzcode", "kernel") });
  const receipts: ReceiptInput[] = [];
  const issue = kernel.issueReceipt.bind(kernel);
  kernel.issueReceipt = async (input: ReceiptInput) => {
    receipts.push(input);
    return issue(input);
  };
  const store = new SessionStore(workspace);
  const deps: LoopDeps = {
    workspace,
    sessionId: store.createSession("json-repair").id,
    model: "scripted-1",
    provider: twoStepProvider(call(rawName, rawArgs)),
    kernel,
    store,
    signal: new AbortController().signal,
    callbacks: { onEvent: (ev) => events.push(ev) },
    sessionLeases: [],
    approve: async () => true,
  };
  try {
    const result = await runTurn(deps, "go");
    const logged = await kernel.readEvents(`session:${deps.sessionId}`).catch(() => []);
    const history = store.history(deps.sessionId);
    return { result, events, receipts, logged, history };
  } finally {
    await kernel.close();
    store.close();
  }
}

describe("repairable arguments run, marked and receipted as repaired", () => {
  test("single quotes + trailing comma + string-typed limit: the read runs", async () => {
    writeFileSync(path.join(workspace, "a.txt"), "one\ntwo\nthree\n");
    const { events, receipts } = await run("read", "{'path': 'a.txt', 'limit': '2',}");
    const done = events.filter((e): e is Extract<RuntimeEvent, { type: "tool.card" }> => e.type === "tool.card" && e.status !== "running");
    expect(done).toHaveLength(1);
    expect(done[0]?.status).toBe("ok");
    expect(done[0]?.repaired).toBe(true);
    expect(done[0]?.args).toEqual({ path: "a.txt", limit: 2 });
    // The running card is marked too.
    expect(events.find((e) => e.type === "tool.card" && e.status === "running")).toMatchObject({ repaired: true });
    // The receipt digest is of the REPAIRED args that were admitted, not the raw bytes.
    expect(receipts).toHaveLength(1);
    expect(receipts[0]?.argsDigest).toBe(sha256Hex(canonicalJson({ path: "a.txt", limit: 2 })));
  });

  test("clean arguments are not marked repaired", async () => {
    writeFileSync(path.join(workspace, "a.txt"), "x\n");
    const { events } = await run("read", '{"path":"a.txt"}');
    const cards = events.filter((e): e is Extract<RuntimeEvent, { type: "tool.card" }> => e.type === "tool.card");
    expect(cards.length).toBeGreaterThan(0);
    for (const c of cards) expect(c.repaired).toBeUndefined();
  });

  test("the durable tool.call event carries repaired + the repair list", async () => {
    writeFileSync(path.join(workspace, "a.txt"), "x\n");
    const { logged } = await run("read", '```json\n{"path":"a.txt"}\n```');
    const ev = logged.find((e) => e.type === "tool.call");
    expect(ev).toBeDefined();
    const payload = ev?.payload as { repaired?: boolean; repairs?: string[]; args?: unknown };
    expect(payload.repaired).toBe(true);
    expect(payload.repairs).toContain("stripped a code fence");
    expect(payload.args).toEqual({ path: "a.txt" });
  });
});

describe("a truncation repair is disclosed to the model (ruling 74)", () => {
  const NOTE = "[arguments were cut off and closed; re-issue the call if the values are incomplete]";
  const toolText = (history: Array<{ role: string; content: string }>) => history.filter((m) => m.role === "tool").map((m) => m.content).join("\n");

  test("a cut-off read call runs and its tool result carries the note", async () => {
    writeFileSync(path.join(workspace, "a.txt"), "one\ntwo\n");
    const { events, history } = await run("read", '{"path":"a.txt');
    const done = events.filter((e): e is Extract<RuntimeEvent, { type: "tool.card" }> => e.type === "tool.card" && e.status !== "running");
    expect(done[0]?.status).toBe("ok");
    expect(done[0]?.repaired).toBe(true);
    expect(toolText(history)).toContain(NOTE);
  });

  test("a plain syntax repair (no cut-off) carries no note", async () => {
    writeFileSync(path.join(workspace, "a.txt"), "one\n");
    const { history } = await run("read", "{'path': 'a.txt',}");
    expect(toolText(history)).not.toContain(NOTE);
  });

  test("a clean call carries no note", async () => {
    writeFileSync(path.join(workspace, "a.txt"), "one\n");
    const { history } = await run("read", '{"path":"a.txt"}');
    expect(toolText(history)).not.toContain(NOTE);
  });
});

describe("a truncated side-effecting call is refused, never completed", () => {
  test("shell: a cut command does not run", async () => {
    const marker = path.join(workspace, "ran.txt");
    const { events, receipts } = await run("shell", `{"command":"echo hi > ${marker}`);
    expect(existsSync(marker)).toBe(false);
    const done = events.filter((e): e is Extract<RuntimeEvent, { type: "tool.card" }> => e.type === "tool.card" && e.status !== "running");
    expect(done[0]?.status).toBe("error");
    expect(done[0]?.summary ?? "").toContain("cut off");
    // The refusal is receipted over EMPTY args: the cut command was never admitted.
    expect(receipts.map((r) => r.argsDigest)).toEqual([sha256Hex(canonicalJson({}))]);
  });

  test("write: a cut content string does not create the file", async () => {
    const target = path.join(workspace, "out.txt");
    const { events } = await run("write", `{"path":"${target}","content":"half a fi`);
    expect(existsSync(target)).toBe(false);
    const done = events.filter((e): e is Extract<RuntimeEvent, { type: "tool.card" }> => e.type === "tool.card" && e.status !== "running");
    expect(done[0]?.status).toBe("error");
    expect(readFileSyncSafe(target)).toBeUndefined();
  });
});

function readFileSyncSafe(p: string): string | undefined {
  try {
    return readFileSync(p, "utf8");
  } catch {
    return undefined;
  }
}
