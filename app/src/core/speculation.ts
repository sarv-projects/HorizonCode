/**
 * speculation.ts — the speculative-execution coordinator (Tier-3 strategic).
 *
 * WHAT THIS IS. A self-contained, host-injected coordinator that may run ONLY
 * provably side-effect-free tool calls AHEAD of commit, so a batch's reads can
 * overlap the work that decides whether their results are still wanted. It
 * generalizes NF-072 within-batch parallelism (loop.ts `batchSegments` + the
 * `Promise.all` batch run): NF-072 runs shared calls concurrently once the
 * model has committed to them; speculation runs the side-effect-free ones
 * eagerly and then reconciles them against what was actually committed.
 *
 * THE SAFETY INVARIANT (the whole point — tested explicitly). Speculation must
 * NEVER run a non-side-effect-free tool and NEVER bypass the kernel guard:
 *
 *  - The CLOSED effect union is the single source of truth. A candidate's
 *    effect is either `{ kind: 'pure' }` or
 *    `{ kind: 'local_read', resources: [{ scheme:'file', path, access:'read' }] }`
 *    and NOTHING ELSE. `normalizeSpeculationEffect` REJECTS (throws a typed
 *    `SpeculationError`, reason `unspeculable-effect`) anything that is not
 *    exactly one of those two shapes. A side-effecting tool (write/edit/shell/
 *    bash/agent/code_mode/preview/undo/mcp) has no representable effect here, so
 *    it can never be admitted as a speculation candidate.
 *  - The coordinator never touches the filesystem and never spawns. The ONLY
 *    way an effect physically happens is the host-injected `run` callback, which
 *    the loop wires to the SAME guarded `executeTool` path
 *    (`admissionFor -> gate.check -> tool.execute`). A speculatively-run read is
 *    therefore a guarded `fs.read`, identical to a non-speculative one.
 *
 * BOUNDING & RECONCILIATION.
 *  - `DEFAULT_MAX_IN_FLIGHT = 2`: at most two candidates run at once; admission
 *    beyond the bound is rejected with reason `max-in-flight`.
 *  - Fingerprint = `sha256Hex(canonicalJson({ name, args, effect }))` (canon.ts).
 *    When the final (committed) calls are reconciled against the immutable
 *    snapshot of admitted fingerprints, a mismatch DISCARDS the candidate
 *    (reason `fingerprint-mismatch`), and a discard CASCADES to every transitive
 *    dependent. A committed result is kept only when its fingerprint matches.
 *
 * REDUCED FORM, stated. This module is pure and host-injected: it schedules,
 * bounds, fingerprints, commits and discards — it never calls `fs` or spawns.
 * The loop owns the wiring (off-by-default) and the single guarded run path.
 *
 * Sources: research/compare-ohmypi-deepseek.md §1.4 (speculative-execution.ts);
 * docs/24 NF-072; docs/28 ruling 40.
 */

import * as path from "node:path";
import { canonicalJson, sha256Hex } from "./canon";

/* ------------------------------ the effect union ------------------------------ */

/** One read-only filesystem resource a `local_read` effect may name. */
export interface SpeculationReadResource {
  scheme: "file";
  path: string;
  access: "read";
}

/**
 * The CLOSED effect union. A speculable call's effect is EXACTLY one of these:
 *  - `pure`: no external effect at all.
 *  - `local_read`: a bounded set of read-only `file` resources.
 * There is no third member on purpose: anything that would write, spawn, fetch
 * or otherwise change the world has no representation here, so it can never be
 * speculated. `normalizeSpeculationEffect` is the gate that enforces this.
 */
export type SpeculationEffect =
  | { kind: "pure" }
  | { kind: "local_read"; resources: SpeculationReadResource[] };

/* ------------------------------ the typed error ------------------------------ */

export type SpeculationErrorReason =
  | "unspeculable-effect"
  | "max-in-flight"
  | "fingerprint-mismatch"
  | "invalid-candidate";

