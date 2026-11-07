/**
 * kernel.ts — the trust boundary (and its TypeScript stand-in).
 *
 * KernelClient talks to the Rust kernel binary over NDJSON on stdin/stdout when
 * it can be started. When the binary is missing, crashes, times out or breaks the
 * protocol, the client transparently falls back to LocalKernel: a TypeScript
 * implementation of the same methods that writes byte-identical files
 * (events/<stream>.jsonl and their .head anchors, receipts.jsonl and its anchor)
 * and evaluates the same DEFAULT_POLICY.
 *
 * The only visible difference is `kernelMode`: 'trusted' for the sandboxed Rust
 * kernel, 'untrusted' for the in-process fallback.
 *
 * With HZ_ANCHOR_KEY set (hex), anchors become HMAC-SHA256(key, canonical record
 * preimage) on both sides (the keyed anchor-of-record), and a legacy (unkeyed or
 * absent) anchor fails closed unless HZ_ACCEPT_LEGACY_ANCHORS=1 is set. Unkeyed,
 * every byte stays exactly as it was before keying existed.
 */

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHmac } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import * as path from "node:path";
import type {
  EventEnvelope,
  EventSeed,
  GuardAction,
  GuardDecision,
  GuardKind,
  KernelMethod,
  KernelMode,
  KernelRequestMap,
  Lease,
  PolicyRule,
  PolicyScope,
  Receipt,
  ReceiptInput,
} from "../contracts";
import { DEFAULT_POLICY, hashEnvelope, hashReceipt, newId, nowIso } from "../contracts";
import { canonicalJson, sha256Hex } from "./canon";

const DEFAULT_TIMEOUT_MS = 5_000;

/** A chain's last-record anchor; "corrupt" when present but unreadable. */
type ChainHead = { seq: number; hash: string } | "corrupt";

/** The fields a record's chain hash — and its anchor digest — covers. */
const EVENT_PREIMAGE_FIELDS = ["id", "seq", "ts", "stream", "type", "actor", "payload", "prevHash"] as const;
const RECEIPT_PREIMAGE_FIELDS = ["id", "seq", "ts", "action", "tool", "argsDigest", "resultDigest", "prevHash"] as const;

/** The canonical preimage of a record, mirroring canon.rs (missing field -> null). */
function preimageOf(record: unknown, fields: readonly string[]): Record<string, unknown> {
  const source = (record ?? {}) as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const field of fields) out[field] = source[field] === undefined ? null : source[field];
  return out;
}

function eventPreimageOf(record: unknown): Record<string, unknown> {
  return preimageOf(record, EVENT_PREIMAGE_FIELDS);
}

function receiptPreimageOf(record: unknown): Record<string, unknown> {
  const out = preimageOf(record, RECEIPT_PREIMAGE_FIELDS);
  const leaseId = (record as Record<string, unknown> | null | undefined)?.leaseId;
  if (leaseId !== undefined && leaseId !== null) out.leaseId = leaseId;
  return out;
}

/**
 * HZ_ANCHOR_KEY: hex key enabling keyed anchors (HMAC-SHA256 over the record
 * preimage). Undefined when unset or empty; a malformed value throws — a
 * configured-but-broken key must never quietly become unkeyed mode.
 */
export function anchorKeyFromEnv(env: Record<string, string | undefined> = process.env): Buffer | undefined {
  const raw = env.HZ_ANCHOR_KEY;
  const hex = typeof raw === "string" ? raw.trim() : "";
  if (hex === "") return undefined;
  if (hex.length % 2 !== 0 || hex.length < 32 || !/^[0-9a-fA-F]+$/.test(hex)) {
    throw new Error("HZ_ANCHOR_KEY must be an even-length hex string of at least 32 characters");
  }
  return Buffer.from(hex, "hex");
}

/** HZ_ACCEPT_LEGACY_ANCHORS truthiness (1/true yes; 0/false/empty no). */
export function acceptLegacyAnchorsFromEnv(env: Record<string, string | undefined> = process.env): boolean {
  const raw = env.HZ_ACCEPT_LEGACY_ANCHORS;
  const value = typeof raw === "string" ? raw.trim() : "";
  return value !== "" && value !== "0" && value.toLowerCase() !== "false";
}

/**
 * Stream name "session:abc" -> file "session__abc.jsonl".
 *
 * Byte-for-byte the Rust kernel's rule (eventlog.rs::sanitize): ':' -> "__",
 * path separators and control characters -> '_', everything else kept. The
 * fallback must write the same file names the kernel would, or a workspace
 * toggling between trusted and untrusted would split its own event log.
 */
export function sanitizeStream(stream: string): string {
  const trimmed = String(stream ?? "").trim();
  const name = trimmed.replace(/:/g, "__").replace(/[/\\\p{Cc}]/gu, "_");
  // The Rust kernel rejects empty or traversing names; the fallback is total
  // (never throws) and substitutes a safe name instead.
  if (name === "" || name === "." || name === ".." || name.includes("..")) return "stream";
  return name;
}

