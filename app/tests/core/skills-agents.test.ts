/**
 * skills-agents.test.ts — skills discovery + activation and subagent delegation.
 *
 * Everything here is hermetic: temp workspaces and a temp HOME (skills are
 * discovered there too), the local kernel fallback (no binary needed) or a
 * short-lived real kernel where receipts matter. The mock provider makes the
 * nested loop deterministic and instant.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import type { Lease, ProviderRequest, RuntimeEvent, ToolContext } from "../../src/contracts";
import { KernelClient } from "../../src/core/kernel";
import type { LoopDeps } from "../../src/core/loop";
import { runTurn } from "../../src/core/loop";
import { createMockProvider } from "../../src/core/providers";
import { SessionStore } from "../../src/core/session";
import {
  ACTIVE_SKILL_BODY_CAP,
  activeSkillSection,
  getSkill,
  listSkills,
  resolveSkillForMessage,
  skillsPromptSection,
} from "../../src/core/skills";
import { skillsDir, userSkillsDir } from "../../src/core/paths";
import type { WorkspaceTrustOptions } from "../../src/core/trust";
import { clampSteps, runNested } from "../../src/core/subagent";
import { agentTool } from "../../src/tools/agent";
import { BASE_TOOL_NAMES, getTool } from "../../src/tools";
import { hasRustKernel, rustKernelPath, setEnv } from "./helpers";

/* ------------------------------- fixtures ------------------------------- */

let workspace: string;
let home: string;
let savedHome: string | undefined;

beforeEach(() => {
  workspace = mkdtempSync(path.join(tmpdir(), "hz-skills-ws-"));
  home = mkdtempSync(path.join(tmpdir(), "hz-skills-home-"));
  savedHome = process.env.HOME;
  process.env.HOME = home;
});

afterEach(() => {
  if (savedHome === undefined) delete process.env.HOME;
  else process.env.HOME = savedHome;
  rmSync(workspace, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

function writeSkill(root: string, file: string, content: string): void {
  const dir = root === home ? userSkillsDir(home) : skillsDir(root);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, file), content, "utf8");
}

function skillTrust(): WorkspaceTrustOptions {
  return { home, trustedWorkspaceHooks: [path.resolve(workspace)] };
}

function fakeContext(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    cwd: process.cwd(),
    workspace: process.cwd(),
    sessionId: "test-session",
    signal: new AbortController().signal,
    guard: async () => ({ decision: "allow" as const }),
    approve: async () => false,
    receipt: async () => {
      throw new Error("receipt not expected in this test");
    },
    ...overrides,
  };
}

/* -------------------------------- skills -------------------------------- */

