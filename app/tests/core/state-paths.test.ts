/**
 * state-paths.test.ts — the one resolution rule for state paths (docs/28 §4
 * gap 6): canonical-first (`.hz/` in a workspace, `~/.config/horizon/` for user
 * config), with an existing `.hzcode/` tree honoured in place forever.
 *
 * The rule itself lives in app/src/core/paths.ts; these tests pin the concrete
 * tree (docs/12 §4.1 for the named paths) and prove that a legacy workspace is
 * never split: nothing canonical appears beside an existing `.hzcode/`.
 *
 * Hermetic: every case runs in temp dirs; the process environment is saved and
 * restored. HOME is exercised through the explicit `home` parameter, the repo's
 * existing pattern (Bun resolves os.homedir() once at start-up — see
 * config.test.ts).
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { defaultConfigPath, loadConfig } from "../../src/core/config";
import { KernelClient } from "../../src/core/kernel";
import {
  historyFilePath,
  isLegacyWorkspace,
  kernelStateDir,
  sessionDbPath,
  skillsDir,
  spillDir,
  stateRoot,
  userConfigDir,
  workspaceStateDir,
} from "../../src/core/paths";
import { SessionStore } from "../../src/core/session";
import { cleanupTemps, restoreEnv, seedFor, setEnv, snapshotEnv, tempDir, type EnvSnapshot } from "./helpers";

let envBackup: EnvSnapshot;

beforeAll(() => {
  envBackup = snapshotEnv();
});

afterAll(() => {
  restoreEnv(envBackup);
  cleanupTemps();
});

/** Nothing from the ambient environment may leak into a config assertion. */
function cleanEnv(): void {
  setEnv({
    HZ_PROVIDER: undefined,
    HZ_MODEL: undefined,
    HZ_BASE_URL: undefined,
    HZ_API_KEY: undefined,
    ANTHROPIC_API_KEY: undefined,
    OPENAI_API_KEY: undefined,
  });
}

/** The whole canonical workspace tree, as literal strings (the contract). */
function canonicalPaths(workspace: string) {
  return {
    root: path.join(workspace, ".hz"),
    state: path.join(workspace, ".hz", "state"),
    kernel: path.join(workspace, ".hz", "state", "kernel"),
    db: path.join(workspace, ".hz", "state", "hzcode.db"),
    spills: path.join(workspace, ".hz", "state", "spills"),
    skills: path.join(workspace, ".hz", "state", "skills"),
    history: path.join(workspace, ".hz", "state", "history"),
  };
}

/** The legacy tree, as literal strings. */
function legacyPaths(workspace: string) {
  return {
    root: path.join(workspace, ".hzcode"),
    kernel: path.join(workspace, ".hzcode", "kernel"),
    db: path.join(workspace, ".hzcode", "db.sqlite"),
    spills: path.join(workspace, ".hzcode", "spills"),
    skills: path.join(workspace, ".hzcode", "skills"),
    history: path.join(workspace, ".hzcode", "history"),
  };
}

/* ------------------------------ the workspace ------------------------------ */

