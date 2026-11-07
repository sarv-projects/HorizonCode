/**
 * fallback.test.ts — the untrusted path: KernelClient with no Rust binary.
 *
 * HZ_KERNEL_BIN points at a path that does not exist (and, in one case, at a file
 * that is not executable): every method must still work, must say `untrusted`, and
 * must produce the byte-identical file layout the Rust kernel uses.
 */

import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import type { EventEnvelope, KernelMode, Receipt } from "../../src/contracts";
import { EventTypes, canonicalJson } from "../../src/contracts";
import { KernelClient } from "../../src/core/kernel";
import {
  assertEventChain,
  assertReceiptChain,
  cleanupTemps,
  ENVELOPE_KEYS,
  eventFilePath,
  readJsonl,
  readLines,
  RECEIPT_FIELDS,
  recomputeEventHash,
  recomputeReceiptHash,
  receiptPreimage,
  receiptsFilePath,
  restoreEnv,
  seedFor,
  setEnv,
  snapshotEnv,
  tempDir,
  type EnvSnapshot,
} from "./helpers";

const STREAM = "session:fallback-1";
const LOCAL_VERSION = /^local-ts-/;

let envBackup: EnvSnapshot;
let workspace = "";
let stateDir = "";
let missingBinary = "";
let client: KernelClient;
const modeChanges: Array<{ mode: KernelMode; reason: string }> = [];
const appended: EventEnvelope[] = [];
const receipts: Receipt[] = [];

/** Build a fallback client against a fresh temp workspace + state dir. */
async function fallbackClient(): Promise<{ client: KernelClient; workspace: string; stateDir: string }> {
  const workspace = tempDir("hz-ws-fb-");
  const stateDir = path.join(tempDir("hz-state-fb-"), "kernel");
  const kernel = new KernelClient({ workspace, stateDir });
  expect(await kernel.start()).toBe("untrusted");
  return { client: kernel, workspace, stateDir };
}

beforeAll(() => {
  envBackup = snapshotEnv();
  missingBinary = path.join(tempDir("hz-nowhere-"), "hz-kernel");
  expect(existsSync(missingBinary)).toBe(false);
  setEnv({ HZ_KERNEL_BIN: missingBinary, HZ_STATE_DIR: undefined });
});

afterAll(async () => {
  await client?.close();
  restoreEnv(envBackup);
  cleanupTemps();
});

test("a nonexistent HZ_KERNEL_BIN forces the local fallback", async () => {
  workspace = tempDir("hz-ws-fb-main-");
  stateDir = path.join(tempDir("hz-state-fb-main-"), "kernel");
  client = new KernelClient({
    workspace,
    stateDir,
    onModeChange: (mode, reason) => modeChanges.push({ mode, reason }),
  });

  expect(await client.start()).toBe("untrusted");
  expect(client.mode).toBe("untrusted");
  expect(client.binary).toBeUndefined();
  expect(client.modeReason).toContain("HZ_KERNEL_BIN");
  expect(client.modeReason).toContain("local fallback");
  expect(modeChanges).toEqual([{ mode: "untrusted", reason: client.modeReason }]);
});

test("ping answers as the TypeScript kernel, never as the Rust one", async () => {
  const pong = await client.ping();
  expect(pong.version).toMatch(LOCAL_VERSION);
  expect(pong.version).toBe("local-ts-0.1");
});

