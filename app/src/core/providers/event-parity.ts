/**
 * event-parity.ts -- pinned 18-variant provider event parity assessment
 * (plan Task 5). This is an assessment artifact, NOT a claim of full parity.
 * Rows marked additive_needed stay that way until a later additive contract
 * change; no contract is modified here.
 */

export type ParityDecision = "covered" | "additive_needed" | "out_of_scope";

export interface ParityRow {
  upstream: string;
  local: string | undefined;
  decision: ParityDecision;
  note: string;
}

export const PROVIDER_EVENT_PARITY: readonly ParityRow[] = [
  { upstream: "start", local: undefined, decision: "additive_needed", note: "No local step-start ProviderEvent; turn boundaries are RuntimeEvents." },
  { upstream: "text_delta", local: "text", decision: "covered", note: "ProviderEvent.text streams incremental text." },
  { upstream: "reasoning_delta", local: "thinking", decision: "covered", note: "ADDITIVE C3 display-only thinking map." },
  { upstream: "tool_call_delta", local: "tool_call", decision: "covered", note: "Partial tool call assembled by tool-call-assembly.ts." },
  { upstream: "tool_call_final", local: "tool_call", decision: "covered", note: "Same variant; final args carried on the completed call." },
  { upstream: "usage", local: "done", decision: "covered", note: "Usage is additive on the done event." },
  { upstream: "stop", local: "done", decision: "covered", note: "stopReason: end|tool_use|max_tokens|abort." },
  { upstream: "error", local: "error", decision: "covered", note: "Typed ProviderFailureCode taxonomy exists." },
  { upstream: "thinking_signature", local: undefined, decision: "additive_needed", note: "Signed thinking replay field not represented." },
  { upstream: "redacted_thinking", local: undefined, decision: "additive_needed", note: "No redacted-thinking event." },
  { upstream: "cache_creation", local: undefined, decision: "additive_needed", note: "Usage fields record cache tokens; no dedicated event." },
  { upstream: "cache_read", local: undefined, decision: "additive_needed", note: "Usage fields record cache tokens; no dedicated event." },
  { upstream: "quirk_applied", local: "quirks", decision: "covered", note: "forge T-8 additive quirks event." },
  { upstream: "notice", local: "notice", decision: "covered", note: "Human-readable provider notices." },
  { upstream: "live_steer_claim", local: undefined, decision: "out_of_scope", note: "LiveSteerClaim is a separate control-plane interface, not a stream event." },
  { upstream: "image_part", local: undefined, decision: "additive_needed", note: "ChatMsg multimodal parts exist on requests, not on ProviderEvent." },
  { upstream: "refusal", local: undefined, decision: "additive_needed", note: "No distinct refusal event; typed error codes only." },
  { upstream: "finish_reason_metadata", local: "done", decision: "covered", note: "done.stopReason + usage carry finish metadata." },
];

export function providerEventParityReport(): {
  total: number;
  covered: number;
  additiveNeeded: number;
  outOfScope: number;
} {
  let covered = 0;
  let additiveNeeded = 0;
  let outOfScope = 0;
  for (const row of PROVIDER_EVENT_PARITY) {
    if (row.decision === "covered") covered += 1;
    else if (row.decision === "additive_needed") additiveNeeded += 1;
    else outOfScope += 1;
  }
  return {
    total: PROVIDER_EVENT_PARITY.length,
    covered,
    additiveNeeded,
    outOfScope,
  };
}
