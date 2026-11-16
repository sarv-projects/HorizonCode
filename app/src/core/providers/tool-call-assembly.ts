/**
 * tool-call-assembly.ts — index-keyed tool-call delta assembler with cancel.
 *
 * ADAPT reduced from omp provider streaming + agent-loop `cancelArgStreams`:
 * when a mid-stream steer/abort cuts the provider request, in-flight argument
 * JSON must be discarded before any `tool_call` event is emitted (C-9 /
 * assembly-cancel). OpenAI chat-completions uses this; other providers may.
 */

export interface AssembledToolCall {
  id: string;
  name: string;
  arguments: string;
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