/**
 * Lease patterns are exact, or a trailing `*` wildcard prefix.
 *
 * Byte-for-byte the Rust kernel's rule (guard.rs::pattern_matches). The fallback
 * must not be more permissive than the kernel, or one approval would mean two
 * different things depending on which transport happened to be running.
 */
export function patternMatches(pattern: string, target: string): boolean {
  const p = typeof pattern === "string" ? pattern : "";
  const t = typeof target === "string" ? target : "";
  if (p.endsWith("*")) return t.startsWith(p.slice(0, -1));
  return t === p;
}

function isPolicyRule(value: unknown): value is PolicyRule {
  if (value === null || typeof value !== "object") return false;
  const rule = value as Partial<PolicyRule>;
  return (
    (rule.kind === "*" || typeof rule.kind === "string") &&
    (rule.scope === "*" || rule.scope === "workspace" || rule.scope === "outside") &&
    (rule.decision === "allow" || rule.decision === "ask" || rule.decision === "deny")
  );
}

/** <state-dir>/policy.json when it exists and parses, otherwise the built-in policy. */
export function loadPolicy(stateDir: string): PolicyRule[] {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path.join(stateDir, "policy.json"), "utf8"));
    const list = Array.isArray(parsed)
      ? parsed
      : parsed !== null && typeof parsed === "object" && Array.isArray((parsed as { rules?: unknown }).rules)
        ? ((parsed as { rules: unknown[] }).rules as unknown[])
        : [];
    const rules = list.filter(isPolicyRule);
    if (rules.length > 0) return rules;
  } catch {
    /* absent or unreadable: the built-in policy applies */
  }
  return DEFAULT_POLICY.slice();
}

function leaseActive(lease: Lease, now: number): boolean {
  const expiry = Date.parse(lease?.expiry ?? "");
  return Number.isFinite(expiry) && expiry > now;
}

