/**
 * Loopback CONNECT proxy wired to egress-decider (docs/33 §5.2 stage 1 reduced).
 *
 * Advisory only: setting HTTP_PROXY on shell children does not prove MITM;
 * netns-only-route denial and TLS intercept remain open.
 */

import net from "node:net";
import http from "node:http";
import { mkdirSync } from "node:fs";
import * as path from "node:path";
import { nowIso, type EgressPolicyDoc, type EgressOriginRule } from "../contracts";
import {
  connectAdmits,
  decideConnectAuthority,
  loadEgressPolicy,
  parseEgressPolicyDoc,
  type EgressDecision,
} from "./egress-decider";
import { appendJsonlSync } from "./jsonl-append";
import { assertDialAddressStillPinned, resolveAndPin } from "./egress-dial-pin";
import { EGRESS_TLS_INTERCEPT_REFUSE_BODY, egressTlsInterceptRefuseForward } from "./egress-tls-intercept-ca";
import { egressTlsPeekEnabled, parseTlsClientHelloSni } from "./egress-tls-peek";
import { egressTlsTerminateAttempt, terminateTlsOnConnectSocket, type TlsCredentialInjection } from "./egress-tls-terminate";

export type EgressTlsSniPeekRecord = {
  authority: string;
  sni: string;
};

export type EgressTlsTerminateRecord = {
  authority: string;
  servername: string;
  firstHttpLine: string | undefined;
};

export type EgressConnectProxy = {
  url: string;
  port: number;
  /** Recent CONNECT decisions (content-free). */
  records: EgressConnectRecord[];
  /** ClientHello SNI peek lines when HZ_EGRESS_TLS_PEEK=1 (logging only). */
  sniPeeks: EgressTlsSniPeekRecord[];
  /** First HTTP line observations when HZ_EGRESS_TLS_TERMINATE=1 (hermetic precursor). */
  terminateObservations: EgressTlsTerminateRecord[];
  stop: () => void;
};

export type EgressConnectRecord = {
  authority: string;
  decision: EgressDecision["kind"];
  status: number;
};

export type StartEgressConnectProxyOptions = {
  port?: number;
  /** Listen address (default loopback). Hermetic netns veth probes bind the parent bridge IP (**315**). */
  listenHost?: string;
  /** Load `<stateDir>/egress.json` when set. */
  stateDir?: string;
  /** In-memory policy for hermetic tests (overrides stateDir when both set). */
  policy?: EgressPolicyDoc | EgressOriginRule[];
  /** When true, pipe allowed CONNECT tunnels (TCP). Default from `HZ_EGRESS_FORWARD=1`. */
  forward?: boolean;
  /** Log ClientHello SNI on forward (default from `HZ_EGRESS_TLS_PEEK=1` when forward is on). */
  tlsPeek?: boolean;
  env?: Record<string, string | undefined>;
  /**
   * ADDITIVE opt-in MITM credential injection: when TLS terminate + upstream
   * pipe is active, scoped credential headers are injected into the decrypted
   * request before forwarding. Default absent = byte-identical. Advisory only;
   * never shell-net `enforced`.
   */
  credentialInjection?: TlsCredentialInjection;
};

export function egressForwardEnabled(env: Record<string, string | undefined> = process.env): boolean {
  const raw = env.HZ_EGRESS_FORWARD;
  if (raw === "1") return true;
  if (typeof raw === "string" && raw.trim().toLowerCase() === "true") return true;
  return false;
}

function policyFromOptions(opts: StartEgressConnectProxyOptions) {
  if (opts.policy !== undefined) return parseEgressPolicyDoc(opts.policy);
  if (opts.stateDir !== undefined) return loadEgressPolicy(opts.stateDir);
  return undefined;
}

function parseConnectAuthority(authority: string): { host: string; port: number } | undefined {
  const trimmed = authority.trim();
  if (trimmed === "" || /\s/.test(trimmed)) return undefined;
  const colon = trimmed.lastIndexOf(":");
  if (colon < 0) return { host: trimmed, port: 443 };
  const host = trimmed.slice(0, colon);
  const portPart = trimmed.slice(colon + 1);
  if (!/^\d+$/.test(portPart)) return undefined;
  const port = Number(portPart);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return undefined;
  if (host === "") return undefined;
  return { host, port };
}

