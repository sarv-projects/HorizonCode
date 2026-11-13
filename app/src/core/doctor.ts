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
import { parseModelsPollIntervalMs } from "./catalog/catalog-poll";
import { docs30SkipBacklogCount } from "./docs30-skip-backlog";
import { readOAuthToken } from "./auth/store";
import { defaultConfigPath, loadConfig, missingKey, readConfigFile, type EnvLike } from "./config";
import { resolveKernelBinary, resolveSandboxExecBinary } from "./kernel";
import { kernelStateDir } from "./paths";
import { tuiFullscreenBlocksLabel } from "../tui/escape-writer";
import { resolveTuiScreenMode } from "../tui/screen-mode";
import { detectColorLevel } from "../tui/style";
import { egressProxyFromEnv } from "./egress-env";
import {
  effectHostDoctorFixLines,
  effectHostDoctorPosture,
  effectHostPrototypeHonestyDoctorHint,
} from "./effect-host-posture";
import { postimageReplayDoctorFixLines, postimageReplayDoctorPosture } from "./effect-postimage-replay";
import { applyEffectHostKernelFromUserConfig, applyEffectHostKernelSandboxDefault } from "./effect-host-runtime";
import { effectReconcileBlockDoctorHint } from "./effect-reconcile-block";
import { formatEffectReconcileProbeSummary, probeEffectReconcile } from "./effect-reconcile-probe";
import {
  formatTerminalProbeSummary,
  probeWorkspaceTerminalReadOnly,
} from "./effect-reconcile-probe-terminal";
import {
  captureTerminalRunCapabilitySnapshot,
  formatTerminalRunCapabilityDoctorLine,
} from "./receipt-run-terminal";
import { tlsMitmPosture } from "./egress-tls-mitm";
import { netnsConnectDenialPosture } from "./sandbox-netns-denial";
import {
  assessNetnsParentProxyReachability,
  assessNetnsSpawnRoutedProxyWiring,
} from "./sandbox-netns-proxy";
import {
  assessNetnsSpawnVethRoutedStackPosture,
  type NetnsSpawnVethRoutedPosture,
} from "./sandbox-netns-spawn-veth";
import {
  assessNetnsSpawnWrappedConnectPosture,
  type NetnsSpawnWrappedConnectPosture,
} from "./sandbox-netns-spawn-wrapped-connect";
import {
  assessNetnsSpawnWrappedExecCreateConnectPosture,
  type NetnsSpawnWrappedExecCreatePosture,
} from "./sandbox-netns-spawn-wrapped-exec-create-connect";
import {
  assessSandboxNetnsProductSpawnPosture,
  sandboxNetnsProductSpawnDoctorFixLines,
  type SandboxNetnsProductSpawnPosture,
} from "./sandbox-netns-spawn-product-default";
import {
  assessNetnsVethBridgePosture,
  assessNetnsVethRoutedConnectPosture,
  type NetnsVethBridgePosture,
} from "./sandbox-netns-veth";
import { netnsEgressRoutePosture } from "./sandbox-netns-route";
import {
  assessSandboxExecVethJoinPosture,
  assessSandboxExecVethJoinSpawnWiring,
  type SandboxExecVethJoinPosture,
} from "./sandbox-exec-veth-join";
import {
  assessSandboxExecVethCreatePosture,
  assessSandboxExecVethCreateSpawnWiring,
  type SandboxExecVethCreatePosture,
} from "./sandbox-exec-veth-create";
import { sandboxPlatformHonesty } from "./sandbox-platform-honesty";
import { jsonlFsyncEnabled } from "./jsonl-append";
import { workspaceMountPosture } from "./workspace-mount";
import { formatWorktreePoolLines, inspectWorktreePool, worktreePoolMaxFromEnv } from "./worktree-pool";
import { workspaceSnapshotHonesty } from "./workspace-snapshot";
import { parseAnthropicCacheKeepaliveMs } from "./providers/anthropic-cache-keepalive";

const REPO_ROOT = path.resolve(import.meta.dir, "../../..");
const LICENSE_STATUS_DOC = "docs/LICENSE-STATUS.md";

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

function checkCatalogSource(d: DoctorEnv): DoctorCheck {
  const loaded = loadCatalog(d.env, d.home);
  const detail =
    loaded.source === "cache"
      ? `user cache (${Object.keys(loaded.providers).length} providers)`
      : loaded.source === "override"
        ? "HZ_MODELS_SNAPSHOT override"
        : loaded.source === "snapshot"
          ? `committed models-dev.snapshot.json (${Object.keys(loaded.providers).length} providers)`
          : loaded.source === "curated"
            ? "committed curated snapshot"
            : loaded.source;
  return ok("catalog.source", "model catalog", `source: ${detail}`);
}

function anthropicCacheBreakpointsOn(env: EnvLike): boolean {
  const v = env.HZ_ANTHROPIC_CACHE_BREAKPOINTS;
  if (typeof v !== "string") return false;
  const t = v.trim().toLowerCase();
  return t === "1" || t === "true" || t === "on";
}

function checkAnthropicCache(d: DoctorEnv): DoctorCheck {
  const bp = anthropicCacheBreakpointsOn(d.env);
  const keep = parseAnthropicCacheKeepaliveMs(d.env);
  const system =
    typeof d.env.HZ_ANTHROPIC_CACHE_SYSTEM === "string" &&
    ["1", "true", "on"].includes(d.env.HZ_ANTHROPIC_CACHE_SYSTEM.trim().toLowerCase());
  const detail = [
    bp ? "breakpoints on (HZ_ANTHROPIC_CACHE_BREAKPOINTS)" : "breakpoints off",
    system ? "system block cache marker on" : "system block cache marker off",
    keep !== undefined ? `keep-alive stub every ${keep}ms` : "keep-alive off",
    "local prefix measure on keep-alive tick when provider=anthropic (no API cache-hit)",
  ].join("; ");
  return ok("provider.cache", "Anthropic cache layout (B-4)", detail);
}

function checkCatalogPoll(d: DoctorEnv): DoctorCheck {
  const ms = parseModelsPollIntervalMs(d.env);
  if (ms === undefined) {
    return ok(
      "catalog.poll",
      "models.dev background poll",
      "off by default (HZ_MODELS_POLL_MS ≥60000 enables; wired on createRuntime, stops on close — ruling 180)",
    );
  }
  return ok("catalog.poll", "models.dev background poll", `enabled every ${ms}ms (HZ_MODELS_POLL_MS; ruling 180)`);
}

