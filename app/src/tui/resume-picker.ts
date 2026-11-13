/**
 * resume-picker.ts — searchable session list for fullscreen-experimental (docs/30 §8 #1, docs/13 D13).
 *
 * Pure layout + state machine; terminal I/O lives in fullscreen-chat.ts.
 */

import type { SessionInfo } from "../core/session";
import { bufferFromLines, type CellBuffer } from "./cellbuffer";

export type ResumePickerItem = SessionInfo & {
  snippet?: string;
  /** When set (from SessionStore), shown on the list row as `N msgs`. */
  messageCount?: number;
  /** Reserved for a future SessionStore cost rollup (docs/13 D13); omitted when unknown. */
  totalCostUsd?: number;
};

export interface ResumePickerState {
  query: string;
  selectedIndex: number;
  /** Index of the first visible list row. */
  scrollOffset: number;
  items: readonly ResumePickerItem[];
}

export type ResumePickerKey =
  | { kind: "filter"; ch: string }
  | { kind: "backspace" }
  | { kind: "up" }
  | { kind: "down" }
  | { kind: "confirm" }
  | { kind: "dismiss" };

export type ResumePickerOutcome =
  | { kind: "pending" }
  | { kind: "resume"; sessionId: string }
  | { kind: "new" };

export interface ResumePickerSearch {
  (query: string, limit?: number): readonly ResumePickerItem[];
}

export interface ResumePickerStepOpts {
  listRows: number;
  search: ResumePickerSearch;
  limit?: number;
}

const DEFAULT_HEADER = "Resume session · type to filter · ↑↓ move · Enter resume · Esc new chat";

export function initialResumePickerState(
  search: ResumePickerSearch,
  limit = 40,
): ResumePickerState {
  const items = search("", limit);
  return { query: "", selectedIndex: items.length > 0 ? 0 : -1, scrollOffset: 0, items };
}

export function resumePickerStateWithQuery(
  state: ResumePickerState,
  query: string,
  search: ResumePickerSearch,
  limit = 40,
): ResumePickerState {
  const items = search(query, limit);
  const selectedIndex = items.length > 0 ? 0 : -1;
  return { query, selectedIndex, scrollOffset: 0, items };
}

function clampScroll(state: ResumePickerState, listRows: number): ResumePickerState {
  const count = state.items.length;
  if (count === 0 || listRows <= 0) return { ...state, scrollOffset: 0, selectedIndex: -1 };
  let { selectedIndex, scrollOffset } = state;
  if (selectedIndex < 0) selectedIndex = 0;
  if (selectedIndex >= count) selectedIndex = count - 1;
  if (selectedIndex < scrollOffset) scrollOffset = selectedIndex;
  if (selectedIndex >= scrollOffset + listRows) scrollOffset = selectedIndex - listRows + 1;
  if (scrollOffset < 0) scrollOffset = 0;
  const maxOffset = Math.max(0, count - listRows);
  if (scrollOffset > maxOffset) scrollOffset = maxOffset;
  return { ...state, selectedIndex, scrollOffset };
}

/** Advance the picker from one logical key event. */
export function applyResumePickerKey(
  state: ResumePickerState,
  key: ResumePickerKey,
  opts: ResumePickerStepOpts,
): { state: ResumePickerState; outcome: ResumePickerOutcome } {
  const limit = opts.limit ?? 40;
  if (key.kind === "dismiss") return { state, outcome: { kind: "new" } };
  if (key.kind === "confirm") {
    const pick = state.items[state.selectedIndex];
    if (pick === undefined) return { state, outcome: { kind: "new" } };
    return { state, outcome: { kind: "resume", sessionId: pick.id } };
  }

  let next = state;
  if (key.kind === "filter") {
    const query = state.query + key.ch;
    next = resumePickerStateWithQuery(state, query, opts.search, limit);
  } else if (key.kind === "backspace") {
    const query = state.query.slice(0, Math.max(0, state.query.length - 1));
    next = resumePickerStateWithQuery(state, query, opts.search, limit);
  } else if (key.kind === "up") {
    if (state.items.length === 0) return { state, outcome: { kind: "pending" } };
    const selectedIndex = state.selectedIndex <= 0 ? state.items.length - 1 : state.selectedIndex - 1;
    next = clampScroll({ ...state, selectedIndex }, opts.listRows);
  } else if (key.kind === "down") {
    if (state.items.length === 0) return { state, outcome: { kind: "pending" } };
    const selectedIndex =
      state.selectedIndex < 0 || state.selectedIndex >= state.items.length - 1 ? 0 : state.selectedIndex + 1;
    next = clampScroll({ ...state, selectedIndex }, opts.listRows);
  }

  return { state: next, outcome: { kind: "pending" } };
}

