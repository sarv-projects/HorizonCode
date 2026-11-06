/**
 * canon.ts — canonical JSON and hashing.
 *
 * The rules live in ../contracts.ts and are shared with the Rust kernel; this
 * module only re-exports them so core code has one obvious place to import from.
 */

import { canonicalJson, sha256Hex } from "../contracts";

export { canonicalJson, sha256Hex };
export { hashEnvelope, hashReceipt } from "../contracts";

/** sha256 hex of the canonical JSON of any value — the digest used for tools. */
export function digestOf(value: unknown): string {
  return sha256Hex(canonicalJson(value));
}