test("log.append chains and writes the same layout as the Rust kernel", async () => {
  const first = await client.appendEvent(STREAM, seedFor(STREAM, EventTypes.sessionStart, { mode: "fallback" }, "fb-1"));
  appended.push(first);

  expect(first.seq).toBe(1);
  expect(first.prevHash).toBeNull();
  expect(first.id).toBe("fb-1");
  expect(first.ts).toBe("2026-01-02T03:04:05.006Z");
  expect(Object.keys(first).sort()).toEqual([...ENVELOPE_KEYS].sort());
  expect(recomputeEventHash(first)).toBe(first.hash);

  // The contract's own path: state/events/<stream with ':' -> '__'>.jsonl
  const file = eventFilePath(stateDir, STREAM);
  expect(file).toBe(path.join(stateDir, "events", "session__fallback-1.jsonl"));
  expect(existsSync(file)).toBe(true);
  expect(readJsonl<EventEnvelope>(file)).toEqual(appended);
  // The fallback writes canonical JSON, one record per line, with no lock files.
  expect(readLines(file)[0]).toBe(canonicalJson(first));
  expect(existsSync(file + ".lock")).toBe(false);

  for (const [index, type] of [EventTypes.toolCall, EventTypes.toolResult].entries()) {
    appended.push(await client.appendEvent(STREAM, seedFor(STREAM, type, { index }, `fb-${index + 2}`)));
  }
  expect(appended.map((event) => event.seq)).toEqual([1, 2, 3]);
  expect(appended[1].prevHash).toBe(appended[0].hash);
  expect(appended[2].prevHash).toBe(appended[1].hash);
  assertEventChain(appended, "fallback envelopes");
  assertEventChain(readJsonl<EventEnvelope>(eventFilePath(stateDir, STREAM)), "fallback chain on disk");
});

test("log.read, log.verify and the receipts behave like the trusted kernel", async () => {
  expect((await client.readEvents(STREAM)).map((event) => event.seq)).toEqual([1, 2, 3]);
  expect((await client.readEvents(STREAM, 2)).map((event) => event.seq)).toEqual([2, 3]);
  expect((await client.readEvents(STREAM, 2, 1)).map((event) => event.seq)).toEqual([2]);
  // `limit: 0` means zero events, exactly as in the Rust kernel's log.read.
  expect(await client.readEvents(STREAM, 1, 0)).toEqual([]);
  expect(await client.readEvents(STREAM, 99)).toEqual([]);
  expect(await client.verifyEventChain(STREAM)).toEqual({ ok: true, count: 3 });

  const base = { action: "tool.execute", tool: "read", argsDigest: "c".repeat(64), resultDigest: "d".repeat(64) };
  const first = await client.issueReceipt(base);
  const leased = await client.issueReceipt({ ...base, tool: "shell", leaseId: "lease-7" });
  receipts.push(first, leased);

  expect(first.seq).toBe(1);
  expect(first.prevHash).toBeNull();
  expect(first.leaseId).toBeUndefined();
  expect(Object.keys(receiptPreimage(first)).sort()).toEqual([...RECEIPT_FIELDS].sort());
  expect(recomputeReceiptHash(first)).toBe(first.hash);
  expect(leased.seq).toBe(2);
  expect(leased.prevHash).toBe(first.hash);
  expect(leased.leaseId).toBe("lease-7");
  expect(recomputeReceiptHash(leased)).toBe(leased.hash);
  assertReceiptChain(receipts, "fallback receipts");
  expect(await client.verifyReceipts()).toEqual({ ok: true, count: 2 });

  const file = receiptsFilePath(stateDir);
  expect(file).toBe(path.join(stateDir, "receipts.jsonl"));
  expect(readJsonl<Receipt>(file)).toEqual(receipts);
  const lines = readLines(file);
  expect(lines[0]).toBe(canonicalJson(first));
  // A receipt without a lease must not carry an `undefined` leaseId onto disk.
  expect(Object.keys(JSON.parse(lines[0]) as object).sort()).toEqual([...RECEIPT_FIELDS, "hash"].sort());
});

