/**
 * One-shot loopback OAuth redirect capture (docs/33 §5.6).
 */

export interface OAuthCallbackResult {
  code?: string;
  error?: string;
  errorDescription?: string;
}

export interface OAuthCallbackListener {
  port: number;
  redirectUri: string;
  result: Promise<OAuthCallbackResult>;
  stop: () => void;
}

export function startOAuthCallbackListener(opts: {
  state: string;
  path?: string;
  timeoutMs?: number;
}): OAuthCallbackListener {
  const path = opts.path ?? "/callback";
  const timeoutMs = opts.timeoutMs ?? 5 * 60 * 1000;
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;

  let server: ReturnType<typeof Bun.serve> | undefined;
  let settled = false;

  const result = new Promise<OAuthCallbackResult>((resolve, reject) => {
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        server?.stop();
        reject(new Error("oauth callback timed out"));
      }
    }, timeoutMs);

    server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(req) {
        const url = new URL(req.url);
        if (url.pathname !== normalizedPath) return new Response("not found", { status: 404 });
        if ((url.searchParams.get("state") ?? "") !== opts.state) return new Response("state mismatch", { status: 400 });
        const finish = (value: OAuthCallbackResult): Response => {
          if (!settled) {
            settled = true;
            clearTimeout(timer);
            server?.stop();
            resolve(value);
          }
          return new Response("Login complete. You can close this tab.", { status: 200, headers: { "content-type": "text/plain" } });
        };
        const err = url.searchParams.get("error");
        if (err) return finish({ error: err, errorDescription: url.searchParams.get("error_description") ?? undefined });
        const code = url.searchParams.get("code");
        if (!code) return new Response("missing code", { status: 400 });
        return finish({ code });
      },
    });
  });

  const port = server!.port ?? 0;
  const redirectUri = `http://127.0.0.1:${port}${normalizedPath}`;
  return {
    port,
    redirectUri,
    result,
    stop: () => server?.stop(),
  };
}
