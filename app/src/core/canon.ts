/**
 * canon.ts — canonical JSON and hashing, with the number rules enforced.
 *
 * The encoding rules live in ../contracts.ts (frozen v0.1) and in docs/05
 * rules D3/D40; this module exposes them with one addition: every value is
 * walked *before* serialization, and a number that has no canonical JSON form
 * — NaN, ±Infinity, or an integer at or beyond ±2^53 whose serialized form is
 * a decimal numeral — raises `CanonicalNumberError` naming the value's path.
 * JSON.stringify would instead rewrite NaN/±Infinity as `null` and print the
 * out-of-range integer as if the double carried its digits.
 */

import {
  canonicalJson as encodeCanonicalJson,
  sha256Hex,
  type EventEnvelope,
  type Receipt,
} from "../contracts";

export { sha256Hex };

/** The number kinds canonical JSON refuses (docs/05 D40). */
export type CanonicalNumberKind = "NaN" | "+Infinity" | "-Infinity" | "unsafe integer";

/**
 * Raised by `canonicalJson`/`validateCanonicalNumbers` for a number that has
 * no canonical JSON form. `path` is the JSONPath-style location of the value
 * (`$` is the root: e.g. `$.payload.count`, `$.items[2]`), and the message
 * names it.
 */
export class CanonicalNumberError extends Error {
  readonly kind: CanonicalNumberKind;
  readonly path: string;
  readonly value: number;

  constructor(kind: CanonicalNumberKind, path: string, value: number) {
    super(`canonical JSON refuses ${kind === "unsafe integer" ? `unsafe integer ${value}` : kind} at ${path}`);
    this.name = "CanonicalNumberError";
    this.kind = kind;
    this.path = path;
    this.value = value;
  }
}

/** The |n| under which JSON.stringify prints an integer in decimal form. */
const DECIMAL_INTEGER_BOUND = 1e21;

function refuseInvalidNumbers(value: number, path: string): void {
  if (Number.isNaN(value)) throw new CanonicalNumberError("NaN", path, value);
  if (value === Number.POSITIVE_INFINITY) throw new CanonicalNumberError("+Infinity", path, value);
  if (value === Number.NEGATIVE_INFINITY) throw new CanonicalNumberError("-Infinity", path, value);
  // An integer at or beyond ±2^53 whose shortest form is a decimal numeral
  // implies a precision a double cannot carry; JSON.stringify switches to
  // exponential form at |n| >= 1e21, and an exponential form makes no such
  // claim, so those values are encodable.
  if (Number.isInteger(value) && !Number.isSafeInteger(value) && Math.abs(value) < DECIMAL_INTEGER_BOUND) {
    throw new CanonicalNumberError("unsafe integer", path, value);
  }
}

function childPath(path: string, key: string): string {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key) ? `${path}.${key}` : `${path}[${JSON.stringify(key)}]`;
}

/**
 * Walk `value` and refuse any number canonical JSON cannot encode (docs/05
 * D40) before the serializer sees it. Objects are walked with the same own
 * enumerable keys the serializer uses, and `undefined`-valued object keys are
 * skipped exactly as the serializer skips them.
 */
export function validateCanonicalNumbers(value: unknown, path = "$"): void {
  if (value === null) return;
  if (typeof value !== "object") {
    if (typeof value === "number") refuseInvalidNumbers(value, path);
    return;
  }
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      validateCanonicalNumbers(value[index], `${path}[${index}]`);
    }
    return;
  }
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (record[key] === undefined) continue;
    validateCanonicalNumbers(record[key], childPath(path, key));
  }
}

/**
 * Canonical JSON (docs/05 D3/D40): byte-identical to the frozen serializer in
 * ../contracts.ts for every valid value; refuses NaN, ±Infinity and unsafe
 * decimal integers with a `CanonicalNumberError` naming the value's path.
 */
export function canonicalJson(value: unknown): string {
  validateCanonicalNumbers(value);
  return encodeCanonicalJson(value);
}

/** sha256 hex of the canonical JSON of an envelope minus `hash` (docs/05 D3, D40). */
export function hashEnvelope(ev: Omit<EventEnvelope, "hash">): string {
  return sha256Hex(canonicalJson(ev));
}

/** sha256 hex of the canonical JSON of a receipt minus `hash` (docs/05 D3, D40). */
export function hashReceipt(r: Omit<Receipt, "hash">): string {
  return sha256Hex(canonicalJson(r));
}

/** sha256 hex of the canonical JSON of any value — the digest used for tools. */
export function digestOf(value: unknown): string {
  return sha256Hex(canonicalJson(value));
}
