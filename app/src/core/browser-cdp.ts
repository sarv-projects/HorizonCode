/**
 * Headless browser verification via Chrome DevTools Protocol (ruling 643).
 *
 * Zero runtime deps: HTTP + WebSocket to an already-running Chromium with
 * `--remote-debugging-port`. Captures a PNG screenshot into the workspace
 * verification dir for Verification Artifacts.
 *
 * Does **not** bundle Chromium, claim Playwright parity, or start a browser
 * when none is listening (fail closed with a typed error).
 */

import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import {
  admitVerificationFsWrite,
  resolveHzVerificationPath,
} from "./verification-artifact";

export type BrowserCdpTarget = {
  id: string;
  title: string;
  url: string;
  webSocketDebuggerUrl?: string;
  type?: string;
};

export type CaptureScreenshotResult = {
  ok: true;
  path: string;
  sha256: string;
  bytes: number;
  url: string;
} | {
  ok: false;
  error: string;
};

export function cdpEndpointFromEnv(
  env: Record<string, string | undefined> = process.env,
): string {
  const raw = env.HZ_BROWSER_CDP?.trim();
  if (raw !== undefined && raw !== "") return raw.replace(/\/$/, "");
  return "http://127.0.0.1:9222";
}

/** List open page targets from a CDP HTTP endpoint. */
export async function listCdpTargets(
  endpoint: string,
  fetchImpl: typeof fetch = fetch,
): Promise<BrowserCdpTarget[]> {
  const res = await fetchImpl(`${endpoint}/json/list`);
  if (!res.ok) {
    throw new Error(`CDP list failed: HTTP ${res.status}`);
  }
  const data = (await res.json()) as unknown;
  if (!Array.isArray(data)) return [];
  return data.filter((row): row is BrowserCdpTarget => {
    return (
      row !== null &&
      typeof row === "object" &&
      typeof (row as BrowserCdpTarget).id === "string" &&
      typeof (row as BrowserCdpTarget).url === "string"
    );
  });
}

function pickPageTarget(targets: BrowserCdpTarget[]): BrowserCdpTarget | undefined {
  return (
    targets.find((t) => t.type === "page" && t.webSocketDebuggerUrl) ??
    targets.find((t) => t.webSocketDebuggerUrl)
  );
}

type WsLike = {
  send(data: string): void;
  close(): void;
  addEventListener(type: "message" | "open" | "error" | "close", fn: (ev: { data?: unknown }) => void): void;
};

export type CaptureScreenshotOpts = {
  endpoint?: string;
  workspace: string;
  /** Navigate before capture; omitted = screenshot current page. */
  navigateUrl?: string;
  fileName?: string;
  fetchImpl?: typeof fetch;
  /** Inject WebSocket for tests. */
  openWebSocket?: (url: string) => WsLike;
  timeoutMs?: number;
};

/**
 * Capture a PNG via CDP Page.captureScreenshot. Requires a live Chromium
 * remote-debugging endpoint (or injected WebSocket).
 */
export async function captureBrowserScreenshot(
  opts: CaptureScreenshotOpts,
): Promise<CaptureScreenshotResult> {
  const endpoint = opts.endpoint ?? cdpEndpointFromEnv();
  const timeoutMs = opts.timeoutMs ?? 15_000;
  let targets: BrowserCdpTarget[];
  try {
    targets = await listCdpTargets(endpoint, opts.fetchImpl ?? fetch);
  } catch (err) {
    return {
      ok: false,
      error: `browser CDP unreachable at ${endpoint}: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  const target = pickPageTarget(targets);
  if (!target?.webSocketDebuggerUrl) {
    return {
      ok: false,
      error: `no CDP page target with webSocketDebuggerUrl at ${endpoint}`,
    };
  }

  const openWs =
    opts.openWebSocket ??
    ((url: string) => new WebSocket(url) as unknown as WsLike);

  return await new Promise<CaptureScreenshotResult>((resolve) => {
    let settled = false;
    const finish = (result: CaptureScreenshotResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        ws.close();
      } catch {
        /* ignore */
      }
      resolve(result);
    };
    const timer = setTimeout(() => {
      finish({ ok: false, error: `CDP screenshot timed out after ${timeoutMs}ms` });
    }, timeoutMs);

    let nextId = 1;
    const pending = new Map<number, (result: unknown) => void>();
    const ws = openWs(target.webSocketDebuggerUrl!);

    const call = (method: string, params?: Record<string, unknown>): Promise<unknown> => {
      const id = nextId++;
      return new Promise((res, rej) => {
        pending.set(id, (msg) => {
          const row = msg as { result?: unknown; error?: { message?: string } };
          if (row.error) rej(new Error(row.error.message ?? "CDP error"));
          else res(row.result);
        });
        ws.send(JSON.stringify({ id, method, params: params ?? {} }));
      });
    };

    ws.addEventListener("message", (ev) => {
      try {
        const msg = JSON.parse(String(ev.data ?? "")) as { id?: number };
        if (typeof msg.id === "number" && pending.has(msg.id)) {
          const cb = pending.get(msg.id)!;
          pending.delete(msg.id);
          cb(msg);
        }
      } catch {
        /* ignore malformed */
      }
    });
    ws.addEventListener("error", () => {
      finish({ ok: false, error: "CDP WebSocket error" });
    });

    const run = async () => {
      try {
        await call("Page.enable");
        if (opts.navigateUrl) {
          await call("Page.navigate", { url: opts.navigateUrl });
          // Best-effort wait; hosts that inject WS can resolve immediately.
          await new Promise((r) => setTimeout(r, 250));
        }
        const shot = (await call("Page.captureScreenshot", {
          format: "png",
          fromSurface: true,
        })) as { data?: string };
        if (typeof shot?.data !== "string" || shot.data === "") {
          finish({ ok: false, error: "Page.captureScreenshot returned no data" });
          return;
        }
        const bytes = Buffer.from(shot.data, "base64");
        const fileName = opts.fileName ?? `shot-${Date.now()}.png`;
        let outPath: string;
        try {
          outPath = resolveHzVerificationPath(opts.workspace, ["verification", "screenshots"], fileName);
        } catch (err) {
          finish({
            ok: false,
            error: err instanceof Error ? err.message : String(err),
          });
          return;
        }
        const refused = await admitVerificationFsWrite(outPath, opts.workspace);
        if (refused !== undefined) {
          finish({ ok: false, error: refused });
          return;
        }
        mkdirSync(path.dirname(outPath), { recursive: true });
        writeFileSync(outPath, bytes);
        const sha256 = createHash("sha256").update(bytes).digest("hex");
        finish({
          ok: true,
          path: outPath,
          sha256,
          bytes: bytes.length,
          url: opts.navigateUrl ?? target.url,
        });
      } catch (err) {
        finish({
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    };

    let started = false;
    const start = () => {
      if (started) return;
      started = true;
      void run();
    };
    ws.addEventListener("open", start);
    // Test doubles / already-open sockets.
    const readyState = (ws as unknown as { readyState?: number }).readyState;
    if (typeof readyState === "number" && readyState === 1) {
      start();
    }
  });
}
