/**
 * `hzcode doctor` (T-10): a diagnose-only environment report.
 *
 * Every check answers one question ("will this install behave?") with OK, WARN
 * or FAIL and, for anything not OK, a one-line fix hint. Nothing is changed and
 * no key is ever printed: the provider line says whether a key exists and where
 * it came from, never the value. The one filesystem touch is the kernel's own
 * `--selftest`, which works in a scratch directory under the OS temp dir that
 * the kernel removes (and that this module removes again) when it finishes.
 *
 * Everything the checks read is injected (`DoctorEnv`), so the tests drive each
 * line with a fake environment and no real terminal, kernel or network.
 */

import { spawnSync } from "node:child_process";
import { accessSync, constants, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import * as path from "node:path";
import { catalogModel, loadCatalog } from "./catalog/catalog";
import { defaultConfigPath, loadConfig, missingKey, type EnvLike } from "./config";
import { resolveKernelBinary } from "./kernel";
import { kernelStateDir } from "./paths";
import { detectColorLevel } from "../tui/style";

export type DoctorStatus = "ok" | "warn" | "fail";

export interface DoctorCheck {
  /** Stable machine id (the JSON output keys on it). */
  id: string;
  /** Short human label for the table. */
  label: string;
  status: DoctorStatus;
  detail: string;
  /** What to do about it; present for every warn and fail. */
  hint?: string;
}

/** The result of running an external command (injected so tests need no processes). */
export interface SpawnResult {
  ok: boolean;
  status: number | null;
  stdout: string;
  stderr: string;
}

export interface DoctorEnv {
  env: EnvLike;
  workspace: string;
  home: string;
  bunVersion: string | undefined;
  stdinIsTTY: boolean;
  stdoutIsTTY: boolean;
  /** Run a command with a timeout. Must not throw. */
  run: (cmd: string, args: string[], timeoutMs: number) => SpawnResult;
  /** Where the kernel binary is, or undefined when there is none. */
  kernelBinary: string | undefined;
}

export function realDoctorEnv(workspace: string, env: EnvLike = process.env): DoctorEnv {
  return {
    env,
    workspace,
    home: homedir(),
    bunVersion: (process.versions as { bun?: string }).bun,
    stdinIsTTY: Boolean(process.stdin.isTTY),
    stdoutIsTTY: Boolean(process.stdout.isTTY),
    run: (cmd, args, timeoutMs) => {
      try {
        const r = spawnSync(cmd, args, { encoding: "utf8", timeout: timeoutMs, stdio: ["ignore", "pipe", "pipe"], env: env as NodeJS.ProcessEnv });
        if (r.error) return { ok: false, status: null, stdout: "", stderr: r.error.message };
        return { ok: r.status === 0, status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
      } catch (err) {
        return { ok: false, status: null, stdout: "", stderr: err instanceof Error ? err.message : String(err) };
      }
    },
    kernelBinary: resolveKernelBinary(env),
  };
}

const ok = (id: string, label: string, detail: string): DoctorCheck => ({ id, label, status: "ok", detail });
const warn = (id: string, label: string, detail: string, hint: string): DoctorCheck => ({ id, label, status: "warn", detail, hint });
const fail = (id: string, label: string, detail: string, hint: string): DoctorCheck => ({ id, label, status: "fail", detail, hint });

function parseVersion(v: string): [number, number, number] {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(v);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : [0, 0, 0];
}

/** The oldest Bun this tree is known to run on; the suite is exercised on 1.2.x. */
export const MIN_BUN = "1.1.0";

function checkBun(d: DoctorEnv): DoctorCheck {
  if (d.bunVersion === undefined) {
    return fail("bun", "bun", "not running under Bun", "run hzcode with Bun: install from https://bun.sh, then `bun run src/main.ts`");
  }
  const a = parseVersion(d.bunVersion);
  const b = parseVersion(MIN_BUN);
  const older = a[0] !== b[0] ? a[0] < b[0] : a[1] !== b[1] ? a[1] < b[1] : a[2] < b[2];
  return older
    ? warn("bun", "bun", `version ${d.bunVersion}`, `upgrade Bun to ${MIN_BUN} or newer (\`bun upgrade\`); the test suite runs on 1.2.x`)
    : ok("bun", "bun", `version ${d.bunVersion}`);
}

function checkKernel(d: DoctorEnv): DoctorCheck[] {
  const override = typeof d.env.HZ_KERNEL_BIN === "string" ? d.env.HZ_KERNEL_BIN.trim() : "";
  if (d.kernelBinary === undefined) {
    return [
      warn(
        "kernel.binary",
        "kernel binary",
        override !== "" ? `HZ_KERNEL_BIN points at ${override}, which does not exist` : "no hz-kernel binary found",
        override !== ""
          ? "fix or unset HZ_KERNEL_BIN"
          : "build it: cd kernel && cargo build --release --locked (without it the TypeScript fallback runs UNTRUSTED)",
      ),
      warn("kernel.mode", "kernel mode", "untrusted (TypeScript fallback kernel)", "build the Rust kernel to get trusted mode; the guard and receipts still run, but not behind the process boundary"),
    ];
  }
  const out: DoctorCheck[] = [ok("kernel.binary", "kernel binary", d.kernelBinary)];
  // The selftest needs a state dir; give it a throwaway one so no real state is touched.
  let scratch: string | undefined;
  try {
    scratch = mkdtempSync(path.join(tmpdir(), "hz-doctor-"));
    const r = d.run(d.kernelBinary, ["--selftest", "--state-dir", scratch], 20_000);
    const tail = (r.stdout.trim().split("\n").pop() ?? "").trim();
    if (r.ok) {
      out.push(ok("kernel.selftest", "kernel selftest", tail !== "" ? tail : "passed"));
      out.push(ok("kernel.mode", "kernel mode", "trusted (Rust kernel)"));
    } else {
      out.push(
        fail(
          "kernel.selftest",
          "kernel selftest",
          r.status === null ? `could not run: ${r.stderr.trim().split("\n")[0] ?? "unknown error"}` : `exit ${r.status}: ${(tail || r.stderr.trim().split("\n")[0]) ?? ""}`,
          "rebuild the kernel (cd kernel && cargo build --release --locked) and re-run `hzcode doctor`; if it still fails, attach this output to a bug report",
        ),
      );
      out.push(warn("kernel.mode", "kernel mode", "would fall back to untrusted", "fix the selftest failure above to get trusted mode"));
    }
  } catch (err) {
    out.push(fail("kernel.selftest", "kernel selftest", `could not run: ${err instanceof Error ? err.message : String(err)}`, "check that the temp directory is writable"));
  } finally {
    if (scratch !== undefined) rmSync(scratch, { recursive: true, force: true });
  }
  return out;
}

function checkConfig(d: DoctorEnv): DoctorCheck[] {
  const file = defaultConfigPath(d.home);
  const out: DoctorCheck[] = [];
  let raw: string | undefined;
  try {
    raw = readFileSync(file, "utf8");
  } catch {
    raw = undefined;
  }
  if (raw === undefined) {
    out.push(ok("config.file", "config file", `none at ${file} (defaults and environment apply)`));
  } else {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        out.push(fail("config.file", "config file", `${file} is not a JSON object`, "the config must be one JSON object, e.g. {\"provider\":\"anthropic\"}"));
      } else {
        out.push(ok("config.file", "config file", `${file} parses`));
        // An inline key readable by other users is worth a warning (never its value).
        const inlineKey = typeof (parsed as { apiKey?: unknown }).apiKey === "string" && (parsed as { apiKey: string }).apiKey.trim() !== "";
        if (inlineKey) {
          const mode = statSync(file).mode & 0o077;
          if (mode !== 0) out.push(warn("config.perms", "config file mode", `${file} holds an apiKey and is readable by other users`, `chmod 600 ${file}`));
        }
      }
    } catch (err) {
      out.push(fail("config.file", "config file", `${file} does not parse: ${err instanceof Error ? err.message : String(err)}`, "fix the JSON (a broken file is silently ignored at runtime, so your settings are NOT applied)"));
    }
  }
  return out;
}

