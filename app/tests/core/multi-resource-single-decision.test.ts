/** §8 #6 — one human decision for multi-resource ask (ruling 577). */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import type { ApprovalRequest, GuardAction, Lease, Provider, ProviderEvent } from "../../src/contracts";
import { EventTypes } from "../../src/contracts";
import { runTurn, streamFor, type LoopDeps } from "../../src/core/loop";
import { KernelClient } from "../../src/core/kernel";
import { SessionStore } from "../../src/core/session";
import { humanApprovalOwner } from "../../src/core/human-approval-principal";

let workspace = "";

beforeEach(() => {
  workspace = mkdtempSync(path.join(tmpdir(), "hz-multi-ask-"));
});

afterEach(() => {
  rmSync(workspace, { recursive: true, force: true });
});

describe("multi-resource single decision (ruling 577)", () => {
  test("apply_patch ask prompts once with resources and applies one yes to all paths", async () => {
    const prevBin = process.env.HZ_KERNEL_BIN;
    process.env.HZ_KERNEL_BIN = path.join(workspace, "no-such-hz-kernel");
    try {
      const stateDir = path.join(workspace, ".hzcode", "kernel");
      mkdirSync(stateDir, { recursive: true });
      writeFileSync(
        path.join(stateDir, "policy.json"),
        JSON.stringify([{ kind: "fs.write", scope: "workspace", decision: "ask" }]),
        "utf8",
      );
      writeFileSync(path.join(workspace, "a.ts"), "old-a\n", "utf8");
      writeFileSync(path.join(workspace, "b.ts"), "old-b\n", "utf8");
      const patch = [
        "*** Begin Patch",
        "*** Update File: a.ts",
        "@@",
        "-old-a",
        "+new-a",
        "*** Update File: b.ts",
        "@@",
        "-old-b",
        "+new-b",
        "*** End Patch",
      ].join("\n");
      let turn = 0;
      const provider: Provider = {
        name: "scripted",
        async *stream() {
          turn += 1;
          if (turn === 1) {
            yield {
              type: "tool_call",
              id: "call_1",
              name: "apply_patch",
              arguments: JSON.stringify({ input: patch }),
            } satisfies ProviderEvent;
            yield { type: "done", stopReason: "tool_use" } satisfies ProviderEvent;
            return;
          }
          yield { type: "done", stopReason: "end" } satisfies ProviderEvent;
        },
      };
      const approveCalls: Array<{ resources?: string[]; target?: string }> = [];
      const kernel = new KernelClient({ workspace, stateDir });
      await kernel.start();
      const store = new SessionStore(workspace);
      const sessionId = store.createSession("multi-ask").id;
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
        approve: async (req: ApprovalRequest, action?: GuardAction) => {
          approveCalls.push({ resources: req.resources, target: action?.target });
          return true;
        },
      };
      try {
        process.env.HZ_ACTION_STATIONARITY = "0";
        const sessionLeases: Lease[] = [];
        deps.sessionLeases = sessionLeases;
        const leaseSpy = deps.kernel.makeLease.bind(deps.kernel);
        let mintCount = 0;
        deps.kernel.makeLease = async (...args) => {
          mintCount += 1;
          return leaseSpy(...args);
        };
        await runTurn(deps, "patch two files");
        expect(approveCalls).toHaveLength(1);
        expect(approveCalls[0]?.resources?.length).toBe(2);
        expect(approveCalls[0]?.resources?.[0]).toContain("a.ts");
        expect(approveCalls[0]?.resources?.[1]).toContain("b.ts");
        expect(mintCount).toBe(2);
        expect(sessionLeases).toHaveLength(2);
        const targets = sessionLeases.map((l) => l.pattern).sort();
        expect(targets.some((t) => t.endsWith("a.ts"))).toBe(true);
        expect(targets.some((t) => t.endsWith("b.ts"))).toBe(true);
        const events = await kernel.readEvents(streamFor(sessionId));
        const issued = events.filter((e) => e.type === EventTypes.effectLeaseIssued);
        const batchIssued = issued.filter((e) => (e.payload as { source?: string }).source === "approval_batch");
        expect(batchIssued).toHaveLength(1);
        for (const lease of sessionLeases) {
          expect(lease.owner).toBe(humanApprovalOwner(sessionId));
        }
      } finally {
        delete process.env.HZ_ACTION_STATIONARITY;
        await kernel.close();
        store.close();
      }
    } finally {
      if (prevBin === undefined) delete process.env.HZ_KERNEL_BIN;
      else process.env.HZ_KERNEL_BIN = prevBin;
    }
  });

  test("three-path apply_patch admission mints one lease per also target on one yes", async () => {
    const prevBin = process.env.HZ_KERNEL_BIN;
    process.env.HZ_KERNEL_BIN = path.join(workspace, "no-such-hz-kernel");
    try {
      const stateDir = path.join(workspace, ".hzcode", "kernel");
      mkdirSync(stateDir, { recursive: true });
      writeFileSync(
        path.join(stateDir, "policy.json"),
        JSON.stringify([{ kind: "fs.write", scope: "workspace", decision: "ask" }]),
        "utf8",
      );
      writeFileSync(path.join(workspace, "a.ts"), "a\n", "utf8");
      writeFileSync(path.join(workspace, "b.ts"), "b\n", "utf8");
      writeFileSync(path.join(workspace, "c.ts"), "c\n", "utf8");
      const patch = [
        "*** Begin Patch",
        "*** Update File: a.ts",
        "@@",
        "-a",
        "+A",
        "*** Update File: b.ts",
        "@@",
        "-b",
        "+B",
        "*** Update File: c.ts",
        "@@",
        "-c",
        "+C",
        "*** End Patch",
      ].join("\n");
      let turn = 0;
      const provider: Provider = {
        name: "scripted",
        async *stream() {
          turn += 1;
          if (turn === 1) {
            yield {
              type: "tool_call",
              id: "call_tri",
              name: "apply_patch",
              arguments: JSON.stringify({ input: patch }),
            } satisfies ProviderEvent;
            yield { type: "done", stopReason: "tool_use" } satisfies ProviderEvent;
            return;
          }
          yield { type: "done", stopReason: "end" } satisfies ProviderEvent;
        },
      };
      const kernel = new KernelClient({ workspace, stateDir });
      await kernel.start();
      const store = new SessionStore(workspace);
      const sessionId = store.createSession("tri-patch").id;
      const sessionLeases: Lease[] = [];
      let mintCount = 0;
      const makeLeaseSpy = kernel.makeLease.bind(kernel);
      kernel.makeLease = async (...args) => {
        mintCount += 1;
        return makeLeaseSpy(...args);
      };
      let approveCount = 0;
      const deps: LoopDeps = {
        workspace,
        sessionId,
        model: "scripted-1",
        provider,
        kernel,
        store,
        signal: new AbortController().signal,
        callbacks: { onEvent: () => undefined },
        sessionLeases,
        approve: async () => {
          approveCount += 1;
          return true;
        },
      };
      try {
        process.env.HZ_ACTION_STATIONARITY = "0";
        await runTurn(deps, "patch three files");
        expect(approveCount).toBe(1);
        expect(mintCount).toBe(3);
        expect(sessionLeases).toHaveLength(3);
        const events = await kernel.readEvents(streamFor(sessionId));
        const batchIssued = events.filter(
          (e) =>
            e.type === EventTypes.effectLeaseIssued &&
            (e.payload as { source?: string }).source === "approval_batch",
        );
        expect(batchIssued).toHaveLength(2);
      } finally {
        delete process.env.HZ_ACTION_STATIONARITY;
        await kernel.close();
        store.close();
      }
    } finally {
      if (prevBin === undefined) delete process.env.HZ_KERNEL_BIN;
      else process.env.HZ_KERNEL_BIN = prevBin;
    }
  });

  test("sibling batch mint failure is all-or-nothing (ruling 682)", async () => {
    const prevBin = process.env.HZ_KERNEL_BIN;
    process.env.HZ_KERNEL_BIN = path.join(workspace, "no-such-hz-kernel");
    try {
      const stateDir = path.join(workspace, ".hzcode", "kernel");
      mkdirSync(stateDir, { recursive: true });
      writeFileSync(
        path.join(stateDir, "policy.json"),
        JSON.stringify([{ kind: "fs.write", scope: "workspace", decision: "ask" }]),
        "utf8",
      );
      writeFileSync(path.join(workspace, "a.ts"), "a\n", "utf8");
      writeFileSync(path.join(workspace, "b.ts"), "b\n", "utf8");
      writeFileSync(path.join(workspace, "c.ts"), "c\n", "utf8");
      const patch = [
        "*** Begin Patch",
        "*** Update File: a.ts",
        "@@",
        "-a",
        "+A",
        "*** Update File: b.ts",
        "@@",
        "-b",
        "+B",
        "*** Update File: c.ts",
        "@@",
        "-c",
        "+C",
        "*** End Patch",
      ].join("\n");
      let turn = 0;
      const provider: Provider = {
        name: "scripted",
        async *stream() {
          turn += 1;
          if (turn === 1) {
            yield {
              type: "tool_call",
              id: "call_atomic",
              name: "apply_patch",
              arguments: JSON.stringify({ input: patch }),
            } satisfies ProviderEvent;
            yield { type: "done", stopReason: "tool_use" } satisfies ProviderEvent;
            return;
          }
          yield { type: "done", stopReason: "end" } satisfies ProviderEvent;
        },
      };
      const kernel = new KernelClient({ workspace, stateDir });
      await kernel.start();
      const store = new SessionStore(workspace);
      const sessionId = store.createSession("atomic-batch").id;
      const sessionLeases: Lease[] = [];
      const makeLeaseSpy = kernel.makeLease.bind(kernel);
      let mintCount = 0;
      kernel.makeLease = async (...args) => {
        mintCount += 1;
        // Primary approve mints once; first sibling succeeds; second sibling fails.
        if (mintCount === 3) throw new Error("injected mint failure");
        return makeLeaseSpy(...args);
      };
      const deps: LoopDeps = {
        workspace,
        sessionId,
        model: "scripted-1",
        provider,
        kernel,
        store,
        signal: new AbortController().signal,
        callbacks: { onEvent: () => undefined },
        sessionLeases,
        approve: async () => true,
      };
      try {
        process.env.HZ_ACTION_STATIONARITY = "0";
        await runTurn(deps, "patch three files");
        expect(mintCount).toBe(3);
        // Primary may keep its gate.approve lease; no approval_batch sibling leases.
        const events = await kernel.readEvents(streamFor(sessionId));
        const batchIssued = events.filter(
          (e) =>
            e.type === EventTypes.effectLeaseIssued &&
            (e.payload as { source?: string }).source === "approval_batch",
        );
        expect(batchIssued).toHaveLength(0);
        expect(sessionLeases.every((l) => l.owner === humanApprovalOwner(sessionId))).toBe(true);
      } finally {
        delete process.env.HZ_ACTION_STATIONARITY;
        await kernel.close();
        store.close();
      }
    } finally {
      if (prevBin === undefined) delete process.env.HZ_KERNEL_BIN;
      else process.env.HZ_KERNEL_BIN = prevBin;
    }
  });

  test("multi-resource decline refuses once without a second prompt", async () => {
    const prevBin = process.env.HZ_KERNEL_BIN;
    process.env.HZ_KERNEL_BIN = path.join(workspace, "no-such-hz-kernel");
    try {
      const stateDir = path.join(workspace, ".hzcode", "kernel");
      mkdirSync(stateDir, { recursive: true });
      writeFileSync(
        path.join(stateDir, "policy.json"),
        JSON.stringify([{ kind: "fs.write", scope: "workspace", decision: "ask" }]),
        "utf8",
      );
      writeFileSync(path.join(workspace, "a.ts"), "old-a\n", "utf8");
      writeFileSync(path.join(workspace, "b.ts"), "old-b\n", "utf8");
      const patch = [
        "*** Begin Patch",
        "*** Update File: a.ts",
        "@@",
        "-old-a",
        "+new-a",
        "*** Update File: b.ts",
        "@@",
        "-old-b",
        "+new-b",
        "*** End Patch",
      ].join("\n");
      let turn = 0;
      const provider: Provider = {
        name: "scripted",
        async *stream() {
          turn += 1;
          if (turn === 1) {
            yield {
              type: "tool_call",
              id: "call_1",
              name: "apply_patch",
              arguments: JSON.stringify({ input: patch }),
            } satisfies ProviderEvent;
            yield { type: "done", stopReason: "tool_use" } satisfies ProviderEvent;
            return;
          }
          yield { type: "done", stopReason: "end" } satisfies ProviderEvent;
        },
      };
      let approveCount = 0;
      const kernel = new KernelClient({ workspace, stateDir });
      await kernel.start();
      const store = new SessionStore(workspace);
      const sessionId = store.createSession("multi-decline").id;
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
        approve: async () => {
          approveCount += 1;
          return false;
        },
      };
      try {
        process.env.HZ_ACTION_STATIONARITY = "0";
        await runTurn(deps, "patch two files");
        expect(approveCount).toBe(1);
      } finally {
        delete process.env.HZ_ACTION_STATIONARITY;
        await kernel.close();
        store.close();
      }
    } finally {
      if (prevBin === undefined) delete process.env.HZ_KERNEL_BIN;
      else process.env.HZ_KERNEL_BIN = prevBin;
    }
  });
});
