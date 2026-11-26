/**
 * interjection.ts — mid-turn steering buffer (docs/30 §8 #8, C-9 reduced slice).
 *
 * ADAPT from Grok `xai-interjection-core`: FIFO buffer, one synthetic user
 * message per entry at the next safe step boundary (never merged). The loop
 * drains; producers push while a turn is in flight.
 */

import type { ChatContentPart } from "../contracts";

/** Match Grok's large-prompt cap for interjection bodies. */
export const INTERJECTION_LARGE_PROMPT_THRESHOLD = 25_000;

export const INTERJECTION_NOTE =
  "The user sent a message while you were working:";

export const INTERRUPT_NOTE = "The user interrupted the previous turn:";

export const INTERJECTION_UNFINISHED_REMINDER =
  "If the user is asking for a response, address the user first. After replying, complete any unfinished tasks from previous turns.";

export interface PendingInterjection {
  text: string;
  /** "interrupt" uses the <system-interrupt> envelope from the chat bar. */
  framing?: "steer" | "interrupt";
  /** Preserved image parts for multimodal steering. */
  images?: readonly ChatContentPart[];
}

export interface DrainedInterjection {
  /** Text stored in the transcript for the model. */
  modelText: string;
  /** Raw user text for UI echo (without the synthetic envelope). */
  displayText: string;
  /** Optional multipart content for multimodal providers. */
  contentParts?: ChatContentPart[];
}

export type InterjectionRejectReason = "idle" | "empty" | "closed";

export interface InterjectionAcceptResult {
  accepted: true;
  /** True when image attachments were accepted into the steering buffer. */
  imagesAccepted?: true;
  /** True when image attachments were dropped on the floor. */
  imagesRefused?: true;
}

export interface InterjectionRejectResult {
  accepted: false;
  reason: InterjectionRejectReason;
}

export type InterjectionResult = InterjectionAcceptResult | InterjectionRejectResult;

/** Hard cap on buffered interjections per turn (oldest dropped). */
export const INTERJECTION_BUFFER_CAP = 32;

/**
 * FIFO buffer for mid-turn user text. One instance is scoped to a single
 * `runTurn` / `send()`; clones are not shared.
 */
export class InterjectionBuffer {
  private readonly queue: PendingInterjection[] = [];

  push(text: string, framing?: "steer" | "interrupt", images?: readonly ChatContentPart[]): void {
    const value = typeof text === "string" ? text.trim() : "";
    if (value === "") return;
    this.queue.push({ text: value, framing, ...(images && images.length > 0 ? { images } : {}) });
    if (this.queue.length > INTERJECTION_BUFFER_CAP) {
      this.queue.splice(0, this.queue.length - INTERJECTION_BUFFER_CAP);
    }
  }

  len(): number {
    return this.queue.length;
  }

  isEmpty(): boolean {
    return this.queue.length === 0;
  }

  drainAll(): PendingInterjection[] {
    if (this.queue.length === 0) return [];
    return this.queue.splice(0, this.queue.length);
  }

  /** Cancel-safety: put entries back at the front, preserving order. */
  restoreFront(entries: readonly PendingInterjection[]): void {
    if (entries.length === 0) return;
    this.queue.unshift(...entries);
  }
}

export function userQueryEnvelope(userMessage: string): string {
  return `<user_query>\n${userMessage}\n</user_query>`;
}

function frameSteeredUserTurn(note: string, body: string): string {
  return `${note}\n${body}\n${INTERJECTION_UNFINISHED_REMINDER}`;
}

function truncateInterjectionBody(text: string): string {
  if (text.length <= INTERJECTION_LARGE_PROMPT_THRESHOLD) return text;
  return `${text.slice(0, INTERJECTION_LARGE_PROMPT_THRESHOLD)}... [truncated]`;
}

/** Wrap raw user text as a mid-turn synthetic user message (Grok `format_interjection`). */
export function formatInterjection(text: string): string {
  const body = truncateInterjectionBody(typeof text === "string" ? text : "");
  return frameSteeredUserTurn(INTERJECTION_NOTE, userQueryEnvelope(body));
}