describe("skills", () => {
  test("discovers frontmatter skills, filename skills, and skips malformed files", () => {
    writeSkill(workspace, "deploy.md", "---\nname: deploy\ndescription: Ship it safely\n---\nStep one.\nStep two.\n");
    writeSkill(workspace, "notes.md", "Just a body, no frontmatter.\n");
    writeSkill(workspace, "bad name.md", "no safe filename either\n");

    const skills = listSkills(workspace, skillTrust());
    const names = skills.map((s) => s.name).sort();
    expect(names).toEqual(["deploy", "notes"]);

    const deploy = getSkill(workspace, "deploy", skillTrust());
    expect(deploy?.description).toBe("Ship it safely");
    expect(deploy?.body).toContain("Step one.");
    expect(deploy?.source.endsWith("deploy.md")).toBe(true);
    expect(getSkill(workspace, "notes", skillTrust())?.description).toBe("");
  });

  test("a workspace skill shadows a home skill with the same name", () => {
    writeSkill(home, "same.md", "---\nname: same\ndescription: from home\n---\nbody\n");
    writeSkill(workspace, "same.md", "---\nname: same\ndescription: from workspace\n---\nbody\n");
    expect(getSkill(workspace, "same", skillTrust())?.description).toBe("from workspace");
  });

  test("the prompt section is empty with no skills and capped at 12 with a note", () => {
    expect(skillsPromptSection(workspace, skillTrust())).toBe("");
    for (let i = 1; i <= 14; i += 1) {
      const n = String(i).padStart(2, "0");
      writeSkill(workspace, `skill-${n}.md`, `---\nname: skill-${n}\ndescription: number ${n}\n---\nbody\n`);
    }
    const section = skillsPromptSection(workspace, skillTrust());
    expect(section).toContain("## Available skills");
    expect(section).toContain("skill-01 — number 01");
    expect(section).toContain("(2 more not listed)");
    expect(section.split("\n").filter((line) => line.startsWith("- skill-")).length).toBe(12);
  });

  test("slash activation resolves the skill and strips the action; unknown or partial names do not", () => {
    writeSkill(workspace, "deploy.md", "---\nname: deploy\ndescription: x\n---\nbody\n");
    const hit = resolveSkillForMessage(workspace, "  /deploy push the service\nand watch it\n", skillTrust());
    expect(hit?.skill.name).toBe("deploy");
    expect(hit?.action).toBe("push the service\nand watch it");

    const bare = resolveSkillForMessage(workspace, "/deploy", skillTrust());
    expect(bare?.skill.name).toBe("deploy");
    expect(bare?.action).toBe("");

    expect(resolveSkillForMessage(workspace, "/deployment now", skillTrust())).toBeUndefined();
    expect(resolveSkillForMessage(workspace, "plain text", skillTrust())).toBeUndefined();
    expect(resolveSkillForMessage(workspace, "/unknown-skill x", skillTrust())).toBeUndefined();
  });

  test("the active-skill section carries the body, capped at the contract size", () => {
    const body = "x".repeat(ACTIVE_SKILL_BODY_CAP + 500);
    writeSkill(workspace, "big.md", `---\nname: big\n---\n${body}\n`);
    const skill = getSkill(workspace, "big");
    expect(skill).toBeDefined();
    const section = activeSkillSection(skill!);
    expect(section.startsWith("## Active skill: big")).toBe(true);
    expect(section).toContain("[skill truncated]");
    expect(section.length).toBeLessThan(body.length);
  });
});

/* ---------------------------- loop plumbing ----------------------------- */

describe("loop: skills and filter plumbing", () => {
  test("systemExtra lands in the provider request, systemOverride replaces it, toolFilter hides tools", async () => {
    const systems: string[] = [];
    const toolLists: string[][] = [];
    const fake = {
      name: "fake",
      async *stream(req: ProviderRequest) {
        systems.push(req.system);
        toolLists.push(req.tools.map((t) => t.name));
        yield { type: "done" as const, stopReason: "end" as const };
      },
    };
    const kernel = new KernelClient({ workspace, stateDir: path.join(workspace, ".hzcode", "kernel") }); // local fallback
    const store = new SessionStore(workspace);
    const deps: LoopDeps = {
      workspace,
      sessionId: store.createSession("plumbing").id,
      model: "fake-1",
      provider: fake,
      kernel,
      store,
      signal: new AbortController().signal,
      callbacks: { onEvent: () => undefined },
      sessionLeases: [],
      systemExtra: "## Available skills\n- demo — x",
      // The subagent filter: exactly the seven base tools, nothing else.
      toolFilter: (name) => (BASE_TOOL_NAMES as readonly string[]).includes(name),
      maxProviderCalls: 3,
    };
    try {
      await runTurn(deps, "hello");
      expect(systems[0]).toContain("You are HzCode");
      expect(systems[0]).toContain("## Available skills");
      expect(toolLists[0]).toEqual(["read", "write", "edit", "grep", "glob", "shell", "todo"]);

      const childDeps: LoopDeps = { ...deps, sessionId: store.createSession("child").id, systemOverride: "CHILD PROMPT", systemExtra: "## Available skills\n- hidden?" };
      await runTurn(childDeps, "go");
      expect(systems[1]?.startsWith("CHILD PROMPT")).toBe(true);
    } finally {
      await kernel.close();
      store.close();
    }
  });

  test("a child effect re-enters the approval path: parent session leases are not inherited (R-tools-32)", async () => {
    const kernel = new KernelClient({ workspace, stateDir: path.join(workspace, ".hzcode", "kernel") });
    const store = new SessionStore(workspace);
    const controller = new AbortController();
    const outside = mkdtempSync(path.join(tmpdir(), "hz-subagent-outside-"));
    const target = path.join(outside, "written.txt");
    const approvals: string[] = [];
    let turn = 0;
    const provider = {
      name: "scripted-child",
      async *stream() {
        // Advance before yielding: a consumer that stops at `done` abandons the
        // generator body, so a post-yield increment would never run.
        const current = turn;
        turn += 1;
        if (current === 0) {
          yield { type: "tool_call" as const, id: "w1", name: "write", arguments: JSON.stringify({ path: target, content: "child data" }) };
          yield { type: "done" as const, stopReason: "tool_use" as const };
        } else {
          yield { type: "text" as const, text: "reported" };
          yield { type: "done" as const, stopReason: "end" as const };
        }
      },
    };
    // What the parent's "always" answer produces: a wildcard session lease.
    // The child must not inherit it — its own write has to ask.
    const parentLease: Lease = {
      leaseId: "parent-always-lease",
      kind: "fs.write",
      pattern: "*",
      expiry: new Date(Date.now() + 15 * 60_000).toISOString(),
    };
    try {
      const result = await runNested({
        workspace,
        task: "write the file",
        model: "scripted-1",
        provider,
        kernel,
        store,
        signal: controller.signal,
        sessionLeases: [parentLease],
        approve: async (req) => {
          approvals.push(req.title);
          return true;
        },
      });
      expect(result.ok).toBe(true);
      expect(approvals.length).toBe(1);
      expect(approvals[0]).toContain("written.txt");
      expect(readFileSync(target, "utf8")).toBe("child data");
    } finally {
      await kernel.close();
      store.close();
      rmSync(outside, { recursive: true, force: true });
    }
  });
});

