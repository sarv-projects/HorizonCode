/**
 * Hermetic TLS terminate on CONNECT (rulings **283**, **285**).
 *
 * Opt-in `HZ_EGRESS_TLS_TERMINATE=1` with intercept CA + `HZ_EGRESS_TLS_INTERCEPT=1`
 * and `HZ_EGRESS_FORWARD=1`: after CONNECT 200, terminate client TLS with a CA-signed
 * leaf, optionally TLS re-connect to upstream and pipe bytes both ways.
 * Advisory only — never shell-net enforced.
 */

import { readFileSync } from "node:fs";
import tls from "node:tls";
import type net from "node:net";
import {
  egressTlsInterceptCaKeyPath,
  egressTlsInterceptCaLoadable,
  egressTlsTerminateEnabled,
  mintHermeticLeafCert,
} from "./egress-tls-intercept-ca";
import { egressTlsInterceptEnabled } from "./egress-tls-intercept";

const REQUEST_ACCUM_MAX = 16 * 1024;

function egressForwardEnabled(env: Record<string, string | undefined>): boolean {
  const raw = env.HZ_EGRESS_FORWARD;
  if (raw === "1") return true;
  if (typeof raw === "string" && raw.trim().toLowerCase() === "true") return true;
  return false;
}

export function egressTlsTerminateAttempt(env: Record<string, string | undefined> = process.env): boolean {
  if (!egressTlsInterceptEnabled(env)) return false;
  if (!egressTlsTerminateEnabled(env)) return false;
  return egressTlsInterceptCaLoadable(env.HZ_EGRESS_TLS_INTERCEPT_CA);
}

/** True when terminate is armed and CONNECT forward is on (upstream pipe eligible). */
export function egressTlsTerminateUpstreamPipeEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return egressTlsTerminateAttempt(env) && egressForwardEnabled(env);
}

export type TlsTerminateObservation = {
  servername: string;
  firstHttpLine: string | undefined;
  upstreamPiped?: boolean;
};

export type TlsTerminateUpstreamTarget = {
  host: string;
  port: number;
};

function hostFromConnectAuthority(authority: string): string {
  const trimmed = authority.trim();
  const colon = trimmed.lastIndexOf(":");
  if (colon < 0) return trimmed;
  return trimmed.slice(0, colon);
}

function parseFirstHttpLine(buf: Buffer): string | undefined {
  const text = buf.toString("latin1");
  const lineEnd = text.indexOf("\r\n");
  if (lineEnd < 0) return undefined;
  const line = text.slice(0, lineEnd).trim();
  return line === "" ? undefined : line;
}

function upstreamTlsOptions(
  target: TlsTerminateUpstreamTarget,
  servername: string,
  env: Record<string, string | undefined>,
): tls.ConnectionOptions {
  const caPath = env.HZ_EGRESS_TLS_UPSTREAM_CA?.trim();
  const base: tls.ConnectionOptions = {
    host: target.host,
    port: target.port,
    servername: servername || target.host,
  };
  if (caPath) {
    try {
      base.ca = readFileSync(caPath, "utf8");
      base.rejectUnauthorized = true;
    } catch {
      base.rejectUnauthorized = false;
    }
  }
  return base;
}

function pipeBidirectional(a: tls.TLSSocket, b: tls.TLSSocket): void {
  const destroyBoth = () => {
    if (!a.destroyed) a.destroy();
    if (!b.destroyed) b.destroy();
  };
  a.pipe(b);
  b.pipe(a);
  a.on("error", destroyBoth);
  b.on("error", destroyBoth);
  a.on("end", () => {
    if (!b.destroyed) b.end();
  });
  b.on("end", () => {
    if (!a.destroyed) a.end();
  });
}

function startUpstreamPipe(
  clientTls: tls.TLSSocket,
  pending: Buffer,
  target: TlsTerminateUpstreamTarget,
  servername: string,
  env: Record<string, string | undefined>,
  onObserved: (obs: TlsTerminateObservation) => void,
  firstHttpLine: string | undefined,
): void {
  const upstreamPlain = tls.connect(upstreamTlsOptions(target, servername, env), () => {
    onObserved({ servername, firstHttpLine, upstreamPiped: true });
    if (pending.length > 0) {
      upstreamPlain.write(pending);
    }
    pipeBidirectional(clientTls, upstreamPlain);
  });
  upstreamPlain.on("error", () => {
    clientTls.destroy();
  });
}

/**
 * Respond CONNECT 200, terminate TLS with a CA-minted leaf, observe first HTTP line,
 * and when `upstream` is set pipe decrypted bytes to a TLS upstream.
 */
export function terminateTlsOnConnectSocket(
  socket: net.Socket,
  authority: string,
  initialBytes: Buffer,
  env: Record<string, string | undefined>,
  onObserved: (obs: TlsTerminateObservation) => void,
  upstream?: TlsTerminateUpstreamTarget,
): void {
  const caCertPath = env.HZ_EGRESS_TLS_INTERCEPT_CA?.trim();
  const caKeyPath = egressTlsInterceptCaKeyPath(env);
  if (!caCertPath || !caKeyPath) {
    socket.destroy();
    return;
  }
  const servername = hostFromConnectAuthority(authority);
  const leaf = mintHermeticLeafCert(caCertPath, caKeyPath, servername || "localhost");
  const secureContext = tls.createSecureContext({ cert: leaf.certPem, key: leaf.keyPem });

  socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");

  const tlsSocket = new tls.TLSSocket(socket, {
    isServer: true,
    secureContext,
    requestCert: false,
  });

  let buf = Buffer.from(initialBytes);
  let observed = false;
  let upstreamStarted = false;

  const observeOnce = (line: string | undefined, upstreamPiped?: boolean) => {
    if (observed) return;
    observed = true;
    onObserved({ servername, firstHttpLine: line, upstreamPiped });
  };

  const maybeStartUpstream = (line: string | undefined) => {
    if (!upstream || upstreamStarted) return;
    if (!egressTlsTerminateUpstreamPipeEnabled(env)) return;
    upstreamStarted = true;
    tlsSocket.off("data", onData);
    startUpstreamPipe(tlsSocket, buf, upstream, servername, env, onObserved, line);
  };

  const finishEcho = (firstHttpLine: string | undefined) => {
    observeOnce(firstHttpLine, false);
    const echo = firstHttpLine
      ? `HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nConnection: close\r\nContent-Length: ${Buffer.byteLength(firstHttpLine, "utf8")}\r\n\r\n${firstHttpLine}`
      : "HTTP/1.1 204 No Content\r\nConnection: close\r\n\r\n";
    tlsSocket.write(echo, () => {
      tlsSocket.end();
    });
  };

  const maybeDone = () => {
    const line = parseFirstHttpLine(buf);
    if (upstream && egressTlsTerminateUpstreamPipeEnabled(env)) {
      if (line !== undefined) {
        maybeStartUpstream(line);
      }
      return;
    }
    if (line !== undefined || buf.length >= REQUEST_ACCUM_MAX) {
      tlsSocket.off("data", onData);
      finishEcho(line);
    }
  };

  const onData = (chunk: Buffer) => {
    if (buf.length < REQUEST_ACCUM_MAX) {
      buf = Buffer.concat([buf, chunk]);
    }
    maybeDone();
  };

  tlsSocket.once("secure", () => {
    maybeDone();
  });
  tlsSocket.on("data", onData);
  tlsSocket.on("error", () => {
    tlsSocket.destroy();
  });
}