describe("workspace state paths", () => {
  test("a fresh workspace resolves to the canonical tree and creates it on first write", async () => {
    const workspace = tempDir("hz-paths-canonical-");
    const canonical = canonicalPaths(workspace);

    // Resolution is pure: it names the canonical tree before anything exists.
    expect(isLegacyWorkspace(workspace)).toBe(false);
    expect(stateRoot(workspace)).toBe(canonical.root);
    expect(workspaceStateDir(workspace)).toBe(canonical.state);
    expect(kernelStateDir(workspace)).toBe(canonical.kernel);
    expect(sessionDbPath(workspace)).toBe(canonical.db);
    expect(spillDir(workspace)).toBe(canonical.spills);
    expect(skillsDir(workspace)).toBe(canonical.skills);
    expect(historyFilePath(workspace)).toBe(canonical.history);
    expect(existsSync(workspace)).toBe(true);

    // The kernel path creates the tree: `.hz/state/kernel/events/...`.
    const client = new KernelClient({ workspace }); // local fallback: never started
    try {
      await client.appendEvent("state-paths:test", seedFor("state-paths:test", "test.event", { hello: "world" }));
    } finally {
      await client.close();
    }
    expect(existsSync(canonical.kernel)).toBe(true);
    expect(existsSync(path.join(canonical.kernel, "events", "state-paths__test.jsonl"))).toBe(true);
    expect(existsSync(legacyPaths(workspace).root)).toBe(false);

    // The session store creates its database under the same canonical tree.
    const store = new SessionStore(workspace);
    try {
      expect(store.dbPath).toBe(canonical.db);
      expect(existsSync(canonical.db)).toBe(true);
    } finally {
      store.close();
    }
  });

  test("an existing `.hzcode/` is honoured in place: nothing under `.hz` is created", async () => {
    const workspace = tempDir("hz-paths-legacy-");
    const legacy = legacyPaths(workspace);
    mkdirSync(legacy.root, { recursive: true });

    expect(isLegacyWorkspace(workspace)).toBe(true);
    expect(stateRoot(workspace)).toBe(legacy.root);
    expect(workspaceStateDir(workspace)).toBe(legacy.root);
    expect(kernelStateDir(workspace)).toBe(legacy.kernel);
    expect(sessionDbPath(workspace)).toBe(legacy.db);
    expect(spillDir(workspace)).toBe(legacy.spills);
    expect(skillsDir(workspace)).toBe(legacy.skills);
    expect(historyFilePath(workspace)).toBe(legacy.history);

    const client = new KernelClient({ workspace });
    try {
      await client.appendEvent("state-paths:test", seedFor("state-paths:test", "test.event", { hello: "legacy" }));
    } finally {
      await client.close();
    }
    const store = new SessionStore(workspace);
    try {
      expect(store.dbPath).toBe(legacy.db);
    } finally {
      store.close();
    }

    expect(existsSync(path.join(legacy.kernel, "events", "state-paths__test.jsonl"))).toBe(true);
    expect(existsSync(legacy.db)).toBe(true);
    // The canonical tree is never created beside a legacy one.
    expect(existsSync(path.join(workspace, ".hz"))).toBe(false);
  });

  test("both present: legacy wins, and the canonical tree is not split off", async () => {
    const workspace = tempDir("hz-paths-both-");
    const legacy = legacyPaths(workspace);
    const canonical = canonicalPaths(workspace);
    mkdirSync(legacy.root, { recursive: true });
    mkdirSync(canonical.root, { recursive: true });
    writeFileSync(path.join(canonical.root, "keep.txt"), "untouched\n", "utf8");

    expect(isLegacyWorkspace(workspace)).toBe(true);
    expect(stateRoot(workspace)).toBe(legacy.root);
    expect(kernelStateDir(workspace)).toBe(legacy.kernel);
    expect(sessionDbPath(workspace)).toBe(legacy.db);

    const client = new KernelClient({ workspace });
    try {
      await client.appendEvent("state-paths:test", seedFor("state-paths:test", "test.event", {}));
    } finally {
      await client.close();
    }
    const store = new SessionStore(workspace);
    try {
      expect(store.dbPath).toBe(legacy.db);
    } finally {
      store.close();
    }

    // Legacy state grew in place; the canonical tree did not gain a state/ tree.
    expect(existsSync(path.join(legacy.kernel, "events", "state-paths__test.jsonl"))).toBe(true);
    expect(existsSync(legacy.db)).toBe(true);
    expect(existsSync(canonical.state)).toBe(false);
    expect(existsSync(path.join(canonical.root, "keep.txt"))).toBe(true);
  });

  test("resolution is symlink-safe: a symlinked workspace decides like its target", () => {
    // A symlinked legacy workspace: the `.hzcode` in the target decides.
    const real = tempDir("hz-paths-link-real-");
    mkdirSync(path.join(real, ".hzcode"), { recursive: true });
    const holder = tempDir("hz-paths-link-holder-");
    const link = path.join(holder, "ws-link");
    symlinkSync(real, link, "dir");
    expect(isLegacyWorkspace(link)).toBe(true);
    expect(stateRoot(link)).toBe(path.join(link, ".hzcode"));

    // A symlinked fresh workspace: canonical, through the link.
    const fresh = tempDir("hz-paths-link-fresh-");
    const holder2 = tempDir("hz-paths-link-holder2-");
    const link2 = path.join(holder2, "ws-link");
    symlinkSync(fresh, link2, "dir");
    expect(isLegacyWorkspace(link2)).toBe(false);
    expect(stateRoot(link2)).toBe(path.join(link2, ".hz"));

    // A `.hzcode` symlink — even a dangling one — counts as the legacy tree.
    const linked = tempDir("hz-paths-link-legacy-");
    const tree = tempDir("hz-paths-link-tree-");
    symlinkSync(tree, path.join(linked, ".hzcode"), "dir");
    expect(stateRoot(linked)).toBe(path.join(linked, ".hzcode"));

    const dangling = tempDir("hz-paths-link-dangling-");
    symlinkSync(path.join(dangling, "nowhere"), path.join(dangling, ".hzcode"), "dir");
    expect(isLegacyWorkspace(dangling)).toBe(true);
    expect(stateRoot(dangling)).toBe(path.join(dangling, ".hzcode"));
  });
});