function ruleMatches(rule: PolicyRule, kind: GuardKind, scope: PolicyScope): boolean {
  const kindOk = rule.kind === "*" || rule.kind === kind;
  const scopeOk = rule.scope === "*" || rule.scope === scope;
  return kindOk && scopeOk;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Size+mtime of a log file, used to notice writes made by another process
 * (two windows, one workspace) so a cached tail can never be trusted blindly.
 */
function fileStamp(file: string): string | undefined {
  try {
    const stat = statSync(file);
    return `${stat.size}:${stat.mtimeMs}`;
  } catch {
    return undefined;
  }
}

/** An explicitly configured kernel binary, trimmed; empty means "not set". */
function kernelBinOverride(env: Record<string, string | undefined>): string {
  return typeof env.HZ_KERNEL_BIN === "string" ? env.HZ_KERNEL_BIN.trim() : "";
}

/* ------------------------------ LocalKernel ------------------------------ */

/**
 * The in-process kernel: same contract, same files, no sandbox. It is the
 * fallback path, and it is what keeps the product usable on a machine where the
 * Rust binary has not been built yet.
 */
export class LocalKernel {
  readonly stateDir: string;
  private readonly locks = new Map<string, Promise<unknown>>();
  private readonly tails = new Map<
    string,
    { seq: number; hash: string; record: Record<string, unknown>; stamp: string | undefined }
  >();
  private readonly leases = new Map<string, Lease>();
  private readonly anchorKey: Buffer | undefined;
  private readonly acceptLegacy: boolean;
  private policy: PolicyRule[];

  constructor(opts: { stateDir: string; policy?: PolicyRule[] }) {
    this.stateDir = opts.stateDir;
    this.policy = opts.policy ?? loadPolicy(opts.stateDir);
    this.anchorKey = anchorKeyFromEnv();
    this.acceptLegacy = acceptLegacyAnchorsFromEnv();
  }

  /** Serialize writers per stream so seq/prevHash can never interleave. */
  private withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(key) ?? Promise.resolve();
    const run = previous.then(fn, fn);
    const settled: Promise<unknown> = run.then(
      () => undefined,
      () => undefined,
    );
    settled.then(() => {
      if (this.locks.get(key) === settled) this.locks.delete(key);
    });
    this.locks.set(key, settled);
    return run;
  }

  private eventsDir(): string {
    return path.join(this.stateDir, "events");
  }

  private streamPath(stream: string): string {
    return path.join(this.eventsDir(), sanitizeStream(stream) + ".jsonl");
  }

  private receiptsPath(): string {
    return path.join(this.stateDir, "receipts.jsonl");
  }

  private async lines(file: string): Promise<string[]> {
    try {
      return (await readFile(file, "utf8")).split("\n");
    } catch {
      return [];
    }
  }

  private headPath(file: string): string {
    return `${file}.head`;
  }

  /**
   * The integrity anchor written beside every chain file: seq and hash of the
   * last record. `verify` compares the chain against it, so tail truncation
   * (deleting whole trailing records) can no longer pass silently.
   */
  private async writeHead(file: string, seq: number, hash: string): Promise<void> {
    const tmp = `${file}.head.tmp`;
    await writeFile(tmp, canonicalJson({ hash, seq }) + "\n", "utf8");
    await rename(tmp, this.headPath(file));
  }

  /** The anchor of `file`, "corrupt" when present but unreadable, undefined when absent. */
  private async readHead(file: string): Promise<ChainHead | undefined> {
    let text: string;
    try {
      text = await readFile(this.headPath(file), "utf8");
    } catch {
      return undefined; // no anchor: a chain written before anchors existed
    }
    try {
      const parsed = JSON.parse(text.trim()) as { seq?: unknown; hash?: unknown };
      if (parsed !== null && typeof parsed === "object" && typeof parsed.seq === "number" && typeof parsed.hash === "string") {
        return { seq: parsed.seq, hash: parsed.hash };
      }
    } catch {
      /* a corrupt anchor is a finding, not an absence */
    }
    return "corrupt";
  }

  /**
   * Refuse to extend a chain whose tail disagrees with its anchor: appending
   * onto a truncated or rewritten tail would silently bless the edit. Mirrors
   * eventlog.rs::ensure_anchor_matches (keyed anchors included).
   */
  private async ensureAnchorAligned(
    file: string,
    kind: "event" | "receipt",
    tail: { seq: number; hash: string } | undefined,
  ): Promise<void> {
    const head = await this.readHead(file);
    const tailSeq = tail?.seq ?? 0;
    if (head === undefined) {
      if (this.anchorKey !== undefined && tailSeq > 0) {
        throw new Error(this.legacyRefusal(`chain ${file} has ${tailSeq} record(s) but no anchor`));
      }
      return; // legacy file without an anchor (unkeyed mode)
    }
    if (head === "corrupt") throw new Error(`chain anchor for ${file} is unreadable; refusing to append`);
    if (head.seq === tailSeq) {
      if (tailSeq === 0 || tail === undefined) return;
      if (this.anchorKey !== undefined) {
        if (this.anchorDigest(kind, tail) === head.hash) return;
        if (tail.hash === head.hash) {
          // an unkeyed anchor over an intact tail: legacy shape
          if (this.acceptLegacy) return;
          throw new Error(this.legacyRefusal(`chain ${file} is anchored with an unkeyed anchor`));
        }
      } else if (tail.hash === head.hash) {
        return;
      }
    }
    throw new Error(
      `chain tail (seq ${tailSeq}) disagrees with its anchor (seq ${head.seq}) for ${file}; refusing to append`,
    );
  }

  /** The typed refusal for a legacy anchor while HZ_ANCHOR_KEY is configured. */
  private legacyRefusal(detail: string): string {
    return `HZ_PRECONDITION_FAILED: legacy (unkeyed) anchor: ${detail} — HZ_ANCHOR_KEY is configured; set HZ_ACCEPT_LEGACY_ANCHORS=1 to accept it`;
  }

  /**
   * The digest an anchor stores for one record: plain sha256 of the canonical
   * preimage when unkeyed (equal to the record hash), HMAC-SHA256(key, preimage)
   * when keyed. Mirrors eventlog.rs::anchor_digest byte-for-byte.
   */
  private anchorDigest(kind: "event" | "receipt", record: unknown): string {
    const preimage = kind === "event" ? eventPreimageOf(record) : receiptPreimageOf(record);
    const canonical = canonicalJson(preimage);
    if (this.anchorKey === undefined) return sha256Hex(canonical);
    return createHmac("sha256", this.anchorKey).update(canonical, "utf8").digest("hex");
  }

  /**
   * Compare a completed, internally consistent walk of `count` records against
   * the chain's `.head` anchor. Returns the seq to report as broken, or a typed
   * refusal when HZ_ANCHOR_KEY is configured and the anchor is legacy (unkeyed
   * or absent). Mirrors eventlog.rs::anchor_check.
   */
  private checkAnchor(
    head: ChainHead | undefined,
    count: number,
    last: { hash: string; record: Record<string, unknown> } | undefined,
    kind: "event" | "receipt",
    label: string,
  ): { brokenAt?: number; refusal?: string } {
    if (head === undefined) {
      // Unkeyed: an absent anchor is a legacy chain. Keyed: a non-empty chain
      // without its anchor has lost exactly what the key protects.
      if (this.anchorKey !== undefined && count > 0) {
        return { refusal: this.legacyRefusal(`chain ${label} has ${count} record(s) but no anchor`) };
      }
      return {};
    }
    if (head === "corrupt") return { brokenAt: count + 1 };
    if (head.seq > count) return { brokenAt: count + 1 }; // records were removed from the tail
    if (head.seq < count) return { brokenAt: head.seq + 1 }; // records exist the anchor never saw
    if (count === 0) return {};
    if (last === undefined) return { brokenAt: count };
    if (this.anchorKey !== undefined) {
      if (this.anchorDigest(kind, last.record) === head.hash) return {};
      if (last.hash === head.hash) {
        if (this.acceptLegacy) return {};
        return { refusal: this.legacyRefusal(`chain ${label} is anchored with an unkeyed anchor`) };
      }
      return { brokenAt: count };
    }
    if (head.hash !== last.hash) return { brokenAt: count }; // the tail record was rewritten
    return {};
  }

  private async readEnvelopes(stream: string): Promise<EventEnvelope[]> {
    const out: EventEnvelope[] = [];
    for (const line of await this.lines(this.streamPath(stream))) {
      const text = line.trim();
      if (text === "") continue;
      try {
        const ev = JSON.parse(text) as EventEnvelope;
        if (ev !== null && typeof ev === "object" && typeof ev.seq === "number") out.push(ev);
      } catch {
        /* a corrupt line is reported by verify, not by read */
      }
    }
    return out;
  }

  private async readReceipts(): Promise<Receipt[]> {
    const out: Receipt[] = [];
    for (const line of await this.lines(this.receiptsPath())) {
      const text = line.trim();
      if (text === "") continue;
      try {
        const receipt = JSON.parse(text) as Receipt;
        if (receipt !== null && typeof receipt === "object" && typeof receipt.seq === "number") out.push(receipt);
      } catch {
        /* ignore malformed lines here; verify reports them */
      }
    }
    return out;
  }

  /**
   * (seq, hash) of a log's last record, cached only while the file on disk is the
   * one this instance wrote last. A second process sharing the state dir (two
   * windows on one workspace, or a kernel that was restarted) must never let the
   * fallback reuse a stale tail and write a colliding seq.
   */
  private async tailOf<T extends { seq: number; hash: string }>(
    key: string,
    file: string,
    read: () => Promise<T[]>,
  ): Promise<T | undefined> {
    const stamp = fileStamp(file);
    const cached = this.tails.get(key);
    if (cached !== undefined && cached.stamp === stamp) return cached.record as unknown as T;
    if (cached !== undefined) this.tails.delete(key);
    const items = await read();
    const last = items.length > 0 ? items[items.length - 1] : undefined;
    if (!last) return undefined;
    this.tails.set(key, {
      seq: last.seq,
      hash: last.hash,
      record: last as unknown as Record<string, unknown>,
      stamp: fileStamp(file),
    });
    return last;
  }

  async ping(): Promise<{ version: string }> {
    return { version: "local-ts-0.1" };
  }

  async appendEvent(stream: string, seed: EventSeed): Promise<EventEnvelope> {
    return this.withLock(`events:${stream}`, async () => {
      const file = this.streamPath(stream);
      await mkdir(this.eventsDir(), { recursive: true });
      const tail = await this.tailOf(`events:${stream}`, file, () => this.readEnvelopes(stream));
      await this.ensureAnchorAligned(file, "event", tail);
      const base: Omit<EventEnvelope, "hash"> = {
        id: seed?.id || newId(),
        seq: (tail?.seq ?? 0) + 1,
        ts: seed?.ts || nowIso(),
        stream,
        type: seed?.type ?? "event",
        actor: seed?.actor ?? { kind: "system", id: "hzcode" },
        payload: seed?.payload ?? null,
        prevHash: tail ? tail.hash : null,
      };
      const envelope: EventEnvelope = { ...base, hash: hashEnvelope(base) };
      await appendFile(file, canonicalJson(envelope) + "\n", "utf8");
      await this.writeHead(file, envelope.seq, this.anchorDigest("event", envelope));
      this.tails.set(`events:${stream}`, {
        seq: envelope.seq,
        hash: envelope.hash,
        record: envelope as unknown as Record<string, unknown>,
        stamp: fileStamp(file),
      });
      return envelope;
    });
  }

  async readEvents(stream: string, fromSeq = 1, limit?: number): Promise<EventEnvelope[]> {
    const events = await this.readEnvelopes(stream);
    const start = Number.isFinite(fromSeq) && fromSeq > 1 ? Math.floor(fromSeq) : 1;
    const rest = events.filter((ev) => ev.seq >= start);
    // `limit: 0` means zero events (the Rust kernel checks its cap before pushing;
    // a negative or absent limit is treated as "no limit", as number_param does).
    if (typeof limit === "number" && Number.isFinite(limit) && limit >= 0) return rest.slice(0, Math.floor(limit));
    return rest;
  }

  async verifyEventChain(stream: string): Promise<{ ok: boolean; count: number; brokenAt?: number }> {
    const file = this.streamPath(stream);
    let count = 0;
    let prevHash: string | null = null;
    let lastRecord: { hash: string; record: Record<string, unknown> } | undefined;
    for (const line of await this.lines(file)) {
      const text = line.trim();
      if (text === "") continue;
      const expected = count + 1;
      let ev: EventEnvelope;
      try {
        ev = JSON.parse(text) as EventEnvelope;
      } catch {
        return { ok: false, count, brokenAt: expected };
      }
      if (ev === null || typeof ev !== "object" || typeof ev.seq !== "number" || typeof ev.hash !== "string") {
        return { ok: false, count, brokenAt: expected };
      }
      if (ev.seq !== expected) return { ok: false, count, brokenAt: ev.seq > 0 ? ev.seq : expected };
      if (ev.prevHash !== prevHash) return { ok: false, count, brokenAt: ev.seq };
      const { hash, ...rest } = ev;
      if (hashEnvelope(rest) !== hash) return { ok: false, count, brokenAt: ev.seq };
      prevHash = hash;
      lastRecord = { hash, record: ev as unknown as Record<string, unknown> };
      count = expected;
    }
    const check = this.checkAnchor(await this.readHead(file), count, lastRecord, "event", file);
    if (check.refusal !== undefined) throw new Error(check.refusal);
    if (check.brokenAt !== undefined) return { ok: false, count, brokenAt: check.brokenAt };
    return { ok: true, count };
  }

  async issueReceipt(input: ReceiptInput): Promise<Receipt> {
    return this.withLock("receipts", async () => {
      const file = this.receiptsPath();
      await mkdir(this.stateDir, { recursive: true });
      const tail = await this.tailOf("receipts", file, () => this.readReceipts());
      await this.ensureAnchorAligned(file, "receipt", tail);
      const base: Omit<Receipt, "hash"> = {
        id: newId(),
        seq: (tail?.seq ?? 0) + 1,
        ts: nowIso(),
        action: input?.action ?? "tool.execute",
        tool: input?.tool ?? "unknown",
        argsDigest: input?.argsDigest ?? "",
        resultDigest: input?.resultDigest ?? "",
        leaseId: input?.leaseId,
        prevHash: tail ? tail.hash : null,
      };
      const receipt: Receipt = { ...base, hash: hashReceipt(base) };
      await appendFile(file, canonicalJson(receipt) + "\n", "utf8");
      await this.writeHead(file, receipt.seq, this.anchorDigest("receipt", receipt));
      this.tails.set("receipts", {
        seq: receipt.seq,
        hash: receipt.hash,
        record: receipt as unknown as Record<string, unknown>,
        stamp: fileStamp(file),
      });
      return receipt;
    });
  }

  async verifyReceipts(): Promise<{ ok: boolean; count: number; brokenAt?: number }> {
    const file = this.receiptsPath();
    let count = 0;
    let prevHash: string | null = null;
    let lastRecord: { hash: string; record: Record<string, unknown> } | undefined;
    for (const line of await this.lines(file)) {
      const text = line.trim();
      if (text === "") continue;
      const expected = count + 1;
      let receipt: Receipt;
      try {
        receipt = JSON.parse(text) as Receipt;
      } catch {
        return { ok: false, count, brokenAt: expected };
      }
      if (receipt === null || typeof receipt !== "object" || typeof receipt.seq !== "number" || typeof receipt.hash !== "string") {
        return { ok: false, count, brokenAt: expected };
      }
      if (receipt.seq !== expected) return { ok: false, count, brokenAt: receipt.seq > 0 ? receipt.seq : expected };
      if (receipt.prevHash !== prevHash) return { ok: false, count, brokenAt: receipt.seq };
      const { hash, ...rest } = receipt;
      if (hashReceipt(rest) !== hash) return { ok: false, count, brokenAt: receipt.seq };
      prevHash = hash;
      lastRecord = { hash, record: receipt as unknown as Record<string, unknown> };
      count = expected;
    }
    const check = this.checkAnchor(await this.readHead(file), count, lastRecord, "receipt", file);
    if (check.refusal !== undefined) throw new Error(check.refusal);
    if (check.brokenAt !== undefined) return { ok: false, count, brokenAt: check.brokenAt };
    return { ok: true, count };
  }

  async checkGuard(action: GuardAction, scope?: PolicyScope, leases: Lease[] = []): Promise<GuardDecision> {
    if (action === null || typeof action !== "object" || typeof action.kind !== "string") {
      return { decision: "deny", reason: "malformed guard action" };
    }
    // The kernel defaults a missing/empty scope to "*" (guard.rs: scope.filter(non-empty).unwrap_or("*")).
    // A `*` scope matches only `*` rules, so this default is the stricter one.
    const effective: PolicyScope = scope === undefined || (scope as string) === "" ? "*" : scope;

    // deny > lease > ask > allow (docs/11-authority-safety.md R1) — the exact
    // order guard.rs::check uses, so a decision can never widen or narrow when
    // the transport changes.
    const matching = this.policy.filter((rule) => ruleMatches(rule, action.kind, effective));
    const deny = matching.find((rule) => rule.decision === "deny");
    if (deny) return { decision: "deny", reason: `policy denies ${action.kind} for ${effective} targets` };

    const now = Date.now();
    const active = [...leases, ...this.leases.values()].filter(
      (lease) => lease && lease.kind === action.kind && leaseActive(lease, now) && patternMatches(lease.pattern, action.target),
    );
    const best = active[0];
    if (best) return { decision: "allow", leaseId: best.leaseId };

    const ask = matching.find((rule) => rule.decision === "ask");
    if (ask) {
      // R1: an ask rule beats a matching allow rule; the lease above still wins
      // on purpose — lease semantics are unchanged.
      return { decision: "ask", reason: `${action.kind} for ${effective} targets needs approval` };
    }

    const allow = matching.find((rule) => rule.decision === "allow");
    if (allow) return { decision: "allow" };

    return { decision: "ask", reason: `no policy rule allows ${action.kind}` };
  }

  async makeLease(kind: GuardKind, pattern: string, ttlMs: number): Promise<Lease> {
    // The Rust kernel refuses an empty pattern (string_param); mirror that here
    // instead of widening it to `*`, or one approval would mean two things.
    if (typeof pattern !== "string" || pattern === "") throw new Error("lease pattern must be a non-empty string");
    const ttl = Number.isFinite(ttlMs) && ttlMs > 0 ? Math.floor(ttlMs) : 15 * 60_000;
    const lease: Lease = {
      leaseId: newId(),
      kind,
      pattern,
      expiry: new Date(Date.now() + ttl).toISOString(),
    };
    this.leases.set(lease.leaseId, lease);
    return lease;
  }

  async close(): Promise<void> {
    this.locks.clear();
    this.tails.clear();
    this.leases.clear();
  }
}

