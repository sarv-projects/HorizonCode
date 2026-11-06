/**
 * kernel-trusted.test.ts — KernelClient against the Rust trust kernel.
 *
 * Every hash asserted here is recomputed in the test from contracts.ts
 * (canonicalJson + sha256Hex over the frozen field list), and every record is
 * also read back from the state directory with plain JSON.parse, so a passing
 * run means the two implementations agree on disk and in memory.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import type { EventEnvelope, GuardAction, KernelMode, Receipt } from "../../src/contracts";
import { EventTypes, canonicalJson, hashEnvelope } from "../../src/contracts";
import { KernelClient } from "../../src/core/kernel";
import {
  assertEventChain,
  assertReceiptChain,
  cargoKernelVersion,
  cleanupTemps,
  ENVELOPE_KEYS,
  eventFilePath,
  hasRustKernel,
  readJsonl,
  recomputeEventHash,
  recomputeReceiptHash,
  receiptsFilePath,
  restoreEnv,
  rustKernelPath,
  seedFor,
  setEnv,
  snapshotEnv,
  tempDir,
  type EnvSnapshot,
} from "./helpers";

const STREAM = "session:trusted-1";

let envBackup: EnvSnapshot;
let workspace = "";
let stateDir = "";
let client: KernelClient;
const modeChanges: Array<{ mode: KernelMode; reason: string }> = [];
const appended: EventEnvelope[] = [];
const receipts: Receipt[] = [];

describe.skipIf(!hasRustKernel)("KernelClient (trusted, Rust kernel)", () => {
  beforeAll(async () => {
    envBackup = snapshotEnv();
    workspace = tempDir("hz-ws-trusted-");
    stateDir = path.join(tempDir("hz-state-trusted-"), "kernel"); // the kernel creates it
    setEnv({ HZ_KERNEL_BIN: rustKernelPath, HZ_STATE_DIR: undefined });
    client = new KernelClient({
      workspace,
      stateDir,
      onModeChange: (mode, reason) => modeChanges.push({ mode, reason }),
    });
    expect(await client.start()).toBe("trusted");
  });

  afterAll(async () => {
    await client?.close();
    restoreEnv(envBackup);
    cleanupTemps();
  });

  test("reports trusted mode, the resolved binary and a mode-change reason", () => {
    expect(client.mode).toBe("trusted");
    expect(client.binary).toBe(rustKernelPath);
    expect(client.modeReason).toContain("kernel");
    expect(client.modeReason).toContain(rustKernelPath);
    expect(modeChanges).toEqual([{ mode: "trusted", reason: client.modeReason }]);
  });

  test("ping returns the version the crate declares", async () => {
    const pong = await client.ping();
    expect(pong.version).toMatch(/^\d+\.\d+\.\d+/);
    const declared = cargoKernelVersion();
    if (declared) expect(pong.version).toBe(declared);
  });

  test("log.append assigns seq 1, prevHash null and a recomputable hash", async () => {
    const seed = seedFor(STREAM, EventTypes.sessionStart, { workspace, ok: true }, "evt-1");
    const event = await client.appendEvent(STREAM, seed);
    appended.push(event);

    expect(event.seq).toBe(1);
    expect(event.prevHash).toBeNull();
    expect(event.id).toBe("evt-1");
    expect(event.ts).toBe("2026-01-02T03:04:05.006Z");
    expect(event.stream).toBe(STREAM);
    expect(event.type).toBe(EventTypes.sessionStart);
    expect(event.actor).toEqual({ kind: "agent", id: "hzcode-test" });
    expect(event.payload).toEqual({ workspace, ok: true });
    expect(Object.keys(event).sort()).toEqual([...ENVELOPE_KEYS].sort());
    expect(event.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(recomputeEventHash(event)).toBe(event.hash);
    // The same digest the contracts helper produces for the same envelope.
    const { hash, ...rest } = event;
    expect(hashEnvelope(rest)).toBe(hash);

    const file = eventFilePath(stateDir, STREAM);
    expect(existsSync(file)).toBe(true);
    expect(file.endsWith(path.join("events", "session__trusted-1.jsonl"))).toBe(true);
    const onDisk = readJsonl<EventEnvelope>(file);
    expect(onDisk).toEqual(appended);
    expect(canonicalJson(onDisk[0])).toBe(canonicalJson(event));
    assertEventChain(onDisk, "on-disk chain after the first append");
  });

  test("a second and third append chain onto the previous hash", async () => {
    const second = await client.appendEvent(STREAM, seedFor(STREAM, EventTypes.messageStart, { text: "hello" }, "evt-2"));
    const third = await client.appendEvent(STREAM, seedFor(STREAM, EventTypes.messageEnd, { text: "hello" }, "evt-3"));
    appended.push(second, third);

    expect(second.seq).toBe(2);
    expect(second.prevHash).toBe(appended[0].hash);
    expect(third.seq).toBe(3);
    expect(third.prevHash).toBe(second.hash);
    assertEventChain(appended, "appended envelopes");

    const onDisk = readJsonl<EventEnvelope>(eventFilePath(stateDir, STREAM));
    expect(onDisk).toEqual(appended);
    assertEventChain(onDisk, "on-disk chain after three appends");
    // No lockfiles are left behind once the kernel has released its writers.
    expect(existsSync(eventFilePath(stateDir, STREAM) + ".lock")).toBe(false);
  });

  test("log.read honours fromSeq and limit", async () => {
    const all = await client.readEvents(STREAM);
    expect(all.map((event) => event.seq)).toEqual([1, 2, 3]);
    expect(all).toEqual(appended);

    const fromTwo = await client.readEvents(STREAM, 2);
    expect(fromTwo.map((event) => event.seq)).toEqual([2, 3]);

    const window = await client.readEvents(STREAM, 2, 1);
    expect(window.map((event) => event.seq)).toEqual([2]);
    expect(window[0]).toEqual(appended[1]);

    const beyond = await client.readEvents(STREAM, 99);
    expect(beyond).toEqual([]);

    const empty = await client.readEvents("session:never-written");
    expect(empty).toEqual([]);
  });

  test("log.verify accepts the chain and reports the full count", async () => {
    const report = await client.verifyEventChain(STREAM);
    expect(report).toEqual({ ok: true, count: 3 });
    expect(report.brokenAt).toBeUndefined();
  });

  test("log.verify reports a tampered record as broken at its seq", async () => {
    const tamperStream = "session:trusted-tamper";
    const first = await client.appendEvent(tamperStream, seedFor(tamperStream, EventTypes.messageStart, { text: "a" }, "t-1"));
    await client.appendEvent(tamperStream, seedFor(tamperStream, EventTypes.messageEnd, { text: "b" }, "t-2"));
    expect(await client.verifyEventChain(tamperStream)).toEqual({ ok: true, count: 2 });

    const file = eventFilePath(stateDir, tamperStream);
    const lines = readFileSync(file, "utf8").split("\n").filter((line) => line.trim() !== "");
    const tampered = JSON.parse(lines[0]) as EventEnvelope;
    tampered.payload = { text: "tampered" };
    lines[0] = JSON.stringify(tampered);
    writeFileSync(file, lines.join("\n") + "\n");

    expect(recomputeEventHash(tampered)).not.toBe(first.hash);
    expect(await client.verifyEventChain(tamperStream)).toEqual({ ok: false, count: 0, brokenAt: 1 });
  });

  test("receipt.issue chains receipts and receipt.verify accepts them", async () => {
    const base = { action: "tool.execute", tool: "read", argsDigest: "a".repeat(64), resultDigest: "b".repeat(64) };
    const first = await client.issueReceipt({ ...base, tool: "read" });
    const second = await client.issueReceipt({ ...base, tool: "grep" });
    receipts.push(first, second);

    expect(first.seq).toBe(1);
    expect(first.prevHash).toBeNull();
    expect(first.tool).toBe("read");
    expect(first.argsDigest).toBe(base.argsDigest);
    expect(first.resultDigest).toBe(base.resultDigest);
    expect(first.leaseId).toBeUndefined();
    expect(recomputeReceiptHash(first)).toBe(first.hash);
    expect(second.seq).toBe(2);
    expect(second.prevHash).toBe(first.hash);
    expect(recomputeReceiptHash(second)).toBe(second.hash);
    assertReceiptChain(receipts, "issued receipts");
    expect(await client.verifyReceipts()).toEqual({ ok: true, count: 2 });

    const file = receiptsFilePath(stateDir);
    expect(readJsonl<Receipt>(file)).toEqual(receipts);

    const leased = await client.issueReceipt({ ...base, tool: "shell", leaseId: "lease-42" });
    receipts.push(leased);
    expect(leased.seq).toBe(3);
    expect(leased.leaseId).toBe("lease-42");
    expect(recomputeReceiptHash(leased)).toBe(leased.hash);
    assertReceiptChain(receipts, "receipts including one with a lease");
    expect(readJsonl<Receipt>(receiptsFilePath(stateDir))).toEqual(receipts);
    expect(await client.verifyReceipts()).toEqual({ ok: true, count: 3 });
  });

  test("guard.check applies DEFAULT_POLICY with the scope the caller passes", async () => {
    const workspaceFile = path.join(workspace, "notes.txt");
    const outsideFile = "/etc/hosts";

    const readWorkspace = await client.checkGuard({ kind: "fs.read", target: workspaceFile }, "workspace");
    expect(readWorkspace.decision).toBe("allow");

    const writeWorkspace = await client.checkGuard({ kind: "fs.write", target: workspaceFile }, "workspace");
    expect(writeWorkspace.decision).toBe("allow");

    const readOutside = await client.checkGuard({ kind: "fs.read", target: outsideFile }, "outside");
    expect(readOutside.decision).toBe("ask");
    expect(readOutside.reason ?? "").toContain("fs.read");

    const shell = await client.checkGuard({ kind: "shell.exec", target: "rm -rf /" }, "*");
    expect(shell.decision).toBe("ask");
    expect(shell.leaseId).toBeUndefined();

    expect((await client.checkGuard({ kind: "net.fetch", target: "https://example.invalid" }, "*")).decision).toBe("ask");
    expect((await client.checkGuard({ kind: "spawn", target: "/bin/ls" }, "*")).decision).toBe("ask");
  });

  test("guard.lease then guard.check allows the leased command", async () => {
    // An expired caller-supplied lease grants nothing. Asserted BEFORE any lease is
    // issued: once guard.lease ran, the kernel also holds the (unexpired) lease and
    // still honours it - an expired copy cannot revoke it (that is by design, and
    // matches the TS fallback, see kernel.ts active-lease merge).
    const staleLease = {
      leaseId: "expired-lease",
      kind: "shell.exec" as const,
      pattern: "echo *",
      expiry: new Date(Date.now() - 1_000).toISOString(),
    };
    expect((await client.checkGuard({ kind: "shell.exec", target: "echo hi" }, "*", [staleLease])).decision).toBe("ask");

    const lease = await client.makeLease("shell.exec", "echo *", 60_000);
    expect(lease.leaseId).toMatch(/[0-9a-f-]{36}/);
    expect(lease.kind).toBe("shell.exec");
    expect(lease.pattern).toBe("echo *");
    expect(Date.parse(lease.expiry)).toBeGreaterThan(Date.now());

    // Held by the kernel after guard.lease...
    const held = await client.checkGuard({ kind: "shell.exec", target: "echo hi" }, "*");
    expect(held.decision).toBe("allow");
    expect(held.leaseId).toBe(lease.leaseId);

    // ...and honoured when the caller passes it explicitly.
    const passed = await client.checkGuard({ kind: "shell.exec", target: "echo hi" }, "*", [lease]);
    expect(passed.decision).toBe("allow");
    expect(passed.leaseId).toBe(lease.leaseId);

    // A command outside the pattern is still an ask.
    expect((await client.checkGuard({ kind: "shell.exec", target: "rm -rf /tmp" }, "*", [lease])).decision).toBe("ask");
    // A lease for another kind grants nothing.
    expect((await client.checkGuard({ kind: "net.fetch", target: "https://example.invalid" }, "*", [lease])).decision).toBe("ask");

    // (Expired-lease behaviour is asserted at the top of this test, where no
    // lease is held yet.)
  });

  test("a policy.json in the state dir replaces the default policy", async () => {
    const dir = path.join(tempDir("hz-state-policy-"), "kernel");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      path.join(dir, "policy.json"),
      JSON.stringify([
        { kind: "fs.read", scope: "workspace", decision: "deny" },
        { kind: "shell.exec", scope: "*", decision: "allow" },
      ]),
    );
    const policed = new KernelClient({ workspace, stateDir: dir });
    try {
      expect(await policed.start()).toBe("trusted");
      const denied = await policed.checkGuard({ kind: "fs.read", target: path.join(workspace, "a.txt") }, "workspace");
      expect(denied.decision).toBe("deny");
      expect(denied.reason ?? "").toContain("deny");
      expect((await policed.checkGuard({ kind: "shell.exec", target: "echo hi" }, "*")).decision).toBe("allow");
      // Nothing in the file says what to do with a write: no matching rule, so ask.
      expect((await policed.checkGuard({ kind: "fs.write", target: path.join(workspace, "a.txt") }, "workspace")).decision).toBe("ask");
    } finally {
      await policed.close();
    }
  });
});
