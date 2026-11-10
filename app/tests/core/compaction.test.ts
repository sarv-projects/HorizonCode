/**
 * compaction.test.ts — the window boundary stops being silent.
 *
 * These are eval cases with a before and an after, not just coverage:
 *
 *  - BEFORE: `trimHistory` kept the newest 80 messages and dropped the rest.
 *    The turn that stated the task, and every constraint stated after it, fell
 *    out of the provider view with nothing in the transcript or the UI left to
 *    say so. A 200-turn session ran with no idea what it had been told first.
 *  - AFTER: `compactHistory` keeps the same window, but the task statement, the
 *    constraints stated in later turns and a labelled summary of what left the
 *    window ride with it — and the elision is reported (a notice for the human,
 *    a `session.compaction` event for the audit trail).
 *
 * The cases are here so that a regression is a failing test rather than a
 * customer's session quietly losing its constraints again.
 */

import { afterEach, describe, expect, test } from "bun:test";
import type { ChatMsg, Provider, ProviderEvent, ProviderRequest, RuntimeEvent } from "../../src/contracts";
import {
  COMPACTION_EVENT,
  PINNED_HEADING,
  MAX_SUMMARY_CHARS,
  MAX_SUMMARY_COMMANDS,
  SUMMARY_HEADING,
  classifyTool,
  compactHistory,
  looksLikeConstraint,
  maskSecrets,
  summariseElided,
} from "../../src/core/compaction";
import { KernelClient } from "../../src/core/kernel";
import type { LoopDeps } from "../../src/core/loop";
import { HISTORY_LIMIT, runTurn, streamFor, trimHistory } from "../../src/core/loop";
import { SessionStore } from "../../src/core/session";
import { cleanupTemps, tempDir } from "./helpers";

const TASK = "Task: add a --dry-run flag. Do not edit app/src/tools/*.ts.";
const LATER_CONSTRAINT = "From now on: never bypass the guard kernel for a write.";

function chat(role: ChatMsg["role"], content: string, extra: Partial<ChatMsg> = {}): ChatMsg {
  return { role, content, ...extra };
}

/** Filler turns: alternating assistant/user rows, `turns` of them. */
function filler(turns: number): ChatMsg[] {
  const out: ChatMsg[] = [];
  for (let i = 0; i < turns; i += 1) {
    out.push(chat("assistant", `step ${i}: working on it`));
    out.push(chat("user", `follow-up ${i}: keep going`));
  }
  return out;
}

/** Every tool row's call is answered by an assistant row that precedes it. */
function hasNoOrphanToolRow(messages: ChatMsg[]): boolean {
  const seen = new Set<string>();
  for (const message of messages) {
    if (message.role === "assistant") for (const call of message.toolCalls ?? []) seen.add(call.id);
    if (message.role === "tool" && !seen.has(message.toolCallId ?? "")) return false;
  }
  return true;
}

function joined(messages: ChatMsg[]): string {
  return messages.map((message) => message.content).join("\n");
}

afterEach(cleanupTemps);

/* ------------- eval case: turn-1 constraints under compaction ------------- */

