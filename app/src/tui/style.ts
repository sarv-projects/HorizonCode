/**
 * style.ts — tiny ANSI helpers for the HorizonCode chat UI. No dependencies.
 *
 * Colour is OFF unless stdout is a real terminal and the environment does not ask
 * for plain text (`NO_COLOR`, `TERM=dumb`). Every helper degrades to the plain
 * string when colour is off, so callers never have to branch on terminal support.
 */

const ESC = "\u001b[";

let enabled = detectColor();

function detectColor(): boolean {
  try {
    const env: Record<string, string | undefined> = process.env ?? {};
    if (typeof env.NO_COLOR === "string" && env.NO_COLOR !== "") return false;
    if (env.TERM === "dumb" || env.TERM === "unknown") return false;
    if (typeof env.FORCE_COLOR === "string" && env.FORCE_COLOR !== "" && env.FORCE_COLOR !== "0") return true;
    return Boolean((process.stdout as { isTTY?: boolean } | undefined)?.isTTY);
  } catch {
    return false;
  }
}

/** True when colour sequences will actually be emitted. */
export function colorEnabled(): boolean {
  return enabled;
}

/** Force colour on/off (the headless mode forces it off so pipes stay clean). */
export function setColorEnabled(on: boolean): void {
  enabled = Boolean(on);
}

function wrap(code: string, value: unknown): string {
  const s = value === undefined || value === null ? "" : String(value);
  return enabled && s !== "" ? ESC + code + "m" + s + ESC + "0m" : s;
}

export const bold = (s: unknown): string => wrap("1", s);
export const dim = (s: unknown): string => wrap("2", s);
export const cyan = (s: unknown): string => wrap("36", s);
export const green = (s: unknown): string => wrap("32", s);
export const yellow = (s: unknown): string => wrap("33", s);
export const red = (s: unknown): string => wrap("31", s);

/** Bare reset sequence, for callers that build their own runs. */
export const reset = ESC + "0m";

const ANSI_RE = /\u001b\[[0-9;?]*[ -\/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)?|\u001b[@-Z\\-_]/g;

/** Remove ANSI escape sequences. */
export function strip(s: unknown): string {
  return String(s ?? "").replace(ANSI_RE, "");
}

/** Width of the text as a terminal sees it (escape sequences ignored). */
export function visibleWidth(s: unknown): number {
  return Array.from(strip(s)).length;
}

/** Shorten to `max` columns, marking the cut with a single ellipsis. */
export function truncate(s: unknown, max: number): string {
  const text = String(s ?? "");
  if (max <= 0) return "";
  if (text.length <= max) return text;
  return text.slice(0, Math.max(1, max - 1)) + "\u2026";
}

/**
 * Word-wrap plain text to `width` columns. Long words are hard-broken so an odd
 * terminal width can never produce a line that overflows.
 */
export function wrapText(text: unknown, width: number, indent = ""): string[] {
  const limit = Math.max(8, Math.floor(width) - visibleWidth(indent));
  const out: string[] = [];
  const lines = String(text ?? "").replace(/\r/g, "").replace(/\t/g, "  ").split("\n");
  for (const raw of lines) {
    if (raw === "") {
      out.push(indent);
      continue;
    }
    let rest = raw;
    let guard = 0;
    while (rest.length > limit && guard++ < 10000) {
      let cut = rest.lastIndexOf(" ", limit);
      // Avoid a runt line when the first chunk has nowhere good to break.
      if (cut < Math.min(20, Math.max(1, limit >> 1))) cut = limit;
      out.push(indent + rest.slice(0, cut));
      rest = rest.slice(cut).replace(/^ +/, "");
    }
    out.push(indent + rest);
  }
  return out;
}

/** Current terminal width, clamped to something usable. */
export function terminalWidth(): number {
  const cols = (process.stdout as { columns?: number } | undefined)?.columns;
  return Math.max(20, typeof cols === "number" && cols > 0 ? cols : 80);
}

/* ------------------------- small shared helpers ------------------------- */

/** Human-readable message from a thrown value. */
export function errorMessage(err: unknown): string {
  if (err instanceof Error && err.message) return err.message;
  if (typeof err === "string" && err !== "") return err;
  if (err === undefined || err === null) return "unknown error";
  try {
    return JSON.stringify(err) ?? String(err);
  } catch {
    return String(err);
  }
}

/**
 * Strip control characters that would let model output rewrite the terminal
 * (escape sequences, carriage returns, bells…). Newlines and tabs survive.
 */
export function sanitizeText(input: unknown): string {
  const s = input === undefined || input === null ? "" : String(input);
  return s.replace(ANSI_RE, "").replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "");
}
