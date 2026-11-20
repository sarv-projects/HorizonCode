/**
 * I-4 (ruling 506 residual) — the richer local analytics names are EMITTED
 * from the real call sites, file-only, with the strict allowlist preserved.
 *
 * Proves:
 *   - `provider.usage` is appended on a provider turn with only scalar fields;
 *   - `guard.decision` is appended on an approval with a closed terminal token;
 *   - no content/tool-name/path/secret field enters the NDJSON row.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import type { Provider, ProviderEvent } from "../../src/contracts";
import { appendAnalyticsEvent } from "../../src/core/analytics-log";
import { KernelClient } from "../../src/core/kernel";
import { runTurn, type LoopDeps } from "../../src/core/loop";
import { SessionStore } from "../../src/core/session";

let workspace = "";
let logPath = "";
let prevEnv: string | undefined;

beforeEach(() => {
  workspace = mkdtempSync(path.join(tmpdir(), "hz-i4-emit-"));
  logPath = path.join(workspace, "analytics.ndjson");
  prevEnv = process.env.HZ_ANALYTICS_LOG;
  process.env.HZ_ANALYTICS_LOG = logPath;
  process.env.HZ_JSONL_FSYNC = "0";
});

afterEach(() => {
  if (prevEnv === undefined) delete process.env.HZ_ANALYTICS_LOG;
  else process.env.HZ_ANALYTICS_LOG = prevEnv;
  rmSync(workspace, { recursive: true, force: true });
});

function rows(): Array<Record<string, unknown>> {
  try {
    return readFileSync(logPath, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

function provider(): Provider {
  let phase = 0;
  return {
    name: "scripted",
    async *stream(): AsyncGenerator<ProviderEvent> {
      phase += 1;
      if (phase === 1) {
        yield { type: "text", text: "hello from the provider" } satisfies ProviderEvent;
        yield { type: "done", stopReason: "end", usage: { inputTokens: 100, outputTokens: 20 } } satisfies ProviderEvent;
        return;
      }
      yield { type: "done", stopReason: "end" } satisfies ProviderEvent;
    },
  };
}

function deps(approve: () => Promise<boolean>): LoopDeps {
  const stateDir = path.join(workspace, ".hzcode", "kernel");
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(
    path.join(stateDir, "policy.json"),
    JSON.stringify([{ kind: "fs.write", scope: "workspace", decision: "ask" }]),
  );
  const store = new SessionStore(workspace);
  return {
    workspace,
    sessionId: store.createSession("i4-emit").id,
    model: "scripted-1",
    provider: provider(),
    kernel: new KernelClient({ workspace, stateDir }),
    store,
    signal: new AbortController().signal,
    callbacks: { onEvent: () => undefined },
    sessionLeases: [],
    approve,
  };
}

describe("I-4 richer analytics emitted from call sites", () => {
  test("provider.usage is emitted with scalar fields only and no content", async () => {
    await runTurn(deps(async () => true));
    const usage = rows().filter((r) => r.event === "provider.usage");
    expect(usage.length).toBeGreaterThanOrEqual(1);
    const row = usage[0]!;
    expect(row.v).toBe(1);
    expect(row.sessionId).toBeTypeOf("string");
    expect(row.provider).toBe("scripted");
    expect(row.model).toBe("scripted-1");
    expect(typeof row.stepCount).toBe("number");
    const serialized = JSON.stringify(row);
    for (const forbidden of ["hello from the provider", "apiKey", "content", "task", "path", "argv", "message"]) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  test("guard.decision is emitted on an approval with a closed terminal token", async () => {
    const target = path.join(workspace, "out.txt");
    let phase = 0;
    const writeProvider: Provider = {
      name: "scripted",
      async *stream(): AsyncGenerator<ProviderEvent> {
        phase += 1;
        if (phase === 1) {
          yield {
            type: "tool_call",
            id: "call_i4",
            name: "write",
            arguments: JSON.stringify({ path: target, content: "secret-body" }),
          } satisfies ProviderEvent;
          yield { type: "done", stopReason: "tool_use" } satisfies ProviderEvent;
          return;
        }
        yield { type: "done", stopReason: "end" } satisfies ProviderEvent;
      },
    };
    const base = deps(async () => true);
    await runTurn({ ...base, provider: writeProvider });
    const decisions = rows().filter((r) => r.event === "guard.decision");
    expect(decisions.length).toBeGreaterThanOrEqual(1);
    const row = decisions[0]!;
    expect(["approved", "declined"]).toContain(row.terminal);
    const serialized = JSON.stringify(row);
    for (const forbidden of ["secret-body", target, "out.txt", "apiKey", "content", "path"]) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  test("the allowlist drops non-catalogue fields even when a caller supplies them", async () => {
    // Direct seam test: a caller trying to smuggle content/keys is silently
    // truncated to allowlisted scalar fields.
    await appendAnalyticsEvent({
      workspace,
      event: "config.invalid",
      sessionId: "s1",
      errorCode: "rejected",
      // @ts-expect-error - deliberately out of the allowlist
      content: "attack",
      // @ts-expect-error - deliberately out of the allowlist
      apiKey: "sk-secret",
    } as never);
    const row = rows().find((r) => r.event === "config.invalid");
    expect(row).toBeDefined();
    expect(row).toMatchObject({ event: "config.invalid", sessionId: "s1", errorCode: "rejected" });
    expect(row).not.toHaveProperty("content");
    expect(row).not.toHaveProperty("apiKey");
    expect(JSON.stringify(row)).not.toContain("sk-secret");
  });
});