function checkProvider(d: DoctorEnv): DoctorCheck[] {
  const out: DoctorCheck[] = [];
  const file = defaultConfigPath(d.home);
  const config = loadConfig(d.env, file);
  const where = config.sources.provider;
  if (config.permissionModeRejected !== undefined) {
    out.push(warn("config.permission_mode", "permission mode", "the config file's permissionMode was rejected", config.permissionModeRejected));
  }
  if (config.provider === "mock") {
    out.push(warn("provider", "provider", "mock (offline demo, no real model)", "set ANTHROPIC_API_KEY, OPENAI_API_KEY or GEMINI_API_KEY (or HZ_PROVIDER) to use a real model"));
  } else {
    out.push(ok("provider", "provider", `${config.provider} (from ${where})`));
  }
  const missing = missingKey(config);
  if (missing !== null) {
    out.push(fail("provider.key", "provider key", `${config.provider} needs a key and none is set`, `export ${missing}=... (the value is never printed by hzcode)`));
  } else if (config.provider === "mock" || config.provider === "ollama") {
    out.push(ok("provider.key", "provider key", "not required"));
  } else {
    out.push(ok("provider.key", "provider key", `present (source: ${config.sources.apiKey}; value not shown)`));
  }
  // Model resolution against the catalog.
  const catalog = loadCatalog(d.env);
  if (config.provider === "mock") {
    out.push(ok("model", "model", `${config.model} (mock)`));
  } else if (config.model === "") {
    out.push(fail("model", "model", "no model configured for this provider", "set HZ_MODEL or `model` in the config file"));
  } else {
    const entry = catalogModel(catalog, config.provider, config.model);
    out.push(
      entry !== undefined
        ? ok("model", "model", `${config.model} found in the ${catalog.source} catalog (context ${entry.limit.context})`)
        : warn("model", "model", `${config.model} is not in the ${catalog.source} catalog for ${config.provider}`, "check the spelling; a custom or new model still works, but its context window is a guess"),
    );
  }
  return out;
}