function writeHttpResponse(socket: net.Socket, status: number, body: string): void {
  const payload = body.endsWith("\n") ? body : `${body}\n`;
  socket.write(`HTTP/1.1 ${status} \r\nContent-Length: ${Buffer.byteLength(payload, "utf8")}\r\n\r\n${payload}`);
  socket.end();
}

const TLS_PEEK_ACCUM_MAX = 16 * 1024;

function pipeConnectTunnel(
  client: net.Socket,
  host: string,
  port: number,
  initial: Buffer,
  onEstablished: () => void,
  onFailed: () => void,
  tlsPeek: boolean,
  authority: string,
  sniPeeks: EgressTlsSniPeekRecord[],
): void {
  const upstream = net.connect({ host, port });
  const fail = () => {
    onFailed();
    writeHttpResponse(client, 502, "CONNECT upstream failed\n");
  };
  upstream.once("error", fail);
  upstream.once("connect", () => {
    onEstablished();
    client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    let peekBuf = Buffer.from(initial);
    let sniLogged = false;
    const maybePeekSni = () => {
      if (!tlsPeek || sniLogged) return;
      const sni = parseTlsClientHelloSni(peekBuf);
      if (sni === undefined) return;
      sniLogged = true;
      sniPeeks.push({ authority, sni });
    };
    maybePeekSni();
    const forwardClientChunk = (chunk: Buffer) => {
      if (tlsPeek && !sniLogged && peekBuf.length < TLS_PEEK_ACCUM_MAX) {
        peekBuf = Buffer.concat([peekBuf, chunk]);
        maybePeekSni();
      }
      if (!upstream.destroyed) upstream.write(chunk);
    };
    if (initial.length > 0) upstream.write(initial);
    client.on("data", (chunk: Buffer) => {
      forwardClientChunk(chunk);
    });
    upstream.on("data", (chunk) => {
      if (!client.destroyed) client.write(chunk);
    });
    const closeBoth = () => {
      client.destroy();
      upstream.destroy();
    };
    client.on("end", closeBoth);
    client.on("error", closeBoth);
    upstream.on("end", closeBoth);
    upstream.on("error", closeBoth);
  });
}

function handleConnectClient(
  socket: net.Socket,
  policy: ReturnType<typeof parseEgressPolicyDoc> | undefined,
  forward: boolean,
  tlsPeek: boolean,
  records: EgressConnectRecord[],
  sniPeeks: EgressTlsSniPeekRecord[],
  terminateObservations: EgressTlsTerminateRecord[],
  env: Record<string, string | undefined>,
  credentialInjection?: TlsCredentialInjection,
): void {
  let buffer = Buffer.alloc(0);
  const onData = (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk]);
    const headerEnd = buffer.indexOf("\r\n\r\n");
    if (headerEnd < 0) return;
    socket.off("data", onData);

    const headerText = buffer.subarray(0, headerEnd).toString("latin1");
    const body = buffer.subarray(headerEnd + 4);
    const firstLine = headerText.split("\r\n")[0] ?? "";
    const match = /^CONNECT\s+(\S+)\s+HTTP\/\d/i.exec(firstLine);
    if (!match) {
      writeHttpResponse(socket, 501, "egress connect proxy: CONNECT only");
      return;
    }
    let authority = match[1] ?? "";
    if (authority === "/" || authority === "") {
      const hostLine = headerText
        .split("\r\n")
        .find((line) => line.toLowerCase().startsWith("host:"));
      authority = hostLine?.slice("host:".length).trim() ?? "";
    }

    if (!authority) {
      records.push({ authority: "", decision: "deny", status: 400 });
      writeHttpResponse(socket, 400, "CONNECT missing authority");
      return;
    }
    if (!policy) {
      records.push({ authority, decision: "deny", status: 503 });
      writeHttpResponse(socket, 503, "egress policy not loaded (egress.json absent)");
      return;
    }
    const decision = decideConnectAuthority(policy, authority);
    if (decision === "unparseable") {
      records.push({ authority, decision: "deny", status: 403 });
      writeHttpResponse(socket, 403, "CONNECT authority not allowed (unparseable)");
      return;
    }
    if (!connectAdmits(decision)) {
      records.push({ authority, decision: decision.kind, status: 403 });
      writeHttpResponse(socket, 403, `CONNECT denied (${decision.kind})`);
      return;
    }
    if (!forward) {
      records.push({ authority, decision: decision.kind, status: 502 });
      writeHttpResponse(
        socket,
        502,
        "CONNECT allowed by policy; forward tunnel not enabled (set HZ_EGRESS_FORWARD=1; MITM still open)",
      );
      return;
    }

    if (egressTlsInterceptRefuseForward(env)) {
      records.push({ authority, decision: decision.kind, status: 502 });
      writeHttpResponse(socket, 502, EGRESS_TLS_INTERCEPT_REFUSE_BODY);
      return;
    }

    if (egressTlsTerminateAttempt(env)) {
      records.push({ authority, decision: decision.kind, status: 200 });
      const upstreamTarget = parseConnectAuthority(authority);
      terminateTlsOnConnectSocket(
        socket,
        authority,
        body,
        env,
        (obs) => {
          terminateObservations.push({
            authority,
            servername: obs.servername,
            firstHttpLine: obs.firstHttpLine,
          });
        },
        upstreamTarget ?? undefined,
        credentialInjection,
      );
      return;
    }

    const target = parseConnectAuthority(authority);
    if (!target) {
      records.push({ authority, decision: "deny", status: 403 });
      writeHttpResponse(socket, 403, "CONNECT authority not allowed (unparseable)");
      return;
    }

    records.push({ authority, decision: decision.kind, status: 200 });
    pipeConnectTunnel(
      socket,
      target.host,
      target.port,
      body,
      () => {},
      () => {
        const last = records[records.length - 1];
        if (last?.authority === authority) last.status = 502;
      },
      tlsPeek && forward,
      authority,
      sniPeeks,
    );
  };
  socket.on("data", onData);
  socket.on("error", () => {
    socket.destroy();
  });
}

