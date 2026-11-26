/**
 * http-credential-inject.ts — MITM broker HTTP-level credential injection
 * into the DECRYPTED request (codex/grok "must steal" MITM piece).
 *
 * Pure: given an HTTP/1.1 request as text, a target host, a CredentialBroker and
 * a set of scoped rules, inject credential headers into the header block only
 * (before the blank line), leaving the body byte-identical. A rule applies only
 * when its host matches (case-insensitive); an existing header of the same name
 * is never duplicated. Unknown secret ids fail closed, and the secret value is
 * never logged.
 *
 * The caller decides whether/when to call this (e.g. only on an opt-in,
 * loopback-scoped TLS-terminating proxy). This is advisory credentials only —
 * it does not terminate TLS, bind sockets or enforce egress; never shell-net
 * `enforced`.
 */

import type { CredentialBroker } from "./egress-credential-broker";

export interface CredentialHeaderRule {
  /** Exact host the rule applies to (case-insensitive). */
  host: string;
  /** Header name to inject. */
  header: string;
  /** Broker secret id holding the value. */
  secretId: string;
}

const MAX_HEADER_BYTES = 64 * 1024;
/** RFC 7230 §3.2.6 token characters for HTTP header field-name. */
const RFC7230_HEADER_NAME_RE = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

/** Inject scoped credential headers into the request header block. */
export function injectCredentialHeaders(
  request: string,
  host: string,
  broker: CredentialBroker,
  rules: readonly CredentialHeaderRule[],
): string {
  const terminator = request.indexOf("\r\n\r\n");
  if (terminator < 0) throw new Error("HZ_PRECONDITION_FAILED: HTTP request missing header terminator");
  const head = request.slice(0, terminator);
  const rest = request.slice(terminator); // includes \r\n\r\n + body, kept byte-identical
  if (Buffer.byteLength(head, "utf8") > MAX_HEADER_BYTES) {
    throw new Error("HZ_PRECONDITION_FAILED: HTTP header block too large");
  }
  const applicable = rules.filter((r) => r.host.trim().toLowerCase() === host.trim().toLowerCase());
  if (applicable.length === 0) return request;

  const lines = head.split("\r\n");
  const existing = new Set(lines.map((l) => {
    const colon = l.indexOf(":");
    return colon < 0 ? "" : l.slice(0, colon).trim().toLowerCase();
  }));
  const additions: string[] = [];
  for (const rule of applicable) {
    const name = rule.header.trim();
    if (name === "" || !RFC7230_HEADER_NAME_RE.test(name)) {
      throw new Error(`HZ_PRECONDITION_FAILED: invalid RFC 7230 credential header name: ${JSON.stringify(rule.header)}`);
    }
    if (existing.has(name.toLowerCase())) continue; // never duplicate
    const { value } = broker.headerFor(rule.secretId); // unknown id -> typed throw
    if (/[\r\n\0]/.test(value)) {
      throw new Error(`HZ_PRECONDITION_FAILED: credential header value for ${name} contains CR/LF/NUL`);
    }
    additions.push(`${name}: ${value}`);
  }
  if (additions.length === 0) return request;
  return [...lines, ...additions].join("\r\n") + rest;
}
