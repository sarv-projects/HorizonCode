/**
 * H-1 / ruling 472: accepts_settings negotiation strips unsupported optional
 * provider params (warning, not a provider 400).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import type { Provider, ProviderEvent, ProviderRequest } from "../../src/contracts";
import {
  negotiateAcceptsSettings,
  negotiateReasoningEffort,
  parseCheckModelAcceptsSettingsFlag,
  resolveCatalogAcceptsSettings,
} from "../../src/core/catalog/accepts-settings";
import { catalogModel, curatedCatalog, decodeModel } from "../../src/core/catalog/catalog";
import { KernelClient } from "../../src/core/kernel";
import { runTurn, type LoopDeps } from "../../src/core/loop";
import { SessionStore } from "../../src/core/session";

let workspace: string;

beforeEach(() => {
  workspace = mkdtempSync(path.join(tmpdir(), "hz-accepts-"));
});

afterEach(() => {
  rmSync(workspace, { recursive: true, force: true });
});

describe("resolveCatalogAcceptsSettings", () => {
  test("explicit acceptsSettings wins (including empty)", () => {
    expect(
      resolveCatalogAcceptsSettings({
        id: "m",
        provider: "p",
        limit: { context: 1 },
        acceptsSettings: [],
        capabilities: { reasoning: true },
      }),
    ).toEqual([]);
    expect(
      resolveCatalogAcceptsSettings({
        id: "m",
        provider: "p",
        limit: { context: 1 },
        acceptsSettings: ["reasoning_effort"],
        capabilities: { reasoning: false },
      }),
    ).toEqual(["reasoning_effort"]);
  });

  test("derives from capabilities.reasoning when acceptsSettings absent", () => {
    expect(
      resolveCatalogAcceptsSettings({
        id: "m",
        provider: "p",
        limit: { context: 1 },
        capabilities: { reasoning: true },
      }),
    ).toEqual(["reasoning_effort"]);
    expect(
      resolveCatalogAcceptsSettings({
        id: "m",
        provider: "p",
        limit: { context: 1 },
        capabilities: { reasoning: false },
      }),
    ).toEqual([]);
  });

  test("undefined model or unknown caps is permissive (undefined)", () => {
    expect(resolveCatalogAcceptsSettings(undefined)).toBeUndefined();
    expect(
      resolveCatalogAcceptsSettings({ id: "m", provider: "p", limit: { context: 1 } }),
    ).toBeUndefined();
  });

  test("curated floor declares accepts_settings as DATA", () => {
    const catalog = curatedCatalog();
    expect(catalogModel(catalog, "anthropic", "claude-sonnet-4-5")?.acceptsSettings).toEqual([
      "reasoning_effort",
    ]);
    expect(catalogModel(catalog, "openai", "gpt-4o-mini")?.acceptsSettings).toEqual([]);
    expect(resolveCatalogAcceptsSettings(catalogModel(catalog, "openai", "gpt-4o-mini"))).toEqual([]);
    expect(
      resolveCatalogAcceptsSettings(catalogModel(catalog, "google", "gemini-2.5-flash")),
    ).toEqual(["reasoning_effort"]);
  });
});

describe("decodeModel accepts_settings", () => {
  test("decodes snake_case and camelCase arrays", () => {
    const snake = decodeModel("p", "m", {
      id: "m",
      limit: { context: 8 },
      accepts_settings: ["reasoning_effort", ""],
    });
    expect(typeof snake).not.toBe("string");
    if (typeof snake === "string") return;
    expect(snake.acceptsSettings).toEqual(["reasoning_effort"]);

    const camel = decodeModel("p", "m", {
      id: "m",
      limit: { context: 8 },
      acceptsSettings: ["reasoning_effort"],
    });
    expect(typeof camel).not.toBe("string");
    if (typeof camel === "string") return;
    expect(camel.acceptsSettings).toEqual(["reasoning_effort"]);
  });

  test("empty array is preserved (explicit refuse-all)", () => {
    const decoded = decodeModel("p", "m", {
      id: "m",
      limit: { context: 8 },
      accepts_settings: [],
    });
    expect(typeof decoded).not.toBe("string");
    if (typeof decoded === "string") return;
    expect(decoded.acceptsSettings).toEqual([]);
  });
});

describe("negotiateAcceptsSettings", () => {
  test("keeps reasoning_effort when accepted", () => {
    const result = negotiateAcceptsSettings(
      { reasoning_effort: "high" },
      ["reasoning_effort"],
      { modelName: "claude-sonnet-4-5" },
    );
    expect(result.accepted).toEqual({ reasoning_effort: "high" });
    expect(result.stripped).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  test("strips unsupported reasoning_effort with a warning", () => {
    const result = negotiateAcceptsSettings(
      { reasoning_effort: "high" },
      [],
      { modelName: "gpt-4o-mini" },
    );
    expect(result.accepted).toEqual({});
    expect(result.stripped).toEqual(["reasoning_effort"]);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain("gpt-4o-mini");
    expect(result.warnings[0]).toContain("reasoning_effort");
    expect(result.warnings[0]).toContain("HZ_CHECK_MODEL_ACCEPTS_SETTINGS=0");
  });

  test("undefined accepts is permissive (no strip)", () => {
    const result = negotiateAcceptsSettings(
      { reasoning_effort: "medium" },
      undefined,
      { modelName: "unknown-model" },
    );
    expect(result.accepted).toEqual({ reasoning_effort: "medium" });
    expect(result.stripped).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  test("check=false force-sends unsupported params", () => {
    const result = negotiateAcceptsSettings(
      { reasoning_effort: "low" },
      [],
      { modelName: "gpt-4o-mini", check: false },
    );
    expect(result.accepted).toEqual({ reasoning_effort: "low" });
    expect(result.stripped).toEqual([]);
    expect(result.warnings).toEqual([]);
  });
});

describe("negotiateReasoningEffort + flag parse", () => {
  test("convenience wrapper strips or keeps", () => {
    expect(negotiateReasoningEffort("high", ["reasoning_effort"]).effort).toBe("high");
    expect(negotiateReasoningEffort("high", []).effort).toBeUndefined();
    expect(negotiateReasoningEffort("high", []).warnings[0]).toContain("reasoning_effort");
    expect(negotiateReasoningEffort(undefined, []).warnings).toEqual([]);
  });

  test("parseCheckModelAcceptsSettingsFlag default-on", () => {
    expect(parseCheckModelAcceptsSettingsFlag(undefined)).toBe(true);
    expect(parseCheckModelAcceptsSettingsFlag("1")).toBe(true);
    expect(parseCheckModelAcceptsSettingsFlag("0")).toBe(false);
    expect(parseCheckModelAcceptsSettingsFlag("off")).toBe(false);
  });
});

describe("loop wire — strip unsupported reasoning_effort", () => {
  test("empty accepts_settings strips effort and emits a notice", async () => {
    const captured: ProviderRequest[] = [];
    const notices: string[] = [];
    const provider: Provider = {
      name: "openai",
      async *stream(req) {
        captured.push(req);
        const done: ProviderEvent = { type: "done", stopReason: "end" };
        yield done;
      },
    };
    const kernel = new KernelClient({ workspace, stateDir: path.join(workspace, ".hzcode", "kernel") });
    const store = new SessionStore(workspace);
    const deps: LoopDeps = {
      workspace,
      sessionId: store.createSession("accepts").id,
      model: "gpt-4o-mini",
      provider,
      kernel,
      store,
      signal: new AbortController().signal,
      callbacks: {
        onEvent: (ev) => {
          if (ev.type === "notice" && typeof ev.message === "string") notices.push(ev.message);
        },
      },
      sessionLeases: [],
      approve: async () => true,
      thinkingEffort: "high",
      acceptsSettings: [],
    };
    try {
      await runTurn(deps, "hello");
      expect(captured).toHaveLength(1);
      expect(captured[0]?.reasoningEffort).toBeUndefined();
      expect(notices.some((n) => n.includes("reasoning_effort") && n.includes("gpt-4o-mini"))).toBe(true);
    } finally {
      await kernel.close();
      store.close();
    }
  });

  test("accepted reasoning_effort reaches the provider request", async () => {
    const captured: ProviderRequest[] = [];
    const provider: Provider = {
      name: "anthropic",
      async *stream(req) {
        captured.push(req);
        yield { type: "done", stopReason: "end" } satisfies ProviderEvent;
      },
    };
    const kernel = new KernelClient({ workspace, stateDir: path.join(workspace, ".hzcode", "kernel") });
    const store = new SessionStore(workspace);
    const deps: LoopDeps = {
      workspace,
      sessionId: store.createSession("accepts-ok").id,
      model: "claude-sonnet-4-5",
      provider,
      kernel,
      store,
      signal: new AbortController().signal,
      callbacks: { onEvent: () => {} },
      sessionLeases: [],
      approve: async () => true,
      thinkingEffort: "medium",
      acceptsSettings: ["reasoning_effort"],
    };
    try {
      await runTurn(deps, "hello");
      expect(captured[0]?.reasoningEffort).toBe("medium");
    } finally {
      await kernel.close();
      store.close();
    }
  });
});
