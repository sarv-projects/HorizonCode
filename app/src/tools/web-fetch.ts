/**
 * `web_fetch` — fetch one HTTPS URL and return readable text for the model.
 *
 * Authority: kernel `net.fetch` via loop admission (`guardActionFor`) and a
 * matching in-tool `ctx.guard` check. HTTP uses ambient `fetch` (Bun); there is
 * **no** routed egress proxy — product shell-net is **not** enforced (docs/11,
 * ruling 43). The egress decider only admits `net.fetch`; it does not constrain
 * the actual socket.
 */

import { lookup as dnsLookupPromise } from "node:dns/promises";
import { isIP } from "node:net";
import type { GuardAction, Tool, ToolContext, ToolResult } from "../contracts";
import { tunnelPermissionError } from "../core/guards/defect-tunnel";
import { truncate } from "./helpers";

const DEFAULT_MAX_BYTES = 512 * 1024;
const MAX_OUTPUT_CHARS = 100_000;
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 120_000;
const MAX_REDIRECT_HOPS = 5;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const AUTH_HEADER_NAMES = new Set([
  "authorization",
  "proxy-authorization",
  "cookie",
  "x-api-key",
  "x-subscription-token",
]);

function stripAuthHeaders(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    if (!AUTH_HEADER_NAMES.has(k.toLowerCase())) out[k] = v;
  }
  return out;
}

export type WebFetchHttp = (url: string, init: RequestInit) => Promise<Response>;
export type WebFetchDnsLookup = (hostname: string) => Promise<Array<{ address: string; family: number }>>;

let httpFetch: WebFetchHttp = (url, init) => fetch(url, init);
let usingCustomHttp = false;
let dnsLookup: WebFetchDnsLookup = (hostname) => dnsLookupPromise(hostname, { all: true });
let usingCustomDns = false;

/** Test hook: replace the HTTP layer; pass `undefined` to restore Bun `fetch`. */
export function __setWebFetchHttpForTests(impl: WebFetchHttp | undefined): void {
  usingCustomHttp = impl !== undefined;
  httpFetch = impl ?? ((url, init) => fetch(url, init));
}

/** Test hook: replace DNS resolution; pass `undefined` to restore `dns.promises.lookup`. */
export function __setWebFetchDnsLookupForTests(impl: WebFetchDnsLookup | undefined): void {
  usingCustomDns = impl !== undefined;
  dnsLookup = impl ?? ((hostname) => dnsLookupPromise(hostname, { all: true }));
}

/**
 * Resolve `url`'s hostname via DNS before fetch() and reject if any returned
 * address is private/loopback/link-local/CGNAT/multicast/NAT64.
 * Preserves injected custom `fetch` test harnesses for synthetic test domains
 * when no custom DNS lookup hook is installed.
 */
export async function checkDnsNotPrivate(
  url: string,
  opts?: { customFetchInjected?: boolean },
): Promise<string | null> {
  if (process.env.HZ_ALLOW_PRIVATE_FETCH === "1") return null;
  let host: string;
  try {
    host = new URL(url).hostname.replace(/^\[/, "").replace(/\]$/, "");
  } catch {
    return "invalid URL";
  }
  if (isBlockedPrivateHost(host)) {
    return `blocked private or internal host: ${host}`;
  }
  if (isIP(host) !== 0) return null;
  try {
    const records = await dnsLookup(host);
    for (const rec of records) {
      if (isBlockedPrivateHost(rec.address)) {
        return `hostname ${host} resolved to blocked private address ${rec.address}`;
      }
    }
    return null;
  } catch (e) {
    if (opts?.customFetchInjected && !usingCustomDns) return null;
    return `DNS resolution failed for ${host}: ${msg(e)}`;
  }
}

function fail(error: string): ToolResult {
  return { ok: false, output: "", error };
}

