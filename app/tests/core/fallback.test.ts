/**
 * fallback.test.ts — the untrusted path: KernelClient with no Rust binary.
 *
 * HZ_KERNEL_BIN points at a path that does not exist (and, in one case, at a file
 * that is not executable): every method must still work, must say `untrusted`, and
 * must produce the byte-identical file layout the Rust kernel uses.
 */

import { afterAll, beforeAll, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createHmac } from "node:crypto";
import * as path from "node:path";
import type { EventEnvelope, GuardAction, KernelMode, Receipt } from "../../src/contracts";
import { EventTypes, canonicalJson } from "../../src/contracts";
import { KernelClient, LocalKernel } from "../../src/core/kernel";
import {
  assertEventChain,
  assertReceiptChain,
  cleanupTemps,
  ENVELOPE_KEYS,
  eventFilePath,
  eventPreimage,
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
  permissionBitsBind,
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
  // Ruling 32: the lease is spent by that one allow — a second identical check
  // is not admitted by it, whether held or echoed back as a caller-supplied
  // claim (the claim was already never authority).
  const spent = await client.checkGuard({ kind: "shell.exec", target: "echo hi" }, "*", [lease]);
  expect(spent.decision).toBe("ask");
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

test("an ask rule beats a matching allow rule in the fallback (docs/11 R1)", async () => {
  const dir = path.join(tempDir("hz-state-ask-order-"), "kernel");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, "policy.json"),
    JSON.stringify([
      { kind: "shell.exec", scope: "*", decision: "allow" },
      { kind: "shell.exec", scope: "*", decision: "ask" },
      // ask declared after allow and before allow, both ways
      { kind: "net.fetch", scope: "*", decision: "ask" },
      { kind: "net.fetch", scope: "*", decision: "allow" },
    ]),
  );
  const kernel = new KernelClient({ workspace: tempDir("hz-ws-ask-order-"), stateDir: dir });
  try {
    expect(await kernel.start()).toBe("untrusted");
    expect((await kernel.checkGuard({ kind: "shell.exec", target: "echo hi" }, "*")).decision).toBe("ask");
    expect((await kernel.checkGuard({ kind: "net.fetch", target: "https://example.invalid" }, "*")).decision).toBe("ask");
    // lease semantics are unchanged: an unexpired matching lease still allows
    const lease = await kernel.makeLease("shell.exec", "echo *", 60_000);
    const held = await kernel.checkGuard({ kind: "shell.exec", target: "echo hi" }, "*");
    expect(held.decision).toBe("allow");
    expect(held.leaseId).toBe(lease.leaseId);
  } finally {
    await kernel.close();
  }
});

test("keyed anchors are HMAC over the preimage and fail closed on the wrong key (fallback)", async () => {
  const key = "6f".repeat(32);
  const wrongKey = "22".repeat(32);
  const stateDir = path.join(tempDir("hz-state-keyed-fb-"), "kernel");
  const workspace = tempDir("hz-ws-keyed-fb-");
  const stream = "session:keyed-fallback";
  const hmac = (keyHex: string, preimage: Record<string, unknown>): string =>
    createHmac("sha256", Buffer.from(keyHex, "hex")).update(canonicalJson(preimage), "utf8").digest("hex");

  setEnv({ HZ_ANCHOR_KEY: key, HZ_ACCEPT_LEGACY_ANCHORS: undefined });
  try {
    const keyed = new KernelClient({ workspace, stateDir });
    expect(await keyed.start()).toBe("untrusted");
    const events = [
      await keyed.appendEvent(stream, seedFor(stream, EventTypes.sessionStart, { n: 1 }, "kf-1")),
      await keyed.appendEvent(stream, seedFor(stream, EventTypes.messageEnd, { n: 2 }, "kf-2")),
    ];
    const receipt = await keyed.issueReceipt({
      action: "tool.execute",
      tool: "read",
      argsDigest: "1".repeat(64),
      resultDigest: "2".repeat(64),
    });
    expect(await keyed.verifyEventChain(stream)).toEqual({ ok: true, count: 2 });
    expect(await keyed.verifyReceipts()).toEqual({ ok: true, count: 1 });

    // anchors store HMAC(key, canonical preimage) — never the record hash
    const head = JSON.parse(readLines(eventFilePath(stateDir, stream) + ".head")[0] as string) as { hash: string; seq: number };
    expect(head).toEqual({ hash: hmac(key, eventPreimage(events[1]!)), seq: 2 });
    expect(head.hash).not.toBe(events[1]!.hash);
    expect(events[1]!.hash).toBe(recomputeEventHash(events[1]!));
    const rhead = JSON.parse(readLines(receiptsFilePath(stateDir) + ".head")[0] as string) as { hash: string; seq: number };
    expect(rhead).toEqual({ hash: hmac(key, receiptPreimage(receipt)), seq: 1 });

    // a fresh keyed client continues the chain with keyed anchors
    const fresh = new KernelClient({ workspace, stateDir });
    expect(await fresh.start()).toBe("untrusted");
    const third = await fresh.appendEvent(stream, seedFor(stream, EventTypes.sessionEnd, { n: 3 }, "kf-3"));
    expect(third.seq).toBe(3);
    expect(await fresh.verifyEventChain(stream)).toEqual({ ok: true, count: 3 });
    await fresh.close();
    await keyed.close();

    // wrong key: tamper verdict on verify, refusal on append
    setEnv({ HZ_ANCHOR_KEY: wrongKey });
    const wrong = new KernelClient({ workspace, stateDir });
    expect(await wrong.start()).toBe("untrusted");
    expect(await wrong.verifyEventChain(stream)).toEqual({ ok: false, count: 3, brokenAt: 3 });
    await expect(wrong.appendEvent(stream, seedFor(stream, EventTypes.error, { n: 4 }, "kf-4"))).rejects.toThrow(/disagrees with its anchor/);
    await wrong.close();

    // deleted anchor: the keyed material is gone, so verification fails closed
    setEnv({ HZ_ANCHOR_KEY: key });
    rmSync(eventFilePath(stateDir, stream) + ".head");
    const missing = new KernelClient({ workspace, stateDir });
    expect(await missing.start()).toBe("untrusted");
    await expect(missing.verifyEventChain(stream)).rejects.toThrow(/HZ_PRECONDITION_FAILED: legacy \(unkeyed\) anchor/);
    await expect(missing.verifyEventChain(stream)).rejects.toThrow(/no anchor/);
    await missing.close();
  } finally {
    setEnv({ HZ_ANCHOR_KEY: undefined, HZ_ACCEPT_LEGACY_ANCHORS: undefined });
  }
});

