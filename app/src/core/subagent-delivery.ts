/**
 * subagent-delivery.ts — port of grok xai-message-delivery-core identity +
 * lifecycle (Tier 1 #7). Source: repo_take/grok-build/crates/common/
 * xai-message-delivery-core/src/{identity.rs,lifecycle.rs} @ 2bdd1d6.
 *
 * Restart-stable AgentId/AttemptId minted from HOST entropy (no process-global
 * counter), an opaque child address that is NEVER the session id, and a typed
 * Pending→Projecting→Delivered lifecycle with COMMIT-BEFORE-TRANSITION.
 * Terminal causes split into fallback (completion/soft-cancel/rewind) vs
 * completion (hard teardown/actor-drop), matching grok's TerminalCause.
 * No authority, no network, no contract change.
 */

export type TerminalCause =
  | "completion"
  | "soft_cancel"
  | "rewind"
  | "hard_teardown"
  | "actor_drop";

function fallsBack(cause: TerminalCause): boolean {
  return cause === "completion" || cause === "soft_cancel" || cause === "rewind";
}

abstract class OpaqueToken {
  protected constructor(protected readonly token: string) {}
  asStr(): string {
    return this.token;
  }
  toString(): string {
    return this.token;
  }
}

/** Restart-stable logical agent name. Distinct from delivery addresses. */
export class AgentId extends OpaqueToken {
  private static readonly PREFIX = "ag1.";
  private constructor(token: string) {
    super(token);
  }
  static mint(entropy: string): AgentId {
    return new AgentId(`${AgentId.PREFIX}${entropy.trim()}`);
  }
  static parse(token: string): AgentId | undefined {
    const t = token.trim();
    return t.startsWith(AgentId.PREFIX) ? new AgentId(t) : undefined;
  }
}

/** One activation of an AgentId. A resume or fork always mints a new one. */
export class AttemptId extends OpaqueToken {
  private static readonly PREFIX = "at1.";
  private constructor(token: string) {
    super(token);
  }
  static mint(entropy: string): AttemptId {
    return new AttemptId(`${AttemptId.PREFIX}${entropy.trim()}`);
  }
  static parse(token: string): AttemptId | undefined {
    const t = token.trim();
    return t.startsWith(AttemptId.PREFIX) ? new AttemptId(t) : undefined;
  }
}

/** Opaque address a parent uses to reply to a child. NEVER the session id. */
export class OpaqueAddress extends OpaqueToken {
  private static readonly PREFIX = "dx1.";
  private constructor(token: string) {
    super(token);
  }
  static mint(entropy: string): OpaqueAddress {
    return new OpaqueAddress(`${OpaqueAddress.PREFIX}${entropy.trim()}`);
  }
  static parse(token: string): OpaqueAddress | undefined {
    const t = token.trim();
    return t.startsWith(OpaqueAddress.PREFIX) ? new OpaqueAddress(t) : undefined;
  }
}

type Phase = "pending" | "projecting" | "delivered";

interface Slot<T> {
  phase: Phase;
  message: T;
  commit?: () => void;
}

export interface TerminalResult<T> {
  fallbacks: T[];
  completions: T[];
}

/** Typed Pending→Projecting→Delivered lifecycle with commit-before-transition. */
export class DeliveryLifecycle<T> {
  private readonly slots = new Map<string, Slot<T>>();

  len(): number {
    return this.slots.size;
  }

  phaseOf(id: string): Phase | undefined {
    return this.slots.get(id)?.phase;
  }

  admitPending(id: string, message: T, commit?: () => void): void {
    if (this.slots.has(id)) throw new Error(`duplicate delivery identity: ${id}`);
    this.slots.set(id, { phase: "pending", message, commit });
  }

  beginProjection(id: string): void {
    const slot = this.slots.get(id);
    if (slot === undefined || slot.phase !== "pending") {
      throw new Error(`unknown or non-pending delivery identity: ${id}`);
    }
    slot.phase = "projecting";
  }

  /** Commit FIRST; only then transition to Delivered (commit-before-transition). */
  commitAndDeliver(id: string): void {
    const slot = this.slots.get(id);
    if (slot === undefined || slot.phase !== "projecting") {
      throw new Error(`unknown or non-projecting delivery identity: ${id}`);
    }
    slot.commit?.();
    slot.phase = "delivered";
  }

  terminate(cause: TerminalCause, target: string | "all"): TerminalResult<T> {
    const result: TerminalResult<T> = { fallbacks: [], completions: [] };
    const ids = target === "all" ? [...this.slots.keys()] : [target];
    for (const id of ids) {
      const slot = this.slots.get(id);
      if (slot === undefined) continue;
      this.slots.delete(id);
      if (fallsBack(cause)) result.fallbacks.push(slot.message);
      else result.completions.push(slot.message);
    }
    return result;
  }
}
