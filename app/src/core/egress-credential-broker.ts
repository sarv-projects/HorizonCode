/**
 * egress-credential-broker.ts — MITM credential broker + body secret
 * substitution. ADAPT of codex `network-proxy` BodySecretSubstitutionConfig /
 * grok `xai-grok-egress-proxy` credential broker (the "must steal" MITM piece).
 *
 * Credentials are held ONLY in the broker object. A forwarded body may carry
 * `${SECRET:<id>}` placeholders that are substituted at forward time; a log
 * string can be redacted of every known secret. `childEnv()` is ALWAYS empty —
 * no credential is ever exported into a sandboxed child's environment. Pure,
 * no I/O, no network. Advisory: does not itself terminate TLS or enforce egress.
 */

export interface BrokerCredential {
  id: string;
  /** Header name the credential belongs to (data, not a decision). */
  header: string;
  /** The secret value — held only in the broker. */
  value: string;
}

const PLACEHOLDER = /\$\{SECRET:([^}]+)\}/g;

function validate(creds: readonly BrokerCredential[]): void {
  for (const c of creds) {
    if (c.id.trim() === "") throw new Error("HZ_PRECONDITION_FAILED: credential id is empty");
    if (c.value.trim() === "") throw new Error("HZ_PRECONDITION_FAILED: credential value is empty/blank");
  }
  const ids = new Set(creds.map((c) => c.id));
  if (ids.size !== creds.length) throw new Error("HZ_PRECONDITION_FAILED: duplicate credential id");
}

/** Substitute `${SECRET:id}` placeholders in a body. Unknown ids fail closed. */
export function substituteSecrets(body: string, creds: readonly BrokerCredential[]): string {
  validate(creds);
  const byId = new Map(creds.map((c) => [c.id, c.value]));
  return body.replace(PLACEHOLDER, (_match, id: string) => {
    const value = byId.get(id);
    if (value === undefined) throw new Error(`HZ_PRECONDITION_FAILED: unknown secret id ${id}`);
    return value;
  });
}

/** Redact every known secret from a string (for notices/logs). */
export function redactSecrets(text: string, creds: readonly BrokerCredential[]): string {
  let out = text;
  for (const c of creds) {
    if (c.value === "") continue;
    out = out.split(c.value).join("[REDACTED]");
  }
  return out;
}

/** Holds credentials and issues scoped headers; never exports to a child env. */
export class CredentialBroker {
  private readonly creds: Map<string, BrokerCredential>;

  constructor(creds: readonly BrokerCredential[]) {
    validate(creds);
    this.creds = new Map(creds.map((c) => [c.id, c]));
  }

  headerFor(id: string): { name: string; value: string } {
    const c = this.creds.get(id);
    if (c === undefined) throw new Error(`HZ_PRECONDITION_FAILED: unknown secret id ${id}`);
    return { name: c.header, value: c.value };
  }

  substitute(body: string): string {
    return substituteSecrets(body, [...this.creds.values()]);
  }

  /** ALWAYS empty: a broker never exports credentials into a child env. */
  childEnv(): Record<string, string> {
    return {};
  }
}
