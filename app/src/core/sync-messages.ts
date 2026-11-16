/**
 * sync-messages.ts — B-5: frozen fingerprinted StablePrefix + append-only log +
 * byte-stable `syncMessages` (omp `AppendOnlyContextManager` spirit; docs/28
 * rulings 470, 482, 489).
 *
 * When rewritten history would otherwise clear the whole log (forcing a full
 * provider re-prefill), keep the longest prefix whose per-message digests still
 * match and re-append only the diverged tail.
 *
 * Ruling **470**: pure `syncMessages` helper.
 * Ruling **482**: `ProviderHistorySync` cursor + main-loop wire after
 * compact/steer rewrite paths; `syncForkedHistory` for in-memory fork truncation.
 * Ruling **489**: frozen fingerprinted StablePrefix (system+tools), the full
 * `AppendOnlyLog` class, and a per-provider gate resolved from LOCAL data
 * (`auto`) — no live calls. `syncMessages`/`ProviderHistorySync` stay
 * backward compatible (default gate `on`, no StablePrefix configured).
 */

import type { ChatMsg } from "../contracts";
import { digestOf } from "./canon";

/**
 * Digest of wire-relevant `ChatMsg` fields only (role/content/tool*). Object
 * identity and non-contract keys do not participate — two equal wire messages
 * share a digest even when they are distinct objects.
 */
export function chatMessageDigest(msg: ChatMsg): string {
  const wire: Record<string, unknown> = {
    role: msg.role,
    content: msg.content ?? "",
  };
  if (msg.toolCallId !== undefined) wire.toolCallId = msg.toolCallId;
  if (msg.toolName !== undefined) wire.toolName = msg.toolName;
  if (msg.toolCalls !== undefined) wire.toolCalls = msg.toolCalls;
  return digestOf(wire);
}

/**
 * Exclusive end index: `previous.slice(0, n)` and `desired.slice(0, n)` are
 * byte-stable (same per-message digests).
 */
export function longestStablePrefixLength(
  previous: readonly ChatMsg[],
  desired: readonly ChatMsg[],
): number {
  const n = Math.min(previous.length, desired.length);
  let i = 0;
  for (; i < n; i += 1) {
    if (chatMessageDigest(previous[i]!) !== chatMessageDigest(desired[i]!)) break;
  }
  return i;
}

export type SyncMessagesKind = "identical" | "append" | "rewrite" | "compact";

export interface SyncMessagesResult {
  /** Synced history: previous prefix objects kept where digests match, then desired tail. */
  messages: ChatMsg[];
  /** Exclusive end index of the preserved prefix. */
  stablePrefixLength: number;
  kind: SyncMessagesKind;
}

function classifySync(
  previousLen: number,
  desiredLen: number,
  stablePrefixLength: number,
): SyncMessagesKind {
  if (stablePrefixLength === previousLen && desiredLen === previousLen) return "identical";
  if (stablePrefixLength === previousLen && desiredLen > previousLen) return "append";
  if (desiredLen < previousLen && stablePrefixLength === desiredLen) return "compact";
  return "rewrite";
}

/**
 * Truncate rewritten history to the longest byte-stable prefix of `previous`,
 * then append the diverged `desired` tail. Pure helper — does not mutate inputs.
 */
export function syncMessages(
  previous: readonly ChatMsg[],
  desired: readonly ChatMsg[],
): SyncMessagesResult {
  const stablePrefixLength = longestStablePrefixLength(previous, desired);
  const kind = classifySync(previous.length, desired.length, stablePrefixLength);
  const messages: ChatMsg[] = [
    ...previous.slice(0, stablePrefixLength),
    ...desired.slice(stablePrefixLength),
  ];
  return { messages, stablePrefixLength, kind };
}

/**
 * In-memory fork truncation: keep the first `keep` parent messages via
 * `syncMessages` (omp compact/rewrite posture). SessionStore still persists a
 * row copy; this helper is the provider-facing / test rewrite path.
 */
export function syncForkedHistory(
  parent: readonly ChatMsg[],
  keep: number,
): SyncMessagesResult {
  const n = Number.isFinite(keep) ? Math.max(0, Math.min(Math.floor(keep), parent.length)) : 0;
  return syncMessages(parent, parent.slice(0, n));
}

/* ------------------------ Ruling 489: B-5 residual ------------------------ */