test("a legacy anchor is refused while keyed unless HZ_ACCEPT_LEGACY_ANCHORS=1 (fallback)", async () => {
  const key = "7c".repeat(32);
  const stateDir = path.join(tempDir("hz-state-legacy-fb-"), "kernel");
  const workspace = tempDir("hz-ws-legacy-fb-");
  const stream = "session:legacy-fallback";

  // unkeyed first: the shipped default, anchor hash == record hash
  const plain = new KernelClient({ workspace, stateDir });
  expect(await plain.start()).toBe("untrusted");
  const plainEvent = await plain.appendEvent(stream, seedFor(stream, EventTypes.sessionStart, { n: 1 }, "lg-1"));
  const plainHead = JSON.parse(readLines(eventFilePath(stateDir, stream) + ".head")[0] as string) as { hash: string; seq: number };
  expect(plainHead).toEqual({ hash: plainEvent.hash, seq: 1 });
  await plain.close();

  setEnv({ HZ_ANCHOR_KEY: key });
  try {
    const strict = new KernelClient({ workspace, stateDir });
    expect(await strict.start()).toBe("untrusted");
    await expect(strict.verifyEventChain(stream)).rejects.toThrow(/HZ_PRECONDITION_FAILED: legacy \(unkeyed\) anchor/);
    await expect(strict.appendEvent(stream, seedFor(stream, EventTypes.sessionEnd, { n: 2 }, "lg-2"))).rejects.toThrow(/legacy \(unkeyed\) anchor/);
    expect(readLines(eventFilePath(stateDir, stream)).length).toBe(1);
    await strict.close();

    // explicit opt-in accepts the legacy anchor and the next append re-anchors keyed
    setEnv({ HZ_ACCEPT_LEGACY_ANCHORS: "1" });
    const accepting = new KernelClient({ workspace, stateDir });
    expect(await accepting.start()).toBe("untrusted");
    expect(await accepting.verifyEventChain(stream)).toEqual({ ok: true, count: 1 });
    const appended = await accepting.appendEvent(stream, seedFor(stream, EventTypes.sessionEnd, { n: 2 }, "lg-2"));
    expect(appended.seq).toBe(2);
    await accepting.close();

    setEnv({ HZ_ACCEPT_LEGACY_ANCHORS: undefined });
    const recheck = new KernelClient({ workspace, stateDir });
    expect(await recheck.start()).toBe("untrusted");
    expect(await recheck.verifyEventChain(stream)).toEqual({ ok: true, count: 2 });
    await recheck.close();
  } finally {
    setEnv({ HZ_ANCHOR_KEY: undefined, HZ_ACCEPT_LEGACY_ANCHORS: undefined });
  }
});

test("a malformed HZ_ANCHOR_KEY is refused, never silently unkeyed (fallback)", () => {
  setEnv({ HZ_ANCHOR_KEY: "not-a-hex-key" });
  try {
    expect(
      () => new KernelClient({ workspace: tempDir("hz-ws-badkey-"), stateDir: path.join(tempDir("hz-state-badkey-"), "kernel") }),
    ).toThrow(/HZ_ANCHOR_KEY must be an even-length hex string/);
  } finally {
    setEnv({ HZ_ANCHOR_KEY: undefined });
  }
});

