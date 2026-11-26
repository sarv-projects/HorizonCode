/**
 * trust-spine-status.ts — read-only TUI trust-spine posture helpers (Wave A / Track A4).
 *
 * Inspects local human-principal ed25519 key posture, EffectHost routing mode,
 * egress/netns/TLS posture (never claiming enforced unless explicitly verified),
 * and PII-vault masking counts without mutating state or creating key material.
 */

import { createHash, createPublicKey } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import type { Runtime } from "../contracts";
import { effectHostKernelMode } from "../core/effect-kernel-mutation-route";
import { inspectLocalHumanKey } from "../core/human-principal-keys";

export type PrincipalMode = "ed25519" | "parent" | "unsigned";
export type EffectHostMode = "off" | "opt-in" | "default" | "require";
export type EgressTlsMode = "off" | "peek" | "intercept" | "terminate";

export interface EgressPosture {
  netns: boolean;
  tlsMode: EgressTlsMode;
  enforced: boolean;
}

export interface PiiVaultStatus {
  active: boolean;
  tokenCount: number;
}

export interface PrincipalPosture {
  principalMode: PrincipalMode;
  principalKeyFingerprint?: string;
}

function truthyEnv(val: string | undefined): boolean {
  if (typeof val !== "string") return false;
  const norm = val.trim().toLowerCase();
  return norm === "1" || norm === "true" || norm === "yes" || norm === "on";
}

/**
 * Validate ed25519 public key hex: accepts either a valid SPKI DER ed25519
 * public key (88 hex chars / 44 bytes) or a raw 32-byte ed25519 key (64 hex chars).
 */
export function isValidEd25519PublicKeyHex(pubHex: string): boolean {
  const trimmed = pubHex.trim();
  if (trimmed === "" || trimmed.length % 2 !== 0 || !/^[0-9a-fA-F]+$/.test(trimmed)) return false;
  if (trimmed.length === 64) return true; // raw 32-byte ed25519 key
  if (trimmed.length === 88) {
    try {
      const key = createPublicKey({
        key: Buffer.from(trimmed, "hex"),
        format: "der",
        type: "spki",
      });
      return key.asymmetricKeyType === "ed25519";
    } catch {
      return false;
    }
  }
  return false;
}

/**
 * Read-only local ed25519 human-principal key inspection.
 * Never creates or modifies key files; returns `"unsigned"` when absent,
 * symlinked (private or public key), non-file, or invalid key material.
 */
export function inspectPrincipalPosture(home: string = homedir()): PrincipalPosture {
  try {
    const resolvedHome = typeof home === "string" && home.trim() !== "" ? home.trim() : homedir();
    const posture = inspectLocalHumanKey(resolvedHome);
    if (!posture.present || posture.symlink) return { principalMode: "unsigned" };
    const privStat = lstatSync(posture.privateKey);
    const pubStat = lstatSync(posture.publicKey);
    if (privStat.isSymbolicLink() || !privStat.isFile()) return { principalMode: "unsigned" };
    if (pubStat.isSymbolicLink() || !pubStat.isFile()) return { principalMode: "unsigned" };
    const pubHex = readFileSync(posture.publicKey, "utf8").trim();
    if (isValidEd25519PublicKeyHex(pubHex)) {
      const fp = createHash("sha256").update(pubHex).digest("hex").slice(0, 12);
      return { principalMode: "ed25519", principalKeyFingerprint: fp };
    }
  } catch {
    /* unreadable or malformed key material -> report unsigned */
  }
  return { principalMode: "unsigned" };
}

/** Current EffectHost kernel routing mode from environment. */
export function readEffectHostMode(
  env: Record<string, string | undefined> = process.env,
): EffectHostMode {
  return effectHostKernelMode(env);
}

type RuntimeWithTrustSpine = Runtime & {
  effectHostMode?: EffectHostMode | (() => EffectHostMode);
  egressPosture?: EgressPosture | (() => EgressPosture | undefined);
  piiVaultStatus?: () => PiiVaultStatus | undefined;
  piiVault?: PiiVaultStatus;
};

/**
 * Read current egress/netns/TLS posture.
 * Honesty invariant: `enforced` is NEVER true unless explicitly confirmed by the runtime.
 */
export function readEgressPosture(
  runtime?: Runtime,
  env: Record<string, string | undefined> = process.env,
): EgressPosture {
  const rt = runtime as RuntimeWithTrustSpine | undefined;
  const fromRt = typeof rt?.egressPosture === "function" ? rt.egressPosture() : rt?.egressPosture;
  if (fromRt !== undefined) {
    return {
      netns: Boolean(fromRt.netns),
      tlsMode: fromRt.tlsMode,
      enforced: fromRt.enforced === true,
    };
  }
  const netns = truthyEnv(env.HZ_SANDBOX_NETNS);
  let tlsMode: EgressTlsMode = "off";
  if (truthyEnv(env.HZ_EGRESS_TLS_TERMINATE)) tlsMode = "terminate";
  else if (truthyEnv(env.HZ_EGRESS_TLS_INTERCEPT)) tlsMode = "intercept";
  else if (truthyEnv(env.HZ_EGRESS_TLS_PEEK)) tlsMode = "peek";
  // Advisory only until runtime confirms kernel-enforced netns+proxy confinement.
  return { netns, tlsMode, enforced: false };
}

/** Read current PII-vault masking posture when exposed by the runtime or env. */
export function readPiiVaultStatus(
  runtime?: Runtime,
  env: Record<string, string | undefined> = process.env,
): PiiVaultStatus | undefined {
  const rt = runtime as RuntimeWithTrustSpine | undefined;
  const fromRt =
    typeof rt?.piiVaultStatus === "function"
      ? rt.piiVaultStatus()
      : rt?.piiVault;
  if (fromRt !== undefined) {
    return {
      active: Boolean(fromRt.active),
      tokenCount: Math.max(0, Math.floor(Number(fromRt.tokenCount) || 0)),
    };
  }
  if (truthyEnv(env.HZ_PII_VAULT)) {
    return { active: true, tokenCount: 0 };
  }
  return undefined;
}