describe("eval case: a turn-1 constraint in a 200-turn session", () => {
  const input: ChatMsg[] = [chat("user", TASK), ...filler(100), chat("user", LATER_CONSTRAINT), ...filler(99)];

  test("before: the silent slice drops the task statement and its constraints", () => {
    const sliced = trimHistory(input, HISTORY_LIMIT);
    // `trimHistory` keeps at most `limit`, and fewer when the oldest kept row is
    // not a user turn (the replay-validity shift it documents) — the defect is
    // not its length, it is that nothing says what left.
    expect(sliced.length).toBeLessThanOrEqual(HISTORY_LIMIT);
    expect(sliced[0]?.role).toBe("user");
    // The defect, asserted: the constraint is nowhere in what the provider sees.
    expect(joined(sliced)).not.toContain("Do not edit app/src/tools");
    expect(joined(sliced)).not.toContain("never bypass the guard kernel");
  });

  test("after: the view carries the task statement and the constraints", () => {
    const result = compactHistory(input, { limit: HISTORY_LIMIT });
    expect(result.compacted).toBe(true);
    expect(result.history.length).toBeLessThanOrEqual(HISTORY_LIMIT);
    expect(result.history[0]?.role).toBe("user");
    expect(result.dropped).toBe(input.length - result.history.length);

    const view = joined(result.history);
    expect(view).toContain(PINNED_HEADING);
    expect(view).toContain(SUMMARY_HEADING);
    expect(view).toContain("Do not edit app/src/tools");
    expect(view).toContain("never bypass the guard kernel");
    expect(result.history[0]?.content.startsWith(PINNED_HEADING)).toBe(true);

    // The report: a dropped count the caller can show, and role accounting.
    expect(result.notice.startsWith("compaction: ")).toBe(true);
    expect(result.notice).toContain(`${result.dropped} of ${input.length}`);
    expect(result.droppedByRole.user).toBeGreaterThan(0);
    expect(result.elidedTokens).toBeGreaterThan(0);
    // The window still begins at a user turn, so the replay stays valid.
    expect(hasNoOrphanToolRow(result.history)).toBe(true);
  });

  test("the store is not rewritten: the input rows are untouched", () => {
    const first = input[0] as ChatMsg;
    const before = first.content;
    const result = compactHistory(input, { limit: HISTORY_LIMIT });
    expect(input[0]?.content).toBe(before);
    expect(joined(input)).toContain("Do not edit app/src/tools");
    // The merged message is a copy; the original row is not in the view anymore.
    expect(result.history).not.toContain(first);
  });
});

/* --------------- eval case: resume after a mid-turn kill --------------- */

describe("eval case: a window built after a mid-turn kill", () => {
  /** An assistant turn with two calls where only the first has a result row. */
  const killed: ChatMsg[] = [
    chat("user", TASK),
    ...filler(45),
    chat("user", "go on"),
    chat("assistant", "", {
      toolCalls: [
        { id: "c1", name: "read", arguments: JSON.stringify({ path: "a.ts" }) },
        { id: "c2", name: "edit", arguments: JSON.stringify({ path: "b.ts", old: "x", new: "y" }) },
      ],
    }),
    chat("tool", "file a.ts: 12 lines", { toolCallId: "c1", toolName: "read" }),
  ];

  test("the unanswered call stays in the window and no orphan tool row appears", () => {
    const result = compactHistory(killed, { limit: HISTORY_LIMIT });
    expect(result.compacted).toBe(true);
    const calls = result.history.flatMap((message) => message.toolCalls ?? []).map((call) => call.id);
    expect(calls).toContain("c1");
    expect(calls).toContain("c2");
    expect(result.history.some((message) => message.toolCallId === "c1")).toBe(true);
    expect(result.history[0]?.role).toBe("user");
    expect(hasNoOrphanToolRow(result.history)).toBe(true);
  });

  test("the constraint is re-derived from the rows, and two derivations agree", () => {
    // A restart is a fresh derivation from the same store contents: clone the
    // rows the way a second process would read them (plain values, no sharing).
    const fromDisk = JSON.parse(JSON.stringify(killed)) as ChatMsg[];
    const first = compactHistory(killed, { limit: HISTORY_LIMIT });
    const second = compactHistory(fromDisk, { limit: HISTORY_LIMIT });
    expect(second.history[0]?.content).toBe(first.history[0]?.content);
    expect(joined(second.history)).toContain("Do not edit app/src/tools");
    expect(second.pinned?.taskStatement).toBe(first.pinned?.taskStatement ?? null);
  });
});

/* --------------------- eval case: idempotence --------------------- */

