/**
 * Plan-mode shell guard: a conservative READ-ONLY allowlist.
 *
 * Plan mode is documented as read-only (docs/09 §4.6), but the previous
 * implementation was a denylist: it recognised `rm -rf`, `sed -i`, unsafe
 * redirects and a few wrappers, and ALLOWED everything else. That let
 * `git checkout -- .`, `make`, `npm install`, `truncate -s 0 f` and
 * `find . -delete` through. A denylist cannot be made safe for an open-ended
 * shell, so this module inverts the rule:
 *
 *   - the command line is split with the existing compound-shell parser;
 *   - common wrappers (env/timeout/sudo/nice/command/nohup/stdbuf/xargs) are
 *     peeled, and the PROGRAM of every segment must be on the allowlist;
 *   - per-program argument checks reject the known write/execute options
 *     (`find -delete/-exec/...`, `sed -i/-f` and sed's `w`/`e` commands,
 *     `awk system()`/output redirection, `rg --pre`, `tree -o`, ...);
 *   - output redirects are allowed only to the existing safe sinks
 *     (/dev/null, /dev/std*, /dev/tty, /tmp, /var/tmp);
 *   - anything unparsed, multi-line, backgrounded (`&`) or unknown is refused.
 *
 * Deliberately conservative: an investigation command we forgot is REFUSED,
 * never allowed. The model can still read files with `read`/`grep` tools and
 * stage edits with `write`/`edit`; plan mode is not meant to run build tools.
 */

import { analyzeShellCompound } from "./shell-split";

const WRAPPERS = new Set(["sudo", "doas", "env", "timeout", "xargs", "command", "nohup", "time", "nice", "stdbuf"]);

/**
 * Programs plan-mode shell may run. Every entry must be a read-only
 * investigation tool whose writes are either impossible or checked below.
 * Shell builtins are intentionally absent except `cd` (it only changes the
 * shell's own working directory).
 */
const READ_ONLY_PROGRAMS = new Set([
  "ls",
  "cat",
  "head",
  "tail",
  "wc",
  "file",
  "stat",
  "pwd",
  "tree",
  "grep",
  "rg",
  "find",
  "git",
  "awk",
  "sed",
  "diff",
  "cmp",
  "sort",
  "uniq",
  "cut",
  "tr",
  "nl",
  "column",
  "du",
  "df",
  "basename",
  "dirname",
  "realpath",
  "readlink",
  "date",
  "uname",
  "whoami",
  "id",
  "printenv",
  "which",
  "echo",
  "printf",
  "cd",
]);

/** Find actions that delete, execute, or write files (`-fprintf`, `-fls`, ...). */
const FIND_FORBIDDEN = ["-delete", "-exec", "-execdir", "-ok", "-okdir", "-fprint", "-fls"];

