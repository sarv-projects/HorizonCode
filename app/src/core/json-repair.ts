/**
 * Tolerant decoding of model-produced tool arguments (NF-069, docs/10 R15).
 *
 * Models routinely emit JSON that is one syntactic slip away from valid:
 * a trailing comma, single or typographic quotes, an unquoted key, a stray
 * code fence, a raw newline inside a string, or a tail cut off by the output
 * limit. Failing the whole turn on those is wasteful, so this module repairs
 * ONLY syntactic defects, counts every repair, and then (separately) coerces
 * scalar types to the tool's own JSON schema where the conversion is
 * unambiguous ("42" to 42, "true" to true).
 *
 * Fail closed. The parser never guesses a value:
 *  - a bare word that is not true/false/null is an error, not a string;
 *  - a member whose value was cut off is dropped, never completed with null;
 *  - a truncated tail is reported (`truncated: true`) and `parseToolArguments`
 *    refuses it for every tool except a short allowlist of read-only tools, so
 *    a half-sent shell `command` or file `content` is never completed and run.
 *
 * Zero dependencies. The receipt hashes the REPAIRED args that were admitted
 * (the loop issues it from the parsed result), so the audit trail names the
 * exact arguments that ran, and `repaired: true` marks the event and card.
 */

export interface RepairOutcome {
  ok: boolean;
  value?: unknown;
  /** One entry per repair applied, in order (the same repair twice is listed twice). */
  repairs: string[];
  /** The input ended inside a structure or string and was closed by the parser. */
  truncated: boolean;
  error?: string;
}

class RepairError extends Error {}

/** Marker for "no value here" (EOF where a value was due); the member is dropped. */
const NONE = Symbol("none");

const OPEN_TO_CLOSE: Record<string, string> = {
  '"': '"',
  "'": "'",
  "\u201C": "\u201D",
  "\u2018": "\u2019",
  "`": "`",
};
const QUOTE_NAMES: Record<string, string> = {
  "'": "single quotes",
  "\u201C": "smart quotes",
  "\u2018": "smart quotes",
  "`": "backtick quotes",
};
const SIMPLE_ESCAPES: Record<string, string> = {
  '"': '"',
  "\\": "\\",
  "/": "/",
  b: "\b",
  f: "\f",
  n: "\n",
  r: "\r",
  t: "\t",
};
const NUMBER_RE = /^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/;
const IDENT_RE = /^[A-Za-z_$][A-Za-z0-9_$-]*/;
const MAX_DEPTH = 64;

class Repairer {
  pos = 0;
  readonly repairs: string[] = [];
  truncated = false;

  constructor(private readonly s: string) {}

  private note(what: string): void {
    this.repairs.push(what);
  }

  private eof(): boolean {
    return this.pos >= this.s.length;
  }

  private skipWs(): void {
    while (this.pos < this.s.length && /\s/.test(this.s[this.pos] ?? "")) this.pos += 1;
  }

  parseDocument(): unknown {
    this.skipWs();
    const value = this.parseValue(0);
    if (value === NONE) throw new RepairError("no JSON value found");
    this.skipWs();
    if (!this.eof()) throw new RepairError(`unexpected content at position ${this.pos}`);
    return value;
  }

  private parseValue(depth: number): unknown {
    if (depth > MAX_DEPTH) throw new RepairError("nesting too deep");
    this.skipWs();
    if (this.eof()) {
      this.truncated = true;
      return NONE;
    }
    const ch = this.s[this.pos] as string;
    if (ch === "{") return this.parseObject(depth);
    if (ch === "[") return this.parseArray(depth);
    if (ch in OPEN_TO_CLOSE) return this.parseString();
    if (ch === "-" || (ch >= "0" && ch <= "9")) return this.parseNumber();
    return this.parseLiteral();
  }

  private parseObject(depth: number): Record<string, unknown> | typeof NONE {
    this.pos += 1; // {
    const out: Record<string, unknown> = {};
    for (;;) {
      this.skipWs();
      if (this.eof()) {
        this.truncated = true;
        this.note("closed unterminated object");
        return out;
      }
      const ch = this.s[this.pos] as string;
      if (ch === "}") {
        this.pos += 1;
        return out;
      }
      const key = this.parseKey();
      if (key === NONE) {
        this.note("closed unterminated object");
        return out;
      }
      this.skipWs();
      if (this.eof()) {
        this.truncated = true; // a key with no value: dropped, never completed
        this.note("closed unterminated object");
        return out;
      }
      if (this.s[this.pos] !== ":") throw new RepairError(`expected ":" at position ${this.pos}`);
      this.pos += 1;
      const value = this.parseValue(depth + 1);
      if (value === NONE) {
        this.note("closed unterminated object");
        return out;
      }
      // Own property even for "__proto__", matching JSON.parse (no prototype swap).
      Object.defineProperty(out, key, { value, enumerable: true, writable: true, configurable: true });
      this.skipWs();
      if (this.eof()) {
        this.truncated = true;
        this.note("closed unterminated object");
        return out;
      }
      const next = this.s[this.pos] as string;
      if (next === ",") {
        this.pos += 1;
        this.skipWs();
        if (this.s[this.pos] === "}") {
          this.pos += 1;
          this.note("removed trailing comma");
          return out;
        }
        continue;
      }
      if (next === "}") {
        this.pos += 1;
        return out;
      }
      throw new RepairError(`expected "," or "}" at position ${this.pos}`);
    }
  }

