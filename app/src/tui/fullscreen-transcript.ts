/**
 * fullscreen-transcript.ts — alt-screen transcript buffer helpers (docs/33 §5.17).
 *
 * Pure: funnel scrollback `createRenderer` chunks into stripped transcript lines
 * for the reduced cellbuffer pane. Rich diff gutters follow `liveEnabled()` (ruling
 * **259**), not the stricter single-key approval gate.
 */

import type { RuntimeEvent } from "../contracts";
import { liveEnabled } from "./live";
import { createRenderer } from "./render";
import { sanitizeText, strip, type ColorLevel } from "./style";
import {
  TRANSCRIPT_BACKFILL_CHUNK,
  TRANSCRIPT_TAIL_ROWS,
  createTranscriptMountBudget,
  sliceTranscriptTailFirst,
  type TranscriptMountBudget,
  type TranscriptMountBudgetOptions,
  type TranscriptMountWindow,
} from "./transcript";

export {
  TRANSCRIPT_BACKFILL_CHUNK,
  TRANSCRIPT_TAIL_ROWS,
  createTranscriptMountBudget,
  sliceTranscriptTailFirst,
  type TranscriptMountBudget,
  type TranscriptMountBudgetOptions,
  type TranscriptMountWindow,
};

/**
 * Mount the fullscreen transcript tail-first using a progressive 40/60 budget.
 * When `scrollUp` approaches older rows, automatically expands the budget in
 * 60-row chunks so scrolled viewports stay populated without mounting huge
 * histories eagerly on first paint.
 */
export function mountFullscreenTranscriptWindow(
  transcript: readonly string[],
  budget: TranscriptMountBudget,
  opts: { scrollUp?: number; viewportRows?: number } = {},
): TranscriptMountWindow<string> {
  const scrollUp = Math.max(0, Math.floor(opts.scrollUp ?? 0));
  const viewportRows = Math.max(1, Math.floor(opts.viewportRows ?? budget.tailRows));
  if (scrollUp > 0) {
    budget.ensureVisible(transcript.length, scrollUp, viewportRows);
  }
  return budget.slice(transcript);
}

/** Same colour contract as scrollback `createRenderer({ rich: liveEnabled() })`. */
export function fullscreenRichTranscriptEnabled(
  input: { isTty?: boolean },
  liveOn: (stream: { isTTY?: boolean }) => boolean = liveEnabled,
): boolean {
  if (input.isTty === false) return false;
  if (input.isTty !== true) return false;
  return liveOn({ isTTY: true });
}

/** Append one renderer write chunk as transcript lines (ANSI stripped for the grid). */
export function pushTranscriptChunks(transcript: string[], chunk: string): void {
  const plain = strip(sanitizeText(chunk.replace(/\r/g, "")));
  if (plain === "") return;
  const parts = plain.split("\n");
  for (let i = 0; i < parts.length; i += 1) {
    const part = parts[i] ?? "";
    if (i === 0 && transcript.length > 0 && !plain.startsWith("\n") && !chunk.startsWith("\n")) {
      transcript[transcript.length - 1] = (transcript[transcript.length - 1] ?? "") + part;
    } else {
      transcript.push(part);
    }
  }
}

export interface FullscreenTranscriptRenderOptions {
  rich: boolean;
  level?: ColorLevel;
  unicode?: boolean;
}

/** ADAPT scrollback render path: runtime events → fullscreen transcript lines (tests). */
export function transcriptLinesFromRendererEvents(
  events: readonly RuntimeEvent[],
  opts: FullscreenTranscriptRenderOptions,
): string[] {
  const transcript: string[] = [];
  const renderer = createRenderer({
    wrap: false,
    rich: opts.rich,
    level: opts.level,
    unicode: opts.unicode,
    out: (chunk) => pushTranscriptChunks(transcript, chunk),
  });
  for (const ev of events) renderer.handle(ev);
  return transcript;
}
