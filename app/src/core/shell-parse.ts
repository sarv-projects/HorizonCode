/**
 * shell-parse.ts — Zero-dependency `ARITY` permission pattern derivation &
 * workspace-boundary target extraction.
 *
 * Ported from OpenCode's `packages/core/src/shell/parse.ts` without external
 * runtime dependencies (no `effect` package).
 *
 * Key guarantees:
 * - Granular reusable permission patterns via `ARITY` (`git commit *`,
 *   `npm run build *`, `cargo test *`, `docker compose up *`, `kubectl get *`,
 *   `gh pr view *`, etc.).
 * - Workspace-boundary target extraction (`extractShellTargets`) covering
 *   directory-changing commands (`cd`, `pushd`, `Set-Location`, `git -C`),
 *   file-writing redirections, and filesystem path arguments.
 * - Fail-closed on `opaque` commands: NEVER generates a wildcard save pattern
 *   when `scanShellCommand` reports `opaque: true`.
 */

import * as os from "node:os";
import * as path from "node:path";
import {
  scanShellCommand,
  type ShellDialect,
  type ShellInvocation,
  type ShellOpaqueReason,
  type ShellScanOptions,
  type ShellScanResult,
} from "./shell-scan";

/**
 * OpenCode-compatible command arity table determining how many leading tokens
 * form a reusable `"<prefix> *"` permission pattern.
 */
export const ARITY: Readonly<Record<string, number>> = {
  cat: 1,
  cd: 1,
  chmod: 1,
  chown: 1,
  cp: 1,
  echo: 1,
  env: 1,
  export: 1,
  grep: 1,
  kill: 1,
  killall: 1,
  ln: 1,
  ls: 1,
  mkdir: 1,
  mv: 1,
  ps: 1,
  pwd: 1,
  rm: 1,
  rmdir: 1,
  sleep: 1,
  source: 1,
  tail: 1,
  touch: 1,
  unset: 1,
  which: 1,
  aws: 3,
  az: 3,
  bazel: 2,
  brew: 2,
  bun: 2,
  "bun run": 3,
  "bun x": 3,
  cargo: 2,
  "cargo add": 3,
  "cargo run": 3,
  cdk: 2,
  cf: 2,
  cmake: 2,
  composer: 2,
  consul: 2,
  "consul kv": 3,
  crictl: 2,
  deno: 2,
  "deno task": 3,
  doctl: 3,
  docker: 2,
  "docker builder": 3,
  "docker compose": 3,
  "docker container": 3,
  "docker image": 3,
  "docker network": 3,
  "docker volume": 3,
  eksctl: 2,
  "eksctl create": 3,
  firebase: 2,
  flyctl: 2,
  gcloud: 3,
  gh: 3,
  git: 2,
  "git config": 3,
  "git remote": 3,
  "git stash": 3,
  go: 2,
  gradle: 2,
  helm: 2,
  heroku: 2,
  hugo: 2,
  ip: 2,
  "ip addr": 3,
  "ip link": 3,
  "ip netns": 3,
  "ip route": 3,
  kind: 2,
  "kind create": 3,
  kubectl: 2,
  "kubectl kustomize": 3,
  "kubectl rollout": 3,
  kustomize: 2,
  make: 2,
  mc: 2,
  "mc admin": 3,
  minikube: 2,
  mongosh: 2,
  mysql: 2,
  mvn: 2,
  ng: 2,
  npm: 2,
  "npm exec": 3,
  "npm init": 3,
  "npm run": 3,
  "npm view": 3,
  npx: 2,
  nvm: 2,
  nx: 2,
  openssl: 2,
  "openssl req": 3,
  "openssl x509": 3,
  pip: 2,
  pipenv: 2,
  pnpm: 2,
  "pnpm dlx": 3,
  "pnpm exec": 3,
  "pnpm run": 3,
  poetry: 2,
  podman: 2,
  "podman container": 3,
  "podman image": 3,
  psql: 2,
  pulumi: 2,
  "pulumi stack": 3,
  python: 2,
  pyenv: 2,
  rake: 2,
  rbenv: 2,
  "redis-cli": 2,
  rustup: 2,
  serverless: 2,
  sfdx: 3,
  skaffold: 2,
  sls: 2,
  sst: 2,
  swift: 2,
  systemctl: 2,
  terraform: 2,
  "terraform workspace": 3,
  tmux: 2,
  turbo: 2,
  ufw: 2,
  vault: 2,
  "vault auth": 3,
  "vault kv": 3,
  vercel: 2,
  volta: 2,
  wp: 2,
  yarn: 2,
  "yarn dlx": 3,
  "yarn run": 3,
};

