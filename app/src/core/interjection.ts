/**
 * interjection.ts — mid-turn steering buffer (docs/30 §8 #8, C-9 reduced slice).
 *
 * ADAPT from Grok `xai-interjection-core`: FIFO buffer, one synthetic user
 * message per entry at the next safe step boundary (never merged). The loop
 * drains; producers push while a turn is in flight.
 */

/** Match Grok's large-prompt cap for interjection bodies. */
export const INTERJECTION_LARGE_PROMPT_THRESHOLD = 25_000;

export const INTERJECTION_NOTE =
  "The user sent a message while you were working:";

export const INTERRUPT_NOTE = "The user interrupted the previous turn:";

export const INTERJECTION_UNFINISHED_REMINDER =
  "If the user is asking for a response, address the user first. After replying, complete any unfinished tasks from previous turns.";

export interface PendingInterjection {
  text: string;
}

export interface DrainedInterjection {
  /** Text stored in the transcript for the model. */
  modelText: string;
  /** Raw user text for UI echo (without the synthetic envelope). */
  displayText: string;
}

export type InterjectionRejectReason = "idle" | "empty" | "closed";

export interface InterjectionAcceptResult {
  accepted: true;
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

  push(text: string): void {
    const value = typeof text === "string" ? text.trim() : "";
    if (value === "") return;
    this.queue.push({ text: value });
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

/** Same envelope for post-abort reinject (reserved; headless does not use it yet). */
export function formatInterrupt(text: string): string {
  const body = truncateInterjectionBody(typeof text === "string" ? text : "");
  return frameSteeredUserTurn(INTERRUPT_NOTE, userQueryEnvelope(body));
}

/**
 * Drain the buffer into model-ready rows (FIFO, one message per entry).
 * `sanitize` may strip host-specific artifacts from raw text before framing.
 */
export function drainFormatted(
  buffer: InterjectionBuffer,
  sanitize: (raw: string) => string = (raw) => raw,
): DrainedInterjection[] {
  const entries = buffer.drainAll();
  return entries.map((entry) => {
    const displayText = sanitize(entry.text);
    return { displayText, modelText: formatInterjection(displayText) };
  });
}

/**
 * Accept one interjection from a producer. Image-bearing messages are text-only
 * for this slice: attachments are refused and the text is still queued when present.
 */
export function acceptInterjection(
  buffer: InterjectionBuffer,
  text: string,
  opts?: { images?: readonly unknown[] },
): InterjectionResult {
  const trimmed = typeof text === "string" ? text.trim() : "";
  if (trimmed === "") return { accepted: false, reason: "empty" };
  const imagesRefused = opts?.images !== undefined && opts.images.length > 0;
  buffer.push(trimmed);
  return imagesRefused ? { accepted: true, imagesRefused: true } : { accepted: true };
}
