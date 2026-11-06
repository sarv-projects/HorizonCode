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
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import type { EventEnvelope, GuardAction, PolicyScope, Receipt } from "../../src/contracts";
import { EventTypes, canonicalJson } from "../../src/contracts";
import { KernelClient, resolveKernelBinary } from "../../src/core/kernel";
import {
  assertEventChain,
  assertReceiptChain,
  cleanupTemps,
  eventFilePath,
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
    ];
    for (const [action, scope] of cases) {
      const [fromRust, fromLocal] = await Promise.all([rust.checkGuard(action, scope), local.checkGuard(action, scope)]);
      expect(fromLocal.decision, `${action.kind} @ ${scope}`).toBe(fromRust.decision);
    }
    expect((await rust.checkGuard({ kind: "fs.read", target: path.join(workspace, "a.txt") }, "workspace")).decision).toBe("allow");
    expect((await local.checkGuard({ kind: "fs.read", target: path.join(workspace, "a.txt") }, "workspace")).decision).toBe("allow");
    expect((await rust.checkGuard({ kind: "ssh.exec" as GuardAction["kind"], target: "x" }, "*")).decision).toBe("ask");
    expect((await local.checkGuard({ kind: "ssh.exec" as GuardAction["kind"], target: "x" }, "*")).decision).toBe("ask");

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
    ];
    for (const [action, scope, expected] of cases) {
      const [fromRust, fromLocal] = await Promise.all([rust.checkGuard(action, scope), local.checkGuard(action, scope)]);
      expect(fromRust.decision, `rust ${action.kind} @ ${scope}`).toBe(expected);
      expect(fromLocal.decision, `local ${action.kind} @ ${scope}`).toBe(expected);
    }
    await rust.close();
    await local.close();
  });
});