/** The wire-relevant inputs whose byte-stability the frozen prefix guarantees. */
export interface StablePrefixParts {
  system: string;
  tools: readonly unknown[];
}

/** A frozen (immutable, fingerprinted) system+tools prefix — omp `StablePrefix`. */
export interface StablePrefix {
  /** sha256 of canonical `{ system, tools }` — the fast-path drift check. */
  readonly fingerprint: string;
  readonly system: string;
  readonly tools: readonly unknown[];
  readonly toolCount: number;
}

/** Canonical sha256 fingerprint over the stable-prefix inputs (no live calls). */
export function stablePrefixFingerprint(parts: StablePrefixParts): string {
  return digestOf({ system: parts.system ?? "", tools: parts.tools ?? [] });
}

/** Freeze system+tools into an immutable, fingerprinted prefix. */
export function freezeStablePrefix(system: string, tools: readonly unknown[]): StablePrefix {
  const parts: StablePrefixParts = { system: system ?? "", tools: tools ?? [] };
  return Object.freeze({
    fingerprint: stablePrefixFingerprint(parts),
    system: parts.system,
    tools: Object.freeze([...parts.tools]),
    toolCount: parts.tools.length,
  });
}

/** True when current system+tools still hash to the frozen prefix. */
export function stablePrefixMatches(
  prefix: StablePrefix,
  system: string,
  tools: readonly unknown[],
): boolean {
  return prefix.fingerprint === stablePrefixFingerprint({ system, tools });
}

/** Whether the append-only prefix optimization is applied for a provider. */
export type HistorySyncGateMode = "on" | "off";
/** The user-facing gate setting; `auto` resolves from local provider data. */
export type HistorySyncGate = "auto" | HistorySyncGateMode;

/**
 * LOCAL data fact: whether a provider benefits from a byte-stable wire prefix
 * (a server-side prompt/KV cache). One small committed record; never fetched.
 */
export interface ProviderSyncCapabilities {
  prefixCaching: boolean;
}

/**
 * Local provider-capability table (data, not model-name regexes). Unknown
 * providers keep the harmless local optimization (`on`) — absence of a
 * negative fact is not a reason to re-prefill. Providers explicitly recorded
 * with `prefixCaching: false` opt out.
 */
export const PROVIDER_SYNC_CAPABILITIES: Readonly<Record<string, ProviderSyncCapabilities>> =
  Object.freeze({
    anthropic: { prefixCaching: true },
    openai: { prefixCaching: true },
    gemini: { prefixCaching: true },
    deepseek: { prefixCaching: true },
    ollama: { prefixCaching: false },
  });

export interface ResolveGateOptions {
  env?: Record<string, string | undefined>;
  capabilities?: Readonly<Record<string, ProviderSyncCapabilities>>;
}

/**
 * Resolve the per-provider gate from local data + env ONLY. `HZ_HISTORY_SYNC`
 * forces `on`/`off`; `auto` (default) derives from the local capability table.
 * No provider/network calls — the decision is pure data.
 */
export function resolveHistorySyncGate(
  provider: string,
  opts: ResolveGateOptions = {},
): HistorySyncGateMode {
  const env = opts.env ?? process.env;
  const explicit = env.HZ_HISTORY_SYNC?.toLowerCase();
  if (explicit === "on" || explicit === "off") return explicit;
  const key = provider.toLowerCase();
  const data = opts.capabilities?.[key] ?? PROVIDER_SYNC_CAPABILITIES[key];
  return data?.prefixCaching === false ? "off" : "on";
}

export interface AppendOnlySyncResult extends SyncMessagesResult {
  /** True when the frozen prefix drifted and forced a full rebuild this sync. */
  prefixInvalidated: boolean;
}

export interface AppendOnlyLogOptions {
  /** When false, syncs pass desired history through as fresh copies (no reuse). */
  enabled?: boolean;
  /** Frozen system+tools prefix; drift invalidates the whole log. */
  stablePrefix?: StablePrefix;
}

/**
 * Full append-only log (omp `AppendOnlyLog`): a byte-stable prefix that is kept
 * across rewrites, an append-only tail, and a frozen system+tools fingerprint
 * whose drift rebuilds the log. Pure — no I/O, no provider calls.
 */
export class AppendOnlyLog {
  readonly enabled: boolean;
  readonly #stablePrefix?: StablePrefix;
  #messages: ChatMsg[] = [];
  #prefixInvalidations = 0;