/**
 * Chat-bar mid-turn steer (docs/28 §14): an explicit <system-interrupt> signal.
 * The turn is NOT aborted; the buffer still drains at the next safe step
 * boundary, so this is a redirect, not a restart.
 */
export function formatSystemInterruptSteer(text: string): string {
  const body = truncateInterjectionBody(typeof text === "string" ? text : "");
  return [
    '<system-interrupt reason="steer">',
    INTERJECTION_NOTE,
    userQueryEnvelope(body),
    INTERJECTION_UNFINISHED_REMINDER,
    "</system-interrupt>",
  ].join("\n");
}

/** Same envelope for post-abort reinject (reserved; headless does not use it yet). */
export function formatInterrupt(text: string): string {
  const body = truncateInterjectionBody(typeof text === "string" ? text : "");
  return frameSteeredUserTurn(INTERRUPT_NOTE, userQueryEnvelope(body));
}

/**
 * Drain the buffer into model-ready rows (FIFO, one message per entry).
 * `sanitize` may strip host-specific artifacts from raw text before framing.
 */
/**
 * Stranded mid-turn steer that never reached a step boundary (e.g. abort).
 * `interrupted` selects the Grok interrupt envelope vs the mid-turn steer envelope.
 */
export function formatStrandedInterjections(
  entries: readonly PendingInterjection[],
  interrupted: boolean,
): DrainedInterjection[] {
  const fmt = interrupted ? formatInterrupt : formatInterjection;
  return entries.map((entry) => ({
    displayText: entry.text,
    modelText: fmt(entry.text),
  }));
}

/** Drain with the original PendingInterjection kept alongside each row. */
export function drainFormattedWithRows(
  buffer: InterjectionBuffer,
  sanitize: (raw: string) => string = (raw) => raw,
): Array<{ row: DrainedInterjection; entry: PendingInterjection }> {
  return buffer.drainAll().map((entry) => {
    const displayText = sanitize(entry.text);
    const modelText =
      entry.framing === "interrupt" ? formatSystemInterruptSteer(displayText) : formatInterjection(displayText);
    const contentParts: ChatContentPart[] | undefined =
      entry.images && entry.images.length > 0
        ? [{ type: "text", text: modelText }, ...entry.images]
        : undefined;
    return {
      row: {
        displayText,
        modelText,
        ...(contentParts ? { contentParts } : {}),
      },
      entry,
    };
  });
}

export function drainFormatted(
  buffer: InterjectionBuffer,
  sanitize: (raw: string) => string = (raw) => raw,
): DrainedInterjection[] {
  return drainFormattedWithRows(buffer, sanitize).map(({ row }) => row);
}

/**
 * Accept one interjection from a producer. Valid image parts are queued alongside text
 * when multimodal steering is permitted; malformed/unsupported items are refused.
 */
export function acceptInterjection(
  buffer: InterjectionBuffer,
  text: string,
  opts?: { images?: readonly unknown[]; mode?: "steer" | "interrupt"; allowImages?: boolean },
): InterjectionResult {
  const trimmed = typeof text === "string" ? text.trim() : "";
  if (trimmed === "") return { accepted: false, reason: "empty" };
  const rawImages = opts?.images ?? [];
  const validImages: ChatContentPart[] = [];
  for (const item of rawImages) {
    if (
      item !== null &&
      typeof item === "object" &&
      "type" in item &&
      ((item as { type: string }).type === "image" || (item as { type: string }).type === "image_url")
    ) {
      validImages.push(item as ChatContentPart);
    }
  }
  const imagesAllowed = opts?.allowImages ?? true;
  if (imagesAllowed && validImages.length > 0 && validImages.length === rawImages.length) {
    buffer.push(trimmed, opts?.mode ?? "steer", validImages);
    return { accepted: true, imagesAccepted: true };
  }
  const imagesRefused = rawImages.length > 0;
  buffer.push(trimmed, opts?.mode ?? "steer");
  return imagesRefused ? { accepted: true, imagesRefused: true } : { accepted: true };
}
