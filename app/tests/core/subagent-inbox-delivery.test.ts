/**
 * subagent-inbox-delivery.test.ts — SubagentInbox integration into runNested delegation.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { KernelClient } from "../../src/core/kernel";
import { createMockProvider } from "../../src/core/providers";
import { SessionStore } from "../../src/core/session";
import { runNested } from "../../src/core/subagent";
import { SubagentInbox } from "../../src/core/subagent-inbox";
import { cleanupTemps, tempDir } from "./helpers";

afterAll(() => cleanupTemps());

describe("subagent inbox delivery wiring", () => {
  test("runNested posts task to child and result to parent in the shared inbox", async () => {
    const workspace = tempDir("hz-inbox-sub-");
    const kernel = new KernelClient({ workspace, stateDir: `${workspace}/.hzcode/kernel` });
    await kernel.start();
    const store = new SessionStore(workspace);
    const parent = store.createSession("parent-task");
    const inbox = new SubagentInbox();
    const controller = new AbortController();
    const task = "analyze architecture";

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
      inbox,
    });

    expect(result.ok).toBe(true);

    // Parent should receive the final text in the inbox
    const parentMessages = inbox.drain(parent.id);
    expect(parentMessages.length).toBeGreaterThan(0);
    expect(parentMessages[0].body).toBe(result.output);
    expect(parentMessages[0].id).toMatch(/^im-/);

    store.close();
  });
});