export const SHELL_ARITY = ARITY;

const PREFIX_MAX_LENGTH = Math.max(...Object.values(ARITY));

const CWD_COMMANDS = new Set(["cd", "chdir", "popd", "pushd", "push-location", "set-location"]);
const FS_PATH_COMMANDS = new Set([
  "rm",
  "rmdir",
  "mv",
  "cp",
  "chmod",
  "chown",
  "mkdir",
  "touch",
  "ln",
  "tee",
  "truncate",
  "cat",
  "head",
  "tail",
  "sed",
  "awk",
]);
const SAFE_REDIRECT_SINKS = new Set(["/dev/null", "/dev/stdout", "/dev/stderr", "/dev/tty", "nul", "nul:"]);
const SAFE_ENV_ASSIGNMENT_NAMES = new Set(["LC_ALL", "LANG", "TZ", "NO_COLOR"]);

export interface DeriveShellPermissionOptions extends ShellScanOptions {
  cwd?: string;
}

export interface ShellPermissionEntry {
  resource: string;
  pattern: string;
  argv: string[];
}

export type ShellPermissionResult =
  | {
      ok: true;
      opaque: false;
      dialect: ShellDialect;
      patterns: string[];
      commands: ShellPermissionEntry[];
      targets: string[];
    }
  | {
      ok: false;
      opaque: true;
      opaqueReason: ShellOpaqueReason;
      detail: string;
      dialect: ShellDialect;
      patterns: [];
      commands: [];
      targets: [];
    };

export interface ShellTargetsResult {
  ok: boolean;
  opaque: boolean;
  opaqueReason?: ShellOpaqueReason;
  directories: string[];
  redirectTargets: string[];
  paths: string[];
}

/**
 * Select the arity-governed leading token prefix for a command argv.
 * Looks up longest matching key in `ARITY` (case-insensitive) and slices up to
 * that arity, defaulting to 1 token.
 */
export function shellCommandPrefix(argv: readonly string[]): string[] {
  if (argv.length === 0) return [];
  const head = argv.slice(0, PREFIX_MAX_LENGTH);
  for (let len = head.length; len > 0; len--) {
    const key = head.slice(0, len).join(" ").toLowerCase();
    const arity = ARITY[key];
    if (arity !== undefined) {
      return head.slice(0, arity);
    }
  }
  return head.slice(0, 1);
}

/** Compute the reusable wildcard permission pattern for a concrete argv. */
export function shellPermissionPatternForArgv(argv: readonly string[]): string | undefined {
  const pref = shellCommandPrefix(argv);
  if (pref.length === 0) return undefined;
  return `${pref.join(" ")} *`;
}

function expandTargetPath(rawTarget: string, powershell: boolean, cwd?: string): string | undefined {
  let value = rawTarget.trim();
  if (value === "") return undefined;

  if (powershell) {
    value = value
      .replace(/\$\{env:([^}]+)\}/gi, (_, key: string) => lookupEnv(key) ?? "")
      .replace(/\$env:([A-Za-z_][A-Za-z0-9_]*)/gi, (_, key: string) => lookupEnv(key) ?? "")
      .replace(/\$(?:\{(HOME|PWD)\}|(HOME|PWD)(?=$|[\\/]))/gi, (_, braced?: string, bare?: string) => {
        const key = (braced ?? bare ?? "").toUpperCase();
        if (key === "HOME") return os.homedir();
        return cwd ?? process.cwd();
      });
  }

  // Unresolved shell variables or command substitutions cannot be statically resolved.
  if (value.includes("$") || value.includes("`")) return undefined;

  if (value === "~") {
    value = os.homedir();
  } else if (value.startsWith("~/") || value.startsWith("~\\")) {
    value = path.join(os.homedir(), value.slice(2));
  }

  if (cwd && !path.isAbsolute(value) && !/^[A-Za-z]:[\\/]/.test(value)) {
    return path.resolve(cwd, value);
  }
  return value;
}