function checkDocs30SkipBacklog(): DoctorCheck {
  const n = docs30SkipBacklogCount();
  return ok(
    "backlog.skip",
    "docs/30 SKIP backlog",
    `${n} explicit SKIP rows (Wave F + §8 list — not queued; see docs/MASTER-BACKLOG-ALL.md)`,
  );
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
  } else if (config.resolved?.credential.kind === "oauth") {
    out.push(ok("provider.key", "provider key", "oauth (value not shown)"));
  } else {
    out.push(ok("provider.key", "provider key", `present (source: ${config.sources.apiKey}; value not shown)`));
  }
  const oauth = checkOAuthToken(d, config);
  if (oauth !== undefined) out.push(oauth);
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

/** Reduced sandbox helper (docs/33 §5.3): report binary presence only — not enforcement. */
function checkSandboxExec(d: DoctorEnv): DoctorCheck {
  if (d.env.HZ_SANDBOX_EXEC === "0") {
    return ok("sandbox.exec", "hz-sandbox-exec", "disabled (HZ_SANDBOX_EXEC=0)");
  }
  const bin = resolveSandboxExecBinary(d.env);
  if (bin === undefined) {
    return warn(
      "sandbox.exec",
      "hz-sandbox-exec",
      "binary not found (shell auto-wrap inactive)",
      "build `hz-sandbox-exec` from kernel/ or set HZ_SANDBOX_EXEC_BIN; set HZ_SANDBOX_EXEC=1 to force wrap when the binary exists",
    );
  }
  return ok("sandbox.exec", "hz-sandbox-exec", `found (${bin}); optional shell child confinement when the kernel reports process enforced`);
}

/** Seatbelt / macOS child_net unavailable on Linux builds — never claim enforced. */
function checkSandboxPlatformHonesty(_d: DoctorEnv): DoctorCheck {
  const { detail } = sandboxPlatformHonesty();
  return warn(
    "sandbox.platform",
    "cross-platform OS sandbox",
    detail,
    "see sandbox.report platformNotes and docs/33 §5.3 — enforcement claims are Linux hz-sandbox-exec only when tested",
  );
}

/** Honest Landlock posture (docs/33 §5.3): host capability only — never `enforced`. */
function checkLandlockHost(d: DoctorEnv): DoctorCheck {
  try {
    const lsm = readFileSync("/sys/kernel/security/lsm", "utf8").toLowerCase();
    if (lsm.includes("landlock")) {
      return ok(
        "sandbox.landlock",
        "host Landlock LSM",
        "landlock in LSM list; hz-sandbox-exec applies a workspace FS fence (HZ_SANDBOX_FS_ROOT)",
      );
    }
    return ok("sandbox.landlock", "host Landlock LSM", "landlock not named in LSM list (see ops/landlock-probe.sh canary)");
  } catch {
    return warn(
      "sandbox.landlock",
      "host Landlock LSM",
      "LSM list unreadable (common on WSL); hz-sandbox-exec still applies Landlock when the create canary works",
      "run sh ops/landlock-probe.sh — exit 0 means Landlock is usable; docs/33 §5.3",
    );
  }
}

/** Shell children bypass net.fetch; warn unless outer confinement is explicit (docs/33 §5.2). */
function checkShellEgressHonesty(d: DoctorEnv): DoctorCheck {
  const sandboxOff = d.env.HZ_SANDBOX_EXEC === "0";
  const proxy = egressProxyFromEnv(d.env);
  if (sandboxOff) {
    return warn(
      "egress.shell",
      "shell network",
      "HZ_SANDBOX_EXEC=0 — shell children use ambient egress (net.fetch decider does not apply to curl/wget in shell)",
      "enable hz-sandbox-exec for netns confinement; egress proxy enforcement still needs MITM stage 1 + denial tests",
    );
  }
  const detail =
    proxy !== undefined
      ? "shell children use ambient egress (HZ_EGRESS_PROXY sets child proxy env only; unverified)"
      : "shell children use ambient egress (only net.fetch is decided; curl in shell is unconstrained)";
  return warn(
    "egress.shell",
    "shell network",
    detail,
    "MITM proxy + netns denial tests are required before any egress confinement claim (docs/33 §5.2); set HZ_EGRESS_PROXY for optional child proxy env",
  );
}

/** Netns CONNECT/TCP denial — partial only; never shell-net enforced (docs/33 §5.2). */
function checkEgressNetnsPartial(d: DoctorEnv): DoctorCheck {
  const posture = netnsConnectDenialPosture(d.env as Record<string, string | undefined>);
  if (posture.honesty === "off") {
    return warn(
      "egress.netns",
      "netns TCP deny",
      posture.detail,
      "build or set HZ_SANDBOX_EXEC_BIN to hz-sandbox-exec; HZ_SANDBOX_CHILD_NET=off for explicit network-off",
    );
  }
  return warn(
    "egress.netns",
    "netns TCP deny",
    posture.detail,
    "routed proxy-only netns egress and TLS MITM still open; see egress.shell / egress.proxy / egress.netns.route",
  );
}

/** Netns child can reach parent-loopback CONNECT proxy (ruling **289**; spawn wire **317**). */
function checkEgressNetnsProxyReach(d: DoctorEnv): DoctorCheck {
  const env = d.env as Record<string, string | undefined>;
  const reach = assessNetnsParentProxyReachability(env);
  const spawnWire = assessNetnsSpawnRoutedProxyWiring(env);
  const spawnSuffix =
    spawnWire.wired || spawnWire.detail.includes("HZ_EGRESS_NETNS_PROXY")
      ? `; ${spawnWire.detail}`
      : "";
  if (reach.kind === "not-applicable") {
    return warn(
      "egress.netns.proxy",
      "netns proxy reach",
      reach.detail,
      "set HZ_SANDBOX_EXEC=1 with default child net off to enable netns isolation probe",
    );
  }
  if (reach.kind === "no-proxy-configured") {
    return warn(
      "egress.netns.proxy",
      "netns proxy reach",
      reach.detail,
      "for routed egress set HZ_EGRESS_NETNS_PROXY=1 and HZ_EGRESS_NETNS_PROXY_ENDPOINT to a TCP-reachable host",
    );
  }
  if (reach.kind === "parent-loopback-blocked") {
    return warn(
      "egress.netns.proxy",
      "netns proxy reach",
      `parent-loopback blocked — ${reach.detail}${spawnSuffix}`,
      "set HZ_EGRESS_NETNS_PROXY=1 + HZ_EGRESS_NETNS_PROXY_ENDPOINT, or HZ_EGRESS_NETNS_PROXY_ROUTED=1 + HZ_EGRESS_NETNS_BRIDGE_HOST — spawn wiring advisory only; never claim enforced",
    );
  }
  return warn(
    "egress.netns.proxy",
    "netns proxy reach",
    `${reach.detail}${spawnSuffix}`,
    "hermetic veth/bridge route not proven on this host; CONNECT MITM still advisory only — never claim shell-net enforced",
  );
}

