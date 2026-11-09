/**
 * `ast_search` — structural / AST pattern search (Tier-3).
 *
 * The primary backend is the self-contained, zero-dependency structural matcher
 * (./ast-match.ts): HorizonCode keeps app/ at zero runtime dependencies, and
 * this host has no `ast-grep` binary (`/usr/bin/sg` is `newgrp`, not ast-grep).
 * When a REAL external `ast-grep` is present it is a capability-detected
 * accelerator, invoked ONLY through the guarded spawn path — a GuardAction of
 * kind `shell.exec` admitted via ctx.guard / ctx.approve, then `spawnOwned`
 * (core/owned-spawn.ts, NF-071). When it is absent the tool degrades gracefully
 * to the matcher; it never crashes and never spawns without a guard admission.
 *
 * The read is guarded exactly as grep.ts guards its search root (fs.read via
 * ctx.guard, with ctx.approve on `ask`). Output is grep-style for readability:
 *   rel:line:col: <first line of the matched text>
 *   meta: k=v[, k=v...]            (only when the match captured metavariables)
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import type { GuardAction, Tool, ToolContext, ToolResult } from "../contracts";
import { kernelStateDir, spawnOwned } from "../core/owned-spawn";
import { matchPattern } from "./ast-match";
import { isBinary, relPath, resolvePath } from "./helpers";

const MAX_RESULTS = 200;
const MAX_FILE_BYTES = 8 * 1024 * 1024;
/** Candidate files the walk collects before filtering/searching. */
const MAX_CANDIDATES = 50_000;
// Same runtime-state and vendored exclusions grep.ts applies: `.hz`/`.hzcode`
// hold kernel files and ledgers, never source.
const SKIP_DIRS = new Set(["node_modules", ".git", "target", "dist", ".hz", ".hzcode"]);

function fail(error: string): ToolResult {
  return { ok: false, output: "", error };
}

function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Guard + (when policy says `ask`) approve a read of `resolved` — mirrors grep.ts. */
async function checkAccess(ctx: ToolContext, resolved: string, rel: string): Promise<string | null> {
  const action: GuardAction = { kind: "fs.read", target: resolved };
  const decision = await ctx.guard(action);
  if (decision.decision === "deny") {
    return `denied by policy${decision.reason ? `: ${decision.reason}` : ""}`;
  }
  if (decision.decision === "ask") {
    const ok = await ctx.approve({ title: `AST search ${rel}`, detail: resolved, kind: "fs.read" }, action);
    if (!ok) return "declined by user";
  }
  return null;
}

/**
 * Capability-detect a REAL external `ast-grep`. `Bun.which('sg')` on this host
 * resolves to `newgrp` (a set-group shim), NOT ast-grep, so `sg` is only
 * honoured when it resolves to a path whose basename is literally `ast-grep`.
 * Returns the resolved binary path, or null when no real backend exists.
 */
export function detectAstGrep(): string | null {
  const direct = Bun.which("ast-grep");
  if (typeof direct === "string" && direct !== "") return direct;
  const sg = Bun.which("sg");
  if (typeof sg === "string" && sg !== "" && path.basename(sg) === "ast-grep") return sg;
  return null;
}

/** One grep-style line for a match in `rel`. */
function formatMatch(rel: string, line: number, column: number, text: string, meta: Record<string, string>): string {
  const head = text.split("\n")[0] ?? "";
  const base = `${rel}:${line}:${column}: ${head}`;
  const keys = Object.keys(meta);
  if (keys.length === 0) return base;
  const pairs = keys.map((k) => `${k}=${(meta[k] as string).split("\n")[0] ?? ""}`).join(", ");
  return `${base}\nmeta: ${pairs}`;
}