/* ------------------------------ KernelClient ----------------------------- */

export interface KernelClientOptions {
  workspace: string;
  stateDir?: string;
  timeoutMs?: number;
  /** Called once whenever the client switches transport (start, fallback). */
  onModeChange?: (mode: KernelMode, reason: string) => void;
}

/**
 * Where the kernel binary lives: HZ_KERNEL_BIN when it is set, then the release
 * and debug builds of this repository's kernel crate.
 *
 * An explicit HZ_KERNEL_BIN is authoritative: a path that does not exist means
 * "no kernel", not "run some other binary instead". Silently starting a
 * different build than the one an operator pointed at would hide a
 * misconfiguration inside the trust boundary.
 */
export function resolveKernelBinary(env: Record<string, string | undefined> = process.env): string | undefined {
  const override = kernelBinOverride(env);
  if (override !== "") return existsSync(override) ? override : undefined;
  const repoRoot = path.resolve(import.meta.dir, "../../..");
  const candidates = [
    path.join(repoRoot, "kernel", "target", "release", "hz-kernel"),
    path.join(repoRoot, "kernel", "target", "debug", "hz-kernel"),
  ];
  return candidates.find((candidate) => existsSync(candidate));
}

/**
 * A structured refusal from the kernel: the request reached it and it answered
 * with an error. Such a call must never be routed around: the kernel said no,
 * and a local retry would be the client overruling its own authority. Transport
 * and lifecycle failures (exit, timeout, malformed output) stay plain Error and
 * are the only ones that trigger the fallback.
 */
