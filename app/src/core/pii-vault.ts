/**
 * pii-vault.ts — Reversible session-scoped PII & high-confidence secret tokenizer vault.
 *
 * Zero runtime dependencies (pure TypeScript).
 *
 * Replaces sensitive PII and high-confidence bearer/API keys in untrusted or
 * model-bound text with deterministic per-session placeholders:
 *   - Emails            -> [EMAIL_1], [EMAIL_2], ...
 *   - Phone numbers     -> [PHONE_1], [PHONE_2], ...
 *   - SSNs              -> [SSN_1], [SSN_2], ...
 *   - Payment cards     -> [CARD_1], [CARD_2], ... (13-19 digits, Luhn-verified)
 *   - High-conf secrets -> [SECRET_1], [SECRET_2], ... (sk-, ghp_, xoxb-, AKIA...)
 *
 * Detokenization is strictly fail-closed: tokens are only restored when the
 * caller supplies a `destination` that matches `opts.allowlist`.
 */

export type PiiCategory = "EMAIL" | "PHONE" | "SSN" | "CARD" | "SECRET";

export interface PiiDetokenizeOptions {
  destination: string;
  allowlist?: readonly string[];
}

export interface PiiVaultStats {
  active: boolean;
  tokenCount: number;
}

/** Max number of session vaults kept in the bounded LRU registry. */
export const PII_VAULT_MAX_SESSIONS = 128;

/** Env var that disables PII vault tokenization only when explicitly set to "0". */
export const PII_VAULT_ENV = "HZ_PII_VAULT";

/** Env var listing allowlisted destinations (comma/whitespace separated) for MCP detokenization. */
export const MCP_PII_DETOKENIZE_ALLOW_ENV = "HZ_MCP_PII_DETOKENIZE_ALLOW";

const TOKEN_PLACEHOLDER_RE = /\[(?:EMAIL|PHONE|SSN|CARD|SECRET)_\d+\]/g;

// High-confidence bearer/API keys & PEM private keys:
// OpenAI/Anthropic sk-*, GitHub ghp_/gho_/ghu_/ghs_/ghr_/github_pat_*, Slack xox[baprs]-*, AWS AKIA*, Google AIza*, PEM private keys
const SECRET_RE =
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----(?:[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----)?|(?<![A-Za-z0-9_-])(?:sk-(?:proj-|ant-api\d+-|live-|test-)?[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9_]{16,}|github_pat_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{35})(?![A-Za-z0-9_-])/g;

// Standard email addresses (linear-time label grammar — zero quadratic backtracking)
const EMAIL_RE =
  /\b[A-Za-z0-9_%+-]+(?:\.[A-Za-z0-9_%+-]+)*@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}\b/g;

// US SSNs: XXX-XX-XXXX (not embedded in larger alphanumeric/hyphenated IDs)
const SSN_RE = /(?<![A-Za-z0-9-])\d{3}-\d{2}-\d{4}(?![A-Za-z0-9-])/g;

// Candidate payment card sequences (13-19 digits with optional single spaces or dashes)
const CARD_CANDIDATE_RE = /(?<![A-Za-z0-9])(?:\d[ -]?){12,18}\d(?![A-Za-z0-9])/g;

// Phone numbers:
//  1. International E.164 unseparated (+14155552671, 10-15 digits)
//  2. Formatted international numbers (+91 98765 43210, +44 20 7946 0958, +1-415-555-2671)
//  3. Formatted US/local numbers with separators or area-code parens (10-15 digits; excludes YYYY-MM-DDDD dates)
const PHONE_RE =
  /(?<![A-Za-z0-9+])(?:\+[1-9]\d{9,14}|\+\d{1,3}[\s.-](?:\(\d{1,5}\)[\s.-]?|\d{2,5}[\s.-]?){1,4}\d{2,5}|(?:\(\d{2,4}\)[\s.-]?|\d{3}[\s.-])\d{3,5}[\s.-]\d{3,5}(?:[\s.-]\d{1,4})?)(?![A-Za-z0-9])/g;

