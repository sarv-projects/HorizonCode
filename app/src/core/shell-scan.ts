/**
 * shell-scan.ts — Portable zero-dependency static Shell AST scanner.
 *
 * Ported and adapted from OpenCode's `packages/core/src/shell/scan.ts` to cover
 * Bash/Zsh/POSIX and PowerShell syntax without external runtime dependencies.
 *
 * Key capabilities:
 * - Splits pipelines (`|`, `|&`), logical lists (`&&`, `||`, `;`, `&`, newlines),
 *   subshells `(...)`, brace groups `{ ...; }`, command substitutions `$(...)` /
 *   backticks, process substitutions `<(...)` / `>(...)`, redirections (including
 *   heredocs `<<` / `<<-` / `<<<`), quotes (`'...'`, `"..."`, `$'...'`, PowerShell
 *   backtick escapes & here-strings), and leading env-var assignments (`FOO=bar cmd`).
 * - Extracts every concrete command invocation `{ argv, rawWords, raw, redirects,
 *   envAssignments }`, including nested commands inside `$()`, backticks, process
 *   substitutions, subshells, script blocks, and pipelines.
 * - Flags dynamic/opaque execution (`opaque: true` with explicit `opaqueReason`):
 *   `eval`, `source`/`.`, `exec`, dynamic command names (`$CMD arg`, `$(...) arg`),
 *   indirect expansion `${!var}`, PowerShell `Invoke-Expression` / `iex` / `& $var`
 *   / `. $var`, and unclosed/malformed syntax.
 */

export type ShellDialect = "posix" | "bash" | "zsh" | "powershell";

export type ShellOpaqueReason =
  | "dynamic-execution"
  | "dynamic-command-name"
  | "command-substitution"
  | "compound-command"
  | "heredoc"
  | "invalid-redirect"
  | "invalid-structure"
  | "unterminated-escape"
  | "unterminated-quote";

export interface ShellRedirect {
  op: string;
  fd?: string;
  target: string;
  isWrite: boolean;
  isFdDup: boolean;
}

export interface ShellEnvAssignment {
  name: string;
  value: string;
  raw: string;
}

export interface ShellInvocation {
  argv: string[];
  rawWords: string[];
  raw: string;
  redirects: ShellRedirect[];
  envAssignments: ShellEnvAssignment[];
  nested?: boolean;
  backgrounded?: boolean;
  declaration?: boolean;
  statementHead?: boolean;
  wordEnds?: number[];
  redirectWordCount?: number;
  redirectPrefixEnd?: number;
}

export type ShellScanResult =
  | {
      ok: true;
      opaque: false;
      dialect: ShellDialect;
      commands: ShellInvocation[];
    }
  | {
      ok: false;
      opaque: true;
      opaqueReason: ShellOpaqueReason;
      detail: string;
      dialect: ShellDialect;
      commands: ShellInvocation[];
    };

export interface ShellScanOptions {
  dialect?: ShellDialect;
  shell?: string;
}

const MAX_INPUT_LENGTH = 64 * 1024;
const MAX_NESTING_DEPTH = 32;

const POSIX_REDIRECT_OPS = ["&>>", "&>", "<<<", "<<-", "<<", "<>", "<&", ">&", ">|", ">>", ">", "<"];
const POSIX_DECLARATIONS = new Set(["declare", "typeset", "export", "readonly", "local", "unset", "unsetenv"]);
const POSIX_OPAQUE_COMMANDS = new Set(["eval", "source", ".", "exec"]);
const POWERSHELL_OPAQUE_COMMANDS = new Set([
  "invoke-expression",
  "iex",
  "invoke-command",
  "icm",
  "start-process",
  "saps",
]);
const PRECOMMAND_WRAPPERS = new Set([
  "builtin",
  "command",
  "nohup",
  "time",
  "nice",
  "env",
  "sudo",
  "doas",
  "timeout",
  "stdbuf",
  "!",
]);
const POSIX_KEYWORDS = new Set([
  "if",
  "then",
  "elif",
  "else",
  "fi",
  "for",
  "select",
  "in",
  "while",
  "until",
  "do",
  "done",
  "case",
  "esac",
]);

const ANSI_ESCAPES: Record<string, string> = {
  a: "\x07",
  b: "\b",
  e: "\x1b",
  E: "\x1b",
  f: "\f",
  n: "\n",
  r: "\r",
  t: "\t",
  v: "\v",
  "\\": "\\",
  "'": "'",
  '"': '"',
  "?": "?",
};

type OpaqueSignal = { reason: ShellOpaqueReason; detail: string };

interface ScanBudget {
  remaining: number;
  dialect: ShellDialect;
  opaque?: OpaqueSignal;
}

interface PendingHeredoc {
  delimiter: string;
  quoted: boolean;
  stripTabs: boolean;
}

function recordOpaque(budget: ScanBudget, reason: ShellOpaqueReason, detail: string): void {
  if (budget.opaque === undefined) {
    budget.opaque = { reason, detail };
  }
}

