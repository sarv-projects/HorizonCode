/** Wave 0 RC-18 literal `hz.policy.revision.changed` (ruling 447). */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import type { Provider, ProviderEvent } from "../../src/contracts";
import { EventTypes } from "../../src/contracts";
import { KernelClient } from "../../src/core/kernel";
import { runTurn, streamFor, type LoopDeps } from "../../src/core/loop";
import { SessionStore } from "../../src/core/session";

let workspace = "";

beforeEach(() => {
  workspace = mkdtempSync(path.join(tmpdir(), "hz-policy-rev-"));
});

afterEach(() => {
  rmSync(workspace, { recursive: true, force: true });
});

describe("hz.policy.revision.changed", () => {
  test("mid-session policy.json edit emits revision.changed on next guard check (447)", async () => {
    const stateDir = path.join(workspace, ".hzcode", "kernel");
    mkdirSync(stateDir, { recursive: true });
    const policyPath = path.join(stateDir, "policy.json");
    writeFileSync(
      policyPath,
      JSON.stringify([{ kind: "fs.write", scope: "workspace", decision: "ask" }]),
    );
    let phase = 0;
    const provider: Provider = {
      name: "scripted",
      async *stream() {
        phase += 1;
        if (phase === 1 || phase === 3) {
          const n = phase === 1 ? 1 : 2;
          yield {
            type: "tool_call",
            id: `call_${n}`,
            name: "write",
            arguments: JSON.stringify({ path: `out${n}.txt`, content: "hi" }),
          } satisfies ProviderEvent;
          yield { type: "done", stopReason: "tool_use" } satisfies ProviderEvent;
          return;
        }
        yield { type: "done", stopReason: "end" } satisfies ProviderEvent;
      },
    };
    const kernel = new KernelClient({ workspace, stateDir });
    const store = new SessionStore(workspace);
    const sessionId = store.createSession("policy-rev").id;
    const deps: LoopDeps = {
      workspace,
      sessionId,
      model: "scripted-1",
      provider,
      kernel,
      store,
      signal: new AbortController().signal,
      callbacks: { onEvent: () => undefined },
      sessionLeases: [],
      approve: async () => true,
    };
    try {
      process.env.HZ_ACTION_STATIONARITY = "0";
      await runTurn(deps, "first write");
      const before = (await kernel.readEvents(streamFor(sessionId))).filter(
        (e) => e.type === EventTypes.policyRevisionChanged,
      );
      expect(before).toHaveLength(0);

      writeFileSync(
        policyPath,
        JSON.stringify([
          { kind: "fs.write", scope: "workspace", decision: "ask" },
          { kind: "fs.read", scope: "workspace", decision: "allow" },
        ]),
      );
      await runTurn(deps, "second write after policy edit");
      const after = (await kernel.readEvents(streamFor(sessionId))).filter(
        (e) => e.type === EventTypes.policyRevisionChanged,
      );
      expect(after.length).toBeGreaterThanOrEqual(1);
      const payload = after[0]!.payload as {
        previousRevision?: string;
        newRevision?: string;
        digest?: string;
        source?: string;
        scope?: string;
      };
      expect(payload.source).toBe("file");
      expect(payload.scope).toBe("workspace");
      expect(typeof payload.previousRevision).toBe("string");
      expect(typeof payload.newRevision).toBe("string");
      expect(payload.previousRevision).not.toBe(payload.newRevision);
      expect(payload.digest).toBe(payload.newRevision);
    } finally {
      delete process.env.HZ_ACTION_STATIONARITY;
      await kernel.close();
      store.close();
    }
  });
});