function modeOf(p: string): number | undefined {
  try {
    return statSync(p).mode & 0o777;
  } catch {
    return undefined;
  }
}

function checkWorkspace(d: DoctorEnv): DoctorCheck[] {
  const out: DoctorCheck[] = [];
  try {
    if (!statSync(d.workspace).isDirectory()) throw new Error("not a directory");
    // access(2) rather than a probe file: doctor writes nothing.
    accessSync(d.workspace, constants.W_OK);
    out.push(ok("workspace", "workspace", `${d.workspace} is writable`));
  } catch (err) {
    out.push(fail("workspace", "workspace", `${d.workspace}: ${err instanceof Error ? err.message : String(err)}`, "run from a writable folder or pass --workspace <path>"));
    return out;
  }
  const kdir = kernelStateDir(d.workspace);
  if (!existsSync(kdir)) {
    out.push(ok("state.perms", "state directory", `${kdir} not created yet (made private on first run)`));
    return out;
  }
  const bad: string[] = [];
  const dirMode = modeOf(kdir);
  if (dirMode !== undefined && (dirMode & 0o077) !== 0) bad.push(`${kdir} is ${dirMode.toString(8)}`);
  try {
    for (const name of readdirSync(kdir).slice(0, 50)) {
      const full = path.join(kdir, name);
      const m = modeOf(full);
      if (m !== undefined && statSync(full).isFile() && (m & 0o077) !== 0) bad.push(`${name} is ${m.toString(8)}`);
    }
  } catch {
    /* unreadable listing: the directory mode check above stands */
  }
  out.push(
    bad.length === 0
      ? ok("state.perms", "state directory", `${kdir} is private`)
      : warn("state.perms", "state directory", `readable by other users: ${bad.slice(0, 3).join(", ")}${bad.length > 3 ? ", ..." : ""}`, `chmod -R go-rwx ${kdir}`),
  );
  return out;
}

function checkGit(d: DoctorEnv): DoctorCheck {
  const r = d.run("git", ["--version"], 5_000);
  return r.ok
    ? ok("git", "git", r.stdout.trim())
    : warn("git", "git", "git not found on PATH", "install git; turn diffs, checkpoints and project detection work best inside a git repository");
}

function utf8Locale(env: EnvLike): boolean {
  for (const key of ["LC_ALL", "LC_CTYPE", "LANG"]) {
    const v = env[key];
    if (typeof v === "string" && v !== "") return /utf-?8/i.test(v);
  }
  return false;
}

