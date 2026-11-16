/**
 * audit-redaction.test.ts — the durable event log stores masked summaries, not
 * a second copy of the prompt/tool args/tool output (audit remediation wave).
 *
 * A secret pasted into a prompt or read from a file must not survive in
 * `.hz/state/kernel/events/*.jsonl` (the model can read/grep that tree):
 *
 *   - `message.end` (user) carries `inputDigest` + `inputBytes` + a short
 *     masked `preview`, never the raw `text`;
 *   - `tool.call` carries `argsDigest` + `argsBytes` and masked args (path kept);
 *   - `tool.result` carries `resultDigest` + `outputBytes` + a masked
 *     `output` preview, never the 4000-char raw body.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import type { Provider, ProviderEvent, RuntimeEvent } from "../../src/contracts";
import { EventTypes } from "../../src/contracts";
import { KernelClient } from "../../src/core/kernel";
import { redactEventPayload, runTurn, type LoopDeps } from "../../src/core/loop";
import { sessionEventsPath } from "../../src/core/session-kernel-reconcile";
import { SessionStore } from "../../src/core/session";

const SECRET = "sk-live-SENTINEL0123456789";
const PROMPT_SECRET = "PROMPT-SENTINEL-PASSWORD-123";

const workspaces: string[] = [];
afterEach(() => {
  while (workspaces.length > 0) rmSync(workspaces.pop()!, { recursive: true, force: true });
});

function scratch(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "hz-audit-redaction-"));
  workspaces.push(dir);
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

async function runReadTurn(workspace: string, prompt: string): Promise<{
  sessionId: string;
  events: RuntimeEvent[];
  kernel: KernelClient;
  store: SessionStore;
}> {
  const kernel = new KernelClient({ workspace });
  const store = new SessionStore(workspace);
  const events: RuntimeEvent[] = [];
  const deps: LoopDeps = {
    workspace,
    sessionId: store.createSession("audit-redaction").id,
    model: "scripted-1",
    provider: scriptedProvider([
      [
        { type: "tool_call", id: "call_1", name: "read", arguments: JSON.stringify({ path: "secret.txt" }) },
        { type: "done", stopReason: "tool_use" },
      ],
      [{ type: "text", text: "done" }, { type: "done", stopReason: "end" }],
    ]),
    kernel,
    store,
    signal: new AbortController().signal,
    callbacks: { onEvent: (ev) => events.push(ev) },
    sessionLeases: [],
    approve: async () => true,
    budget: { maxSteps: 5 },
  };
  await runTurn(deps, prompt);
  return { sessionId: deps.sessionId, events, kernel, store };
}

describe("durable events are redacted summaries", () => {
  test("no sentinel secret reaches the event log; payload shapes carry digests and previews", async () => {
    const workspace = scratch();
    // >500 chars so the result preview must be capped, not copied.
    writeFileSync(
      path.join(workspace, "secret.txt"),
      `API_TOKEN=${SECRET}\n` + "ordinary line of file content\n".repeat(40),
    );
    const prompt = `please inspect password=${PROMPT_SECRET}`;
    const { sessionId, events, kernel, store } = await runReadTurn(workspace, prompt);
    try {
      const onDisk = readFileSync(sessionEventsPath(workspace, sessionId), "utf8");
      expect(onDisk).not.toContain(SECRET);
      expect(onDisk).not.toContain(PROMPT_SECRET);

      const logged = await kernel.readEvents(`session:${sessionId}`);
      const userEnd = logged.find(
        (event) => event.type === EventTypes.messageEnd && (event.payload as { role?: string }).role === "user",
      );
      expect(userEnd).toBeDefined();
      const userPayload = userEnd?.payload as Record<string, unknown>;
      expect(userPayload.text).toBeUndefined();
      expect(typeof userPayload.inputDigest).toBe("string");
      expect(userPayload.inputDigest).toHaveLength(64);
      expect(userPayload.inputBytes).toBe(Buffer.byteLength(prompt, "utf8"));
      expect(typeof userPayload.preview).toBe("string");
      expect(String(userPayload.preview).length).toBeLessThanOrEqual(201);
      expect(userPayload.inputPreview).toBe(userPayload.preview);
      expect(String(userPayload.preview)).not.toContain(PROMPT_SECRET);

      const toolCall = logged.find((event) => event.type === EventTypes.toolCall);
      expect(toolCall).toBeDefined();
      const callPayload = toolCall?.payload as Record<string, unknown>;
      expect(callPayload.args).toEqual({ path: "secret.txt" });
      expect(typeof callPayload.argsDigest).toBe("string");
      expect(callPayload.argsDigest).toHaveLength(64);
      expect(callPayload.argsBytes).toBeGreaterThan(0);

      const toolResult = logged.find((event) => event.type === EventTypes.toolResult);
      expect(toolResult).toBeDefined();
      const resultPayload = toolResult?.payload as Record<string, unknown>;
      expect(typeof resultPayload.resultDigest).toBe("string");
      expect(resultPayload.resultDigest).toHaveLength(64);
      expect(resultPayload.outputBytes).toBeGreaterThan(500);
      expect(typeof resultPayload.output).toBe("string");
      expect(String(resultPayload.output).length).toBeLessThanOrEqual(501);
      expect(String(resultPayload.output)).not.toContain(SECRET);
    } finally {
      await kernel.close();
      store.close();
    }
  }, 30000);

  test("redactEventPayload masks sensitive keys and applies the 64KB fallback", () => {
    const small = redactEventPayload({
      nested: { api_key: "plain-value", note: "token=visible-secret-value" },
    }) as Record<string, { api_key?: string; note?: string }>;
    expect(small.nested?.api_key).toBe("***");
    expect(small.nested?.note).not.toContain("visible-secret-value");

    const huge: Record<string, string> = {};
    for (let i = 0; i < 120; i += 1) huge[`k${i}`] = "x".repeat(2000);
    const capped = redactEventPayload(huge) as Record<string, unknown>;
    expect(capped.eventPayloadTruncated).toBe(true);
    expect(capped.eventPayloadDigest).toHaveLength(64);
    expect(Number(capped.eventPayloadBytes)).toBeGreaterThan(64 * 1024);
    expect(String(capped.preview).length).toBeLessThanOrEqual(501);
  });
});
