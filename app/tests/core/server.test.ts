/**
 * server.test.ts — the single-attach server (FEAT-002), driven over in-memory
 * NDJSON pipes with the mock provider. No real stdio: `input` is a pushable
 * async iterable of request lines, `output` collects response/notification
 * frames. Every assertion is about what the server does through `createRuntime`
 * — so the crash-reconstruct case reads the DB back through a SECOND SQLite
 * connection exactly like crash-recovery.test.ts, proving recovery ran on
 * attach, not in an in-memory object.
 *
 * This suite is the revert check for the whole server wiring: if the prompt
 * reply or the streamed `session.event` notifications disappear, (b)/(c) fail.
 */

import { Database } from "bun:sqlite";
import { afterAll, describe, expect, test } from "bun:test";
import type { ChatMsg, ServerNotification, ServerResponse } from "../../src/contracts";
import { HZ_PROTO, SESSION_EVENT_METHOD } from "../../src/contracts";
import { AdmissionQueue } from "../../src/core/admission";
import { createServer } from "../../src/core/server";
import { SessionStore } from "../../src/core/session";
import { cleanupTemps, tempDir } from "./helpers";

afterAll(() => cleanupTemps());

/** A pushable async iterable of lines, closable to end the server loop. */
function makeInput(): { push(line: string): void; end(): void; iterable: AsyncIterable<string> } {
  const queue: string[] = [];
  let done = false;
  let wake: (() => void) | null = null;
  const kick = (): void => {
    const w = wake;
    wake = null;
    if (w) w();
  };
  const iterable: AsyncIterable<string> = {
    async *[Symbol.asyncIterator]() {
      while (true) {
        if (queue.length > 0) {
          yield queue.shift() as string;
          continue;
        }
        if (done) return;
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
      }
    },
  };
  return {
    push: (line: string) => {
      queue.push(line.endsWith("\n") ? line : line + "\n");
      kick();
    },
    end: () => {
      done = true;
      kick();
    },
    iterable,
  };
}

/** Collect output frames and let a test await the response for a given id. */
function makeOutput(): {
  sink: (line: string) => void;
  responses: ServerResponse[];
  notifications: ServerNotification[];
  waitFor(id: number): Promise<ServerResponse>;
} {
  const responses: ServerResponse[] = [];
  const notifications: ServerNotification[] = [];
  const waiters = new Map<number, (r: ServerResponse) => void>();
  return {
    responses,
    notifications,
    sink: (line: string) => {
      const trimmed = line.trim();
      if (trimmed === "") return;
      const obj = JSON.parse(trimmed) as Record<string, unknown>;
      if (typeof obj.id === "number" || typeof obj.id === "string") {
        const resp = obj as unknown as ServerResponse;
        responses.push(resp);
        if (typeof obj.id === "number") {
          const w = waiters.get(obj.id);
          if (w) {
            waiters.delete(obj.id);
            w(resp);
          }
        }
      } else if (typeof obj.method === "string") {
        notifications.push(obj as unknown as ServerNotification);
      }
    },
    waitFor: (id: number) =>
      new Promise<ServerResponse>((resolve) => {
        const existing = responses.find((r) => r.id === id);
        if (existing) {
          resolve(existing);
          return;
        }
        waiters.set(id, resolve);
      }),
  };
}

function resultOf(resp: ServerResponse): Record<string, unknown> {
  expect("error" in resp ? JSON.stringify((resp as { error: unknown }).error) : "ok").toBe("ok");
  return (resp as { result: Record<string, unknown> }).result;
}

function sessionEvents(out: ReturnType<typeof makeOutput>, sessionId: string): string[] {
  return out.notifications
    .filter((n) => n.method === SESSION_EVENT_METHOD)
    .map((n) => n.params as { sessionId: string; event: { type: string } })
    .filter((p) => p.sessionId === sessionId)
    .map((p) => p.event.type);
}

/** Read the transcript back through a fresh read-only connection. */
function readMessages(dbPath: string, sessionId: string): Array<{ role: string; content: string; meta: string | null }> {
  const db = new Database(dbPath, { readonly: true });
  try {
    return db
      .query("SELECT role, content, meta FROM messages WHERE session_id = ? ORDER BY rowid ASC")
      .all(sessionId) as Array<{ role: string; content: string; meta: string | null }>;
  } finally {
    db.close();
  }
}

