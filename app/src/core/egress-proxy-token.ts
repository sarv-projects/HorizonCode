/**
 * egress-proxy-token.ts — per-call MITM proxy tokens with exact revocation.
 * ADAPT of grok `revoke_exact` / codex per-call proxy credentials (the "must
 * steal" MITM piece). Pure, hermetic: tokens are random; the manager holds the
 * only mapping. Tokens are scoped to one (host, port) origin and expire; a
 * `revokeExact(id)` removes exactly one token without touching siblings.
 *
 * Advisory credential material only — does NOT terminate TLS, bind a socket,
 * or enforce egress. Never shell-net `enforced`.
 */

import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";

export const TOKEN_BYTES = 32;
const DEFAULT_TTL_MS = 600_000; // 10 min, mirroring grok's parked-Ask backstop

export interface ProxyToken {
  id: string;
  token: string;
  host: string;
  port: number;
  issuedAtMs: number;
}

interface StoredToken extends ProxyToken {
  tokenBuf: Buffer;
}

export interface ProxyTokenManagerOptions {
  now?: () => number;
  ttlMs?: number;
}

export class ProxyTokenManager {
  private readonly tokens = new Map<string, StoredToken>();
  private readonly now: () => number;
  private readonly ttlMs: number;

  constructor(opts: ProxyTokenManagerOptions = {}) {
    this.now = opts.now ?? Date.now;
    this.ttlMs = Math.max(1, Math.floor(opts.ttlMs ?? DEFAULT_TTL_MS));
  }

  private evictExpired(nowMs: number): void {
    for (const [id, stored] of this.tokens) {
      if (nowMs - stored.issuedAtMs >= this.ttlMs) {
        this.tokens.delete(id);
      }
    }
  }

  /** Issue a random token bound to one origin. */
  issue(host: string, port: number): ProxyToken {
    const h = typeof host === "string" ? host.trim().toLowerCase() : "";
    if (h === "") throw new Error("HZ_PRECONDITION_FAILED: proxy token requires an origin host");
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new Error("HZ_PRECONDITION_FAILED: proxy token requires a valid port");
    }
    const nowMs = this.now();
    this.evictExpired(nowMs);
    const token = randomBytes(TOKEN_BYTES).toString("hex");
    const stored: StoredToken = {
      id: randomUUID(),
      token,
      tokenBuf: Buffer.from(token, "utf8"),
      host: h,
      port,
      issuedAtMs: nowMs,
    };
    this.tokens.set(stored.id, stored);
    return {
      id: stored.id,
      token: stored.token,
      host: stored.host,
      port: stored.port,
      issuedAtMs: stored.issuedAtMs,
    };
  }

  verify(token: string, host: string, port: number): boolean {
    if (typeof token !== "string" || token === "") return false;
    const nowMs = this.now();
    this.evictExpired(nowMs);
    const candidateBuf = Buffer.from(token, "utf8");
    const normHost = host.trim().toLowerCase();
    for (const stored of this.tokens.values()) {
      if (stored.tokenBuf.length !== candidateBuf.length) continue;
      if (!timingSafeEqual(stored.tokenBuf, candidateBuf)) continue;
      return stored.host === normHost && stored.port === port;
    }
    return false;
  }

  /** Revoke exactly one token by id; returns false when unknown or already revoked. */
  revokeExact(id: string): boolean {
    return this.tokens.delete(id);
  }
}