/** Walk `root` under glob honouring SKIP_DIRS, scanning each file with the matcher. */
function selfContainedSearch(
  pat: string,
  root: string,
  globFilter: string | undefined,
  cwd: string,
): { results: string[]; capped: boolean } {
  let matcher: Bun.Glob | null = null;
  if (globFilter) {
    try {
      matcher = new Bun.Glob(globFilter);
    } catch {
      matcher = null;
    }
  }

  const results: string[] = [];
  let capped = false;

  const scanFile = (abs: string, rel: string): void => {
    if (matcher && !matcher.match(rel) && !matcher.match(path.basename(rel))) return;
    let buf: Buffer;
    try {
      buf = readFileSync(abs);
    } catch {
      return;
    }
    if (buf.length > MAX_FILE_BYTES || isBinary(buf)) return;
    const source = buf.toString("utf8");
    for (const m of matchPattern(pat, source)) {
      results.push(formatMatch(rel, m.startLine, m.startColumn, m.text, m.metaVariables));
      if (results.length >= MAX_RESULTS) return;
    }
  };

  const candidates: string[] = [];
  const walk = (dir: string): void => {
    if (capped) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (candidates.length >= MAX_CANDIDATES) {
        capped = true;
        return;
      }
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        walk(abs);
      } else if (entry.isFile()) {
        candidates.push(abs);
      }
    }
  };

  let rootIsFile = false;
  try {
    rootIsFile = statSync(root).isFile();
  } catch {
    return { results, capped };
  }
  if (rootIsFile) candidates.push(root);
  else walk(root);

  for (const abs of candidates) {
    if (results.length >= MAX_RESULTS) break;
    scanFile(abs, relPath(cwd, abs));
  }
  return { results, capped };
}

/**
 * Run the external `ast-grep` through the guarded spawn path. The command is
 * admitted as a `shell.exec` GuardAction (deny -> fail; ask -> approve) BEFORE
 * any child is started, then spawned with spawnOwned (NF-071 ledger). Its
 * `--json` stream is parsed into grep-style lines. Returns null when the
 * backend could not serve the search (so the caller degrades to the matcher).
 */
async function externalSearch(
  exe: string,
  pat: string,
  root: string,
  lang: string | undefined,
  cwd: string,
  ctx: ToolContext,
): Promise<{ ok: true; results: string[] } | { ok: false; denied?: string } | null> {
  const cmd = [exe, "run", "--pattern", pat, "--json"];
  if (lang) cmd.push("--lang", lang);
  cmd.push(root);
  const commandString = cmd.join(" ");

  const action: GuardAction = { kind: "shell.exec", target: commandString };
  const decision = await ctx.guard(action);
  if (decision.decision === "deny") {
    return { ok: false, denied: `denied by policy${decision.reason ? `: ${decision.reason}` : ""}` };
  }
  if (decision.decision === "ask") {
    const approved = await ctx.approve(
      { title: "Run ast-grep", detail: commandString, kind: "shell.exec" },
      action,
    );
    if (!approved) return { ok: false, denied: "declined by user" };
  }

  let proc: Awaited<ReturnType<typeof spawnOwned>>["proc"];
  try {
    ({ proc } = await spawnOwned(cmd, {
      stateDir: kernelStateDir(ctx.workspace),
      label: "ast_search:ast-grep",
      stdio: { stdin: "ignore", stdout: "pipe", stderr: "ignore" },
      longLived: false,
    }));
  } catch {
    return null;
  }

  const results: string[] = [];
  const decoder = new TextDecoder();
  const reader = proc.stdout.getReader();
  let out = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      out += decoder.decode(value, { stream: true });
    }
  } catch {
    /* stream closed early */
  }
  try {
    reader.cancel();
  } catch {
    /* ignore */
  }
  try {
    await proc.exited;
  } catch {
    /* ignore */
  }

  // ast-grep --json emits one JSON array of matches. Be lenient: accept either a
  // single array or newline-delimited objects.
  const parsed = parseAstGrepJson(out, cwd);
  if (parsed === null) return null;
  for (const line of parsed) {
    results.push(line);
    if (results.length >= MAX_RESULTS) break;
  }
  return { ok: true, results };
}