/** Netns egress route: ambient vs deny-only vs proxy-env partial (ruling **288**). */
function checkEgressNetnsRoute(d: DoctorEnv): DoctorCheck {
  const posture = netnsEgressRoutePosture(d.env as Record<string, string | undefined>);
  const label =
    posture.route === "ambient"
      ? "ambient"
      : posture.route === "deny-only"
        ? "netns deny-only"
        : "proxy-routed partial";
  if (posture.route === "ambient") {
    return warn(
      "egress.netns.route",
      "netns egress route",
      `${label} — ${posture.detail}`,
      "set HZ_SANDBOX_EXEC=1 + HZ_SANDBOX_NETNS=1 or default child net off for netns TCP deny; HZ_EGRESS_PROXY is advisory only",
    );
  }
  return warn(
    "egress.netns.route",
    "netns egress route",
    `${label} — ${posture.detail}`,
    "true routed proxy-only netns egress (parent-loopback reachability) still open; never claim shell-net enforced",
  );
}

/** Host `terminal.run` capability snapshot (cols/rows/tty; ruling **298**). */
function checkTerminalRunCapability(d: DoctorEnv): DoctorCheck {
  const snap = captureTerminalRunCapabilitySnapshot({
    cols: d.stdoutIsTTY ? undefined : 80,
    rows: d.stdoutIsTTY ? undefined : 24,
    stdinIsTTY: d.stdinIsTTY,
    stdoutIsTTY: d.stdoutIsTTY,
  });
  const detail = formatTerminalRunCapabilityDoctorLine(snap);
  if (!d.stdinIsTTY && !d.stdoutIsTTY) {
    return warn(
      "terminal.run",
      "terminal.run capability",
      detail,
      "non-TTY host: geometry is nominal; RC-7 run snapshot still recorded on run.complete",
    );
  }
  return ok("terminal.run", "terminal.run capability", `${detail} (ruling **298**)`);
}

/** Allow-listed argv-only workspace terminal probes (docs/06; ruling **292**). */
function checkTerminalStateProbe(d: DoctorEnv): DoctorCheck {
  try {
    const snap = probeWorkspaceTerminalReadOnly(d.workspace, {
      run: (argv, cwd) => {
        const refused = argv.some((p) => p.includes("\0"));
        if (refused) {
          return { ok: false, exitCode: null, stdout: "", stderr: "refused" };
        }
        const r = d.run(argv[0] ?? "", [...argv.slice(1)], 8_000);
        return { ok: r.ok, exitCode: r.status, stdout: r.stdout, stderr: r.stderr };
      },
    });
    const detail = formatTerminalProbeSummary(snap);
    const anyRefused = snap.probes.some((p) => p.refused);
    if (anyRefused) {
      return fail(
        "terminal.state",
        "terminal.state probe",
        detail,
        "probe argv must match READ_ONLY_PROBE_ARGV_ALLOWLIST exactly (fail-closed)",
      );
    }
    const failed = snap.probes.filter((p) => !p.ok);
    if (failed.length > 0) {
      return warn(
        "terminal.state",
        "terminal.state probe",
        `${detail} — ${failed.map((p) => p.argv.join(" ")).join(", ")} failed`,
        "read-only workspace observation only; never shell-net enforcement",
      );
    }
    return ok(
      "terminal.state",
      "terminal.state probe",
      `${detail} (docs/06 allow-list; ruling **292**)`,
    );
  } catch (err) {
    return warn(
      "terminal.state",
      "terminal.state probe",
      `probe failed: ${err instanceof Error ? err.message : String(err)}`,
      "check workspace cwd is readable",
    );
  }
}

/** Read-only durable ledger vs kernel reconcile probe (docs/06; ruling **286**). */
/** Independent receipt postimage replay — off by default; require-mode auto-on at verify (**301**). */
function checkEffectPostimageReplay(d: DoctorEnv): DoctorCheck {
  const posture = postimageReplayDoctorPosture(d.env as Record<string, string | undefined>);
  if (posture.active) {
    return warn(
      "effect.postimage.replay",
      "Postimage digest replay at verify",
      posture.detail,
      `${posture.hint}; run hzcode doctor --fix effect.postimage.replay for export lines`,
    );
  }
  return warn(
    "effect.postimage.replay",
    "Postimage digest replay at verify",
    posture.detail,
    `${posture.hint}; run hzcode doctor --fix effect.postimage.replay for export lines`,
  );
}

function checkEffectReconcileProbe(d: DoctorEnv): DoctorCheck {
  try {
    const report = probeEffectReconcile(d.workspace);
    const detail = formatEffectReconcileProbeSummary(report);
    const blockHint = effectReconcileBlockDoctorHint(d.env as Record<string, string | undefined>);
    if (report.mismatches.length > 0) {
      return warn(
        "effect.reconcile",
        "EffectHost reconcile probe",
        detail,
        `${blockHint}; run /unknown reconcile --probe in-session; /unknown reconcile mutates ledger — probe does not`,
      );
    }
    return ok(
      "effect.reconcile",
      "EffectHost reconcile probe",
      `${detail} (read-only; docs/06 fs/vcs/terminal probe on mismatch — **290**/**292**); ${blockHint}`,
    );
  } catch (err) {
    return warn(
      "effect.reconcile",
      "EffectHost reconcile probe",
      `probe failed: ${err instanceof Error ? err.message : String(err)}`,
      "check .hz/state/effects.jsonl readability",
    );
  }
}