test("guard.check applies DEFAULT_POLICY and guard.lease unlocks a command", async () => {
  expect((await client.checkGuard({ kind: "fs.read", target: path.join(workspace, "a.txt") }, "workspace")).decision).toBe("allow");
  expect((await client.checkGuard({ kind: "fs.write", target: path.join(workspace, "a.txt") }, "workspace")).decision).toBe("allow");
  expect((await client.checkGuard({ kind: "fs.read", target: "/etc/hosts" }, "outside")).decision).toBe("ask");
  expect((await client.checkGuard({ kind: "shell.exec", target: "rm -rf /" }, "*")).decision).toBe("ask");
  expect((await client.checkGuard({ kind: "net.fetch", target: "https://example.invalid" }, "*")).decision).toBe("ask");
  expect((await client.checkGuard({ kind: "spawn", target: "/bin/ls" }, "*")).decision).toBe("ask");

  // An expired caller-supplied lease grants nothing while none is held.
  const stale = { leaseId: "stale-1", kind: "spawn" as const, pattern: "*", expiry: new Date(Date.now() - 1_000).toISOString() };
  expect((await client.checkGuard({ kind: "spawn", target: "/bin/ls" }, "*", [stale])).decision).toBe("ask");

  const lease = await client.makeLease("shell.exec", "echo *", 60_000);
  expect(lease.pattern).toBe("echo *");
  const held = await client.checkGuard({ kind: "shell.exec", target: "echo hi" }, "*");
  expect(held.decision).toBe("allow");
  expect(held.leaseId).toBe(lease.leaseId);
  const passed = await client.checkGuard({ kind: "shell.exec", target: "echo hi" }, "*", [lease]);
  expect(passed.decision).toBe("allow");
  expect(passed.leaseId).toBe(lease.leaseId);
  expect((await client.checkGuard({ kind: "shell.exec", target: "rm -rf /tmp" }, "*", [lease])).decision).toBe("ask");
});

test("two fallback writers on one state dir never collide on seq", async () => {
  const shared = path.join(tempDir("hz-state-shared-"), "kernel");
  const workspaceA = tempDir("hz-ws-a-");
  const workspaceB = tempDir("hz-ws-b-");
  const a = new KernelClient({ workspace: workspaceA, stateDir: shared });
  const b = new KernelClient({ workspace: workspaceB, stateDir: shared });
  try {
    expect(await a.start()).toBe("untrusted");
    expect(await b.start()).toBe("untrusted");

    const stream = "session:shared";
    const e1 = await a.appendEvent(stream, seedFor(stream, EventTypes.messageStart, { n: 1 }, "sh-1"));
    const e2 = await b.appendEvent(stream, seedFor(stream, EventTypes.messageDelta, { n: 2 }, "sh-2"));
    const e3 = await a.appendEvent(stream, seedFor(stream, EventTypes.messageEnd, { n: 3 }, "sh-3"));

    expect([e1.seq, e2.seq, e3.seq]).toEqual([1, 2, 3]);
    expect(e2.prevHash).toBe(e1.hash);
    expect(e3.prevHash).toBe(e2.hash);
    const onDisk = readJsonl<EventEnvelope>(eventFilePath(shared, stream));
    expect(onDisk).toEqual([e1, e2, e3]);
    assertEventChain(onDisk, "interleaved writers");
    expect(await a.verifyEventChain(stream)).toEqual({ ok: true, count: 3 });
    expect(await b.verifyEventChain(stream)).toEqual({ ok: true, count: 3 });
    expect((await b.readEvents(stream)).map((event) => event.seq)).toEqual([1, 2, 3]);

    const r1 = await a.issueReceipt({ action: "tool.execute", tool: "read", argsDigest: "1".repeat(64), resultDigest: "2".repeat(64) });
    const r2 = await b.issueReceipt({ action: "tool.execute", tool: "grep", argsDigest: "3".repeat(64), resultDigest: "4".repeat(64) });
    const r3 = await a.issueReceipt({ action: "tool.execute", tool: "shell", argsDigest: "5".repeat(64), resultDigest: "6".repeat(64) });
    expect([r1.seq, r2.seq, r3.seq]).toEqual([1, 2, 3]);
    assertReceiptChain(readJsonl<Receipt>(receiptsFilePath(shared)), "interleaved receipts");
    expect(await b.verifyReceipts()).toEqual({ ok: true, count: 3 });
  } finally {
    await a.close();
    await b.close();
  }
});

test("a fresh fallback client continues a chain written by another instance", async () => {
  const stream = STREAM;
  const fresh = new KernelClient({ workspace, stateDir });
  try {
    expect(await fresh.start()).toBe("untrusted");
    const next = await fresh.appendEvent(stream, seedFor(stream, EventTypes.sessionEnd, { done: true }, "fb-4"));
    expect(next.seq).toBe(4);
    expect(next.prevHash).toBe(appended[2].hash);
    expect(await fresh.verifyEventChain(stream)).toEqual({ ok: true, count: 4 });
    expect(recomputeEventHash(next)).toBe(next.hash);
  } finally {
    await fresh.close();
  }
});

