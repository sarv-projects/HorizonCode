/**
 * egress-park.ts -- advisory parked Ask hold state (plan Task 13).
 *
 * This is NOT connection parking or OS egress enforcement. It holds an
 * advisory promise until a one-shot approval, caller abort or backstop sweep.
 * No bytes are forwarded from this module; no Guard decision is weakened.
 */

import { randomUUID } from "node:crypto";
import {
  EGRESS_DEFAULT_HOLD_TIMEOUT_SECS,
  EGRESS_DEFAULT_MAX_HELD,
  EGRESS_DEFAULT_MAX_HELD_PER_CALL,
} from "../contracts";

export class EgressParkOverloaded extends Error {
  constructor(scope: "proxy-wide" | "per-call") {
    super(`egress Ask park overloaded (${scope})`);
    this.name = "EgressParkOverloaded";
  }
}

export interface ParkedAsk {
  key: string;
  decided: "approved" | "denied";
  holdMs: number;
}

export function egressParkBackstopMs(
  env: Record<string, string | undefined> = process.env,
): number {
  const raw = (env.HZ_EGRESS_HOLD_SECONDS ?? "").trim();
  const seconds = raw === "" ? Number.NaN : Number(raw);
  if (!Number.isInteger(seconds) || seconds <= 0) return EGRESS_DEFAULT_HOLD_TIMEOUT_SECS * 1000;
  return seconds * 1000;
}

interface Entry {
  key: string;
  at: number;
  approve: () => void;
  deny: () => void;
  cleanup: () => void;
}

export interface EgressAskParkOptions {
  now?: () => number;
  backstopMs?: number;
  maxHeld?: number;
  maxPerCall?: number;
}

export class EgressAskPark {
  /** Internal id → entry; several parked asks may share the same approval key. */
  private readonly entries = new Map<string, Entry>();
  private readonly now: () => number;
  private readonly backstopMs: number;
  private readonly maxHeld: number;
  private readonly maxPerCall: number;

  constructor(opts: EgressAskParkOptions = {}) {
    this.now = opts.now ?? Date.now;
    this.backstopMs = opts.backstopMs ?? egressParkBackstopMs();
    this.maxHeld = opts.maxHeld ?? EGRESS_DEFAULT_MAX_HELD;
    this.maxPerCall = opts.maxPerCall ?? EGRESS_DEFAULT_MAX_HELD_PER_CALL;
  }

  park(key: string, signal?: AbortSignal): Promise<ParkedAsk> {
    if (key.trim() === "") return Promise.resolve({ key, decided: "denied", holdMs: 0 });
    if (this.entries.size >= this.maxHeld) throw new EgressParkOverloaded("proxy-wide");
    let sameKey = 0;
    for (const entry of this.entries.values()) if (entry.key === key) sameKey += 1;
    if (sameKey >= this.maxPerCall) throw new EgressParkOverloaded("per-call");
    if (signal?.aborted === true) {
      return Promise.resolve({ key, decided: "denied", holdMs: 0 });
    }
    const at = this.now();
    return new Promise<ParkedAsk>((resolve) => {
      const id = randomUUID();
      let onAbort: (() => void) | undefined;
      const settle = (decided: "approved" | "denied"): void => {
        if (this.entries.get(id) !== entry) return;
        this.entries.delete(id);
        if (onAbort !== undefined && signal !== undefined) signal.removeEventListener("abort", onAbort);
        resolve({ key, decided, holdMs: Math.max(0, this.now() - at) });
      };
      const entry: Entry = {
        key,
        at,
        approve: () => settle("approved"),
        deny: () => settle("denied"),
        cleanup: () => {
          if (onAbort !== undefined && signal !== undefined) signal.removeEventListener("abort", onAbort);
          if (this.entries.get(id) === entry) this.entries.delete(id);
        },
      };
      this.entries.set(id, entry);
      if (signal !== undefined) {
        onAbort = () => entry.deny();
        signal.addEventListener("abort", onAbort, { once: true });
      }
    });
  }

  /** Exactly one approval per parked key; a second call cannot approve again. */
  approveOnce(token: string): boolean {
    for (const entry of this.entries.values()) {
      if (entry.key !== token) continue;
      entry.approve();
      return true;
    }
    return false;
  }

  /** Auto-deny every request older than the backstop; returns their keys. */
  sweep(nowMs = this.now()): string[] {
    const expired: string[] = [];
    for (const [, entry] of this.entries) {
      if (nowMs - entry.at < this.backstopMs) continue;
      expired.push(entry.key);
      // deny() -> settle() removes the entry itself.
      entry.deny();
    }
    return expired;
  }

  pending(): number {
    return this.entries.size;
  }
}
