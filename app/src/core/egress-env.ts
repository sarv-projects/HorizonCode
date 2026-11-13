/**
 * Optional egress proxy env (docs/33 §5.2 stage 1 reduced).
 *
 * When `HZ_EGRESS_PROXY` is set, shell children receive `HTTP_PROXY` and
 * `HTTPS_PROXY`. This is transport routing only — not enforcement. A child
 * can bypass unless network confinement (5.3) forces traffic through the proxy.
 */

export function normalizeEgressProxyUrl(raw: string): string | undefined {
  const t = raw.trim();
  if (t === "" || t === "0" || t.toLowerCase() === "false") return undefined;
  if (/^https?:\/\//i.test(t)) return t;
  if (/^[\w.-]+:\d+$/.test(t)) return `http://${t}`;
  return undefined;
}

/** Proxy URL from the environment, if any. */
export function egressProxyFromEnv(env: Record<string, string | undefined>): string | undefined {
  const raw = env.HZ_EGRESS_PROXY;
  if (typeof raw !== "string") return undefined;
  return normalizeEgressProxyUrl(raw);
}

/**
 * Merge HTTP(S)_PROXY when HZ_EGRESS_PROXY is set. Existing proxy vars on the
 * child win (we do not overwrite).
 */
export function mergeEgressProxyEnv(
  base: Record<string, string | undefined>,
): Record<string, string | undefined> {
  const proxy = egressProxyFromEnv(base);
  if (proxy === undefined) return base;
  const out = { ...base };
  if (out.HTTP_PROXY === undefined || out.HTTP_PROXY === "") out.HTTP_PROXY = proxy;
  if (out.HTTPS_PROXY === undefined || out.HTTPS_PROXY === "") out.HTTPS_PROXY = proxy;
  if (out.http_proxy === undefined || out.http_proxy === "") out.http_proxy = proxy;
  if (out.https_proxy === undefined || out.https_proxy === "") out.https_proxy = proxy;
  return out;
}
