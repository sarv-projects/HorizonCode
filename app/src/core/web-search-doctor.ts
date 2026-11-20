/**
 * Doctor surface for `web_search` — backend posture only (no live search).
 */

import type { EnvLike } from "./config";
import { assessWebSearchBackend, webSearchBackendEnabled, webSearchBackendLabel } from "../tools/web-search-posture";
import { parseBraveSearchJson, parseDuckDuckGoHtml } from "../tools/web-search";

export function hermeticWebSearchParseSelfCheck(): { ok: boolean; summary: string } {
  const html = `<div class="result"><div class="result__body"><a class="result__a" href="https://example.com/x">T</a><a class="result__snippet">S</a></div></div>`;
  const ddg = parseDuckDuckGoHtml(html, 3);
  if (ddg.length !== 1 || ddg[0]!.url !== "https://example.com/x") {
    return { ok: false, summary: "DDG HTML parse self-check failed" };
  }
  const brave = parseBraveSearchJson(
    JSON.stringify({ web: { results: [{ title: "B", url: "https://b.example", description: "d" }] } }),
    3,
  );
  if (brave.length !== 1 || brave[0]!.url !== "https://b.example") {
    return { ok: false, summary: "Brave JSON parse self-check failed" };
  }
  return { ok: true, summary: "parse self-check ok (DDG HTML + Brave JSON)" };
}

export type WebSearchDoctorPosture = {
  enabled: boolean;
  backendSummary: string;
  selfCheckOk: boolean;
  selfCheckSummary: string;
};

export function assessWebSearchDoctor(env: EnvLike): WebSearchDoctorPosture {
  const backend = assessWebSearchBackend(env);
  const self = hermeticWebSearchParseSelfCheck();
  return {
    enabled: webSearchBackendEnabled(backend),
    backendSummary: webSearchBackendLabel(backend),
    selfCheckOk: self.ok,
    selfCheckSummary: self.summary,
  };
}

export function formatWebSearchDoctorDetail(posture: WebSearchDoctorPosture): string {
  const parts = [posture.selfCheckSummary, posture.backendSummary];
  if (!posture.enabled) {
    parts.push("builtin.web_search fails closed until a backend is configured");
  }
  parts.push("ambient Bun fetch — shell-net is not enforced");
  return parts.join("; ");
}

export const WEB_SEARCH_DOCTOR_FIX_LINES = [
  "# Enable DuckDuckGo HTML search (no API key):",
  "export HZ_WEB_SEARCH=1",
  "# Or Brave Web Search API:",
  "export HZ_WEB_SEARCH_PROVIDER=brave",
  "export BRAVE_SEARCH_API_KEY=…",
  "# Or custom GET endpoint (include {query} or ?q=):",
  "export HZ_WEB_SEARCH_URL='https://example.com/search?q={query}'",
] as const;