class KernelRefusal extends Error {}

interface PendingCall {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  method: string;
}

/**
 * The kernel facade the runtime codes against. Everything below is expressed in
 * contracts.ts request/response shapes, so the local and the Rust kernel are
 * interchangeable from the caller's point of view.
 */
export class KernelClient {
  readonly workspace: string;
  readonly stateDir: string;
  private readonly timeoutMs: number;
  private readonly onModeChange?: (mode: KernelMode, reason: string) => void;
  private readonly local: LocalKernel;
  private child?: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<number, PendingCall>();
  private writeChain: Promise<void> = Promise.resolve();
  private stdoutBuffer = "";
  private nextId = 1;
  private closed = false;
  private modeValue: KernelMode = "untrusted";
  private binaryPath?: string;
  private reason = "local fallback";
  private startPromise?: Promise<KernelMode>;
  private exitHook?: () => void;
  private readonly diagnostics: string[] = [];

  constructor(opts: KernelClientOptions) {
    this.workspace = opts.workspace;
    this.stateDir = opts.stateDir ?? path.join(opts.workspace, ".hzcode", "kernel");
    this.timeoutMs = opts.timeoutMs && opts.timeoutMs > 0 ? opts.timeoutMs : DEFAULT_TIMEOUT_MS;
    this.onModeChange = opts.onModeChange;
    this.local = new LocalKernel({ stateDir: this.stateDir });
  }

