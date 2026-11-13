/**
 * mouse-parse.ts — SGR and X10 mouse sequence parser (docs/33 §5.19 / docs/13 D3 step 1).
 *
 * Pure incremental parser: non-mouse bytes are never swallowed (R35). For use
 * inside a fullscreen input loop only; scrollback mode must not enable capture.
 */

export type MouseButton = 0 | 1 | 2 | 3 | 4 | 5;

export interface MouseEvent {
  encoding: "sgr" | "x10";
  /** press | release | move (X10 motion) | wheel */
  action: "press" | "release" | "move" | "wheel";
  button: MouseButton;
  /** 1-based row */
  row: number;
  /** 1-based column */
  col: number;
  shift: boolean;
  meta: boolean;
  ctrl: boolean;
}

export interface MouseFeedResult {
  events: MouseEvent[];
  /** Bytes that were not part of a mouse sequence (or incomplete prefixes kept). */
  plain: string;
}

function parseSgrParams(body: string): MouseEvent | undefined {
  const parts = body.split(";");
  if (parts.length < 3) return undefined;
  const cb = Number(parts[0]);
  const col = Number(parts[1]);
  const row = Number(parts[2]);
  if (!Number.isFinite(cb) || !Number.isFinite(col) || !Number.isFinite(row)) return undefined;
  const wheel = cb >= 64 && cb <= 67;
  const release = !wheel && cb === 3;
  const drag = !wheel && cb >= 32 && cb <= 43;
  let button = (cb & 0b11) as MouseButton;
  if (wheel) button = (cb - 64) as MouseButton;
  return {
    encoding: "sgr",
    action: wheel ? "wheel" : release ? "release" : drag ? "move" : "press",
    button,
    row,
    col,
    shift: (cb & 0b0100) !== 0,
    meta: (cb & 0b1000) !== 0,
    ctrl: (cb & 0b1_0000) !== 0,
  };
}

function parseX10(seq: string): MouseEvent | undefined {
  if (seq.length < 6) return undefined;
  const b = seq.charCodeAt(3) - 32;
  const col = seq.charCodeAt(4) - 32;
  const row = seq.charCodeAt(5) - 32;
  if (b < 0 || col < 1 || row < 1) return undefined;
  const release = (b & 0b11) === 0b11;
  const button = (b & 0b11) as MouseButton;
  return {
    encoding: "x10",
    action: release ? "release" : "press",
    button,
    row,
    col,
    shift: (b & 0b0100) !== 0,
    meta: (b & 0b1000) !== 0,
    ctrl: false,
  };
}

/**
 * Feed a chunk of stdin bytes. Incomplete escape sequences stay in `carry` until
 * completed or proven non-mouse.
 */
export function feedMouseBytes(chunk: string, carry = ""): { result: MouseFeedResult; carry: string } {
  const events: MouseEvent[] = [];
  let plain = "";
  let buf = carry + chunk;
  let i = 0;
  while (i < buf.length) {
    const rest = buf.slice(i);
    if (rest.startsWith("\u001b[<")) {
      const end = rest.indexOf("m", 3);
      if (end === -1) break;
      const ev = parseSgrParams(rest.slice(3, end));
      if (ev) events.push(ev);
      i += end + 1;
      continue;
    }
    if (rest.startsWith("\u001b[M")) {
      if (rest.length < 6) break;
      const ev = parseX10(rest.slice(0, 6));
      if (ev) events.push(ev);
      i += 6;
      continue;
    }
    if (rest.startsWith("\u001b") && rest.length < 8) break;
    plain += rest[0];
    i += 1;
  }
  const nextCarry = i < buf.length ? buf.slice(i) : "";
  return { result: { events, plain }, carry: nextCarry };
}

/** Drain carry as plain text (used when closing capture). */
export function flushMouseCarry(carry: string): string {
  return carry;
}
