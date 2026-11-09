/**
 * interop.test.ts — the TypeScript fallback and the Rust kernel must agree.
 *
 * Both directions are exercised against one shared state directory:
 *   (a) the fallback writes events and a receipt, the Rust binary verifies them
 *       and appends onto the same chain;
 *   (b) the Rust binary writes events and receipts, a fresh TS client reads them,
 *       verifies the chain with its own hashing and extends it again.
 * Identical seeds must produce identical records, both verifiers must reject the
 * same tampering, and both guards must answer the same for every default rule.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, linkSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createHmac } from "node:crypto";
import * as path from "node:path";
import type { EventEnvelope, GuardAction, Lease, PolicyScope, Receipt } from "../../src/contracts";
import { EventTypes, canonicalJson } from "../../src/contracts";
import { KernelClient, LocalKernel, loadPolicy, resolveKernelBinary } from "../../src/core/kernel";
import {
  assertEventChain,
  assertReceiptChain,
  cleanupTemps,
  eventFilePath,
  eventPreimage,
  hasRustKernel,
  readJsonl,
  readLines,
  RECEIPT_FIELDS,
  receiptPreimage,
  receiptsFilePath,
  recomputeEventHash,
  recomputeReceiptHash,
  replyResult,
  restoreEnv,
  runKernelNdjson,
  rustKernelPath,
  seedFor,
  setEnv,
  snapshotEnv,
  tempDir,
  type EnvSnapshot,
  permissionBitsBind,
} from "./helpers";

let envBackup: EnvSnapshot;
let missingBinary = "";
const opened: KernelClient[] = [];

/** A fallback client on `stateDir`: HZ_KERNEL_BIN points at a path that is not there. */
async function localClient(stateDir: string, workspace: string): Promise<KernelClient> {
  setEnv({ HZ_KERNEL_BIN: missingBinary });
  const client = new KernelClient({ workspace, stateDir });
  opened.push(client);
  expect(await client.start()).toBe("untrusted");
  return client;
}

/** A trusted client on `stateDir`, running the repository's release binary. */
async function trustedClient(stateDir: string, workspace: string): Promise<KernelClient> {
  setEnv({ HZ_KERNEL_BIN: rustKernelPath });
  const client = new KernelClient({ workspace, stateDir });
  opened.push(client);
  expect(await client.start()).toBe("trusted");
  return client;
}

beforeAll(() => {
  envBackup = snapshotEnv();
  missingBinary = path.join(tempDir("hz-nowhere-"), "hz-kernel");
  expect(existsSync(missingBinary)).toBe(false);
  setEnv({ HZ_KERNEL_BIN: missingBinary, HZ_STATE_DIR: undefined });
});

afterAll(async () => {
  for (const client of opened) await client.close();
  restoreEnv(envBackup);
  cleanupTemps();
});

test("an explicit HZ_KERNEL_BIN is authoritative; a broken one means no kernel", () => {
  const repoBuild = hasRustKernel ? rustKernelPath : undefined;
  const broken = path.join(tempDir("hz-bin-"), "hz-kernel");
  expect(existsSync(broken)).toBe(false);
  // A misconfigured override must never be silently replaced by another build.
  expect(resolveKernelBinary({ HZ_KERNEL_BIN: broken })).toBeUndefined();
  expect(resolveKernelBinary({ HZ_KERNEL_BIN: "   " })).toBe(repoBuild as string | undefined);
  expect(resolveKernelBinary({})).toBe(repoBuild as string | undefined);
  expect(resolveKernelBinary({ HZ_KERNEL_BIN: rustKernelPath })).toBe(repoBuild as string | undefined);
});

