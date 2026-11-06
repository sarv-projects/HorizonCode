/**
 * kernel.ts — the trust boundary (and its TypeScript stand-in).
 *
 * KernelClient talks to the Rust kernel binary over NDJSON on stdin/stdout when
 * it can be started. When the binary is missing, crashes, times out or breaks the
 * protocol, the client transparently falls back to LocalKernel: a TypeScript
 * implementation of the same methods that writes byte-identical files
 * (events/<stream>.jsonl, receipts.jsonl) and evaluates the same DEFAULT_POLICY.
 *
 * The only visible difference is `kernelMode`: 'trusted' for the sandboxed Rust
 * kernel, 'untrusted' for the in-process fallback.
 */

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { appendFile, mkdir, readFile } from "node:fs/promises";
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
import { canonicalJson } from "./canon";

const DEFAULT_TIMEOUT_MS = 5_000;

/** Stream name "session:abc" -> file "session__abc.jsonl". */
export function sanitizeStream(stream: string): string {
  const name = String(stream ?? "").replace(/:/g, "__").replace(/[^A-Za-z0-9._-]/g, "_");
  return name === "" || name === "." || name === ".." ? "stream" : name;
}

/** Lease patterns are exact, path-prefixed, or a trailing `*` wildcard. */
export function patternMatches(pattern: string, target: string): boolean {
  const p = typeof pattern === "string" ? pattern : "";
  const t = typeof target === "string" ? target : "";
  if (p === "" || p === "*") return true;
  if (p.endsWith("*")) return t.startsWith(p.slice(0, -1));
  if (t === p) return true;
  return t.startsWith(p.endsWith("/") ? p : p + "/");
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

/* ------------------------------ LocalKernel ------------------------------ */

/**
 * The in-process kernel: same contract, same files, no sandbox. It is the
 * fallback path, and it is what keeps the product usable on a machine where the
 * Rust binary has not been built yet.
 */
export class LocalKernel {
  readonly stateDir: string;
  private readonly locks = new Map<string, Promise<unknown>>();
  private readonly tails = new Map<string, { seq: number; hash: string }>();
  private readonly leases = new Map<string, Lease>();
  private policy: PolicyRule[];

  constructor(opts: { stateDir: string; policy?: PolicyRule[] }) {
    this.stateDir = opts.stateDir;
    this.policy = opts.policy ?? loadPolicy(opts.stateDir);
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

  private async tailOf(key: string, read: () => Promise<Array<{ seq: number; hash: string }>>): Promise<{ seq: number; hash: string } | undefined> {
    const cached = this.tails.get(key);
    if (cached) return cached;
    const items = await read();
    const last = items.length > 0 ? items[items.length - 1] : undefined;
    if (!last) return undefined;
    const tail = { seq: last.seq, hash: last.hash };
    this.tails.set(key, tail);
    return tail;
  }

  async ping(): Promise<{ version: string }> {
    return { version: "local-ts-0.1" };
  }

  async appendEvent(stream: string, seed: EventSeed): Promise<EventEnvelope> {
    return this.withLock(`events:${stream}`, async () => {
      const file = this.streamPath(stream);
      await mkdir(this.eventsDir(), { recursive: true });
      const tail = await this.tailOf(`events:${stream}`, () => this.readEnvelopes(stream));
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
      this.tails.set(`events:${stream}`, { seq: envelope.seq, hash: envelope.hash });
      return envelope;
    });
  }

  async readEvents(stream: string, fromSeq = 1, limit?: number): Promise<EventEnvelope[]> {
    const events = await this.readEnvelopes(stream);
    const start = Number.isFinite(fromSeq) && fromSeq > 1 ? Math.floor(fromSeq) : 1;
    const rest = events.filter((ev) => ev.seq >= start);
    if (typeof limit === "number" && Number.isFinite(limit) && limit > 0) return rest.slice(0, Math.floor(limit));
    return rest;
  }

  async verifyEventChain(stream: string): Promise<{ ok: boolean; count: number; brokenAt?: number }> {
    let count = 0;
    let prevHash: string | null = null;
    for (const line of await this.lines(this.streamPath(stream))) {
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
      count = expected;
    }
    return { ok: true, count };
  }

  async issueReceipt(input: ReceiptInput): Promise<Receipt> {
    return this.withLock("receipts", async () => {
      const file = this.receiptsPath();
      await mkdir(this.stateDir, { recursive: true });
      const tail = await this.tailOf("receipts", () => this.readReceipts());
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
      this.tails.set("receipts", { seq: receipt.seq, hash: receipt.hash });
      return receipt;
    });
  }

  async verifyReceipts(): Promise<{ ok: boolean; count: number; brokenAt?: number }> {
    let count = 0;
    let prevHash: string | null = null;
    for (const line of await this.lines(this.receiptsPath())) {
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
      count = expected;
    }
    return { ok: true, count };
  }

  async checkGuard(action: GuardAction, scope?: PolicyScope, leases: Lease[] = []): Promise<GuardDecision> {
    if (action === null || typeof action !== "object" || typeof action.kind !== "string") {
      return { decision: "deny", reason: "malformed guard action" };
    }
    const effective: PolicyScope = scope ?? "outside";

    // deny > allow > ask, then active leases grant allow unless a deny matched.
    const matching = this.policy.filter((rule) => ruleMatches(rule, action.kind, effective));
    const deny = matching.find((rule) => rule.decision === "deny");
    if (deny) return { decision: "deny", reason: `policy denies ${action.kind} for ${effective} targets` };
    const allow = matching.find((rule) => rule.decision === "allow");
    if (allow) return { decision: "allow" };

    const now = Date.now();
    const active = [...leases, ...this.leases.values()].filter(
      (lease) => lease && lease.kind === action.kind && leaseActive(lease, now) && patternMatches(lease.pattern, action.target),
    );
    const best = active[0];
    if (best) return { decision: "allow", leaseId: best.leaseId };

    const ask = matching.find((rule) => rule.decision === "ask");
    return {
      decision: "ask",
      reason: ask ? `${action.kind} for ${effective} targets needs approval` : `no policy rule allows ${action.kind}`,
    };
  }

  async makeLease(kind: GuardKind, pattern: string, ttlMs: number): Promise<Lease> {
    const ttl = Number.isFinite(ttlMs) && ttlMs > 0 ? Math.floor(ttlMs) : 15 * 60_000;
    const lease: Lease = {
      leaseId: newId(),
      kind,
      pattern: typeof pattern === "string" && pattern !== "" ? pattern : "*",
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
 * Where the kernel binary lives: HZ_KERNEL_BIN first, then the release and
 * debug builds of this repository's kernel crate.
 */
export function resolveKernelBinary(env: Record<string, string | undefined> = process.env): string | undefined {
  const repoRoot = path.resolve(import.meta.dir, "../../..");
  const candidates = [
    env.HZ_KERNEL_BIN,
    path.join(repoRoot, "kernel", "target", "release", "hz-kernel"),
    path.join(repoRoot, "kernel", "target", "debug", "hz-kernel"),
  ].filter((candidate): candidate is string => typeof candidate === "string" && candidate.trim() !== "");
  return candidates.find((candidate) => existsSync(candidate));
}

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
      this.setMode("untrusted", "kernel binary not found — using the local fallback");
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
      pending.reject(new Error(`kernel ${pending.method}: ${text}`));
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