  private parseArray(depth: number): unknown[] {
    this.pos += 1; // [
    const out: unknown[] = [];
    for (;;) {
      this.skipWs();
      if (this.eof()) {
        this.truncated = true;
        this.note("closed unterminated array");
        return out;
      }
      if (this.s[this.pos] === "]") {
        this.pos += 1;
        return out;
      }
      const value = this.parseValue(depth + 1);
      if (value === NONE) {
        this.note("closed unterminated array");
        return out;
      }
      out.push(value);
      this.skipWs();
      if (this.eof()) {
        this.truncated = true;
        this.note("closed unterminated array");
        return out;
      }
      const next = this.s[this.pos] as string;
      if (next === ",") {
        this.pos += 1;
        this.skipWs();
        if (this.s[this.pos] === "]") {
          this.pos += 1;
          this.note("removed trailing comma");
          return out;
        }
        continue;
      }
      if (next === "]") {
        this.pos += 1;
        return out;
      }
      throw new RepairError(`expected "," or "]" at position ${this.pos}`);
    }
  }

  private parseKey(): string | typeof NONE {
    const ch = this.s[this.pos] as string;
    if (ch in OPEN_TO_CLOSE) {
      const s = this.parseString();
      return s === NONE ? NONE : (s as string);
    }
    const m = IDENT_RE.exec(this.s.slice(this.pos));
    if (m === null) throw new RepairError(`expected a key at position ${this.pos}`);
    this.pos += m[0].length;
    if (this.eof()) {
      // `{"a":1,b` is cut mid-key: never invent the rest of a name.
      this.truncated = true;
      return NONE;
    }
    this.note("quoted an unquoted key");
    return m[0];
  }

  /**
   * Is the quote at `i` a real closer? A standard `"` always is. For the
   * non-standard quote families a quote only closes the string when what follows
   * is structural (`,` `}` `]` `:` or the end), so an apostrophe inside
   * single-quoted text ('it's') stays content.
   */
  private closesAt(i: number, opener: string): boolean {
    if (opener === '"') return true;
    let j = i + 1;
    while (j < this.s.length && /\s/.test(this.s[j] ?? "")) j += 1;
    if (j >= this.s.length) return true;
    return ",}]:".includes(this.s[j] as string);
  }

  private parseString(): string | typeof NONE {
    const opener = this.s[this.pos] as string;
    const closer = OPEN_TO_CLOSE[opener] as string;
    const named = QUOTE_NAMES[opener];
    if (named !== undefined) this.note(`${named} read as double quotes`);
    this.pos += 1;
    let out = "";
    for (;;) {
      if (this.eof()) {
        this.truncated = true;
        this.note("closed unterminated string");
        return out;
      }
      const ch = this.s[this.pos] as string;
      if (ch === closer && this.closesAt(this.pos, opener)) {
        this.pos += 1;
        return out;
      }
      // A typographic double quote may also be closed by an ASCII one.
      if (opener === "\u201C" && ch === '"' && this.closesAt(this.pos, opener)) {
        this.pos += 1;
        return out;
      }
      if (ch === "\\") {
        const esc = this.s[this.pos + 1];
        if (esc === undefined) {
          // A lone backslash at the very end: the cut fell mid-escape.
          this.pos += 1;
          continue;
        }
        if (esc === "u") {
          const hex = this.s.slice(this.pos + 2, this.pos + 6);
          if (/^[0-9a-fA-F]{4}$/.test(hex)) {
            out += String.fromCharCode(parseInt(hex, 16));
            this.pos += 6;
            continue;
          }
          if (this.pos + 6 > this.s.length && /^[0-9a-fA-F]*$/.test(hex)) {
            this.pos = this.s.length; // cut mid-\uXXXX: drop the partial escape
            continue;
          }
          out += "\\u";
          this.pos += 2;
          this.note("kept an invalid escape literally");
          continue;
        }
        const simple = SIMPLE_ESCAPES[esc];
        if (simple !== undefined) {
          out += simple;
        } else if (esc === "'" || esc === "`") {
          out += esc; // an escaped apostrophe is a harmless model habit
          this.note("unescaped a quote");
        } else {
          out += `\\${esc}`; // `\d` in a pattern: the backslash is content
          this.note("kept an invalid escape literally");
        }
        this.pos += 2;
        continue;
      }
      if (ch === "\n" || ch === "\r" || ch === "\t" || ch < " ") {
        this.note("escaped a raw control character");
      }
      out += ch;
      this.pos += 1;
    }
  }