  get mode(): KernelMode {
    return this.modeValue;
  }

  /** Why the fallback is in use ("trusted" when the Rust kernel answered). */
  get modeReason(): string {
    return this.reason;
  }

  get binary(): string | undefined {
    return this.binaryPath;
  }

  /** Start the Rust kernel when possible; resolve with the resulting mode. */
  async start(): Promise<KernelMode> {
    if (!this.startPromise) this.startPromise = this.startBinary();
    return this.startPromise;
  }

  private setMode(mode: KernelMode, reason: string): void {
    if (this.modeValue === mode && this.reason === reason) return;
    this.modeValue = mode;
    this.reason = reason;
    try {
      this.onModeChange?.(mode, reason);
    } catch {
      /* a listener error must not break the kernel client */
    }
  }

  private async startBinary(): Promise<KernelMode> {
    const binary = resolveKernelBinary();
    if (!binary) {
      const requested = kernelBinOverride(process.env);
      this.setMode(
        "untrusted",
        requested !== ""
          ? `HZ_KERNEL_BIN ${requested} is not a file — using the local fallback`
          : "kernel binary not found — using the local fallback",
      );
      return this.modeValue;
    }
    try {
      const child = spawn(binary, ["--state-dir", this.stateDir], {
        cwd: this.workspace,
        stdio: ["pipe", "pipe", "pipe"],
      });
      this.child = child;
      this.wire(child);
      const pong = await this.callRemote<"ping">("ping", {}, this.timeoutMs);
      this.binaryPath = binary;
      this.setMode("trusted", `kernel ${pong?.version ?? "unknown"} (${binary})`);
      return this.modeValue;
    } catch (err) {
      this.capture(`start failed: ${errorMessage(err)}`);
      await this.killChild();
      this.setMode("untrusted", `kernel start failed (${errorMessage(err)}) — using the local fallback`);
      return this.modeValue;
    }
  }

