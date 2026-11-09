/**
 * session-fork.test.ts — session fork (FEAT-004): the store copy, the runtime
 * seam, the kernel stream and the server method. Each test fails if the fork
 * implementation is reverted (no forkSession / no session.fork method).
 */

import { afterAll, describe, expect, test } from "bun:test";
import type { ServerNotification, ServerResponse } from "../../src/contracts";
import { SERVER_METHODS } from "../../src/contracts";
import { streamFor } from "../../src/core/loop";
import { createRuntime } from "../../src/core";
import { KernelClient } from "../../src/core/kernel";
import { createServer } from "../../src/core/server";
import { SessionStore } from "../../src/core/session";
import { cleanupTemps, tempDir } from "./helpers";

afterAll(() => cleanupTemps());

function seed(store: SessionStore, id: string): void {
  store.appendMessage(id, { role: "user", content: "one" });
  store.appendMessage(id, {
    role: "assistant",
    content: "",
    toolCalls: [{ id: "c1", name: "read", arguments: "{}" }],
  });
  store.appendMessage(id, { role: "tool", content: "r", toolCallId: "c1", toolName: "read" });
  store.appendMessage(id, { role: "assistant", content: "done" });
}

describe("SessionStore.forkSession", () => {
  test("copies the whole transcript into a new session with lineage; the parent is untouched", () => {
    const ws = tempDir("hz-fork-store-");
    const store = new SessionStore(ws);
    const parent = store.createSession("p");
    seed(store, parent.id);
    const before = JSON.stringify(store.history(parent.id));
    const child = store.forkSession(parent.id, { parentSeq: 7 });
    expect(child.id).not.toBe(parent.id);
    expect(child.forkedFrom).toEqual({ sessionId: parent.id, messageIndex: 4, parentSeq: 7 });
    expect(JSON.stringify(store.history(child.id))).toBe(before);
    expect(JSON.stringify(store.history(parent.id))).toBe(before);
    expect(store.getSession(parent.id)?.forkedFrom).toBeUndefined();
    expect(store.getSession(child.id)?.forkedFrom?.sessionId).toBe(parent.id);
    const listed = store.listSessions().find((s) => s.id === child.id);
    expect(listed?.forkedFrom?.messageIndex).toBe(4);
    // The child diverges without touching the parent.
    store.appendMessage(child.id, { role: "user", content: "branch" });
    expect(store.messageCount(parent.id)).toBe(4);
    expect(store.messageCount(child.id)).toBe(5);
    store.close();
  });

  test("a cut inside a tool-call group moves earlier; bad indexes and ids are refused", () => {
    const ws = tempDir("hz-fork-cut-");
    const store = new SessionStore(ws);
    const parent = store.createSession("p");
    seed(store, parent.id);
    const child = store.forkSession(parent.id, { at: 2 }); // between assistant tool_call and its result
    expect(child.forkedFrom?.messageIndex).toBe(1);
    expect(store.history(child.id).length).toBe(1);
    expect(store.forkSession(parent.id, { at: 0 }).forkedFrom?.messageIndex).toBe(0);
    expect(() => store.forkSession(parent.id, { at: -1 })).toThrow();
    expect(() => store.forkSession("nope")).toThrow();
    store.close();
  });

  test("lineage survives reopening the database (resume works on forks)", () => {
    const ws = tempDir("hz-fork-reopen-");
    const a = new SessionStore(ws);
    const parent = a.createSession("p");
    seed(a, parent.id);
    const child = a.forkSession(parent.id);
    a.close();
    const b = new SessionStore(ws);
    expect(b.getSession(child.id)?.forkedFrom?.sessionId).toBe(parent.id);
    expect(b.history(child.id).length).toBe(4);
    b.close();
  });
});