/** EffectHost kernel mutation route - report the same user-config precedence as createRuntime. */
function checkEffectHostKernel(d: DoctorEnv): DoctorCheck {
  const env = { ...d.env } as Record<string, string | undefined>;
  const configured = applyEffectHostKernelFromUserConfig(readConfigFile(defaultConfigPath(d.home)), env);
  // The runtime can additionally enable =default after kernel startup. Doctor
  // cannot certify the kernel capability here, so only project explicit Linux
  // sandbox wrapping, and label that projection provisional.
  const sandbox = applyEffectHostKernelSandboxDefault(env, false);
  const source = configured.applied === "config"
    ? "effective mode from user config (env unset)"
    : sandbox.applied === "sandbox-default"
      ? "projected Linux sandbox-wrap default (kernel capability not probed)"
      : "effective mode from environment/default";
  const posture = effectHostDoctorPosture(env);
  const detail = `${posture.detail}; ${source}`;
  const prototypeHint = effectHostPrototypeHonestyDoctorHint(env);
  const fixSuffix = "; run hzcode doctor --fix effect.host for export lines";
  const hintForOffOrOptIn =
    prototypeHint && posture.mode !== "default"
      ? `${posture.hint}; ${prototypeHint}${fixSuffix}`
      : `${posture.hint}${fixSuffix}`;
  if (posture.mode === "require") {
    return warn("effect.host", "EffectHost kernel route", detail, posture.hint);
  }
  if (posture.mode === "default") {
    return warn("effect.host", "EffectHost kernel route", detail, `${posture.hint}${fixSuffix}`);
  }
  return warn("effect.host", "EffectHost kernel route", detail, hintForOffOrOptIn);
}

/** Netns veth/bridge parent-proxy reach — capability probe only at doctor time (ruling **299**). */
function checkEgressNetnsVeth(d: DoctorEnv): DoctorCheck {
  const posture = assessNetnsVethBridgePosture(d.env as Record<string, string | undefined>, d.run);
  return formatNetnsVethDoctorCheck(posture);
}

/** Routed CONNECT on parent bridge IP — hermetic suite only; ruling **315**. */
function checkEgressNetnsVethRouted(d: DoctorEnv): DoctorCheck {
  const posture = assessNetnsVethRoutedConnectPosture(d.env as Record<string, string | undefined>, d.run);
  return formatNetnsVethRoutedDoctorCheck(posture);
}

/** spawnOwned ROUTED child proxy + veth bridge stack — ruling **319** (alongside hz-sandbox-exec). */
function checkEgressNetnsSpawnVethRouted(d: DoctorEnv): DoctorCheck {
  const posture = assessNetnsSpawnVethRoutedStackPosture(d.env as Record<string, string | undefined>, d.run);
  return formatNetnsSpawnVethRoutedDoctorCheck(posture);
}

/** spawnOwned-wrapped hz-sandbox-exec CONNECT via bridge proxy — ruling **321** (hermetic child_net=on only). */
function checkEgressNetnsSpawnWrapped(d: DoctorEnv): DoctorCheck {
  const posture = assessNetnsSpawnWrappedConnectPosture(d.env as Record<string, string | undefined>, d.run);
  return formatNetnsSpawnWrappedDoctorCheck(posture);
}

function formatNetnsSpawnWrappedExecCreateDoctorCheck(
  posture: NetnsSpawnWrappedExecCreatePosture,
): DoctorCheck {
  if (posture.kind === "not-applicable") {
    return warn(
      "egress.netns.spawn.wrapped.exec_create",
      "spawnOwned in-wrapper CREATE CONNECT",
      posture.detail,
      "set HZ_SANDBOX_EXEC=1 + HZ_SANDBOX_NETNS=1 + HZ_EGRESS_NETNS_PROXY_ROUTED=1 + HZ_SANDBOX_VETH_CREATE=1",
    );
  }
  if (posture.kind === "stack-unwired") {
    return warn(
      "egress.netns.spawn.wrapped.exec_create",
      "spawnOwned in-wrapper CREATE CONNECT",
      `${posture.detail} — never claim enforced`,
      "wire ROUTED bridge HTTP_PROXY first; see egress.netns.spawn.routed",
    );
  }
  if (posture.kind === "create-unwired") {
    return warn(
      "egress.netns.spawn.wrapped.exec_create",
      "spawnOwned in-wrapper CREATE CONNECT",
      `${posture.detail} — never claim enforced`,
      "set HZ_SANDBOX_VETH_CREATE=1 + HOST/PEER_ADDR + DEFAULT_ROUTE on wrapped spawn; ops/netns-spawn-wrapped-exec-create-connect-probe.sh",
    );
  }
  if (posture.kind === "cap-net-admin-missing") {
    return warn(
      "egress.netns.spawn.wrapped.exec_create",
      "spawnOwned in-wrapper CREATE CONNECT",
      `${posture.detail} — never claim enforced`,
      "run probe when CAP_NET_ADMIN present; parent plumb path remains egress.netns.spawn.wrapped",
    );
  }
  if (posture.kind === "nsenter-missing") {
    return warn(
      "egress.netns.spawn.wrapped.exec_create",
      "spawnOwned in-wrapper CREATE CONNECT",
      `${posture.detail} — never claim enforced`,
      "install util-linux nsenter for peer ADDR plumb; ops/netns-spawn-wrapped-exec-create-connect-probe.sh",
    );
  }
  if (posture.kind === "hermetic-exec-create-ok") {
    return warn(
      "egress.netns.spawn.wrapped.exec_create",
      "spawnOwned in-wrapper CREATE CONNECT",
      `${posture.detail} — hermetic suite only; never claim enforced`,
      "ops/netns-spawn-wrapped-exec-create-connect-probe.sh; production routed netns-only egress still open",
    );
  }
  return warn(
    "egress.netns.spawn.wrapped.exec_create",
    "spawnOwned in-wrapper CREATE CONNECT",
    `${posture.detail} — never claim enforced`,
    "run hermetic sandbox-netns-spawn-wrapped-exec-create-connect tests; ops/netns-spawn-wrapped-exec-create-connect-probe.sh",
  );
}

function checkEgressNetnsSpawnWrappedExecCreate(d: DoctorEnv): DoctorCheck {
  const posture = assessNetnsSpawnWrappedExecCreateConnectPosture(
    d.env as Record<string, string | undefined>,
    d.run,
  );
  return formatNetnsSpawnWrappedExecCreateDoctorCheck(posture);
}

function formatSandboxNetnsProductSpawnDoctorCheck(posture: SandboxNetnsProductSpawnPosture): DoctorCheck {
  const fixHint = "run hzcode doctor --fix egress.netns.spawn.product for export lines";
  if (posture.kind === "not-applicable") {
    return warn(
      "egress.netns.spawn.product",
      "spawnOwned product netns routing",
      posture.detail,
      `set HZ_SANDBOX_EXEC=1 + HZ_SANDBOX_NETNS_SPAWN_ROUTED=1; ${fixHint}`,
    );
  }
  if (posture.kind === "product-off-default") {
    return warn(
      "egress.netns.spawn.product",
      "spawnOwned product netns routing",
      `${posture.detail} — never claim enforced`,
      fixHint,
    );
  }
  if (posture.kind === "stack-partial") {
    return warn(
      "egress.netns.spawn.product",
      "spawnOwned product netns routing",
      `${posture.detail}`,
      fixHint,
    );
  }
  return warn(
    "egress.netns.spawn.product",
    "spawnOwned product netns routing",
    `${posture.detail}`,
    `${fixHint}; hermetic probes: egress.netns.spawn.wrapped / egress.netns.spawn.wrapped.exec_create`,
  );
}