function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** True when a hostname/IP is loopback, link-local, or RFC 1918 / IPv6 ULA. */
export function isBlockedPrivateHost(hostname: string): boolean {
  const raw = hostname.trim().toLowerCase().replace(/^\[/, "").replace(/\]$/, "").replace(/\.$/, "");
  if (raw === "" || raw === "localhost" || raw === "localhost.localdomain" || raw.endsWith(".localhost")) {
    return true;
  }
  // IPv4 literal (decimal dotted-quad; URL parser normalizes octal/hex/integer IPv4 to dotted-quad)
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(raw);
  if (v4) {
    const a = Number(v4[1]);
    const b = Number(v4[2]);
    if (a === 127 || a === 10 || a === 0) return true;
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64.0.0/10
    if (a === 169 && b === 254) return true;
    if (a === 192 && b === 168) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a >= 224) return true; // multicast 224.0.0.0/4 + reserved/broadcast 240.0.0.0/4
    return false;
  }
  // IPv6 literals (loopback, unspecified, uncompressed forms)
  if (raw === "::1" || raw === "::" || /^(?:0{1,4}:){7}0{0,3}[01]$/.test(raw)) {
    return true;
  }
  // Link-local fe80::/10 (fe80..febf), ULA fc00::/7 (fc../fd..), multicast ff00::/8
  if (/^fe[89ab][0-9a-f]:/.test(raw) || /^f[cd][0-9a-f]{2}:/.test(raw) || /^ff[0-9a-f]{2}:/.test(raw)) {
    return true;
  }
  // NAT64 well-known prefix 64:ff9b::/96 (and local-use 64:ff9b:1::/48)
  if (/^0{0,2}64:ff9b:/.test(raw)) {
    return true;
  }
  // IPv4-mapped IPv6: compressed (::ffff:...) or uncompressed (0:0:0:0:0:ffff:...)
  const v4Mapped = /^(?:::|0{1,4}(?::0{1,4}){4}:)ffff:(.+)$/.exec(raw);
  if (v4Mapped) {
    const tail = v4Mapped[1]!;
    if (tail.includes(".")) return isBlockedPrivateHost(tail);
    const hex = /^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(tail);
    if (hex) {
      const hi = parseInt(hex[1]!, 16);
      const lo = parseInt(hex[2]!, 16);
      const mapped = `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
      return isBlockedPrivateHost(mapped);
    }
  }
  return false;
}

export function normalizeUrl(raw: string): string | undefined {
  const trimmed = raw.trim();
  if (trimmed === "") return undefined;
  try {
    const u = new URL(trimmed);
    if (u.protocol !== "https:") return undefined;
    if (u.username !== "" || u.password !== "") return undefined;
    if (process.env.HZ_ALLOW_PRIVATE_FETCH !== "1" && isBlockedPrivateHost(u.hostname)) {
      return undefined;
    }
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

export async function readBodyCapped(
  res: Response,
  maxBytes: number,
): Promise<{ text: string; truncated: boolean; bytes: number }> {
  if (res.body && typeof res.body.getReader === "function") {
    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    let truncated = false;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value || value.byteLength === 0) continue;
        if (total + value.byteLength > maxBytes) {
          const remaining = maxBytes - total;
          if (remaining > 0) {
            chunks.push(value.subarray(0, remaining));
            total += remaining;
          }
          truncated = true;
          try {
            await reader.cancel();
          } catch {
            /* ignore cancel errors */
          }
          break;
        }
        chunks.push(value);
        total += value.byteLength;
      }
    } finally {
      try {
        reader.releaseLock();
      } catch {
        /* already released */
      }
    }
    const out = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      out.set(chunk, offset);
      offset += chunk.byteLength;
    }
    const text = new TextDecoder("utf-8", { fatal: false }).decode(out);
    return { text, truncated, bytes: total };
  }
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
      let currentUrl = url;
      let currentHeaders: Record<string, string> = { accept: "*/*", "user-agent": "HorizonCode-web_fetch/1.0" };
      let res: Response;
      let hops = 0;
      for (;;) {
        const dnsErr = await checkDnsNotPrivate(currentUrl, { customFetchInjected: usingCustomHttp });
        if (dnsErr !== null) return fail(dnsErr);
        res = await httpFetch(currentUrl, {
          method: "GET",
          redirect: "manual",
          signal: controller.signal,
          headers: currentHeaders,
        });
        if (!REDIRECT_STATUSES.has(res.status)) break;
        const location = res.headers.get("location");
        if (!location) break;
        try {
          await res.body?.cancel();
        } catch {
          /* ignore */
        }
        hops += 1;
        if (hops > MAX_REDIRECT_HOPS) {
          return fail(`too many redirects (max ${MAX_REDIRECT_HOPS})`);
        }
        let nextRaw: string;
        try {
          nextRaw = new URL(location, currentUrl).href;
        } catch {
          return fail(`invalid redirect location: ${location}`);
        }
        const nextUrl = normalizeUrl(nextRaw);
        if (nextUrl === undefined) {
          return fail("redirect target must be a valid https:// URL (no userinfo)");
        }
        const redirectDenied = await checkNetFetch(ctx, nextUrl);
        if (redirectDenied) return fail(redirectDenied);
        if (new URL(nextUrl).origin !== new URL(currentUrl).origin) {
          currentHeaders = stripAuthHeaders(currentHeaders);
        }
        currentUrl = nextUrl;
      }

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
        `url: ${currentUrl}`,
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
      tunnelPermissionError(e);
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