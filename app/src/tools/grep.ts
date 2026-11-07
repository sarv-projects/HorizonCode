/** `grep` — search file contents, preferring ripgrep with a built-in fallback. */

import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import type { GuardAction, Tool, ToolContext, ToolResult } from "../contracts";
import { kernelStateDir, spawnOwned } from "../core/owned-spawn";
import { isBinary, relPath, resolvePath } from "./helpers";

const MAX_RESULTS = 200;
const MAX_FILE_BYTES = 8 * 1024 * 1024;
// `.hz` (canonical) and `.hzcode` (legacy) hold runtime state (kernel files, the
// NF-071 spawn ledger, the session database), never source: searching them would
// both waste results and let the ledger self-match a query — the same exclusion
// repo_map applies.
const SKIP_DIRS = new Set(["node_modules", ".git", "target", "dist", ".hz", ".hzcode"]);
/** Directory names never searched, excluded from the walk and from ripgrep. */
const RG_EXCLUDES = [
  "!**/node_modules/**",
  "!**/.git/**",
  "!**/target/**",
  "!**/dist/**",
  "!**/.hz/**",
  "!**/.hzcode/**",
];

function fail(error: string): ToolResult {
  return { ok: false, output: "", error };
}

function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Guard + (when policy says `ask`) approve a read of `resolved`. */
async function checkAccess(ctx: ToolContext, resolved: string, rel: string): Promise<string | null> {
  const action: GuardAction = { kind: "fs.read", target: resolved };
  const decision = await ctx.guard(action);
  if (decision.decision === "deny") {
    return `denied by policy${decision.reason ? `: ${decision.reason}` : ""}`;
  }
  if (decision.decision === "ask") {
    const ok = await ctx.approve({ title: `Search ${rel}`, detail: resolved, kind: "fs.read" }, action);
    if (!ok) return "declined by user";
  }
  return null;
}

/** One `{"type":"match"}` line of `rg --json` -> `rel:line: text`. */
function parseRgMatch(line: string, cwd: string): string | null {
  let obj: any;
  try {
    obj = JSON.parse(line);
  } catch {
    return null;
  }
  if (!obj || obj.type !== "match" || !obj.data) return null;
  const p = obj.data.path?.text;
  if (typeof p !== "string") return null;
  const no = typeof obj.data.line_number === "number" ? obj.data.line_number : 0;
  const raw = typeof obj.data.lines?.text === "string" ? obj.data.lines.text : "";
  const text = raw.replace(/\r?\n$/, "");
  return `${relPath(cwd, path.resolve(cwd, p))}:${no}: ${text}`;
}

/** Runs ripgrep; returns matches, or null when rg cannot serve the search. */
async function rgSearch(
  exe: string,
  pattern: string,
  root: string,
  globFilter: string | undefined,
  cwd: string,
  stateDir: string,
): Promise<string[] | null> {
  const cmd = [exe, "--json", "--no-config", "--no-messages", "--color", "never", "-e", pattern];
  if (globFilter) cmd.push("--glob", globFilter);
  for (const exclude of RG_EXCLUDES) cmd.push("--glob", exclude);
  cmd.push(root);

  let proc: Awaited<ReturnType<typeof spawnOwned>>["proc"];
  try {
    // NF-071: the single spawn path (foreground: ledger row, no supervisor).
    // cwd/env stay inherited exactly as before; only the record is added.
    ({ proc } = await spawnOwned(cmd, {
      stateDir,
      label: "grep:rg",
      stdio: { stdin: "ignore", stdout: "pipe", stderr: "ignore" },
      longLived: false,
    }));
  } catch {
    return null;
  }

  const results: string[] = [];
  const decoder = new TextDecoder();
  const reader = proc.stdout.getReader();
  let buf = "";
  try {
    outer: for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        const hit = parseRgMatch(line, cwd);
        if (hit) results.push(hit);
        if (results.length >= MAX_RESULTS) break outer;
      }
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
    proc.kill(9);
  } catch {
    /* ignore */
  }

  let code: number | null = null;
  try {
    await proc.exited;
    code = proc.exitCode;
  } catch {
    /* ignore */
  }
  // exit 2 = rg error (bad regex, unreadable root, ...): fall back to the JS walk
  if (code === 2 && results.length === 0) return null;
  return results;
}

/** Plain recursive walk: regex (or literal substring) per line, binary files skipped. */
function jsSearch(pattern: string, root: string, globFilter: string | undefined, cwd: string): string[] {
  let re: RegExp;
  try {
    re = new RegExp(pattern);
  } catch {
    re = new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  }
  let matcher: Bun.Glob | null = null;
  if (globFilter) {
    try {
      matcher = new Bun.Glob(globFilter);
    } catch {
      matcher = null;
    }
  }

  const results: string[] = [];

  const scanFile = (abs: string, rel: string): void => {
    if (matcher && !matcher.match(rel) && !matcher.match(path.basename(rel))) return;
    let buf: Buffer;
    try {
      buf = readFileSync(abs);
    } catch {
      return;
    }
    if (buf.length > MAX_FILE_BYTES || isBinary(buf)) return;
    const lines = buf.toString("utf8").split("\n");
    for (let i = 0; i < lines.length; i++) {
      const text = lines[i].endsWith("\r") ? lines[i].slice(0, -1) : lines[i];
      re.lastIndex = 0;
      if (!re.test(text)) continue;
      results.push(`${rel}:${i + 1}: ${text}`);
      if (results.length >= MAX_RESULTS) return;
    }
  };

  const walk = (dir: string): void => {
    if (results.length >= MAX_RESULTS) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (results.length >= MAX_RESULTS) return;
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        walk(abs);
      } else if (entry.isFile()) {
        scanFile(abs, relPath(cwd, abs));
      }
    }
  };

  let rootIsFile = false;
  try {
    rootIsFile = statSync(root).isFile();
  } catch {
    return results;
  }
  if (rootIsFile) scanFile(root, relPath(cwd, root));
  else walk(root);
  return results;
}

export const grepTool: Tool = {
  name: "grep",
  description: "Search file contents for a regex or text pattern.",
  parameters: {
    type: "object",
    properties: {
      pattern: { type: "string", description: "Regex (or literal text) to search for." },
      path: { type: "string", description: "File or directory to search (default: workspace)." },
      glob: { type: "string", description: "Only search files matching this glob, e.g. '*.ts'." },
    },
    required: ["pattern"],
  },

  async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    try {
      if (typeof args.pattern !== "string" || args.pattern === "") return fail("pattern is required");
      const pattern = args.pattern;
      const rootInput = typeof args.path === "string" && args.path !== "" ? args.path : ".";
      const root = resolvePath(ctx.cwd, rootInput);
      const globFilter = typeof args.glob === "string" && args.glob !== "" ? args.glob : undefined;

      const denied = await checkAccess(ctx, root, relPath(ctx.cwd, root));
      if (denied) return fail(denied);

      const rg = Bun.which("rg");
      const stateDir = kernelStateDir(ctx.workspace);
      let results = rg ? await rgSearch(rg, pattern, root, globFilter, ctx.cwd, stateDir) : null;
      if (results === null) results = jsSearch(pattern, root, globFilter, ctx.cwd);

      if (results.length === 0) return { ok: true, output: "No matches." };
      const body = results.join("\n");
      return {
        ok: true,
        output: results.length >= MAX_RESULTS ? `${body}\n[truncated: first ${MAX_RESULTS} matches shown]` : body,
      };
    } catch (e) {
      return fail(msg(e));
    }
  },
};