  private wire(child: ChildProcessWithoutNullStreams): void {
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string | Buffer) => this.onStdout(String(chunk)));
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string | Buffer) => this.capture(String(chunk)));
    child.on("error", (err: Error) => this.fallBack(`kernel process error: ${err.message}`));
    child.on("exit", (code: number | null, signal: NodeJS.Signals | null) => {
      if (this.closed) return;
      const how = signal ? `signal ${signal}` : `code ${code === null ? "null" : code}`;
      this.fallBack(`kernel exited unexpectedly (${how})`);
    });
    // Last-resort cleanup: never leave an orphan kernel process behind.
    this.exitHook = () => {
      try {
        child.kill("SIGKILL");
      } catch {
        /* already gone */
      }
    };
    process.once("exit", this.exitHook);
  }

  private capture(text: string): void {
    for (const line of text.split("\n")) {
      const trimmed = line.trim();
      if (trimmed === "") continue;
      this.diagnostics.push(trimmed);
    }
    while (this.diagnostics.length > 40) this.diagnostics.shift();
  }

  /** Recent kernel stderr, kept for diagnostics only. */
  diagnosticsTail(): string[] {
    return this.diagnostics.slice();
  }

  private onStdout(chunk: string): void {
    this.stdoutBuffer += chunk;
    let index = this.stdoutBuffer.indexOf("\n");
    while (index >= 0) {
      const line = this.stdoutBuffer.slice(0, index).trim();
      this.stdoutBuffer = this.stdoutBuffer.slice(index + 1);
      if (line !== "") this.onLine(line);
      index = this.stdoutBuffer.indexOf("\n");
    }
  }

  private onLine(line: string): void {
    let message: { id?: unknown; result?: unknown; error?: { message?: unknown } };
    try {
      message = JSON.parse(line) as typeof message;
    } catch {
      // Not NDJSON. Most likely a banner on stdout; treat it as noise and let a
      // real protocol failure surface as a timeout.
      this.capture(`non-protocol output: ${line}`);
      return;
    }
    if (message === null || typeof message !== "object") return;
    const id = typeof message.id === "number" ? message.id : -1;
    if (id < 0) return; // unsolicited line
    const pending = this.pending.get(id);
    if (!pending) {
      this.fallBack(`kernel answered unknown request id ${id}`);
      return;
    }
    this.pending.delete(id);
    clearTimeout(pending.timer);
    if (message.error !== undefined && message.error !== null) {
      const text = typeof message.error.message === "string" ? message.error.message : JSON.stringify(message.error);
      pending.reject(new KernelRefusal(`kernel ${pending.method}: ${text}`));
      return;
    }
    pending.resolve(message.result);
  }

  private fallBack(reason: string): void {
    if (this.closed) return;
    // A child process that is dying during the handshake must release the pending
    // ping immediately, otherwise start-up would sit on the 5s timeout.
    if (!this.child && this.modeValue === "untrusted") return;
    const pending = [...this.pending.values()];
    this.pending.clear();
    for (const call of pending) {
      clearTimeout(call.timer);
      call.reject(new Error(reason));
    }
    void this.killChild();
    this.setMode("untrusted", reason);
  }

  private async killChild(): Promise<void> {
    const child = this.child;
    this.child = undefined;
    this.stdoutBuffer = "";
    if (this.exitHook) {
      process.removeListener("exit", this.exitHook);
      this.exitHook = undefined;
    }
    if (!child) return;
    try {
      child.stdin.end();
    } catch {
      /* already closed */
    }
    try {
      child.kill("SIGTERM");
    } catch {
      /* already gone */
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
    if (child.exitCode === null && child.signalCode === null) {
      try {
        child.kill("SIGKILL");
      } catch {
        /* already gone */
      }
    }
  }

  /** One request/response round trip against the Rust kernel. */
  private callRemote<M extends KernelMethod>(
    method: M,
    params: KernelRequestMap[M]["params"],
    timeoutMs: number = this.timeoutMs,
  ): Promise<KernelRequestMap[M]["result"]> {
    return new Promise<KernelRequestMap[M]["result"]>((resolve, reject) => {
      const child = this.child;
      if (!child || this.closed) {
        reject(new Error("kernel is not running"));
        return;
      }
      const id = this.nextId++;
      const timer = setTimeout(() => {
        const call = this.pending.get(id);
        if (!call) return;
        this.pending.delete(id);
        call.reject(new Error(`kernel timeout after ${timeoutMs}ms (${method})`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: resolve as (value: unknown) => void,
        reject,
        timer,
        method,
      });
      const payload = JSON.stringify({ id, method, params: params ?? {} }) + "\n";
      // Writes are queued: never interleave two requests on stdin.
      this.writeChain = this.writeChain.then(
        () =>
          new Promise<void>((done) => {
            try {
              child.stdin.write(payload, "utf8", () => done());
            } catch {
              done();
            }
          }),
        () => undefined,
      );
    });
  }

  private callLocal<M extends KernelMethod>(method: M, params: KernelRequestMap[M]["params"]): Promise<KernelRequestMap[M]["result"]> {
    const p = params as Record<string, unknown>;
    switch (method) {
      case "ping":
        return this.local.ping() as unknown as Promise<KernelRequestMap[M]["result"]>;
      case "log.append":
        return this.local.appendEvent(String(p.stream), p.event as EventSeed) as unknown as Promise<KernelRequestMap[M]["result"]>;
      case "log.read": {
        const fromSeq = typeof p.fromSeq === "number" ? p.fromSeq : undefined;
        const limit = typeof p.limit === "number" ? p.limit : undefined;
        return this.local
          .readEvents(String(p.stream), fromSeq, limit)
          .then((events) => ({ events })) as unknown as Promise<KernelRequestMap[M]["result"]>;
      }
      case "log.verify":
        return this.local.verifyEventChain(String(p.stream)) as unknown as Promise<KernelRequestMap[M]["result"]>;
      case "receipt.issue":
        return this.local.issueReceipt(p as unknown as ReceiptInput) as unknown as Promise<KernelRequestMap[M]["result"]>;
      case "receipt.verify":
        return this.local.verifyReceipts() as unknown as Promise<KernelRequestMap[M]["result"]>;
      case "guard.check":
        return this.local.checkGuard(
          p.action as GuardAction,
          p.scope as PolicyScope | undefined,
          Array.isArray(p.leases) ? (p.leases as Lease[]) : [],
        ) as unknown as Promise<KernelRequestMap[M]["result"]>;
      case "guard.lease":
        return this.local.makeLease(
          p.kind as GuardKind,
          String(p.pattern ?? "*"),
          typeof p.ttlMs === "number" ? p.ttlMs : 0,
        ) as unknown as Promise<KernelRequestMap[M]["result"]>;
      default:
        return Promise.reject(new Error(`unsupported kernel method: ${String(method)}`));
    }
  }

  /** Trusted transport when possible, local fallback otherwise. */
  private async rpc<M extends KernelMethod>(method: M, params: KernelRequestMap[M]["params"]): Promise<KernelRequestMap[M]["result"]> {
    if (this.modeValue === "trusted" && this.child && !this.closed) {
      try {
        return await this.callRemote(method, params);
      } catch (err) {
        // A refusal is an answer, not a transport failure: surface it and leave
        // the mode alone. Everything else may fall back to the local kernel.
        if (err instanceof KernelRefusal) throw err;
        this.fallBack(`kernel call ${method} failed: ${errorMessage(err)}`);
        this.capture(`${method}: ${errorMessage(err)}`);
      }
    }
    return this.callLocal(method, params);
  }

  /* --------------------------- Public kernel API --------------------------- */

  async ping(): Promise<{ version: string }> {
    return this.rpc("ping", {});
  }

  /** Append one event; the log assigns seq, prevHash and hash. */
  async appendEvent(stream: string, seed: EventSeed): Promise<EventEnvelope> {
    return this.rpc("log.append", { stream, event: seed });
  }

  async readEvents(stream: string, fromSeq?: number, limit?: number): Promise<EventEnvelope[]> {
    const result = await this.rpc("log.read", { stream, fromSeq, limit });
    return result?.events ?? [];
  }

  async verifyEventChain(stream: string): Promise<{ ok: boolean; count: number; brokenAt?: number }> {
    return this.rpc("log.verify", { stream });
  }

  async issueReceipt(input: ReceiptInput): Promise<Receipt> {
    return this.rpc("receipt.issue", input);
  }

  async verifyReceipts(): Promise<{ ok: boolean; count: number; brokenAt?: number }> {
    return this.rpc("receipt.verify", {});
  }

  async checkGuard(action: GuardAction, scope?: PolicyScope, leases?: Lease[]): Promise<GuardDecision> {
    return this.rpc("guard.check", { action, scope, leases });
  }

  async makeLease(kind: GuardKind, pattern: string, ttlMs: number): Promise<Lease> {
    return this.rpc("guard.lease", { kind, pattern, ttlMs });
  }

  /** Kill the kernel child (when any) and release the client. */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const pending = [...this.pending.values()];
    this.pending.clear();
    for (const call of pending) {
      clearTimeout(call.timer);
      call.reject(new Error("kernel client closed"));
    }
    await this.killChild();
    await this.local.close();
  }
}
