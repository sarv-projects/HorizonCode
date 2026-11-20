/**
 * web_fetch — guard admission, HTML stripping, and size cap (mock HTTP).
 */

import { afterEach, describe, expect, test } from "bun:test";
import { __setWebFetchHttpForTests, stripHtmlToText, webFetchTool } from "../../src/tools/web-fetch";
import { mockToolContext } from "./helpers";

afterEach(() => {
  __setWebFetchHttpForTests(undefined);
});

describe("web_fetch", () => {
  test("stripHtmlToText removes tags and keeps text", () => {
    const text = stripHtmlToText("<html><body><h1>Hi</h1><p>There&nbsp;you</p></body></html>");
    expect(text).toContain("Hi");
    expect(text).toContain("There you");
    expect(text).not.toContain("<p>");
  });

  test("refuses invalid URL without calling guard", async () => {
    const ctx = mockToolContext({ decision: "allow" });
    const r = await webFetchTool.execute({ url: "ftp://example.com/x" }, ctx);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/https/i);
    expect(ctx.guardCalls.length).toBe(0);
  });

  test("net.fetch guard deny blocks before HTTP", async () => {
    const ctx = mockToolContext({
      decision: (action) =>
        action.kind === "net.fetch" ? { decision: "deny", reason: "egress-test" } : { decision: "allow" },
    });
    let called = false;
    __setWebFetchHttpForTests(async () => {
      called = true;
      return new Response("nope");
    });
    const r = await webFetchTool.execute({ url: "https://example.com/" }, ctx);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/denied|egress-test/i);
    expect(called).toBe(false);
    expect(ctx.guardCalls.some((a) => a.kind === "net.fetch")).toBe(true);
  });

  test("successful fetch returns stripped HTML body", async () => {
    const ctx = mockToolContext({ decision: "allow" });
    __setWebFetchHttpForTests(async () =>
      new Response("<html><body><title>Doc</title><p>Hello web</p></body></html>", {
        status: 200,
        headers: { "content-type": "text/html; charset=utf-8" },
      }),
    );
    const r = await webFetchTool.execute({ url: "https://docs.example.com/page" }, ctx);
    expect(r.ok).toBe(true);
    expect(r.output).toContain("status: 200");
    expect(r.output).toContain("Hello web");
    expect(r.output).not.toContain("<p>");
  });

  test("truncates body above max_bytes", async () => {
    const ctx = mockToolContext({ decision: "allow" });
    const big = "x".repeat(5000);
    __setWebFetchHttpForTests(async () => new Response(big, { status: 200, headers: { "content-type": "text/plain" } }));
    const r = await webFetchTool.execute({ url: "https://example.com/big", max_bytes: 1000 }, ctx);
    expect(r.ok).toBe(true);
    expect(r.output).toContain("[response body truncated");
    expect(r.output).not.toContain(big);
  });
});