import { HUMAN_APPROVAL_PRINCIPAL, type GuardKind, type Lease } from "../contracts";
import { canonicalJson, sha256Hex } from "./canon";
import { humanPrincipalStrictEnabled } from "./human-approval-principal-strict";
import {
  loadOrCreateHumanKeyPair,
  signHumanApprovalPayload,
  type HumanKeyPair,
} from "./human-principal-keys";
import type { KernelClient } from "./kernel";

export { HUMAN_APPROVAL_PRINCIPAL };

export interface HumanApprovalMintOptions {
  /** Optional precomputed intent digest; defaults to sha256(canonicalJson({ kind, target, sessionId })). */
  intentDigest?: string;
  /** Optional explicit keypair (for deterministic tests). */
  keyPair?: HumanKeyPair;
  /** Optional home directory for loadOrCreateHumanKeyPair(). */
  home?: string;
  /** Optional explicit nonce (for deterministic tests). */
  nonce?: string;
  /** Optional explicit issuedAt timestamp in ms (for deterministic tests). */
  issuedAt?: number;
}

export interface SignedMintKernelOpts {
  principal: typeof HUMAN_APPROVAL_PRINCIPAL;
  humanSig?: string;
  humanPubKeyHex?: string;
  humanNonce?: string;
  humanIssuedAt?: number;
  intentDigest?: string;
}

export function humanApprovalOwner(sessionId: string): string {
  return `human:${sessionId}`;
}

/** Whether a held lease/grant owner speaks for this guard.check session id. */
export function ownerVisibleToSession(owner: string | undefined, sessionId: string | undefined): boolean {
  if (owner === undefined || owner === null || owner === "") return true;
  if (typeof sessionId !== "string" || sessionId === "") return false;
  return owner === sessionId || owner === humanApprovalOwner(sessionId);
}

function buildSignedHumanMintOpts(
  kind: GuardKind,
  pattern: string,
  sessionId: string,
  ttlMs: number,
  opts?: HumanApprovalMintOptions,
): SignedMintKernelOpts {
  const base: SignedMintKernelOpts = { principal: HUMAN_APPROVAL_PRINCIPAL };
  try {
    const keyPair = opts?.keyPair ?? loadOrCreateHumanKeyPair(opts?.home);
    const intentDigest =
      opts?.intentDigest ?? sha256Hex(canonicalJson({ kind, target: pattern, sessionId }));
    const signed = signHumanApprovalPayload({
      intentDigest,
      kind,
      target: pattern,
      sessionId,
      ttlMs,
      nonce: opts?.nonce,
      issuedAt: opts?.issuedAt,
      keyPair,
    });
    return {
      principal: HUMAN_APPROVAL_PRINCIPAL,
      humanSig: signed.humanSig,
      humanPubKeyHex: signed.humanPubKeyHex,
      humanNonce: signed.humanNonce,
      humanIssuedAt: signed.humanIssuedAt,
      intentDigest,
    };
  } catch (err) {
    if (humanPrincipalStrictEnabled()) {
      throw err instanceof Error ? err : new Error(String(err));
    }
    // Stay backwards-compatible with mock/in-memory kernels or read-only test homes
    // when a local keypair cannot be loaded or created and strict mode is off.
    return base;
  }
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
  opts?: HumanApprovalMintOptions,
): Promise<Lease> {
  if (pattern === "" || pattern.endsWith("*")) {
    throw new Error("human approval lease requires an exact target pattern");
  }
  const mintOpts = buildSignedHumanMintOpts(kind, pattern, sessionId, ttlMs, opts);
  return kernel.makeLease(kind, pattern, ttlMs, sessionId, mintOpts);
}

export async function mintHumanApprovalGrant(
  kernel: KernelClient,
  kind: GuardKind,
  pattern: string,
  sessionId: string,
  ttlMs: number,
  opts?: HumanApprovalMintOptions,
): Promise<Lease> {
  if (pattern === "" || pattern.endsWith("*")) {
    throw new Error("human approval grant requires an exact target pattern");
  }
  const mintOpts = buildSignedHumanMintOpts(kind, pattern, sessionId, ttlMs, opts);
  return kernel.makeGrant(kind, pattern, ttlMs, sessionId, mintOpts);
}