/** Parse ast-grep `--json` output into grep-style lines, or null on garbage. */
function parseAstGrepJson(out: string, cwd: string): string[] | null {
  const text = out.trim();
  if (text === "") return [];
  let items: unknown;
  try {
    items = JSON.parse(text);
  } catch {
    // Newline-delimited fallback.
    const lines: unknown[] = [];
    for (const raw of text.split("\n")) {
      const t = raw.trim();
      if (t === "") continue;
      try {
        lines.push(JSON.parse(t));
      } catch {
        return null;
      }
    }
    items = lines;
  }
  if (!Array.isArray(items)) return null;
  const results: string[] = [];
  for (const item of items) {
    if (item === null || typeof item !== "object") continue;
    const obj = item as Record<string, any>;
    const file = typeof obj.file === "string" ? obj.file : "";
    const range = obj.range as Record<string, any> | undefined;
    const startLine = typeof range?.start?.line === "number" ? range.start.line + 1 : 0;
    const startCol = typeof range?.start?.column === "number" ? range.start.column + 1 : 0;
    const matchText = typeof obj.text === "string" ? obj.text : "";
    const rel = file === "" ? "" : relPath(cwd, path.resolve(cwd, file));
    results.push(`${rel}:${startLine}:${startCol}: ${matchText.split("\n")[0] ?? ""}`);
  }
  return results;
}

export const astSearchTool: Tool = {
  name: "ast_search",
  description:
    "Structural (AST-style) pattern search. Metavariables: $NAME (one token), $$$NAME (a run of tokens). " +
    "Uses a built-in structural matcher; an external ast-grep binary is used only when present and only through the guard.",
  parameters: {
    type: "object",
    properties: {
      pat: { type: "string", description: "Structural pattern, e.g. 'foo($A)'. $NAME / $$$NAME are metavariables." },
      path: { type: "string", description: "File or directory to search (default: workspace)." },
      glob: { type: "string", description: "Only search files matching this glob, e.g. '*.ts'." },
      lang: { type: "string", description: "Optional language hint for an external ast-grep backend." },
    },
    required: ["pat"],
  },

  async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    try {
      if (typeof args.pat !== "string" || args.pat === "") return fail("pat is required");
      const pat = args.pat;
      const rootInput = typeof args.path === "string" && args.path !== "" ? args.path : ".";
      const root = resolvePath(ctx.cwd, rootInput);
      const globFilter = typeof args.glob === "string" && args.glob !== "" ? args.glob : undefined;
      const lang = typeof args.lang === "string" && args.lang !== "" ? args.lang : undefined;

      const denied = await checkAccess(ctx, root, relPath(ctx.cwd, root));
      if (denied) return fail(denied);

      const exe = detectAstGrep();
      let results: string[] | null = null;
      const notices: string[] = [];

      if (exe !== null) {
        const ext = await externalSearch(exe, pat, root, lang, ctx.cwd, ctx);
        if (ext !== null && ext.ok === false) return fail(ext.denied ?? "denied");
        if (ext !== null && ext.ok) results = ext.results;
        else notices.push("[ast-grep unavailable: degraded to the built-in structural matcher]");
      }

      if (results === null) {
        const self = selfContainedSearch(pat, root, globFilter, ctx.cwd);
        results = self.results;
        if (self.capped) {
          notices.push(`[incomplete: stopped after ${MAX_CANDIDATES} candidate files; narrow the path]`);
        }
      }

      if (results.length >= MAX_RESULTS) notices.push(`[truncated: first ${MAX_RESULTS} matches shown]`);

      if (results.length === 0) {
        const body = notices.length === 0 ? "No matches." : `No matches.\n${notices.join("\n")}`;
        return { ok: true, output: body };
      }
      const body = results.join("\n");
      return { ok: true, output: notices.length === 0 ? body : `${body}\n${notices.join("\n")}` };
    } catch (e) {
      return fail(msg(e));
    }
  },
};