function maskQuotesAndComments(segment: string): string {
  let out = "";
  let i = 0;
  let quote: "'" | '"' | null = null;
  while (i < segment.length) {
    const c = segment[i]!;
    if (quote !== null) {
      if (c === quote) quote = null;
      else out += " ";
      i++;
      continue;
    }
    if (c === "#" && (i === 0 || /\s/.test(segment[i - 1]!))) break;
    if (c === "'" || c === '"') {
      quote = c;
      out += " ";
      i++;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

function isAllowedRedirectTarget(target: string): boolean {
  // `>&2`, `2>&1`, `>&-`: file-descriptor duplication/close, not a file write.
  if (/^&-?$/.test(target) || /^&\d+$/.test(target)) return true;
  const t = target.toLowerCase();
  if (t.includes("..")) return false;
  if (t === "/dev/null" || t === "/dev/stdout" || t === "/dev/stderr" || t === "/dev/tty") return true;
  if (t === "nul:" || t === "nul") return true;
  if (t === "/tmp" || t.startsWith("/tmp/") || t === "/var/tmp" || t.startsWith("/var/tmp/")) return true;
  return false;
}

/**
 * Refuse a file-writing redirect. Input redirects (`< file`, here-strings) are
 * read-only and left alone; process substitution and heredocs never reach this
 * point (the compound parser refuses them).
 */
function redirectWriteReason(masked: string): string | undefined {
  let i = 0;
  while (i < masked.length) {
    const c = masked[i]!;
    if (c !== ">") {
      i++;
      continue;
    }
    let j = i + 1;
    if (masked[j] === ">") j++; // >>
    if (masked[j] === "|") j++; // >| (clobber)
    while (j < masked.length && /\s/.test(masked[j]!)) j++;
    // `>&1` / `>&-`: the target is a file descriptor, not a path.
    if (masked[j] === "&") {
      let fd = j + 1;
      while (fd < masked.length && /[\d-]/.test(masked[fd]!)) fd++;
      const target = masked.slice(j, fd);
      if (target === "&") return "redirect without a target";
      if (!isAllowedRedirectTarget(target)) return `redirect write to ${target}`;
      i = fd;
      continue;
    }
    let k = j;
    while (k < masked.length && !/[\s;|&]/.test(masked[k]!)) k++;
    const target = masked.slice(j, k);
    if (target === "") return "redirect without a target";
    if (!isAllowedRedirectTarget(target)) return `redirect write to ${target}`;
    i = k;
  }
  return undefined;
}

/** A lone `&` backgrounds the preceding segment and starts another command. */
function backgroundOperatorReason(masked: string): string | undefined {
  for (let i = 0; i < masked.length; i++) {
    if (masked[i] !== "&") continue;
    if (masked[i + 1] === "&") {
      i++; // && (normally already split into segments)
      continue;
    }
    if (masked[i + 1] === ">") continue; // &> / &>>
    if (masked[i - 1] === ">") continue; // 2>&1 / >&2 / >&-
    return "background operator &";
  }
  return undefined;
}

function tokenizeMasked(masked: string): string[] {
  return masked.trim().split(/\s+/).filter((t) => t !== "");
}

function skipWrapperOptions(wrapper: string, tokens: string[], start: number): number {
  let i = start;
  if (wrapper === "env") {
    while (i < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i]!)) i++;
    return i;
  }
  if (wrapper === "timeout") {
    while (i < tokens.length && tokens[i]!.startsWith("-")) i++;
    if (i < tokens.length && /^[\d.]+[smhd]?$/.test(tokens[i]!)) i++;
    return i;
  }
  if (wrapper === "xargs" || wrapper === "sudo" || wrapper === "doas") {
    while (i < tokens.length && tokens[i]!.startsWith("-")) i++;
    return i;
  }
  if (wrapper === "nice") {
    while (i < tokens.length && tokens[i]!.startsWith("-")) {
      const token = tokens[i]!;
      if (token === "-n" || token === "--adjustment") {
        i += 2; // option plus its numeric argument
        continue;
      }
      i++;
    }
    return i;
  }
  if (wrapper === "command" || wrapper === "nohup" || wrapper === "stdbuf" || wrapper === "time") {
    while (i < tokens.length && tokens[i]!.startsWith("-")) i++;
    return i;
  }
  return i;
}

function peelWrappers(tokens: string[]): { tokens: string[]; refusal?: string } {
  let i = 0;
  while (i < tokens.length) {
    const head = tokens[i]!.toLowerCase();
    if (!WRAPPERS.has(head)) break;
    // `/usr/bin/time -o FILE` / `-a` write the timing report to a file; the
    // shell `time` keyword has no such option, so only the binary endangers.
    if (head === "time") {
      for (let j = i + 1; j < tokens.length && tokens[j]!.startsWith("-"); j += 1) {
        const option = tokens[j]!;
        if (
          option === "-o" ||
          option === "--output" ||
          option.startsWith("--output=") ||
          option === "-a" ||
          option === "--append"
        ) {
          return { tokens: tokens.slice(i), refusal: `time ${option} (output file)` };
        }
      }
    }
    i = skipWrapperOptions(head, tokens, i + 1);
  }
  return { tokens: tokens.slice(i) };
}

function optionPresent(tokens: readonly string[], names: readonly string[]): string | undefined {
  for (const token of tokens) {
    for (const name of names) {
      if (token === name || (name.startsWith("--") && token.startsWith(`${name}=`))) return name;
    }
  }
  return undefined;
}

/** A long option prefix (GNU tools accept unambiguous abbreviations). */
function longOptionPrefixPresent(tokens: readonly string[], prefix: string): string | undefined {
  return tokens.find((token) => token.startsWith(prefix) && prefix.startsWith("--"));
}

/** A short-option cluster such as `-nf` / `-Ei` that carries `flag`. */
function shortFlagPresent(tokens: readonly string[], flag: string): boolean {
  return tokens
    .slice(1)
    .some((token) => token.length > 1 && token[0] === "-" && token[1] !== "-" && token.slice(1).includes(flag));
}

/** `sed -i`, `sed -Ei`, `sed --in-place=.bak`: in-place edits. */
function sedInPlace(tokens: readonly string[]): boolean {
  for (const token of tokens.slice(1)) {
    if (token.startsWith("--i")) return true; // --in-place, incl. unambiguous abbreviations
    if (/^-[^-]*i/.test(token)) return true;
  }
  return false;
}

/**
 * sed can write even without `-i`: the `w`/`W` commands write files and `e`/`E`
 * execute a shell. Scripts are normally quoted (masked above), so the RAW
 * segment is inspected. Conservative: a false positive refuses the command.
 */
function sedScriptWrites(raw: string): boolean {
  // Any w/W/e/E command or flag not embedded in a word: `w file`, `1w file`,
  // `1,$w file`, `/re/w file`, `s/a/b/w file`, `s/a/b/e`. A replacement that
  // merely starts with w/e (`s/hello/world/`) is not a separator-terminated
  // command and stays allowed.
  if (/(?:^|[^A-Za-z0-9_])[wWeE](?=[\s;'"{}!]|$)/.test(raw)) return true;
  // Address glued to the command: `1w file`, `1,3w file`.
  if (/(?:^|[;\n'"{}!])[ \t]*\d+(?:,\d+)?[ \t]*[wWeE](?=[\s;'"{}!]|$)/.test(raw)) return true;
  // Substitution flags: s/a/b/w file, s/a/b/gw file, s/a/b/e.
  if (/(?:^|[\s'";])s(.).*?\1.*?\1[a-zA-Z0-9]*[wWeE]/.test(raw)) return true;
  return false;
}

/** awk can execute (`system`) and write (`print > file`, `print | "cmd"`). */
function awkScriptWrites(raw: string): boolean {
  if (/\bsystem\s*\(/.test(raw)) return true;
  if (/\b(?:print|printf)\b[^;\n}]*>>?/.test(raw)) return true;
  if (/\b(?:print|printf)\b[^;\n}]*\|/.test(raw)) return true;
  // `"command" | getline` runs a shell command (awk's other exec vector).
  if (/\|\s*getline\b/.test(raw)) return true;
  if (/@(?:include|load)\b/.test(raw)) return true;
  return false;
}

const GIT_READ_SUBCOMMANDS = new Set(["status", "diff", "log", "show", "rev-parse", "ls-files", "branch"]);

/** Git options that write a file or run an external helper program. */
function gitDangerousOption(tokens: readonly string[]): string | undefined {
  for (const token of tokens.slice(2)) {
    // --output and its unambiguous abbreviations write a file.
    if (token.startsWith("--out")) return token;
    if (token === "--ext-diff" || token === "--textconv") return token;
  }
  return undefined;
}

/** `git branch` creates/deletes unless every argument is a listing flag. */
function gitBranchRefusal(tokens: readonly string[]): string | undefined {
  const allowedFlags = new Set([
    "-a",
    "--all",
    "-r",
    "--remotes",
    "-v",
    "-vv",
    "--verbose",
    "-l",
    "--list",
    "--show-current",
    "--no-color",
    "--color",
    "--contains",
    "--no-contains",
    "--merged",
    "--no-merged",
    "--points-at",
    "--column",
    "--no-column",
    "-i",
    "--ignore-case",
    "--omit-empty",
    "--sort",
    "--format",
  ]);
  for (const token of tokens.slice(2)) {
    if (token.startsWith("--color=") || token.startsWith("--sort=") || token.startsWith("--format=")) continue;
    if (allowedFlags.has(token)) continue;
    return token;
  }
  return undefined;
}

function gitRefusal(tokens: readonly string[]): string | undefined {
  const sub = tokens[1];
  if (sub === undefined) return "git without a read-only subcommand";
  if (!GIT_READ_SUBCOMMANDS.has(sub)) return `git ${sub}`;
  const dangerous = gitDangerousOption(tokens);
  if (dangerous !== undefined) return `git ${sub} ${dangerous}`;
  if (sub === "branch") {
    const branchArg = gitBranchRefusal(tokens);
    if (branchArg !== undefined) return `git branch ${branchArg}`;
  }
  return undefined;
}

/** Per-program option checks; returns a refusal reason or undefined. */
function programRefusal(program: string, tokens: readonly string[], raw: string): string | undefined {
  switch (program) {
    case "find": {
      for (const token of tokens.slice(1)) {
        for (const flag of FIND_FORBIDDEN) {
          if (token === flag || token.startsWith(flag)) return `find ${token}`;
        }
      }
      return undefined;
    }
    case "sed": {
      if (sedInPlace(tokens)) return "sed -i in-place edit";
      if (
        shortFlagPresent(tokens, "f") ||
        optionPresent(tokens, ["--file"]) !== undefined ||
        longOptionPrefixPresent(tokens, "--f") !== undefined
      ) {
        return "sed script from file";
      }
      if (sedScriptWrites(raw)) return "sed write/execute command";
      return undefined;
    }
    case "awk": {
      if (
        shortFlagPresent(tokens, "f") ||
        optionPresent(tokens, ["--file"]) !== undefined ||
        longOptionPrefixPresent(tokens, "--fi") !== undefined
      ) {
        return "awk script from file";
      }
      if (
        shortFlagPresent(tokens, "i") ||
        shortFlagPresent(tokens, "l") ||
        longOptionPrefixPresent(tokens, "--i") !== undefined ||
        longOptionPrefixPresent(tokens, "--lo") !== undefined
      ) {
        return "awk extension load";
      }
      if (awkScriptWrites(raw)) return "awk write/execute command";
      return undefined;
    }
    case "rg": {
      const pre = tokens.find((t) => t === "--pre" || t.startsWith("--pre="));
      if (pre !== undefined) return `rg ${pre} (preprocessor)`;
      return undefined;
    }
    case "git":
      return gitRefusal(tokens);
    case "tree": {
      const output =
        optionPresent(tokens, ["-o", "--output"]) ??
        longOptionPrefixPresent(tokens, "--out") ??
        (shortFlagPresent(tokens, "o") ? "-o" : undefined);
      if (output !== undefined) return `tree ${output} (output file)`;
      return undefined;
    }
    case "sort": {
      const output =
        optionPresent(tokens, ["-o", "--output", "--compress-program", "-T", "--temporary-directory"]) ??
        longOptionPrefixPresent(tokens, "--out") ??
        longOptionPrefixPresent(tokens, "--comp") ??
        longOptionPrefixPresent(tokens, "--temp") ??
        (shortFlagPresent(tokens, "o") ? "-o" : undefined) ??
        (shortFlagPresent(tokens, "T") ? "-T" : undefined);
      if (output !== undefined) return `sort ${output} (output/compress/temp file)`;
      return undefined;
    }
    case "uniq": {
      // uniq's second positional argument is an OUTPUT file.
      let positionals = 0;
      for (const token of tokens.slice(1)) {
        if (token.startsWith("-")) continue;
        positionals += 1;
        if (positionals > 1) return "uniq output file";
      }
      return undefined;
    }
    case "diff": {
      const output =
        optionPresent(tokens, ["-o", "--output"]) ??
        longOptionPrefixPresent(tokens, "--out") ??
        (shortFlagPresent(tokens, "o") ? "-o" : undefined);
      if (output !== undefined) return `diff ${output} (output file)`;
      return undefined;
    }
    case "date": {
      const set =
        optionPresent(tokens, ["-s", "--set"]) ??
        longOptionPrefixPresent(tokens, "--s") ??
        (shortFlagPresent(tokens, "s") ? "-s" : undefined);
      if (set !== undefined) return `date ${set} (set clock)`;
      return undefined;
    }
    case "file": {
      // `file -C` compiles a magic file (writes magic.mgc).
      const compile =
        optionPresent(tokens, ["-C", "--compile"]) ?? (shortFlagPresent(tokens, "C") ? "-C" : undefined);
      if (compile !== undefined) return `file ${compile} (compile magic)`;
      return undefined;
    }
    default:
      return undefined;
  }
}

function checkSegment(segment: string): string | undefined {
  // A newline is a command separator to the shell but not to the compound
  // splitter; `ls # comment\n rm -rf x` must never be read as one `ls` segment.
  if (/[\r\n]/.test(segment)) return "multi-line shell";
  const masked = maskQuotesAndComments(segment);
  const redirect = redirectWriteReason(masked);
  if (redirect !== undefined) return redirect;
  const background = backgroundOperatorReason(masked);
  if (background !== undefined) return background;
  const peeled = peelWrappers(tokenizeMasked(masked));
  if (peeled.refusal !== undefined) return peeled.refusal;
  const tokens = peeled.tokens;
  if (tokens.length === 0) return "empty command segment";
  const program = tokens[0]!;
  if (!READ_ONLY_PROGRAMS.has(program)) return `not a read-only command: ${program}`;
  return programRefusal(program, tokens, segment);
}

/**
 * Short reason when a plan-mode command is not on the read-only allowlist, or
 * undefined when every segment is an allowed investigation command. The name is
 * kept for existing callers; the meaning is now "refused by the allowlist".
 */
export function findPlanModeMutatingCommand(command: string): string | undefined {
  const analysis = analyzeShellCompound(command);
  if (analysis.ok === false) return `unparsed shell (${analysis.reason})`;
  for (const seg of analysis.segments) {
    const reason = checkSegment(seg.text);
    if (reason !== undefined) return reason;
  }
  return undefined;
}

/** Model-facing refusal for plan-mode shell, or undefined to allow investigation commands. */
export function planModeShellRefusal(command: string): string | undefined {
  const reason = findPlanModeMutatingCommand(command);
  if (reason === undefined) return undefined;
  return (
    `plan mode: shell refused (${reason}); plan mode runs only read-only investigation commands. ` +
    "Use read/grep to inspect, write/edit to stage file changes, or exit plan mode to run mutating commands"
  );
}