test("a binary that exists but cannot be executed falls back too", async () => {
  const badBinary = path.join(tempDir("hz-bad-bin-"), "hz-kernel");
  writeFileSync(badBinary, "this is not an executable\n");
  expect(existsSync(badBinary)).toBe(true);
  setEnv({ HZ_KERNEL_BIN: badBinary });

  const workspace = tempDir("hz-ws-bad-");
  const stateDir = path.join(tempDir("hz-state-bad-"), "kernel");
  const changes: KernelMode[] = [];
  const kernel = new KernelClient({ workspace, stateDir, onModeChange: (mode) => changes.push(mode) });
  try {
    expect(await kernel.start()).toBe("untrusted");
    expect(kernel.mode).toBe("untrusted");
    expect(kernel.binary).toBeUndefined();
    expect(kernel.modeReason).toContain("local fallback");
    expect(kernel.modeReason).toMatch(/start failed|process error/);
    if (changes.length > 0) expect(changes).toContain("untrusted");

    const stream = "session:bad-bin";
    const event = await kernel.appendEvent(stream, seedFor(stream, EventTypes.sessionStart, {}, "bad-1"));
    expect(event.seq).toBe(1);
    expect(await kernel.verifyEventChain(stream)).toEqual({ ok: true, count: 1 });
    assertEventChain(readJsonl<EventEnvelope>(eventFilePath(stateDir, stream)), "chain after a failed spawn");
  } finally {
    await kernel.close();
    setEnv({ HZ_KERNEL_BIN: missingBinary });
  }
});

test("an unstarted client answers from the local kernel", async () => {
  const workspace = tempDir("hz-ws-idle-");
  const stateDir = path.join(tempDir("hz-state-idle-"), "kernel");
  const idle = new KernelClient({ workspace, stateDir });
  try {
    expect(idle.mode).toBe("untrusted");
    expect(idle.modeReason).toContain("local fallback");
    const stream = "session:idle";
    const event = await idle.appendEvent(stream, seedFor(stream, EventTypes.messageStart, { idle: true }, "idle-1"));
    expect(event.seq).toBe(1);
    expect((await idle.ping()).version).toMatch(LOCAL_VERSION);
    expect(await idle.verifyEventChain(stream)).toEqual({ ok: true, count: 1 });
    expect(existsSync(eventFilePath(stateDir, stream))).toBe(true);
  } finally {
    await idle.close();
  }
});

test("tail truncation is detected and the truncated chain cannot be extended", async () => {
  const { client: fresh, stateDir: dir } = await fallbackClient();
  const stream = "session:anchor-fallback";
  const appended: EventEnvelope[] = [];
  for (const [index, type] of [EventTypes.sessionStart, EventTypes.messageStart, EventTypes.messageEnd].entries()) {
    appended.push(await fresh.appendEvent(stream, seedFor(stream, type, { index }, `an-${index + 1}`)));
  }
  expect(await fresh.verifyEventChain(stream)).toEqual({ ok: true, count: 3 });

  // the anchor beside the log names the last record
  const headFile = eventFilePath(dir, stream) + ".head";
  const anchor = JSON.parse(readLines(headFile)[0] as string) as { hash: string; seq: number };
  expect(anchor).toEqual({ hash: appended[2]?.hash, seq: 3 });

  // deleting whole trailing records used to verify clean; now the anchor sees it
  const file = eventFilePath(dir, stream);
  const lines = readLines(file);
  writeFileSync(file, lines.slice(0, -1).join("\n") + "\n");
  expect(await fresh.verifyEventChain(stream)).toEqual({ ok: false, count: 2, brokenAt: 3 });
  await expect(fresh.appendEvent(stream, seedFor(stream, EventTypes.error, { index: 4 }, "an-4"))).rejects.toThrow(/anchor/);
  expect(readLines(file).length).toBe(2);
  await fresh.close();
});