function checkEgressNetnsSpawnProductDefault(d: DoctorEnv): DoctorCheck {
  return formatSandboxNetnsProductSpawnDoctorCheck(
    assessSandboxNetnsProductSpawnPosture(d.env as Record<string, string | undefined>),
  );
}

function formatNetnsSpawnVethRoutedDoctorCheck(posture: NetnsSpawnVethRoutedPosture): DoctorCheck {
  if (posture.kind === "not-applicable") {
    return warn(
      "egress.netns.spawn.routed",
      "spawn ROUTED + veth stack",
      posture.detail,
      "set HZ_SANDBOX_EXEC=1 + HZ_SANDBOX_NETNS=1 + HZ_EGRESS_NETNS_PROXY_ROUTED=1 + HZ_EGRESS_NETNS_BRIDGE_HOST",
    );
  }
  if (posture.kind === "stack-unwired") {
    return warn(
      "egress.netns.spawn.routed",
      "spawn ROUTED + veth stack",
      `${posture.detail} — never claim enforced`,
      "wire HZ_EGRESS_NETNS_PROXY_ROUTED + bridge host before veth stack; see egress.netns.proxy",
    );
  }
  if (posture.kind === "cap-net-admin-missing") {
    return warn(
      "egress.netns.spawn.routed",
      "spawn ROUTED + veth stack",
      `${posture.detail} — never claim enforced`,
      "veth inside hz-sandbox-exec still open; run ops/netns-spawn-routed-veth-probe.sh when CAP_NET_ADMIN present — never claim enforced",
    );
  }
  if (posture.kind === "hermetic-stack-ok") {
    return warn(
      "egress.netns.spawn.routed",
      "spawn ROUTED + veth stack",
      `${posture.detail} — hermetic suite only; never claim enforced`,
      "see egress.netns.spawn.wrapped for product-runtime CONNECT probe; in-wrapper veth still open",
    );
  }
  return warn(
    "egress.netns.spawn.routed",
    "spawn ROUTED + veth stack",
    `${posture.detail} — never claim enforced`,
    "run hermetic sandbox-netns-spawn-veth tests; ops/netns-spawn-routed-veth-probe.sh exercises ROUTED env + veth",
  );
}

function formatSandboxExecVethJoinDoctorCheck(posture: SandboxExecVethJoinPosture): DoctorCheck {
  if (posture.kind === "not-applicable") {
    return warn(
      "egress.netns.exec.veth_join",
      "hz-sandbox-exec veth join",
      posture.detail,
      "set HZ_SANDBOX_EXEC=1 + HZ_SANDBOX_NETNS=1 to assess in-wrapper netns join",
    );
  }
  if (posture.kind === "join-off-default") {
    return warn(
      "egress.netns.exec.veth_join",
      "hz-sandbox-exec veth join",
      `${posture.detail} — never claim enforced`,
      "parent prepares netns + veth; set HZ_SANDBOX_VETH_JOIN=1 + HZ_SANDBOX_VETH_NETNS on wrapped spawn",
    );
  }
  if (posture.kind === "join-unconfigured") {
    return warn(
      "egress.netns.exec.veth_join",
      "hz-sandbox-exec veth join",
      `${posture.detail} — never claim enforced`,
      "set HZ_SANDBOX_VETH_NETNS to parent-prepared path or name under /var/run/netns",
    );
  }
  if (posture.kind === "cap-net-admin-missing") {
    return warn(
      "egress.netns.exec.veth_join",
      "hz-sandbox-exec veth join",
      `${posture.detail} — never claim enforced`,
      "run ops/netns-exec-veth-join-probe.sh when CAP_NET_ADMIN present; veth plumb still parent-side",
    );
  }
  const env = {
    HZ_SANDBOX_VETH_JOIN: "1",
    HZ_SANDBOX_VETH_NETNS: "hz-veth-reach-ns",
  } as Record<string, string | undefined>;
  const wire = assessSandboxExecVethJoinSpawnWiring(env, { sandboxWrapped: true });
  return warn(
    "egress.netns.exec.veth_join",
    "hz-sandbox-exec veth join",
    `${posture.detail} — advisory only; never claim enforced`,
    wire.wired
      ? "spawnOwned passes HZ_SANDBOX_VETH_* on wrapped children (**325**); parent must plumb veth; ops/netns-exec-veth-join-probe.sh"
      : "set HZ_SANDBOX_VETH_JOIN=1 + HZ_SANDBOX_VETH_NETNS (or NETNS_AUTO=1) on wrapped spawn; ops/netns-exec-veth-join-probe.sh",
  );
}

function checkSandboxExecVethJoin(d: DoctorEnv): DoctorCheck {
  const posture = assessSandboxExecVethJoinPosture(d.env as Record<string, string | undefined>, d.run);
  return formatSandboxExecVethJoinDoctorCheck(posture);
}

