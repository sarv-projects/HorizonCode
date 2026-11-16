/**
 * spend-ledger.ts — the durable, lock-guarded spend ceiling (backlog C-5).
 *
 * The per-run BudgetLedger bounds steps/tokens/wall-clock for one turn. It
 * cannot bound *money across concurrent runs*: two `hzcode` processes, a batch
 * runner and a TUI, or a server with several sessions can each stay inside their
 * own budget while the workspace as a whole spends far more than the human
 * authorised. This ledger is the workspace-wide ceiling:
 *
 *   - a reservation is taken BEFORE a provider call is dispatched;
 *   - the reservation is settled with the provider's reported cost afterwards
 *     (or converted conservatively to "spent" if the process dies);
 *   - every read-modify-write is serialized by the same cross-process lockfile
 *     used for files and state, so two processes cannot both pass the check;
 *   - a corrupt ledger is a typed refusal, never a silent reset to zero (a
 *     clean-looking zero is the one value that can authorize unbounded spend).
 *
 * Units are integer micro-USD, because floating-point dollars must not decide a
 * ceiling. `HZ_SPEND_LIMIT_USD` sets the ceiling (0/absent = no ceiling, but
 * spend is still recorded for `status`).
 *
 * Residuals, named: the estimate is the caller's (the loop reserves the
 * worst-case output cost from the catalog; provider discounts/reasoning tokens
 * can make the actual differ); a crashed reservation is charged in full after
 * its TTL rather than guessed from partial work; the ledger is per workspace,
 * not per human identity.
 */

import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { withFileLockSync } from "./file-lock";
import { chmodPrivateFile, ensurePrivateDir, workspaceStateDir } from "./paths";

export const SPEND_LEDGER_VERSION = 1 as const;
export const SPEND_LEDGER_FILE = "spend.json";
export const SPEND_LOCK_FILE = "spend.lock";
/** A reservation that was never settled is charged after this long. */
export const DEFAULT_RESERVATION_TTL_MS = 60 * 60 * 1000;

export class SpendLedgerError extends Error {
  readonly code: string;
  constructor(code: "corrupt" | "limit" | "unknown-reservation" | "invalid", message: string) {
    super(message);
    this.name = "SpendLedgerError";
    this.code = code;
  }
}

export class SpendLimitError extends SpendLedgerError {
  constructor(
    readonly limitMicroUsd: number,
    readonly spentMicroUsd: number,
    readonly reservedMicroUsd: number,
    readonly requestedMicroUsd: number,
  ) {
    super(
      "limit",
      `HZ_SPEND_LIMIT: the workspace spend ceiling would be exceeded ` +
        `(limit $${microToUsd(limitMicroUsd).toFixed(2)}, spent $${microToUsd(spentMicroUsd).toFixed(2)}, ` +
        `reserved $${microToUsd(reservedMicroUsd).toFixed(2)}, requested $${microToUsd(requestedMicroUsd).toFixed(2)})`,
    );
  }
}

export interface SpendReservation {
  id: string;
  amountMicroUsd: number;
  at: string;
  expiresAt: string;
  sessionId?: string;
  runId?: string;
  note?: string;
}

export interface SpendLedgerRecord {
  v: typeof SPEND_LEDGER_VERSION;
  limitMicroUsd: number;
  spentMicroUsd: number;
  reservations: SpendReservation[];
  updatedAt: string;
}

export interface SpendStatus {
  limitUsd: number;
  spentUsd: number;
  reservedUsd: number;
  remainingUsd: number;
  reservations: number;
  updatedAt: string;
}

export function usdToMicro(usd: number): number {
  if (!Number.isFinite(usd) || usd < 0) {
    throw new SpendLedgerError("invalid", `spend: invalid USD amount ${String(usd)}`);
  }
  return Math.round(usd * 1_000_000);
}

export function microToUsd(micro: number): number {
  return micro / 1_000_000;
}

/** `HZ_SPEND_LIMIT_USD`: >0 finite is a ceiling; 0/absent/unreadable is off. */
export function spendLimitMicroFromEnv(env: Record<string, string | undefined> = process.env): number {
  const raw = env.HZ_SPEND_LIMIT_USD;
  if (typeof raw !== "string" || raw.trim() === "") return 0;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) return 0;
  return usdToMicro(value);
}