export function startEgressConnectProxy(opts: StartEgressConnectProxyOptions = {}): Promise<EgressConnectProxy> {
  const policy = policyFromOptions(opts);
  const records: EgressConnectRecord[] = [];
  const sniPeeks: EgressTlsSniPeekRecord[] = [];
  const terminateObservations: EgressTlsTerminateRecord[] = [];
  const env = opts.env ?? process.env;
  const forward = opts.forward ?? egressForwardEnabled(env);
  const tlsPeek = opts.tlsPeek ?? (forward && egressTlsPeekEnabled(env));
  const port = opts.port ?? 0;
  const listenHost = opts.listenHost ?? "127.0.0.1";

  return new Promise((resolve, reject) => {
    const server = net.createServer((socket) => {
      handleConnectClient(socket, policy, forward, tlsPeek, records, sniPeeks, terminateObservations, env, opts.credentialInjection);
    });
    server.on("error", (err) => reject(err));
    server.listen(port, listenHost, () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") {
        server.close();
        reject(new Error("egress connect proxy: no listen port"));
        return;
      }
      resolve({
        url: `http://${listenHost}:${addr.port}`,
        port: addr.port,
        records,
        sniPeeks,
        terminateObservations,
        stop: () => server.close(),
      });
    });
  });
}

/* ========================================================================== *
 * J-3 — bounded, audited, TLS-interception-free CONNECT seam (ADDITIVE).
 *
 * This is the tractable adapter half of the routed-proxy row. It is a minimal
 * local HTTP CONNECT proxy (node:http for the CONNECT handshake, node:net for
 * the raw TCP tunnel) that consults the SAME per-origin egress decider the
 * kernel uses BEFORE it opens a tunnel. It is DEFAULT-DENY (no egress.json ⇒
 * refuse), bounds concurrent tunnels, logs CONTENT-FREE request rows to a
 * local NDJSON audit stream, and DOES NOT inspect or intercept TLS.
 *
 * HONESTY / ADVISORY BANNER (also exported + emitted on start):
 *   A proxy enforces nothing by itself. It is advisory UNLESS the OS forces
 *   traffic through it (netns route / firewall). Merely setting HTTP_PROXY on
 *   a child does not prove confinement; `doctor` egress.shell stays honest.
 *   The OS-level backend and the real-container default-deny proof are EXTERNAL.
 * ========================================================================== */