function lookupEnv(key: string): string | undefined {
  if (process.platform !== "win32") return process.env[key];
  const match = Object.keys(process.env).find((k) => k.toLowerCase() === key.toLowerCase());
  return match ? process.env[match] : undefined;
}

function unwrapDirectoryArgv(argv: readonly string[], powershell: boolean): readonly string[] | undefined {
  if (argv.length === 0) return undefined;
  const first = argv[0]!.toLowerCase();
  if (CWD_COMMANDS.has(first)) return argv;
  if (powershell) return undefined;
  let i = 0;
  while (argv[i] === "builtin" || argv[i] === "command") {
    const wrapper = argv[i]!;
    i++;
    while (argv[i]?.startsWith("-")) {
      const flag = argv[i]!;
      i++;
      if (flag === "--") break;
      if (wrapper === "command" && /^-[p]*[vV]/.test(flag)) return undefined;
    }
  }
  if (i > 0 && argv[i] && CWD_COMMANDS.has(argv[i]!.toLowerCase())) {
    return argv.slice(i);
  }
  return undefined;
}

function extractTargetsFromInvocation(
  inv: ShellInvocation,
  powershell: boolean,
  cwd: string | undefined,
  directories: Set<string>,
  redirectTargets: Set<string>,
  paths: Set<string>,
): void {
  // 1. File-writing redirects
  for (const r of inv.redirects) {
    if (!r.isWrite || r.isFdDup) continue;
    if (SAFE_REDIRECT_SINKS.has(r.target.toLowerCase())) continue;
    const resolved = expandTargetPath(r.target, powershell, cwd);
    if (resolved) {
      redirectTargets.add(resolved);
      paths.add(resolved);
    }
  }

  if (inv.argv.length === 0) return;

  // 2. Directory-changing commands (`cd`, `pushd`, `Set-Location`, `Push-Location`)
  const dirArgv = unwrapDirectoryArgv(inv.argv, powershell);
  if (dirArgv !== undefined) {
    const head = dirArgv[0]!.toLowerCase();
    if (head !== "popd") {
      let endOfOpts = false;
      let expectPathValue = false;
      for (const arg of dirArgv.slice(1)) {
        if (!endOfOpts && arg === "--") {
          endOfOpts = true;
          continue;
        }
        if (powershell && !endOfOpts && /^-(?:path|literalpath|lp|pspath):?$/i.test(arg)) {
          expectPathValue = true;
          continue;
        }
        if (powershell && !endOfOpts && /^-(?:path|literalpath|lp|pspath):(.+)$/i.test(arg)) {
          const val = arg.slice(arg.indexOf(":") + 1);
          const resolved = expandTargetPath(val, true, cwd);
          if (resolved) {
            directories.add(resolved);
            paths.add(resolved);
          }
          continue;
        }
        if (!expectPathValue && !endOfOpts && arg.startsWith("-") && arg !== "-") continue;
        expectPathValue = false;
        if (arg === "-") continue;
        const resolved = expandTargetPath(arg, powershell, cwd);
        if (resolved) {
          directories.add(resolved);
          paths.add(resolved);
        }
      }
    }
    return;
  }

  // 3. `git -C <dir> ...`
  const headLower = inv.argv[0]!.toLowerCase();
  if (headLower === "git") {
    for (let i = 1; i < inv.argv.length - 1; i++) {
      if (inv.argv[i] === "-C") {
        const resolved = expandTargetPath(inv.argv[i + 1]!, powershell, cwd);
        if (resolved) {
          directories.add(resolved);
          paths.add(resolved);
        }
        i++;
      }
    }
    return;
  }

  // 4. Filesystem path operands on common file-mutating / file-reading commands
  if (FS_PATH_COMMANDS.has(headLower)) {
    let endOfOpts = false;
    let skipFirstPositional = headLower === "chmod" || headLower === "chown" || headLower === "sed" || headLower === "awk";
    for (let i = 1; i < inv.argv.length; i++) {
      const arg = inv.argv[i]!;
      if (!endOfOpts && arg === "--") {
        endOfOpts = true;
        continue;
      }
      if (!endOfOpts && arg.startsWith("-")) {
        // Options that take a non-path value (e.g. `truncate -s 0`, `sed -e script`, `head -n 10`)
        if (
          (headLower === "truncate" && (arg === "-s" || arg === "--size")) ||
          ((headLower === "head" || headLower === "tail") && (arg === "-n" || arg === "-c")) ||
          (headLower === "sed" && (arg === "-e" || arg === "-f")) ||
          (headLower === "awk" && (arg === "-F" || arg === "-v" || arg === "-f"))
        ) {
          i++;
        }
        continue;
      }
      if (skipFirstPositional) {
        skipFirstPositional = false;
        continue;
      }
      const resolved = expandTargetPath(arg, powershell, cwd);
      if (resolved) paths.add(resolved);
    }
  }
}