/**
 * Raised by the coordinator and the effect normalizer; `reason` is the stable,
 * machine-readable code (mirrors the `ReviewForkError` pattern in review.ts).
 */
export class SpeculationError extends Error {
  readonly reason: SpeculationErrorReason;
  readonly detail: string;

  constructor(reason: SpeculationErrorReason, detail: string) {
    super(`${reason}: ${detail}`);
    this.name = "SpeculationError";
    this.reason = reason;
    this.detail = detail;
  }
}

/* --------------------------- the effect normalizer --------------------------- */

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Normalize an arbitrary input to a `SpeculationEffect`, REJECTING anything
 * that is not exactly `pure` or `local_read`-with-file-read-resources. This is
 * THE gate that guarantees a side-effecting tool is never speculated: there is
 * no input that normalizes to a writing/spawning/fetching effect, because the
 * union has no member for one.
 *
 * Rejections are a typed `SpeculationError` with reason `unspeculable-effect`.
 */
export function normalizeSpeculationEffect(input: unknown): SpeculationEffect {
  if (!isRecord(input) || typeof input.kind !== "string") {
    throw new SpeculationError("unspeculable-effect", `effect must be an object with a string kind (got ${JSON.stringify(input)})`);
  }
  if (input.kind === "pure") {
    // `pure` carries nothing else; extra fields are not a pure effect.
    return { kind: "pure" };
  }
  if (input.kind === "local_read") {
    const resources = input.resources;
    if (!Array.isArray(resources) || resources.length === 0) {
      throw new SpeculationError("unspeculable-effect", "local_read requires a non-empty resources array");
    }
    const normalized: SpeculationReadResource[] = resources.map((resource, index) => {
      if (
        !isRecord(resource) ||
        resource.scheme !== "file" ||
        resource.access !== "read" ||
        typeof resource.path !== "string" ||
        resource.path === ""
      ) {
        throw new SpeculationError(
          "unspeculable-effect",
          `local_read.resources[${index}] must be { scheme:'file', path:<non-empty string>, access:'read' }`,
        );
      }
      return { scheme: "file", path: resource.path, access: "read" };
    });
    return { kind: "local_read", resources: normalized };
  }
  throw new SpeculationError("unspeculable-effect", `effect kind ${JSON.stringify(input.kind)} is not speculable (only pure | local_read)`);
}

/* --------------------------- tool-call → effect map --------------------------- */

/**
 * The read-only / pure tools that MAY be speculated, mapped to how their effect
 * is derived. Any tool not in this set is NEVER speculable — a tool that is not
 * provably side-effect-free returns `undefined` from
 * `speculationEffectForToolCall` and is therefore never admitted.
 */
function argString(args: Record<string, unknown>, ...names: string[]): string | undefined {
  for (const name of names) {
    const value = args[name];
    if (typeof value === "string" && value.trim() !== "") return value.trim();
  }
  return undefined;
}

/**
 * Derive the declared `SpeculationEffect` for a tool call, or `undefined` when
 * the tool is not provably side-effect-free. Path resolution mirrors
 * `guardActionFor` in loop.ts so a speculated read resolves to the SAME fs.read
 * target the guard would check.
 *
 * Speculable: `read`/`grep`/`glob`/`repo_map` → `local_read` of the resolved
 * target. Every other tool (write/edit/shell/bash/agent/code_mode/preview/undo/
 * mcp and any unknown name) → `undefined` (NOT speculable).
 *
 * The derived effect is routed through `normalizeSpeculationEffect`, so the
 * closed union stays the single source of truth even for the internal map.
 */