/** The advisory banner is part of the public surface so callers can print it. */
export const EGRESS_PROXY_ADVISORY_BANNER =
  "egress connect proxy is ADVISORY: it enforces nothing unless the OS forces traffic through it " +
  "(netns route / firewall). No TLS interception; default deny when no egress policy is present.";

export const EGRESS_PROXY_DEFAULT_BIND_HOST = "127.0.0.1";
export const EGRESS_PROXY_DEFAULT_MAX_CONNECTIONS = 32;
export const EGRESS_PROXY_MAX_CONNECTIONS_CAP = 256;

export type BoundedEgressAuditEvent = "banner" | "connect.request";

/** Content-free audit row: no path, headers, body, SNI or payload. */
export type BoundedEgressAuditRow = {
  v: 1;
  ts: string;
  event: BoundedEgressAuditEvent;
  /** `host:port` only — never a URL path/query. */
  authority?: string;
  decision?: EgressDecision["kind"] | "unparseable";
  status: number;
};

export interface BoundedEgressConnectProxy {
  url: string;
  port: number;
  host: string;
  banner: string;
  /** Recent content-free CONNECT decisions (also persisted to the audit file). */
  records: EgressConnectRecord[];
  auditFile?: string;
  activeConnections(): number;
  /** Destroys live tunnels and resolves when the listener has closed. */
  stop(): Promise<void>;
}

export interface StartBoundedEgressConnectProxyOptions {
  /** Ephemeral port (0) by default. */
  port?: number;
  /** Explicit bind opt-in. When absent, `HZ_EGRESS_PROXY_BIND` opts in. */
  bind?: string;
  /** Directory holding `egress.json` (fail closed when absent/malformed). */
  stateDir?: string;
  /** In-memory policy for hermetic tests (overrides stateDir). */
  policy?: EgressPolicyDoc | EgressOriginRule[];
  env?: Record<string, string | undefined>;
  /** Bounded concurrent tunnels (default 32, capped at 256). */
  maxConnections?: number;
  /** Explicit audit NDJSON path; default `<stateDir>/egress-proxy.ndjson`. */
  auditFile?: string;
  /** Test sink for audit rows. */
  onRecord?: (row: BoundedEgressAuditRow) => void;
  /** Emit the advisory banner to stderr on start (default true). */
  notice?: boolean;
  /**
   * ADDITIVE advisory dial pin: when supplied, the CONNECT target is resolved
   * and the dial is re-checked against the pinned answer set immediately
   * before connecting. Absent = byte-identical existing behavior. This is not
   * OS enforcement; shell-net egress is never claimed `enforced`.
   */
  resolve?: (host: string) => Promise<readonly string[]>;
  /**
   * ADDITIVE advisory SSRF guard: when `resolve` is supplied AND this is true,
   * resolved non-public IPs (loopback/private/link-local/metadata) are refused
   * before the dial. Default false = byte-identical existing behavior. Advisory
   * only; shell-net egress is never claimed `enforced`.
   */
  refuseNonPublic?: boolean;
  /**
   * ADDITIVE opt-in MITM credential injection: when TLS terminate + upstream
   * pipe is active, scoped credential headers are injected into the decrypted
   * request before forwarding. Default absent = byte-identical. Advisory only;
   * never shell-net `enforced`.
   */
  credentialInjection?: TlsCredentialInjection;
}

/** `HZ_EGRESS_PROXY_BIND`: absent/0 = not opted in; 1/true = loopback default. */
export function resolveEgressProxyBind(env: Record<string, string | undefined>): { enabled: boolean; host: string } {
  const raw = (env.HZ_EGRESS_PROXY_BIND ?? "").trim();
  if (raw === "") return { enabled: false, host: EGRESS_PROXY_DEFAULT_BIND_HOST };
  const key = raw.toLowerCase();
  if (key === "0" || key === "false" || key === "off" || key === "no") {
    return { enabled: false, host: EGRESS_PROXY_DEFAULT_BIND_HOST };
  }
  if (key === "1" || key === "true" || key === "yes" || key === "on") {
    return { enabled: true, host: EGRESS_PROXY_DEFAULT_BIND_HOST };
  }
  // Any other non-empty value is an explicit bind address (still opt-in).
  return { enabled: true, host: raw };
}

