/**
 * Loopback CONNECT proxy wired to egress-decider (docs/33 §5.2 stage 1 reduced).
 *
 * Advisory only: setting HTTP_PROXY on shell children does not prove MITM;
 * netns-only-route denial and TLS intercept remain open.
 */

import net from "node:net";
import type { EgressPolicyDoc, EgressOriginRule } from "../contracts";
import {
  connectAdmits,
  decideConnectAuthority,
  loadEgressPolicy,
  parseEgressPolicyDoc,
  type EgressDecision,
} from "./egress-decider";
import { EGRESS_TLS_INTERCEPT_REFUSE_BODY, egressTlsInterceptRefuseForward } from "./egress-tls-intercept-ca";
import { egressTlsPeekEnabled, parseTlsClientHelloSni } from "./egress-tls-peek";
import { egressTlsTerminateAttempt, terminateTlsOnConnectSocket } from "./egress-tls-terminate";

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
      handleConnectClient(socket, policy, forward, tlsPeek, records, sniPeeks, terminateObservations, env);
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