function formatSandboxExecVethCreateDoctorCheck(posture: SandboxExecVethCreatePosture): DoctorCheck {
  if (posture.kind === "not-applicable") {
    return warn(
      "egress.netns.exec.veth_create",
      "hz-sandbox-exec veth create",
      posture.detail,
      "set HZ_SANDBOX_EXEC=1 + HZ_SANDBOX_NETNS=1 to assess in-wrapper veth create",
    );
  }
  if (posture.kind === "create-off-default") {
    return warn(
      "egress.netns.exec.veth_create",
      "hz-sandbox-exec veth create",
      `${posture.detail} — never claim enforced`,
      "opt-in HZ_SANDBOX_VETH_CREATE=1 on wrapped child when parent-side plumb is insufficient",
    );
  }
  if (posture.kind === "addr-without-create") {
    return warn(
      "egress.netns.exec.veth_create",
      "hz-sandbox-exec veth create",
      `${posture.detail} — never claim enforced`,
      "set HZ_SANDBOX_VETH_CREATE=1 before ADDR/route env; ops/netns-exec-veth-create-probe.sh",
    );
  }
  if (posture.kind === "create-mutually-exclusive") {
    return warn(
      "egress.netns.exec.veth_create",
      "hz-sandbox-exec veth create",
      `${posture.detail} — never claim enforced`,
      "unset HZ_SANDBOX_VETH_JOIN when using in-wrapper create",
    );
  }
  if (posture.kind === "cap-net-admin-missing") {
    return warn(
      "egress.netns.exec.veth_create",
      "hz-sandbox-exec veth create",
      `${posture.detail} — never claim enforced`,
      "run ops/netns-exec-veth-create-probe.sh when CAP_NET_ADMIN present; prefer parent veth plumb otherwise",
    );
  }
  const env = {
    HZ_SANDBOX_VETH_CREATE: "1",
    HZ_SANDBOX_VETH_HOST: "hz-exec-veth-create-h",
    HZ_SANDBOX_VETH_PEER: "hz-exec-veth-create-p",
  } as Record<string, string | undefined>;
  const wire = assessSandboxExecVethCreateSpawnWiring(env, { sandboxWrapped: true });
  return warn(
    "egress.netns.exec.veth_create",
    "hz-sandbox-exec veth create",
    `${posture.detail} — advisory only; never claim enforced`,
    wire.wired
      ? "spawnOwned passes HZ_SANDBOX_VETH_CREATE (+ optional HOST/PEER) on wrapped children (**330**); ops/netns-exec-veth-create-probe.sh"
      : "set HZ_SANDBOX_VETH_CREATE=1 on wrapped spawn (not with JOIN); ops/netns-exec-veth-create-probe.sh",
  );
}

function checkSandboxExecVethCreate(d: DoctorEnv): DoctorCheck {
  const posture = assessSandboxExecVethCreatePosture(d.env as Record<string, string | undefined>, d.run);
  return formatSandboxExecVethCreateDoctorCheck(posture);
}

function formatNetnsSpawnWrappedDoctorCheck(posture: NetnsSpawnWrappedConnectPosture): DoctorCheck {
  if (posture.kind === "not-applicable") {
    return warn(
      "egress.netns.spawn.wrapped",
      "spawnOwned wrapped CONNECT",
      posture.detail,
      "set HZ_SANDBOX_EXEC=1 + HZ_SANDBOX_NETNS=1 + HZ_EGRESS_NETNS_PROXY_ROUTED=1 + parent veth plumbing",
    );
  }
  if (posture.kind === "stack-unwired") {
    return warn(
      "egress.netns.spawn.wrapped",
      "spawnOwned wrapped CONNECT",
      `${posture.detail} — never claim enforced`,
      "wire spawn ROUTED bridge HTTP_PROXY before wrapped CONNECT probe; see egress.netns.spawn.routed",
    );
  }
  if (posture.kind === "cap-net-admin-missing") {
    return warn(
      "egress.netns.spawn.wrapped",
      "spawnOwned wrapped CONNECT",
      `${posture.detail} — never claim enforced`,
      "run ops/netns-spawn-wrapped-connect-probe.sh when CAP_NET_ADMIN present; see egress.netns.spawn.wrapped.exec_create for in-wrapper CREATE",
    );
  }
  if (posture.kind === "hermetic-production-join-ok") {
    return warn(
      "egress.netns.spawn.wrapped",
      "spawnOwned wrapped CONNECT",
      `${posture.detail} — never claim enforced`,
      "hermetic **326** production child_net=off CONNECT after veth join proven; ops/netns-spawn-wrapped-connect-probe.sh; in-wrapper CREATE CONNECT: egress.netns.spawn.wrapped.exec_create (**332**)",
    );
  }
  if (posture.kind === "hermetic-wrapped-ok") {
    return warn(
      "egress.netns.spawn.wrapped",
      "spawnOwned wrapped CONNECT",
      `${posture.detail} — never claim enforced`,
      "run hermetic sandbox-netns-spawn-wrapped-connect tests; ops/netns-spawn-wrapped-connect-probe.sh",
    );
  }
  return warn(
    "egress.netns.spawn.wrapped",
    "spawnOwned wrapped CONNECT",
    `${posture.detail} — never claim enforced`,
    "run hermetic sandbox-netns-spawn-wrapped-connect tests; ops/netns-spawn-wrapped-connect-probe.sh",
  );
}

function formatNetnsVethDoctorCheck(posture: NetnsVethBridgePosture): DoctorCheck {
  if (posture.kind === "not-applicable") {
    return warn(
      "egress.netns.veth",
      "netns veth bridge",
      posture.detail,
      "set HZ_SANDBOX_EXEC=1 + HZ_SANDBOX_NETNS=1 to assess veth/bridge proxy reach",
    );
  }
  if (posture.kind === "cap-net-admin-missing") {
    return warn(
      "egress.netns.veth",
      "netns veth bridge",
      posture.detail,
      "veth/bridge parent CONNECT reach not available without CAP_NET_ADMIN — never claim shell-net enforced",
    );
  }
  if (posture.kind === "hermetic-reach-ok") {
    return warn(
      "egress.netns.veth",
      "netns veth bridge",
      `${posture.detail} — hermetic probe passed on this host; still advisory only`,
      "production routed netns egress not shipped; see egress.netns.proxy",
    );
  }
  return warn(
    "egress.netns.veth",
    "netns veth bridge",
    posture.detail,
    "veth/bridge to parent CONNECT proxy not proven; HZ_EGRESS_NETNS_PROXY_ENDPOINT workaround — never claim enforced",
  );
}

function formatNetnsVethRoutedDoctorCheck(posture: NetnsVethBridgePosture): DoctorCheck {
  if (posture.kind === "not-applicable") {
    return warn(
      "egress.netns.veth.routed",
      "netns veth routed CONNECT",
      posture.detail,
      "set HZ_SANDBOX_EXEC=1 + HZ_SANDBOX_NETNS=1; hermetic test proves bridge-IP proxy path when CAP_NET_ADMIN present",
    );
  }
  if (posture.kind === "cap-net-admin-missing" || !posture.capNetAdmin) {
    return warn(
      "egress.netns.veth.routed",
      "netns veth routed CONNECT",
      posture.detail,
      "CAP_NET_ADMIN gap — doctor does not run live veth CONNECT; never claim shell-net or routed egress enforced",
    );
  }
  if (posture.kind === "hermetic-routed-connect-ok") {
    return warn(
      "egress.netns.veth.routed",
      "netns veth routed CONNECT",
      `${posture.detail} — hermetic only; spawn+veth stack is partial (**319**)`,
      "see egress.netns.spawn.routed; veth inside hz-sandbox-exec still open — never claim shell-net enforced",
    );
  }
  return warn(
    "egress.netns.veth.routed",
    "netns veth routed CONNECT",
    posture.detail,
    "run hermetic sandbox-netns-veth tests when CAP_NET_ADMIN available; never claim enforced",
  );
}