/** Detect whether a raw shell word contains dynamic expansion (unquoted or double-quoted `$` / backtick). */
export function rawWordHasDynamicExpansion(raw: string): boolean {
  let quote: "'" | '"' | "$'" | null = null;
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i]!;
    const next = raw[i + 1] ?? "";
    if (quote === "'") {
      if (c === "'") quote = null;
      continue;
    }
    if (quote === "$'") {
      if (c === "\\") {
        i++;
        continue;
      }
      if (c === "'") quote = null;
      continue;
    }
    if (quote === '"') {
      if (c === "\\") {
        i++;
        continue;
      }
      if (c === '"') {
        quote = null;
        continue;
      }
      if (c === "`") return true;
      if (c === "$" && (/[A-Za-z_0-9@*#?$!({-]/.test(next) || next === "")) {
        if (next !== "") return true;
      }
      continue;
    }
    if (c === "\\") {
      i++;
      continue;
    }
    if (c === "'") {
      quote = "'";
      continue;
    }
    if (c === '"') {
      quote = '"';
      continue;
    }
    if (c === "$" && next === "'") {
      quote = "$'";
      i++;
      continue;
    }
    if (c === "$" && next === '"') {
      quote = '"';
      i++;
      continue;
    }
    if (c === "`") return true;
    if (c === "$" && /[A-Za-z_0-9@*#?$!({[-]/.test(next)) return true;
  }
  return false;
}

/** Detect whether a raw PowerShell word contains dynamic expansion (backtick escaping, not POSIX `\`). */
export function psRawWordHasDynamicExpansion(raw: string): boolean {
  let quote: "'" | '"' | null = null;
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i]!;
    const next = raw[i + 1] ?? "";
    if (quote === "'") {
      if (c === "'" && next === "'") {
        i++;
        continue;
      }
      if (c === "'") quote = null;
      continue;
    }
    if (quote === '"') {
      if (c === "`") {
        i++;
        continue;
      }
      if (c === '"' && next === '"') {
        i++;
        continue;
      }
      if (c === '"') {
        quote = null;
        continue;
      }
      if (c === "$" && /[A-Za-z_0-9@*#?$!({-]/.test(next)) return true;
      continue;
    }
    if (c === "`") {
      i++;
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
      continue;
    }
    if (c === "$" && /[A-Za-z_0-9@*#?$!({[-]/.test(next)) return true;
  }
  return false;
}

/** Find effective command head index after skipping wrapper builtins/utilities. */
function effectiveCommandHeadIndex(argv: readonly string[], budget?: ScanBudget): number {
  let i = 0;
  while (i < argv.length) {
    const w = argv[i]!;
    const lower = w.toLowerCase();
    if (!PRECOMMAND_WRAPPERS.has(lower)) break;
    i++;
    if (lower === "env") {
      while (i < argv.length) {
        const arg = argv[i]!;
        if (arg === "--") {
          i++;
          break;
        }
        if (arg.startsWith("-")) {
          if (
            arg === "-S" ||
            arg === "--split-string" ||
            arg.startsWith("--split-string=") ||
            /^-[^-]*S/.test(arg)
          ) {
            if (budget) recordOpaque(budget, "dynamic-execution", "env -S splits arbitrary command string");
            return argv.length;
          }
          if (arg === "-u" || arg === "--unset" || arg === "-C" || arg === "--chdir") {
            i += 2;
            continue;
          }
          i++;
          continue;
        }
        if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(arg)) {
          i++;
          continue;
        }
        break;
      }
    } else if (lower === "sudo") {
      while (i < argv.length) {
        const arg = argv[i]!;
        if (arg === "--") {
          i++;
          break;
        }
        if (arg.startsWith("-")) {
          if (
            arg === "-u" ||
            arg === "--user" ||
            arg === "-g" ||
            arg === "--group" ||
            arg === "-C" ||
            arg === "--close-from" ||
            arg === "-h" ||
            arg === "--host" ||
            arg === "-p" ||
            arg === "--prompt" ||
            arg === "-r" ||
            arg === "--role" ||
            arg === "-t" ||
            arg === "--type" ||
            arg === "-T" ||
            arg === "--command-timeout" ||
            arg === "-U" ||
            arg === "--other-user" ||
            arg === "-D" ||
            arg === "--chdir" ||
            /^-[^-]*[ugCh]$/.test(arg)
          ) {
            i += 2;
            continue;
          }
          i++;
          continue;
        }
        if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(arg)) {
          i++;
          continue;
        }
        break;
      }
    } else if (lower === "doas") {
      while (i < argv.length && argv[i]!.startsWith("-")) {
        const arg = argv[i]!;
        if (arg === "--") {
          i++;
          break;
        }
        if (arg === "-u") {
          i += 2;
          continue;
        }
        i++;
      }
    } else if (lower === "timeout") {
      while (i < argv.length && argv[i]!.startsWith("-")) {
        const arg = argv[i]!;
        if (arg === "--") {
          i++;
          break;
        }
        if (arg === "-k" || arg === "--kill-after" || arg === "-s" || arg === "--signal") {
          i += 2;
          continue;
        }
        i++;
      }
      if (i < argv.length && /^[\d.]+[smhd]?$/.test(argv[i]!)) i++;
    } else if (lower === "stdbuf") {
      while (i < argv.length && argv[i]!.startsWith("-")) {
        const arg = argv[i]!;
        if (arg === "--") {
          i++;
          break;
        }
        if (
          arg === "-i" ||
          arg === "--input" ||
          arg === "-o" ||
          arg === "--output" ||
          arg === "-e" ||
          arg === "--error"
        ) {
          i += 2;
          continue;
        }
        i++;
      }
    } else if (lower === "nice") {
      while (i < argv.length && argv[i]!.startsWith("-")) {
        const arg = argv[i]!;
        if (arg === "--") {
          i++;
          break;
        }
        if (arg === "-n" || arg === "--adjustment") {
          i += 2;
          continue;
        }
        i++;
      }
    } else if (lower !== "!") {
      while (i < argv.length && argv[i]!.startsWith("-")) {
        if (argv[i] === "--") {
          i++;
          break;
        }
        i++;
      }
    }
  }
  return i;
}

/** Check an extracted invocation for opaque/dynamic command execution. */
function checkInvocationOpacity(inv: ShellInvocation, budget: ScanBudget): void {
  if (inv.argv.length === 0) return;
  const hasDynamic = budget.dialect === "powershell" ? psRawWordHasDynamicExpansion : rawWordHasDynamicExpansion;
  const rawHead = inv.rawWords[0] ?? "";
  if (hasDynamic(rawHead)) {
    recordOpaque(budget, "dynamic-command-name", `dynamic command name: ${rawHead}`);
    return;
  }
  const headIdx = effectiveCommandHeadIndex(inv.argv, budget);
  if (headIdx >= inv.argv.length) return;
  const effWord = inv.argv[headIdx]!;
  const effRaw = inv.rawWords[headIdx] ?? effWord;
  if (hasDynamic(effRaw)) {
    recordOpaque(budget, "dynamic-command-name", `dynamic command name: ${effRaw}`);
    return;
  }
  const lower = effWord.toLowerCase();
  if (POSIX_OPAQUE_COMMANDS.has(effWord)) {
    recordOpaque(budget, "dynamic-execution", `dynamic shell builtin: ${effWord}`);
    return;
  }
  const psCmdName = lower.includes("\\") ? lower.slice(lower.lastIndexOf("\\") + 1) : lower;
  if (POWERSHELL_OPAQUE_COMMANDS.has(lower) || POWERSHELL_OPAQUE_COMMANDS.has(psCmdName)) {
    recordOpaque(budget, "dynamic-execution", `PowerShell dynamic execution: ${effWord}`);
    return;
  }
  if (effWord === "alias" && inv.argv.slice(headIdx + 1).some((a) => a.includes("="))) {
    recordOpaque(budget, "dynamic-execution", "dynamic alias definition");
    return;
  }
  if (effWord === "compgen" && inv.argv.slice(headIdx + 1).some((a) => a.startsWith("-") && /[CF]/.test(a))) {
    recordOpaque(budget, "dynamic-execution", "compgen command execution flag");
  }
}

function decodeAnsiQuote(input: string, startQuoteIdx: number): { value: string; end: number } | null {
  let value = "";
  for (let i = startQuoteIdx + 1; i < input.length; i++) {
    const c = input[i]!;
    if (c === "'") return { value, end: i };
    if (c !== "\\") {
      value += c;
      continue;
    }
    const esc = input[++i];
    if (esc === undefined) return null;
    if (esc in ANSI_ESCAPES) {
      value += ANSI_ESCAPES[esc]!;
      continue;
    }
    if (esc === "x") {
      const m = /^[0-9a-fA-F]{1,2}/.exec(input.slice(i + 1, i + 3));
      if (m) {
        value += String.fromCodePoint(parseInt(m[0], 16));
        i += m[0].length;
        continue;
      }
    } else if (esc === "u" || esc === "U") {
      const maxLen = esc === "u" ? 4 : 8;
      const m = new RegExp(`^[0-9a-fA-F]{1,${maxLen}}`).exec(input.slice(i + 1, i + 1 + maxLen));
      if (m) {
        const cp = parseInt(m[0], 16);
        if (cp > 0 && cp <= 0x10ffff) value += String.fromCodePoint(cp);
        i += m[0].length;
        continue;
      }
    } else if (/[0-7]/.test(esc)) {
      const m = /^[0-7]{1,3}/.exec(input.slice(i, i + 3));
      if (m) {
        value += String.fromCodePoint(parseInt(m[0], 8));
        i += m[0].length - 1;
        continue;
      }
    }
    value += "\\" + esc;
  }
  return null;
}

function parseHeredocDelimiter(
  input: string,
  start: number,
  stripTabs: boolean,
): { heredoc: PendingHeredoc; end: number } | null {
  let i = start;
  while (i < input.length && (input[i] === " " || input[i] === "\t")) i++;
  if (i >= input.length || input[i] === "\n" || input[i] === "\r" || input[i] === "#") return null;

  let delimiter = "";
  let quoted = false;
  let quote: "'" | '"' | null = null;
  let end = i;
  let started = false;

  for (; i < input.length; i++) {
    const c = input[i]!;
    if (!quote && /[ \t\r\n;&|()<>]/.test(c)) {
      return started ? { heredoc: { delimiter, quoted, stripTabs }, end } : null;
    }
    if (quote !== null) {
      if (c === quote) {
        quote = null;
        end = i;
        continue;
      }
      if (quote === '"' && c === "\\" && i + 1 < input.length) {
        delimiter += input[++i]!;
        end = i;
        continue;
      }
      delimiter += c;
      end = i;
      continue;
    }
    if (c === "\\" && i + 1 < input.length) {
      quoted = true;
      started = true;
      delimiter += input[++i]!;
      end = i;
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
      quoted = true;
      started = true;
      end = i;
      continue;
    }
    delimiter += c;
    started = true;
    end = i;
  }
  if (!started || quote !== null) return null;
  return { heredoc: { delimiter, quoted, stripTabs }, end };
}

function readHeredocBody(
  input: string,
  startAfterNewline: number,
  heredoc: PendingHeredoc,
): { body: string; end: number } | null {
  let lineStart = startAfterNewline;
  for (let i = startAfterNewline; i <= input.length; i++) {
    if (i < input.length && input[i] !== "\n") continue;
    const rawLine = input.slice(lineStart, i).replace(/\r$/, "");
    const candidate = heredoc.stripTabs ? rawLine.replace(/^\t+/, "") : rawLine;
    if (candidate === heredoc.delimiter) {
      return {
        body: input.slice(startAfterNewline, lineStart),
        end: i < input.length ? i : input.length - 1,
      };
    }
    lineStart = i + 1;
  }
  return null;
}

function scanPosixHeredocExpansions(
  body: string,
  depth: number,
  budget: ScanBudget,
  commands: ShellInvocation[],
): OpaqueSignal | undefined {
  for (let i = 0; i < body.length; i++) {
    if (--budget.remaining < 0) return { reason: "invalid-structure", detail: "scanner budget exceeded" };
    const c = body[i]!;
    if (c === "\\") {
      i++;
      continue;
    }
    if (c === "`") {
      const res = scanPosixBacktick(body, i, depth + 1, budget, commands, true);
      if (typeof res === "object") return res;
      i = res;
      continue;
    }
    if (c === "$" && body[i + 1] === "(" && body[i + 2] === "(") {
      const res = scanPosixArithmetic(body, i + 3, depth + 1, budget, commands);
      if (typeof res === "object") return res;
      i = res;
      continue;
    }
    if (c === "$" && body[i + 1] === "(") {
      const res = scanPosixList(body, i + 2, depth + 1, budget, ")", true);
      if ("reason" in res) return res;
      commands.push(...res.commands);
      i = res.end;
      continue;
    }
    if (c === "$" && body[i + 1] === "{") {
      const res = scanPosixParamExpansion(body, i + 2, depth + 1, budget, commands);
      if (typeof res === "object") return res;
      i = res;
      continue;
    }
  }
  return undefined;
}

function scanPosixBacktick(
  input: string,
  start: number,
  depth: number,
  budget: ScanBudget,
  commands: ShellInvocation[],
  inDoubleQuote: boolean,
): number | OpaqueSignal {
  if (depth > MAX_NESTING_DEPTH) return { reason: "command-substitution", detail: "max nesting depth exceeded" };
  let inner = "";
  for (let i = start + 1; i < input.length; i++) {
    if (--budget.remaining < 0) return { reason: "invalid-structure", detail: "scanner budget exceeded" };
    const c = input[i]!;
    if (c === "`") {
      const res = scanPosixList(inner, 0, depth, budget, undefined, true);
      if ("reason" in res) return res;
      commands.push(...res.commands);
      return i;
    }
    if (c === "\\") {
      const next = input[i + 1];
      if (next === undefined) return { reason: "unterminated-escape", detail: "unterminated escape in backtick" };
      if ("$`\\\n".includes(next) || (inDoubleQuote && next === '"')) {
        i++;
        if (next !== "\n") inner += next;
        continue;
      }
    }
    inner += c;
  }
  return { reason: "command-substitution", detail: "unterminated backtick command substitution" };
}

function scanPosixArithmetic(
  input: string,
  start: number,
  depth: number,
  budget: ScanBudget,
  commands: ShellInvocation[],
): number | OpaqueSignal {
  if (depth > MAX_NESTING_DEPTH) return { reason: "invalid-structure", detail: "max nesting depth exceeded" };
  let parenDepth = 0;
  for (let i = start; i < input.length; i++) {
    if (--budget.remaining < 0) return { reason: "invalid-structure", detail: "scanner budget exceeded" };
    const c = input[i]!;
    if (c === "\\" && i + 1 < input.length) {
      i++;
      continue;
    }
    if (c === ")" && input[i + 1] === ")" && parenDepth === 0) {
      return i + 1;
    }
    if (c === "(") {
      parenDepth++;
      continue;
    }
    if (c === ")") {
      if (parenDepth > 0) parenDepth--;
      continue;
    }
    if (c === "`") {
      const res = scanPosixBacktick(input, i, depth + 1, budget, commands, false);
      if (typeof res === "object") return res;
      i = res;
      continue;
    }
    if (c === "$" && input[i + 1] === "(" && input[i + 2] !== "(") {
      const res = scanPosixList(input, i + 2, depth + 1, budget, ")", true);
      if ("reason" in res) return res;
      commands.push(...res.commands);
      i = res.end;
      continue;
    }
    if (c === "$" && input[i + 1] === "{") {
      const res = scanPosixParamExpansion(input, i + 2, depth + 1, budget, commands);
      if (typeof res === "object") return res;
      i = res;
      continue;
    }
  }
  return { reason: "invalid-structure", detail: "unterminated arithmetic expansion $((...))" };
}

function scanPosixParamExpansion(
  input: string,
  start: number,
  depth: number,
  budget: ScanBudget,
  commands: ShellInvocation[],
): number | OpaqueSignal {
  if (depth > MAX_NESTING_DEPTH) return { reason: "command-substitution", detail: "max nesting depth exceeded" };
  // Indirect expansion: ${!var} (excluding ${!arr[@]} / ${#var} — conservatively flag ${!name})
  if (input[start] === "!") {
    recordOpaque(budget, "dynamic-execution", "indirect parameter expansion ${!...}");
  }
  // Zsh eval / indirect flags: ${(e)var} or ${(P)var}
  if (input[start] === "(") {
    const closeFlags = input.indexOf(")", start + 1);
    if (closeFlags > start) {
      const flags = input.slice(start + 1, closeFlags);
      if (/[eP~]/.test(flags)) {
        recordOpaque(budget, "dynamic-execution", `zsh parameter evaluation flag (${flags})`);
      }
    }
  }
  let braceDepth = 1;
  let quote: "'" | '"' | null = null;
  for (let i = start; i < input.length; i++) {
    if (--budget.remaining < 0) return { reason: "invalid-structure", detail: "scanner budget exceeded" };
    const c = input[i]!;
    if (quote === "'") {
      if (c === "'") quote = null;
      continue;
    }
    if (c === "\\" && i + 1 < input.length) {
      i++;
      continue;
    }
    if (c === '"') {
      quote = quote === '"' ? null : '"';
      continue;
    }
    if (quote === null && c === "'") {
      quote = "'";
      continue;
    }
    if (c === "`") {
      const res = scanPosixBacktick(input, i, depth + 1, budget, commands, quote === '"');
      if (typeof res === "object") return res;
      i = res;
      continue;
    }
    if (c === "$" && input[i + 1] === "(" && input[i + 2] === "(") {
      const res = scanPosixArithmetic(input, i + 3, depth + 1, budget, commands);
      if (typeof res === "object") return res;
      i = res;
      continue;
    }
    if (c === "$" && input[i + 1] === "(") {
      const res = scanPosixList(input, i + 2, depth + 1, budget, ")", true);
      if ("reason" in res) return res;
      commands.push(...res.commands);
      i = res.end;
      continue;
    }
    if (c === "$" && input[i + 1] === "{") {
      const res = scanPosixParamExpansion(input, i + 2, depth + 1, budget, commands);
      if (typeof res === "object") return res;
      i = res;
      continue;
    }
    if (quote === null && c === "@") {
      const next = input[i + 1];
      if ((next === "P" || next === "E") && input[i + 2] === "}") {
        recordOpaque(budget, "dynamic-execution", `parameter prompt transformation @${next}`);
      }
    }
    if (quote === null && c === "{") {
      braceDepth++;
      continue;
    }
    if (quote === null && c === "}") {
      braceDepth--;
      if (braceDepth === 0) return i;
    }
  }
  return { reason: "command-substitution", detail: "unterminated parameter expansion ${...}" };
}

function scanPosixDoubleQuote(
  input: string,
  startAfterQuote: number,
  depth: number,
  budget: ScanBudget,
  commands: ShellInvocation[],
): { value: string; end: number } | OpaqueSignal {
  let value = "";
  for (let i = startAfterQuote; i < input.length; i++) {
    if (--budget.remaining < 0) return { reason: "invalid-structure", detail: "scanner budget exceeded" };
    const c = input[i]!;
    if (c === '"') return { value, end: i };
    if (c === "\\") {
      const next = input[i + 1];
      if (next === undefined) return { reason: "unterminated-escape", detail: "unterminated escape in double quote" };
      if (next === "\n") {
        i++;
        continue;
      }
      if ('$`"\\'.includes(next)) {
        value += next;
        i++;
        continue;
      }
      value += c;
      continue;
    }
    if (c === "`") {
      const res = scanPosixBacktick(input, i, depth + 1, budget, commands, true);
      if (typeof res === "object") return res;
      value += input.slice(i, res + 1);
      i = res;
      continue;
    }
    if (c === "$" && input[i + 1] === "(" && input[i + 2] === "(") {
      const res = scanPosixArithmetic(input, i + 3, depth + 1, budget, commands);
      if (typeof res === "object") return res;
      value += input.slice(i, res + 1);
      i = res;
      continue;
    }
    if (c === "$" && input[i + 1] === "(") {
      const res = scanPosixList(input, i + 2, depth + 1, budget, ")", true);
      if ("reason" in res) return res;
      commands.push(...res.commands);
      value += input.slice(i, res.end + 1);
      i = res.end;
      continue;
    }
    if (c === "$" && input[i + 1] === "{") {
      const res = scanPosixParamExpansion(input, i + 2, depth + 1, budget, commands);
      if (typeof res === "object") return res;
      value += input.slice(i, res + 1);
      i = res;
      continue;
    }
    value += c;
  }
  return { reason: "unterminated-quote", detail: "unterminated double quote" };
}

type PosixListResult = { commands: ShellInvocation[]; end: number } | OpaqueSignal;

function scanPosixList(
  input: string,
  start: number,
  depth: number,
  budget: ScanBudget,
  close?: ")" | "}",
  nested = false,
): PosixListResult {
  if (depth > MAX_NESTING_DEPTH) {
    return { reason: "command-substitution", detail: "max nesting depth exceeded" };
  }

  const commands: ShellInvocation[] = [];
  const nestedCommands: ShellInvocation[] = [];
  const pendingHeredocs: PendingHeredoc[] = [];

  let words: string[] = [];
  let rawWords: string[] = [];
  let wordEnds: number[] = [];
  let redirects: ShellRedirect[] = [];
  let envAssignments: ShellEnvAssignment[] = [];

  let word = "";
  let wordStarted = false;
  let wordStart = start;
  let wordEnd = start;
  let commandStart: number | undefined;
  let redirectWordCount: number | undefined;

  let pendingRedirect: { op: string; fd?: string; isWrite: boolean; isFdDup: boolean } | undefined;
  let dangling = false;
  let sawCompoundEnd = false;
  const openKeywords: string[] = [];

  const finishWord = (): void => {
    if (!wordStarted) return;
    const rawWord = input.slice(wordStart, wordEnd);

    if (pendingRedirect !== undefined) {
      const isFdDup = pendingRedirect.isFdDup && /^(?:\d+-?|-)$/.test(word);
      const isWrite = pendingRedirect.isWrite && !isFdDup;
      redirects.push({
        op: pendingRedirect.op,
        fd: pendingRedirect.fd,
        target: word,
        isWrite,
        isFdDup,
      });
      pendingRedirect = undefined;
    } else if (words.length === 0 && /^[A-Za-z_][A-Za-z0-9_]*=/.test(word) && !/^['"]/.test(rawWord)) {
      const eq = word.indexOf("=");
      envAssignments.push({
        name: word.slice(0, eq),
        value: word.slice(eq + 1),
        raw: rawWord,
      });
      commandStart ??= wordStart;
    } else {
      // Handle shell control-flow keywords at command start
      if (words.length === 0 && envAssignments.length === 0 && redirects.length === 0 && POSIX_KEYWORDS.has(word) && rawWord === word) {
        if (word === "if" || word === "for" || word === "select" || word === "while" || word === "until" || word === "case") {
          openKeywords.push(word);
        } else if (word === "fi" && openKeywords.at(-1) === "if") {
          openKeywords.pop();
          sawCompoundEnd = true;
        } else if (word === "done" && ["for", "select", "while", "until"].includes(openKeywords.at(-1) ?? "")) {
          openKeywords.pop();
          sawCompoundEnd = true;
        } else if (word === "esac" && openKeywords.at(-1) === "case") {
          openKeywords.pop();
          sawCompoundEnd = true;
        }
        dangling = false;
        word = "";
        wordStarted = false;
        return;
      }
      commandStart ??= wordStart;
      words.push(word);
      rawWords.push(rawWord);
      wordEnds.push(wordEnd);
    }

    word = "";
    wordStarted = false;
  };

  const finishCommand = (backgrounded = false): OpaqueSignal | undefined => {
    finishWord();
    if (pendingRedirect !== undefined) {
      return { reason: "invalid-redirect", detail: `redirect ${pendingRedirect.op} missing target` };
    }
    if (words.length > 0 || redirects.length > 0) {
      const startPos = commandStart ?? wordStart;
      const raw = input.slice(startPos, wordEnd).trim();
      const isDecl =
        words.length > 0 &&
        envAssignments.length === 0 &&
        redirects.length === 0 &&
        POSIX_DECLARATIONS.has(words[0]!);
      const inv: ShellInvocation = {
        argv: words,
        rawWords,
        raw,
        redirects,
        envAssignments,
        ...(nested ? { nested: true } : {}),
        ...(backgrounded ? { backgrounded: true } : {}),
        ...(isDecl ? { declaration: true } : {}),
        ...(wordEnds.length > 0 ? { wordEnds: wordEnds.map((e) => e - startPos) } : {}),
        ...(redirectWordCount !== undefined ? { redirectWordCount } : {}),
      };
      checkInvocationOpacity(inv, budget);
      commands.push(inv);
    }
    if (nestedCommands.length > 0) {
      commands.push(...nestedCommands.splice(0));
    }
    words = [];
    rawWords = [];
    wordEnds = [];
    redirects = [];
    envAssignments = [];
    commandStart = undefined;
    redirectWordCount = undefined;
    sawCompoundEnd = false;
    return undefined;
  };

  const hasPendingCommand = (): boolean =>
    wordStarted || words.length > 0 || redirects.length > 0 || envAssignments.length > 0 || sawCompoundEnd;

  let i = start;
  for (; i < input.length; i++) {
    if (--budget.remaining < 0) return { reason: "invalid-structure", detail: "scanner budget exceeded" };
    const c = input[i]!;

    // Line continuation outside quotes
    if (c === "\\" && input[i + 1] === "\n") {
      i++;
      continue;
    }
    if (c === "\\" && input[i + 1] === "\r" && input[i + 2] === "\n") {
      i += 2;
      continue;
    }

    if (!wordStarted) {
      wordStart = i;
      if (c === " " || c === "\t" || c === "\r") continue;

      // Comments at word boundary
      if (c === "#") {
        const nl = input.indexOf("\n", i);
        if (nl === -1) {
          i = input.length;
          break;
        }
        i = nl - 1;
        continue;
      }

      // Closing brace for brace group `{ ...; }`
      if (c === "}" && close === "}" && words.length === 0 && pendingRedirect === undefined) {
        const err = finishCommand(false);
        if (err) return err;
        if (dangling) return { reason: "invalid-structure", detail: "dangling operator before }" };
        return { commands, end: i };
      }

      // Subshell `(...)` or arithmetic `((...))` at command start
      if (c === "(" && words.length === 0 && envAssignments.length === 0 && pendingRedirect === undefined) {
        if (input[i + 1] === "(") {
          const arithEnd = scanPosixArithmetic(input, i + 2, depth + 1, budget, nestedCommands);
          if (typeof arithEnd === "object") return arithEnd;
          sawCompoundEnd = true;
          dangling = false;
          i = arithEnd;
          wordEnd = i + 1;
          continue;
        }
        const sub = scanPosixList(input, i + 1, depth + 1, budget, ")", true);
        if ("reason" in sub) return sub;
        if (!input.slice(i + 1, sub.end).trim()) {
          return { reason: "invalid-structure", detail: "empty subshell ()" };
        }
        nestedCommands.push(...sub.commands);
        sawCompoundEnd = true;
        dangling = false;
        i = sub.end;
        wordEnd = i + 1;
        continue;
      }

      // Brace group `{ ...; }` at command start (must be followed by whitespace/newline)
      if (
        c === "{" &&
        words.length === 0 &&
        envAssignments.length === 0 &&
        pendingRedirect === undefined &&
        /[ \t\r\n]/.test(input[i + 1] ?? "")
      ) {
        const grp = scanPosixList(input, i + 1, depth + 1, budget, "}", true);
        if ("reason" in grp) return grp;
        nestedCommands.push(...grp.commands);
        sawCompoundEnd = true;
        dangling = false;
        i = grp.end;
        wordEnd = i + 1;
        continue;
      }
    }

    // Closing paren for `$(...)` or `(...)`
    if (c === ")") {
      if (close === ")") {
        const err = finishCommand(false);
        if (err) return err;
        if (dangling) return { reason: "invalid-structure", detail: "dangling operator before )" };
        return { commands, end: i };
      }
      // Case pattern terminator `foo)` inside `case ... esac`
      if (openKeywords.at(-1) === "case") {
        word = "";
        wordStarted = false;
        words = [];
        rawWords = [];
        wordEnds = [];
        continue;
      }
      return { reason: "invalid-structure", detail: "unexpected closing parenthesis )" };
    }

    // Trailing lone backslash
    if (c === "\\" && i + 1 >= input.length) {
      return { reason: "unterminated-escape", detail: "unterminated trailing backslash" };
    }

    // Escaped character
    if (c === "\\") {
      wordStarted = true;
      word += input[++i]!;
      wordEnd = i + 1;
      dangling = false;
      continue;
    }

    // Single quote
    if (c === "'") {
      const endQ = input.indexOf("'", i + 1);
      if (endQ === -1) return { reason: "unterminated-quote", detail: "unterminated single quote" };
      wordStarted = true;
      word += input.slice(i + 1, endQ);
      i = endQ;
      wordEnd = i + 1;
      dangling = false;
      continue;
    }

    // Double quote
    if (c === '"') {
      const dq = scanPosixDoubleQuote(input, i + 1, depth, budget, nestedCommands);
      if ("reason" in dq) return dq;
      wordStarted = true;
      word += dq.value;
      i = dq.end;
      wordEnd = i + 1;
      dangling = false;
      continue;
    }

    // ANSI-C quote `$'...'` or locale quote `$"..."`
    if (c === "$" && input[i + 1] === "'") {
      const aq = decodeAnsiQuote(input, i + 1);
      if (aq === null) return { reason: "unterminated-quote", detail: "unterminated $'...' quote" };
      wordStarted = true;
      word += aq.value;
      i = aq.end;
      wordEnd = i + 1;
      dangling = false;
      continue;
    }
    if (c === "$" && input[i + 1] === '"') {
      const dq = scanPosixDoubleQuote(input, i + 2, depth, budget, nestedCommands);
      if ("reason" in dq) return dq;
      wordStarted = true;
      word += dq.value;
      i = dq.end;
      wordEnd = i + 1;
      dangling = false;
      continue;
    }

    // Arithmetic `$((...))`
    if (c === "$" && input[i + 1] === "(" && input[i + 2] === "(") {
      const res = scanPosixArithmetic(input, i + 3, depth + 1, budget, nestedCommands);
      if (typeof res === "object") return res;
      wordStarted = true;
      word += input.slice(i, res + 1);
      i = res;
      wordEnd = i + 1;
      dangling = false;
      continue;
    }

    // Command substitution `$(...)`
    if (c === "$" && input[i + 1] === "(") {
      const res = scanPosixList(input, i + 2, depth + 1, budget, ")", true);
      if ("reason" in res) return res;
      nestedCommands.push(...res.commands);
      wordStarted = true;
      word += input.slice(i, res.end + 1);
      i = res.end;
      wordEnd = i + 1;
      dangling = false;
      continue;
    }

    // Backtick command substitution
    if (c === "`") {
      const res = scanPosixBacktick(input, i, depth + 1, budget, nestedCommands, false);
      if (typeof res === "object") return res;
      wordStarted = true;
      word += input.slice(i, res + 1);
      i = res;
      wordEnd = i + 1;
      dangling = false;
      continue;
    }

    // Parameter expansion `${...}`
    if (c === "$" && input[i + 1] === "{") {
      const res = scanPosixParamExpansion(input, i + 2, depth + 1, budget, nestedCommands);
      if (typeof res === "object") return res;
      wordStarted = true;
      word += input.slice(i, res + 1);
      i = res;
      wordEnd = i + 1;
      dangling = false;
      continue;
    }

    // Process substitution `<(...)` / `>(...)`
    if ((c === "<" || c === ">") && input[i + 1] === "(") {
      const res = scanPosixList(input, i + 2, depth + 1, budget, ")", true);
      if ("reason" in res) return res;
      nestedCommands.push(...res.commands);
      wordStarted = true;
      word += input.slice(i, res.end + 1);
      i = res.end;
      wordEnd = i + 1;
      dangling = false;
      continue;
    }

    // Redirections
    if (c === "<" || c === ">" || (c === "&" && input[i + 1] === ">")) {
      const matchedOp = POSIX_REDIRECT_OPS.find((op) => input.startsWith(op, i));
      if (matchedOp !== undefined) {
        if (pendingRedirect !== undefined) {
          return { reason: "invalid-redirect", detail: `unexpected redirect ${matchedOp} before target` };
        }
        let fd: string | undefined;
        if (wordStarted && /^\d+$/.test(word) && (c === "<" || c === ">")) {
          fd = word;
          word = "";
          wordStarted = false;
        } else {
          finishWord();
        }
        commandStart ??= i;
        if (redirectWordCount === undefined && words.length > 0) {
          redirectWordCount = words.length;
        }
        if (matchedOp === "<<" || matchedOp === "<<-") {
          const parsed = parseHeredocDelimiter(input, i + matchedOp.length, matchedOp === "<<-");
          if (parsed === null) {
            return { reason: "invalid-redirect", detail: "invalid heredoc delimiter" };
          }
          pendingHeredocs.push(parsed.heredoc);
          redirects.push({
            op: matchedOp,
            fd,
            target: parsed.heredoc.delimiter,
            isWrite: false,
            isFdDup: false,
          });
          i = parsed.end;
          wordEnd = i + 1;
          dangling = false;
          continue;
        }
        const isFdDup = matchedOp === "<&" || matchedOp === ">&";
        const isWrite = matchedOp !== "<" && matchedOp !== "<<<" && matchedOp !== "<&";
        pendingRedirect = { op: matchedOp, fd, isWrite, isFdDup };
        i += matchedOp.length - 1;
        wordEnd = i + 1;
        continue;
      }
    }

    // List / pipeline separators: `&&`, `||`, `|&`, `;;`, `;`, `|`, `&`, `\n`
    if (c === "&" || c === "|" || c === ";" || c === "\n") {
      if (c === ";" && input[i + 1] === ";" && openKeywords.at(-1) === "case") {
        const err = finishCommand(false);
        if (err) return err;
        i++;
        continue;
      }
      const twoChar =
        (c === "&" && input[i + 1] === "&") ||
        (c === "|" && input[i + 1] === "|") ||
        (c === "|" && input[i + 1] === "&")
          ? input.slice(i, i + 2)
          : undefined;
      const op = twoChar ?? c;
      const isBinaryRequired = op === "&&" || op === "||" || op === "|" || op === "|&";

      if (isBinaryRequired && !hasPendingCommand() && openKeywords.length === 0) {
        return { reason: "invalid-structure", detail: `unexpected operator ${op}` };
      }

      const err = finishCommand(op === "&");
      if (err) return err;

      if (op === "\n" && pendingHeredocs.length > 0) {
        let cursor = i;
        for (const hd of pendingHeredocs.splice(0)) {
          const read = readHeredocBody(input, cursor + 1, hd);
          if (read === null) {
            return { reason: "heredoc", detail: `unterminated heredoc <<${hd.delimiter}` };
          }
          if (!hd.quoted) {
            const hdErr = scanPosixHeredocExpansions(read.body, depth, budget, commands);
            if (hdErr) return hdErr;
          }
          cursor = read.end;
        }
        i = cursor;
        dangling = false;
        continue;
      }

      dangling = isBinaryRequired;
      if (twoChar !== undefined) i++;
      continue;
    }

    // Whitespace
    if (c === " " || c === "\t" || c === "\r") {
      finishWord();
      continue;
    }

    // Unexpected unquoted `(` mid-word (e.g. zsh glob qualifier)
    if (c === "(") {
      return { reason: "invalid-structure", detail: "unexpected '(' in word" };
    }

    wordStarted = true;
    word += c;
    wordEnd = i + 1;
    dangling = false;
  }

  if (close !== undefined) {
    return {
      reason: close === ")" ? "command-substitution" : "invalid-structure",
      detail: `unclosed ${close === ")" ? "parenthesis/substitution" : "brace group"}`,
    };
  }
  if (pendingHeredocs.length > 0) {
    return { reason: "heredoc", detail: `unterminated heredoc <<${pendingHeredocs[0]!.delimiter}` };
  }
  const endErr = finishCommand(false);
  if (endErr) return endErr;
  if (dangling) {
    return { reason: "invalid-structure", detail: "dangling pipeline or logical operator" };
  }
  if (openKeywords.length > 0) {
    return { reason: "compound-command", detail: `unclosed compound structure: ${openKeywords.at(-1)}` };
  }
  return { commands, end: input.length };
}

/* ============================================================================
 * PowerShell Static Scanner
 * ============================================================================ */

const PS_ESCAPES: Record<string, string> = {
  "0": "\0",
  a: "\x07",
  b: "\b",
  e: "\x1b",
  f: "\f",
  n: "\n",
  r: "\r",
  t: "\t",
  v: "\v",
};

const PS_KEYWORDS = new Set([
  "if",
  "elseif",
  "else",
  "for",
  "foreach",
  "while",
  "do",
  "until",
  "switch",
  "try",
  "catch",
  "finally",
  "function",
  "filter",
  "param",
  "begin",
  "process",
  "end",
  "return",
  "throw",
  "exit",
  "break",
  "continue",
]);

function decodePsEscape(input: string, backtickIdx: number): { value: string; end: number } | null {
  const next = input[backtickIdx + 1];
  if (next === undefined) return null;
  if (next === "\r" && input[backtickIdx + 2] === "\n") return { value: "", end: backtickIdx + 2 };
  if (next === "\n" || next === "\r") return { value: "", end: backtickIdx + 1 };
  if (next === "u" && input[backtickIdx + 2] === "{") {
    const closeBrace = input.indexOf("}", backtickIdx + 3);
    if (closeBrace === -1) return null;
    const hex = input.slice(backtickIdx + 3, closeBrace);
    if (!/^[0-9a-fA-F]{1,6}$/.test(hex)) return null;
    const cp = parseInt(hex, 16);
    if (cp > 0x10ffff) return null;
    return { value: String.fromCodePoint(cp), end: closeBrace };
  }
  return { value: PS_ESCAPES[next] ?? next, end: backtickIdx + 1 };
}

function matchPsRedirect(input: string, index: number): { op: string; fd?: string; isWrite: boolean; isFdDup: boolean } | null {
  let cursor = index;
  let fd: string | undefined;
  if (input[cursor] === "*") {
    fd = "*";
    cursor++;
  } else if (/[1-6]/.test(input[cursor] ?? "")) {
    fd = input[cursor]!;
    cursor++;
  }
  if (input[cursor] !== ">") return null;
  cursor++;
  if (input[cursor] === ">") cursor++;
  let isFdDup = false;
  if (input[cursor] === "&") {
    cursor++;
    if (input[cursor] === "1") {
      cursor++;
      isFdDup = true;
    } else {
      return null;
    }
  }
  const op = input.slice(index, cursor);
  if (!/^(?:(?:[1-6]|\*)?>>?|[2-6*]>&1)$/.test(op)) return null;
  return { op, fd, isWrite: !isFdDup, isFdDup };
}

function scanPsHereString(
  input: string,
  start: number,
  depth: number,
  budget: ScanBudget,
  commands: ShellInvocation[],
): { value: string; end: number } | OpaqueSignal {
  const quote = input[start + 1]!;
  let bodyStart = start + 2;
  while (bodyStart < input.length && (input[bodyStart] === " " || input[bodyStart] === "\t")) bodyStart++;
  if (input[bodyStart] === "\r" && input[bodyStart + 1] === "\n") bodyStart += 2;
  else if (input[bodyStart] === "\n" || input[bodyStart] === "\r") bodyStart += 1;
  else return { reason: "unterminated-quote", detail: "PowerShell here-string header requires newline" };

  let lineStart = true;
  for (let i = bodyStart; i < input.length; i++) {
    if (--budget.remaining < 0) return { reason: "invalid-structure", detail: "scanner budget exceeded" };
    if (lineStart && input[i] === quote && input[i + 1] === "@") {
      return { value: input.slice(bodyStart, i).replace(/\r?\n$/, ""), end: i + 1 };
    }
    if (quote === '"') {
      if (input[i] === "`") {
        const esc = decodePsEscape(input, i);
        if (!esc) return { reason: "unterminated-escape", detail: "unterminated escape in PowerShell here-string" };
        i = esc.end;
        lineStart = false;
        continue;
      }
      if (input[i] === "$" && input[i + 1] === "(") {
        const sub = scanPowerShellList(input, i + 2, depth + 1, budget, ")", true);
        if ("reason" in sub) return sub;
        commands.push(...sub.commands);
        i = sub.end;
        lineStart = false;
        continue;
      }
    }
    lineStart = input[i] === "\n" || input[i] === "\r";
  }
  return { reason: "unterminated-quote", detail: "unterminated PowerShell here-string" };
}

function scanPowerShellList(
  input: string,
  start: number,
  depth: number,
  budget: ScanBudget,
  close?: ")" | "}",
  nested = false,
): PosixListResult {
  if (depth > MAX_NESTING_DEPTH) {
    return { reason: "command-substitution", detail: "max nesting depth exceeded" };
  }

  const commands: ShellInvocation[] = [];
  const nestedCommands: ShellInvocation[] = [];

  let words: string[] = [];
  let rawWords: string[] = [];
  let wordEnds: number[] = [];
  let redirects: ShellRedirect[] = [];
  let envAssignments: ShellEnvAssignment[] = [];

  let word = "";
  let wordStarted = false;
  let wordStart = start;
  let wordEnd = start;
  let commandStart: number | undefined;
  let redirectWordCount: number | undefined;

  let pendingRedirect: { op: string; fd?: string; isWrite: boolean; isFdDup: boolean } | undefined;
  let callOperator: "&" | "." | undefined;
  let dangling = false;
  let statementHead = true;
  let isAssignmentLine = false;
  let assignVarName: string | undefined;

  const finishWord = (): void => {
    if (!wordStarted) return;
    const rawWord = input.slice(wordStart, wordEnd);

    if (pendingRedirect !== undefined) {
      redirects.push({
        op: pendingRedirect.op,
        fd: pendingRedirect.fd,
        target: word,
        isWrite: pendingRedirect.isWrite,
        isFdDup: pendingRedirect.isFdDup,
      });
      pendingRedirect = undefined;
    } else if (isAssignmentLine && assignVarName !== undefined) {
      envAssignments.push({ name: assignVarName, value: word, raw: `$env:${assignVarName}=${rawWord}` });
      isAssignmentLine = false;
      assignVarName = undefined;
    } else {
      commandStart ??= wordStart;
      words.push(word);
      rawWords.push(rawWord);
      wordEnds.push(wordEnd);
    }

    word = "";
    wordStarted = false;
  };

  const finishCommand = (): OpaqueSignal | undefined => {
    finishWord();
    if (pendingRedirect !== undefined) {
      return { reason: "invalid-redirect", detail: `PowerShell redirect ${pendingRedirect.op} missing target` };
    }
    if (callOperator !== undefined && words.length === 0) {
      return { reason: "invalid-structure", detail: `PowerShell call operator '${callOperator}' missing target` };
    }
    if (words.length > 0 || redirects.length > 0) {
      const startPos = commandStart ?? wordStart;
      const raw = input.slice(startPos, wordEnd).trim();
      const firstWord = words[0] ?? "";
      const firstRaw = rawWords[0] ?? "";

      // Check PowerShell call operators `&` and `.`
      if (callOperator === ".") {
        if (firstRaw.startsWith("$") || firstRaw.startsWith("(") || firstRaw.startsWith("{")) {
          recordOpaque(budget, "dynamic-command-name", `PowerShell dynamic dot-source: . ${firstRaw}`);
        } else {
          recordOpaque(budget, "dynamic-execution", `PowerShell dot-source: . ${firstRaw}`);
        }
      } else if (callOperator === "&") {
        if (firstRaw.startsWith("$") || firstRaw.startsWith("(") || firstRaw.startsWith("{") || psRawWordHasDynamicExpansion(firstRaw)) {
          recordOpaque(budget, "dynamic-command-name", `PowerShell dynamic call operator: & ${firstRaw}`);
        }
      }

      // Skip bare control-flow keywords (if, foreach, while, etc.) as standalone commands
      const isControlKeyword =
        callOperator === undefined &&
        words.length > 0 &&
        PS_KEYWORDS.has(firstWord.toLowerCase()) &&
        !/['"]/.test(firstRaw);

      if (!isControlKeyword) {
        // Skip pure variable expressions like `$x = 1` or `$_ -like "*.ts"`, but
        // NEVER drop `$`-prefixed member/method/index expressions (`.`, `(`, `[`).
        const isPureVariableExpr =
          callOperator === undefined &&
          firstRaw.startsWith("$") &&
          !firstRaw.startsWith("$(") &&
          !/[.([]/.test(firstRaw) &&
          words.length > 0 &&
          (words[1] === "=" || words[1]?.startsWith("-") || words.length === 1);

        if (!isPureVariableExpr) {
          const inv: ShellInvocation = {
            argv: words,
            rawWords,
            raw,
            redirects,
            envAssignments,
            ...(nested ? { nested: true } : {}),
            ...(statementHead && callOperator === undefined ? { statementHead: true } : {}),
            ...(wordEnds.length > 0 ? { wordEnds: wordEnds.map((e) => e - startPos) } : {}),
            ...(redirectWordCount !== undefined ? { redirectWordCount } : {}),
          };
          checkInvocationOpacity(inv, budget);
          commands.push(inv);
        }
      }
    }
    if (nestedCommands.length > 0) {
      commands.push(...nestedCommands.splice(0));
    }
    words = [];
    rawWords = [];
    wordEnds = [];
    redirects = [];
    envAssignments = [];
    commandStart = undefined;
    redirectWordCount = undefined;
    callOperator = undefined;
    isAssignmentLine = false;
    assignVarName = undefined;
    return undefined;
  };

  let i = start;
  for (; i < input.length; i++) {
    if (--budget.remaining < 0) return { reason: "invalid-structure", detail: "scanner budget exceeded" };
    const c = input[i]!;

    if (!wordStarted) {
      wordStart = i;
      if (c === " " || c === "\t") continue;

      // Block comment `<# ... #>`
      if (c === "<" && input[i + 1] === "#") {
        const endComment = input.indexOf("#>", i + 2);
        if (endComment === -1) return { reason: "invalid-structure", detail: "unterminated PowerShell block comment" };
        i = endComment + 1;
        continue;
      }

      // Line comment `# ...`
      if (c === "#") {
        const nl = input.indexOf("\n", i);
        if (nl === -1) {
          i = input.length;
          break;
        }
        i = nl - 1;
        continue;
      }

      // PowerShell call operators `&` and `.` at command start
      if (words.length === 0 && callOperator === undefined && pendingRedirect === undefined) {
        if (c === "&" && input[i + 1] !== "&") {
          callOperator = "&";
          commandStart ??= i;
          continue;
        }
        if (c === "." && (i + 1 >= input.length || /[\s"'$(),;{|}&]/.test(input[i + 1]!))) {
          callOperator = ".";
          commandStart ??= i;
          continue;
        }
      }

      // PowerShell `$env:VAR = value` detection
      if (words.length === 1 && c === "=" && input[i + 1] !== "=" && /^\$env:([A-Za-z_][A-Za-z0-9_]*)$/i.test(words[0]!)) {
        const m = /^\$env:([A-Za-z_][A-Za-z0-9_]*)$/i.exec(words[0]!);
        if (m) {
          assignVarName = m[1]!;
          isAssignmentLine = true;
          words = [];
          rawWords = [];
          wordEnds = [];
          continue;
        }
      }

      // PowerShell here-strings `@'...'@` and `@"..."@`
      if (c === "@" && (input[i + 1] === "'" || input[i + 1] === '"')) {
        const hs = scanPsHereString(input, i, depth, budget, nestedCommands);
        if ("reason" in hs) return hs;
        wordStarted = true;
        word += hs.value;
        i = hs.end;
        wordEnd = i + 1;
        finishWord();
        dangling = false;
        continue;
      }
    }

    // Closing delimiter for nested `$(...)`, `(...)`, `{...}`
    if (close !== undefined && c === close) {
      const err = finishCommand();
      if (err) return err;
      if (dangling) return { reason: "invalid-structure", detail: `dangling operator before ${close}` };
      return { commands, end: i };
    }

    // Unexpected closing delimiters
    if (c === ")" || c === "}") {
      return { reason: "invalid-structure", detail: `unexpected closing '${c}' in PowerShell` };
    }

    // Backtick escape
    if (c === "`") {
      const esc = decodePsEscape(input, i);
      if (!esc) return { reason: "unterminated-escape", detail: "unterminated PowerShell backtick escape" };
      if (esc.value !== "") {
        wordStarted = true;
        word += esc.value;
      }
      i = esc.end;
      wordEnd = i + 1;
      dangling = false;
      continue;
    }

    // Single-quoted string `'...'` (`''` escapes `'`)
    if (c === "'") {
      let j = i + 1;
      let val = "";
      let closed = false;
      for (; j < input.length; j++) {
        if (input[j] === "'" && input[j + 1] === "'") {
          val += "'";
          j++;
          continue;
        }
        if (input[j] === "'") {
          closed = true;
          break;
        }
        val += input[j]!;
      }
      if (!closed) return { reason: "unterminated-quote", detail: "unterminated PowerShell single quote" };
      wordStarted = true;
      word += val;
      i = j;
      wordEnd = i + 1;
      dangling = false;
      continue;
    }

    // Double-quoted string `"..."` (supports backtick escapes, `""`, and `$(...)`)
    if (c === '"') {
      let j = i + 1;
      let val = "";
      let closed = false;
      for (; j < input.length; j++) {
        if (--budget.remaining < 0) return { reason: "invalid-structure", detail: "scanner budget exceeded" };
        const ch = input[j]!;
        if (ch === '"' && input[j + 1] === '"') {
          val += '"';
          j++;
          continue;
        }
        if (ch === '"') {
          closed = true;
          break;
        }
        if (ch === "`") {
          const esc = decodePsEscape(input, j);
          if (!esc) return { reason: "unterminated-escape", detail: "unterminated escape in PowerShell double quote" };
          val += esc.value;
          j = esc.end;
          continue;
        }
        if (ch === "$" && input[j + 1] === "(") {
          const sub = scanPowerShellList(input, j + 2, depth + 1, budget, ")", true);
          if ("reason" in sub) return sub;
          nestedCommands.push(...sub.commands);
          val += input.slice(j, sub.end + 1);
          j = sub.end;
          continue;
        }
        val += ch;
      }
      if (!closed) return { reason: "unterminated-quote", detail: "unterminated PowerShell double quote" };
      wordStarted = true;
      word += val;
      i = j;
      wordEnd = i + 1;
      dangling = false;
      continue;
    }

    // Subexpression `$(...)`, array subexpression `@(...)`, grouping `(...)`, script block `{...}`
    if ((c === "$" || c === "@") && input[i + 1] === "(") {
      const sub = scanPowerShellList(input, i + 2, depth + 1, budget, ")", true);
      if ("reason" in sub) return sub;
      nestedCommands.push(...sub.commands);
      wordStarted = true;
      word += input.slice(i, sub.end + 1);
      i = sub.end;
      wordEnd = i + 1;
      dangling = false;
      continue;
    }
    if (c === "(") {
      if (wordStarted) finishWord();
      const subStart = i;
      const sub = scanPowerShellList(input, i + 1, depth + 1, budget, ")", true);
      if ("reason" in sub) return sub;
      nestedCommands.push(...sub.commands);
      wordStart = subStart;
      wordStarted = true;
      word = input.slice(subStart, sub.end + 1);
      i = sub.end;
      wordEnd = i + 1;
      finishWord();
      dangling = false;
      continue;
    }
    if (c === "{") {
      if (wordStarted) finishWord();
      const blkStart = i;
      const blk = scanPowerShellList(input, i + 1, depth + 1, budget, "}", true);
      if ("reason" in blk) return blk;
      nestedCommands.push(...blk.commands);
      wordStart = blkStart;
      wordStarted = true;
      word = input.slice(blkStart, blk.end + 1);
      i = blk.end;
      wordEnd = i + 1;
      finishWord();
      dangling = false;
      continue;
    }

    // PowerShell redirections: `>`, `>>`, `2>&1`, `2>`, `*>&1`, etc.
    if (!wordStarted && (c === ">" || c === "*" || /[1-6]/.test(c))) {
      const redir = matchPsRedirect(input, i);
      if (redir !== null) {
        if (pendingRedirect !== undefined) {
          return { reason: "invalid-redirect", detail: `unexpected redirect ${redir.op}` };
        }
        if (redirectWordCount === undefined && words.length > 0) {
          redirectWordCount = words.length;
        }
        if (redir.isFdDup) {
          redirects.push({ op: redir.op, fd: redir.fd, target: "1", isWrite: false, isFdDup: true });
        } else {
          pendingRedirect = redir;
        }
        i += redir.op.length - 1;
        wordEnd = i + 1;
        continue;
      }
    }

    // Pipeline / list separators: `&&`, `||`, `|`, `;`, `\n`, `\r\n`
    if (c === "|" || c === ";" || c === "\n" || c === "\r" || (c === "&" && input[i + 1] === "&")) {
      const twoChar =
        (c === "&" && input[i + 1] === "&") ||
        (c === "|" && input[i + 1] === "|") ||
        (c === "\r" && input[i + 1] === "\n")
          ? input.slice(i, i + 2)
          : undefined;
      const op = twoChar ?? c;
      const isBinary = op === "&&" || op === "||" || op === "|";
      if (isBinary && !wordStarted && words.length === 0 && nestedCommands.length === 0 && redirects.length === 0) {
        return { reason: "invalid-structure", detail: `unexpected PowerShell operator ${op}` };
      }
      const err = finishCommand();
      if (err) return err;
      dangling = isBinary;
      statementHead = !isBinary;
      if (twoChar !== undefined) i++;
      continue;
    }

    // Whitespace
    if (c === " " || c === "\t") {
      finishWord();
      continue;
    }

    wordStarted = true;
    word += c;
    wordEnd = i + 1;
    dangling = false;
  }

  if (close !== undefined) {
    return { reason: "invalid-structure", detail: `unclosed PowerShell '${close === ")" ? "(" : "{"}'` };
  }
  const endErr = finishCommand();
  if (endErr) return endErr;
  if (dangling) {
    return { reason: "invalid-structure", detail: "dangling PowerShell pipeline or logical operator" };
  }
  return { commands, end: input.length };
}

/* ============================================================================
 * Public Entry Points
 * ============================================================================ */

export function detectShellDialect(command: string, shell?: string): ShellDialect {
  if (shell) {
    const base = shell.replace(/^.*[\\/]/, "").replace(/\.exe$/i, "").toLowerCase();
    if (base === "pwsh" || base === "powershell") return "powershell";
    if (base === "zsh") return "zsh";
    if (base === "bash") return "bash";
  }
  // Heuristic auto-detection when no shell is specified:
  if (/^\s*(?:[A-Za-z0-9_.-]+\\)?(?:invoke-expression|iex|invoke-command|icm|start-process|saps)\b/i.test(command)) {
    return "powershell";
  }
  if (/^\s*[&.]\s+\$[A-Za-z_]/.test(command)) return "powershell";
  if (/(?:^|[|;]\s*)(?:Get|Set|New|Remove|Invoke|Where|ForEach|Select|Out|Write|Start|Stop)-[A-Z][A-Za-z]+\b/.test(command)) {
    return "powershell";
  }
  return "posix";
}

export function scanPosixShell(command: string, dialect: "posix" | "bash" | "zsh" = "posix"): ShellScanResult {
  if (command.length > MAX_INPUT_LENGTH) {
    return {
      ok: false,
      opaque: true,
      opaqueReason: "invalid-structure",
      detail: `command exceeds maximum length (${MAX_INPUT_LENGTH} bytes)`,
      dialect,
      commands: [],
    };
  }
  if (command.trim() === "") {
    return {
      ok: false,
      opaque: true,
      opaqueReason: "invalid-structure",
      detail: "empty command",
      dialect,
      commands: [],
    };
  }
  const budget: ScanBudget = { remaining: MAX_INPUT_LENGTH * MAX_NESTING_DEPTH, dialect };
  const res = scanPosixList(command, 0, 0, budget);
  if ("reason" in res) {
    return {
      ok: false,
      opaque: true,
      opaqueReason: res.reason,
      detail: res.detail,
      dialect,
      commands: [],
    };
  }
  if (budget.opaque !== undefined) {
    return {
      ok: false,
      opaque: true,
      opaqueReason: budget.opaque.reason,
      detail: budget.opaque.detail,
      dialect,
      commands: res.commands,
    };
  }
  return {
    ok: true,
    opaque: false,
    dialect,
    commands: res.commands,
  };
}

export function scanPowerShellCommand(command: string): ShellScanResult {
  const dialect: ShellDialect = "powershell";
  if (command.length > MAX_INPUT_LENGTH) {
    return {
      ok: false,
      opaque: true,
      opaqueReason: "invalid-structure",
      detail: `command exceeds maximum length (${MAX_INPUT_LENGTH} bytes)`,
      dialect,
      commands: [],
    };
  }
  if (/[\0\u0085\u2013-\u2015\u2018-\u201e\ufeff]/.test(command)) {
    return {
      ok: false,
      opaque: true,
      opaqueReason: "invalid-structure",
      detail: "unsupported PowerShell Unicode quote/dash/control character",
      dialect,
      commands: [],
    };
  }
  if (command.trim() === "") {
    return {
      ok: false,
      opaque: true,
      opaqueReason: "invalid-structure",
      detail: "empty command",
      dialect,
      commands: [],
    };
  }
  const budget: ScanBudget = { remaining: MAX_INPUT_LENGTH * MAX_NESTING_DEPTH, dialect };
  const res = scanPowerShellList(command, 0, 0, budget);
  if ("reason" in res) {
    return {
      ok: false,
      opaque: true,
      opaqueReason: res.reason,
      detail: res.detail,
      dialect,
      commands: [],
    };
  }
  if (budget.opaque !== undefined) {
    return {
      ok: false,
      opaque: true,
      opaqueReason: budget.opaque.reason,
      detail: budget.opaque.detail,
      dialect,
      commands: res.commands,
    };
  }
  return {
    ok: true,
    opaque: false,
    dialect,
    commands: res.commands,
  };
}

export function scanShellCommand(command: string, opts?: ShellScanOptions): ShellScanResult {
  const dialect = opts?.dialect ?? detectShellDialect(command, opts?.shell);
  if (dialect === "powershell") return scanPowerShellCommand(command);
  return scanPosixShell(command, dialect);
}