describe("eval case: compacting a compacted view", () => {
  const input: ChatMsg[] = [chat("user", TASK), ...filler(120)];

  test("under the limit: identity, same reference, no marker", () => {
    const short = [chat("user", TASK), ...filler(10)];
    const result = compactHistory(short, { limit: HISTORY_LIMIT });
    expect(result.compacted).toBe(false);
    expect(result.history).toBe(short);
    expect(result.notice).toBe("");
    expect(joined(result.history)).not.toContain(PINNED_HEADING);
  });

  test("an already-compacted view is a no-op and no marker nests", () => {
    const once = compactHistory(input, { limit: HISTORY_LIMIT });
    const twice = compactHistory(once.history, { limit: HISTORY_LIMIT });
    expect(twice.compacted).toBe(false);
    expect(twice.history).toBe(once.history);
    const markerCount = twice.history.filter((message) => message.content.includes(PINNED_HEADING)).length;
    expect(markerCount).toBe(1);
  });
});

/* ------------------ the constraint rule itself ------------------ */

describe("the constraint detector", () => {
  test("keeps standing instructions and skips remarks, questions and code", () => {
    expect(looksLikeConstraint("You must never rewrite the transcript.")).toBe(true);
    expect(looksLikeConstraint("Don’t touch app/src/tools/*.ts")).toBe(true);
    expect(looksLikeConstraint("Required: evidence for every feature.")).toBe(true);
    expect(looksLikeConstraint("Can you make the flag optional?")).toBe(false);
    expect(looksLikeConstraint("ok")).toBe(false);
    expect(looksLikeConstraint("the build took 4 seconds")).toBe(false);
  });
});

/* ------------- structured summary of the elided tool calls (T-7) ------------- */

let callSeq = 0;
/** One assistant row carrying a tool call plus its tool result row. */
function toolTurn(name: string, args: Record<string, unknown>, result = "ok"): ChatMsg[] {
  callSeq += 1;
  const id = `c${callSeq}`;
  return [
    chat("assistant", "", { toolCalls: [{ id, name, arguments: JSON.stringify(args) }] }),
    chat("tool", result, { toolCallId: id, toolName: name }),
  ];
}