  constructor(opts: AppendOnlyLogOptions = {}) {
    this.enabled = opts.enabled ?? true;
    this.#stablePrefix = opts.stablePrefix;
  }

  prefix(): StablePrefix | undefined {
    return this.#stablePrefix;
  }

  messages(): readonly ChatMsg[] {
    return this.#messages;
  }

  prefixInvalidations(): number {
    return this.#prefixInvalidations;
  }

  /** Append to the tail; the existing prefix is never rewritten. */
  append(messages: readonly ChatMsg[]): ChatMsg[] {
    this.#messages = [...this.#messages, ...messages];
    return this.#messages;
  }

  /** True unless current system+tools drifted from the frozen prefix. */
  prefixMatches(current: StablePrefixParts | undefined): boolean {
    if (this.#stablePrefix === undefined || current === undefined) return true;
    return stablePrefixMatches(this.#stablePrefix, current.system, current.tools);
  }

  /**
   * Sync desired provider-facing history. Enabled + intact prefix → keep the
   * longest byte-stable prefix; drift → rebuild from empty; disabled → pass
   * desired through as fresh copies (no object-identity reuse).
   */
  sync(desired: readonly ChatMsg[], current?: StablePrefixParts): AppendOnlySyncResult {
    const prefixInvalidated = !this.prefixMatches(current);
    if (prefixInvalidated) this.#prefixInvalidations += 1;

    if (!this.enabled) {
      const fresh = desired.map((m) => ({ ...m }));
      this.#messages = fresh;
      return {
        messages: fresh,
        stablePrefixLength: 0,
        kind: fresh.length === 0 ? "identical" : "rewrite",
        prefixInvalidated,
      };
    }
    const base = prefixInvalidated ? [] : this.#messages;
    const result = syncMessages(base, desired);
    this.#messages = result.messages;
    return { ...result, prefixInvalidated };
  }

  reset(): void {
    this.#messages = [];
  }
}

export interface ProviderHistorySyncOptions {
  /** Resolved gate; default `on` keeps ruling 482 behavior. */
  gate?: HistorySyncGateMode;
  stablePrefix?: StablePrefix;
  /** Re-derived per sync to detect system+tools drift (frozen-prefix check). */
  currentPrefix?: () => StablePrefixParts | undefined;
}

/**
 * Stateful sync cursor for the main loop (omp `AppendOnlyContextManager`
 * `syncMessages` call pattern). Backed by {@link AppendOnlyLog}.
 *
 * Across dispatches, compact / steer / fork-shaped rewrites preserve prior
 * prefix object identity where digests still match — unless the provider gate
 * is `off` or the frozen system+tools prefix has drifted.
 */
export class ProviderHistorySync {
  readonly #log: AppendOnlyLog;
  readonly #currentPrefix?: () => StablePrefixParts | undefined;
  #last: SyncMessagesResult | null = null;

  constructor(opts: ProviderHistorySyncOptions = {}) {
    this.#log = new AppendOnlyLog({
      enabled: (opts.gate ?? "on") !== "off",
      stablePrefix: opts.stablePrefix,
    });
    this.#currentPrefix = opts.currentPrefix;
  }

  /** Last sync result, if any. */
  last(): SyncMessagesResult | null {
    return this.#last;
  }

  /** Messages from the previous successful sync (empty before the first). */
  previous(): readonly ChatMsg[] {
    return this.#log.messages();
  }

  /** Resolved gate mode for this cursor. */
  gate(): HistorySyncGateMode {
    return this.#log.enabled ? "on" : "off";
  }

  /** Number of syncs that rebuilt the log after a frozen-prefix drift. */
  prefixInvalidations(): number {
    return this.#log.prefixInvalidations();
  }

  /** Seed the cursor (e.g. inherited fork prefix) without classifying a rewrite. */
  seed(messages: readonly ChatMsg[]): void {
    this.#log.reset();
    this.#log.append(messages);
    this.#last = {
      messages: [...messages],
      stablePrefixLength: messages.length,
      kind: "identical",
    };
  }

  reset(): void {
    this.#log.reset();
    this.#last = null;
  }

  /**
   * Sync desired provider-facing history against the prior dispatch view.
   * Updates the cursor to the synced messages.
   */
  sync(desired: readonly ChatMsg[]): SyncMessagesResult {
    const result = this.#log.sync(desired, this.#currentPrefix?.());
    this.#last = result;
    return result;
  }
}
