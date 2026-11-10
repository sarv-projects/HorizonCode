/**
 * style.ts — tiny ANSI helpers for the HorizonCode chat UI. No dependencies.
 *
 * Colour is OFF unless stdout is a real terminal and the environment does not ask
 * for plain text (`NO_COLOR`, `TERM=dumb`). Every helper degrades to the plain
 * string when colour is off, so callers never have to branch on terminal support.
 */

const ESC = "\u001b[";

let enabled = detectColor();
let levelOverride: ColorLevel | undefined;

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
  levelOverride = undefined;
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

/** Columns one code point occupies: 0 combining/joiners, 2 wide (CJK, emoji), else 1. */
export function charWidth(cp: number): number {
  if (cp < 0x300) return 1;
  if ((cp >= 0x300 && cp <= 0x36f) || (cp >= 0x200b && cp <= 0x200f) || (cp >= 0xfe00 && cp <= 0xfe0f)) return 0;
  if (
    (cp >= 0x1100 && cp <= 0x115f) ||
    (cp >= 0x2e80 && cp <= 0xa4cf) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe30 && cp <= 0xfe6f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f300 && cp <= 0x1faff)
  )
    return 2;
  return 1;
}

/** Width of the text as a terminal sees it (escape sequences ignored, wide chars count 2). */
export function visibleWidth(s: unknown): number {
  let w = 0;
  for (const ch of strip(s)) w += charWidth(ch.codePointAt(0) ?? 0);
  return w;
}