  private parseNumber(): number | typeof NONE {
    const rest = this.s.slice(this.pos);
    const m = NUMBER_RE.exec(rest);
    if (m === null) {
      if (rest === "-") {
        this.pos = this.s.length;
        this.truncated = true;
        return NONE;
      }
      throw new RepairError(`invalid number at position ${this.pos}`);
    }
    let end = m[0].length;
    const tail = rest.slice(end);
    // A number cut mid-token at the end of input ("2.", "2e", "2e+") keeps its
    // valid prefix; anywhere else the stray characters are a real error.
    if (/^(?:\.|[eE][+-]?)$/.test(tail)) {
      end += tail.length;
      this.truncated = true;
      this.note("trimmed an incomplete number");
    }
    this.pos += end;
    return Number(m[0]);
  }

  private parseLiteral(): unknown {
    const rest = this.s.slice(this.pos);
    const m = /^[A-Za-z]+/.exec(rest);
    if (m === null) throw new RepairError(`unexpected character at position ${this.pos}`);
    const word = m[0];
    const lower = word.toLowerCase();
    const table: Record<string, unknown> = { true: true, false: false, null: null, none: null, undefined: null };
    if (lower in table) {
      this.pos += word.length;
      if (word !== "true" && word !== "false" && word !== "null") this.note(`read ${word} as ${String(table[lower])}`);
      return table[lower];
    }
    // `tru` at the end of input is a cut literal: drop it, never complete it.
    if (this.pos + word.length >= this.s.length && ["true", "false", "null"].some((l) => l.startsWith(lower))) {
      this.pos = this.s.length;
      this.truncated = true;
      return NONE;
    }
    throw new RepairError(`unexpected bare word "${word.slice(0, 20)}"`);
  }
}

/** Remove a wrapping markdown code fence (```json ... ```), complete or cut. */
function stripFences(text: string): { text: string; stripped: boolean } {
  const m = /^```[A-Za-z0-9_-]*[ \t]*\r?\n?([\s\S]*?)(?:\r?\n?```[ \t]*)?$/.exec(text);
  if (m === null) return { text, stripped: false };
  return { text: (m[1] ?? "").trim(), stripped: true };
}

