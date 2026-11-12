/**
 * doctor.test.ts - T-10: `hzcode doctor` is diagnose-only and honest.
 *
 * Each check is driven through an injected environment (no real terminal,
 * kernel or network); a final block runs the real CLI end to end.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import {
  doctorExitCode,
  runDoctor,
  renderDoctor,
  renderDoctorJson,
  type DoctorCheck,
  type DoctorEnv,
  type SpawnResult,
} from "../../src/core/doctor";
import { COMMITTED_CATALOG_SNAPSHOT } from "../../src/core/catalog/catalog";
import { kernelStateDir } from "../../src/core/paths";
import { writeOAuthToken } from "../../src/core/auth/store";

let home: string;
let workspace: string;
beforeEach(() => {
  home = mkdtempSync(path.join(tmpdir(), "hz-doctor-home-"));
  workspace = mkdtempSync(path.join(tmpdir(), "hz-doctor-ws-"));
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  rmSync(workspace, { recursive: true, force: true });
});

test("oauth token line when stored", () => {
  writeOAuthToken(
    { provider: "myllm", accessToken: "secret", obtainedAt: new Date().toISOString(), expiresAt: "2099-01-01T00:00:00.000Z" },
    home,
  );
  writeConfig(
    JSON.stringify({
      providers: [{ id: "myllm", baseUrl: "http://127.0.0.1:9999", protocol: "openai-chat" }],
      provider: "myllm",
      model: "m1",
    }),
  );
  const checks = runDoctor(fakeEnv({ env: { ...fakeEnv().env, HZ_PROVIDER: "myllm", HZ_MODEL: "m1", HOME: home } }));
  expect(byId(checks, "provider.oauth").status).toBe("ok");
});

test("hz-sandbox-exec doctor line", () => {
  const missing = runDoctor(fakeEnv({ env: { ...fakeEnv().env, HZ_SANDBOX_EXEC_BIN: "/no/such/hz-sandbox-exec" } }));
  expect(missing.some((c) => c.id === "sandbox.exec" && c.status === "warn")).toBe(true);
  const off = runDoctor(fakeEnv({ env: { ...fakeEnv().env, HZ_SANDBOX_EXEC: "0" } }));
  expect(off.some((c) => c.id === "sandbox.exec" && c.status === "ok" && c.detail.includes("disabled"))).toBe(true);
});

test("landlock doctor line is honest (no FS enforcement claimed)", () => {
  const checks = runDoctor(fakeEnv());
  const line = byId(checks, "sandbox.landlock");
  expect(line.status === "ok" || line.status === "warn").toBe(true);
  expect(line.detail.toLowerCase()).not.toContain("enforced");
});

test("tui.screen warns when fullscreen is requested", () => {
  const scroll = byId(runDoctor(fakeEnv()), "tui.screen");
  expect(scroll.status).toBe("ok");
  expect(scroll.detail).toContain("scrollback");
  const full = byId(runDoctor(fakeEnv({ env: { ...fakeEnv().env, HZ_TUI_MODE: "fullscreen" } })), "tui.screen");
  expect(full.status).toBe("warn");
});

test("outer egress firewall marker", () => {
  const off = runDoctor(fakeEnv({ env: { ...fakeEnv().env, LANG: "en_US.UTF-8" } }));
  expect(off.some((c) => c.id === "egress.outer" && c.status === "warn")).toBe(true);
  const on = runDoctor(fakeEnv({ env: { ...fakeEnv().env, HZ_OUTER_EGRESS_FIREWALL: "1" } }));
  expect(on.some((c) => c.id === "egress.outer" && c.status === "ok")).toBe(true);
});

const OKRUN = (cmd: string): SpawnResult =>
  cmd === "git"
    ? { ok: true, status: 0, stdout: "git version 2.40.0\n", stderr: "" }
    : { ok: true, status: 0, stdout: "SELFTEST OK (25 checks)\n", stderr: "" };

function fakeEnv(over: Partial<DoctorEnv> = {}): DoctorEnv {
  return {
    env: { LANG: "en_US.UTF-8", TERM: "xterm-256color", COLORTERM: "truecolor", HZ_PROVIDER: "mock" },
    workspace,
    home,
    bunVersion: "1.2.14",
    stdinIsTTY: true,
    stdoutIsTTY: true,
    run: OKRUN,
    kernelBinary: "/fake/hz-kernel",
    ...over,
  };
}

const byId = (checks: DoctorCheck[], id: string): DoctorCheck => {
  const c = checks.find((x) => x.id === id);
  if (c === undefined) throw new Error(`no check ${id}; have ${checks.map((x) => x.id).join(",")}`);
  return c;
};

function writeConfig(content: string, mode = 0o600): string {
  const dir = path.join(home, ".config", "horizon");
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "config.json");
  writeFileSync(file, content);
  chmodSync(file, mode);
  return file;
}

describe("a healthy environment", () => {
  test("has no FAIL, exits 0, and every non-OK line carries a fix hint", () => {
    const checks = runDoctor(fakeEnv());
    expect(doctorExitCode(checks)).toBe(0);
    expect(checks.filter((c) => c.status === "fail")).toEqual([]);
    for (const c of checks) if (c.status !== "ok") expect(c.hint).toBeTruthy();
    expect(byId(checks, "kernel.mode").detail).toContain("trusted");
    expect(byId(checks, "term.color").detail).toBe("truecolor");
  });
  test("the table has one line per check and a fix line under every WARN", () => {
    const checks = runDoctor(fakeEnv());
    const text = renderDoctor(checks);
    for (const c of checks) expect(text).toContain(c.label);
    const warns = checks.filter((c) => c.status !== "ok").length;
    expect(text.split("\n").filter((l) => l.includes("fix: ")).length).toBe(warns);
    expect(text).toMatch(/\d+ ok, \d+ warning\(s\), \d+ failure\(s\)/);
  });
});

describe("bun", () => {
  test("missing is a FAIL, too old is a WARN", () => {
    expect(byId(runDoctor(fakeEnv({ bunVersion: undefined })), "bun").status).toBe("fail");
    const old = byId(runDoctor(fakeEnv({ bunVersion: "1.0.9" })), "bun");
    expect(old.status).toBe("warn");
    expect(old.hint).toContain("bun upgrade");
  });
});

describe("kernel", () => {
  test("no binary: untrusted mode, with the build command as the fix", () => {
    const checks = runDoctor(fakeEnv({ kernelBinary: undefined }));
    expect(byId(checks, "kernel.binary").status).toBe("warn");
    expect(byId(checks, "kernel.binary").hint).toContain("cargo build --release --locked");
    expect(byId(checks, "kernel.mode").detail).toContain("untrusted");
    expect(doctorExitCode(checks)).toBe(0);
  });
  test("HZ_KERNEL_BIN pointing nowhere is named, not papered over", () => {
    const checks = runDoctor(fakeEnv({ kernelBinary: undefined, env: { HZ_KERNEL_BIN: "/nope/hz-kernel", LANG: "C.UTF-8" } }));
    expect(byId(checks, "kernel.binary").detail).toContain("/nope/hz-kernel");
    expect(byId(checks, "kernel.binary").hint).toContain("HZ_KERNEL_BIN");
  });
  test("a failing selftest is a FAIL and the run exits 1", () => {
    const checks = runDoctor(fakeEnv({ run: (cmd) => (cmd === "git" ? OKRUN(cmd) : { ok: false, status: 1, stdout: "SELFTEST FAILED\n", stderr: "" }) }));
    expect(byId(checks, "kernel.selftest").status).toBe("fail");
    expect(byId(checks, "kernel.selftest").hint).toContain("cargo build");
    expect(byId(checks, "kernel.mode").status).toBe("warn");
    expect(doctorExitCode(checks)).toBe(1);
  });
  test("a binary that cannot be spawned is a FAIL with the reason", () => {
    const checks = runDoctor(fakeEnv({ run: (cmd) => (cmd === "git" ? OKRUN(cmd) : { ok: false, status: null, stdout: "", stderr: "spawn EACCES" }) }));
    expect(byId(checks, "kernel.selftest").detail).toContain("EACCES");
  });
  test("the selftest runs against a throwaway state dir, never the workspace's", () => {
    const seen: string[][] = [];
    runDoctor(fakeEnv({ run: (cmd, args) => (seen.push([cmd, ...args]), OKRUN(cmd)) }));
    const st = seen.find((a) => a.includes("--selftest"));
    expect(st).toBeDefined();
    const dir = st?.[st.indexOf("--state-dir") + 1] ?? "";
    expect(dir.startsWith(tmpdir())).toBe(true);
    expect(dir.startsWith(workspace)).toBe(false);
    expect(existsSync(dir)).toBe(false); // cleaned up
  });
});

describe("config file", () => {
  test("malformed JSON is a FAIL that says the settings are not applied", () => {
    writeConfig("{ not json");
    const c = byId(runDoctor(fakeEnv()), "config.file");
    expect(c.status).toBe("fail");
    expect(c.hint).toContain("NOT applied");
  });
  test("a non-object is a FAIL", () => {
    writeConfig("[1,2]");
    expect(byId(runDoctor(fakeEnv()), "config.file").status).toBe("fail");
  });
  test("a valid file is OK; absent is OK", () => {
    expect(byId(runDoctor(fakeEnv()), "config.file").status).toBe("ok");
    writeConfig('{"provider":"mock"}');
    expect(byId(runDoctor(fakeEnv()), "config.file").detail).toContain("parses");
  });
  test("an inline apiKey in a world-readable file warns, and the key is never printed", () => {
    writeConfig('{"provider":"anthropic","apiKey":"sk-inline-SECRET"}', 0o644);
    const checks = runDoctor(fakeEnv({ env: { LANG: "C.UTF-8" } }));
    const c = byId(checks, "config.perms");
    expect(c.status).toBe("warn");
    expect(c.hint).toContain("chmod 600");
    expect(renderDoctor(checks)).not.toContain("sk-inline-SECRET");
    expect(renderDoctorJson(checks)).not.toContain("sk-inline-SECRET");
  });
  test("a private file with a key raises no permission warning", () => {
    writeConfig('{"provider":"anthropic","apiKey":"sk-x"}', 0o600);
    expect(runDoctor(fakeEnv({ env: { LANG: "C.UTF-8" } })).some((c) => c.id === "config.perms")).toBe(false);
  });
});

describe("provider, key and model", () => {
  test("mock provider is a WARN that names how to use a real one", () => {
    const c = byId(runDoctor(fakeEnv()), "provider");
    expect(c.status).toBe("warn");
    expect(c.hint).toContain("ANTHROPIC_API_KEY");
  });
  test("a real provider with no key is a FAIL naming the variable", () => {
    const checks = runDoctor(fakeEnv({ env: { HZ_PROVIDER: "anthropic", LANG: "C.UTF-8" } }));
    const k = byId(checks, "provider.key");
    expect(k.status).toBe("fail");
    expect(k.hint).toContain("ANTHROPIC_API_KEY");
    expect(doctorExitCode(checks)).toBe(1);
  });
  test("with a key it is OK and the value never appears in either output form", () => {
    const secret = "sk-ant-THIS-MUST-NOT-LEAK-123";
    const checks = runDoctor(fakeEnv({ env: { HZ_PROVIDER: "anthropic", ANTHROPIC_API_KEY: secret, LANG: "C.UTF-8" } }));
    expect(byId(checks, "provider.key").status).toBe("ok");
    expect(byId(checks, "provider.key").detail).toContain("value not shown");
    expect(renderDoctor(checks)).not.toContain(secret);
    expect(renderDoctorJson(checks)).not.toContain(secret);
  });
  test("catalog.source names committed models-dev snapshot when bundled", () => {
    if (!existsSync(COMMITTED_CATALOG_SNAPSHOT)) return;
    const env = { ...fakeEnv().env, LANG: "C.UTF-8", HZ_NO_COMMITTED_SNAPSHOT: "0" };
    const line = byId(runDoctor(fakeEnv({ env, home })), "catalog.source");
    expect(line.status).toBe("ok");
    expect(line.detail).toContain("models-dev.snapshot");
  });

  test("a known model resolves in the catalog; an unknown one is a WARN", () => {
    const env = { HZ_PROVIDER: "anthropic", ANTHROPIC_API_KEY: "k", LANG: "C.UTF-8" };
    const known = byId(runDoctor(fakeEnv({ env })), "model");
    expect(known.status).toBe("ok");
    expect(known.detail).toContain("catalog");
    const unknown = byId(runDoctor(fakeEnv({ env: { ...env, HZ_MODEL: "claude-not-a-model-9" } })), "model");
    expect(unknown.status).toBe("warn");
    expect(unknown.hint).toBeTruthy();
  });
});

describe("workspace and state directory", () => {
  test("a missing workspace is a FAIL", () => {
    const c = byId(runDoctor(fakeEnv({ workspace: path.join(workspace, "does-not-exist") })), "workspace");
    expect(c.status).toBe("fail");
    expect(c.hint).toContain("--workspace");
  });
  test("a state dir open to other users warns with the chmod fix; a private one is OK", () => {
    const kdir = kernelStateDir(workspace);
    mkdirSync(kdir, { recursive: true });
    chmodSync(kdir, 0o755);
    writeFileSync(path.join(kdir, "receipts.jsonl"), "");
    chmodSync(path.join(kdir, "receipts.jsonl"), 0o644);
    const bad = byId(runDoctor(fakeEnv()), "state.perms");
    expect(bad.status).toBe("warn");
    expect(bad.hint).toBe(`chmod -R go-rwx ${kdir}`);
    chmodSync(kdir, 0o700);
    chmodSync(path.join(kdir, "receipts.jsonl"), 0o600);
    expect(byId(runDoctor(fakeEnv()), "state.perms").status).toBe("ok");
  });
});

describe("git and terminal", () => {
  test("missing git is a WARN", () => {
    const checks = runDoctor(fakeEnv({ run: (cmd) => (cmd === "git" ? { ok: false, status: null, stdout: "", stderr: "ENOENT" } : OKRUN(cmd)) }));
    expect(byId(checks, "git").status).toBe("warn");
  });
  test("not a TTY, NO_COLOR and a non-UTF-8 locale are each reported with a fix", () => {
    const checks = runDoctor(fakeEnv({ stdinIsTTY: false, stdoutIsTTY: false, env: { NO_COLOR: "1", LANG: "C", HZ_PROVIDER: "mock" } }));
    expect(byId(checks, "term.tty").status).toBe("warn");
    expect(byId(checks, "term.color").detail).toContain("NO_COLOR");
    expect(byId(checks, "term.utf8").status).toBe("warn");
    expect(byId(checks, "term.utf8").hint).toContain("UTF-8");
  });
  test("TERM=dumb warns", () => {
    const c = byId(runDoctor(fakeEnv({ env: { TERM: "dumb", LANG: "C.UTF-8", HZ_PROVIDER: "mock" } })), "term.color");
    expect(c.status).toBe("warn");
  });
  test("colour levels are named", () => {
    const lvl = (env: Record<string, string>) => byId(runDoctor(fakeEnv({ env: { LANG: "C.UTF-8", HZ_PROVIDER: "mock", ...env } })), "term.color").detail;
    expect(lvl({ TERM: "xterm-256color" })).toBe("256 colours");
    expect(lvl({ TERM: "xterm" })).toBe("16 colours");
  });
});

describe("diagnose only", () => {
  test("a full run changes nothing under the workspace or home", () => {
    const list = (root: string): string[] => {
      const out: string[] = [];
      const walk = (d: string): void => {
        for (const e of readdirSync(d, { withFileTypes: true })) {
          const full = path.join(d, e.name);
          out.push(full);
          if (e.isDirectory()) walk(full);
        }
      };
      walk(root);
      return out.sort();
    };
    writeConfig('{"provider":"mock"}');
    const before = [list(home), list(workspace)];
    runDoctor(fakeEnv());
    expect([list(home), list(workspace)]).toEqual(before);
  });
  test("a check that throws becomes a FAIL line instead of crashing the report", () => {
    const checks = runDoctor(fakeEnv({ run: () => { throw new Error("boom"); } }));
    expect(checks.some((c) => c.status === "fail" && c.detail.includes("boom"))).toBe(true);
  });
});

describe("the real CLI", () => {
  const main = path.resolve(import.meta.dir, "../../src/main.ts");
  const run = (args: string[], env: Record<string, string>) =>
    Bun.spawnSync(["bun", main, ...args], { env: { PATH: process.env.PATH ?? "", HOME: home, LANG: "C.UTF-8", ...env }, stdout: "pipe", stderr: "pipe" });

  test("--json is machine readable, exits 0, and the key is not in it", () => {
    const r = run(["doctor", "--json", "--workspace", workspace], { ANTHROPIC_API_KEY: "sk-cli-SECRET-999" });
    expect(r.exitCode).toBe(0);
    const text = r.stdout.toString();
    expect(text).not.toContain("sk-cli-SECRET-999");
    const parsed = JSON.parse(text) as { ok: boolean; checks: Array<{ id: string }> };
    expect(parsed.ok).toBe(true);
    expect(parsed.checks.map((c) => c.id)).toContain("kernel.selftest");
  });
  test("a broken config makes the command exit 1 and print FAIL", () => {
    writeConfig("{ nope");
    const r = run(["doctor", "--workspace", workspace], {});
    expect(r.exitCode).toBe(1);
    expect(r.stdout.toString()).toContain("[FAIL] config file");
  });
  test("an unknown argument is a usage error (2); --help documents the command", () => {
    expect(run(["doctor", "--bogus"], {}).exitCode).toBe(2);
    expect(run(["--help"], {}).stdout.toString()).toContain("hzcode doctor");
    expect(run(["doctor", "--help"], {}).exitCode).toBe(0);
  });
});
