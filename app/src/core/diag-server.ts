/**
 * diag-server.ts — loopback diagnostic endpoints
 * (grok xai-grok-diag-server ADAPT). Source: xai-grok-diag-server/src/lib.rs:42-93.
 *
 * Pure response model + bounded log ring for `/ready`, `/statusz`, `/logs`.
 * No socket, no HTTP server binding — the caller (loopback-only 0600 listener)
 * owns transport. Content-free: no secrets, no egress/sandbox `enforced` claim.
 */

export const DEFAULT_LOG_TAIL_BYTES = 64 * 1024;
export const MAX_LOG_TAIL_BYTES = 256 * 1024;
export const MAX_ERROR_DETAIL_BYTES = 256;

export interface DiagEnv {
  ready: boolean;
  state: "starting" | "ready" | "degraded" | "failed";
  errorDetail?: string;
  version?: string;
}

export interface ReadyBody {
  ready: boolean;
  state: DiagEnv["state"];
  version?: string;
  errorDetail?: string;
}

export function readyBody(env: DiagEnv): ReadyBody {
  const body: ReadyBody = { ready: env.ready, state: env.state };
  if (env.version !== undefined) body.version = env.version;
  if (env.errorDetail !== undefined) body.errorDetail = env.errorDetail.slice(0, MAX_ERROR_DETAIL_BYTES);
  return body;
}

export function statuszBody(env: DiagEnv): ReadyBody & { statusz: true } {
  return { ...readyBody(env), statusz: true };
}

/** Byte-bounded log ring (keeps the most recent bytes). */
export class LogRing {
  private lines: string[] = [];
  private bytes = 0;
  constructor(private readonly capacityBytes = MAX_LOG_TAIL_BYTES) {}

  push(line: string): void {
    const b = new TextEncoder().encode(line).length;
    this.lines.push(line);
    this.bytes += b;
    while (this.bytes > this.capacityBytes && this.lines.length > 1) {
      const removed = this.lines.shift()!;
      this.bytes -= new TextEncoder().encode(removed).length;
    }
  }

  /** Return the most recent lines whose combined bytes fit `tailBytes`. */
  tail(tailBytes = DEFAULT_LOG_TAIL_BYTES): string[] {
    const cap = Math.min(tailBytes, MAX_LOG_TAIL_BYTES);
    const out: string[] = [];
    let used = 0;
    for (let i = this.lines.length - 1; i >= 0; i -= 1) {
      const b = new TextEncoder().encode(this.lines[i]!).length;
      if (used + b > cap) break;
      used += b;
      out.unshift(this.lines[i]!);
    }
    return out;
  }
}

export interface DiagResponse { status: number; body: string }

/** Route a diagnostic path to a bounded JSON response. */
export function routeDiag(path: string, env: DiagEnv, logs: LogRing): DiagResponse {
  const [pathname, query = ""] = path.split("?");
  if (pathname === "/ready") return { status: 200, body: JSON.stringify(readyBody(env)) };
  if (pathname === "/statusz") return { status: 200, body: JSON.stringify(statuszBody(env)) };
  if (pathname === "/logs") {
    const match = /tail_bytes=(\d+)/.exec(query);
    const requested = match === null ? DEFAULT_LOG_TAIL_BYTES : Number(match[1]);
    return { status: 200, body: JSON.stringify({ lines: logs.tail(requested) }) };
  }
  return { status: 404, body: JSON.stringify({ error: "not found" }) };
}