/** TLS MITM — unavailable/advisory only; never claim enforced (docs/33 §5.2). */
function checkEgressTlsMitm(d: DoctorEnv): DoctorCheck {
  const posture = tlsMitmPosture(d.env as Record<string, string | undefined>);
  const hint =
    posture.honesty === "advisory"
      ? posture.tlsPeek
        ? posture.tlsIntercept
          ? "peek-only SNI logging (not decryption); HZ_EGRESS_TLS_INTERCEPT requires CA for hermetic stub — never enforced"
          : "SNI peek logs ClientHello hostnames only (not decryption); true TLS intercept and routed netns-only egress remain open"
        : posture.tlsIntercept
          ? "intercept stub flagged: needs HZ_EGRESS_TLS_INTERCEPT_CA for hermetic tests; CONNECT forward is passthrough only"
          : "CONNECT forward is TCP passthrough only; optional HZ_EGRESS_TLS_PEEK=1 for SNI peek (not intercept); MITM residual open"
      : posture.tlsIntercept
        ? "HZ_EGRESS_TLS_INTERCEPT without forward: stub unavailable; do not claim shell TLS inspection"
        : "do not claim shell TLS inspection; HZ_EGRESS_FORWARD=1 forwards bytes without terminating TLS";
  return warn("egress.tls", "TLS intercept", posture.detail, hint);
}

/** HZ_EGRESS_PROXY wiring — transport hint only, never enforcement. */
function checkEgressProxyEnv(d: DoctorEnv): DoctorCheck {
  const raw = d.env.HZ_EGRESS_PROXY;
  if (typeof raw !== "string" || raw.trim() === "" || raw === "0" || raw === "false") {
    return ok(
      "egress.proxy",
      "child HTTP proxy",
      "HZ_EGRESS_PROXY unset (spawnOwned does not inject HTTP_PROXY/HTTPS_PROXY)",
    );
  }
  const proxy = egressProxyFromEnv(d.env);
  if (proxy === undefined) {
    return warn(
      "egress.proxy",
      "child HTTP proxy",
      `HZ_EGRESS_PROXY is set but not parseable (${raw.trim()})`,
      "use http://host:port or host:port; confinement still unproven without denial tests",
    );
  }
  return ok(
    "egress.proxy",
    "child HTTP proxy",
    `HZ_EGRESS_PROXY → ${proxy} (HTTP_PROXY/HTTPS_PROXY on children; advisory routing only)`,
  );
}

/** Stage 0 (docs/33 §5.2): report outer egress firewall marker only — never claim enforcement. */
function checkOuterEgressFirewall(d: DoctorEnv): DoctorCheck {
  const marker = d.env.HZ_OUTER_EGRESS_FIREWALL;
  if (typeof marker === "string" && marker !== "" && marker !== "0" && marker !== "false") {
    return ok(
      "egress.outer",
      "outer egress firewall",
      "HZ_OUTER_EGRESS_FIREWALL is set (outer layer; unverifiable from inside and does not confine shell children)",
    );
  }
  return warn(
    "egress.outer",
    "outer egress firewall",
    "no HZ_OUTER_EGRESS_FIREWALL marker",
    "use the container/devcontainer egress recipe (docs/33 §5.2 stage 0) if you rely on an outer firewall; shell children still reach the network unless HZ_SANDBOX_EXEC=1",
  );
}

function checkOAuthToken(d: DoctorEnv, config: ReturnType<typeof loadConfig>): DoctorCheck | undefined {
  const id = config.provider;
  if (id === "mock" || id === "ollama") return undefined;
  const tok = readOAuthToken(id, d.home);
  const usesOAuth = config.resolved?.credential.kind === "oauth";
  if (!usesOAuth && tok === undefined) return undefined;
  if (tok === undefined) {
    return fail(
      "provider.oauth",
      "oauth token",
      `provider ${id} expects OAuth but no token file is stored`,
      "run hzcode login when the PKCE flow is configured, or store a dev token under the user oauth directory",
    );
  }
  const exp = tok.expiresAt ? Date.parse(tok.expiresAt) : Number.NaN;
  if (!Number.isNaN(exp) && exp < Date.now()) {
    return warn("provider.oauth", "oauth token", "stored token is expired", "refresh or re-login when token refresh is wired");
  }
  const detail = tok.expiresAt ? `present (expires ${tok.expiresAt}; value not shown)` : "present (value not shown)";
  return ok("provider.oauth", "oauth token", detail);
}

function checkGit(d: DoctorEnv): DoctorCheck {
  const r = d.run("git", ["--version"], 5_000);
  return r.ok
    ? ok("git", "git", r.stdout.trim())
    : warn("git", "git", "git not found on PATH", "install git; turn diffs, checkpoints and project detection work best inside a git repository");
}

/** Workspace full-tree snapshot posture (docs/12 S-50; ruling 270). */
export function checkWorkspaceSnapshot(_d: DoctorEnv): DoctorCheck {
  const { detail } = workspaceSnapshotHonesty();
  return ok("workspace.snapshot", "workspace snapshot (S-50)", detail);
}

function checkWorkspaceMount(d: DoctorEnv): DoctorCheck {
  let findmntFstype: string | undefined;
  const fm = d.run("findmnt", ["-n", "-o", "FSTYPE", "-T", d.workspace], 5_000);
  if (fm.ok && fm.stdout.trim() !== "") findmntFstype = fm.stdout.trim();
  let mountinfo: string | undefined;
  try {
    const p = "/proc/self/mountinfo";
    if (existsSync(p)) mountinfo = readFileSync(p, "utf8");
  } catch {
    /* unreadable */
  }
  const posture = workspaceMountPosture(d.workspace, { findmntFstype, mountinfo });
  if (posture.kind === "network") {
    return warn(
      "workspace.mount",
      "workspace mount",
      posture.detail,
      "prefer a local disk for .hz state; NFS/SMB SQLite WAL and POSIX locks are unsafe (docs/12 F9)",
    );
  }
  if (posture.kind === "local") return ok("workspace.mount", "workspace mount", posture.detail);
  return ok("workspace.mount", "workspace mount", posture.detail);
}