export function speculationEffectForToolCall(
  name: string,
  args: Record<string, unknown>,
  workspace: string,
): SpeculationEffect | undefined {
  const resolved = (value: string): string => path.resolve(workspace, value);
  let raw: SpeculationEffect | undefined;
  switch (name) {
    case "read": {
      const file = argString(args, "path", "file");
      if (file === undefined) return undefined;
      raw = { kind: "local_read", resources: [{ scheme: "file", path: resolved(file), access: "read" }] };
      break;
    }
    case "glob":
    case "grep":
    case "repo_map": {
      const root = argString(args, "path", "dir", "cwd") ?? ".";
      raw = { kind: "local_read", resources: [{ scheme: "file", path: resolved(root), access: "read" }] };
      break;
    }
    default:
      // write / edit / shell / bash / agent / code_mode / preview / undo / mcp
      // and any unknown tool: not provably side-effect-free, never speculated.
      return undefined;
  }
  // Route through the gate so the closed union is the one source of truth.
  return normalizeSpeculationEffect(raw);
}

/* ------------------------------ the candidate ------------------------------ */

export type SpeculativeState = "queued" | "running" | "completed" | "failed" | "discarded";

/**
 * One speculative tool call. `dependencies`/`dependents` are candidate ids;
 * `fingerprint` is `sha256Hex(canonicalJson({ name, args, effect }))`.
 */
export interface SpeculativeToolCandidate {
  id: string;
  name: string;
  args: Record<string, unknown>;
  effect: SpeculationEffect;
  dependencies: string[];
  dependents: string[];
  state: SpeculativeState;
  fingerprint: string;
  committed: boolean;
}

export interface SpeculativeCandidateInput {
  id: string;
  name: string;
  args: Record<string, unknown>;
  /** The declared effect; routed through `normalizeSpeculationEffect`. */
  effect: unknown;
  dependencies?: string[];
}

/** The fingerprint of a candidate: the digest of its name, args and effect. */
export function fingerprintCandidate(name: string, args: Record<string, unknown>, effect: SpeculationEffect): string {
  return sha256Hex(canonicalJson({ name, args, effect }));
}

/** Build a validated candidate (effect normalized, fingerprint computed). */
export function makeCandidate(input: SpeculativeCandidateInput): SpeculativeToolCandidate {
  if (!isRecord(input) || typeof input.id !== "string" || input.id === "" || typeof input.name !== "string" || input.name === "") {
    throw new SpeculationError("invalid-candidate", "a candidate requires a non-empty string id and name");
  }
  if (!isRecord(input.args)) {
    throw new SpeculationError("invalid-candidate", `candidate ${JSON.stringify(input.id)} requires an args object`);
  }
  const effect = normalizeSpeculationEffect(input.effect);
  const dependencies = Array.isArray(input.dependencies) ? input.dependencies.filter((d): d is string => typeof d === "string") : [];
  return {
    id: input.id,
    name: input.name,
    args: input.args,
    effect,
    dependencies,
    dependents: [],
    state: "queued",
    fingerprint: fingerprintCandidate(input.name, input.args, effect),
    committed: false,
  };
}

/* ------------------------------ the coordinator ------------------------------ */

/** The default max-in-flight bound: at most two candidates run at once. */
export const DEFAULT_MAX_IN_FLIGHT = 2;

/** One run result the host returns for a candidate. */
export interface SpeculativeRunResult {
  ok: boolean;
  output: string;
  error?: string;
}

/**
 * The host callbacks. `run` is the ONLY way an effect physically happens — the
 * loop wires it to the guarded `executeTool` path, so a speculated read is a
 * guarded `fs.read`. `validate` (optional) lets the host veto a candidate on
 * claim (e.g. a stale read); a `false` validation discards the candidate and
 * cascades to its dependents.
 */
export interface SpeculativeHost {
  run(candidate: SpeculativeToolCandidate): Promise<SpeculativeRunResult>;
  validate?(candidate: SpeculativeToolCandidate): boolean | Promise<boolean>;
}