/** Shorten to `max` columns, marking the cut with a single ellipsis. */
export function truncate(s: unknown, max: number, ellipsis = "\u2026"): string {
  const text = String(s ?? "");
  if (max <= 0) return "";
  if (ellipsis !== "\u2026") {
    if (visibleWidth(text) <= max) return text;
    const keep = Math.max(0, max - visibleWidth(ellipsis));
    let out = "";
    let w = 0;
    for (const ch of text) {
      const cw = charWidth(ch.codePointAt(0) ?? 0);
      if (w + cw > keep) break;
      out += ch;
      w += cw;
    }
    return out + ellipsis;
  }
  // Fast path: plain narrow text is measured by length.
  if (/^[\u0020-\u02ff]*$/.test(text)) {
    if (text.length <= max) return text;
    return text.slice(0, Math.max(1, max - 1)) + "\u2026";
  }
  if (visibleWidth(text) <= max) return text;
  let out = "";
  let w = 0;
  for (const ch of text) {
    const cw = charWidth(ch.codePointAt(0) ?? 0);
    if (w + cw > Math.max(1, max - 1)) break;
    out += ch;
    w += cw;
  }
  return out + "\u2026";
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

/* ------------------------ colour levels and role table ------------------------ */

/** 0 none, 1 basic 16, 2 ansi 256, 3 truecolor. */
export type ColorLevel = 0 | 1 | 2 | 3;
export type RGB = readonly [number, number, number];

/**
 * Detection order (first match wins): NO_COLOR / dumb / not a TTY => 0, then
 * FORCE_COLOR 1|2|3, COLORTERM truecolor, known truecolor terminals, a
 * `256color` TERM, any other xterm-ish TERM => 1, else 0.
 */
export function detectColorLevel(
  env: Record<string, string | undefined> = process.env ?? {},
  isTTY: boolean = Boolean((process.stdout as { isTTY?: boolean } | undefined)?.isTTY),
): ColorLevel {
  if (typeof env.NO_COLOR === "string" && env.NO_COLOR !== "") return 0;
  const term = env.TERM ?? "";
  if (term === "dumb" || term === "unknown") return 0;
  const force = env.FORCE_COLOR;
  if (typeof force === "string" && force !== "" && force !== "0" && force !== "false") {
    if (force === "2") return 2;
    if (force === "3") return 3;
    return 1;
  }
  if (!isTTY) return 0;
  const ct = (env.COLORTERM ?? "").toLowerCase();
  if (ct === "truecolor" || ct === "24bit") return 3;
  const prog = env.TERM_PROGRAM ?? "";
  if (["iTerm.app", "WezTerm", "ghostty", "vscode"].includes(prog)) return 3;
  if (env.WT_SESSION || env.KITTY_WINDOW_ID) return 3;
  if (/kitty|alacritty|foot|ghostty/.test(term)) return 3;
  if (/256color/.test(term)) return 2;
  if (/^(xterm|screen|tmux|vt100|linux|ansi|rxvt)/.test(term)) return 1;
  return 0;
}

/** Current level: 0 whenever colour is off (headless, NO_COLOR); forced-on pipes get 1. */
export function colorLevel(): ColorLevel {
  if (!enabled) return 0;
  if (levelOverride !== undefined) return levelOverride;
  const detected = detectColorLevel();
  return detected === 0 ? 1 : detected;
}

/** Pin the level (tests, `--color` style overrides). Cleared by setColorEnabled. */
export function setColorLevel(level: ColorLevel | undefined): void {
  levelOverride = level;
  if (level !== undefined) enabled = level > 0;
}

export type Role =
  | "accent" | "info" | "ok" | "err" | "warn" | "path" | "text" | "muted" | "faint"
  | "link" | "h1" | "h2" | "h3" | "code" | "bgUser" | "bgPanel" | "bgAdd" | "bgDel";

interface RoleDef {
  rgb: RGB;
  idx: number;
  /** SGR for the basic 16 level; "2" = dim, "" = terminal default */
  basic: string;
}

const DARK: Record<Role, RoleDef> = {
  accent: { rgb: [0xbb, 0x9a, 0xf7], idx: 141, basic: "35" },
  info: { rgb: [0x7d, 0xcf, 0xff], idx: 117, basic: "36" },
  ok: { rgb: [0x9e, 0xce, 0x6a], idx: 149, basic: "32" },
  err: { rgb: [0xf7, 0x76, 0x8e], idx: 211, basic: "31" },
  warn: { rgb: [0xe0, 0xaf, 0x68], idx: 179, basic: "33" },
  path: { rgb: [0xff, 0x9e, 0x64], idx: 215, basic: "33" },
  text: { rgb: [0xe1, 0xe1, 0xe1], idx: 253, basic: "" },
  muted: { rgb: [0x6c, 0x6c, 0x6c], idx: 242, basic: "2" },
  faint: { rgb: [0x58, 0x58, 0x58], idx: 240, basic: "2" },
  link: { rgb: [0x7a, 0xa6, 0xda], idx: 110, basic: "34" },
  h1: { rgb: [0x1a, 0xbc, 0x9c], idx: 36, basic: "36" },
  h2: { rgb: [0x7a, 0xa2, 0xf7], idx: 111, basic: "34" },
  h3: { rgb: [0x9d, 0x7c, 0xd8], idx: 98, basic: "35" },
  code: { rgb: [0x3a, 0x95, 0xab], idx: 37, basic: "36" },
  bgUser: { rgb: [0x24, 0x24, 0x24], idx: 235, basic: "" },
  bgPanel: { rgb: [0x1c, 0x1c, 0x1c], idx: 234, basic: "" },
  bgAdd: { rgb: [0x06, 0x38, 0x06], idx: 22, basic: "" },
  bgDel: { rgb: [0x42, 0x0e, 0x14], idx: 52, basic: "" },
};

const LIGHT_OVERRIDES: Partial<Record<Role, RoleDef>> = {
  accent: { rgb: [0x7d, 0x4b, 0xc6], idx: 98, basic: "35" },
  info: { rgb: [0x00, 0x82, 0xaa], idx: 31, basic: "36" },
  ok: { rgb: [0x37, 0x8e, 0x23], idx: 28, basic: "32" },
  err: { rgb: [0xcd, 0x30, 0x48], idx: 161, basic: "31" },
  warn: { rgb: [0xa2, 0x76, 0x12], idx: 136, basic: "33" },
  path: { rgb: [0xc3, 0x69, 0x1e], idx: 166, basic: "33" },
  text: { rgb: [0x26, 0x26, 0x26], idx: 235, basic: "" },
  muted: { rgb: [0x76, 0x76, 0x76], idx: 243, basic: "2" },
  bgUser: { rgb: [0xe4, 0xe4, 0xe4], idx: 254, basic: "" },
  bgPanel: { rgb: [0xec, 0xec, 0xec], idx: 255, basic: "" },
  bgAdd: { rgb: [0xda, 0xf2, 0xdc], idx: 194, basic: "" },
  bgDel: { rgb: [0xf5, 0xda, 0xde], idx: 224, basic: "" },
};

/** `light` when HZ_THEME says so or COLORFGBG reports a light background; else `dark`. */
export function detectTheme(env: Record<string, string | undefined> = process.env ?? {}): "dark" | "light" {
  const forced = (env.HZ_THEME ?? "").toLowerCase();
  if (forced === "light" || forced === "dark") return forced;
  const fgbg = env.COLORFGBG;
  if (typeof fgbg === "string") {
    const bg = Number(fgbg.split(";").pop());
    if (Number.isFinite(bg) && bg >= 7 && bg !== 8) return "light";
  }
  return "dark";
}

/** Session palette choice (`/theme`): auto follows detectTheme(); mono drops every colour. */
export type ThemeMode = "auto" | "dark" | "light" | "mono";
let themeModeValue: ThemeMode = "auto";

export function setThemeMode(mode: ThemeMode): void {
  themeModeValue = mode;
}
export function themeMode(): ThemeMode {
  return themeModeValue;
}
/** The palette in use: the pinned dark/light, else what the terminal/env suggests. */
export function activeTheme(): "dark" | "light" {
  return themeModeValue === "dark" || themeModeValue === "light" ? themeModeValue : detectTheme();
}

function roleDef(role: Role): RoleDef {
  return (activeTheme() === "light" ? LIGHT_OVERRIDES[role] : undefined) ?? DARK[role];
}

/** The SGR parameter string that selects `role` as a foreground at `level` ("" = none). */
export function fgCode(role: Role, level: ColorLevel = colorLevel()): string {
  if (level === 0 || themeModeValue === "mono") return "";
  const d = roleDef(role);
  if (level === 3) return `38;2;${d.rgb[0]};${d.rgb[1]};${d.rgb[2]}`;
  if (level === 2) return `38;5;${d.idx}`;
  return d.basic;
}

/** Background parameters; basic 16 drops backgrounds (they differ wildly per profile). */
export function bgCode(role: Role, level: ColorLevel = colorLevel()): string {
  if (level < 2 || themeModeValue === "mono") return "";
  const d = roleDef(role);
  return level === 3 ? `48;2;${d.rgb[0]};${d.rgb[1]};${d.rgb[2]}` : `48;5;${d.idx}`;
}

/** Colour `s` with a role. Plain text at level 0. */
export function paint(role: Role, s: unknown, level: ColorLevel = colorLevel()): string {
  const text = s === undefined || s === null ? "" : String(s);
  const code = fgCode(role, level);
  return code === "" || text === "" ? text : ESC + code + "m" + text + ESC + "0m";
}

/** Role-based helpers; every call site goes through the table, never raw SGR. */
export const c = {
  accent: (s: unknown): string => paint("accent", s),
  info: (s: unknown): string => paint("info", s),
  ok: (s: unknown): string => paint("ok", s),
  err: (s: unknown): string => paint("err", s),
  warn: (s: unknown): string => paint("warn", s),
  path: (s: unknown): string => paint("path", s),
  muted: (s: unknown): string => paint("muted", s),
  faint: (s: unknown): string => paint("faint", s),
  link: (s: unknown): string => paint("link", s),
  code: (s: unknown): string => bold(paint("code", s)),
};

/**
 * `inner` on a background role, padded with spaces to `width` columns. At level
 * < 2 there is no background: the text is returned unpadded.
 */
export function onBg(role: Role, inner: string, width: number, level: ColorLevel = colorLevel()): string {
  const code = bgCode(role, level);
  if (code === "") return inner;
  const pad = " ".repeat(Math.max(0, Math.floor(width) - visibleWidth(inner)));
  // Re-open the background after any reset inside `inner` so the row stays filled.
  const body = inner.split(ESC + "0m").join(ESC + "0m" + ESC + code + "m");
  return ESC + code + "m" + body + pad + ESC + "0m";
}

/** Linear RGB blend, t in [0,1]. */
export function blend(a: RGB, b: RGB, t: number): RGB {
  const k = Math.max(0, Math.min(1, Number.isFinite(t) ? t : 0));
  return [0, 1, 2].map((i) => Math.round(a[i] + (b[i] - a[i]) * k)) as unknown as RGB;
}

/** sin^2(tick * speed): the pulse in [0,1] (Grok `pulse_brightness`). */
export function pulse(tick: number, speed = 0.08): number {
  const v = Math.sin((Number.isFinite(tick) ? tick : 0) * speed);
  return v * v;
}

/** Nearest xterm-256 index for an RGB colour (6x6x6 cube or grey ramp). */
export function nearestIndexed(rgb: RGB): number {
  const lv = [0, 95, 135, 175, 215, 255];
  const near = (v: number): number => lv.reduce((best, x, i) => (Math.abs(x - v) < Math.abs(lv[best] - v) ? i : best), 0);
  const [ri, gi, bi] = [near(rgb[0]), near(rgb[1]), near(rgb[2])];
  const cube: RGB = [lv[ri], lv[gi], lv[bi]];
  const gray = Math.max(0, Math.min(23, Math.round((((rgb[0] + rgb[1] + rgb[2]) / 3) - 8) / 10)));
  const gv = 8 + gray * 10;
  const dist = (p: RGB): number => (p[0] - rgb[0]) ** 2 + (p[1] - rgb[1]) ** 2 + (p[2] - rgb[2]) ** 2;
  return dist([gv, gv, gv]) < dist(cube) ? 232 + gray : 16 + 36 * ri + 6 * gi + bi;
}

/** Foreground escape for an arbitrary RGB colour at `level` ("" at levels 0/1). */
export function rgbFg(rgb: RGB, level: ColorLevel = colorLevel()): string {
  if (level === 3) return `${ESC}38;2;${rgb[0]};${rgb[1]};${rgb[2]}m`;
  if (level === 2) return `${ESC}38;5;${nearestIndexed(rgb)}m`;
  return "";
}