/* ------------------------------- agent tool ------------------------------- */

describe("agent tool", () => {
  test("is registered and clamps steps: default 12, cap 20, floor 1; missing task and no delegate fail closed", async () => {
    expect(getTool("agent")).toBe(agentTool);

    const seen: Array<{ task: string; steps?: number }> = [];
    const delegate = async (task: string, steps?: number) => {
      seen.push({ task, steps });
      return { ok: true, output: `done: ${task}` };
    };
    const capped = await agentTool.execute({ task: "research x", max_steps: 99 }, fakeContext({ delegate }));
    expect(capped.ok).toBe(true);
    expect(capped.output).toBe("done: research x");
    expect(seen[0]?.steps).toBe(20);

    await agentTool.execute({ task: "y" }, fakeContext({ delegate }));
    expect(seen[1]?.steps).toBe(12);

    await agentTool.execute({ task: "z", max_steps: -3 }, fakeContext({ delegate }));
    expect(seen[2]?.steps).toBe(1);

    expect((await agentTool.execute({}, fakeContext({ delegate }))).ok).toBe(false);
    expect((await agentTool.execute({ task: "q" }, fakeContext())).ok).toBe(false);
  });

  test("clampSteps is the same rule, exported for the runner", () => {
    expect(clampSteps()).toBe(12);
    expect(clampSteps(5)).toBe(5);
    expect(clampSteps(99)).toBe(20);
    expect(clampSteps(0)).toBe(1);
    expect(clampSteps(Number.NaN)).toBe(12);
  });
});

/* ------------------------- nested run, end to end ------------------------ */

