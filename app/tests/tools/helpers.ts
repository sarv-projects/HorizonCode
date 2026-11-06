/**
 * Shared helpers for the tool test suite.
 *
 * Every fixture lives in a fresh directory under `os.tmpdir()` and is removed by
 * `afterAll`. `mockToolContext` builds a `ToolContext` whose guard / approve /
 * receipt calls are recorded so tests can assert on them.
 */

import { afterAll } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  canonicalJson,
  newId,
  sha256Hex,
  type ApprovalRequest,
  type GuardAction,
  type GuardDecision,
  type GuardDecisionValue,
  type Receipt,
  type ReceiptInput,
  type ToolContext,
} from "../../src/contracts";

const roots: string[] = [];

/** Create a fresh fixture directory (tracked for cleanup). */
export function tempRoot(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "hz-tools-test-"));
  roots.push(dir);
  return dir;
}

/** Write `content` to `rel` inside `root`, creating parents. Returns the absolute path. */
export function writeFixture(root: string, rel: string, content: string | Uint8Array): string {
  const abs = path.join(root, rel);
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, content);
  return abs;
}

/** Create a fixture workspace root and populate it from `files` (relative path -> content). */
export function makeWorkspace(files: Record<string, string | Uint8Array> = {}): string {
  const root = tempRoot();
  for (const [rel, content] of Object.entries(files)) writeFixture(root, rel, content);
  return root;
}

/** Read a fixture file as UTF-8 text. */
export function readFixture(root: string, rel: string): string {
  return readFileSync(path.join(root, rel), "utf8");
}

/** `count` newline-terminated lines, numbered from 1 unless `line` says otherwise. */
export function numberedLines(count: number, line: (n: number) => string = (n) => `line ${n}`): string {
  return Array.from({ length: count }, (_, i) => line(i + 1)).join("\n") + "\n";
}

afterAll(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

export type DecisionFn = (action: GuardAction) => GuardDecision | Promise<GuardDecision>;
export type ApproveFn = (req: ApprovalRequest) => boolean | Promise<boolean>;

export interface MockCtxOptions {
  /** Working directory for the tools (default: a fresh empty fixture). */
  cwd?: string;
  /** Workspace root reported to tools (default: `cwd`). */
  workspace?: string;
  sessionId?: string;
  /** Guard answer: a fixed decision, or a function for per-action behaviour. */
  decision?: GuardDecisionValue | DecisionFn;
  /** Reason attached to a fixed guard decision. */
  decisionReason?: string;
  /** Approve answer: a fixed boolean, or a function for per-request behaviour. */
  approve?: boolean | ApproveFn;
  /** Start with an already-aborted signal (default false). */
  aborted?: boolean;
}

export interface MockToolContext extends ToolContext {
  readonly guardCalls: GuardAction[];
  readonly approveCalls: ApprovalRequest[];
  readonly receiptCalls: ReceiptInput[];
  /** Abort the context's signal. */
  abort(): void;
}

/** A `ToolContext` backed by an in-memory recorder and its own AbortController. */
export function mockToolContext(opts: MockCtxOptions = {}): MockToolContext {
  const cwd = opts.cwd ?? makeWorkspace();
  const controller = new AbortController();
  if (opts.aborted) controller.abort();

  const guardCalls: GuardAction[] = [];
  const approveCalls: ApprovalRequest[] = [];
  const receiptCalls: ReceiptInput[] = [];
  let seq = 0;

  return {
    cwd,
    workspace: opts.workspace ?? cwd,
    sessionId: opts.sessionId ?? `session-${newId().slice(0, 8)}`,
    signal: controller.signal,
    guardCalls,
    approveCalls,
    receiptCalls,
    abort: () => controller.abort(),

    async guard(action: GuardAction): Promise<GuardDecision> {
      guardCalls.push(action);
      const decision = opts.decision ?? "allow";
      if (typeof decision === "function") return decision(action);
      return opts.decisionReason === undefined ? { decision } : { decision, reason: opts.decisionReason };
    },

    async approve(req: ApprovalRequest): Promise<boolean> {
      approveCalls.push(req);
      const answer = opts.approve ?? true;
      return typeof answer === "function" ? answer(req) : answer;
    },

    async receipt(input: ReceiptInput): Promise<Receipt> {
      receiptCalls.push(input);
      const base = { ...input, id: newId(), seq: ++seq, ts: new Date().toISOString(), prevHash: null };
      return { ...base, hash: sha256Hex(canonicalJson(base)) };
    },
  };
}

/**
 * Run `fn` with `Bun.which` reporting no executables, forcing the pure-JS
 * fallback paths (grep without ripgrep).
 */
export async function withoutRipgrep<T>(fn: () => Promise<T>): Promise<T> {
  const original = Bun.which;
  try {
    (Bun as unknown as { which: unknown }).which = () => null;
    return await fn();
  } finally {
    (Bun as unknown as { which: unknown }).which = original;
  }
}
