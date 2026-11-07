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
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createHmac } from "node:crypto";
import * as path from "node:path";
import type { EventEnvelope, GuardAction, PolicyScope, Receipt } from "../../src/contracts";
import { EventTypes, canonicalJson } from "../../src/contracts";
import { KernelClient, resolveKernelBinary } from "../../src/core/kernel";
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
});