export function checkWorktreePool(d: DoctorEnv): DoctorCheck {
  const porcelain = d.run("git", ["worktree", "list", "--porcelain"], 10_000);
  if (!porcelain.ok || porcelain.stdout.trim() === "") {
    return ok("worktree.pool", "worktree pool", "not a git repository (hzcode --worktree needs git)");
  }
  const status = inspectWorktreePool(d.workspace, {
    max: worktreePoolMaxFromEnv(d.env as Record<string, string | undefined>),
    porcelain: porcelain.stdout,
  });
  const summary = formatWorktreePoolLines(status).join("; ");
  if (status.atCapacity) {
    return warn(
      "worktree.pool",
      "worktree pool",
      summary,
      "reuse idle trees with hzcode --worktree <name> or remove extras; raise HZ_WORKTREE_POOL_MAX",
    );
  }
  return ok("worktree.pool", "worktree pool", summary);
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

/** Owner license honesty (docs/LICENSE-STATUS.md): never imply Apache/MIT without a root LICENSE. */
export function checkRepoLicense(repoRoot: string = REPO_ROOT): DoctorCheck {
  const licensePath = path.join(repoRoot, "LICENSE");
  const noticePath = path.join(repoRoot, "NOTICE");
  const statusDoc = path.join(repoRoot, LICENSE_STATUS_DOC);
  const hasLicense = existsSync(licensePath);
  const hasNotice = existsSync(noticePath);
  const hasStatusDoc = existsSync(statusDoc);
  if (hasLicense) {
    const name = path.basename(licensePath);
    return ok("repo.license", "project license", `${name} present at repo root (verify it matches owner intent)`);
  }
  let noticeFreshness = "";
  if (hasNotice) {
    try {
      const mtime = statSync(noticePath).mtime.toISOString().slice(0, 10);
      noticeFreshness = `; NOTICE dated ${mtime} (refresh when Provenance tables change)`;
    } catch {
      noticeFreshness = "; NOTICE present (mtime unreadable)";
    }
  }
  const parts = [
    "no LICENSE at repo root — owner choice still OPEN",
    hasNotice
      ? `NOTICE present (attribution hygiene only, not a grant${noticeFreshness})`
      : "NOTICE missing",
    hasStatusDoc ? LICENSE_STATUS_DOC : `${LICENSE_STATUS_DOC} missing`,
  ];
  return warn(
    "repo.license",
    "project license",
    parts.join("; "),
    hasStatusDoc
      ? `read ${LICENSE_STATUS_DOC}; add a root LICENSE when the owner chooses terms — do not invent SPDX ids`
      : `add ${LICENSE_STATUS_DOC} and a root LICENSE when the owner chooses terms`,
  );
}

function checkStateDurability(d: DoctorEnv): DoctorCheck {
  const env = d.env as NodeJS.ProcessEnv;
  if (!jsonlFsyncEnabled(env)) {
    return warn(
      "state.durability",
      "JSONL durability",
      "HZ_JSONL_FSYNC=0 — JSONL appends skip file and directory fsync (fast/test only)",
      "unset HZ_JSONL_FSYNC for normal durability; SQLite synchronous=FULL is unchanged",
    );
  }
  return ok(
    "state.durability",
    "JSONL durability",
    "SQLite synchronous=FULL; JSONL appends fsync file + best-effort parent directory (HZ_JSONL_FSYNC=0 disables); power-loss matrix not measured (docs/12 F10)",
  );
}

function checkTuiScreen(d: DoctorEnv): DoctorCheck {
  const mode = resolveTuiScreenMode(d.env);
  if (mode === "fullscreen" || mode === "fullscreen-experimental") {
    return ok(
      "tui.screen",
      "TUI mode",
      `${mode}: reduced alt-screen chat (raw stdin, cellbuffer); ${tuiFullscreenBlocksLabel()}; residuals mouse/gutters/rich approval`,
    );
  }
  return ok(
    "tui.screen",
    "TUI mode",
    `scrollback (native terminal scrollback); ${tuiFullscreenBlocksLabel()}`,
  );
}

/** Run every check, in table order. Never throws: a check that blows up is reported as a FAIL line. */
export function runDoctor(d: DoctorEnv): DoctorCheck[] {
  const groups: Array<[string, () => DoctorCheck | DoctorCheck[]]> = [
    ["bun", () => checkBun(d)],
    ["kernel", () => checkKernel(d)],
    ["config", () => checkConfig(d)],
    ["catalog", () => [checkCatalogSource(d), checkCatalogPoll(d), checkDocs30SkipBacklog()]],
    ["provider", () => [...checkProvider(d), checkAnthropicCache(d)]],
    [
      "workspace",
      () => [
        ...checkWorkspace(d),
        checkWorkspaceMount(d),
        checkWorkspaceSnapshot(d),
        checkStateDurability(d),
        checkEffectReconcileProbe(d),
        checkEffectPostimageReplay(d),
        checkTerminalRunCapability(d),
        checkTerminalStateProbe(d),
      ],
    ],
    ["git", () => [checkGit(d), checkWorktreePool(d)]],
    ["repo", () => checkRepoLicense()],
    ["sandbox", () => [checkSandboxExec(d), checkLandlockHost(d), checkSandboxPlatformHonesty(d), checkEffectHostKernel(d)]],
    [
      "egress",
      () => [
        checkShellEgressHonesty(d),
        checkEgressNetnsPartial(d),
        checkEgressNetnsRoute(d),
        checkEgressNetnsProxyReach(d),
        checkEgressNetnsVeth(d),
        checkEgressNetnsVethRouted(d),
        checkEgressNetnsSpawnVethRouted(d),
        checkEgressNetnsSpawnWrapped(d),
        checkEgressNetnsSpawnWrappedExecCreate(d),
        checkEgressNetnsSpawnProductDefault(d),
        checkSandboxExecVethJoin(d),
        checkSandboxExecVethCreate(d),
        checkEgressTlsMitm(d),
        checkEgressProxyEnv(d),
        checkOuterEgressFirewall(d),
      ],
    ],
    ["terminal", () => [...checkTerminal(d), checkTuiScreen(d)]],
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

/** Suggested exports for `hzcode doctor --fix <checkId>` — read-only, never mutates env files (ruling **299**). */
export function doctorFixSuggestion(
  checkId: string,
  env: Record<string, string | undefined> = process.env,
): string[] | undefined {
  if (checkId === "effect.host") return effectHostDoctorFixLines(env);
  if (checkId === "effect.postimage.replay") return postimageReplayDoctorFixLines(env);
  if (checkId === "egress.netns.spawn.product") return sandboxNetnsProductSpawnDoctorFixLines(env);
  return undefined;
}
