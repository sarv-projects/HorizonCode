/**
 * human-principal-keys.ts -- host-local ed25519 approval keypair (docs/28 §14).
 *
 * HONEST SCOPE: this proves possession of a key stored in the user's config
 * directory. It does NOT prove a cryptographic human identity (no WebAuthn,
 * Secure Enclave or OS attestation), so callers must not claim `principal:
 * "human"` is cryptographically attested from this alone.
 */

import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
  sign,
  verify,
} from "node:crypto";
import {
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import * as path from "node:path";

export interface HumanKeyPair {
  /** SPKI DER, hex. */
  publicKeyHex: string;
  /** PKCS#8 DER, hex. */
  privateKeyHex: string;
}

export function generateHumanKeyPair(): HumanKeyPair {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return {
    publicKeyHex: publicKey.export({ type: "spki", format: "der" }).toString("hex"),
    privateKeyHex: privateKey.export({ type: "pkcs8", format: "der" }).toString("hex"),
  };
}

function fromHex(value: string): Buffer {
  if (value.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(value)) throw new Error("invalid hex key material");
  return Buffer.from(value, "hex");
}

export function signApproval(privateKeyHex: string, intent: string): string {
  const key = createPrivateKey({ key: fromHex(privateKeyHex), format: "der", type: "pkcs8" });
  return sign(null, Buffer.from(intent, "utf8"), key).toString("hex");
}

export function verifyApproval(publicKeyHex: string, intent: string, signatureHex: string): boolean {
  try {
    const key = createPublicKey({ key: fromHex(publicKeyHex), format: "der", type: "spki" });
    return verify(null, Buffer.from(intent, "utf8"), key, fromHex(signatureHex));
  } catch {
    return false;
  }
}

export function humanKeyPaths(home: string): { dir: string; privateKey: string; publicKey: string } {
  const dir = path.join(home, ".config", "horizon", "keys");
  return {
    dir,
    privateKey: path.join(dir, "human-approval.key"),
    publicKey: path.join(dir, "human-approval.pub"),
  };
}

export interface LocalHumanKeyPosture {
  present: boolean;
  symlink: boolean;
  privateKey: string;
  publicKey: string;
}

/** Read-only posture check: never creates or modifies key material. */
export function inspectLocalHumanKey(home: string): LocalHumanKeyPosture {
  const paths = humanKeyPaths(home);
  const privatePresent = existsSync(paths.privateKey);
  return {
    present: privatePresent && existsSync(paths.publicKey),
    symlink: privatePresent && lstatSync(paths.privateKey).isSymbolicLink(),
    privateKey: paths.privateKey,
    publicKey: paths.publicKey,
  };
}

function assertNotSymlinkPath(targetPath: string): void {
  try {
    if (lstatSync(targetPath).isSymbolicLink()) {
      throw new Error(`refusing symlink at human approval key path: ${targetPath}`);
    }
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | undefined)?.code;
    if (code === "ENOENT") return;
    throw err;
  }
}

function atomicPlaceKeyFile(tmpPath: string, destPath: string): boolean {
  try {
    linkSync(tmpPath, destPath);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | undefined)?.code;
    if (code === "EEXIST") return false;
    // Fallback for filesystems that do not support hard links (e.g. some mounts).
    if (code === "EPERM" || code === "ENOTSUP" || code === "ENOSYS" || code === "EXDEV") {
      if (existsSync(destPath)) return false;
      renameSync(tmpPath, destPath);
      return true;
    }
    throw err;
  }
}