describe("the structured compaction summary", () => {
  const elided: ChatMsg[] = [
    chat("user", TASK),
    ...toolTurn("read", { path: "src/a.ts" }),
    ...toolTurn("read", { path: "src/b.ts" }),
    ...toolTurn("edit", { path: "src/a.ts", old: "x", new: "y" }),
    ...toolTurn("grep", { pattern: "dryRun", path: "src", glob: "*.ts" }),
    ...toolTurn("shell", { command: "bun test tests/a.test.ts" }),
    ...toolTurn("apply_patch", { input: "*** Begin Patch\n*** Add File: src/c.ts\n+hi\n*** Delete File: src/old.ts\n*** End Patch" }),
    ...toolTurn("todo", { action: "add", text: "wire the flag" }),
    ...toolTurn("todo", { action: "add", text: "write tests" }),
    ...toolTurn("todo", { action: "done", text: "t1" }),
    ...toolTurn("shell_session", { mode: "write", input: "secret\n" }),
    ...toolTurn("shell", { command: "bun run typecheck" }),
  ];
  const summary = summariseElided(elided, elided.length + 10, 10);

  test("each file carries its LAST op, in order of last touch", () => {
    expect(summary).toContain("- files touched (last op, oldest first): src/b.ts (read), src/a.ts (edit), src/c.ts (write), src/old.ts (delete)");
  });

  test("commands are listed oldest first; stdin writes to a shell session are not commands", () => {
    const at = summary.indexOf("- commands run (oldest first):");
    expect(at).toBeGreaterThan(-1);
    expect(summary.slice(at)).toContain("  - `bun test tests/a.test.ts`\n  - `bun run typecheck`\n");
    expect(summary).not.toContain("secret");
  });

  test("searches and todo changes are named", () => {
    expect(summary).toContain('- searches: grep "dryRun" in src (*.ts)');
    expect(summary).toContain('- todo changes: added 2: "wire the flag", "write tests"; done 1: "t1"');
  });

  test("the pinned contract lines survive: heading first, view-not-deletion last", () => {
    expect(summary.startsWith(SUMMARY_HEADING)).toBe(true);
    expect(summary.endsWith("this block is a view, not a deletion.")).toBe(true);
  });

  test("deterministic: the same input yields the identical string", () => {
    expect(summariseElided(elided, elided.length + 10, 10)).toBe(summary);
  });

  test("empty sections are omitted", () => {
    const plain = summariseElided([chat("user", "hello there"), chat("assistant", "hi")], 12, 10);
    for (const section of ["files touched", "commands run", "searches:", "todo changes", "tools called"]) {
      expect(plain).not.toContain(section);
    }
  });

  test("commands keep the newest N and count the rest", () => {
    const many: ChatMsg[] = [];
    for (let i = 0; i < MAX_SUMMARY_COMMANDS + 3; i += 1) many.push(...toolTurn("shell", { command: `echo ${i}` }));
    const text = summariseElided(many, many.length, 1);
    expect(text).toContain("- commands run (oldest first, 3 earlier omitted):");
    expect(text).not.toContain("`echo 2`");
    expect(text).toContain("`echo 3`");
    expect(text).toContain(`\`echo ${MAX_SUMMARY_COMMANDS + 2}\``);
  });

  test("the whole block is bounded by MAX_SUMMARY_CHARS and says when it was cut", () => {
    const huge: ChatMsg[] = [];
    for (let i = 0; i < 200; i += 1) {
      const long = `${"segment".repeat(20)}/${i}`;
      huge.push(...toolTurn("write", { path: `${long}/file-${i}.ts`, content: "x" }));
      huge.push(...toolTurn("shell", { command: `${"x".repeat(300)} ${i}` }));
      huge.push(...toolTurn("grep", { pattern: `${"p".repeat(300)}${i}`, path: long }));
      huge.push(...toolTurn("todo", { action: "add", text: "t".repeat(200) }));
    }
    const text = summariseElided(huge, huge.length, 1);
    expect(text.length).toBeLessThanOrEqual(MAX_SUMMARY_CHARS);
    expect(text).toContain(`omitted at the ${MAX_SUMMARY_CHARS}-char cap`);
    expect(text.endsWith("this block is a view, not a deletion.")).toBe(true);
  });

  test("classifyTool maps the builtin tool names", () => {
    expect(classifyTool("read")).toBe("read");
    expect(classifyTool("ast_edit")).toBe("edit");
    expect(classifyTool("apply_patch")).toBe("patch");
    expect(classifyTool("ast_search")).toBe("search");
    expect(classifyTool("shell_session")).toBe("shell");
    expect(classifyTool("todo")).toBe("todo");
    expect(classifyTool("lsp")).toBe("other");
  });
});

/* ----------------- eval case: the live turn (integration) ----------------- */

interface Harness {
  deps: LoopDeps;
  kernel: KernelClient;
  store: SessionStore;
  events: RuntimeEvent[];
  requests: ProviderRequest[];
}

function harness(workspace: string, sessionId: string): Harness {
  const kernel = new KernelClient({ workspace });
  const store = new SessionStore(workspace);
  const events: RuntimeEvent[] = [];
  const requests: ProviderRequest[] = [];
  const provider: Provider = {
    name: "capture",
    async *stream(req): AsyncIterable<ProviderEvent> {
      requests.push(req);
      yield { type: "text", text: "carried on" };
      yield { type: "done", stopReason: "end" };
    },
  };
  const deps: LoopDeps = {
    workspace,
    sessionId,
    model: "capture-1",
    provider,
    kernel,
    store,
    signal: new AbortController().signal,
    callbacks: { onEvent: (ev) => events.push(ev) },
    sessionLeases: [],
    approve: async () => true,
    budget: { maxSteps: 5 },
  };
  return { deps, kernel, store, events, requests };
}

