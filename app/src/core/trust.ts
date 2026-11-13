/**
 * trust.ts — workspace trust for hooks, skills and MCP (docs/15 H1, docs/33 §6.2).
 *
 * Workspace hooks, skills, agent presets and (future) MCP declarations load only
 * when the workspace path is listed in user `trustedWorkspaceHooks` and each
 * present surface's digest matches user `trust.json`.
 */

import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import * as path from "node:path";
import type { ApprovalHandler } from "../contracts";
import type { HzConfig } from "./config";
import type { HooksOptions } from "./hooks";
import { skillsDir, stateRoot, userConfigDir } from "./paths";

export type WorkspaceTrustReceiptPayload = {
  workspace: string;
  decision: "bind" | "rebind";
  hooksDigest?: string;
  skillsDigest?: string;
  agentsDigest?: string;
  mcpDigest?: string;
  providersDigest?: string;
};

/** @deprecated Use `WorkspaceTrustReceiptPayload`. */
export type HookTrustReceiptPayload = WorkspaceTrustReceiptPayload & {
  hooksDigest: string;
};

export interface WorkspaceTrustRecord {
  /** Absolute workspace path. */
  workspace: string;
  hooksDigest?: string | null;
  skillsDigest?: string | null;
  agentsDigest?: string | null;
  mcpDigest?: string | null;
  providersDigest?: string | null;
  /** ISO timestamp when the digest set was recorded. */
  decidedAt: string;
}

export interface TrustStoreV1 {
  version: 1;
  records: WorkspaceTrustRecord[];
}

export interface WorkspaceTrustDigests {
  hooks: string | null;
  skills: string | null;
  agents: string | null;
  mcp: string | null;
  providers: string | null;
}

const TRUST_FILENAME = "trust.json";
const DIR_DIGEST_CAP = 200;
/** Sentinel when a directory tree exceeds `DIR_DIGEST_CAP` — must not bind. */
export const TRUST_DIR_DIGEST_TRUNCATED = "hz:dir-digest-truncated";

export function trustStorePath(home: string): string {
  return path.join(userConfigDir(home), TRUST_FILENAME);
}

function resolveHome(home: string | undefined): string {
  if (home !== undefined) return home;
  try {
    return homedir();
  } catch {
    return "";
  }
}

/** Absolute path to the workspace hooks file (canonical state root). */
export function workspaceHooksFile(workspace: string): string {
  return path.join(stateRoot(workspace), "hooks.json");
}

export function workspaceAgentsDir(workspace: string): string {
  return path.join(stateRoot(workspace), "agents");
}

export function workspaceMcpConfigFile(workspace: string): string {
  return path.join(stateRoot(workspace), "mcp.json");
}

export function workspaceProvidersConfigFile(workspace: string): string {
  return path.join(stateRoot(workspace), "providers.json");
}

/** sha256 hex of `hooks.json`, or `null` when the file is absent. */
export function digestWorkspaceHooks(workspace: string): string | null {
  const file = workspaceHooksFile(workspace);
  if (!existsSync(file)) return null;
  const bytes = readFileSync(file);
  return createHash("sha256").update(bytes).digest("hex");
}

/** Content digest of a directory tree (sorted relative paths + file bytes), or `null` when absent/empty. */
export function digestDirectory(root: string): string | null {
  if (!existsSync(root)) return null;
  const files: string[] = [];
  let truncated = false;
  const walk = (dir: string, rel: string, depth: number): void => {
    let names: string[];
    try {
      names = readdirSync(dir).sort();
    } catch {
      return;
    }
    for (const name of names) {
      if (files.length >= DIR_DIGEST_CAP) {
        truncated = true;
        return;
      }
      if (name.startsWith(".")) continue;
      const full = path.join(dir, name);
      const r = rel === "" ? name : `${rel}/${name}`;
      try {
        const st = lstatSync(full);
        if (st.isSymbolicLink()) continue;
        if (st.isDirectory()) {
          if (depth < 4) walk(full, r, depth + 1);
        } else if (st.isFile()) {
          files.push(r);
        }
      } catch {
        /* unreadable */
      }
    }
  };
  walk(root, "", 0);
  if (truncated) return TRUST_DIR_DIGEST_TRUNCATED;
  if (files.length === 0) return null;
  const h = createHash("sha256");
  for (const rel of files.sort()) {
    h.update(rel);
    h.update("\0");
    try {
      h.update(readFileSync(path.join(root, rel)));
    } catch {
      h.update("?");
    }
    h.update("\0");
  }
  return h.digest("hex");
}