/* ------------------------------ user config ------------------------------ */

describe("user config paths", () => {
  test("a fresh home gets `~/.config/horizon/` and the config file is read from there", () => {
    cleanEnv();
    const home = tempDir("hz-paths-home-canonical-");
    const dir = path.join(home, ".config", "horizon");
    expect(userConfigDir(home)).toBe(dir);
    expect(defaultConfigPath(home)).toBe(path.join(dir, "config.json"));

    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "config.json"), JSON.stringify({ provider: "openai", model: "gpt-from-canonical" }), "utf8");
    const config = loadConfig({}, defaultConfigPath(home));
    expect(config.provider).toBe("openai");
    expect(config.model).toBe("gpt-from-canonical");
    expect(config.sources.provider).toBe("file");
  });

  test("an existing `~/.hzcode/` is honoured in place", () => {
    cleanEnv();
    const home = tempDir("hz-paths-home-legacy-");
    const dir = path.join(home, ".hzcode");
    mkdirSync(dir, { recursive: true });
    expect(userConfigDir(home)).toBe(dir);
    expect(defaultConfigPath(home)).toBe(path.join(dir, "config.json"));

    writeFileSync(path.join(dir, "config.json"), JSON.stringify({ provider: "anthropic", model: "claude-legacy" }), "utf8");
    const config = loadConfig({}, defaultConfigPath(home));
    expect(config.provider).toBe("anthropic");
    expect(config.model).toBe("claude-legacy");
    expect(config.sources.provider).toBe("file");
  });

  test("the config path follows HOME (temp HOME installed, real one restored)", () => {
    cleanEnv();
    const home = tempDir("hz-paths-home-env-");
    setEnv({ HOME: home });
    expect(process.env.HOME).toBe(home);
    expect(defaultConfigPath(process.env.HOME)).toBe(path.join(home, ".config", "horizon", "config.json"));
  });

  test("user config resolution is symlink-safe: a symlinked home decides like its target", () => {
    const real = tempDir("hz-paths-home-real-");
    mkdirSync(path.join(real, ".hzcode"), { recursive: true });
    const holder = tempDir("hz-paths-home-holder-");
    const link = path.join(holder, "home-link");
    symlinkSync(real, link, "dir");
    expect(userConfigDir(link)).toBe(path.join(link, ".hzcode"));

    const fresh = tempDir("hz-paths-home-fresh-");
    expect(userConfigDir(fresh)).toBe(path.join(fresh, ".config", "horizon"));
  });
});
