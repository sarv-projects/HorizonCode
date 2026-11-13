/**
 * egress-decider.ts — TS mirror of kernel/src/egress.rs (admission only).
 *
 * Used by the loopback CONNECT proxy slice (docs/33 §5.2); does not intercept
 * shell children — MITM / netns enforcement remains open.
 */

import { existsSync, readFileSync } from "node:fs";
import * as path from "node:path";
import type { EgressBaseDecision, EgressOrigin, EgressOriginRule, EgressPolicyDoc } from "../contracts";

export type EgressDenySource = "deny_row" | "web_fetch_denylist";

export type EgressDecision =
  | { kind: "allow" }
  | { kind: "deny"; source: EgressDenySource }
  | { kind: "ask" }
  | { kind: "allow_and_record"; would: "allowed" | "denied" | "asked" };

export type EgressPolicy = {
  rules: OriginRule[];
  disallowedWebFetchDomains: string[];
  observe: boolean;
};

type OriginRule = {
  host: string;
  scheme: string | null;
  port: number | null;
  decision: EgressBaseDecision;
};

export function normalizeNetworkRuleHost(input: string): string | undefined {
  let s = input.trim();
  const schemeIdx = s.indexOf("://");
  if (schemeIdx >= 0) s = s.slice(schemeIdx + 3);
  for (const sep of ["/", "?", "#"]) {
    const idx = s.indexOf(sep);
    if (idx >= 0) s = s.slice(0, idx);
  }
  const at = s.lastIndexOf("@");
  if (at >= 0) s = s.slice(at + 1);
  const colon = s.lastIndexOf(":");
  if (colon >= 0) {
    const tail = s.slice(colon + 1);
    if (tail !== "" && /^\d+$/.test(tail)) s = s.slice(0, colon);
  }
  if (s === "" || s.includes("*") || /\s/.test(s)) return undefined;
  return s.toLowerCase();
}

function defaultPort(scheme: string): number | undefined {
  if (scheme === "https") return 443;
  if (scheme === "http") return 80;
  return undefined;
}

export function parseOrigin(url: string): EgressOrigin | undefined {
  const s = url.trim();
  if (s === "" || /\s/.test(s)) return undefined;
  const schemeSplit = s.split("://");
  if (schemeSplit.length !== 2) return undefined;
  const scheme = schemeSplit[0]!.toLowerCase();
  if (scheme === "") return undefined;
  let rest = schemeSplit[1]!;
  for (const sep of ["/", "?", "#"]) {
    const idx = rest.indexOf(sep);
    if (idx >= 0) rest = rest.slice(0, idx);
  }
  if (rest === "") return undefined;
  const authority = (() => {
    const at = rest.lastIndexOf("@");
    return at >= 0 ? rest.slice(at + 1) : rest;
  })();
  if (authority === "") return undefined;
  let hostRaw = authority;
  let port = defaultPort(scheme);
  const colon = authority.lastIndexOf(":");
  if (colon >= 0) {
    const tail = authority.slice(colon + 1);
    if (tail !== "" && /^\d+$/.test(tail)) {
      const n = Number(tail);
      if (!Number.isInteger(n) || n < 0 || n > 65535) return undefined;
      hostRaw = authority.slice(0, colon);
      port = n;
    }
  }
  if (port === undefined) return undefined;
  const host = hostRaw.toLowerCase();
  if (host === "" || host.includes("*")) return undefined;
  return { scheme, host, port };
}

/** CONNECT authority `host:port` → `https://host:port` origin. */
export function originFromConnectAuthority(authority: string): EgressOrigin | undefined {
  const trimmed = authority.trim();
  if (trimmed === "" || /\s/.test(trimmed)) return undefined;
  const colon = trimmed.lastIndexOf(":");
  if (colon < 0) return parseOrigin(`https://${trimmed}:443`);
  const hostPart = trimmed.slice(0, colon);
  const portPart = trimmed.slice(colon + 1);
  if (!/^\d+$/.test(portPart)) return undefined;
  return parseOrigin(`https://${hostPart}:${portPart}`);
}

