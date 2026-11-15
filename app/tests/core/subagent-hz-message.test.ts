/**
 * subagent-hz-message.test.ts — Wave 0 RC-18: parent stream hz.agent.message.sent
 * on delegation (instruction + result digests; ruling 413).
 */

import { afterAll, describe, expect, test } from "bun:test";
import { EventTypes } from "../../src/contracts";
import { sha256Hex } from "../../src/core/canon";
import { KernelClient } from "../../src/core/kernel";
import { streamFor } from "../../src/core/loop";
import { createMockProvider } from "../../src/core/providers";
import { SessionStore } from "../../src/core/session";
import { runNested } from "../../src/core/subagent";
import { cleanupTemps, tempDir } from "./helpers";

afterAll(() => cleanupTemps());

describe("hz.agent.message.sent on parent stream", () => {
  test("runNested appends instruction and result digests when parentSessionId is set", async () => {
    const workspace = tempDir("hz-msg-");
    const kernel = new KernelClient({ workspace, stateDir: `${workspace}/.hzcode/kernel` });
    await kernel.start();
    const store = new SessionStore(workspace);
    const parent = store.createSession("parent");
    const controller = new AbortController();
    const task = "list relevant files";
    try {
      const result = await runNested({
        workspace,
        task,
        parentSessionId: parent.id,
        model: "mock-1",
        provider: createMockProvider(),
        kernel,
        store,
        signal: controller.signal,
        sessionLeases: [],
      });
      expect(result.ok).toBe(true);
      const parentStream = streamFor(parent.id);
      const events = await kernel.readEvents(parentStream);
      const kinds = events.filter((e) => e.type === EventTypes.agentMessageSent);
      expect(kinds).toHaveLength(2);
      const instruction = kinds[0]?.payload as Record<string, unknown>;
      const answer = kinds[1]?.payload as Record<string, unknown>;
      expect(instruction.kind).toBe("instruction");
      expect(instruction.payloadDigest).toBe(sha256Hex(task));
      expect(instruction.delivery).toBe("queue");
      expect(answer.kind).toBe("result");
      expect(answer.fromAgentId).toBe(instruction.toAgentId);
      expect(answer.toAgentId).toBe(parent.id);
      expect(answer.payloadDigest).toBe(sha256Hex(String(result.output).trim()));
      expect(answer.status).toBe("succeeded");
    } finally {
      await kernel.close();
      store.close();
    }
  }, 30000);
});