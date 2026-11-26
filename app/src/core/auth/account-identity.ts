/**
 * Best-effort stable account identity from JWT access-token claims.
 * These unverified claims are metadata only; never use them for authorization.
 */
export function extractOAuthAccountId(accessToken: string | undefined): string | undefined {
  if (typeof accessToken !== "string") return undefined;
  const parts = accessToken.split(".");
  if (parts.length !== 3 || parts[1] === "") return undefined;
  try {
    const payload: unknown = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return undefined;
    const claims = payload as Record<string, unknown>;
    const auth = claims["https://api.openai.com/auth"];
    const authClaims = typeof auth === "object" && auth !== null && !Array.isArray(auth) ? auth as Record<string, unknown> : undefined;
    for (const candidate of [claims.account_id, claims.accountId, authClaims?.chatgpt_account_id, claims.user_id, claims.sub]) {
      if (typeof candidate !== "string") continue;
      const normalized = candidate.trim();
      if (normalized.length > 0 && normalized.length <= 512) return normalized;
    }
    return undefined;
  } catch {
    return undefined;
  }
}