test("the fallback tightens a pre-existing loose state dir to 0700/0600 (Unix)", async () => {
  if (process.platform === "win32") return;
  const stateDir = path.join(tempDir("hz-state-modes-fb-"), "kernel");
  const eventsDir = path.join(stateDir, "events");
  const stream = "session:modes-fallback";
  const chain = eventFilePath(stateDir, stream);
  // A state dir left world-readable by an earlier tool (or an older build): the
  // fallback must tighten it, not inherit its laxity.
  mkdirSync(eventsDir, { recursive: true });
  chmodSync(stateDir, 0o755);
  chmodSync(eventsDir, 0o755);
  writeFileSync(chain, "", "utf8");
  chmodSync(chain, 0o644);

  const kernel = new KernelClient({ workspace: tempDir("hz-ws-modes-fb-"), stateDir });
  try {
    expect(await kernel.start()).toBe("untrusted");
    await kernel.appendEvent(stream, seedFor(stream, EventTypes.sessionStart, { n: 1 }, "md-1"));
    await kernel.issueReceipt({
      action: "tool.execute",
      tool: "read",
      argsDigest: "aa".repeat(32),
      resultDigest: "bb".repeat(32),
    });
  } finally {
    await kernel.close();
  }
  const mode = (file: string): number => statSync(file).mode & 0o777;
  expect(mode(stateDir), "state dir").toBe(0o700);
  expect(mode(eventsDir), "events dir").toBe(0o700);
  expect(mode(chain), "event stream").toBe(0o600);
  expect(mode(`${chain}.head`), "event anchor").toBe(0o600);
  expect(mode(receiptsFilePath(stateDir)), "receipts").toBe(0o600);
  expect(mode(`${receiptsFilePath(stateDir)}.head`), "receipts anchor").toBe(0o600);
});

test.skipIf(!permissionBitsBind)("an unreadable receipts chain refuses the append and leaves the bytes alone", async () => {
  const stateDir = path.join(tempDir("hz-state-rread-fb-"), "kernel");
  const workspace = tempDir("hz-ws-rread-fb-");
  const receipts = receiptsFilePath(stateDir);
  const writer = new KernelClient({ workspace, stateDir });
  expect(await writer.start()).toBe("untrusted");
  await writer.issueReceipt({
    action: "tool.execute",
    tool: "read",
    argsDigest: "cc".repeat(32),
    resultDigest: "dd".repeat(32),
  });
  const before = readFileSync(receipts, "utf8");

  chmodSync(receipts, 0o200);
  try {
    const reader = new KernelClient({ workspace, stateDir });
    expect(await reader.start()).toBe("untrusted");
    await expect(
      reader.issueReceipt({ action: "tool.execute", tool: "grep", argsDigest: "ee".repeat(32), resultDigest: "ff".repeat(32) }),
    ).rejects.toThrow(/cannot read/);
    await reader.close();
  } finally {
    chmodSync(receipts, 0o600);
  }
  expect(readFileSync(receipts, "utf8")).toBe(before);
  expect(readJsonl<Receipt>(receipts).map((receipt) => receipt.seq)).toEqual([1]);
  await writer.close();
});

test("the local kernel reloads policy.json per check and refuses unknown kinds (findings 12/14)", async () => {
  const stateDir = path.join(tempDir("hz-state-lk-fb-"), "kernel");
  const workspace = tempDir("hz-ws-lk-fb-");
  mkdirSync(stateDir, { recursive: true });
  const policy = path.join(stateDir, "policy.json");
  const kernel = new LocalKernel({ stateDir, workspace });
  const target = path.join(workspace, "a.txt");

  expect((await kernel.checkGuard({ kind: "fs.write", target }, "workspace")).decision).toBe("allow");
  // Tighten the policy mid-session: the next check must see it (the local
  // kernel used to cache policy.json at construction while Rust reloads it
  // before every check — a deny-vs-allow divergence in fallback mode).
  writeFileSync(policy, JSON.stringify([{ kind: "fs.write", scope: "workspace", decision: "deny" }]), "utf8");
  expect((await kernel.checkGuard({ kind: "fs.write", target }, "workspace")).decision).toBe("deny");
  rmSync(policy);
  expect((await kernel.checkGuard({ kind: "fs.write", target }, "workspace")).decision).toBe("allow");

  // A kind outside the closed TS vocabulary is refused BEFORE evaluation: the
  // structural state-dir rule is keyed to fs.write, so an unknown mutating
  // spelling must never fall through the policy to "allow".
  const unknown = await kernel.checkGuard(
    { kind: "fs.edit", target: path.join(stateDir, "policy.json") } as unknown as GuardAction,
    "outside",
  );
  expect(unknown.decision).toBe("deny");
  expect(unknown.reason ?? "").toMatch(/HZ_PRECONDITION_FAILED: unknown action kind "fs\.edit"/);
  await kernel.close();
});