/** Repair a tolerant superset of JSON. Never throws. */
export function repairJson(raw: string): RepairOutcome {
  let text = typeof raw === "string" ? raw.trim() : "";
  const repairs: string[] = [];
  const fence = stripFences(text);
  if (fence.stripped) {
    text = fence.text;
    repairs.push("stripped a code fence");
  }
  const parser = new Repairer(text);
  try {
    const value = parser.parseDocument();
    return { ok: true, value, repairs: [...repairs, ...parser.repairs], truncated: parser.truncated };
  } catch (err) {
    return {
      ok: false,
      repairs: [...repairs, ...parser.repairs],
      truncated: parser.truncated,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/* ------------------------------ schema coercion ------------------------------ */

type Schema = Record<string, unknown>;

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function schemaTypes(schema: Schema): string[] {
  const t = schema.type;
  if (typeof t === "string") return [t];
  if (Array.isArray(t)) return t.filter((x): x is string => typeof x === "string");
  return [];
}

function matchesType(value: unknown, type: string): boolean {
  switch (type) {
    case "string":
      return typeof value === "string";
    case "number":
      return typeof value === "number";
    case "integer":
      return typeof value === "number" && Number.isInteger(value);
    case "boolean":
      return typeof value === "boolean";
    case "null":
      return value === null;
    case "array":
      return Array.isArray(value);
    case "object":
      return isRecord(value);
    default:
      return false;
  }
}

const STRICT_NUMBER_RE = /^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?$/;

function coerceValue(value: unknown, schema: Schema, where: string, notes: string[]): unknown {
  const types = schemaTypes(schema);
  if (types.length > 0 && types.some((t) => matchesType(value, t))) {
    // Already one of the allowed types: descend only to coerce nested members.
    if (Array.isArray(value) && isRecord(schema.items)) {
      return value.map((item, i) => coerceValue(item, schema.items as Schema, `${where}[${i}]`, notes));
    }
    if (isRecord(value) && isRecord(schema.properties)) return coerceObject(value, schema, where, notes);
    return value;
  }
  if (typeof value === "string" && types.length > 0) {
    const trimmed = value.trim();
    if ((types.includes("number") || types.includes("integer")) && STRICT_NUMBER_RE.test(trimmed)) {
      const n = Number(trimmed);
      if (Number.isFinite(n) && (types.includes("number") || Number.isInteger(n))) {
        notes.push(`${where}: "${trimmed}" to number`);
        return n;
      }
    }
    if (types.includes("boolean") && (trimmed === "true" || trimmed === "false")) {
      notes.push(`${where}: "${trimmed}" to boolean`);
      return trimmed === "true";
    }
    // A JSON-encoded array/object passed as a string ("[\"a\",\"b\"]").
    if ((types.includes("array") && trimmed.startsWith("[")) || (types.includes("object") && trimmed.startsWith("{"))) {
      try {
        const inner: unknown = JSON.parse(trimmed);
        if (types.some((t) => matchesType(inner, t))) {
          notes.push(`${where}: JSON string to ${Array.isArray(inner) ? "array" : "object"}`);
          return coerceValue(inner, schema, where, notes);
        }
      } catch {
        // not JSON: leave the value alone, the tool's own validation reports it
      }
    }
  }
  return value;
}

function coerceObject(obj: Record<string, unknown>, schema: Schema, where: string, notes: string[]): Record<string, unknown> {
  const props = isRecord(schema.properties) ? schema.properties : {};
  const out: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(obj)) {
    const sub = props[key];
    out[key] = isRecord(sub) ? coerceValue(val, sub, where === "" ? key : `${where}.${key}`, notes) : val;
  }
  return out;
}

/**
 * Coerce scalar members of `args` to the types `schema` declares, where the
 * conversion is unambiguous. Strings that already satisfy a string type are
 * never touched, so `content`, `command`, `old_string` and friends pass through
 * byte-identical. Returns the coerced object and one note per change.
 */
export function coerceToSchema(args: Record<string, unknown>, schema: Schema | undefined): { args: Record<string, unknown>; coercions: string[] } {
  if (schema === undefined) return { args, coercions: [] };
  const coercions: string[] = [];
  const next = coerceObject(args, schema, "", coercions);
  return { args: coercions.length === 0 ? args : next, coercions };
}

/* ----------------------------- tool-level policy ----------------------------- */

/**
 * Tools whose call has no side effects, so a truncated tail may be closed. For
 * every other tool (shell, write, edit, apply_patch, MCP tools, ...) a cut-off
 * argument blob is refused: completing a half-sent `command` or `content`
 * would run or write something the model never finished saying.
 */
export const TRUNCATION_TOLERANT_TOOLS: ReadonlySet<string> = new Set(["read", "grep", "glob", "repo_map", "tool_search", "ast_search"]);

export interface ToolArguments {
  args: Record<string, unknown>;
  error?: string;
  /** True when the admitted args differ from the model's raw bytes (syntax repair or type coercion). */
  repaired?: true;
  /** True when a cut-off tail was closed by the parser, so the values may be incomplete. */
  truncated?: true;
  /** Every repair and coercion applied, for the event log. */
  repairs?: string[];
}

/**
 * Parse a tool call's argument blob. Valid JSON takes the fast path; anything
 * else goes through `repairJson`. `toolName` and `schema` select the fail-closed
 * policy and the type coercion; omit them and a truncated tail is refused.
 */
export function parseToolArguments(raw: string, toolName?: string, schema?: Schema): ToolArguments {
  const text = typeof raw === "string" ? raw.trim() : "";
  if (text === "") return { args: {} };
  let value: unknown;
  const repairs: string[] = [];
  let cutOff = false;
  try {
    value = JSON.parse(text);
  } catch (strictErr) {
    const out = repairJson(text);
    if (!out.ok) return { args: {}, error: strictErr instanceof Error ? strictErr.message : String(strictErr) };
    if (out.truncated && !(toolName !== undefined && TRUNCATION_TOLERANT_TOOLS.has(toolName))) {
      return {
        args: {},
        error: `the arguments were cut off before the JSON ended (output limit?); refusing to complete a ${toolName ?? "tool"} call from a partial blob. Resend the complete call`,
      };
    }
    value = out.value;
    repairs.push(...out.repairs);
    cutOff = out.truncated;
  }
  if (!isRecord(value)) return { args: {}, error: "arguments must be a JSON object" };
  const coerced = coerceToSchema(value, schema);
  repairs.push(...coerced.coercions);
  if (repairs.length === 0) return { args: coerced.args };
  return { args: coerced.args, repaired: true, ...(cutOff ? { truncated: true as const } : {}), repairs };
}