function readAdmissions(dbPath: string, sessionId: string): Array<{ id: string; state: string; evidence: string | null }> {
  const db = new Database(dbPath, { readonly: true });
  try {
    return db
      .query("SELECT id, state, evidence FROM admissions WHERE session_id = ? ORDER BY rowid ASC")
      .all(sessionId) as Array<{ id: string; state: string; evidence: string | null }>;
  } finally {
    db.close();
  }
}

function metaCallId(meta: string | null): string | undefined {
  if (!meta) return undefined;
  try {
    const parsed = JSON.parse(meta) as { toolCallId?: string };
    return parsed.toolCallId;
  } catch {
    return undefined;
  }
}

describe("single-attach server (FEAT-002)", () => {
  test("(a) server.hello returns proto=HZ_PROTO and the workspace/kernelMode", async () => {
    const workspace = tempDir("hz-server-hello-");
    const input = makeInput();
    const out = makeOutput();
    const server = createServer({ workspace, input: input.iterable, output: out.sink, mock: true });
    const run = server.start();

    input.push(JSON.stringify({ id: 1, method: "server.hello" }));
    const hello = resultOf(await out.waitFor(1));
    expect(hello.proto).toBe(HZ_PROTO);
    expect(hello.workspace).toBe(workspace);
    expect(typeof hello.version).toBe("string");
    // hello precedes the first session open, yet the mode is real, never "unknown".
    expect(["trusted", "untrusted"]).toContain(hello.kernelMode as string);
    const caps = hello.capabilities as { methods: string[]; transports: string[]; singleAttach: boolean };
    expect(caps.methods).toContain("session.prompt");
    expect(caps.transports).toEqual(["stdio"]);
    expect(caps.singleAttach).toBe(true);

    input.end();
    await run;
    await server.stop();
  });

  test("(b) session.create then session.prompt runs a mock turn and streams events + a reply with text/exit", async () => {
    const workspace = tempDir("hz-server-prompt-");
    const input = makeInput();
    const out = makeOutput();
    const server = createServer({ workspace, input: input.iterable, output: out.sink, mock: true });
    const run = server.start();

    input.push(JSON.stringify({ id: 1, method: "session.create" }));
    const created = resultOf(await out.waitFor(1));
    const sessionId = created.sessionId as string;
    expect(typeof sessionId).toBe("string");
    expect(server.sessionIds()).toContain(sessionId);

    input.push(JSON.stringify({ id: 2, method: "session.prompt", params: { sessionId, text: "hello there" } }));
    const promptResp = resultOf(await out.waitFor(2));
    expect(promptResp.sessionId).toBe(sessionId);
    // The mock provider answers with text; the reply carries it plus the exit.
    expect(typeof promptResp.text).toBe("string");
    expect(promptResp.aborted).toBe(false);
    expect(promptResp).toHaveProperty("exit");

    // THE revert check: the stream carried the turn's RuntimeEvents.
    const types = sessionEvents(out, sessionId);
    expect(types).toContain("assistant.done");
    expect(types).toContain("turn.done");
    expect(types.length).toBeGreaterThan(0);

    input.end();
    await run;
    await server.stop();
  });

  test("(c) session.subscribe streams events for the running turn", async () => {
    const workspace = tempDir("hz-server-subscribe-");
    const input = makeInput();
    const out = makeOutput();
    const server = createServer({ workspace, input: input.iterable, output: out.sink, mock: true });
    const run = server.start();

    input.push(JSON.stringify({ id: 1, method: "session.create" }));
    const sessionId = resultOf(await out.waitFor(1)).sessionId as string;

    input.push(JSON.stringify({ id: 2, method: "session.subscribe", params: { sessionId } }));
    const sub = resultOf(await out.waitFor(2));
    expect(sub.subscribed).toBe(true);
    expect(sub.sessionId).toBe(sessionId);

    input.push(JSON.stringify({ id: 3, method: "session.prompt", params: { sessionId, text: "stream this" } }));
    await out.waitFor(3);
    const types = sessionEvents(out, sessionId);
    expect(types).toContain("turn.done");

    input.end();
    await run;
    await server.stop();
  });

  test("(d) resume/attach: a second server opens the SAME workspace, lists the prior session and continues it", async () => {
    const workspace = tempDir("hz-server-resume-");

    // First server process: create a session and run a turn.
    let sessionId: string;
    {
      const input = makeInput();
      const out = makeOutput();
      const server = createServer({ workspace, input: input.iterable, output: out.sink, mock: true });
      const run = server.start();
      input.push(JSON.stringify({ id: 1, method: "session.create" }));
      sessionId = resultOf(await out.waitFor(1)).sessionId as string;
      input.push(JSON.stringify({ id: 2, method: "session.prompt", params: { sessionId, text: "first turn" } }));
      await out.waitFor(2);
      input.end();
      await run;
      await server.stop();
    }

    // Second server process emulation: same workspace, fresh server.
    const input = makeInput();
    const out = makeOutput();
    const server = createServer({ workspace, input: input.iterable, output: out.sink, mock: true });
    const run = server.start();

    input.push(JSON.stringify({ id: 1, method: "session.list" }));
    const list = resultOf(await out.waitFor(1));
    const sessions = list.sessions as Array<{ id: string; uri: string }>;
    expect(sessions.some((s) => s.id === sessionId)).toBe(true);
    expect(sessions.some((s) => s.uri === `hz://session/${sessionId}`)).toBe(true);

    // Resume the prior session (the most-recently-touched one) and continue it.
    input.push(JSON.stringify({ id: 2, method: "session.prompt", params: { sessionId, text: "second turn" } }));
    const promptResp = resultOf(await out.waitFor(2));
    expect(promptResp.sessionId).toBe(sessionId);

    // The transcript carried forward: both user turns are present.
    const store = new SessionStore(workspace);
    try {
      const history: ChatMsg[] = store.history(sessionId);
      const userTexts = history.filter((m) => m.role === "user").map((m) => m.content);
      expect(userTexts).toContain("first turn");
      expect(userTexts).toContain("second turn");
    } finally {
      store.close();
    }

    input.end();
    await run;
    await server.stop();
  });

  test("(e) crash-reconstruct: attaching an interrupted session repairs the transcript AND the admission row", async () => {
    // Seed the exact SIGKILL-mid-tool state crash-recovery.test.ts seeds.
    const workspace = tempDir("hz-server-crash-");
    const seed = new SessionStore(workspace);
    const dbPath = seed.dbPath;
    let sessionId: string;
    let admissionId: string;
    try {
      const session = seed.createSession("crashed");
      sessionId = session.id;
      seed.appendMessage(sessionId, { role: "user", content: "run a long command" });
      seed.appendMessage(sessionId, {
        role: "assistant",
        content: "",
        toolCalls: [{ id: "c1", name: "shell", arguments: "{}" }],
      });
      const queue = new AdmissionQueue(seed);
      admissionId = queue.admit(sessionId, "interrupted turn", "run-1");
      expect(queue.begin(admissionId)).toBe(true);
      expect(queue.list(sessionId)[0]?.state).toBe("running");
    } finally {
      seed.close();
    }

    // Start a server and attach/prompt the crashed session: createRuntime runs
    // BOTH recoveries on open (rollout reconstruction), before the next turn.
    const input = makeInput();
    const out = makeOutput();
    const server = createServer({ workspace, input: input.iterable, output: out.sink, mock: true });
    const run = server.start();

    input.push(JSON.stringify({ id: 1, method: "session.subscribe", params: { sessionId } }));
    const sub = resultOf(await out.waitFor(1));
    expect(sub.sessionId).toBe(sessionId);

    input.end();
    await run;
    await server.stop();

    // Read the bytes back through a SECOND connection.
    const rows = readMessages(dbPath, sessionId);
    const answer = rows.find((r) => r.role === "tool" && metaCallId(r.meta) === "c1");
    expect(answer).toBeDefined();
    expect(answer?.content.startsWith("UNKNOWN:")).toBe(true);
    expect(answer?.content).toContain("shell");

    const adm = readAdmissions(dbPath, sessionId);
    expect(adm.length).toBe(1);
    expect(adm[0]?.id).toBe(admissionId);
    expect(adm[0]?.state).toBe("unknown");
    expect(adm[0]?.evidence).toBe("interrupted");
  });

  test("(g) session.list on a FRESH empty workspace returns [] and creates NO session (read-only)", async () => {
    const workspace = tempDir("hz-server-list-empty-");
    const input = makeInput();
    const out = makeOutput();
    const server = createServer({ workspace, input: input.iterable, output: out.sink, mock: true });
    const run = server.start();

    input.push(JSON.stringify({ id: 1, method: "session.list" }));
    const list = resultOf(await out.waitFor(1));
    const sessions = list.sessions as Array<{ id: string }>;
    // The list is empty AND nothing was materialized as a side effect.
    expect(sessions).toEqual([]);
    expect(server.sessionIds()).toEqual([]);

    input.end();
    await run;
    await server.stop();

    // THE revert check (read the bytes back through a fresh connection): a
    // read-only list must leave the store with zero sessions and zero messages.
    // If handleList falls back to createRuntime/openRuntime (the reverted bug),
    // continueSession -> latestSession() -> createSession() materializes one
    // empty session and this fails.
    const store = new SessionStore(workspace);
    try {
      expect(store.listSessions().length).toBe(0);
    } finally {
      store.close();
    }
  });

  test("(h) resume-by-id: two sessions exist and the OLDER (not latest) one can be prompted by its id", async () => {
    const workspace = tempDir("hz-server-resume-by-id-");

    // First server process: create TWO sessions; run a turn on the first so it
    // has a transcript. The SECOND created session becomes the latest.
    let firstId: string;
    let secondId: string;
    {
      const input = makeInput();
      const out = makeOutput();
      const server = createServer({ workspace, input: input.iterable, output: out.sink, mock: true });
      const run = server.start();

      input.push(JSON.stringify({ id: 1, method: "session.create" }));
      firstId = resultOf(await out.waitFor(1)).sessionId as string;
      input.push(JSON.stringify({ id: 2, method: "session.prompt", params: { sessionId: firstId, text: "older turn" } }));
      await out.waitFor(2);

      input.push(JSON.stringify({ id: 3, method: "session.create" }));
      secondId = resultOf(await out.waitFor(3)).sessionId as string;
      input.push(JSON.stringify({ id: 4, method: "session.prompt", params: { sessionId: secondId, text: "newer turn" } }));
      await out.waitFor(4);

      input.end();
      await run;
      await server.stop();
    }
    expect(firstId).not.toBe(secondId);

    // A fresh server process over the SAME workspace. The latest session is the
    // SECOND one, so a resume-by-latest would open secondId. Prompt the OLDER
    // firstId by id and confirm we hit THAT session, not the latest.
    const input = makeInput();
    const out = makeOutput();
    const server = createServer({ workspace, input: input.iterable, output: out.sink, mock: true });
    const run = server.start();

    input.push(JSON.stringify({ id: 1, method: "session.prompt", params: { sessionId: firstId, text: "resumed older" } }));
    const resp = resultOf(await out.waitFor(1));
    // THE revert check: resume-by-id lands on the requested (older) session. If
    // runtimeFor reverted to continueSession (latest-only), it would either
    // refuse firstId with INVALID_PARAMS or retarget to secondId — both fail.
    expect(resp.sessionId).toBe(firstId);
    expect(server.sessionIds()).toContain(firstId);

    input.end();
    await run;
    await server.stop();

    // The OLDER session's transcript carried forward and gained the resumed
    // turn; the NEWER session's transcript was never touched by the resume.
    const store = new SessionStore(workspace);
    try {
      const older = store.history(firstId).filter((m) => m.role === "user").map((m) => m.content);
      expect(older).toContain("older turn");
      expect(older).toContain("resumed older");
      const newer = store.history(secondId).filter((m) => m.role === "user").map((m) => m.content);
      expect(newer).toContain("newer turn");
      expect(newer).not.toContain("resumed older");
    } finally {
      store.close();
    }
  });

  test("(f) an unknown method returns a JSON-RPC error, never silently ignored", async () => {
    const workspace = tempDir("hz-server-unknown-");
    const input = makeInput();
    const out = makeOutput();
    const server = createServer({ workspace, input: input.iterable, output: out.sink, mock: true });
    const run = server.start();

    input.push(JSON.stringify({ id: 1, method: "does.not.exist", params: {} }));
    const resp = await out.waitFor(1);
    expect("error" in resp).toBe(true);
    const err = (resp as { error: { code?: number; message: string } }).error;
    expect(err.code).toBe(-32601);
    expect(err.message).toContain("does.not.exist");

    input.end();
    await run;
    await server.stop();
  });
});