function emptyRecord(limitMicroUsd: number): SpendLedgerRecord {
  return {
    v: SPEND_LEDGER_VERSION,
    limitMicroUsd,
    spentMicroUsd: 0,
    reservations: [],
    updatedAt: new Date().toISOString(),
  };
}

function isReservation(value: unknown): value is SpendReservation {
  if (value === null || typeof value !== "object") return false;
  const r = value as Partial<SpendReservation>;
  return (
    typeof r.id === "string" &&
    r.id !== "" &&
    typeof r.amountMicroUsd === "number" &&
    Number.isInteger(r.amountMicroUsd) &&
    r.amountMicroUsd > 0 &&
    typeof r.at === "string" &&
    typeof r.expiresAt === "string"
  );
}

function decode(raw: string, where: string): SpendLedgerRecord {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (err) {
    throw new SpendLedgerError("corrupt", `spend ledger ${where} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (value === null || typeof value !== "object") {
    throw new SpendLedgerError("corrupt", `spend ledger ${where} is not an object`);
  }
  const r = value as Partial<SpendLedgerRecord>;
  if (
    r.v !== SPEND_LEDGER_VERSION ||
    typeof r.limitMicroUsd !== "number" ||
    !Number.isInteger(r.limitMicroUsd) ||
    r.limitMicroUsd < 0 ||
    typeof r.spentMicroUsd !== "number" ||
    !Number.isInteger(r.spentMicroUsd) ||
    r.spentMicroUsd < 0 ||
    !Array.isArray(r.reservations) ||
    !r.reservations.every(isReservation) ||
    typeof r.updatedAt !== "string"
  ) {
    throw new SpendLedgerError("corrupt", `spend ledger ${where} has an invalid schema; refusing to treat it as zero`);
  }
  return r as SpendLedgerRecord;
}

/**
 * Charge expired reservations as spent: a crashed process may or may not have
 * spent the money, so the ceiling assumes it did. Releasing it would let an
 * attacker crash repeatedly to reset the budget.
 */
function expireReservations(record: SpendLedgerRecord, now = Date.now()): number {
  const live: SpendReservation[] = [];
  let changed = 0;
  for (const reservation of record.reservations) {
    const at = Date.parse(reservation.expiresAt);
    if (Number.isFinite(at) && at <= now) {
      record.spentMicroUsd += reservation.amountMicroUsd;
      changed += 1;
    } else {
      live.push(reservation);
    }
  }
  record.reservations = live;
  return changed;
}

export class SpendLedger {
  readonly workspace: string;
  readonly file: string;
  readonly lockFile: string;
  private readonly limitOverride?: number;
  private readonly ttlMs: number;

  constructor(
    workspace: string,
    opts: { limitMicroUsd?: number; ttlMs?: number; env?: Record<string, string | undefined> } = {},
  ) {
    this.workspace = path.resolve(workspace);
    const state = ensurePrivateDir(workspaceStateDir(this.workspace));
    this.file = path.join(state, SPEND_LEDGER_FILE);
    this.lockFile = path.join(state, SPEND_LOCK_FILE);
    this.limitOverride = opts.limitMicroUsd;
    this.ttlMs = opts.ttlMs ?? DEFAULT_RESERVATION_TTL_MS;
    if (this.limitOverride === undefined) {
      // Resolve once at construction: a later env mutation must not silently
      // lift a ceiling that was already in force.
      this.limitOverride = spendLimitMicroFromEnv(opts.env ?? process.env);
    }
  }

  private limit(): number {
    return Math.max(0, Math.floor(this.limitOverride ?? 0));
  }

  private readUnlocked(limit: number): SpendLedgerRecord {
    if (!existsSync(this.file)) return emptyRecord(limit);
    const record = decode(readFileSync(this.file, "utf8"), this.file);
    // The ceiling is configuration, not ledger history: a lower configured
    // ceiling takes effect immediately, while spend/reservations persist.
    record.limitMicroUsd = limit;
    return record;
  }

  private writeUnlocked(record: SpendLedgerRecord): void {
    record.updatedAt = new Date().toISOString();
    const body = JSON.stringify(record, null, 2) + "\n";
    const tmp = `${this.file}.tmp-${process.pid}-${randomBytes(6).toString("hex")}`;
    writeFileSync(tmp, body, { mode: 0o600 });
    chmodPrivateFile(tmp);
    renameSync(tmp, this.file);
    chmodPrivateFile(this.file);
  }

  /** Read/expire under the cross-process lock. */
  private withRecord<T>(fn: (record: SpendLedgerRecord) => T): T {
    ensurePrivateDir(path.dirname(this.file));
    return withFileLockSync(this.lockFile, () => {
      const limit = this.limit();
      const record = this.readUnlocked(limit);
      const expired = expireReservations(record);
      const result = fn(record);
      if (expired > 0 || record.v !== SPEND_LEDGER_VERSION) this.writeUnlocked(record);
      return result;
    });
  }

  /** Reserve `usd` before a provider call. Throws `SpendLimitError` when full. */
  reserve(
    usd: number,
    meta: { sessionId?: string; runId?: string; note?: string; ttlMs?: number } = {},
  ): SpendReservation {
    const amount = usdToMicro(usd);
    if (amount <= 0) throw new SpendLedgerError("invalid", "spend: reservation must be positive");
    return this.withRecord((record) => {
      const reserved = record.reservations.reduce((sum, r) => sum + r.amountMicroUsd, 0);
      if (record.limitMicroUsd > 0 && record.spentMicroUsd + reserved + amount > record.limitMicroUsd) {
        throw new SpendLimitError(record.limitMicroUsd, record.spentMicroUsd, reserved, amount);
      }
      const now = Date.now();
      const reservation: SpendReservation = {
        id: `spend-${randomBytes(8).toString("hex")}`,
        amountMicroUsd: amount,
        at: new Date(now).toISOString(),
        expiresAt: new Date(now + (meta.ttlMs ?? this.ttlMs)).toISOString(),
        ...(meta.sessionId !== undefined ? { sessionId: meta.sessionId } : {}),
        ...(meta.runId !== undefined ? { runId: meta.runId } : {}),
        ...(meta.note !== undefined ? { note: meta.note } : {}),
      };
      record.reservations.push(reservation);
      this.writeUnlocked(record);
      return reservation;
    });
  }

  /**
   * Settle a reservation with the actual cost. `actualUsd` may exceed the
   * reserved amount (providers are the source of truth); the ledger records it.
   * Settling twice is a typed refusal, never a double charge.
   */
  settle(id: string, actualUsd: number, note?: string): SpendStatus {
    const actual = usdToMicro(actualUsd);
    return this.withRecord((record) => {
      const at = record.reservations.findIndex((r) => r.id === id);
      if (at < 0) throw new SpendLedgerError("unknown-reservation", `spend: unknown reservation ${id}`);
      record.reservations.splice(at, 1);
      record.spentMicroUsd += actual;
      if (note !== undefined) record.updatedAt = new Date().toISOString();
      this.writeUnlocked(record);
      return this.statusOf(record);
    });
  }

  /** Release an unused reservation (e.g. the provider call was never sent). */
  release(id: string): SpendStatus {
    return this.withRecord((record) => {
      const at = record.reservations.findIndex((r) => r.id === id);
      if (at < 0) throw new SpendLedgerError("unknown-reservation", `spend: unknown reservation ${id}`);
      record.reservations.splice(at, 1);
      this.writeUnlocked(record);
      return this.statusOf(record);
    });
  }

  status(): SpendStatus {
    return this.withRecord((record) => this.statusOf(record));
  }

  private statusOf(record: SpendLedgerRecord): SpendStatus {
    const reserved = record.reservations.reduce((sum, r) => sum + r.amountMicroUsd, 0);
    const remaining =
      record.limitMicroUsd > 0
        ? Math.max(0, record.limitMicroUsd - record.spentMicroUsd - reserved)
        : Number.POSITIVE_INFINITY;
    return {
      limitUsd: microToUsd(record.limitMicroUsd),
      spentUsd: microToUsd(record.spentMicroUsd),
      reservedUsd: microToUsd(reserved),
      remainingUsd: Number.isFinite(remaining) ? microToUsd(remaining) : Number.POSITIVE_INFINITY,
      reservations: record.reservations.length,
      updatedAt: record.updatedAt,
    };
  }

  /** Remove the ledger (tests/tools only; production must not reset spend). */
  resetForTests(): void {
    if (existsSync(this.file)) unlinkSync(this.file);
  }
}

/** Ensure the state directory exists without touching a ledger (constructor does it). */
export function spendLedgerPath(workspace: string): string {
  const dir = workspaceStateDir(path.resolve(workspace));
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return path.join(dir, SPEND_LEDGER_FILE);
}
