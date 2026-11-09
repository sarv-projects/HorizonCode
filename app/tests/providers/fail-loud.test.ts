/**
 * fail-loud.test.ts — makeProvider never turns a typo into a fake chat.
 *
 * The named bug (CURRENT_RUN.md §11): makeProvider()'s `default:` arm used to
 * return the offline mock for ANY unknown provider id, so a typo'd HZ_PROVIDER
 * (e.g. "groq") silently became a mock conversation. The fix emits an error
 * event naming the unknown id and listing the valid providers, then ends the
 * turn — mirroring the existing missingKeyProvider() shape. The mock stays
 * reachable ONLY through the --mock flag or an explicit HZ_PROVIDER=mock.
 *
 * NOTE: config.ts's normalizeProvider() currently coerces an unknown
 * HZ_PROVIDER to undefined (so the config LAYER falls back to mock before
 * makeProvider ever sees it). To exercise makeProvider's `default:` arm
 * directly, this test constructs an HzConfig with an unknown `provider` string
 * through a cast on the cfg() helper. FEAT-002 makes the config layer actually
 * surface registry/unknown ids, at which point this path is reachable end to
 * end without the cast.
 */

import { describe, expect, test } from "bun:test";
import type { HzConfig } from "../../src/core/config";
import { PROVIDER_NAMES } from "../../src/core/config";
import { makeProvider } from "../../src/core/providers/index";
import { MOCK_GREETING } from "../../src/core/providers/mock";
import type { Provider, ProviderEvent } from "../../src/contracts";
import { makeRequest, run, textOf } from "./helpers";

function cfg(overrides: Partial<HzConfig> = {}): HzConfig {
  return {
    provider: "mock",
    model: "mock-1",
    sources: { provider: "default", model: "default", baseUrl: "default", apiKey: "none" },
    ...overrides,
  };
}

/** cfg() but with an unknown provider id (cast past the ProviderName union). */
function cfgUnknown(id: string): HzConfig {
  return cfg({ provider: id as HzConfig["provider"] });
}

async function collect(provider: Provider, req = makeRequest()): Promise<ProviderEvent[]> {
  const result = run(provider, req);
  await result.done;
  expect(result.thrown).toBeNull();
  return result.events;
}

describe("makeProvider fail-loud default", () => {
  test("an unknown provider id yields an error naming the id and the valid providers, then done", async () => {
    const provider = makeProvider(cfgUnknown("groq-typo"));
    expect(provider.name).toBe("groq-typo");

    const events = await collect(provider);
    expect(events).toHaveLength(2);

    const error = events[0]!;
    if (error.type !== "error") throw new Error(`expected an error event, got ${JSON.stringify(error)}`);
    expect(error.message).toContain("groq-typo");
    for (const name of PROVIDER_NAMES) expect(error.message).toContain(name);

    expect(events[1]).toEqual({ type: "done", stopReason: "end" });
  });

  test("an unknown provider never produces MOCK_GREETING", async () => {
    const events = await collect(makeProvider(cfgUnknown("groq-typo")));
    expect(textOf(events)).not.toBe(MOCK_GREETING);
    expect(events.some((e) => e.type === "text" && e.text === MOCK_GREETING)).toBe(false);
  });

  test("the mock is still returned for the explicit --mock flag", async () => {
    const provider = makeProvider(cfgUnknown("groq-typo"), { mockFlag: true });
    expect(provider.name).toBe("mock");
    const events = await collect(provider);
    expect(events).toEqual([{ type: "text", text: MOCK_GREETING }, { type: "done", stopReason: "end" }]);
  });

  test("the mock is still returned for an explicit HZ_PROVIDER=mock", async () => {
    const provider = makeProvider(cfg({ provider: "mock" }));
    expect(provider.name).toBe("mock");
    const events = await collect(provider);
    expect(events).toEqual([{ type: "text", text: MOCK_GREETING }, { type: "done", stopReason: "end" }]);
  });
});