function parseRule(index: number, raw: EgressOriginRule): OriginRule | undefined {
  const host = normalizeNetworkRuleHost(raw.host);
  if (!host) return undefined;
  const decision = raw.decision;
  if (decision !== "allow" && decision !== "deny" && decision !== "ask") return undefined;
  let scheme: string | null = null;
  if (raw.scheme != null) {
    const s = String(raw.scheme).trim().toLowerCase();
    if (s === "") return undefined;
    scheme = s;
  }
  let port: number | null = null;
  if (raw.port != null) {
    const n = raw.port;
    if (!Number.isInteger(n) || n < 0 || n > 65535) return undefined;
    port = n;
  }
  void index;
  return { host, scheme, port, decision };
}

export function parseEgressPolicyDoc(doc: EgressPolicyDoc | EgressOriginRule[]): EgressPolicy | undefined {
  const rulesRaw = Array.isArray(doc) ? doc : doc.rules;
  const denylist = Array.isArray(doc)
    ? []
    : (doc.disallowedWebFetchDomains ?? [])
        .map((h) => normalizeNetworkRuleHost(h))
        .filter((h): h is string => h !== undefined);
  const observe = Array.isArray(doc) ? false : doc.observe === true;
  const rules: OriginRule[] = [];
  for (let i = 0; i < rulesRaw.length; i += 1) {
    const parsed = parseRule(i, rulesRaw[i]!);
    if (!parsed) return undefined;
    rules.push(parsed);
  }
  return { rules, disallowedWebFetchDomains: denylist, observe };
}

export function loadEgressPolicy(stateDir: string): EgressPolicy | undefined {
  const file = path.join(stateDir, "egress.json");
  if (!existsSync(file)) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8")) as unknown;
  } catch {
    return undefined;
  }
  if (Array.isArray(parsed)) return parseEgressPolicyDoc(parsed);
  if (parsed && typeof parsed === "object" && "rules" in parsed) {
    return parseEgressPolicyDoc(parsed as EgressPolicyDoc);
  }
  return undefined;
}

function ruleMatches(rule: OriginRule, origin: EgressOrigin): boolean {
  if (rule.host !== origin.host) return false;
  if (rule.scheme !== null && rule.scheme !== origin.scheme) return false;
  if (rule.port !== null && rule.port !== origin.port) return false;
  return true;
}

function decideEnforce(policy: EgressPolicy, origin: EgressOrigin): EgressDecision {
  if (policy.disallowedWebFetchDomains.includes(origin.host)) {
    return { kind: "deny", source: "web_fetch_denylist" };
  }
  let sawAllow = false;
  let sawAsk = false;
  for (const rule of policy.rules) {
    if (!ruleMatches(rule, origin)) continue;
    if (rule.decision === "deny") return { kind: "deny", source: "deny_row" };
    if (rule.decision === "allow") sawAllow = true;
    if (rule.decision === "ask") sawAsk = true;
  }
  if (sawAllow) return { kind: "allow" };
  if (sawAsk) return { kind: "ask" };
  return { kind: "deny", source: "deny_row" };
}

export function decideOrigin(policy: EgressPolicy, origin: EgressOrigin): EgressDecision {
  const base = decideEnforce(policy, origin);
  if (!policy.observe) return base;
  const would =
    base.kind === "allow"
      ? "allowed"
      : base.kind === "ask"
        ? "asked"
        : "denied";
  return { kind: "allow_and_record", would };
}

export function decideConnectAuthority(policy: EgressPolicy, authority: string): EgressDecision | "unparseable" {
  const origin = originFromConnectAuthority(authority);
  if (!origin) return "unparseable";
  return decideOrigin(policy, origin);
}

export function connectAdmits(decision: EgressDecision): boolean {
  if (decision.kind === "allow") return true;
  if (decision.kind === "allow_and_record") return true;
  return false;
}
