/**
 * event-catalogue.ts — shipped kernel event type names + hz.* RC mapping
 * (docs/06 J4, docs/_conventions.md §6, docs/33 §6.3, RC-18).
 *
 * These are the dotted names the TypeScript runtime emits today. They are NOT
 * the full 44-name `hz.*` design catalogue; RC-18 maps each shipped name onto
 * zero-or-more canonical `hz.*` facts (many design events remain unimplemented).
 */

import { EventTypes } from "../contracts";
import { COMPACTION_EVENT } from "./compaction";
import { PENDING_TODOS_EVENT, UNVERIFIED_COMPLETION_EVENT } from "./loop";

/** Event type strings the runtime may append to the kernel log (2026-11-10). */
export const SHIPPED_EVENT_CATALOGUE: readonly string[] = [
  EventTypes.sessionStart,
  EventTypes.sessionEnd,
  EventTypes.sessionFork,
  EventTypes.messageStart,
  EventTypes.messageEnd,
  EventTypes.toolCall,
  EventTypes.toolResult,
  EventTypes.approvalRequest,
  EventTypes.approvalDecision,
  EventTypes.receiptIssued,
  EventTypes.effectSettled,
  EventTypes.effectUnknown,
  EventTypes.effectReconciled,
  EventTypes.error,
  COMPACTION_EVENT,
  "hook.decision",
  "hook.failure",
  PENDING_TODOS_EVENT,
  UNVERIFIED_COMPLETION_EVENT,
  "rewind.plan",
  "rewind.apply",
  "rewind.conversation",
  "plan.apply",
] as const;

/** Reserved in contracts but not emitted yet (docs/33 §6.3). */
export const RESERVED_UNEMITTED_EVENT_TYPES: readonly string[] = [EventTypes.messageDelta];

/**
 * The 44 canonical `hz.*` names from docs/_conventions.md §6 (RC-1, RC-10).
 * Order matches the conventions list.
 */
export const HZ_CANONICAL_EVENTS: readonly string[] = [
  "hz.session.created",
  "hz.session.prompt.admitted",
  "hz.session.claim.acquired",
  "hz.session.claim.released",
  "hz.session.busy.entered",
  "hz.session.busy.left",
  "hz.step.started",
  "hz.step.llm.requested",
  "hz.step.llm.delta",
  "hz.step.llm.completed",
  "hz.step.tool.requested",
  "hz.step.tool.completed",
  "hz.part.created",
  "hz.part.updated",
  "hz.plan.updated",
  "hz.todo.updated",
  "hz.goal.updated",
  "hz.effect.decision.made",
  "hz.effect.lease.issued",
  "hz.effect.settled",
  "hz.effect.unknown",
  "hz.effect.reconciled",
  "hz.session.compacted",
  "hz.session.checkpoint.created",
  "hz.session.rewound",
  "hz.session.forked",
  "hz.session.moved",
  "hz.agent.spawned",
  "hz.agent.completed",
  "hz.agent.message.sent",
  "hz.memory.retained",
  "hz.memory.recalled",
  "hz.memory.expired",
  "hz.skill.invoked",
  "hz.skill.installed",
  "hz.learn.trajectory.recorded",
  "hz.learn.proposal.created",
  "hz.learn.eval.completed",
  "hz.permission.asked",
  "hz.permission.answered",
  "hz.policy.revision.changed",
  "hz.provider.account.rotated",
  "hz.error.raised",
  "hz.usage.recorded",
] as const;

export type ShippedToHzRelation =
  | "equivalent"
  | "subset"
  | "superset_ui"
  | "unmapped_shipped"
  | "unimplemented_hz";

export interface ShippedToHzMapEntry {
  shipped: string;
  hz: readonly string[];
  relation: ShippedToHzRelation;
  note: string;
}

/**
 * RC-18 mapping: each shipped runtime log type → the canonical hz.* fact(s) it
 * approximates today. Empty `hz` means the shipped type is an honest extension
 * not yet promoted into the closed 44 (hooks / pending-todos / unverified).
 */