export function digestFile(file: string): string | null {
  if (!existsSync(file)) return null;
  try {
    const st = lstatSync(file);
    if (st.isSymbolicLink() || !st.isFile()) return null;
  } catch {
    return null;
  }
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

export function digestWorkspaceSkills(workspace: string): string | null {
  return digestDirectory(skillsDir(workspace));
}

export function digestWorkspaceAgents(workspace: string): string | null {
  return digestDirectory(workspaceAgentsDir(workspace));
}

export function digestWorkspaceMcp(workspace: string): string | null {
  return digestFile(workspaceMcpConfigFile(workspace));
}

export function digestWorkspaceProviders(workspace: string): string | null {
  return digestFile(workspaceProvidersConfigFile(workspace));
}

export function collectWorkspaceTrustDigests(workspace: string): WorkspaceTrustDigests {
  return {
    hooks: digestWorkspaceHooks(workspace),
    skills: digestWorkspaceSkills(workspace),
    agents: digestWorkspaceAgents(workspace),
    mcp: digestWorkspaceMcp(workspace),
    providers: digestWorkspaceProviders(workspace),
  };
}

export function loadTrustStore(home: string): TrustStoreV1 {
  const file = trustStorePath(home);
  if (!existsSync(file)) return { version: 1, records: [] };
  try {
    const raw = JSON.parse(readFileSync(file, "utf8")) as TrustStoreV1;
    if (raw?.version !== 1 || !Array.isArray(raw.records)) return { version: 1, records: [] };
    return raw;
  } catch {
    return { version: 1, records: [] };
  }
}

export function saveTrustStore(home: string, store: TrustStoreV1): void {
  const dir = userConfigDir(home);
  mkdirSync(dir, { recursive: true });
  writeFileSync(trustStorePath(home), JSON.stringify(store, null, 2) + "\n", { mode: 0o600 });
}

function findRecord(store: TrustStoreV1, workspace: string): WorkspaceTrustRecord | undefined {
  const ws = path.resolve(workspace);
  return store.records.find((r) => path.resolve(r.workspace) === ws);
}

type DigestField = "hooksDigest" | "skillsDigest" | "agentsDigest" | "mcpDigest" | "providersDigest";
type DigestKey = keyof WorkspaceTrustDigests;

const DIGEST_FIELDS: { key: DigestKey; field: DigestField; label: string }[] = [
  { key: "hooks", field: "hooksDigest", label: "hooks.json" },
  { key: "skills", field: "skillsDigest", label: "workspace skills" },
  { key: "agents", field: "agentsDigest", label: "workspace agent presets" },
  { key: "mcp", field: "mcpDigest", label: "workspace MCP config" },
  { key: "providers", field: "providersDigest", label: "workspace providers.json" },
];

const SURFACE_RISK: Record<DigestKey, string> = {
  hooks: "project hooks may run shell commands and deny or narrow tools",
  skills: "skills inject instructions into every turn",
  agents: "agent presets choose models and tool subsets for subagents",
  mcp: "MCP servers add third-party tools and network reach",
  providers: "providers.json can redirect API traffic and credentials",
};

/** Human-readable inventory for trust prompts (Grok folder-trust UX adapt). */
export function workspaceTrustSurfaceSummary(workspace: string): string[] {
  const currents = collectWorkspaceTrustDigests(workspace);
  const lines: string[] = [];
  for (const { key, label } of DIGEST_FIELDS) {
    const digest = currents[key];
    if (digest === null) continue;
    const risk = SURFACE_RISK[key];
    if (digest === TRUST_DIR_DIGEST_TRUNCATED) {
      lines.push(`${label}: present but too large to digest safely (bind refused)`);
      continue;
    }
    lines.push(`${label}: will load if trusted — ${risk}`);
    lines.push(`  fingerprint ${digest.slice(0, 12)}…`);
  }
  return lines;
}

export function workspaceTrustRiskBlurb(): string {
  return (
    "Folder trust is not git trust. Approving loads executable workspace config: " +
    "hooks, skills, MCP and provider overrides run with your user account on this machine."
  );
}

export type WorkspaceTrustGate = "no_surfaces" | "unlisted" | "unbound" | "stale" | "trusted";

/** Coarse gate for UX prompts (Grok folder-trust adapt). */
export function workspaceTrustGate(
  workspace: string,
  home: string,
  trusted?: readonly string[],
): WorkspaceTrustGate {
  const currents = collectWorkspaceTrustDigests(workspace);
  if (!Object.values(currents).some((d) => d !== null)) return "no_surfaces";
  if (!workspaceHooksTrusted(workspace, trusted)) return "unlisted";
  if (home === "") return "unbound";
  const record = findRecord(loadTrustStore(home), workspace);
  if (record === undefined) return "unbound";
  const stale = trustSurfacesOutOfDate(record, currents);
  if (stale.length > 0) return "stale";
  return "trusted";
}

/** Actionable steps when the workspace is not fully trusted. */
export function workspaceTrustNextSteps(gate: WorkspaceTrustGate, workspace: string, home: string): string[] {
  const ws = path.resolve(workspace);
  const cfgDir = home !== "" ? userConfigDir(home) : "~/.config/horizon";
  const listHint = `Add "${ws}" to trustedWorkspaceHooks in ${cfgDir}/config.json (or your active user config).`;
  switch (gate) {
    case "no_surfaces":
      return ["No trust-gated workspace surfaces detected on disk."];
    case "unlisted":
      return [
        listHint,
        "Restart hzcode or run /trust to confirm the folder is listed.",
        "Send a message: the folder-trust approval card binds digests in trust.json.",
      ];
    case "unbound":
      return [
        "This folder is listed but not bound in trust.json yet.",
        "Send a message to get the folder-trust approval card (inventory + fingerprints).",
        "Run /trust to review on-disk surfaces before approving.",
      ];
    case "stale":
      return [
        "On-disk surfaces changed since the last bind — hooks/skills/MCP stay off until re-trust.",
        "Send a message for a re-trust approval card comparing old and new fingerprints.",
        "Run /trust to inspect which surfaces are stale.",
      ];
    case "trusted":
      return ["Folder trust is current; listed surfaces match trust.json."];
  }
}

/** One-line startup notice when trust-gated surfaces are present but ignored. */
export function formatUntrustedWorkspaceStartupNotice(
  workspace: string,
  home: string,
  trusted?: readonly string[],
): string | undefined {
  const gate = workspaceTrustGate(workspace, home, trusted);
  if (gate === "no_surfaces" || gate === "trusted") return undefined;
  const lines = [
    "Workspace folder is not fully trusted — workspace hooks, skills, agents, MCP and providers stay ignored.",
    ...workspaceTrustNextSteps(gate, workspace, home),
  ];
  return lines.join("\n");
}

/** Observability text for `/trust` and similar (folder-trust UX remainder). */
export function renderWorkspaceTrustReport(workspace: string, home: string, trusted?: readonly string[]): string {
  const ws = path.resolve(workspace);
  const gate = workspaceTrustGate(workspace, home, trusted);
  const listed = trusted !== undefined && trusted.some((t) => path.resolve(t) === ws);
  const record = home !== "" ? findRecord(loadTrustStore(home), workspace) : undefined;
  const lines = [workspaceTrustRiskBlurb(), `Workspace: ${ws}`, "", `Status: ${gate}`];
  if (!listed) {
    lines.push("trustedWorkspaceHooks: this folder is not listed in your user config.");
  } else if (record === undefined) {
    lines.push("trust.json: not bound yet — hooks/skills/agents/MCP/providers stay ignored until approval.");
  } else {
    lines.push(`trust.json: bound at ${record.decidedAt}`);
    const stale = trustSurfacesOutOfDate(record, collectWorkspaceTrustDigests(workspace));
    if (stale.length > 0) lines.push(`Stale surfaces (re-trust required): ${stale.join(", ")}`);
  }
  const inventory = workspaceTrustSurfaceSummary(workspace);
  lines.push("");
  lines.push(inventory.length > 0 ? "On disk:" : "On disk: (no trust-gated surfaces detected)");
  for (const row of inventory) lines.push(`  ${row}`);
  const steps = workspaceTrustNextSteps(gate, workspace, home);
  lines.push("", "Next steps:");
  for (const step of steps) lines.push(`  · ${step}`);
  return lines.join("\n");
}

function formatTrustBindDetail(workspace: string): string {
  const ws = path.resolve(workspace);
  return [
    workspaceTrustRiskBlurb(),
    `Workspace: ${ws}`,
    "",
    "Surfaces present:",
    ...workspaceTrustSurfaceSummary(workspace),
    "",
    "Until you approve, workspace hooks/skills/agents/MCP/providers stay ignored.",
  ].join("\n");
}

function formatTrustRebindDetail(workspace: string, home: string, stale: string[]): string {
  const currents = collectWorkspaceTrustDigests(workspace);
  const record = findRecord(loadTrustStore(home), workspace);
  const lines = [
    workspaceTrustRiskBlurb(),
    `Workspace: ${path.resolve(workspace)}`,
    "",
    `Changed since last trust: ${stale.join(", ")}`,
    "",
    "Review fingerprints before re-trusting:",
  ];
  for (const { key, field, label } of DIGEST_FIELDS) {
    const current = currents[key];
    if (current === null || current === TRUST_DIR_DIGEST_TRUNCATED) continue;
    const stored = storedDigest(record, field);
    lines.push(`- ${label}: was ${(stored ?? "none").slice(0, 12)}… → now ${current.slice(0, 12)}…`);
  }
  return lines.join("\n");
}

function storedDigest(record: WorkspaceTrustRecord | undefined, field: DigestField): string | undefined {
  if (record === undefined) return undefined;
  const value = record[field];
  return typeof value === "string" ? value : undefined;
}

/** Surfaces whose on-disk digest no longer matches `trust.json` (empty when bind is needed only). */
export function trustSurfacesOutOfDate(
  record: WorkspaceTrustRecord | undefined,
  currents: WorkspaceTrustDigests,
): string[] {
  const changed: string[] = [];
  for (const { key, field, label } of DIGEST_FIELDS) {
    const current = currents[key];
    if (current === null) continue;
    const stored = storedDigest(record, field);
    if (stored !== current) changed.push(label);
  }
  return changed;
}

export function bindWorkspaceTrustRecord(home: string, workspace: string, currents: WorkspaceTrustDigests): void {
  if (home === "") return;
  const store = loadTrustStore(home);
  const ws = path.resolve(workspace);
  const prev = findRecord(store, workspace);
  const next: WorkspaceTrustRecord = {
    workspace: ws,
    decidedAt: new Date().toISOString(),
  };
  for (const { key, field } of DIGEST_FIELDS) {
    const current = currents[key];
    // Truncated inventories must never bind — incomplete digests are not trust.
    if (current === TRUST_DIR_DIGEST_TRUNCATED) continue;
    if (current !== null) next[field] = current;
    else if (prev?.[field] !== undefined) next[field] = prev[field];
  }
  const idx = store.records.findIndex((r) => path.resolve(r.workspace) === ws);
  if (idx >= 0) store.records[idx] = next;
  else store.records.push(next);
  saveTrustStore(home, store);
}

/** Persist or update the hooks digest binding (merges other workspace digests). */
export function bindWorkspaceHooksDigest(home: string, workspace: string, hooksDigest: string): void {
  const currents = collectWorkspaceTrustDigests(workspace);
  currents.hooks = hooksDigest;
  bindWorkspaceTrustRecord(home, workspace, currents);
}

/** True when `workspace` is listed in `trusted` (each entry resolved absolutely). */
export function workspaceHooksTrusted(workspace: string, trusted: readonly string[] | undefined): boolean {
  if (!trusted || trusted.length === 0) return false;
  const ws = path.resolve(workspace);
  return trusted.some((entry) => path.resolve(entry) === ws);
}

function resolveSurfaceTrust(
  workspace: string,
  trusted: readonly string[] | undefined,
  home: string,
  key: DigestKey,
  label: string,
  onNotice?: (message: string) => void,
): boolean {
  if (!workspaceHooksTrusted(workspace, trusted)) return false;
  const currents = collectWorkspaceTrustDigests(workspace);
  const current = currents[key];
  if (current === null) return true;
  if (current === TRUST_DIR_DIGEST_TRUNCATED) {
    onNotice?.(`workspace ${label} ignored (directory too large to digest safely)`);
    return false;
  }
  // No home config dir → cannot consult or persist trust.json; fail closed.
  if (home === "") {
    onNotice?.(`workspace ${label} ignored (no home config dir for trust.json)`);
    return false;
  }
  const record = findRecord(loadTrustStore(home), workspace);
  if (record === undefined) {
    onNotice?.(`workspace ${label} ignored (not bound in trust.json): approve trust for this workspace`);
    return false;
  }
  const field = DIGEST_FIELDS.find((d) => d.key === key)!.field;
  const stored = storedDigest(record, field);
  if (stored !== current) {
    onNotice?.(`workspace ${label} ignored (digest changed): re-trust this workspace after review`);
    return false;
  }
  return true;
}

/**
 * Whether workspace hooks may load: listed in config and digest matches `trust.json`
 * (bind/rebind only via `ensureWorkspaceHookTrust` approval).
 */
export function resolveWorkspaceHookTrust(
  workspace: string,
  trusted: readonly string[] | undefined,
  home: string,
  onNotice?: (message: string) => void,
): boolean {
  return resolveSurfaceTrust(workspace, trusted, home, "hooks", "hooks", onNotice);
}

export function resolveWorkspaceProjectSkillsTrust(
  workspace: string,
  trusted: readonly string[] | undefined,
  home: string,
  onNotice?: (message: string) => void,
): boolean {
  return resolveSurfaceTrust(workspace, trusted, home, "skills", "skills", onNotice);
}

export function resolveWorkspaceProjectAgentsTrust(
  workspace: string,
  trusted: readonly string[] | undefined,
  home: string,
  onNotice?: (message: string) => void,
): boolean {
  return resolveSurfaceTrust(workspace, trusted, home, "agents", "agent presets", onNotice);
}

export function resolveWorkspaceMcpConfigTrust(
  workspace: string,
  trusted: readonly string[] | undefined,
  home: string,
  onNotice?: (message: string) => void,
): boolean {
  return resolveSurfaceTrust(workspace, trusted, home, "mcp", "mcp.json", onNotice);
}

export function resolveWorkspaceProvidersConfigTrust(
  workspace: string,
  trusted: readonly string[] | undefined,
  home: string,
  onNotice?: (message: string) => void,
): boolean {
  return resolveSurfaceTrust(workspace, trusted, home, "providers", "providers.json", onNotice);
}

/** v1 loads MCP from user config only; still surface when workspace mcp.json exists but is untrusted. */
export function noticeUntrustedWorkspaceMcp(
  workspace: string,
  trusted: readonly string[] | undefined,
  home: string,
  onNotice: (message: string) => void,
): void {
  if (digestWorkspaceMcp(workspace) === null) return;
  if (trusted === undefined) return;
  if (!workspaceHooksTrusted(workspace, trusted)) {
    onNotice("workspace mcp.json ignored (untrusted workspace or digest changed)");
    return;
  }
  void resolveWorkspaceMcpConfigTrust(workspace, trusted, home, onNotice);
}

export function noticeUntrustedWorkspaceProviders(
  workspace: string,
  trusted: readonly string[] | undefined,
  home: string,
  onNotice: (message: string) => void,
): void {
  if (digestWorkspaceProviders(workspace) === null) return;
  if (trusted === undefined) return;
  if (!workspaceHooksTrusted(workspace, trusted)) {
    onNotice("workspace providers.json ignored (untrusted workspace or digest changed)");
    return;
  }
  void resolveWorkspaceProvidersConfigTrust(workspace, trusted, home, onNotice);
}

function receiptPayload(workspace: string, decision: "bind" | "rebind", currents: WorkspaceTrustDigests): WorkspaceTrustReceiptPayload {
  const payload: WorkspaceTrustReceiptPayload = { workspace, decision };
  if (currents.hooks !== null) payload.hooksDigest = currents.hooks;
  if (currents.skills !== null) payload.skillsDigest = currents.skills;
  if (currents.agents !== null) payload.agentsDigest = currents.agents;
  if (currents.mcp !== null) payload.mcpDigest = currents.mcp;
  if (currents.providers !== null) payload.providersDigest = currents.providers;
  return payload;
}

/**
 * Ensure workspace trust before a turn: first bind and digest changes both need
 * human approval (docs/15 H7); may issue a receipt. Truncated directory digests
 * never bind.
 */
export async function ensureWorkspaceHookTrust(
  workspace: string,
  trusted: readonly string[] | undefined,
  home: string,
  approve?: ApprovalHandler,
  onReceipt?: (payload: WorkspaceTrustReceiptPayload) => Promise<void>,
  onNotice?: (message: string) => void,
): Promise<boolean> {
  if (!workspaceHooksTrusted(workspace, trusted)) return false;
  if (home === "") {
    onNotice?.("workspace trust unavailable (no home config dir for trust.json)");
    return false;
  }
  const currents = collectWorkspaceTrustDigests(workspace);
  if (!Object.values(currents).some((d) => d !== null)) return true;
  if (Object.values(currents).some((d) => d === TRUST_DIR_DIGEST_TRUNCATED)) {
    onNotice?.("workspace trust refused (a surface directory is too large to digest safely)");
    return false;
  }
  const store = loadTrustStore(home);
  const record = findRecord(store, workspace);
  const ws = path.resolve(workspace);
  if (record === undefined) {
    const detail = formatTrustBindDetail(workspace);
    if (approve === undefined) {
      onNotice?.("workspace trust not bound; approve to trust this workspace");
      return false;
    }
    const ok = await approve({
      title: "Trust this workspace folder?",
      kind: "other",
      detail,
    });
    if (!ok) {
      onNotice?.("workspace trust not bound (not approved)");
      return false;
    }
    bindWorkspaceTrustRecord(home, workspace, currents);
    await onReceipt?.(receiptPayload(ws, "bind", currents));
    return true;
  }
  const stale = trustSurfacesOutOfDate(record, currents);
  if (stale.length === 0) return true;
  const detail = formatTrustRebindDetail(workspace, home, stale);
  if (approve === undefined) {
    onNotice?.(`workspace trust out of date (${stale.join(", ")}); approve to re-trust`);
    return false;
  }
  const ok = await approve({
    title: "Workspace trust changed — review and re-trust?",
    kind: "other",
    detail,
  });
  if (!ok) {
    onNotice?.(`workspace trust unchanged (not approved): ${stale.join(", ")}`);
    return false;
  }
  bindWorkspaceTrustRecord(home, workspace, currents);
  await onReceipt?.(receiptPayload(ws, "rebind", currents));
  onNotice?.(`workspace re-trusted for ${ws}`);
  return true;
}

export interface WorkspaceTrustOptions {
  trustedWorkspaceHooks?: readonly string[];
  home?: string;
  onNotice?: (message: string) => void;
}

export function hooksLoadOptions(
  workspace: string,
  config: Pick<HzConfig, "trustedWorkspaceHooks">,
  onNotice?: (message: string) => void,
  home?: string,
): HooksOptions {
  const resolvedHome = resolveHome(home);
  const trustWorkspaceHooks = resolveWorkspaceHookTrust(
    workspace,
    config.trustedWorkspaceHooks,
    resolvedHome,
    onNotice,
  );
  return {
    home: resolvedHome !== "" ? resolvedHome : undefined,
    trustWorkspaceHooks,
    onNotice,
  };
}
