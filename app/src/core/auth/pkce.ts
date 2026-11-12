import { createHash, randomBytes } from "node:crypto";

function base64Url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

/** RFC 7636 PKCE verifier + S256 challenge. */
export function createPkcePair(): { verifier: string; challenge: string; method: "S256" } {
  const verifier = base64Url(randomBytes(32));
  const challenge = base64Url(createHash("sha256").update(verifier).digest());
  return { verifier, challenge, method: "S256" };
}

export function newOAuthState(): string {
  return base64Url(randomBytes(16));
}
