/**
 * H-4 / ruling **494** — swappable `format_message` class.
 *
 * A small, closed set of built-in message formatters for the provider dialects
 * the product already speaks. The dialect is selected ONLY from config data via
 * the closed `formatMessageClass` class-key map in `config-class-keys.ts` (short
 * name → dialect id). There is NO dynamic import, no plugin registry and no new
 * dependency: every implementation below statically delegates to the adapter's
 * existing pure, exported message converter, so the default output is
 * byte-identical to today's behavior.
 *
 * Interface: `formatMessages` is `format_message`; `formatObservationMessages`
 * is `format_observation_messages` (tool results). The wire array shape is
 * dialect-specific by design (OpenAI objects, Anthropic blocks, Google parts,
 * Ollama objects), so it is intentionally typed `unknown[]`.
 */

import type { ChatMsg } from "../../contracts";
import { parseConfigClassFields, type ResolvedConfigClass } from "../config-class-keys";
import { toOpenAiMessages } from "./openai";
import { toAnthropicMessages } from "./anthropic";
import { toGoogleContents } from "./google";
import { toOllamaMessages } from "./ollama";

export type FormatterDialect = "openai" | "anthropic" | "google" | "ollama";

/** Documented formatter class interface (dialect-agnostic contract). */
export interface MessageFormatter {
  /** Stable dialect id this implementation emits. */
  readonly dialect: FormatterDialect;
  /** `format_message`: contract conversation → provider wire messages. */
  formatMessages(messages: readonly ChatMsg[]): readonly unknown[];
  /** `format_observation_messages`: tool-result messages → wire messages. */
  formatObservationMessages(messages: readonly ChatMsg[]): readonly unknown[];
}

function fromAdapter(
  dialect: FormatterDialect,
  convert: (messages: ChatMsg[]) => readonly unknown[],
): MessageFormatter {
  return {
    dialect,
    formatMessages: (messages) => convert([...messages]),
    formatObservationMessages: (messages) => convert([...messages].filter((m) => m && m.role === "tool")),
  };
}

/** OpenAI chat-completions wire shape (also used by mock / openai-compatible). */
export const OPENAI_FORMATTER: MessageFormatter = fromAdapter("openai", toOpenAiMessages);
export const ANTHROPIC_FORMATTER: MessageFormatter = fromAdapter("anthropic", toAnthropicMessages);
export const GOOGLE_FORMATTER: MessageFormatter = fromAdapter("google", toGoogleContents);
export const OLLAMA_FORMATTER: MessageFormatter = fromAdapter("ollama", toOllamaMessages);

const BY_DIALECT: Readonly<Record<FormatterDialect, MessageFormatter>> = Object.freeze({
  openai: OPENAI_FORMATTER,
  anthropic: ANTHROPIC_FORMATTER,
  google: GOOGLE_FORMATTER,
  ollama: OLLAMA_FORMATTER,
});

/** Default when no formatMessageClass is configured: today's OpenAI path. */
export const DEFAULT_FORMATTER_DIALECT: FormatterDialect = "openai";

/** Static dialect lookup — unknown ids fall back to the default (never throw). */
export function formatterForDialect(dialect: string | undefined): MessageFormatter {
  if (dialect !== undefined && Object.prototype.hasOwnProperty.call(BY_DIALECT, dialect)) {
    return BY_DIALECT[dialect as FormatterDialect];
  }
  return BY_DIALECT[DEFAULT_FORMATTER_DIALECT];
}

/**
 * Select the built-in formatter from a resolved `formatMessageClass` config
 * value. `ResolvedConfigClass.modulePath` holds the dialect id for this key
 * (see config-class-keys.ts). Absent / wrong-key → default, byte-identical.
 */
export function selectMessageFormatter(resolved: ResolvedConfigClass | undefined): MessageFormatter {
  if (resolved === undefined || resolved.key !== "formatMessageClass") {
    return BY_DIALECT[DEFAULT_FORMATTER_DIALECT];
  }
  return formatterForDialect(resolved.modulePath);
}

/**
 * Product wiring seam: an OPTIONAL formatter for `makeProvider`. When the key
 * is unset this returns `undefined` so every adapter keeps its own native
 * message converter (byte-identical default). When set, the resolved dialect
 * id selects a built-in formatter statically — no dynamic import, no new dep.
 */
export function formatterFromResolvedConfig(resolved: ResolvedConfigClass | undefined): MessageFormatter | undefined {
  if (resolved === undefined || resolved.key !== "formatMessageClass") return undefined;
  return formatterForDialect(resolved.modulePath);
}

/** One-shot: raw config data → selected formatter (no config.ts wiring needed). */
export function selectMessageFormatterFromConfig(raw: Record<string, unknown>): MessageFormatter {
  return selectMessageFormatter(parseConfigClassFields(raw).formatMessageClass);
}