/** The record of one admitted candidate's outcome. */
export interface SpeculativeOutcome {
  id: string;
  state: SpeculativeState;
  fingerprint: string;
  result?: SpeculativeRunResult;
  /** Set when the candidate was discarded; names why. */
  discardReason?: "fingerprint-mismatch" | "validate-veto" | "dependency-discarded";
}

/**
 * The speculative-operation coordinator. Pure and host-injected: it schedules,
 * bounds, fingerprints, commits and discards; it NEVER calls `fs` or spawns.
 *
 * Admission is SERIAL behind an admission promise chain, so the max-in-flight
 * bound and the admitted-fingerprint snapshot are observed deterministically.
 */
export class SpeculativeOperationCoordinator {
  private readonly maxInFlight: number;
  private readonly host: SpeculativeHost;
  private readonly candidates = new Map<string, SpeculativeToolCandidate>();
  /** The immutable snapshot of admitted fingerprints, keyed by candidate id. */
  private readonly admittedFingerprints = new Map<string, string>();
  private readonly outcomes = new Map<string, SpeculativeOutcome>();
  private inFlight = 0;
  /** Serializes admission so the bound and snapshot are observed in order. */
  private admissionChain: Promise<void> = Promise.resolve();

  constructor(host: SpeculativeHost, maxInFlight: number = DEFAULT_MAX_IN_FLIGHT) {
    if (!Number.isInteger(maxInFlight) || maxInFlight < 1) {
      throw new SpeculationError("invalid-candidate", `maxInFlight must be a positive integer (got ${maxInFlight})`);
    }
    this.host = host;
    this.maxInFlight = maxInFlight;
  }

  /** The candidates admitted so far, in admission order. */
  admitted(): SpeculativeToolCandidate[] {
    return [...this.candidates.values()];
  }

  /** The recorded outcome for a candidate id, if any. */
  outcomeFor(id: string): SpeculativeOutcome | undefined {
    return this.outcomes.get(id);
  }

  /**
   * Admit and run one candidate speculatively. Admission is serialized; the
   * max-in-flight bound is enforced (reject with reason `max-in-flight`); the
   * host `validate` may veto on claim (discard + cascade); otherwise the host
   * `run` executes it through the guarded path and the outcome is recorded.
   */
  async admit(candidate: SpeculativeToolCandidate): Promise<SpeculativeOutcome> {
    // Normalize the effect defensively: a candidate handed in by a caller must
    // still carry a representable (speculable) effect, or it is rejected.
    candidate.effect = normalizeSpeculationEffect(candidate.effect);
    candidate.fingerprint = fingerprintCandidate(candidate.name, candidate.args, candidate.effect);

    // Serialize the admission gate so the bound and the snapshot are observed
    // deterministically regardless of concurrent callers.
    let release!: () => void;
    const mine = new Promise<void>((resolve) => {
      release = resolve;
    });
    const prior = this.admissionChain;
    this.admissionChain = this.admissionChain.then(() => mine);
    await prior;

    try {
      if (this.inFlight >= this.maxInFlight) {
        throw new SpeculationError("max-in-flight", `at most ${this.maxInFlight} speculative calls may run at once`);
      }
      if (this.candidates.has(candidate.id)) {
        throw new SpeculationError("invalid-candidate", `duplicate candidate id ${JSON.stringify(candidate.id)}`);
      }
      this.inFlight += 1;
      candidate.state = "running";
      this.candidates.set(candidate.id, candidate);
      this.admittedFingerprints.set(candidate.id, candidate.fingerprint);
      // Link this candidate as a dependent of each of its dependencies, and
      // note whether any dependency is unknown or already discarded.
      let badDependency = false;
      for (const dep of candidate.dependencies) {
        const parent = this.candidates.get(dep);
        if (parent === undefined || parent.state === "discarded") {
          badDependency = true;
          continue;
        }
        if (!parent.dependents.includes(candidate.id)) parent.dependents.push(candidate.id);
      }
      if (badDependency) {
        this.inFlight -= 1;
        return this.discard(candidate.id, "dependency-discarded");
      }
    } finally {
      release();
    }

    try {
      // Host validate on claim: a false veto discards this candidate and
      // cascades to its transitive dependents.
      if (this.host.validate !== undefined) {
        const ok = await this.host.validate(candidate);
        if (!ok) {
          const outcome = this.discard(candidate.id, "validate-veto");
          return outcome;
        }
      }
      const result = await this.host.run(candidate);
      // A discard issued while `run` was pending is final: keep it.
      if ((candidate.state as SpeculativeState) === "discarded") {
        return this.outcomes.get(candidate.id) as SpeculativeOutcome;
      }
      candidate.state = result.ok ? "completed" : "failed";
      candidate.committed = result.ok;
      const outcome: SpeculativeOutcome = { id: candidate.id, state: candidate.state, fingerprint: candidate.fingerprint, result };
      this.outcomes.set(candidate.id, outcome);
      return outcome;
    } catch (err) {
      // A throwing validate/run must not leave the candidate stuck `running`.
      if ((candidate.state as SpeculativeState) !== "discarded") {
        candidate.state = "failed";
        candidate.committed = false;
        this.outcomes.set(candidate.id, {
          id: candidate.id,
          state: "failed",
          fingerprint: candidate.fingerprint,
          result: { ok: false, output: "", error: err instanceof Error ? err.message : String(err) },
        });
      }
      return this.outcomes.get(candidate.id) as SpeculativeOutcome;
    } finally {
      this.inFlight -= 1;
    }
  }