function checkTerminal(d: DoctorEnv): DoctorCheck[] {
  const out: DoctorCheck[] = [];
  out.push(
    d.stdinIsTTY && d.stdoutIsTTY
      ? ok("term.tty", "terminal", "stdin and stdout are a TTY (the chat bar is available)")
      : warn("term.tty", "terminal", `stdin ${d.stdinIsTTY ? "is" : "is not"} a TTY, stdout ${d.stdoutIsTTY ? "is" : "is not"} a TTY`, "this is normal in scripts and CI; for the chat bar run hzcode in a real terminal"),
  );
  const noColor = typeof d.env.NO_COLOR === "string" && d.env.NO_COLOR !== "";
  const level = detectColorLevel(d.env as Record<string, string | undefined>, d.stdoutIsTTY);
  const names = ["none", "16 colours", "256 colours", "truecolor"];
  if (noColor) out.push(ok("term.color", "colour", "off (NO_COLOR is set)"));
  else if (d.env.TERM === "dumb") out.push(warn("term.color", "colour", "TERM=dumb: plain text only", "use a terminal that sets TERM to xterm-256color or similar"));
  else if (!d.stdoutIsTTY && level === 0) out.push(ok("term.color", "colour", "off (stdout is not a terminal)"));
  else if (level === 0) out.push(warn("term.color", "colour", "this terminal reports no colour", "set TERM=xterm-256color, or COLORTERM=truecolor if your terminal supports 24-bit colour"));
  else out.push(ok("term.color", "colour", names[level] ?? String(level)));
  out.push(
    utf8Locale(d.env)
      ? ok("term.utf8", "locale", "UTF-8")
      : warn("term.utf8", "locale", "no UTF-8 locale in LC_ALL, LC_CTYPE or LANG", "export LANG=en_US.UTF-8 (or C.UTF-8); otherwise box drawing and symbols may render as garbage"),
  );
  return out;
}

/** Run every check, in table order. Never throws: a check that blows up is reported as a FAIL line. */
export function runDoctor(d: DoctorEnv): DoctorCheck[] {
  const groups: Array<[string, () => DoctorCheck | DoctorCheck[]]> = [
    ["bun", () => checkBun(d)],
    ["kernel", () => checkKernel(d)],
    ["config", () => checkConfig(d)],
    ["provider", () => checkProvider(d)],
    ["workspace", () => checkWorkspace(d)],
    ["git", () => checkGit(d)],
    ["terminal", () => checkTerminal(d)],
  ];
  const out: DoctorCheck[] = [];
  for (const [name, fn] of groups) {
    try {
      const r = fn();
      out.push(...(Array.isArray(r) ? r : [r]));
    } catch (err) {
      out.push(fail(`${name}.error`, name, `the check itself failed: ${err instanceof Error ? err.message : String(err)}`, "re-run with a clean environment; if it persists, report it"));
    }
  }
  return out;
}

export function doctorExitCode(checks: readonly DoctorCheck[]): number {
  return checks.some((c) => c.status === "fail") ? 1 : 0;
}

const TAGS: Record<DoctorStatus, string> = { ok: "OK  ", warn: "WARN", fail: "FAIL" };

/** The human table: one line per check, a `fix:` line under every WARN and FAIL, then a summary. */
export function renderDoctor(checks: readonly DoctorCheck[]): string {
  const width = Math.max(...checks.map((c) => c.label.length), 0);
  const lines: string[] = ["hzcode doctor", ""];
  for (const c of checks) {
    lines.push(`[${TAGS[c.status]}] ${c.label.padEnd(width)}  ${c.detail}`);
    if (c.status !== "ok" && c.hint !== undefined) lines.push(`       ${" ".repeat(width)}  fix: ${c.hint}`);
  }
  const n = (s: DoctorStatus): number => checks.filter((c) => c.status === s).length;
  lines.push("", `${n("ok")} ok, ${n("warn")} warning(s), ${n("fail")} failure(s)`);
  return lines.join("\n");
}

/** The machine form, suitable for attaching to a support ticket. */
export function renderDoctorJson(checks: readonly DoctorCheck[]): string {
  const n = (s: DoctorStatus): number => checks.filter((c) => c.status === s).length;
  return JSON.stringify({ ok: doctorExitCode(checks) === 0, summary: { ok: n("ok"), warn: n("warn"), fail: n("fail") }, checks }, null, 2);
}