function extractTargetsFromScan(scan: ShellScanResult, cwd?: string): ShellTargetsResult {
  if (scan.opaque) {
    return {
      ok: false,
      opaque: true,
      opaqueReason: scan.opaqueReason,
      directories: [],
      redirectTargets: [],
      paths: [],
    };
  }
  const powershell = scan.dialect === "powershell";
  const directories = new Set<string>();
  const redirectTargets = new Set<string>();
  const paths = new Set<string>();
  for (const inv of scan.commands) {
    extractTargetsFromInvocation(inv, powershell, cwd, directories, redirectTargets, paths);
  }
  return {
    ok: true,
    opaque: false,
    directories: [...directories],
    redirectTargets: [...redirectTargets],
    paths: [...paths],
  };
}

/**
 * Extract directory and filesystem path targets from a shell command for
 * workspace-boundary verification.
 */
export function extractShellTargets(command: string, opts?: DeriveShellPermissionOptions): ShellTargetsResult {
  const scan = scanShellCommand(command, opts);
  return extractTargetsFromScan(scan, opts?.cwd);
}

/**
 * Derive granular reusable `ARITY`-based permission patterns for a shell command.
 *
 * Fail-closed guarantee: when the static AST scanner flags `opaque: true`
 * (e.g., `eval`, `source`/`.`, `exec`, `$CMD`, `${!var}`, PowerShell `iex` /
 * `Invoke-Expression` / `& $var`, or unclosed/malformed syntax), this function
 * NEVER generates a wildcard save pattern and returns `{ ok: false, opaque: true, ... }`.
 */
export function deriveShellPermissionPatterns(
  command: string,
  opts?: DeriveShellPermissionOptions,
): ShellPermissionResult {
  const scan = scanShellCommand(command, opts);
  if (scan.opaque) {
    return {
      ok: false,
      opaque: true,
      opaqueReason: scan.opaqueReason,
      detail: scan.detail,
      dialect: scan.dialect,
      patterns: [],
      commands: [],
      targets: [],
    };
  }

  const entries: ShellPermissionEntry[] = [];
  const patternSet = new Set<string>();

  for (const inv of scan.commands) {
    if (inv.declaration === true) {
      return {
        ok: false,
        opaque: true,
        opaqueReason: "dynamic-execution",
        detail: `shell declaration cannot derive wildcard permission pattern: ${inv.raw}`,
        dialect: scan.dialect,
        patterns: [],
        commands: [],
        targets: [],
      };
    }
    if (inv.envAssignments.length > 0) {
      const unsafe = inv.envAssignments.filter((a) => !SAFE_ENV_ASSIGNMENT_NAMES.has(a.name));
      if (unsafe.length > 0) {
        return {
          ok: false,
          opaque: true,
          opaqueReason: "dynamic-execution",
          detail: `unsafe environment assignment (${unsafe.map((a) => a.name).join(", ")}) cannot derive wildcard permission pattern`,
          dialect: scan.dialect,
          patterns: [],
          commands: [],
          targets: [],
        };
      }
    }
    if (inv.argv.length === 0) continue;
    const words =
      inv.redirectWordCount !== undefined ? inv.argv.slice(0, inv.redirectWordCount) : inv.argv;
    const pattern = shellPermissionPatternForArgv(words);
    if (!pattern) continue;
    patternSet.add(pattern);
    entries.push({
      resource: inv.raw,
      pattern,
      argv: inv.argv,
    });
  }

  const targetResult = extractTargetsFromScan(scan, opts?.cwd);

  return {
    ok: true,
    opaque: false,
    dialect: scan.dialect,
    patterns: [...patternSet],
    commands: entries,
    targets: targetResult.paths,
  };
}
