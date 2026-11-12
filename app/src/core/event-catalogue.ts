/**
 * event-catalogue.ts — shipped kernel event type names (docs/06 J4, docs/33 §6.3).
 *
 * These are the dotted names the TypeScript runtime emits today. They are NOT
 * the full 44-name `hz.*` design catalogue; that mapping is for docs/_conventions.
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