const IPV4_RE = /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/;
const DATE_LIKE_RE = /^(?:19|20)\d{2}[-./](?:0[1-9]|1[0-2])[-./]\d{2,4}$/;
const ALL_SAME_DIGIT_RE = /^(\d)\1+$/;

/** Standard Luhn checksum validation for 13-19 digit payment card numbers. */
export function passesLuhn(digits: string): boolean {
  if (digits.length < 13 || digits.length > 19 || !/^\d+$/.test(digits)) return false;
  if (ALL_SAME_DIGIT_RE.test(digits)) return false;
  let sum = 0;
  let shouldDouble = false;
  for (let i = digits.length - 1; i >= 0; i -= 1) {
    let digit = digits.charCodeAt(i) - 48;
    if (shouldDouble) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
    shouldDouble = !shouldDouble;
  }
  return sum % 10 === 0;
}

/** True unless HZ_PII_VAULT is explicitly set to "0". */
export function isPiiVaultEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env[PII_VAULT_ENV] !== "0";
}

/** Parse comma- or whitespace-separated destination allowlist entries. */
export function parsePiiDetokenizeAllowlist(raw: string | undefined): string[] {
  if (typeof raw !== "string" || raw.trim() === "") return [];
  return raw
    .split(/[,\s]+/)
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "");
}

/**
 * Fail-closed destination check against an allowlist.
 * Supports:
 *   - exact match ("crm:create_contact")
 *   - wildcard ("*" or "crm:*")
 *   - server prefix match for colon-delimited targets ("crm" matches "crm:create_contact")
 */
