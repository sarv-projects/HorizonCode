import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import {
  SPEND_LEDGER_FILE,
  SpendLedger,
  SpendLedgerError,
  SpendLimitError,
  microToUsd,
  spendLimitMicroFromEnv,
  usdToMicro,
} from "../../src/core/spend-ledger";

const roots: string[] = [];
function workspace(): string {
  const dir = path.join(tmpdir(), `hz-spend-${process.pid}-${Math.random().toString(16).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  roots.push(dir);
  return dir;
}
afterEach(() => {
  for (const root of roots.splice(0)) {
    try {
      require("node:fs").rmSync(root, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
});

describe("spend ledger", () => {
  test("reserves, refuses over the ceiling, settles actual and reports remaining", () => {
    const ws = workspace();
    const ledger = new SpendLedger(ws, { limitMicroUsd: usdToMicro(10) });
    const first = ledger.reserve(4, { sessionId: "s1", runId: "r1" });
    expect(first.amountMicroUsd).toBe(usdToMicro(4));
    expect(ledger.status()).toMatchObject({
      limitUsd: 10,
      spentUsd: 0,
      reservedUsd: 4,
      remainingUsd: 6,
      reservations: 1,
    });

    const second = ledger.reserve(6);
    expect(second.amountMicroUsd).toBe(usdToMicro(6));
    expect(() => ledger.reserve(0.5)).toThrow(SpendLimitError);

    const after = ledger.settle(first.id, 3.25);
    expect(after.spentUsd).toBe(3.25);
    expect(after.reservedUsd).toBe(6);
    expect(after.remainingUsd).toBeCloseTo(0.75, 6);

    ledger.release(second.id);
    expect(ledger.status()).toMatchObject({ spentUsd: 3.25, reservedUsd: 0, remainingUsd: 6.75 });
  });

  test("settle is exactly-once and unknown ids are typed refusals", () => {
    const ws = workspace();
    const ledger = new SpendLedger(ws, { limitMicroUsd: usdToMicro(10) });
    const r = ledger.reserve(1);
    ledger.settle(r.id, 0.75);
    expect(() => ledger.settle(r.id, 0.75)).toThrow(SpendLedgerError);
    expect(() => ledger.release(r.id)).toThrow(SpendLedgerError);
    expect(ledger.status().spentUsd).toBe(0.75);
  });

  test("a corrupt ledger is a refusal, never a clean zero", () => {
    const ws = workspace();
    const ledger = new SpendLedger(ws, { limitMicroUsd: usdToMicro(10) });
    ledger.reserve(1);
    const file = path.join(ws, ".hz", "state", SPEND_LEDGER_FILE);
    writeFileSync(file, "{ this is not json", "utf8");
    expect(() => ledger.status()).toThrow(SpendLedgerError);
    expect(() => ledger.reserve(1)).toThrow(SpendLedgerError);
  });

  test("an expired reservation is charged, not silently released", () => {
    const ws = workspace();
    const ledger = new SpendLedger(ws, { limitMicroUsd: usdToMicro(10), ttlMs: 1 });
    const r = ledger.reserve(2);
    expect(r.id).toStartWith("spend-");
    const file = path.join(ws, ".hz", "state", SPEND_LEDGER_FILE);
    const record = JSON.parse(readFileSync(file, "utf8"));
    record.reservations[0].expiresAt = new Date(Date.now() - 1000).toISOString();
    writeFileSync(file, JSON.stringify(record), "utf8");
    const status = ledger.status();
    expect(status.spentUsd).toBe(2);
    expect(status.reservations).toBe(0);
    expect(() => ledger.settle(r.id, 2)).toThrow(SpendLedgerError);
  });

  test("state file is owner-only and micro-USD helpers round-trip", () => {
    const ws = workspace();
    const ledger = new SpendLedger(ws, { limitMicroUsd: usdToMicro(1) });
    ledger.reserve(0.1);
    const file = path.join(ws, ".hz", "state", SPEND_LEDGER_FILE);
    if (process.platform !== "win32") expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(usdToMicro(1.234567)).toBe(1_234_567);
    expect(microToUsd(1_234_567)).toBe(1.234567);
  });

  test("env ceiling parsing is conservative", () => {
    expect(spendLimitMicroFromEnv({ HZ_SPEND_LIMIT_USD: "2.50" })).toBe(2_500_000);
    expect(spendLimitMicroFromEnv({ HZ_SPEND_LIMIT_USD: "0" })).toBe(0);
    expect(spendLimitMicroFromEnv({ HZ_SPEND_LIMIT_USD: "nope" })).toBe(0);
    expect(spendLimitMicroFromEnv({})).toBe(0);
  });

  test("two ledger instances share the ceiling through the lockfile", () => {
    const ws = workspace();
    const a = new SpendLedger(ws, { limitMicroUsd: usdToMicro(5) });
    const b = new SpendLedger(ws, { limitMicroUsd: usdToMicro(5) });
    a.reserve(3);
    expect(() => b.reserve(3)).toThrow(SpendLimitError);
    expect(b.status().reservedUsd).toBe(3);
  });
});
