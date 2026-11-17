/**
 * tool-call-assembly.ts — index-keyed tool-call delta assembler with cancel.
 *
 * ADAPT reduced from omp provider streaming + agent-loop `cancelArgStreams`:
 * when a mid-stream steer/abort cuts the provider request, in-flight argument
 * JSON must be discarded before any `tool_call` event is emitted (C-9 /
 * assembly-cancel). OpenAI chat-completions uses this; other providers may.
 *
 * H-5 (ruling 517 residual): FINAL assembled argument JSON is validated here,
 * outside every adapter's SSE loop. Syntax-only repairs (trailing commas,
 * single quotes, code fences, ...) are admitted; a blob that is still malformed
 * or truncated past what the syntax rules can safely close is REFUSED with a
 * structured tool-input error instead of being silently fed downstream.
 * `cancel()` and the assembly-cancel notices are unchanged.
 */

import type { ProviderEvent } from "../../contracts";
import { parseToolArguments } from "../json-repair";
import { isCompleteToolArgsObject } from "./tool-args-object";

export interface AssembledToolCall {
  id: string;
  name: string;
  arguments: string;
}

/** Structured refusal when a FINAL assembled tool call's arguments are broken. */
export interface ToolInputRefusal {
  id: string;
  name: string;
  reason: string;
}

/** Outcome of validating one FINAL assembled tool call's argument JSON. */
export type AssembledArgumentResult =
  | { ok: true; arguments: string }
  | { ok: false; refusal: ToolInputRefusal };

/**
 * Validate FINAL assembled argument JSON with the pure repair utils only.
 *
 * - A complete JSON object passes through BYTE-IDENTICALLY (single strict parse).
 * - A blob that needs only syntax repair is admitted as the repaired JSON.
 * - A blob that is truncated / unrepairable / not an object is refused with a
 *   structured reason (readable, never thrown at the caller).
 *
 * Truncation-tolerant tools are still repaired (streaming previews may be
 * tolerant); a side-effecting tool's cut-off blob is refused, never completed.
 */
export function validateFinalToolArguments(call: AssembledToolCall): AssembledArgumentResult {
  // Fast path: already a complete JSON object — no re-serialization, byte-identical.
  if (isCompleteToolArgsObject(call.arguments)) {
    return { ok: true, arguments: call.arguments };
  }
  const parsed = parseToolArguments(call.arguments, call.name);
  if (parsed.error !== undefined) {
    return { ok: false, refusal: { id: call.id, name: call.name, reason: parsed.error } };
  }
  // Syntax repair was applied; feed the REPAIRED JSON downstream, never the raw
  // malformed bytes.
  return { ok: true, arguments: JSON.stringify(parsed.args) };
}

/**
 * Turn a structured refusal into the provider's existing typed error event
 * (`{ type: "error", message, code }`). No new contract event shape is needed.
 */
export function toolInputErrorEvent(refusal: ToolInputRefusal): Extract<ProviderEvent, { type: "error" }> {
  const who = refusal.name !== "" ? refusal.name : refusal.id !== "" ? refusal.id : "tool";
  return {
    type: "error",
    code: "UNKNOWN",
    message: `tool_input_error: ${who}: ${refusal.reason}`,
  };
}

export interface ToolCallDelta {
  index?: number;
  id?: string;
  function?: { name?: string; arguments?: string };
}

export interface CancelledToolCallFragment {
  index: number;
  id: string;
  name: string;
  argsBytes: number;
}

/** Format the provider notice when assembly is cancelled mid-stream. */
export function formatAssemblyCancelNotice(cancelled: readonly CancelledToolCallFragment[]): string {
  const n = cancelled.length;
  if (n === 0) return "assembly-cancel: discarded 0 partial tool calls";
  const named = cancelled
    .map((c) => (c.name !== "" ? c.name : c.id !== "" ? c.id : `#${c.index}`))
    .slice(0, 3)
    .join(", ");
  const more = n > 3 ? ` (+${n - 3} more)` : "";
  return `assembly-cancel: discarded ${n} partial tool call${n === 1 ? "" : "s"} (${named}${more})`;
}

/**
 * Accumulates OpenAI-style tool_call deltas by index. Emit only via
 * `flushCompleted` after a clean stream end; `cancel()` discards everything.
 */
export class ToolCallAssembler {
  private readonly partials = new Map<number, { id: string; name: string; args: string }>();

  pushDelta(call: ToolCallDelta): void {
    const index = typeof call.index === "number" ? call.index : 0;
    const current = this.partials.get(index) ?? { id: "", name: "", args: "" };
    if (typeof call.id === "string" && call.id !== "") current.id = call.id;
    if (typeof call.function?.name === "string" && call.function.name !== "") {
      current.name = call.function.name;
    }
    if (typeof call.function?.arguments === "string") current.args += call.function.arguments;
    this.partials.set(index, current);
  }

  size(): number {
    return this.partials.size;
  }

  /** Discard every in-flight fragment; returns what was cancelled (for notices). */
  cancel(): CancelledToolCallFragment[] {
    const out: CancelledToolCallFragment[] = [];
    for (const index of [...this.partials.keys()].sort((a, b) => a - b)) {
      const call = this.partials.get(index);
      if (!call) continue;
      out.push({
        index,
        id: call.id,
        name: call.name,
        argsBytes: call.args.length,
      });
    }
    this.partials.clear();
    return out;
  }

  /**
   * Emit completed assemblies (name present). Empty args become `"{}"` so a
   * no-argument tool stays parseable — same contract as openai.ts historically.
   */
  flushCompleted(): AssembledToolCall[] {
    const out: AssembledToolCall[] = [];
    for (const index of [...this.partials.keys()].sort((a, b) => a - b)) {
      const call = this.partials.get(index);
      if (!call || call.name === "") continue;
      out.push({
        id: call.id !== "" ? call.id : `call_${index + 1}`,
        name: call.name,
        arguments: call.args.trim() === "" ? "{}" : call.args,
      });
    }
    this.partials.clear();
    return out;
  }
}
