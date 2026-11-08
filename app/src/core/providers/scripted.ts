/**
 * scripted.ts — a deterministic model, IN the library (docs/30 §4 item 8,
 * "test-model-in-library").
 *
 * The mock provider (`providers/mock.ts`) answers one canned line and can run
 * exactly one `glob` call; it exists so a fresh install can chat. This is the
 * other half: a model whose entire behaviour is a script the caller wrote, so a
 * test or an eval case can drive the harness through any turn shape — text,
 * tool calls, an error, a mid-turn stop — with no network and no clock in the
 * result. It is the in-library form of the `scriptedProvider` helper the test
 * suites have used all along, promoted so eval cases (data) can name a model.
 *
 * Pinned semantics:
 *  - One script turn is consumed per `stream()` call, in order. The same script
 *    and the same requests yield the same events, every run.
 *  - An aborted signal consumes NOTHING and yields `{done, stopReason:"abort"}`
 *    — the script stays where it was, exactly like a real turn that was stopped
 *    before it produced anything.
 *  - An exhausted script yields no events at all followed by `{done, "end"}`:
 *    the script has nothing more to say, and inventing a line would make the
 *    result depend on the script only approximately.
 *  - Tool-call ids default to `scripted-<turn>.<n>` — deterministic, so receipts
 *    and event logs from scripted runs are reproducible.
 */

import type { ChatMsg, Provider, ProviderEvent, ProviderRequest } from "../../contracts";

/** One tool call a scripted turn will ask for. */
export interface ScriptedCall {
  name: string;
  args: Record<string, unknown>;
  /** Default `scripted-<turn>.<index>` (1-based, deterministic). */
  id?: string;
}

/**
 * A scripted turn: what one model call produces.
 *
 * - `text`: stream some text, then stop for the turn.
 * - `calls`: ask for tool calls, then stop with `tool_use` so the harness runs
 *   them and calls back with the next turn.
 * - `error`: report a provider error (the turn fails; no tool runs).
 * - `stop`: stop with a specific reason (`end`, `max_tokens`, `abort`).
 */
export type ScriptedTurn =
  | { kind: "text"; text: string }
  | { kind: "calls"; calls: ScriptedCall[]; text?: string }
  | { kind: "error"; message: string }
  | { kind: "stop"; reason?: "end" | "max_tokens" | "abort" };

export interface ScriptedProviderOptions {
  /** Provider name the run records (`providerName`). Default `scripted`. */
  name?: string;
}

export interface ScriptedProvider extends Provider {
  /** Script turns consumed so far (0-based count of `stream()` calls that produced a turn). */
  consumed(): number;
  /** Requests seen, in order, for assertions about what the harness sent. */
  requests(): readonly ProviderRequest[];
}

/** A message whose last row is a tool result — the harness is calling back. */
export function isToolResultRequest(req: ProviderRequest): boolean {
  const messages: ChatMsg[] = Array.isArray(req?.messages) ? req.messages : [];
  const last = messages.length > 0 ? messages[messages.length - 1] : undefined;
  return last !== undefined && last.role === "tool";
}

function turnEvents(turn: ScriptedTurn, turnNumber: number): ProviderEvent[] {
  switch (turn.kind) {
    case "text": {
      return [
        { type: "text", text: turn.text },
        { type: "done", stopReason: "end" },
      ];
    }
    case "calls": {
      const events: ProviderEvent[] = [];
      if (typeof turn.text === "string" && turn.text !== "") events.push({ type: "text", text: turn.text });
      if (!Array.isArray(turn.calls) || turn.calls.length === 0) {
        // A `calls` turn with no calls is a script bug; fail the turn instead of
        // looping (the harness would call back and consume the next turn forever).
        return [{ type: "error", message: `scripted turn ${turnNumber}: kind "calls" carries no calls` }];
      }
      turn.calls.forEach((call, index) => {
        events.push({
          type: "tool_call",
          id: call.id !== undefined && call.id !== "" ? call.id : `scripted-${turnNumber}.${index + 1}`,
          name: call.name,
          arguments: JSON.stringify(call.args ?? {}),
        });
      });
      events.push({ type: "done", stopReason: "tool_use" });
      return events;
    }
    case "error": {
      return [{ type: "error", message: turn.message }];
    }
    case "stop": {
      return [{ type: "done", stopReason: turn.reason ?? "end" }];
    }
    default: {
      const unknown = turn as { kind?: unknown };
      return [{ type: "error", message: `scripted turn ${turnNumber}: unknown kind ${JSON.stringify(unknown?.kind)}` }];
    }
  }
}

/**
 * Build the provider. The script is copied at construction: later mutation of
 * the caller's array cannot change what a run does half-way through.
 */
export function createScriptedProvider(
  turns: readonly ScriptedTurn[],
  opts: ScriptedProviderOptions = {},
): ScriptedProvider {
  const script: ScriptedTurn[] = Array.isArray(turns) ? [...turns] : [];
  const seen: ProviderRequest[] = [];
  let index = 0;

  return {
    name: opts.name !== undefined && opts.name !== "" ? opts.name : "scripted",

    async *stream(req: ProviderRequest): AsyncIterable<ProviderEvent> {
      seen.push(req);
      if (req?.signal?.aborted) {
        // Consume nothing: a stop before the turn started is not the turn.
        yield { type: "done", stopReason: "abort" };
        return;
      }
      const turn = script[index];
      if (turn === undefined) {
        // Exhausted: say nothing, then end. Never invent a line.
        yield { type: "done", stopReason: "end" };
        return;
      }
      index += 1;
      for (const event of turnEvents(turn, index)) yield event;
    },

    consumed(): number {
      return index;
    },

    requests(): readonly ProviderRequest[] {
      return seen;
    },
  };
}

/** Convenience: a single text turn (the common ``say one thing`` script). */
export function textTurn(text: string): ScriptedTurn {
  return { kind: "text", text };
}

/** Convenience: one turn that asks for tool calls (optionally after some text). */
export function toolCallTurn(...calls: ScriptedCall[]): ScriptedTurn {
  return { kind: "calls", calls };
}
