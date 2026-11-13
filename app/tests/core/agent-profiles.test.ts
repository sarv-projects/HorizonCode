/**
 * agent-profiles.test.ts: specialised agent presets (docs/15 §3.6, docs/30
 * §5.11). Revert check: removing the `profile` plumbing (tool arg, allow-list
 * filter, ceiling check, catalog, card name) fails the matching case below.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { RuntimeEvent } from "../../src/contracts";
import {
  BUILTIN_PRESETS,
  loadPresets,
  parsePresetFile,
  presetCatalog,
  presetCeiling,
  resolvePreset,
} from "../../src/core/agent-profiles";
import { createRuntime } from "../../src/core/index";
import { createScriptedProvider, textTurn, toolCallTurn } from "../../src/core/providers/scripted";
import { staticPrompt } from "../../src/core/prompt";
import { createRenderer } from "../../src/tui/render";
import { agentTool } from "../../src/tools/agent";
import { cleanupTemps, tempDir } from "./helpers";

afterAll(() => cleanupTemps());

function put(dir: string, name: string, text: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, name), text);
}

const READ_ONLY_FORBIDDEN = ["write", "edit", "shell", "apply_patch", "ast_edit", "undo", "agent"];

describe("built-in presets", () => {
  test("explore, plan, code and review exist; read-only ones hold no mutating tool; none holds agent", () => {
    const by = new Map(BUILTIN_PRESETS.map((p) => [p.name, p]));
    expect([...by.keys()].sort()).toEqual(["code", "explore", "never", "plan", "review"]);
    expect(by.get("never")!.tools).toEqual(["grep", "glob"]);
    for (const name of ["explore", "plan", "review"]) {
      const tools = by.get(name)!.tools;
      expect(tools).toEqual(expect.arrayContaining(["read", "grep", "glob", "repo_map", "ast_search", "lsp"]));
      for (const bad of READ_ONLY_FORBIDDEN) expect(tools).not.toContain(bad);
    }
    expect(by.get("code")!.tools).toEqual(expect.arrayContaining(["write", "edit", "shell"]));
    expect(by.get("code")!.tools).not.toContain("agent");
  });

  test("every built-in only narrows the ceiling", () => {
    const ceiling = new Set(presetCeiling());
    for (const p of BUILTIN_PRESETS) for (const t of p.tools) expect(ceiling.has(t)).toBe(true);
    expect(ceiling.has("agent")).toBe(false);
  });
});

describe("user presets", () => {
  const good = "---\nname: docs\ndescription: reads docs\ntools: read, grep\nmodel: m-small\nmax_steps: 5\n---\nOnly read docs.\n";

  test("parse front-matter into a preset; the body is the prompt", () => {
    const p = parsePresetFile(good, "x", "user");
    expect(typeof p).toBe("object");
    expect(p).toMatchObject({ name: "docs", tools: ["read", "grep"], model: "m-small", maxSteps: 5, prompt: "Only read docs.", source: "user" });
  });

  test("a preset naming a tool outside the ceiling is refused as profile_ceiling_widens", () => {
    const r = parsePresetFile(good.replace("read, grep", "read, mcp_evil, agent"), "x", "user");
    expect(r).toBe("profile_ceiling_widens: mcp_evil, agent");
  });

  test("malformed files are refused with a reason", () => {
    expect(parsePresetFile("no front matter", "x", "user")).toBe("missing front-matter");
    expect(parsePresetFile("---\nname: a\n---\nbody", "x", "user")).toBe("tools is required");
    expect(parsePresetFile("---\ntools: read\n---\n", "x", "user")).toBe("prompt body is empty");
    expect(typeof parsePresetFile("---\nname: Bad Name\ntools: read\n---\nb", "x", "user")).toBe("string");
  });

  test("loaded from the user config dir and workspace .hz only; widening and shadowing files are refused", () => {
    const home = tempDir("hz-prof-home-");
    const ws = tempDir("hz-prof-ws-");
    put(path.join(home, ".config", "horizon", "agents"), "docs.md", good);
    put(path.join(ws, ".hz", "agents"), "wide.md", good.replace("name: docs", "name: wide").replace("read, grep", "read, shell, nope"));
    put(path.join(ws, ".hz", "agents"), "explore.md", good.replace("name: docs", "name: explore"));
    put(path.join(ws, ".hz", "agents"), "ok.md", good.replace("name: docs", "name: local").replace("read, grep", "read, shell"));
    put(path.join(ws, "agents"), "outside.md", good.replace("name: docs", "name: outside"));
    const set = loadPresets(ws, { home });
    expect(set.presets.get("docs")?.source).toBe("user");
    expect(set.presets.get("local")?.source).toBe("workspace");
    expect(set.presets.get("local")?.model).toBeUndefined();
    expect(set.presets.get("docs")?.model).toBe("m-small");
    expect(set.presets.has("wide")).toBe(false);
    expect(set.presets.has("outside")).toBe(false);
    expect(set.presets.get("explore")?.source).toBe("builtin");
    expect(set.refused.map((r) => r.name).sort()).toEqual(["explore", "wide"]);
    const r = resolvePreset(ws, "wide", { home });
    expect(r).toEqual({ ok: false, error: expect.stringContaining("profile_ceiling_widens: nope") });
    expect(resolvePreset(ws, "zzz", { home })).toEqual({ ok: false, error: expect.stringContaining("unknown profile") });
  });

  test("the catalog lists built-in and user presets for the tool description", () => {
    const home = tempDir("hz-prof-home2-");
    const ws = tempDir("hz-prof-ws2-");
    put(path.join(ws, ".hz", "agents"), "docs.md", good);
    const text = presetCatalog(ws, { home });
    expect(text).toContain("- explore:");
    expect(text).toContain("- review:");
    expect(text).toContain("- docs [workspace]: reads docs");
  });
});

describe("the agent tool", () => {
  test("declares an optional profile and forwards it to the delegate", async () => {
    expect((agentTool.parameters as { properties: Record<string, unknown> }).properties.profile).toBeDefined();
    expect((agentTool.parameters as { required: string[] }).required).toEqual(["task"]);
    let seen: unknown[] = [];
    const ctx = { delegate: async (...a: unknown[]) => ((seen = a), { ok: true, output: "k" }) } as never;
    await agentTool.execute({ task: "t", profile: " review " }, ctx);
    expect(seen[2]).toBe("review");
    await agentTool.execute({ task: "t" }, ctx);
    expect(seen[2]).toBeUndefined();
    const bad = await agentTool.execute({ task: "t", profile: 3 }, ctx);
    expect(bad.ok).toBe(false);
  });
});

describe("delegated run with a profile", () => {
  async function run(workspace: string, script: ReturnType<typeof createScriptedProvider>, events: RuntimeEvent[]) {
    const runtime = await createRuntime({ workspace, mock: true, model: "mistral-7b-instruct" });
    (runtime as unknown as { provider: unknown }).provider = script;
    runtime.setApprovalHandler(async () => true);
    try {
      await runtime.send("delegate", { onEvent: (ev) => events.push(ev) });
    } finally {
      await runtime.close();
    }
  }

  test("explore child sees only its allow-list, a write call is refused, and the profile rides the events", async () => {
    const ws = tempDir("hz-prof-run-");
    const script = createScriptedProvider([
      toolCallTurn({ name: "agent", args: { task: "find x", profile: "explore" } }),
      toolCallTurn({ name: "write", args: { path: "pwn.txt", content: "x" } }),
      textTurn("findings"),
      textTurn("parent done"),
    ]);
    const events: RuntimeEvent[] = [];
    await run(ws, script, events);
    const reqs = script.requests();
    const parent = reqs[0];
    const agentSpec = parent.tools.find((t) => t.name === "agent")!;
    expect(agentSpec.description).toContain("- explore:");
    expect(agentSpec.description).toContain("- review:");
    const child = reqs[1];
    expect(child.tools.map((t) => t.name).sort()).toEqual(["ast_search", "glob", "grep", "lsp", "read", "repo_map"]);
    expect(child.system).toContain("Profile: explore.");
    expect(child.system).toContain("READ-ONLY");
    expect(await Bun.file(path.join(ws, "pwn.txt")).exists()).toBe(false);
    const nested = events.filter((e) => e.type === "subagent.event") as Extract<RuntimeEvent, { type: "subagent.event" }>[];
    expect(nested.length).toBeGreaterThan(0);
    expect(nested.every((n) => n.profile === "explore")).toBe(true);
    const refused = nested.some((n) => n.event.type === "tool.card" && n.event.name === "write" && n.event.status === "error");
    expect(refused).toBe(true);
  }, 30000);

  test("a workspace preset narrows to its tools and carries its prompt; a widening preset fails the call", async () => {
    const ws = tempDir("hz-prof-run2-");
    put(path.join(ws, ".hz", "agents"), "docs.md", "---\nname: docs\ntools: read\nmax_steps: 3\n---\nOnly read docs.\n");
    put(path.join(ws, ".hz", "agents"), "wide.md", "---\nname: wide\ntools: read, secret_tool\n---\nbody\n");
    const script = createScriptedProvider([
      toolCallTurn({ name: "agent", args: { task: "a", profile: "docs", max_steps: 9 } }),
      textTurn("child ok"),
      toolCallTurn({ name: "agent", args: { task: "b", profile: "wide" } }),
      toolCallTurn({ name: "agent", args: { task: "c", profile: "nope" } }),
      textTurn("parent done"),
    ]);
    const events: RuntimeEvent[] = [];
    await run(ws, script, events);
    const reqs = script.requests();
    expect(reqs[1].tools.map((t) => t.name)).toEqual(["read"]);
    expect(reqs[1].system).toContain("Only read docs.");
    const results = JSON.stringify(reqs[reqs.length - 1].messages);
    expect(results).toContain("profile_ceiling_widens: secret_tool");
    expect(results).toContain("unknown profile");
  }, 30000);

  test("no profile keeps the generic seven-tool child", async () => {
    const ws = tempDir("hz-prof-run3-");
    const script = createScriptedProvider([
      toolCallTurn({ name: "agent", args: { task: "a" } }),
      textTurn("child"),
      textTurn("done"),
    ]);
    await run(ws, script, []);
    expect(script.requests()[1].tools.map((t) => t.name).sort()).toEqual(["edit", "glob", "grep", "read", "shell", "todo", "write"]);
  }, 30000);
});

describe("TUI card and base prompt", () => {
  test("the profile name is shown once before a profiled child's lines", () => {
    const chunks: string[] = [];
    const r = createRenderer({ wrap: false, out: (c: string) => void chunks.push(c) });
    const ev = (n: string) => ({
      type: "subagent.event" as const, agentId: "a1", name: "agent", depth: 1, profile: "review",
      event: { type: "notice" as const, message: n },
    });
    r.handle(ev("one"));
    r.handle(ev("two"));
    // eslint-disable-next-line no-control-regex
    const plain = chunks.join("").replace(/\x1b\[[0-9;]*m/g, "");
    expect(plain.match(/profile: review/g)?.length).toBe(1);
    expect(plain.indexOf("profile: review")).toBeLessThan(plain.indexOf("one"));
  });

  test("the base prompt tells the main agent when to delegate", () => {
    expect(staticPrompt()).toContain("profile explore for broad search");
    expect(staticPrompt()).toContain("profile review before you finish a larger change");
  });
});