/** Load the local pair, creating it once with 0700 dir / 0600 files. */
export function loadOrCreateHumanKeyPair(home: string = homedir()): HumanKeyPair {
  const resolvedHome = path.resolve(home);
  const configDir = path.join(resolvedHome, ".config");
  const horizonDir = path.join(configDir, "horizon");
  const paths = humanKeyPaths(resolvedHome);
  for (const p of [resolvedHome, configDir, horizonDir, paths.dir, paths.privateKey, paths.publicKey]) {
    assertNotSymlinkPath(p);
  }
  mkdirSync(paths.dir, { recursive: true, mode: 0o700 });
  for (const p of [configDir, horizonDir, paths.dir, paths.privateKey, paths.publicKey]) {
    assertNotSymlinkPath(p);
  }
  if (existsSync(paths.privateKey) && existsSync(paths.publicKey)) {
    const privateKeyHex = readFileSync(paths.privateKey, "utf8").trim();
    const publicKeyHex = readFileSync(paths.publicKey, "utf8").trim();
    fromHex(privateKeyHex);
    fromHex(publicKeyHex);
    return { privateKeyHex, publicKeyHex };
  }
  const pair = generateHumanKeyPair();
  const suffix = `${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
  const privTmp = path.join(paths.dir, `.human-approval.key.${suffix}`);
  const pubTmp = path.join(paths.dir, `.human-approval.pub.${suffix}`);
  try {
    writeFileSync(privTmp, `${pair.privateKeyHex}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
    writeFileSync(pubTmp, `${pair.publicKeyHex}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
    const wonPrivate = atomicPlaceKeyFile(privTmp, paths.privateKey);
    if (wonPrivate) {
      // Only the process that created the private key atomically publishes the matching public key.
      renameSync(pubTmp, paths.publicKey);
    } else if (!existsSync(paths.publicKey)) {
      atomicPlaceKeyFile(pubTmp, paths.publicKey);
    }
  } finally {
    for (const tmp of [privTmp, pubTmp]) {
      try {
        if (existsSync(tmp)) unlinkSync(tmp);
      } catch {
        /* best-effort cleanup */
      }
    }
  }
  const privateKeyHex = readFileSync(paths.privateKey, "utf8").trim();
  const publicKeyHex = readFileSync(paths.publicKey, "utf8").trim();
  fromHex(privateKeyHex);
  fromHex(publicKeyHex);
  return { privateKeyHex, publicKeyHex };
}

export interface HumanApprovalPayloadInput {
  intentDigest: string;
  kind: string;
  target: string;
  sessionId: string;
  ttlMs: number;
  nonce: string;
  issuedAt: number;
}

/**
 * Canonical signing payload for human-approved grants/leases.
 * Matches the exact byte-for-byte Rust kernel format:
 *   hz-human-approval-v1\nintent=...\nkind=...\ntarget=...\nsession=...\nttl_ms=...\nnonce=...\nissued_at=...
 */
export function canonicalHumanApprovalPayload({
  intentDigest,
  kind,
  target,
  sessionId,
  ttlMs,
  nonce,
  issuedAt,
}: HumanApprovalPayloadInput): string {
  return [
    "hz-human-approval-v1",
    `intent=${intentDigest}`,
    `kind=${kind}`,
    `target=${target}`,
    `session=${sessionId}`,
    `ttl_ms=${ttlMs}`,
    `nonce=${nonce}`,
    `issued_at=${issuedAt}`,
  ].join("\n");
}

/** First 12 lowercase hex chars of SHA-256(publicKeyHex). */
export function humanKeyFingerprint(publicKeyHex: string): string {
  return createHash("sha256").update(publicKeyHex, "utf8").digest("hex").slice(0, 12);
}

export interface SignHumanApprovalPayloadInput {
  intentDigest: string;
  kind: string;
  target: string;
  sessionId: string;
  ttlMs: number;
  nonce?: string;
  issuedAt?: number;
  keyPair?: HumanKeyPair;
  home?: string;
}

export interface SignedHumanApprovalPayload {
  humanSig: string;
  humanPubKeyHex: string;
  humanNonce: string;
  humanIssuedAt: number;
  fingerprint: string;
}

/** Sign a canonical human approval payload with the provided or local ed25519 keypair. */
export function signHumanApprovalPayload(input: SignHumanApprovalPayloadInput): SignedHumanApprovalPayload {
  const pair = input.keyPair ?? loadOrCreateHumanKeyPair(input.home ?? homedir());
  const humanNonce = input.nonce ?? randomBytes(16).toString("hex");
  const humanIssuedAt = input.issuedAt ?? Date.now();
  const payload = canonicalHumanApprovalPayload({
    intentDigest: input.intentDigest,
    kind: input.kind,
    target: input.target,
    sessionId: input.sessionId,
    ttlMs: input.ttlMs,
    nonce: humanNonce,
    issuedAt: humanIssuedAt,
  });
  const humanSig = signApproval(pair.privateKeyHex, payload);
  return {
    humanSig,
    humanPubKeyHex: pair.publicKeyHex,
    humanNonce,
    humanIssuedAt,
    fingerprint: humanKeyFingerprint(pair.publicKeyHex),
  };
}

/** Verify a canonical human approval payload signature. */
export function verifyHumanApprovalPayload(
  input: HumanApprovalPayloadInput,
  publicKeyHex: string,
  signatureHex: string,
): boolean {
  return verifyApproval(publicKeyHex, canonicalHumanApprovalPayload(input), signatureHex);
}
