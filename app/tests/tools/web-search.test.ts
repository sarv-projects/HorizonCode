/**
 * web_search — guard admission, DDG/Brave parse, injected fetch, env-gated backend.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { guardTargetForWebSearchQuery } from "../../src/tools/web-search-posture";
import {
  __setWebSearchHttpForTests,
  parseBraveSearchJson,
  parseDuckDuckGoHtml,
  searchRequestUrl,
  webSearchTool,
} from "../../src/tools/web-search";
import { mockToolContext } from "./helpers";

afterEach(() => {
  __setWebSearchHttpForTests(undefined);
  delete process.env.HZ_WEB_SEARCH;
  delete process.env.HZ_WEB_SEARCH_URL;
  delete process.env.HZ_WEB_SEARCH_ENDPOINT;
  delete process.env.HZ_WEB_SEARCH_PROVIDER;
  delete process.env.HZ_WEB_SEARCH_API_KEY;
  delete process.env.BRAVE_SEARCH_API_KEY;
});

describe("web_search", () => {
  test("default backend is disabled (fail-closed)", async () => {
    expect(searchRequestUrl("horizon code")).toBeUndefined();
    expect(guardTargetForWebSearchQuery("q", process.env)).toBeUndefined();
    const ctx = mockToolContext({ decision: "allow" });
    const r = await webSearchTool.execute({ query: "test" }, ctx);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/not configured/i);
  });

  test("searchRequestUrl uses DuckDuckGo HTML when HZ_WEB_SEARCH=1", () => {
    process.env.HZ_WEB_SEARCH = "1";
    expect(searchRequestUrl("horizon code")).toBe("https://html.duckduckgo.com/html/?q=horizon%20code");
  });

  test("parseDuckDuckGoHtml extracts title, url, snippet", () => {
    const html = `
      <div class="result">
        <div class="result__body">
          <a class="result__a" href="https://duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fdoc">Example title</a>
          <a class="result__snippet">A helpful snippet here.</a>
        </div>
      </div>`;
    const rows = parseDuckDuckGoHtml(html, 5);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.url).toBe("https://example.com/doc");
    expect(rows[0]!.title).toContain("Example title");
    expect(rows[0]!.snippet).toContain("helpful snippet");
  });

  test("parseBraveSearchJson extracts results", () => {
    const json = JSON.stringify({
      web: { results: [{ title: "Brave hit", url: "https://example.com/b", description: "Desc" }] },
    });
    const rows = parseBraveSearchJson(json, 5);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.title).toBe("Brave hit");
    expect(rows[0]!.snippet).toBe("Desc");
  });

  test("net.fetch guard deny blocks before HTTP", async () => {
    process.env.HZ_WEB_SEARCH = "1";
    const ctx = mockToolContext({
      decision: (action) =>
        action.kind === "net.fetch" ? { decision: "deny", reason: "no-search" } : { decision: "allow" },
    });
    let called = false;
    __setWebSearchHttpForTests(async () => {
      called = true;
      return new Response("nope");
    });
    const r = await webSearchTool.execute({ query: "test" }, ctx);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/denied|no-search/i);
    expect(called).toBe(false);
  });

  test("successful search returns formatted results with injected fetch", async () => {
    process.env.HZ_WEB_SEARCH = "1";
    const ctx = mockToolContext({ decision: "allow" });
    const html = `
      <div class="results">
        <div class="result">
          <div class="result__body">
            <a class="result__a" href="https://example.com/a">Alpha</a>
            <a class="result__snippet">First hit.</a>
          </div>
        </div>
        <div class="result">
          <div class="result__body">
            <a class="result__a" href="https://example.com/b">Beta</a>
            <a class="result__snippet">Second hit.</a>
          </div>
        </div>
      </div>`;
    __setWebSearchHttpForTests(async () =>
      new Response(html, { status: 200, headers: { "content-type": "text/html" } }),
    );
    const r = await webSearchTool.execute({ query: "alpha beta", count: 2 }, ctx);
    expect(r.ok).toBe(true);
    expect(r.output).toContain("backend: duckduckgo-html");
    expect(r.output).toContain("Alpha");
    expect(r.output).toContain("https://example.com/a");
    expect(r.output).toContain("First hit");
  });

  test("brave provider sends subscription token header", async () => {
    process.env.HZ_WEB_SEARCH_PROVIDER = "brave";
    process.env.BRAVE_SEARCH_API_KEY = "test-key";
    const ctx = mockToolContext({ decision: "allow" });
    let seenToken = "";
    __setWebSearchHttpForTests(async (_url, init) => {
      const h = init.headers;
      if (h && typeof h === "object" && !Array.isArray(h)) {
        seenToken = String((h as Record<string, string>)["x-subscription-token"] ?? "");
      }
      return new Response(
        JSON.stringify({ web: { results: [{ title: "X", url: "https://x.test", description: "y" }] } }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
    const r = await webSearchTool.execute({ query: "brave test" }, ctx);
    expect(seenToken).toBe("test-key");
    expect(r.ok).toBe(true);
    expect(r.output).toContain("backend: brave-api");
    expect(r.output).toContain("https://x.test");
  });
});