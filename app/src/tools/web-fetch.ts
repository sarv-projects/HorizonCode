/**
 * `web_fetch` — fetch one HTTPS URL and return readable text for the model.
 *
 * Authority: kernel `net.fetch` via loop admission (`guardActionFor`) and a
 * matching in-tool `ctx.guard` check. HTTP uses ambient `fetch` (Bun); there is
 * **no** routed egress proxy — product shell-net is **not** enforced (docs/11,
 * ruling 43). The egress decider only admits `net.fetch`; it does not constrain
 * the actual socket.
 */

import type { GuardAction, Tool, ToolContext, ToolResult } from "../contracts";
import { truncate } from "./helpers";

const DEFAULT_MAX_BYTES = 512 * 1024;
const MAX_OUTPUT_CHARS = 100_000;
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 120_000;

export type WebFetchHttp = (url: string, init: RequestInit) => Promise<Response>;

let httpFetch: WebFetchHttp = (url, init) => fetch(url, init);

/** Test hook: replace the HTTP layer; pass `undefined` to restore Bun `fetch`. */
export function __setWebFetchHttpForTests(impl: WebFetchHttp | undefined): void {
  httpFetch = impl ?? ((url, init) => fetch(url, init));
}

function fail(error: string): ToolResult {
  return { ok: false, output: "", error };
}

function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function normalizeUrl(raw: string): string | undefined {
  const trimmed = raw.trim();
  if (trimmed === "") return undefined;
  try {
    const u = new URL(trimmed);
    if (u.protocol !== "https:") return undefined;
    if (u.username !== "" || u.password !== "") return undefined;
    return u.href;
  } catch {
    return undefined;
  }
}

/** Minimal tag stripper — no dependency on a HTML parser. */
export function stripHtmlToText(html: string): string {
  let s = html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<!--[\s\S]*?-->/g, "");
  s = s.replace(/<br\s*\/?>/gi, "\n");
  s = s.replace(/<\/(p|div|h[1-6]|li|tr|pre|blockquote)>/gi, "\n");
  s = s.replace(/<[^>]+>/g, " ");
  s = s
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'");
  return s
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

async function readBodyCapped(res: Response, maxBytes: number): Promise<{ text: string; truncated: boolean; bytes: number }> {
  const buf = await res.arrayBuffer();
  const bytes = buf.byteLength;
  const slice = bytes > maxBytes ? buf.slice(0, maxBytes) : buf;
  const truncated = bytes > maxBytes;
  const text = new TextDecoder("utf-8", { fatal: false }).decode(slice);
  return { text, truncated, bytes };
}

async function checkNetFetch(ctx: ToolContext, url: string): Promise<string | null> {
  const action: GuardAction = { kind: "net.fetch", target: url };
  const decision = await ctx.guard(action);
  if (decision.decision === "deny") {
    return `denied by policy${decision.reason ? `: ${decision.reason}` : ""}`;
  }
  if (decision.decision === "ask") {
    const ok = await ctx.approve({ title: `Fetch ${url}`, detail: url, kind: "net.fetch" }, action);
    if (!ok) return "declined by user";
  }
  return null;
}

export const webFetchTool: Tool = {
  name: "web_fetch",
  description:
    "Fetch an HTTPS URL and return its body as text (HTML is stripped to plain text). Uses kernel net.fetch admission; ambient Bun fetch — no routed egress proxy.",
  parameters: {
    type: "object",
    properties: {
      url: { type: "string", description: "HTTPS URL to fetch (no credentials in the URL)." },
      format: {
        type: "string",
        enum: ["text", "html", "json"],
        description: "Response shape: text (default, HTML stripped), html (raw), or json (pretty when valid JSON).",
      },
      max_bytes: {
        type: "integer",
        description: `Max response bytes to read (default ${DEFAULT_MAX_BYTES}; hard cap 2 MiB).`,
        minimum: 1024,
        maximum: 2 * 1024 * 1024,
      },
      timeout_ms: {
        type: "integer",
        description: `Request timeout in ms (default ${DEFAULT_TIMEOUT_MS}).`,
        minimum: 1000,
        maximum: MAX_TIMEOUT_MS,
      },
    },
    required: ["url"],
  },
  concurrencyClass: "shared",

  async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const urlRaw = typeof args.url === "string" ? args.url : "";
    const url = normalizeUrl(urlRaw);
    if (url === undefined) return fail("url must be a valid https:// URL (no userinfo)");

    const denied = await checkNetFetch(ctx, url);
    if (denied) return fail(denied);

    const format = typeof args.format === "string" ? args.format.trim().toLowerCase() : "text";
    if (format !== "text" && format !== "html" && format !== "json") {
      return fail("format must be text, html, or json");
    }

    const maxBytesRaw = args.max_bytes;
    const maxBytes =
      typeof maxBytesRaw === "number" && Number.isFinite(maxBytesRaw)
        ? Math.min(2 * 1024 * 1024, Math.max(1024, Math.floor(maxBytesRaw)))
        : DEFAULT_MAX_BYTES;

    const timeoutRaw = args.timeout_ms;
    const timeoutMs =
      typeof timeoutRaw === "number" && Number.isFinite(timeoutRaw)
        ? Math.min(MAX_TIMEOUT_MS, Math.max(1000, Math.floor(timeoutRaw)))
        : DEFAULT_TIMEOUT_MS;

    const controller = new AbortController();
    const onAbort = () => controller.abort();
    ctx.signal.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const res = await httpFetch(url, {
        method: "GET",
        redirect: "follow",
        signal: controller.signal,
        headers: { accept: "*/*", "user-agent": "HorizonCode-web_fetch/1.0" },
      });

      const contentType = res.headers.get("content-type") ?? "";
      const { text: body, truncated: bodyTruncated, bytes } = await readBodyCapped(res, maxBytes);

      let content = body;
      const isHtml = /text\/html/i.test(contentType) || /^\s*</.test(body.slice(0, 200));
      if (format === "text" && isHtml) content = stripHtmlToText(body);
      else if (format === "json") {
        try {
          content = JSON.stringify(JSON.parse(body), null, 2);
        } catch {
          /* leave raw body */
        }
      }

      const outputTruncated = content.length > MAX_OUTPUT_CHARS;
      const shown = truncate(content, MAX_OUTPUT_CHARS);

      const header = [
        `url: ${url}`,
        `status: ${res.status}`,
        `content-type: ${contentType || "(none)"}`,
        `bytes: ${bytes}${bodyTruncated ? " (body truncated at max_bytes)" : ""}`,
      ].join("\n");

      if (!res.ok) {
        return {
          ok: false,
          output: `${header}\n\n${shown}`,
          error: `HTTP ${res.status}`,
        };
      }

      const tail =
        (bodyTruncated ? "\n[response body truncated at max_bytes]" : "") +
        (outputTruncated ? "\n[output truncated for model context]" : "");

      return { ok: true, output: `${header}\n\n${shown}${tail}` };
    } catch (e) {
      if (controller.signal.aborted) {
        const reason = ctx.signal.aborted ? "aborted" : "timeout";
        return fail(`fetch ${reason}`);
      }
      return fail(`fetch failed: ${msg(e)}`);
    } finally {
      clearTimeout(timer);
      ctx.signal.removeEventListener("abort", onAbort);
    }
  },
};