  /**
   * Discard a candidate and CASCADE the discard to every transitive dependent.
   * Returns the outcome recorded for the named candidate.
   */
  discard(id: string, reason: SpeculativeOutcome["discardReason"]): SpeculativeOutcome {
    const seed = this.candidates.get(id);
    const seedFingerprint = seed?.fingerprint ?? this.admittedFingerprints.get(id) ?? "";
    const seedOutcome: SpeculativeOutcome = { id, state: "discarded", fingerprint: seedFingerprint, discardReason: reason };

    const stack = [id];
    const seen = new Set<string>();
    while (stack.length > 0) {
      const current = stack.pop() as string;
      if (seen.has(current)) continue;
      seen.add(current);
      const node = this.candidates.get(current);
      if (node !== undefined) {
        node.state = "discarded";
        node.committed = false;
        for (const dependent of node.dependents) stack.push(dependent);
      }
      const discardReason = current === id ? reason : "dependency-discarded";
      this.outcomes.set(current, {
        id: current,
        state: "discarded",
        fingerprint: this.candidates.get(current)?.fingerprint ?? this.admittedFingerprints.get(current) ?? "",
        discardReason,
      });
    }
    return this.outcomes.get(id) ?? seedOutcome;
  }

  /**
   * Reconcile the speculatively-run candidates against the FINAL committed
   * calls (what the model actually committed to, each with its own fingerprint).
   * A speculated candidate whose fingerprint does not match its committed
   * counterpart is DISCARDED (reason `fingerprint-mismatch`), and the discard
   * cascades to its dependents. Returns the ids kept (committed, matching).
   */
  reconcile(committed: ReadonlyArray<{ id: string; fingerprint: string }>): string[] {
    const committedById = new Map<string, string>();
    for (const call of committed) committedById.set(call.id, call.fingerprint);

    const kept: string[] = [];
    for (const [id, admittedFingerprint] of this.admittedFingerprints) {
      const node = this.candidates.get(id);
      if (node === undefined || node.state === "discarded") continue;
      const committedFingerprint = committedById.get(id);
      if (committedFingerprint === undefined || committedFingerprint !== admittedFingerprint) {
        this.discard(id, "fingerprint-mismatch");
        continue;
      }
      if (node.state === "completed" && node.committed) kept.push(id);
    }
    return kept;
  }
}