export function isPiiDestinationAllowed(
  destination: string | undefined,
  allowlist: readonly string[] | undefined,
): boolean {
  if (typeof destination !== "string" || destination.trim() === "") return false;
  if (!Array.isArray(allowlist) || allowlist.length === 0) return false;
  const dest = destination.trim();
  for (const rawEntry of allowlist) {
    if (typeof rawEntry !== "string") continue;
    const entry = rawEntry.trim();
    if (entry === "") continue;
    if (entry === "*" || entry === dest) return true;
    if (entry.endsWith("*") && dest.startsWith(entry.slice(0, -1))) return true;
    if (!entry.includes(":") && dest.startsWith(`${entry}:`)) return true;
  }
  return false;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object") return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

export class PiiVault {
  private readonly valueToToken = new Map<string, string>();
  private readonly tokenToValue = new Map<string, string>();
  private readonly counters: Record<PiiCategory, number> = {
    EMAIL: 0,
    PHONE: 0,
    SSN: 0,
    CARD: 0,
    SECRET: 0,
  };

  private intern(category: PiiCategory, raw: string): string {
    const existing = this.valueToToken.get(raw);
    if (existing !== undefined) return existing;
    this.counters[category] += 1;
    const token = `[${category}_${this.counters[category]}]`;
    this.valueToToken.set(raw, token);
    this.tokenToValue.set(token, raw);
    return token;
  }

  /** Replace detected PII and high-confidence secrets with reversible session tokens. */
  tokenizeText(text: string): string {
    if (typeof text !== "string" || text === "") return text;
    let out = text;

    // 1. High-confidence bearer/API keys first so embedded digits aren't split.
    out = out.replace(SECRET_RE, (match) => this.intern("SECRET", match));

    // 2. Emails.
    out = out.replace(EMAIL_RE, (match) => this.intern("EMAIL", match));

    // 3. SSNs (XXX-XX-XXXX).
    out = out.replace(SSN_RE, (match) => this.intern("SSN", match));

    // 4. Payment cards (13-19 digits with Luhn check).
    out = out.replace(CARD_CANDIDATE_RE, (match) => {
      const digits = match.replace(/[ -]/g, "");
      if (!passesLuhn(digits)) return match;
      return this.intern("CARD", match);
    });

    // 5. Phone numbers (international / US / 10-15 digits, excluding IPv4 and YYYY-MM-DDDD dates).
    out = out.replace(PHONE_RE, (match) => {
      if (IPV4_RE.test(match) || DATE_LIKE_RE.test(match)) return match;
      const digits = match.replace(/\D/g, "");
      if (digits.length < 10 || digits.length > 15) return match;
      return this.intern("PHONE", match);
    });

    return out;
  }

  /** Recursively tokenize string values and object keys inside arrays and plain objects. */
  tokenizeValue<T>(value: T): T {
    return this.transformValue(value, (s) => this.tokenizeText(s), new Set<object>());
  }

  /**
   * Restore vaulted tokens in `text` ONLY when `opts.destination` matches `opts.allowlist`.
   * Fails closed (preserves tokens) whenever destination is missing or not allowlisted.
   */
  detokenizeText(text: string, opts: PiiDetokenizeOptions): string {
    if (typeof text !== "string" || text === "" || this.tokenToValue.size === 0) return text;
    if (!isPiiDestinationAllowed(opts?.destination, opts?.allowlist)) return text;
    return text.replace(TOKEN_PLACEHOLDER_RE, (token) => this.tokenToValue.get(token) ?? token);
  }

  /**
   * Recursively detokenize string values and object keys inside arrays and plain objects.
   * Fails closed (returns value unchanged) when `opts.destination` is not allowlisted.
   */
  detokenizeValue<T>(value: T, opts: PiiDetokenizeOptions): T {
    if (this.tokenToValue.size === 0 || !isPiiDestinationAllowed(opts?.destination, opts?.allowlist)) {
      return value;
    }
    return this.transformValue(
      value,
      (s) => s.replace(TOKEN_PLACEHOLDER_RE, (token) => this.tokenToValue.get(token) ?? token),
      new Set<object>(),
    );
  }

  stats(): PiiVaultStats {
    return {
      active: this.tokenToValue.size > 0,
      tokenCount: this.tokenToValue.size,
    };
  }

  clear(): void {
    this.valueToToken.clear();
    this.tokenToValue.clear();
    this.counters.EMAIL = 0;
    this.counters.PHONE = 0;
    this.counters.SSN = 0;
    this.counters.CARD = 0;
    this.counters.SECRET = 0;
  }

  private transformValue<T>(value: T, fn: (s: string) => string, active: Set<object>): T {
    if (typeof value === "string") return fn(value) as T;
    if (value === null || typeof value !== "object") return value;
    if (active.has(value as object)) return value;

    active.add(value as object);
    try {
      if (Array.isArray(value)) {
        return value.map((item) => this.transformValue(item, fn, active)) as T;
      }
      if (isPlainObject(value)) {
        const out: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(value)) {
          out[fn(k)] = this.transformValue(v, fn, active);
        }
        return out as T;
      }
      return value;
    } finally {
      active.delete(value as object);
    }
  }
}

/* --------------------- Bounded Session LRU Registry --------------------- */

const sessionVaults = new Map<string, PiiVault>();

/** Return (or create) the session-scoped PiiVault, maintaining a bounded 128-session LRU. */
export function getSessionPiiVault(sessionId: string): PiiVault {
  const key = typeof sessionId === "string" && sessionId !== "" ? sessionId : "default";
  const existing = sessionVaults.get(key);
  if (existing !== undefined) {
    // Refresh recency in Map iteration order.
    sessionVaults.delete(key);
    sessionVaults.set(key, existing);
    return existing;
  }
  while (sessionVaults.size >= PII_VAULT_MAX_SESSIONS) {
    const oldestKey = sessionVaults.keys().next().value;
    if (oldestKey === undefined) break;
    const evicted = sessionVaults.get(oldestKey);
    evicted?.clear();
    sessionVaults.delete(oldestKey);
  }
  const created = new PiiVault();
  sessionVaults.set(key, created);
  return created;
}

/** Clear and remove one session's PiiVault from the registry. */
export function clearSessionPiiVault(sessionId: string): void {
  const key = typeof sessionId === "string" && sessionId !== "" ? sessionId : "default";
  const existing = sessionVaults.get(key);
  if (existing !== undefined) {
    existing.clear();
    sessionVaults.delete(key);
  }
}
