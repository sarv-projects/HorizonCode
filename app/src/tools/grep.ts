/** `grep` — search file contents, preferring ripgrep with a built-in fallback. */

import { lstatSync, readdirSync, readFileSync } from "node:fs";
import type { Stats } from "node:fs";
import path from "node:path";
import type { GuardAction, Tool, ToolContext, ToolResult } from "../contracts";
import { tunnelPermissionError } from "../core/guards/defect-tunnel";
import { kernelStateDir, spawnOwned } from "../core/owned-spawn";
import { realpathish } from "../core/paths";
import { isBinary, relPath, resolveRealTarget, scrubEnv } from "./helpers";
import { gitIgnoredPaths } from "./ignore";

const MAX_RESULTS = 200;
const MAX_FILE_BYTES = 8 * 1024 * 1024;
const RG_TIMEOUT_MS = 30_000;
/** Candidate files the JS fallback collects before filtering/searching. */
const MAX_CANDIDATES = 50_000;
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
  signal: AbortSignal,
): Promise<string[] | null> {
  if (signal.aborted) return [];
  const cmd = [exe, "--json", "--no-config", "--no-messages", "--color", "never", "-e", pattern];
  if (globFilter) cmd.push("--glob", globFilter);
  for (const exclude of RG_EXCLUDES) cmd.push("--glob", exclude);
  cmd.push("--", root);

  let proc: Awaited<ReturnType<typeof spawnOwned>>["proc"];
  try {
    // NF-071: the single spawn path (foreground: ledger row, no supervisor).
    ({ proc } = await spawnOwned(cmd, {
      stateDir,
      label: "grep:rg",
      env: scrubEnv(),
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
  const killRg = (): void => {
    try {
      proc.kill(9);
    } catch {
      /* ignore */
    }
    try {
      void reader.cancel();
    } catch {
      /* ignore */
    }
  };
  const timer = setTimeout(killRg, RG_TIMEOUT_MS);
  signal.addEventListener("abort", killRg, { once: true });
  try {
    outer: for (;;) {
      if (signal.aborted) break;
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
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", killRg);
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

/**
 * Plain recursive walk: regex (or literal substring) per line, binary files
 * skipped. Git-ignored candidates are filtered the same way ripgrep filters
 * them (ignore.ts), so the fallback and the ripgrep path answer alike.
 */
async function jsSearch(
  pattern: string,
  root: string,
  globFilter: string | undefined,
  cwd: string,
  stateDir: string,
  signal?: AbortSignal,
): Promise<{ matches: string[]; note?: string }> {
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

  const candidates: string[] = [];
  let capped = false;
  const walk = (dir: string): void => {
    if (capped || signal?.aborted) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (signal?.aborted) return;
      if (candidates.length >= MAX_CANDIDATES) {
        capped = true;
        return;
      }
      // NEVER follow a symlink during the walk: a link inside the workspace can
      // point at ~/.ssh or any other outside tree, and searching through it
      // would read bytes the guard never classified. The root itself is
      // realpath-resolved and guarded before the walk starts.
      if (entry.isSymbolicLink()) continue;
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
    // lstat, not stat: the root was already realpath-resolved by the caller, so
    // this refuses a symlink swapped into the root's place after that guard
    // instead of following it.
    const st = lstatSync(root);
    if (st.isSymbolicLink()) return { matches: results };
    rootIsFile = st.isFile();
  } catch {
    return { matches: results };
  }
  if (rootIsFile) candidates.push(root);
  else walk(root);

  if (signal?.aborted) return { matches: results };
  const ignored = await gitIgnoredPaths(cwd, candidates, stateDir);
  for (const abs of candidates) {
    if (signal?.aborted || results.length >= MAX_RESULTS) break;
    if (ignored.has(abs)) continue;
    // Defensive per-candidate check (a race can swap a path component after the
    // walk): refuse symlinks and any candidate whose real path differs from the
    // walked path, so a link planted mid-search cannot redirect the read.
    let st: Stats;
    try {
      st = lstatSync(abs);
    } catch {
      continue;
    }
    if (!st.isFile()) continue; // symlinks and special files are not read
    if (realpathish(abs) !== abs) continue;
    scanFile(abs, relPath(cwd, abs));
  }
  return {
    matches: results,
    note: capped
      ? `[incomplete: stopped after ${MAX_CANDIDATES} candidate files; this search is NOT exhaustive — narrow the path]`
      : undefined,
  };
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
      // The guard must classify the root whose bytes are actually traversed:
      // `statSync`/`readdirSync`/`readFileSync` all follow a symlink at the root,
      // so a lexical "inside" decision would let a link to ~/.ssh be searched.
      const root = resolveRealTarget(ctx.cwd, rootInput, ctx.workspace).real;
      const globFilter = typeof args.glob === "string" && args.glob !== "" ? args.glob : undefined;

      const denied = await checkAccess(ctx, root, relPath(ctx.cwd, root));
      if (denied) return fail(denied);

      const rg = Bun.which("rg");
      const stateDir = kernelStateDir(ctx.workspace);
      let results = rg ? await rgSearch(rg, pattern, root, globFilter, ctx.cwd, stateDir, ctx.signal) : null;
      let incomplete: string | undefined;
      if (results === null) {
        if (ctx.signal.aborted) return fail("aborted");
        const js = await jsSearch(pattern, root, globFilter, ctx.cwd, stateDir, ctx.signal);
        if (ctx.signal.aborted) return fail("aborted");
        results = js.matches;
        incomplete = js.note;
      }

      if (results.length === 0 && incomplete === undefined) return { ok: true, output: "No matches." };
      const body = results.join("\n");
      const notices: string[] = [];
      if (results.length >= MAX_RESULTS) notices.push(`[truncated: first ${MAX_RESULTS} matches shown]`);
      if (incomplete !== undefined) notices.push(incomplete);
      if (notices.length === 0) return { ok: true, output: body };
      return { ok: true, output: body === "" ? notices.join("\n") : `${body}\n${notices.join("\n")}` };
    } catch (e) {
      tunnelPermissionError(e);
      return fail(msg(e));
    }
  },
};