/** Compact relative time from an ISO `updated` stamp (resume list meta; ruling 262). */
export function formatResumePickerRelativeTime(updatedIso: string, nowMs = Date.now()): string {
  const t = Date.parse(updatedIso);
  if (!Number.isFinite(t)) return "";
  const delta = Math.max(0, nowMs - t);
  const sec = Math.floor(delta / 1000);
  if (sec < 45) return "now";
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m`;
  const hr = Math.floor(min / 60);
  if (hr < 48) return `${hr}h`;
  const day = Math.floor(hr / 24);
  if (day < 14) return `${day}d`;
  const d = new Date(t);
  const mon = d.toLocaleString("en-US", { month: "short", timeZone: "UTC" });
  return `${mon} ${d.getUTCDate()}`;
}

export function formatResumePickerRowMeta(item: ResumePickerItem, nowMs?: number): string {
  const parts: string[] = [];
  const rel = formatResumePickerRelativeTime(item.updated, nowMs);
  if (rel !== "") parts.push(rel);
  if (typeof item.messageCount === "number" && item.messageCount >= 0) {
    parts.push(`${item.messageCount} msg${item.messageCount === 1 ? "" : "s"}`);
  }
  if (typeof item.totalCostUsd === "number" && Number.isFinite(item.totalCostUsd) && item.totalCostUsd > 0) {
    parts.push(`$${item.totalCostUsd.toFixed(2)}`);
  }
  return parts.join(" · ");
}

function truncateMiddle(text: string, max: number): string {
  if (max <= 0) return "";
  if (text.length <= max) return text;
  if (max <= 3) return text.slice(0, max);
  const head = Math.ceil((max - 1) / 2);
  const tail = max - 1 - head;
  return `${text.slice(0, head)}…${text.slice(text.length - tail)}`;
}

export function formatResumePickerRow(
  item: ResumePickerItem,
  currentSessionId: string,
  selected: boolean,
  width: number,
  nowMs?: number,
): string {
  const w = Math.max(10, Math.floor(width));
  const mark = item.id === currentSessionId ? "*" : " ";
  const caret = selected ? ">" : " ";
  const title = (item.title ?? "").replace(/\s+/g, " ").trim() || "(no title)";
  const id = item.id;
  const prefix = `${caret}${mark} ${id}  `;
  const meta = formatResumePickerRowMeta(item, nowMs);
  const metaPad = meta === "" ? "" : `  ${meta}`;
  const titleBudget = Math.max(0, w - prefix.length - metaPad.length);
  const titleFit = titleBudget > 0 ? truncateMiddle(title, titleBudget) : "";
  const line = `${prefix}${titleFit}${metaPad}`;
  if (line.length <= w) return line.padEnd(w, " ");
  return line.slice(0, w).padEnd(w, " ");
}

export function formatResumePickerForkPreview(item: ResumePickerItem): string | undefined {
  const fork = item.forkedFrom;
  if (fork === undefined) return undefined;
  const parent = fork.sessionId;
  const shortParent = parent.length > 14 ? `${parent.slice(0, 12)}…` : parent;
  return `fork ${shortParent} @ msg ${fork.messageIndex}`;
}

export function formatResumePickerSnippet(item: ResumePickerItem, width: number): string | undefined {
  const parts: string[] = [];
  const forkLine = formatResumePickerForkPreview(item);
  if (forkLine !== undefined) parts.push(forkLine);
  const raw = item.snippet?.replace(/\s+/g, " ").trim();
  if (raw !== undefined && raw !== "") parts.push(raw);
  if (parts.length === 0) return undefined;
  const w = Math.max(10, Math.floor(width));
  const body = parts.join(" · ");
  const line = `      ${body}`;
  return line.slice(0, w).padEnd(w, " ");
}

export interface ResumePickerFrameInput {
  width: number;
  height: number;
  state: ResumePickerState;
  currentSessionId: string;
  header?: string;
}

/** Cell grid for the alt-screen picker (status, filter, scrollable list, footer). */
export function buildResumePickerFrame(opts: ResumePickerFrameInput): CellBuffer {
  const w = Math.max(24, Math.floor(opts.width));
  const h = Math.max(5, Math.floor(opts.height));
  const header = (opts.header ?? DEFAULT_HEADER).slice(0, w);
  const filterLabel = "Filter: ";
  const filterLine = (filterLabel + opts.state.query).slice(0, w).padEnd(w, " ");
  const footer =
    (opts.state.items.length === 0
      ? "No matching sessions · Esc starts a new chat"
      : `${opts.state.items.length} session(s) · row ${Math.max(0, opts.state.selectedIndex) + 1}/${opts.state.items.length}`
    ).slice(0, w);

  const listStart = 2;
  const listEnd = h - 2;
  const listRows = Math.max(1, listEnd - listStart);
  const grid: string[] = new Array(h).fill("".padEnd(w, " "));
  grid[0] = header.padEnd(w, " ").slice(0, w);
  grid[1] = filterLine;
  grid[h - 1] = footer.padEnd(w, " ").slice(0, w);

  const { items, scrollOffset, selectedIndex } = opts.state;
  let row = listStart;
  let vis = 0;
  while (row < listEnd && vis < items.length) {
    const item = items[scrollOffset + vis];
    if (item === undefined) break;
    const selected = scrollOffset + vis === selectedIndex;
    grid[row] = formatResumePickerRow(item, opts.currentSessionId, selected, w);
    row += 1;
    if (selected) {
      const snip = formatResumePickerSnippet(item, w);
      if (snip !== undefined && row < listEnd) {
        grid[row] = snip;
        row += 1;
      }
    }
    vis += 1;
  }
  while (row < listEnd) {
    grid[row] = "".padEnd(w, " ");
    row += 1;
  }

  return bufferFromLines(grid, w, h);
}

/** 1-based terminal column for the filter cursor. */
export function resumePickerFilterCursorColumn(query: string): number {
  return Math.max(1, "Filter: ".length + query.length + 1);
}