describe.skipIf(!hasRustKernel)("kernel interop (TS fallback <-> Rust kernel)", () => {
  test("the TS fallback writes a chain the Rust kernel verifies and extends", async () => {
    const workspace = tempDir("hz-ws-i1-");
    const stateDir = path.join(tempDir("hz-state-i1-"), "kernel");
    const stream = "session:ts-to-rust";
    const client = await localClient(stateDir, workspace);

    const events: EventEnvelope[] = [];
    for (const [index, seed] of [
      seedFor(stream, EventTypes.sessionStart, { index: 1, ok: true }, "i1-1"),
      seedFor(stream, EventTypes.toolCall, { index: 2, name: "read" }, "i1-2"),
      seedFor(stream, EventTypes.toolResult, { index: 3, ok: true }, "i1-3"),
    ].entries()) {
      events.push(await client.appendEvent(stream, seed));
      expect(events[index].seq).toBe(index + 1);
    }
    const receipt = await client.issueReceipt({
      action: "tool.execute",
      tool: "read",
      argsDigest: "11".repeat(32),
      resultDigest: "22".repeat(32),
    });
    await client.close();

    assertEventChain(events, "TS-written chain");
    assertReceiptChain([receipt], "TS-written receipt");
    expect(readJsonl<EventEnvelope>(eventFilePath(stateDir, stream))).toEqual(events);

    // The Rust kernel, in its own process, reads the fallback's files.
    const run = runKernelNdjson(
      [
        { id: 1, method: "ping", params: {} },
        { id: 2, method: "log.verify", params: { stream } },
        { id: 3, method: "log.read", params: { stream } },
        { id: 4, method: "receipt.verify", params: {} },
      ],
      stateDir,
    );
    expect(run.status).toBe(0);
    expect(run.signal).toBeNull();
    expect(replyResult<{ version: string }>(run.replies, 1).version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(replyResult(run.replies, 2)).toEqual({ ok: true, count: 3 });
    expect(replyResult(run.replies, 3)).toEqual({ events });
    expect(replyResult(run.replies, 4)).toEqual({ ok: true, count: 1 });

    // ...and appends onto the very same chain.
    const second_run = runKernelNdjson(
      [
        { id: 1, method: "log.append", params: { stream, event: seedFor(stream, EventTypes.messageEnd, { index: 4 }, "i1-4") } },
        {
          id: 2,
          method: "receipt.issue",
          params: { action: "tool.execute", tool: "grep", argsDigest: "33".repeat(32), resultDigest: "44".repeat(32) },
        },
        { id: 3, method: "log.verify", params: { stream } },
        { id: 4, method: "receipt.verify", params: {} },
      ],
      stateDir,
    );
    const fourth = replyResult<EventEnvelope>(second_run.replies, 1);
    expect(fourth.seq).toBe(4);
    expect(fourth.prevHash).toBe(events[2].hash);
    expect(recomputeEventHash(fourth)).toBe(fourth.hash);
    const secondReceipt = replyResult<Receipt>(second_run.replies, 2);
    expect(secondReceipt.seq).toBe(2);
    expect(secondReceipt.prevHash).toBe(receipt.hash);
    expect(recomputeReceiptHash(secondReceipt)).toBe(secondReceipt.hash);
    expect(replyResult(second_run.replies, 3)).toEqual({ ok: true, count: 4 });
    expect(replyResult(second_run.replies, 4)).toEqual({ ok: true, count: 2 });
  });

  test("the TS fallback reads, verifies and extends a chain the Rust kernel wrote", async () => {
    const workspace = tempDir("hz-ws-i2-");
    const stateDir = path.join(tempDir("hz-state-i2-"), "kernel");
    const stream = "session:rust-to-ts";

    const run = runKernelNdjson(
      [
        { id: 1, method: "log.append", params: { stream, event: seedFor(stream, EventTypes.sessionStart, { index: 1 }, "i2-1") } },
        { id: 2, method: "log.append", params: { stream, event: seedFor(stream, EventTypes.messageStart, { index: 2 }, "i2-2") } },
        { id: 3, method: "log.append", params: { stream, event: seedFor(stream, EventTypes.messageEnd, { index: 3 }, "i2-3") } },
        {
          id: 4,
          method: "receipt.issue",
          params: { action: "tool.execute", tool: "read", argsDigest: "55".repeat(32), resultDigest: "66".repeat(32) },
        },
        {
          id: 5,
          method: "receipt.issue",
          params: { action: "tool.execute", tool: "grep", argsDigest: "77".repeat(32), resultDigest: "88".repeat(32), leaseId: "lease-rust" },
        },
      ],
      stateDir,
    );
    expect(run.status).toBe(0);
    const rustEvents = [1, 2, 3].map((id) => replyResult<EventEnvelope>(run.replies, id));
    const rustReceipts = [4, 5].map((id) => replyResult<Receipt>(run.replies, id));
    assertEventChain(rustEvents, "Rust-written chain");
    assertReceiptChain(rustReceipts, "Rust-written receipts");
    expect(rustReceipts[1].leaseId).toBe("lease-rust");
    expect(readJsonl<EventEnvelope>(eventFilePath(stateDir, stream))).toEqual(rustEvents);

    // A fresh TS client (the fallback) parses and verifies the Rust bytes itself.
    const client = await localClient(stateDir, workspace);
    expect(await client.readEvents(stream)).toEqual(rustEvents);
    expect(await client.verifyEventChain(stream)).toEqual({ ok: true, count: 3 });
    expect(await client.verifyReceipts()).toEqual({ ok: true, count: 2 });

    // ...and keeps the chain going from the Rust tail.
    const fourth = await client.appendEvent(stream, seedFor(stream, EventTypes.sessionEnd, { index: 4 }, "i2-4"));
    expect(fourth.seq).toBe(4);
    expect(fourth.prevHash).toBe(rustEvents[2].hash);
    expect(recomputeEventHash(fourth)).toBe(fourth.hash);
    const thirdReceipt = await client.issueReceipt({
      action: "tool.execute",
      tool: "shell",
      argsDigest: "99".repeat(32),
      resultDigest: "aa".repeat(32),
    });
    expect(thirdReceipt.seq).toBe(3);
    expect(thirdReceipt.prevHash).toBe(rustReceipts[1].hash);
    await client.close();

    // The Rust kernel accepts what the fallback appended to its own files.
    const after = runKernelNdjson(
      [
        { id: 1, method: "log.verify", params: { stream } },
        { id: 2, method: "receipt.verify", params: {} },
        { id: 3, method: "log.read", params: { stream, fromSeq: 4 } },
      ],
      stateDir,
    );
    expect(replyResult(after.replies, 1)).toEqual({ ok: true, count: 4 });
    expect(replyResult(after.replies, 2)).toEqual({ ok: true, count: 3 });
    expect(replyResult(after.replies, 3)).toEqual({ events: [fourth] });
  });

  test("identical seeds produce identical records under both implementations", async () => {
    const stream = "session:identical";
    const seed = seedFor(stream, EventTypes.sessionStart, { nested: { b: [1, true, null, "x"], a: "\u00e9" }, n: 7 }, "same-1");
    const localDir = path.join(tempDir("hz-state-same-local-"), "kernel");
    const rustDir = path.join(tempDir("hz-state-same-rust-"), "kernel");
    const local = await localClient(localDir, tempDir("hz-ws-same-local-"));

    const localEvent = await local.appendEvent(stream, seed);
    const rustEvent = replyResult<EventEnvelope>(
      runKernelNdjson([{ id: 1, method: "log.append", params: { stream, event: seed } }], rustDir).replies,
      1,
    );
    expect(rustEvent).toEqual(localEvent);
    expect(rustEvent.hash).toBe(localEvent.hash);
    expect(canonicalJson(rustEvent)).toBe(canonicalJson(localEvent));
    expect(recomputeEventHash(rustEvent)).toBe(rustEvent.hash);
    expect(readLines(eventFilePath(localDir, stream))).toEqual([canonicalJson(localEvent)]);
    expect(JSON.parse(readLines(eventFilePath(rustDir, stream))[0])).toEqual(rustEvent);
    // the anchors beside both logs are byte-identical too
    expect(readLines(eventFilePath(localDir, stream) + ".head")).toEqual(readLines(eventFilePath(rustDir, stream) + ".head"));

    const input = { action: "tool.execute", tool: "read", argsDigest: "ab".repeat(32), resultDigest: "cd".repeat(32) };
    const localReceipt = await local.issueReceipt(input);
    const rustReceipt = replyResult<Receipt>(
      runKernelNdjson([{ id: 1, method: "receipt.issue", params: input }], rustDir).replies,
      1,
    );
    for (const receipt of [localReceipt, rustReceipt]) {
      expect(receipt.seq).toBe(1);
      expect(receipt.prevHash).toBeNull();
      expect(recomputeReceiptHash(receipt)).toBe(receipt.hash);
      // A receipt without a lease carries no leaseId field at all.
      expect(Object.keys(receiptPreimage(receipt)).sort()).toEqual([...RECEIPT_FIELDS].sort());
    }
    expect(Object.keys(JSON.parse(readLines(receiptsFilePath(localDir))[0])).sort()).toEqual([...RECEIPT_FIELDS, "hash"].sort());
    expect(Object.keys(JSON.parse(readLines(receiptsFilePath(rustDir))[0])).sort()).toEqual([...RECEIPT_FIELDS, "hash"].sort());
    await local.close();
  });

  test("both verifiers reject the same tampering", async () => {
    const stateDir = path.join(tempDir("hz-state-tamper-"), "kernel");
    const stream = "session:tamper";
    const client = await localClient(stateDir, tempDir("hz-ws-tamper-"));
    for (const [index, seed] of [
      seedFor(stream, EventTypes.messageStart, { text: "a" }, "tp-1"),
      seedFor(stream, EventTypes.messageDelta, { text: "b" }, "tp-2"),
      seedFor(stream, EventTypes.messageEnd, { text: "c" }, "tp-3"),
    ].entries()) {
      const event = await client.appendEvent(stream, seed);
      expect(event.seq).toBe(index + 1);
    }
    expect(await client.verifyEventChain(stream)).toEqual({ ok: true, count: 3 });

    const file = eventFilePath(stateDir, stream);
    const lines = readFileSync(file, "utf8").split("\n").filter((line) => line.trim() !== "");
    const second = JSON.parse(lines[1]) as EventEnvelope;
    second.payload = { text: "tampered" };
    lines[1] = JSON.stringify(second);
    writeFileSync(file, lines.join("\n") + "\n");

    const expected = { ok: false, count: 1, brokenAt: 2 };
    expect(await client.verifyEventChain(stream)).toEqual(expected);
    expect(replyResult(runKernelNdjson([{ id: 1, method: "log.verify", params: { stream } }], stateDir).replies, 1)).toEqual(expected);
    await client.close();
  });

  test("an unwritten stream verifies as empty in both implementations", async () => {
    const stateDir = path.join(tempDir("hz-state-empty-"), "kernel");
    const client = await localClient(stateDir, tempDir("hz-ws-empty-"));
    expect(await client.verifyEventChain("session:none")).toEqual({ ok: true, count: 0 });
    expect(await client.verifyReceipts()).toEqual({ ok: true, count: 0 });
    expect(await client.readEvents("session:none")).toEqual([]);
    await client.close();

    const run = runKernelNdjson(
      [
        { id: 1, method: "log.verify", params: { stream: "session:none" } },
        { id: 2, method: "receipt.verify", params: {} },
        { id: 3, method: "log.read", params: { stream: "session:none" } },
      ],
      stateDir,
    );
    expect(replyResult(run.replies, 1)).toEqual({ ok: true, count: 0 });
    expect(replyResult(run.replies, 2)).toEqual({ ok: true, count: 0 });
    expect(replyResult(run.replies, 3)).toEqual({ events: [] });
  });

  test("guard decisions match across transports for every default rule", async () => {
    const workspace = tempDir("hz-ws-guard-");
    const rust = await trustedClient(path.join(tempDir("hz-state-guard-rust-"), "kernel"), workspace);
    const local = await localClient(path.join(tempDir("hz-state-guard-local-"), "kernel"), workspace);

    const cases: Array<[GuardAction, PolicyScope]> = [
      [{ kind: "fs.read", target: path.join(workspace, "a.txt") }, "workspace"],
      [{ kind: "fs.write", target: path.join(workspace, "a.txt") }, "workspace"],
      [{ kind: "fs.read", target: "/etc/hosts" }, "outside"],
      [{ kind: "fs.write", target: "/tmp/elsewhere.txt" }, "outside"],
      [{ kind: "shell.exec", target: "rm -rf /" }, "*"],
      [{ kind: "net.fetch", target: "https://example.invalid" }, "*"],
      [{ kind: "spawn", target: "/bin/ls" }, "*"],
      // docs/09 §4.7: the eighth default row — an MCP tool call asks.
      [{ kind: "mcp.invoke", target: "github:create_pr" }, "*"],
    ];
    for (const [action, scope] of cases) {
      const [fromRust, fromLocal] = await Promise.all([rust.checkGuard(action, scope), local.checkGuard(action, scope)]);
      expect(fromLocal.decision, `${action.kind} @ ${scope}`).toBe(fromRust.decision);
    }
    expect((await rust.checkGuard({ kind: "fs.read", target: path.join(workspace, "a.txt") }, "workspace")).decision).toBe("allow");
    expect((await local.checkGuard({ kind: "fs.read", target: path.join(workspace, "a.txt") }, "workspace")).decision).toBe("allow");
    // An unknown kind is refused before evaluation in both implementations — a
    // typed HZ_PRECONDITION_FAILED naming the kind, never a policy answer.
    const unknownKind = { kind: "ssh.exec" as GuardAction["kind"], target: "x" };
    await expect(rust.checkGuard(unknownKind, "*")).rejects.toThrow(/HZ_PRECONDITION_FAILED: unknown action kind/);
    const unknownLocal = await local.checkGuard(unknownKind, "*");
    expect(unknownLocal.decision).toBe("deny");
    expect(unknownLocal.reason ?? "").toContain("HZ_PRECONDITION_FAILED");
    expect(unknownLocal.reason ?? "").toContain("ssh.exec");

    // The same lease shape unlocks the same command in both implementations.
    const rustLease = await rust.makeLease("shell.exec", "echo *", 60_000);
    const localLease = await local.makeLease("shell.exec", "echo *", 60_000);
    const fromRust = await rust.checkGuard({ kind: "shell.exec", target: "echo hi" }, "*");
    const fromLocal = await local.checkGuard({ kind: "shell.exec", target: "echo hi" }, "*");
    expect(fromRust.decision).toBe("allow");
    expect(fromRust.leaseId).toBe(rustLease.leaseId);
    expect(fromLocal.decision).toBe("allow");
    expect(fromLocal.leaseId).toBe(localLease.leaseId);
    await rust.close();
    await local.close();
  });

  test("the same policy.json produces the same decisions in both implementations", async () => {
    const policy = [
      { kind: "fs.read", scope: "workspace", decision: "deny" },
      { kind: "shell.exec", scope: "*", decision: "allow" },
      // docs/11 R1: a matching ask rule must beat a matching allow rule in both
      // implementations, whatever the declaration order.
      { kind: "net.fetch", scope: "*", decision: "ask" },
      { kind: "net.fetch", scope: "*", decision: "allow" },
    ];
    const workspace = tempDir("hz-ws-pol-");
    const writePolicy = (dir: string): string => {
      mkdirSync(dir, { recursive: true });
      writeFileSync(path.join(dir, "policy.json"), JSON.stringify(policy));
      return dir;
    };
    const rust = await trustedClient(writePolicy(path.join(tempDir("hz-state-pol-rust-"), "kernel")), workspace);
    const local = await localClient(writePolicy(path.join(tempDir("hz-state-pol-local-"), "kernel")), workspace);

    const cases: Array<[GuardAction, PolicyScope, string]> = [
      [{ kind: "fs.read", target: path.join(workspace, "a.txt") }, "workspace", "deny"],
      [{ kind: "fs.write", target: path.join(workspace, "a.txt") }, "workspace", "ask"],
      [{ kind: "shell.exec", target: "echo hi" }, "*", "allow"],
      [{ kind: "net.fetch", target: "https://example.invalid" }, "*", "ask"],
    ];
    for (const [action, scope, expected] of cases) {
      const [fromRust, fromLocal] = await Promise.all([rust.checkGuard(action, scope), local.checkGuard(action, scope)]);
      expect(fromRust.decision, `rust ${action.kind} @ ${scope}`).toBe(expected);
      expect(fromLocal.decision, `local ${action.kind} @ ${scope}`).toBe(expected);
    }
    await rust.close();
    await local.close();
  });

  test("mcp.invoke evaluates identically on both transports, and the unknown-kind refusal stays intact", async () => {
    const workspace = tempDir("hz-ws-mcp-invoke-");
    const action: GuardAction = { kind: "mcp.invoke", target: "github:create_pr" };

    // (a) Default policy: mcp.invoke is a known kind with an ask row on both
    // transports (docs/09 §4.7) — never an unknown-kind refusal, never an allow.
    const localDefault = await localClient(path.join(tempDir("hz-state-mcp-default-ts-"), "kernel"), workspace);
    expect((await localDefault.checkGuard(action, "*")).decision).toBe("ask");
    await localDefault.close();
    const rustDefault = runKernelNdjson(
      [{ id: 1, method: "guard.check", params: { action, scope: "*" } }],
      path.join(tempDir("hz-state-mcp-default-rs-"), "kernel"),
    );
    expect(replyResult<{ decision: string }>(rustDefault.replies, 1).decision).toBe("ask");

    // (b) The same policy.json: allow, deny and ask rows for mcp.invoke decide
    // identically on both transports. A deny wins over anything, as everywhere.
    const decide = async (policy: unknown[], row: { action: GuardAction; scope: PolicyScope; expected: string }): Promise<void> => {
      const write = (dir: string): string => {
        mkdirSync(dir, { recursive: true });
        writeFileSync(path.join(dir, "policy.json"), JSON.stringify(policy));
        return dir;
      };
      const local = await localClient(write(path.join(tempDir("hz-state-mcp-pol-ts-"), "kernel")), workspace);
      const rust = runKernelNdjson(
        [{ id: 1, method: "guard.check", params: { action: row.action, scope: row.scope } }],
        write(path.join(tempDir("hz-state-mcp-pol-rs-"), "kernel")),
      );
      expect((await local.checkGuard(row.action, row.scope)).decision, `local ${JSON.stringify(row.action)}`).toBe(row.expected);
      expect(
        replyResult<{ decision: string }>(rust.replies, 1).decision,
        `rust ${JSON.stringify(row.action)}`,
      ).toBe(row.expected);
      await local.close();
    };
    await decide([{ kind: "mcp.invoke", scope: "*", decision: "allow" }], { action, scope: "*", expected: "allow" });
    await decide(
      [
        { kind: "mcp.invoke", scope: "*", decision: "allow" },
        { kind: "mcp.invoke", scope: "*", decision: "deny" },
      ],
      { action, scope: "*", expected: "deny" },
    );
    await decide(
      [
        { kind: "mcp.invoke", scope: "*", decision: "allow" },
        { kind: "mcp.invoke", scope: "*", decision: "ask" },
      ],
      { action, scope: "*", expected: "ask" },
    );

    // (c) A lease for the new kind is mintable and spent by one effect on both
    // transports — the kind is in the lease vocabulary too, not only in rules.
    const stateDir = path.join(tempDir("hz-state-mcp-lease-"), "kernel");
    const rust = runKernelNdjson(
      [
        { id: 1, method: "guard.lease", params: { kind: "mcp.invoke", pattern: "github:create_pr", ttlMs: 60_000 } },
        { id: 2, method: "guard.check", params: { action, scope: "*" } },
        { id: 3, method: "guard.check", params: { action, scope: "*" } },
      ],
      stateDir,
    );
    const lease = replyResult<Lease>(rust.replies, 1);
    const first = replyResult<{ decision: string; leaseId?: string }>(rust.replies, 2);
    expect(first.decision).toBe("allow");
    expect(first.leaseId).toBe(lease.leaseId);
    expect(replyResult<{ decision: string }>(rust.replies, 3).decision).toBe("ask");

    const local = await localClient(stateDir, workspace);
    const localLease = await local.makeLease("mcp.invoke", "github:create_pr", 60_000);
    const localFirst = await local.checkGuard(action, "*");
    expect(localFirst.decision).toBe("allow");
    expect(localFirst.leaseId).toBe(localLease.leaseId);
    expect((await local.checkGuard(action, "*", [], undefined)).decision).toBe("ask");
    await local.close();

    // (d) The unknown-kind refusal is unchanged and now names every known kind:
    // a near-miss MCP kind is refused BEFORE evaluation on both transports.
    const nearMiss = { kind: "mcp.connect" as GuardAction["kind"], target: "github" };
    const localNear = await localClient(path.join(tempDir("hz-state-mcp-near-ts-"), "kernel"), workspace);
    const localRefusal = await localNear.checkGuard(nearMiss, "*");
    expect(localRefusal.decision).toBe("deny");
    expect(localRefusal.reason ?? "").toContain('unknown action kind "mcp.connect"');
    expect(localRefusal.reason ?? "").toContain("mcp.invoke");
    await localNear.close();
    const rustNear = runKernelNdjson(
      [
        { id: 1, method: "guard.check", params: { action: nearMiss, scope: "*" } },
        { id: 2, method: "guard.lease", params: { kind: "mcp.connect", pattern: "*", ttlMs: 60_000 } },
      ],
      path.join(tempDir("hz-state-mcp-near-rs-"), "kernel"),
    );
    expect(rustNear.replies[0]?.error?.message ?? "").toContain('unknown action kind "mcp.connect"');
    expect(rustNear.replies[0]?.error?.message ?? "").toContain("mcp.invoke");
    expect(rustNear.replies[1]?.error?.message ?? "").toContain('unknown action kind "mcp.connect"');
  });

  test("astral and private-use payload keys hash identically under both implementations", async () => {
    const stream = "session:astral";
    // Byte order (not UTF-16 code-unit order) puts the astral key after U+E000.
    const payload = { "\u{10000}": 1, "\uE000": 2, z: 3, "\u00e9": 4, n: 9007199254740991 };
    const seed = seedFor(stream, EventTypes.messageDelta, payload, "astral-1");
    const localDir = path.join(tempDir("hz-state-astral-local-"), "kernel");
    const rustDir = path.join(tempDir("hz-state-astral-rust-"), "kernel");
    const local = await localClient(localDir, tempDir("hz-ws-astral-local-"));

    const localEvent = await local.appendEvent(stream, seed);
    const rustEvent = replyResult<EventEnvelope>(
      runKernelNdjson([{ id: 1, method: "log.append", params: { stream, event: seed } }], rustDir).replies,
      1,
    );
    expect(rustEvent.hash).toBe(localEvent.hash);
    expect(canonicalJson(rustEvent)).toBe(canonicalJson(localEvent));
    expect(recomputeEventHash(rustEvent)).toBe(rustEvent.hash);
    expect(readLines(eventFilePath(localDir, stream))).toEqual(readLines(eventFilePath(rustDir, stream)));
    const canonical = canonicalJson(localEvent);
    expect(canonical.indexOf("\u{10000}")).toBeGreaterThan(canonical.indexOf("\uE000"));
    await local.close();
  });

  test("a kernel refusal is surfaced, never routed around, and the mode stays trusted", async () => {
    const workspace = tempDir("hz-ws-refusal-");
    const stateDir = path.join(tempDir("hz-state-refusal-"), "kernel");
    const client = await trustedClient(stateDir, workspace);

    // The kernel rejects this stream name outright; the client must not fall back
    // and write it locally as if the kernel had not answered.
    const bad = "session:bad..name";
    await expect(client.appendEvent(bad, seedFor(bad, EventTypes.sessionStart, { n: 1 }, "r-1"))).rejects.toThrow(/stream name is not allowed/);
    expect(client.mode).toBe("trusted");
    const eventsDir = path.join(stateDir, "events");
    expect(existsSync(eventsDir) ? readdirSync(eventsDir) : []).toEqual([]);

    // ...and the client still serves the next, valid call from the kernel
    const stream = "session:after-refusal";
    const event = await client.appendEvent(stream, seedFor(stream, EventTypes.sessionStart, { n: 2 }, "r-2"));
    expect(event.seq).toBe(1);
    expect(client.mode).toBe("trusted");
    await client.close();
  });

  test("lease patterns mean the same thing in both implementations", async () => {
    const workspace = tempDir("hz-ws-lease-");
    const rust = await trustedClient(path.join(tempDir("hz-state-lease-rust-"), "kernel"), workspace);
    const local = await localClient(path.join(tempDir("hz-state-lease-local-"), "kernel"), workspace);

    const cases: Array<[string, string, "allow" | "ask"]> = [
      ["echo *", "echo hi", "allow"],
      ["git commit", "git commit", "allow"],
      ["git commit", "git commit -m x", "ask"],
      ["/tmp/demo", "/tmp/demo/sub/file.txt", "ask"],
      ["*", "anything at all", "allow"],
    ];
    for (const [pattern, target, expected] of cases) {
      const rustLease = await rust.makeLease("shell.exec", pattern, 60_000);
      const localLease = await local.makeLease("shell.exec", pattern, 60_000);
      const [fromRust, fromLocal] = await Promise.all([
        rust.checkGuard({ kind: "shell.exec", target }, "*", [rustLease]),
        local.checkGuard({ kind: "shell.exec", target }, "*", [localLease]),
      ]);
      expect(fromRust.decision, `rust ${pattern} -> ${target}`).toBe(expected);
      expect(fromLocal.decision, `local ${pattern} -> ${target}`).toBe(expected);
    }

    // an empty pattern is refused by both, never widened to a wildcard
    await expect(rust.makeLease("shell.exec", "", 1_000)).rejects.toThrow();
    await expect(local.makeLease("shell.exec", "", 1_000)).rejects.toThrow();
    await rust.close();
    await local.close();
  });

  test("the head anchor detects tail truncation in both implementations", async () => {
    const stateDir = path.join(tempDir("hz-state-anchor-"), "kernel");
    const stream = "session:anchor-i";
    const client = await localClient(stateDir, tempDir("hz-ws-anchor-"));
    const appended: EventEnvelope[] = [];
    for (const [index, seed] of [
      seedFor(stream, EventTypes.sessionStart, { index: 1 }, "ai-1"),
      seedFor(stream, EventTypes.messageStart, { index: 2 }, "ai-2"),
      seedFor(stream, EventTypes.messageEnd, { index: 3 }, "ai-3"),
    ].entries()) {
      appended.push(await client.appendEvent(stream, seed));
    }
    expect(await client.verifyEventChain(stream)).toEqual({ ok: true, count: 3 });

    const file = eventFilePath(stateDir, stream);
    const anchor = JSON.parse(readLines(file + ".head")[0] as string) as { hash: string; seq: number };
    expect(anchor).toEqual({ hash: appended[2]?.hash, seq: 3 });

    // drop the last whole record: both verifiers must now call it broken at 3
    const lines = readLines(file);
    writeFileSync(file, lines.slice(0, -1).join("\n") + "\n");
    const expected = { ok: false, count: 2, brokenAt: 3 };
    expect(await client.verifyEventChain(stream)).toEqual(expected);
    expect(replyResult(runKernelNdjson([{ id: 1, method: "log.verify", params: { stream } }], stateDir).replies, 1)).toEqual(expected);

    // ...and neither implementation will extend the truncated chain
    await expect(client.appendEvent(stream, seedFor(stream, EventTypes.sessionEnd, { index: 4 }, "ai-4"))).rejects.toThrow(/anchor/);
    const refused = runKernelNdjson(
      [{ id: 1, method: "log.append", params: { stream, event: seedFor(stream, EventTypes.sessionEnd, { index: 4 }, "ai-4") } }],
      stateDir,
    );
    expect(refused.replies[0]?.error?.message ?? "").toContain("anchor");
    await client.close();
  });

  test("keyed anchors: byte-identical files and cross-verification in both directions", async () => {
    const key = "9c".repeat(32);
    setEnv({ HZ_ANCHOR_KEY: key, HZ_ACCEPT_LEGACY_ANCHORS: undefined });
    try {
      const workspace = tempDir("hz-ws-keyed-i-");
      const localDir = path.join(tempDir("hz-state-keyed-local-"), "kernel");
      const rustDir = path.join(tempDir("hz-state-keyed-rust-"), "kernel");
      const stream = "session:keyed-interop";
      const hmac = (preimage: Record<string, unknown>): string =>
        createHmac("sha256", Buffer.from(key, "hex")).update(canonicalJson(preimage), "utf8").digest("hex");

      // (a) the TS fallback writes; its anchor is HMAC over the event preimage
      const local = await localClient(localDir, workspace);
      const seed = seedFor(stream, EventTypes.sessionStart, { keyed: true }, "ki-1");
      const localEvent = await local.appendEvent(stream, seed);
      const headLocal = JSON.parse(readLines(eventFilePath(localDir, stream) + ".head")[0] as string) as { hash: string; seq: number };
      expect(headLocal).toEqual({ hash: hmac(eventPreimage(localEvent)), seq: 1 });
      expect(headLocal.hash).not.toBe(localEvent.hash);

      // (b) the same seed through the Rust kernel: identical record and anchor
      const rustRun = runKernelNdjson(
        [
          { id: 1, method: "log.append", params: { stream, event: seed } },
          { id: 2, method: "log.verify", params: { stream } },
          { id: 3, method: "receipt.issue", params: { action: "tool.execute", tool: "read", argsDigest: "cd".repeat(32), resultDigest: "ef".repeat(32) } },
          { id: 4, method: "receipt.verify", params: {} },
        ],
        rustDir,
      );
      expect(rustRun.status).toBe(0);
      const rustEvent = replyResult<EventEnvelope>(rustRun.replies, 1);
      expect(rustEvent).toEqual(localEvent);
      expect(readLines(eventFilePath(rustDir, stream) + ".head")).toEqual(readLines(eventFilePath(localDir, stream) + ".head"));
      expect(replyResult(rustRun.replies, 2)).toEqual({ ok: true, count: 1 });
      const rustReceipt = replyResult<Receipt>(rustRun.replies, 3);
      expect(replyResult(rustRun.replies, 4)).toEqual({ ok: true, count: 1 });
      expect(JSON.parse(readLines(receiptsFilePath(rustDir) + ".head")[0] as string)).toEqual({
        hash: hmac(receiptPreimage(rustReceipt)),
        seq: 1,
      });

      // (c) a fresh TS client verifies the Rust-written keyed chain and extends it
      const verifier = await localClient(rustDir, workspace);
      expect(await verifier.verifyEventChain(stream)).toEqual({ ok: true, count: 1 });
      expect(await verifier.verifyReceipts()).toEqual({ ok: true, count: 1 });
      const extended = await verifier.appendEvent(stream, seedFor(stream, EventTypes.sessionEnd, { n: 2 }, "ki-2"));
      expect(extended.seq).toBe(2);
      expect(extended.prevHash).toBe(rustEvent.hash);
      const tsReceipt = await verifier.issueReceipt({
        action: "tool.execute",
        tool: "grep",
        argsDigest: "12".repeat(32),
        resultDigest: "34".repeat(32),
      });
      expect(tsReceipt.seq).toBe(2);
      expect(rustReceipt.prevHash).toBeNull();
      await verifier.close();

      // (d) the Rust kernel verifies the TS keyed extension and the keyed tail anchor
      const after = runKernelNdjson(
        [
          { id: 1, method: "log.verify", params: { stream } },
          { id: 2, method: "receipt.verify", params: {} },
          { id: 3, method: "log.read", params: { stream, fromSeq: 2 } },
        ],
        rustDir,
      );
      expect(replyResult(after.replies, 1)).toEqual({ ok: true, count: 2 });
      expect(replyResult(after.replies, 2)).toEqual({ ok: true, count: 2 });
      expect(replyResult(after.replies, 3)).toEqual({ events: [extended] });
      const finalHead = JSON.parse(readLines(eventFilePath(rustDir, stream) + ".head")[0] as string) as { hash: string; seq: number };
      expect(finalHead).toEqual({ hash: hmac(eventPreimage(extended)), seq: 2 });
      await local.close();
    } finally {
      setEnv({ HZ_ANCHOR_KEY: undefined, HZ_ACCEPT_LEGACY_ANCHORS: undefined });
    }
  });

  test("keyed verification refuses legacy anchors in both implementations; the opt-in accepts", async () => {
    const key = "4e".repeat(32);
    const workspace = tempDir("hz-ws-keyed-legacy-");
    const stateDir = path.join(tempDir("hz-state-keyed-legacy-"), "kernel");
    const stream = "session:legacy-interop";

    // an unkeyed chain written by the Rust kernel (the shipped default)
    const plain = runKernelNdjson(
      [
        { id: 1, method: "log.append", params: { stream, event: seedFor(stream, EventTypes.sessionStart, { n: 1 }, "li-1") } },
        { id: 2, method: "log.append", params: { stream, event: seedFor(stream, EventTypes.messageEnd, { n: 2 }, "li-2") } },
        { id: 3, method: "receipt.issue", params: { action: "tool.execute", tool: "read", argsDigest: "aa".repeat(32), resultDigest: "bb".repeat(32) } },
      ],
      stateDir,
    );
    expect(plain.status).toBe(0);

    setEnv({ HZ_ANCHOR_KEY: key });
    try {
      // the TS fallback refuses, and says why in the typed form
      const strict = await localClient(stateDir, workspace);
      await expect(strict.verifyEventChain(stream)).rejects.toThrow(/HZ_PRECONDITION_FAILED: legacy \(unkeyed\) anchor/);
      await expect(strict.verifyReceipts()).rejects.toThrow(/legacy \(unkeyed\) anchor/);
      await expect(strict.appendEvent(stream, seedFor(stream, EventTypes.error, { n: 3 }, "li-3"))).rejects.toThrow(/legacy \(unkeyed\) anchor/);
      await strict.close();

      // the Rust kernel refuses the same way over the wire
      const refused = runKernelNdjson(
        [
          { id: 1, method: "log.verify", params: { stream } },
          { id: 2, method: "receipt.verify", params: {} },
          { id: 3, method: "log.append", params: { stream, event: seedFor(stream, EventTypes.error, { n: 3 }, "li-3") } },
        ],
        stateDir,
      );
      expect(refused.replies[0]?.error?.message ?? "").toContain("HZ_PRECONDITION_FAILED");
      expect(refused.replies[1]?.error?.message ?? "").toContain("legacy (unkeyed) anchor");
      expect(refused.replies[2]?.error?.message ?? "").toContain("HZ_PRECONDITION_FAILED");

      // explicit opt-in: both accept; the Rust kernel re-anchors keyed on append
      setEnv({ HZ_ACCEPT_LEGACY_ANCHORS: "1" });
      const accepting = await localClient(stateDir, workspace);
      expect(await accepting.verifyEventChain(stream)).toEqual({ ok: true, count: 2 });
      expect(await accepting.verifyReceipts()).toEqual({ ok: true, count: 1 });
      await accepting.close();
      const accepted = runKernelNdjson(
        [
          { id: 1, method: "log.verify", params: { stream } },
          { id: 2, method: "log.append", params: { stream, event: seedFor(stream, EventTypes.sessionEnd, { n: 3 }, "li-3") } },
          { id: 3, method: "log.verify", params: { stream } },
        ],
        stateDir,
      );
      expect(replyResult(accepted.replies, 1)).toEqual({ ok: true, count: 2 });
      const third = replyResult<EventEnvelope>(accepted.replies, 2);
      expect(third.seq).toBe(3);
      expect(replyResult(accepted.replies, 3)).toEqual({ ok: true, count: 3 });
      const head = JSON.parse(readLines(eventFilePath(stateDir, stream) + ".head")[0] as string) as { hash: string; seq: number };
      expect(head.hash).toBe(
        createHmac("sha256", Buffer.from(key, "hex")).update(canonicalJson(eventPreimage(third)), "utf8").digest("hex"),
      );

      // strict keyed verifiers (no opt-in) accept the re-anchored chain
      setEnv({ HZ_ACCEPT_LEGACY_ANCHORS: undefined });
      const recheck = await localClient(stateDir, workspace);
      expect(await recheck.verifyEventChain(stream)).toEqual({ ok: true, count: 3 });
      await recheck.close();
      const strictRust = runKernelNdjson([{ id: 1, method: "log.verify", params: { stream } }], stateDir);
      expect(replyResult(strictRust.replies, 1)).toEqual({ ok: true, count: 3 });
    } finally {
      setEnv({ HZ_ANCHOR_KEY: undefined, HZ_ACCEPT_LEGACY_ANCHORS: undefined });
    }
  });

  test("a wrong key or a deleted anchor fails closed in both implementations", async () => {
    const keyA = "11".repeat(32);
    const keyB = "33".repeat(32);
    const workspace = tempDir("hz-ws-keyed-wrong-");
    const stateDir = path.join(tempDir("hz-state-keyed-wrong-"), "kernel");
    const stream = "session:wrong-key";
    setEnv({ HZ_ANCHOR_KEY: keyA });
    try {
      const writer = runKernelNdjson(
        [
          { id: 1, method: "log.append", params: { stream, event: seedFor(stream, EventTypes.sessionStart, { n: 1 }, "wk-1") } },
          { id: 2, method: "log.append", params: { stream, event: seedFor(stream, EventTypes.messageEnd, { n: 2 }, "wk-2") } },
        ],
        stateDir,
      );
      expect(writer.status).toBe(0);

      // wrong key: same tamper verdict in both implementations
      setEnv({ HZ_ANCHOR_KEY: keyB });
      const wrong = await localClient(stateDir, workspace);
      expect(await wrong.verifyEventChain(stream)).toEqual({ ok: false, count: 2, brokenAt: 2 });
      await expect(wrong.appendEvent(stream, seedFor(stream, EventTypes.error, { n: 3 }, "wk-3"))).rejects.toThrow(/disagrees with its anchor/);
      await wrong.close();
      const wrongRust = runKernelNdjson([{ id: 1, method: "log.verify", params: { stream } }], stateDir);
      expect(replyResult(wrongRust.replies, 1)).toEqual({ ok: false, count: 2, brokenAt: 2 });

      // deleted anchor under the right key: typed refusal in both implementations
      setEnv({ HZ_ANCHOR_KEY: keyA });
      rmSync(eventFilePath(stateDir, stream) + ".head");
      const missing = await localClient(stateDir, workspace);
      await expect(missing.verifyEventChain(stream)).rejects.toThrow(/HZ_PRECONDITION_FAILED: legacy \(unkeyed\) anchor/);
      await expect(missing.verifyEventChain(stream)).rejects.toThrow(/no anchor/);
      await missing.close();
      const missingRust = runKernelNdjson([{ id: 1, method: "log.verify", params: { stream } }], stateDir);
      const message = missingRust.replies[0]?.error?.message ?? "";
      expect(message).toContain("HZ_PRECONDITION_FAILED");
      expect(message).toContain("no anchor");
    } finally {
      setEnv({ HZ_ANCHOR_KEY: undefined, HZ_ACCEPT_LEGACY_ANCHORS: undefined });
    }
  });

  test("a write through a dangling symlink into the state dir is refused by both implementations", async () => {
    const workspace = tempDir("hz-ws-link-i-");
    const stateDir = path.join(tempDir("hz-state-link-i-"), "kernel");
    mkdirSync(stateDir, { recursive: true });
    // the exact repro: a dangling link to <state>/policy.json
    const link = path.join(workspace, "link");
    symlinkSync(path.join(stateDir, "policy.json"), link);
    const action: GuardAction = { kind: "fs.write", target: link };

    const local = await localClient(stateDir, workspace);
    const rust = await trustedClient(stateDir, workspace);
    // Both KernelClients — one per transport — surface the same typed refusal.
    await expect(local.checkGuard(action, "workspace")).rejects.toThrow(/kernel-state-protected/);
    await expect(rust.checkGuard(action, "workspace")).rejects.toThrow(/kernel-state-protected/);
    // The Rust kernel refuses it on its own side too (a deny decision, the
    // kernel's own vocabulary for "the guard answered no").
    const raw = runKernelNdjson(
      [{ id: 1, method: "guard.check", params: { action, scope: "workspace" } }],
      stateDir,
    );
    const decision = replyResult<{ decision: string; reason?: string }>(raw.replies, 1);
    expect(decision.decision).toBe("deny");
    expect(decision.reason ?? "").toContain("kernel-state-protected");
    // Nothing was created behind the link: the refusal precedes any write.
    expect(existsSync(path.join(stateDir, "policy.json"))).toBe(false);
    await local.close();
    await rust.close();
  });

  test("leases are owner-scoped identically in both implementations", async () => {
    const workspace = tempDir("hz-ws-owner-i-");
    const stateDir = path.join(tempDir("hz-state-owner-i-"), "kernel");

    // Rust over the raw protocol: sessionId rides guard.lease and guard.check.
    const minted = runKernelNdjson(
      [
        {
          id: 1,
          method: "guard.lease",
          params: { kind: "shell.exec", pattern: "echo *", ttlMs: 60_000, sessionId: "parent" },
        },
        {
          id: 2,
          method: "guard.check",
          params: { action: { kind: "shell.exec", target: "echo hi" }, sessionId: "parent" },
        },
        {
          id: 3,
          method: "guard.check",
          params: { action: { kind: "shell.exec", target: "echo hi" }, sessionId: "child" },
        },
        {
          id: 4,
          method: "guard.lease",
          params: { kind: "shell.exec", pattern: "echo hi", ttlMs: 60_000 },
        },
        {
          id: 5,
          method: "guard.check",
          params: { action: { kind: "shell.exec", target: "echo hi" }, sessionId: "child" },
        },
      ],
      stateDir,
    );
    const rustLease = replyResult<Lease & { owner?: string }>(minted.replies, 1);
    expect(rustLease.owner).toBe("parent");
    const rustParent = replyResult<{ decision: string; leaseId?: string }>(minted.replies, 2);
    expect(rustParent.decision).toBe("allow");
    expect(rustParent.leaseId).toBe(rustLease.leaseId);
    expect(replyResult<{ decision: string }>(minted.replies, 3).decision).toBe("ask");
    const rustLegacy = replyResult<Lease & { owner?: string }>(minted.replies, 4);
    expect(rustLegacy.owner).toBeUndefined();
    expect(replyResult<{ decision: string }>(minted.replies, 5).decision).toBe("allow");

    // The fallback, minted and checked with the same session ids.
    const local = await localClient(stateDir, workspace);
    const localLease = (await local.makeLease("shell.exec", "echo *", 60_000, "parent")) as Lease & {
      owner?: string;
    };
    expect(localLease.owner).toBe("parent");
    expect((await local.checkGuard({ kind: "shell.exec", target: "echo hi" }, "*", [], "parent")).decision).toBe(
      "allow",
    );
    expect((await local.checkGuard({ kind: "shell.exec", target: "echo hi" }, "*", [], "child")).decision).toBe(
      "ask",
    );
    const localLegacy = (await local.makeLease("shell.exec", "echo hi", 60_000)) as Lease & { owner?: string };
    expect(localLegacy.owner).toBeUndefined();
    expect((await local.checkGuard({ kind: "shell.exec", target: "echo hi" }, "*", [], "child")).decision).toBe(
      "allow",
    );
    await local.close();
  });

  test("a malformed policy.json is refused by both implementations, never silently reduced", async () => {
    const malformed = JSON.stringify([
      { kind: "fs.write", scope: "workspace", decision: "allow" },
      { kind: "fs.write", decision: "deny" }, // the scope-less deny rule
    ]);
    const localDir = path.join(tempDir("hz-state-badpol-ts-"), "kernel");
    const rustDir = path.join(tempDir("hz-state-badpol-rs-"), "kernel");
    mkdirSync(localDir, { recursive: true });
    mkdirSync(rustDir, { recursive: true });
    writeFileSync(path.join(localDir, "policy.json"), malformed, "utf8");
    writeFileSync(path.join(rustDir, "policy.json"), malformed, "utf8");

    // TS: the loader and the kernel both refuse, naming rule 1 — the deny rule
    // is never dropped, so nothing it denies can slip through.
    expect(() => loadPolicy(localDir)).toThrow(/HZ_PRECONDITION_FAILED: policy\.json rule 1/);
    expect(() => new LocalKernel({ stateDir: localDir })).toThrow(/rule 1 is malformed/);

    // Rust: a kernel told to serve it refuses to start (exit 2, same wording).
    const run = runKernelNdjson(
      [{ id: 1, method: "guard.check", params: { action: { kind: "fs.write", target: "/x" }, scope: "workspace" } }],
      rustDir,
    );
    expect(run.replies.length).toBe(0);
    expect(run.status).toBe(2);
    expect(run.stderr).toContain("HZ_PRECONDITION_FAILED: policy.json rule 1 is malformed");
  });

  test.skipIf(!permissionBitsBind)("an unreadable chain refuses appends in both implementations and keeps the bytes", async () => {
    const workspace = tempDir("hz-ws-unreadable-i-");
    const stateDir = path.join(tempDir("hz-state-unreadable-i-"), "kernel");
    const stream = "session:unreadable-i";
    const chain = eventFilePath(stateDir, stream);

    // Rust writes the chain (its own files, its own modes).
    const written = runKernelNdjson(
      [
        { id: 1, method: "log.append", params: { stream, event: seedFor(stream, EventTypes.sessionStart, { n: 1 }, "u-1") } },
        { id: 2, method: "log.append", params: { stream, event: seedFor(stream, EventTypes.messageEnd, { n: 2 }, "u-2") } },
      ],
      stateDir,
    );
    expect(written.status).toBe(0);
    const before = readFileSync(chain, "utf8");

    chmodSync(chain, 0o200); // write-only: appendFile is fine, read is not
    try {
      // The fallback refuses with the same shape of error the Rust kernel uses.
      const local = await localClient(stateDir, workspace);
      await expect(local.appendEvent(stream, seedFor(stream, EventTypes.error, { n: 3 }, "u-3"))).rejects.toThrow(
        /cannot read/,
      );
      await local.close();
      const refused = runKernelNdjson(
        [{ id: 3, method: "log.append", params: { stream, event: seedFor(stream, EventTypes.error, { n: 3 }, "u-3") } }],
        stateDir,
      );
      expect(refused.replies[0]?.error?.message ?? "").toContain("cannot read");
    } finally {
      chmodSync(chain, 0o600);
    }
    // Byte-level parity: neither implementation touched the chain it could not read.
    expect(readFileSync(chain, "utf8")).toBe(before);
    expect(readLines(chain).length).toBe(2);
  });
});

describe("additional-hardening parity", () => {
  test("a hardlinked policy is refused by both implementations until the link is gone", async () => {
    const workspace = tempDir("hz-ws-hardlink-i-");
    const stateDir = path.join(tempDir("hz-state-hardlink-i-"), "kernel");
    mkdirSync(stateDir, { recursive: true });
    const policy = path.join(stateDir, "policy.json");
    writeFileSync(policy, JSON.stringify([{ kind: "fs.write", scope: "*", decision: "allow" }]), "utf8");
    const action: GuardAction = { kind: "fs.write", target: path.join(workspace, "x.txt") };
    const rustCheck = () =>
      runKernelNdjson([{ id: 1, method: "guard.check", params: { action, scope: "workspace" } }], stateDir);

    // A single-link policy serves both transports normally.
    const local = await localClient(stateDir, workspace);
    expect((await local.checkGuard(action, "workspace")).decision).toBe("allow");
    expect(replyResult<{ decision: string }>(rustCheck().replies, 1).decision).toBe("allow");

    // The attack: `ln <state>/policy.json <ws>/pol-link.json`. A plain write
    // through that name would rewrite the policy in place — no path check can
    // see a hard link — so both implementations must refuse to serve it.
    const link = path.join(workspace, "pol-link.json");
    linkSync(policy, link);
    const before = readFileSync(policy, "utf8");
    await expect(local.checkGuard(action, "workspace")).rejects.toThrow(/policy\.json must have exactly one link/);
    // The Rust kernel re-validates the policy before every check, so it refuses
    // here too: pointed at the hardlinked policy it fails closed (exit 2, the
    // same typed message) rather than serving decisions from it.
    const refused = rustCheck();
    expect(refused.status).toBe(2);
    expect(refused.stderr).toContain("policy.json must have exactly one link");
    expect(readFileSync(policy, "utf8")).toBe(before);

    // Removing the extra link restores service on both sides.
    rmSync(link);
    expect((await local.checkGuard(action, "workspace")).decision).toBe("allow");
    expect(replyResult<{ decision: string }>(rustCheck().replies, 1).decision).toBe("allow");
    await local.close();
  });

  test("ttlMs<=0 behaves identically on both transports (finding 13)", async () => {
    const workspace = tempDir("hz-ws-ttl-i-");
    const command = "echo hi";
    const mintedAt = Date.now();

    // TS: ttlMs=0 mints an ALREADY-EXPIRED lease; negative is refused.
    const local = await localClient(path.join(tempDir("hz-state-ttl-ts-"), "kernel"), workspace);
    const localLease = await local.makeLease("shell.exec", command, 0);
    expect(Math.abs(Date.parse(localLease.expiry) - mintedAt)).toBeLessThan(1_000);
    expect((await local.checkGuard({ kind: "shell.exec", target: command }, "*")).decision).toBe("ask");
    await expect(local.makeLease("shell.exec", command, -1)).rejects.toThrow(/ttlMs must be a number/);
    await local.close();

    // Rust: the same request over the raw protocol mints the same expired lease
    // (and the same refusal for a negative TTL).
    const rust = runKernelNdjson(
      [
        { id: 1, method: "guard.lease", params: { kind: "shell.exec", pattern: command, ttlMs: 0 } },
        { id: 2, method: "guard.check", params: { action: { kind: "shell.exec", target: command }, scope: "*" } },
        { id: 3, method: "guard.lease", params: { kind: "shell.exec", pattern: command, ttlMs: -1 } },
      ],
      path.join(tempDir("hz-state-ttl-rs-"), "kernel"),
    );
    const rustLease = replyResult<Lease>(rust.replies, 1);
    expect(Math.abs(Date.parse(rustLease.expiry) - mintedAt)).toBeLessThan(5_000);
    // Expired on issue, so the next check of that command is policy-decided.
    expect(replyResult<{ decision: string }>(rust.replies, 2).decision).toBe("ask");
    expect(rust.replies.find((reply) => reply.id === 3)?.error?.message ?? "").toContain(
      "guard.lease.ttlMs must be a number",
    );
  });

  test("a caller-supplied lease object unlocks nothing on either transport (finding 15b)", async () => {
    const workspace = tempDir("hz-ws-fab-i-");
    const command = "echo hi";
    const fabricated = {
      leaseId: "caller-wild",
      kind: "shell.exec",
      pattern: command,
      expiry: "2099-01-01T00:00:00.000Z",
    } as Lease;

    const local = await localClient(path.join(tempDir("hz-state-fab-ts-"), "kernel"), workspace);
    expect((await local.checkGuard({ kind: "shell.exec", target: command }, "*", [fabricated])).decision).toBe("ask");
    const issued = await local.makeLease("shell.exec", command, 60_000);
    expect((await local.checkGuard({ kind: "shell.exec", target: command }, "*")).leaseId).toBe(issued.leaseId);
    await local.close();

    // Rust over the raw protocol: the `leases` a client sends are not authority;
    // only leases the kernel itself issued are consulted.
    const rust = runKernelNdjson(
      [
        {
          id: 1,
          method: "guard.check",
          params: { action: { kind: "shell.exec", target: command }, scope: "*", leases: [fabricated] },
        },
        { id: 2, method: "guard.lease", params: { kind: "shell.exec", pattern: command, ttlMs: 60_000 } },
        { id: 3, method: "guard.check", params: { action: { kind: "shell.exec", target: command }, scope: "*" } },
      ],
      path.join(tempDir("hz-state-fab-rs-"), "kernel"),
    );
    expect(replyResult<{ decision: string }>(rust.replies, 1).decision).toBe("ask");
    const allowed = replyResult<{ decision: string; leaseId?: string }>(rust.replies, 3);
    const minted = replyResult<Lease>(rust.replies, 2);
    expect(allowed.decision).toBe("allow");
    expect(allowed.leaseId).toBe(minted.leaseId);
  });

  test("a lease is spent by one effect and a grant mints per effect, identically (ruling 32)", async () => {
    const workspace = tempDir("hz-ws-ruling32-i-");
    const stateDir = path.join(tempDir("hz-state-ruling32-i-"), "kernel");
    const command = "echo hi";

    // Rust over the raw protocol, all in one kernel process: one lease admits
    // exactly one effect, and a grant mints a fresh lease per effect.
    const rust = runKernelNdjson(
      [
        { id: 1, method: "guard.lease", params: { kind: "shell.exec", pattern: command, ttlMs: 60_000 } },
        { id: 2, method: "guard.check", params: { action: { kind: "shell.exec", target: command }, scope: "*" } },
        { id: 3, method: "guard.check", params: { action: { kind: "shell.exec", target: command }, scope: "*" } },
        { id: 4, method: "guard.grant", params: { kind: "shell.exec", pattern: command, ttlMs: 60_000 } },
        { id: 5, method: "guard.check", params: { action: { kind: "shell.exec", target: command }, scope: "*" } },
        { id: 6, method: "guard.check", params: { action: { kind: "shell.exec", target: command }, scope: "*" } },
      ],
      stateDir,
    );
    const lease = replyResult<Lease>(rust.replies, 1);
    const first = replyResult<{ decision: string; leaseId?: string }>(rust.replies, 2);
    expect(first.decision).toBe("allow");
    expect(first.leaseId).toBe(lease.leaseId);
    // ...and the spent lease answers nothing a second time.
    expect(replyResult<{ decision: string }>(rust.replies, 3).decision).toBe("ask");
    const grant = replyResult<Lease>(rust.replies, 4);
    const mint1 = replyResult<{ decision: string; leaseId?: string }>(rust.replies, 5);
    const mint2 = replyResult<{ decision: string; leaseId?: string }>(rust.replies, 6);
    expect(mint1.decision).toBe("allow");
    expect(mint2.decision).toBe("allow");
    expect(mint1.leaseId).not.toBe(grant.leaseId);
    expect(mint2.leaseId).not.toBe(mint1.leaseId);

    // The fallback tells the same story with the same calls.
    const local = await localClient(stateDir, workspace);
    const localLease = await local.makeLease("shell.exec", command, 60_000);
    const l1 = await local.checkGuard({ kind: "shell.exec", target: command }, "*");
    expect(l1.decision).toBe("allow");
    expect(l1.leaseId).toBe(localLease.leaseId);
    expect((await local.checkGuard({ kind: "shell.exec", target: command }, "*")).decision).toBe("ask");
    await local.makeGrant("shell.exec", command, 60_000);
    const g1 = await local.checkGuard({ kind: "shell.exec", target: command }, "*");
    const g2 = await local.checkGuard({ kind: "shell.exec", target: command }, "*");
    expect(g1.decision).toBe("allow");
    expect(g2.decision).toBe("allow");
    expect(g1.leaseId).not.toBe(g2.leaseId);
    await local.close();
  });

  test("a traversing stream name is refused by both implementations (finding 15d)", async () => {
    const workspace = tempDir("hz-ws-stream-i-");
    const stream = "session:../../evil";
    const localDir = path.join(tempDir("hz-state-stream-ts-"), "kernel");
    const local = await localClient(localDir, workspace);
    await expect(local.appendEvent(stream, seedFor(stream, EventTypes.sessionStart, { n: 1 }, "st-1"))).rejects.toThrow(
      /stream name is not allowed/,
    );
    // Nothing was created: not the traversal target, and not a sanitized file
    // under the events dir that would silently be a DIFFERENT stream.
    const namesUnder = (dir: string): string[] =>
      existsSync(dir)
        ? readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
            entry.isDirectory() ? namesUnder(path.join(dir, entry.name)) : [entry.name],
          )
        : [];
    expect(namesUnder(path.dirname(localDir)).some((name) => name.includes("evil"))).toBe(false);
    expect(namesUnder(localDir).some((name) => name.includes("evil"))).toBe(false);
    await local.close();

    const rust = runKernelNdjson(
      [{ id: 1, method: "log.append", params: { stream, event: seedFor(stream, EventTypes.sessionStart, { n: 1 }, "st-1") } }],
      path.join(tempDir("hz-state-stream-rs-"), "kernel"),
    );
    expect(rust.replies[0]?.error?.message ?? "").toContain("stream name is not allowed");
  });

  test("a raw client cannot smuggle an unknown kind past the guard (finding 14)", async () => {
    // The audit's exact repro: kind "fs.edit" + a client-supplied lease, aimed
    // at the policy file itself, came back ALLOW because only "fs.write" is
    // keyed into the structural state-dir rule and "fs.edit" was unknown, not
    // refused. Both transports must refuse the KIND before evaluating.
    const stateDir = path.join(tempDir("hz-state-kind-rs-"), "kernel");
    const rust = runKernelNdjson(
      [
        {
          id: 1,
          method: "guard.check",
          params: {
            action: { kind: "fs.edit", target: path.join(stateDir, "policy.json") },
            scope: "outside",
            leases: [{ leaseId: "own", kind: "fs.edit", pattern: "*", expiry: "2099-01-01T00:00:00.000Z" }],
          },
        },
        { id: 2, method: "guard.lease", params: { kind: "fs.edit", pattern: "*", ttlMs: 60_000 } },
      ],
      stateDir,
    );
    expect(rust.replies[0]?.error?.message ?? "").toContain('unknown action kind "fs.edit"');
    expect(rust.replies[1]?.error?.message ?? "").toContain('unknown action kind "fs.edit"');

    // The fallback refuses the same request with the same typed message.
    const workspace = tempDir("hz-ws-kind-i-");
    const local = await localClient(path.join(tempDir("hz-state-kind-ts-"), "kernel"), workspace);
    const refused = await local.checkGuard(
      { kind: "fs.edit", target: path.join(workspace, "..", "policy.json") } as unknown as GuardAction,
      "outside",
    );
    expect(refused.decision).toBe("deny");
    expect(refused.reason ?? "").toContain('unknown action kind "fs.edit"');
    await local.close();
  });
});