export const SHIPPED_TO_HZ_MAP: readonly ShippedToHzMapEntry[] = [
  { shipped: EventTypes.sessionStart, hz: ["hz.session.created"], relation: "subset", note: "session.start omits claim/busy/prompt.admitted fan-out" },
  { shipped: EventTypes.sessionEnd, hz: ["hz.session.busy.left"], relation: "subset", note: "closest durable end-of-run signal; claim.release not separate" },
  { shipped: EventTypes.sessionFork, hz: ["hz.session.forked"], relation: "equivalent", note: "first event of forked child stream" },
  { shipped: EventTypes.messageStart, hz: ["hz.step.started", "hz.step.llm.requested"], relation: "subset", note: "folds step+llm request; no separate part stream" },
  { shipped: EventTypes.messageEnd, hz: ["hz.step.llm.completed", "hz.part.created"], relation: "subset", note: "assistant/user turn close; part.updated not emitted" },
  { shipped: EventTypes.toolCall, hz: ["hz.step.tool.requested"], relation: "equivalent", note: "model tool call admitted" },
  { shipped: EventTypes.toolResult, hz: ["hz.step.tool.completed"], relation: "equivalent", note: "tool finished (status in payload)" },
  { shipped: EventTypes.approvalRequest, hz: ["hz.permission.asked"], relation: "equivalent", note: "ask path only (RC-6)" },
  { shipped: EventTypes.approvalDecision, hz: ["hz.permission.answered", "hz.effect.decision.made"], relation: "subset", note: "user answer; deny-without-ask still folds into decision.made semantics in guard" },
  { shipped: EventTypes.receiptIssued, hz: ["hz.effect.settled"], relation: "subset", note: "receipt chain; paired with literal hz.effect.settled after EffectHost reconcile" },
  { shipped: EventTypes.effectSettled, hz: ["hz.effect.settled"], relation: "equivalent", note: "EffectHost reconcile settled after allow/execute/observe+receipt" },
  { shipped: EventTypes.effectUnknown, hz: ["hz.effect.unknown"], relation: "equivalent", note: "EffectHost reconcile unknown (missing phase or receipt)" },
  { shipped: EventTypes.effectReconciled, hz: ["hz.effect.reconciled"], relation: "equivalent", note: "durable ledger attach: prior unknown/open effect now settled from logs" },
  { shipped: EventTypes.error, hz: ["hz.error.raised"], relation: "equivalent", note: "runtime/provider/tool error" },
  { shipped: COMPACTION_EVENT, hz: ["hz.session.compacted"], relation: "equivalent", note: "context compaction view" },
  { shipped: "hook.decision", hz: [], relation: "unmapped_shipped", note: "hook lifecycle; not in 44 (RC-2 style registry)" },
  { shipped: "hook.failure", hz: [], relation: "unmapped_shipped", note: "hook failure; may fold into hz.error.raised later" },
  { shipped: PENDING_TODOS_EVENT, hz: ["hz.todo.updated"], relation: "subset", note: "pending-todos rail notice, not full todo projector" },
  { shipped: UNVERIFIED_COMPLETION_EVENT, hz: [], relation: "unmapped_shipped", note: "evidence rail; no hz.* yet" },
  { shipped: "rewind.plan", hz: ["hz.session.rewound"], relation: "subset", note: "plan-only rewind preview" },
  { shipped: "rewind.apply", hz: ["hz.session.rewound"], relation: "subset", note: "workspace rewind apply" },
  { shipped: "rewind.conversation", hz: ["hz.session.rewound"], relation: "subset", note: "conversation rewind" },
  { shipped: "plan.apply", hz: ["hz.plan.updated"], relation: "subset", note: "staged plan apply" },
] as const;

/** Canonical hz.* names with no shipped runtime emitter yet. */
export function unimplementedHzEvents(): string[] {
  const covered = new Set<string>();
  for (const row of SHIPPED_TO_HZ_MAP) for (const h of row.hz) covered.add(h);
  return HZ_CANONICAL_EVENTS.filter((h) => !covered.has(h));
}

/** Lookup helper for tooling / doctor. */
export function hzNamesForShipped(shipped: string): readonly string[] {
  const row = SHIPPED_TO_HZ_MAP.find((r) => r.shipped === shipped);
  return row?.hz ?? [];
}