describe("eval case: a live turn over a 92-message transcript", () => {
  test("the request is compacted, reported once, logged once, and the chain verifies", async () => {
    const workspace = tempDir("hz-compaction-");
    const store0 = new SessionStore(workspace);
    const sessionId = store0.createSession("compaction-eval").id;
    store0.appendMessage(sessionId, { role: "user", content: TASK });
    for (let i = 0; i < 45; i += 1) {
      store0.appendMessage(sessionId, { role: "assistant", content: `step ${i}: working` });
      store0.appendMessage(sessionId, { role: "user", content: `follow-up ${i}: keep going` });
    }
    const storedRows = store0.history(sessionId);
    expect(storedRows.length).toBe(91);
    store0.close();

    const h = harness(workspace, sessionId);
    try {
      const result = await runTurn(h.deps, "one more step");
      expect(result.exit.terminal).toBe("succeeded");
      expect(result.text).toBe("carried on");

      // What the provider actually received.
      const request = h.requests[0] as ProviderRequest;
      expect(request.messages.length).toBeLessThanOrEqual(HISTORY_LIMIT);
      expect(request.messages[0]?.role).toBe("user");
      const viewText = joined(request.messages);
      expect(viewText).toContain(PINNED_HEADING);
      expect(viewText).toContain(SUMMARY_HEADING);
      expect(viewText).toContain("Do not edit app/src/tools");
      // The task row itself is outside the window; the text survives in the pin.
      expect(request.messages[0]?.content.startsWith(PINNED_HEADING)).toBe(true);
      // The system rail still carries its own bounded pin — both mechanisms are
      // present, and neither required a contracts.ts change.
      expect(request.system).toContain("Pinned task statement");
      // Split contract (compaction owns the rest, the rail owns the verbatim
      // statement): the statement block no longer renders here, and the rail
      // carries the text exactly once. It may still appear as a constraint
      // bullet and as the elision summary's quoted "first elided request" —
      // those are different mechanisms, both intended.
      expect(viewText).not.toContain("Original task statement (first user message, verbatim):");
      expect(request.system?.split(TASK) ?? []).toHaveLength(2);

      // The human is told once, with a count.
      const notices = h.events
        .filter((ev): ev is { type: "notice"; message: string } => ev.type === "notice")
        .map((ev) => ev.message)
        .filter((message) => message.startsWith("compaction: "));
      expect(notices).toHaveLength(1);
      const expectedDropped = 92 - request.messages.length;
      expect(notices[0]).toContain(`${expectedDropped} of 92`);

      // The audit trail holds the same report, and still verifies.
      const logged = await h.kernel.readEvents(streamFor(sessionId));
      const compactions = logged.filter((event) => event.type === COMPACTION_EVENT);
      expect(compactions).toHaveLength(1);
      const payload = (compactions[0]?.payload ?? {}) as Record<string, unknown>;
      expect(payload.dropped).toBe(expectedDropped);
      expect(payload.kept).toBe(request.messages.length);
      expect(payload.window).toBe(HISTORY_LIMIT);
      expect(payload.taskStatementPinned).toBe(true);
      expect(payload.pinnedConstraints).toBeGreaterThanOrEqual(0);
      const chain = await h.kernel.verifyEventChain(streamFor(sessionId));
      expect(chain.ok).toBe(true);

      // The store is a view source, not a target: the original rows are intact,
      // including the task row the window no longer holds.
      const after = h.store.history(sessionId);
      expect(after[0]?.content).toBe(TASK);
      expect(after.map((message) => message.content).join("\n")).not.toContain(PINNED_HEADING);
      expect(after.length).toBe(93);
    } finally {
      await h.kernel.close();
      h.store.close();
    }
  });
});

test("maskSecrets hides tokens in command lines", () => {
  const out = maskSecrets("curl -H 'Authorization: Bearer abcdef123456' x --token=hunter2 password=p4ss sk-abcdefghij12345");
  expect(out).not.toContain("abcdef123456");
  expect(out).not.toContain("hunter2");
  expect(out).not.toContain("p4ss");
  expect(out).not.toContain("abcdefghij12345");
  expect(out).toContain("curl");
});
