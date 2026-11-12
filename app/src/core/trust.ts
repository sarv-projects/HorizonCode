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
  const walk = (dir: string, rel: string, depth: number): void => {
    let names: string[];
    try {
      names = readdirSync(dir).sort();
    } catch {
      return;
    }
    for (const name of names) {
      if (files.length >= DIR_DIGEST_CAP) return;
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

function autoBindIfNeeded(
  home: string,
  workspace: string,
  record: WorkspaceTrustRecord | undefined,
  currents: WorkspaceTrustDigests,
): WorkspaceTrustRecord | undefined {
  if (home === "") return record;
  if (record !== undefined) return record;
  if (!Object.values(currents).some((d) => d !== null)) return record;
  bindWorkspaceTrustRecord(home, workspace, currents);
  return findRecord(loadTrustStore(home), workspace);
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
  if (home === "") return true;
  let record = findRecord(loadTrustStore(home), workspace);
  record = autoBindIfNeeded(home, workspace, record, currents) ?? record;
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
 * (first load records the digest).
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
 * Ensure workspace trust before a turn: first bind is automatic; a digest
 * change needs human approval (docs/15 H7 re-prompt) and may issue a receipt.
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
  if (home === "") return true;
  const currents = collectWorkspaceTrustDigests(workspace);
  if (!Object.values(currents).some((d) => d !== null)) return true;
  const store = loadTrustStore(home);
  let record = findRecord(store, workspace);
  const ws = path.resolve(workspace);
  if (record === undefined) {
    bindWorkspaceTrustRecord(home, workspace, currents);
    await onReceipt?.(receiptPayload(ws, "bind", currents));
    return true;
  }
  const stale = trustSurfacesOutOfDate(record, currents);
  if (stale.length === 0) return true;
  const detail = [
    "Trusted workspace content changed:",
  ]
    .concat(stale.map((s) => `- ${s}`))
    .concat(DIGEST_FIELDS.filter((d) => currents[d.key] !== null).map((d) => {
      const current = currents[d.key]!;
      const stored = storedDigest(record, d.field);
      return `${d.label}: recorded ${(stored ?? "none").slice(0, 12)}… → now ${current.slice(0, 12)}…`;
    }))
    .join("\n");
  if (approve === undefined) {
    onNotice?.(`workspace trust out of date (${stale.join(", ")}); approve to re-trust`);
    return false;
  }
  const ok = await approve({
    title: "Re-trust workspace hooks/skills/agents after content changed?",
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