describe("runtime fork", () => {
  test("forkSession writes a session.fork first event on a NEW stream; the parent stream is only read", async () => {
    const ws = tempDir("hz-fork-rt-");
    const rt = await createRuntime({ workspace: ws, mock: true });
    await rt.send("hello", {});
    const parentId = rt.sessionId;
    const child = await rt.forkSession!();
    expect(rt.sessionId).toBe(parentId); // non-switching
    const kernel = new KernelClient({ workspace: ws });
    await kernel.start();
    const childEvents = await kernel.readEvents(streamFor(child.id), 1);
    expect(childEvents[0]?.type).toBe("session.fork");
    const payload = childEvents[0]?.payload as { parentSessionId: string; parentStream: string; parentSeq: number };
    expect(payload.parentSessionId).toBe(parentId);
    expect(payload.parentStream).toBe(streamFor(parentId));
    expect(payload.parentSeq).toBeGreaterThan(0);
    const parentEvents = await kernel.readEvents(streamFor(parentId), 1);
    expect(parentEvents.some((e) => e.type === "session.fork")).toBe(false);
    expect((await kernel.verifyEventChain(streamFor(parentId))).ok).toBe(true);
    await kernel.close();

    // switchSession resumes the fork and continues forward on it.
    rt.switchSession!(child.id);
    expect(rt.sessionId).toBe(child.id);
    expect(rt.history().length).toBeGreaterThan(0);
    await rt.close();
  });
});

describe("server session.fork", () => {
  test("is a listed method, forks, shows lineage in session.list, and the fork can be prompted", async () => {
    expect(SERVER_METHODS).toContain("session.fork");
    const ws = tempDir("hz-fork-srv-");
    const lines: string[] = [];
    const out: ServerResponse[] = [];
    let wake: (() => void) | null = null;
    let done = false;
    const input: AsyncIterable<string> = {
      async *[Symbol.asyncIterator]() {
        while (true) {
          if (lines.length > 0) {
            yield lines.shift() as string;
            continue;
          }
          if (done) return;
          await new Promise<void>((r) => (wake = r));
        }
      },
    };
    const sink = (line: string): void => {
      const obj = JSON.parse(line) as ServerResponse | ServerNotification;
      if ("id" in obj) out.push(obj as ServerResponse);
    };
    const server = createServer({ workspace: ws, input, output: sink, mock: true });
    const run = server.start();
    let n = 0;
    const call = async (method: string, params?: unknown): Promise<ServerResponse> => {
      n += 1;
      const id = n;
      lines.push(JSON.stringify({ id, method, params }) + "\n");
      (wake as (() => void) | null)?.();
      for (let i = 0; i < 400; i += 1) {
        const hit = out.find((r) => r.id === id);
        if (hit) return hit;
        await new Promise((r) => setTimeout(r, 25));
      }
      throw new Error("timeout " + method);
    };
    const res = (r: ServerResponse): Record<string, any> => (r as { result: Record<string, any> }).result;

    const created = res(await call("session.create"));
    const parent = created.sessionId as string;
    await call("session.prompt", { sessionId: parent, text: "hi" });
    const forked = res(await call("session.fork", { sessionId: parent }));
    expect(forked.sessionId).not.toBe(parent);
    expect(forked.forkedFrom.sessionId).toBe(parent);
    expect(forked.forkedFrom.uri).toBe(`hz://session/${parent}`);
    expect(forked.forkedFrom.messageIndex).toBeGreaterThan(0);

    const listed = res(await call("session.list")).sessions as Array<Record<string, any>>;
    const row = listed.find((s) => s.id === forked.sessionId);
    expect(row?.forkedFrom?.sessionId).toBe(parent);
    expect(listed.find((s) => s.id === parent)?.forkedFrom).toBeUndefined();

    // fork at 0: empty copy; bad params fail closed.
    const empty = res(await call("session.fork", { sessionId: parent, at: 0 }));
    expect(empty.forkedFrom.messageIndex).toBe(0);
    expect("error" in (await call("session.fork", { sessionId: parent, at: -2 }))).toBe(true);
    expect("error" in (await call("session.fork", { sessionId: "nope" }))).toBe(true);

    // The fork is promptable and the parent stays as it was.
    const parentCount = () => {
      const s = new SessionStore(ws);
      try {
        return s.messageCount(parent);
      } finally {
        s.close();
      }
    };
    const before = parentCount();
    const reply = res(await call("session.prompt", { sessionId: forked.sessionId, text: "on the branch" }));
    expect(reply.sessionId).toBe(forked.sessionId);
    expect(parentCount()).toBe(before);

    done = true;
    (wake as (() => void) | null)?.();
    await run;
    await server.stop();
  });
});
