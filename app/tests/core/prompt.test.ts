/**
 * prompt.test.ts -- the base system prompt as data (src/core/prompt/).
 * Deterministic: every environment input is injected, no clock, no real $SHELL.
 * The golden files are byte snapshots; edit them only when the prompt change
 * is intended (and re-measure the token estimate in docs/28).
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import type { ProviderRequest } from "../../src/contracts";
import { KernelClient } from "../../src/core/kernel";
import { runTurn, systemPrompt, type LoopDeps } from "../../src/core/loop";
import { estimateTokens } from "../../src/core/output-budget";
import {
  BASE_PROMPT_SECTIONS,
  buildChildPrompt,
  insideGitRepo,
  staticPrompt,
} from "../../src/core/prompt";
import { SessionStore } from "../../src/core/session";
import { SUBAGENT_SYSTEM_PROMPT } from "../../src/core/subagent";
import { BASE_TOOL_NAMES } from "../../src/tools";

const FIXED = new Date("2026-03-04T12:00:00Z");
const ENV = { os: "linux x64", shell: "bash", isGitRepo: true, kernelMode: "trusted", planMode: false, tools: ["read", "grep", "shell"] };
const golden = (name: string): string => readFileSync(path.join(import.meta.dir, "fixtures", name), "utf8");

describe("base prompt snapshot", () => {
  test("parent prompt is byte-stable", () => {
    expect(systemPrompt("/w/proj", FIXED, ENV)).toBe(golden("system-prompt.golden.txt"));
  });
  test("child prompt is byte-stable", () => {
    expect(buildChildPrompt("/w/proj", FIXED, { ...ENV, tools: [...BASE_TOOL_NAMES] })).toBe(golden("child-prompt.golden.txt"));
  });
  test("same inputs give the same bytes", () => {
    expect(systemPrompt("/w/proj", FIXED, ENV)).toBe(systemPrompt("/w/proj", new Date(FIXED), { ...ENV }));
  });
});

describe("ordering and environment", () => {
  test("static sections come first, in table order, and the date only appears after them", () => {
    const a = systemPrompt("/w/a", new Date("2026-01-01T00:00:00Z"), ENV);
    const b = systemPrompt("/w/b", new Date("2027-02-02T00:00:00Z"), { ...ENV, planMode: true, tools: ["x"] });
    const prefix = staticPrompt();
    expect(a.startsWith(prefix)).toBe(true);
    expect(b.startsWith(prefix)).toBe(true);
    expect(prefix).not.toMatch(/20\d\d-\d\d-\d\d/);
    expect(prefix).not.toContain("/w/");
    const ids = BASE_PROMPT_SECTIONS.map((s) => s.id);
    expect(ids).toEqual(["identity", "loop", "tools", "safety", "git", "communication", "quality"]);
    let at = -1;
    for (const section of BASE_PROMPT_SECTIONS) {
      const next = a.indexOf(section.text);
      expect(next).toBeGreaterThan(at);
      at = next;
    }
    expect(a.indexOf("Environment:")).toBeGreaterThan(at);
  });
  test("environment values are rendered", () => {
    const text = systemPrompt("/w/proj", FIXED, { ...ENV, kernelMode: "untrusted", planMode: true, isGitRepo: false });
    expect(text).toContain("Working directory (workspace): /w/proj");
    expect(text).toContain("Date: 2026-03-04");
    expect(text).toContain("OS: linux x64; shell: bash");
    expect(text).toContain("Git repository: no");
    expect(text).toContain("Kernel: untrusted (in-process fallback");
    expect(text).toContain("Plan mode: on");
    expect(text).toContain("Tools: read, grep, shell");
  });
  test("required coverage is present in the static prefix", () => {
    const prefix = staticPrompt();
    for (const needle of ["unverified completion", "untrusted data", "kernel guard decides", "git status", "path:line", "placeholder", "specialized tools", "re-read"]) {
      expect(prefix.toLowerCase()).toContain(needle.toLowerCase());
    }
  });
  test("insideGitRepo walks up to a .git entry", () => {
    const root = mkdtempSync(path.join(tmpdir(), "hz-prompt-git-"));
    try {
      mkdirSync(path.join(root, ".git"));
      mkdirSync(path.join(root, "a", "b"), { recursive: true });
      expect(insideGitRepo(path.join(root, "a", "b"))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
  test("lean: the full prompt stays under the token budget", () => {
    const tokens = estimateTokens(systemPrompt("/w/proj", FIXED, ENV));
    console.log(`system prompt token estimate: ${tokens}`);
    expect(tokens).toBeLessThan(700);
  });
});

describe("child prompt", () => {
  test("states task scope, tools, no questions, report, and the no-parent-approvals rule", () => {
    const text = buildChildPrompt("/w/proj", FIXED, { ...ENV, tools: [...BASE_TOOL_NAMES] });
    expect(text).toContain("do not ask any");
    expect(text).toContain("You inherit no approvals from the parent");
    expect(text).toContain("concise report");
    expect(text).toContain(`Tools: ${BASE_TOOL_NAMES.join(", ")}`);
    expect(SUBAGENT_SYSTEM_PROMPT).toContain("subagent");
    expect(text.startsWith(SUBAGENT_SYSTEM_PROMPT)).toBe(true);
  });
});

describe("wired into the loop", () => {
  let workspace: string;
  beforeEach(() => {
    workspace = mkdtempSync(path.join(tmpdir(), "hz-prompt-ws-"));
  });
  afterEach(() => rmSync(workspace, { recursive: true, force: true }));

  test("the provider request carries the static prefix, then project memory, then the environment with the registry tools; a child inherits memory", async () => {
    const { writeFileSync } = await import("node:fs");
    writeFileSync(path.join(workspace, "AGENTS.md"), "PROJECT-RULE-XYZ\n");
    const systems: string[] = [];
    const specNames: string[][] = [];
    const fake = {
      name: "fake",
      async *stream(req: ProviderRequest) {
        systems.push(req.system);
        specNames.push(req.tools.map((t) => t.name));
        yield { type: "done" as const, stopReason: "end" as const };
      },
    };
    const kernel = new KernelClient({ workspace, stateDir: path.join(workspace, ".hzcode", "kernel") });
    const store = new SessionStore(workspace);
    const deps: LoopDeps = {
      workspace,
      sessionId: store.createSession("p").id,
      model: "fake-1",
      provider: fake,
      kernel,
      store,
      signal: new AbortController().signal,
      callbacks: { onEvent: () => undefined },
      sessionLeases: [],
      toolFilter: (name) => (BASE_TOOL_NAMES as readonly string[]).includes(name),
      maxProviderCalls: 2,
      planMode: true,
    };
    try {
      await runTurn(deps, "hello");
      const sys = systems[0] ?? "";
      expect(sys.startsWith(staticPrompt())).toBe(true);
      expect(sys).toContain(`Working directory (workspace): ${workspace}`);
      expect(sys).toContain(`Tools: ${(specNames[0] ?? []).join(", ")}`);
      expect(sys).toContain("Plan mode: on");
      expect(sys).toContain("Kernel: untrusted");
      expect(sys.indexOf("PROJECT-RULE-XYZ")).toBeLessThan(sys.indexOf("Environment:"));

      const child: LoopDeps = { ...deps, sessionId: store.createSession("c").id, planMode: false, systemOverride: buildChildPrompt(workspace, FIXED, ENV) };
      await runTurn(child, "go");
      const csys = systems[1] ?? "";
      expect(csys.startsWith("You are a focused HzCode subagent")).toBe(true);
      expect(csys).toContain("PROJECT-RULE-XYZ");
    } finally {
      await kernel.close();
      store.close();
    }
  });
});

describe("memory precedes the volatile environment", () => {
  test("toggling plan mode or tools leaves the bytes before the environment block unchanged", () => {
    const memory = "\n\nProject instruction files follow\nMEMORY-BODY\n";
    const a = systemPrompt("/w/proj", FIXED, ENV, memory);
    const b = systemPrompt("/w/proj", FIXED, { ...ENV, planMode: true, tools: ["x"] }, memory);
    const cut = (t: string) => t.slice(0, t.indexOf("MEMORY-BODY") + "MEMORY-BODY".length);
    expect(cut(a)).toBe(cut(b));
    expect(a.indexOf("MEMORY-BODY")).toBeLessThan(a.indexOf("2026"));
    expect(a).not.toBe(b);
    expect(systemPrompt("/w/proj", FIXED, ENV, "")).toBe(systemPrompt("/w/proj", FIXED, ENV));
  });
});