function boundedPolicy(opts: StartBoundedEgressConnectProxyOptions) {
  if (opts.policy !== undefined) return parseEgressPolicyDoc(opts.policy);
  if (opts.stateDir !== undefined) return loadEgressPolicy(opts.stateDir);
  return undefined;
}

/**
 * Start the bounded CONNECT proxy. FAILS CLOSED when neither `bind` nor
 * `HZ_EGRESS_PROXY_BIND` opts in — a proxy that silently listens would be a
 * false claim of egress control.
 */
export function startBoundedEgressConnectProxy(
  opts: StartBoundedEgressConnectProxyOptions = {},
): Promise<BoundedEgressConnectProxy> {
  const env = opts.env ?? process.env;
  const bind = opts.bind !== undefined ? { enabled: true, host: opts.bind.trim() } : resolveEgressProxyBind(env);
  if (!bind.enabled || bind.host === "") {
    return Promise.reject(new Error("egress connect proxy: set HZ_EGRESS_PROXY_BIND=1 (or pass bind) to opt in"));
  }
  const maxConnectionsRaw = opts.maxConnections ?? EGRESS_PROXY_DEFAULT_MAX_CONNECTIONS;
  if (!Number.isInteger(maxConnectionsRaw) || maxConnectionsRaw < 1 || maxConnectionsRaw > EGRESS_PROXY_MAX_CONNECTIONS_CAP) {
    return Promise.reject(new Error(`egress connect proxy: maxConnections must be an integer in [1, ${EGRESS_PROXY_MAX_CONNECTIONS_CAP}]`));
  }
  const maxConnections = maxConnectionsRaw;
  const port = opts.port ?? 0;
  const policy = boundedPolicy(opts);
  const auditFile = opts.auditFile ?? (opts.stateDir !== undefined ? path.join(opts.stateDir, "egress-proxy.ndjson") : undefined);
  const records: EgressConnectRecord[] = [];
  const liveClients = new Set<net.Socket>();
  const liveUpstreams = new Set<net.Socket>();

  const audit = (row: BoundedEgressAuditRow): void => {
    if (row.event === "connect.request") {
      records.push({
        authority: row.authority ?? "",
        decision: row.decision === "unparseable" ? "deny" : (row.decision ?? "deny"),
        status: row.status,
      });
    }
    opts.onRecord?.(row);
    if (auditFile === undefined) return;
    try {
      mkdirSync(path.dirname(auditFile), { recursive: true, mode: 0o700 });
      appendJsonlSync(auditFile, `${JSON.stringify(row)}\n`);
    } catch {
      // Auditing is best-effort and never fabricates an allow/deny decision.
    }
  };
  const request = (authority: string, decision: BoundedEgressAuditRow["decision"], status: number): void => {
    audit({ v: 1, ts: nowIso(), event: "connect.request", authority, decision, status });
  };

  /** Raw TCP pipe. No SNI peek, no TLS termination — bytes are opaque. */
  const pipeTunnel = (client: net.Socket, host: string, targetPort: number, head: Buffer, release: () => void): void => {
    const upstream = net.connect({ host, port: targetPort });
    liveUpstreams.add(upstream);
    let established = false;
    let done = false;
    const finish = (): void => {
      if (done) return;
      done = true;
      liveUpstreams.delete(upstream);
      liveClients.delete(client);
      try { client.destroy(); } catch { /* already closed */ }
      try { upstream.destroy(); } catch { /* already closed */ }
      release();
    };
    upstream.setTimeout(30_000, finish); // idle tunnel bound; no data inspection
    upstream.once("error", () => {
      if (!established) {
        try { writeHttpResponse(client, 502, "CONNECT upstream failed\n"); } catch { /* gone */ }
      }
      finish();
    });
    client.once("close", finish);
    client.once("error", finish);
    upstream.once("connect", () => {
      established = true;
      if (head.length > 0) upstream.write(head);
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      client.on("data", (chunk: Buffer) => { if (!upstream.destroyed) upstream.write(chunk); });
      upstream.on("data", (chunk: Buffer) => { if (!client.destroyed) client.write(chunk); });
      client.on("end", finish);
      upstream.on("end", finish);
    });
  };

  return new Promise((resolve, reject) => {
    const server = http.createServer((_req, res) => {
      res.writeHead(501, { "Content-Type": "text/plain" });
      res.end("egress connect proxy: CONNECT only\n");
    });
    // Bound the pipelined CONNECT head explicitly (node versions differ on a
    // writable `maxHeaderSize` property) — oversized heads are refused.
    const MAX_CONNECT_HEAD = 16 * 1024;
    let active = 0;
    const release = (): void => {
      active = Math.max(0, active - 1);
    };

    server.on("connect", async (req, clientSocket, head) => {
      const client = clientSocket as net.Socket;
      liveClients.add(client);
      active += 1;
      const authority = (req.url ?? "").trim();
      if (head.length > MAX_CONNECT_HEAD) {
        request(authority, "unparseable", 431);
        writeHttpResponse(client, 431, "CONNECT head too large\n");
        release();
        liveClients.delete(client);
        return;
      }
      if (active > maxConnections) {
        request(authority, "deny", 503);
        writeHttpResponse(client, 503, "egress connect proxy: connection limit reached\n");
        release();
        liveClients.delete(client);
        return;
      }
      if (authority === "" || /\s/.test(authority)) {
        request(authority, "unparseable", 400);
        writeHttpResponse(client, 400, "CONNECT missing/invalid authority\n");
        release();
        liveClients.delete(client);
        return;
      }
      // No policy file ⇒ NO admission. (Kernel net.fetch absent-policy stays
      // `ask`; a proxy that cannot see a policy must never tunnel.)
      if (policy === undefined) {
        request(authority, "deny", 503);
        writeHttpResponse(client, 503, "egress policy not loaded — CONNECT denied (fail closed)\n");
        release();
        liveClients.delete(client);
        return;
      }
      const decision = decideConnectAuthority(policy, authority);
      if (decision === "unparseable") {
        request(authority, "unparseable", 403);
        writeHttpResponse(client, 403, "CONNECT authority not allowed (unparseable)\n");
        release();
        liveClients.delete(client);
        return;
      }
      if (!connectAdmits(decision)) {
        request(authority, decision.kind, 403);
        writeHttpResponse(client, 403, `CONNECT denied (${decision.kind})\n`);
        release();
        liveClients.delete(client);
        return;
      }
      const target = parseConnectAuthority(authority);
      if (!target) {
        request(authority, "unparseable", 403);
        writeHttpResponse(client, 403, "CONNECT authority not allowed (unparseable)\n");
        release();
        liveClients.delete(client);
        return;
      }
      request(authority, decision.kind, 200);
      if (opts.resolve !== undefined) {
        try {
          const pin = await resolveAndPin(target.host, target.port, {
            resolve: opts.resolve,
            now: () => Date.now(),
            refuseNonPublic: opts.refuseNonPublic ?? true,
          });
          const chosen = pin.addresses[0]!;
          assertDialAddressStillPinned(pin, chosen);
          pipeTunnel(client, chosen, target.port, head, release);
        } catch {
          writeHttpResponse(client, 502, "CONNECT dial pin refused\n");
          release();
          liveClients.delete(client);
        }
        return;
      }
      pipeTunnel(client, target.host, target.port, head, release);
    });

    server.on("error", (err) => reject(err));
    server.listen(port, bind.host, () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") {
        server.close();
        reject(new Error("egress connect proxy: no listen port"));
        return;
      }
      if (opts.notice !== false) {
        try { process.stderr.write(`${EGRESS_PROXY_ADVISORY_BANNER}\n`); } catch { /* non-blocking */ }
      }
      audit({ v: 1, ts: nowIso(), event: "banner", status: 0 });
      let stopping = false;
      resolve({
        url: `http://${bind.host}:${addr.port}`,
        port: addr.port,
        host: bind.host,
        banner: EGRESS_PROXY_ADVISORY_BANNER,
        records,
        ...(auditFile !== undefined ? { auditFile } : {}),
        activeConnections: () => active,
        stop: () =>
          new Promise<void>((stopResolve, stopReject) => {
            if (stopping) { stopResolve(); return; }
            stopping = true;
            for (const socket of liveClients) { try { socket.destroy(); } catch { /* gone */ } }
            for (const socket of liveUpstreams) { try { socket.destroy(); } catch { /* gone */ } }
            server.close((err) => (err ? stopReject(err) : stopResolve()));
          }),
      });
    });
  });
}
