import { HUMAN_APPROVAL_PRINCIPAL, type GuardKind, type Lease } from "../contracts";
import type { KernelClient } from "./kernel";

export { HUMAN_APPROVAL_PRINCIPAL };

export function humanApprovalOwner(sessionId: string): string {
  return `human:${sessionId}`;
}

/** Whether a held lease/grant owner speaks for this guard.check session id. */
export function ownerVisibleToSession(owner: string | undefined, sessionId: string | undefined): boolean {
  if (owner === undefined || owner === null || owner === "") return true;
  if (typeof sessionId !== "string" || sessionId === "") return false;
  return owner === sessionId || owner === humanApprovalOwner(sessionId);
}

/**
 * Mint a held one-use lease after human approval (exact target pattern only).
 * fd-3 (ruling 352) proves the controlling Bun parent for privileged mint RPCs — not a human;
 * `principal:"human"` is session-attested approval-path attribution only (ruling 682).
 */
export async function mintHumanApprovalLease(
  kernel: KernelClient,
  kind: GuardKind,
  pattern: string,
  sessionId: string,
  ttlMs: number,
): Promise<Lease> {
  if (pattern === "" || pattern.endsWith("*")) {
    throw new Error("human approval lease requires an exact target pattern");
  }
  return kernel.makeLease(kind, pattern, ttlMs, sessionId, { principal: HUMAN_APPROVAL_PRINCIPAL });
}

export async function mintHumanApprovalGrant(
  kernel: KernelClient,
  kind: GuardKind,
  pattern: string,
  sessionId: string,
  ttlMs: number,
): Promise<Lease> {
  if (pattern === "" || pattern.endsWith("*")) {
    throw new Error("human approval grant requires an exact target pattern");
  }
  return kernel.makeGrant(kind, pattern, ttlMs, sessionId, { principal: HUMAN_APPROVAL_PRINCIPAL });
}