describe("delegation end to end", () => {
  test("agent tool -> nested run: child session, tool use through the guard, receipts, final report", async () => {
    const kernel = new KernelClient({ workspace, stateDir: path.join(workspace, ".hzcode", "kernel") });
    await kernel.start(); // trusted when the binary exists; fallback otherwise — either is valid here
    const store = new SessionStore(workspace);
    const controller = new AbortController();
    const provider = createMockProvider();
    try {
      // An empty task fails before any session exists.
      const empty = await runNested({
        workspace, task: "   ", model: "mock-1", provider, kernel, store,
        signal: controller.signal, sessionLeases: [],
      });
      expect(empty.ok).toBe(false);
      expect(store.listSessions().length).toBe(0);

      // The tool layer delegates through the same runner the runtime wires up.
      const ctx = fakeContext({
        delegate: (task, steps) =>
          runNested({ workspace, task, maxSteps: steps, model: "mock-1", provider, kernel, store, signal: controller.signal, sessionLeases: [] }),
      });
      const result = await agentTool.execute({ task: "list files", max_steps: 5 }, ctx);
      expect(result.ok).toBe(true);
      expect(result.output.length).toBeGreaterThan(0);
      expect(result.output).toContain("Mock mode");

      // The child got its own titled session and its own transcript.
      const child = store.listSessions().find((s) => s.title.startsWith("subagent:"));
      expect(child).toBeDefined();
      const history = store.history(child!.id);
      expect(history[0]?.role).toBe("user");
      expect(history[0]?.content).toBe("list files");
      expect(history.some((m) => m.role === "tool" && m.toolName === "glob")).toBe(true);
      expect(history[history.length - 1]?.role).toBe("assistant");

      // And every tool it ran left a receipt in the same chain.
      const receipts = await kernel.verifyReceipts();
      expect(receipts.ok).toBe(true);
      expect(receipts.count).toBeGreaterThanOrEqual(1);
      // The child's event stream verifies too.
      const streamCheck = await kernel.verifyEventChain(`session:${child!.id}`);
      expect(streamCheck.ok).toBe(true);
      expect(streamCheck.count).toBeGreaterThanOrEqual(4);
    } finally {
      await kernel.close();
      store.close();
    }
  });

  // The kernel-held shape of the same rule: the parent's "always" lives in the
  // kernel's own lease table (owner-scoped), so a *different* session — the
  // child's — must re-enter approval in both transports.
  for (const mode of ["trusted", "untrusted"] as const) {
    test.skipIf(mode === "trusted" && !hasRustKernel)(
      `${mode}: a parent's kernel-held 'always' lease does not answer the child's checks`,
      async () => {
        const previous = process.env.HZ_KERNEL_BIN;
        setEnv({
          HZ_KERNEL_BIN: mode === "trusted" ? rustKernelPath : path.join(tmpdir(), "hz-no-such-bin", "hz-kernel"),
        });
        const kernel = new KernelClient({ workspace, stateDir: path.join(workspace, ".hzcode", "kernel") });
        const store = new SessionStore(workspace);
        const outside = mkdtempSync(path.join(tmpdir(), "hz-subagent-owned-"));
        const target = path.join(outside, "owned.txt");
        const approvals: string[] = [];
        let turn = 0;
        const provider = {
          name: "scripted-owned",
          async *stream() {
            const current = turn;
            turn += 1;
            if (current === 0) {
              yield { type: "tool_call" as const, id: "w1", name: "write", arguments: JSON.stringify({ path: target, content: "child data" }) };
              yield { type: "done" as const, stopReason: "tool_use" as const };
            } else {
              yield { type: "text" as const, text: "reported" };
              yield { type: "done" as const, stopReason: "end" as const };
            }
          },
        };
        try {
          expect(await kernel.start()).toBe(mode);
          const parentSession = store.createSession("parent").id;
          const parentLease = await kernel.makeLease("fs.write", target, 15 * 60_000, parentSession);
          // The lease is live FOR THE PARENT — so the child's ask below is about
          // owner scoping, not about a dead grant.
          const forParent = await kernel.checkGuard({ kind: "fs.write", target }, "outside", [], parentSession);
          expect(forParent.decision).toBe("allow");
          expect(forParent.leaseId).toBe(parentLease.leaseId);

          const result = await runNested({
            workspace,
            task: "write the owned file",
            model: "scripted-1",
            provider,
            kernel,
            store,
            signal: new AbortController().signal,
            sessionLeases: [],
            approve: async (req) => {
              approvals.push(req.title);
              return true;
            },
          });
          expect(result.ok).toBe(true);
          expect(approvals.length).toBe(1);
          expect(approvals[0]).toContain("owned.txt");
          expect(readFileSync(target, "utf8")).toBe("child data");
        } finally {
          store.close();
          rmSync(outside, { recursive: true, force: true });
          await kernel.close();
          setEnv({ HZ_KERNEL_BIN: previous });
        }
      },
    );
  }

  test("an aborted signal ends the nested run without throwing", async () => {
    const kernel = new KernelClient({ workspace, stateDir: path.join(workspace, ".hzcode", "kernel") });
    const store = new SessionStore(workspace);
    const controller = new AbortController();
    controller.abort();
    try {
      const result = await runNested({
        workspace, task: "list files", model: "mock-1", provider: createMockProvider(), kernel, store,
        signal: controller.signal, sessionLeases: [],
      });
      expect(result.ok).toBe(false);
      expect(result.error).toContain("aborted");
    } finally {
      await kernel.close();
      store.close();
    }
  });
});
