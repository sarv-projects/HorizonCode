/**
 * diagnostics-ledger.ts — de-charge repeated diagnostics by a
 * location-independent identity.
 *
 * The model should not be re-charged context for a diagnostic it has already
 * seen. A diagnostic message typically carries a `file:line:col ` prefix that
 * shifts whenever unrelated edits move the line around, even though the problem
 * itself is unchanged. `diagnosticIdentity` strips that prefix so the SAME
 * problem collapses to one identity regardless of where it now sits.
 *
 * This file is deliberately dependency-free: it operates on `string[]`, so it
 * is portable to ANY diagnostic source — a language server, `tsc --noEmit`, a
 * linter, or any tool that emits one message per line. There is no LSP type in
 * sight.
 *
 * Diagnostics are de-charged per `(ledger instance, file)`: a DiagnosticsLedger
 * holds a per-file seen-set, and `reduce` returns only the messages whose
 * identity is fresh for that file, then REPLACES the file's seen-set with the
 * current identities. Because the seen-set is replaced (not unioned), a
 * diagnostic that disappears and later reappears is reported as fresh again —
 * the reappearance is genuinely new information for the model.
 */

/** Strips a leading `file:line:col ` prefix (`src/a.ts:12:5 `) off a message. */
const DIAGNOSTIC_LOCATION_PREFIX_RE = /^.*?:\d+:\d+\s+/;

/**
 * A location-independent identity for a diagnostic message. Two messages that
 * differ only by their `file:line:col ` prefix map to the same identity; a
 * message with no such prefix is returned unchanged.
 */
export function diagnosticIdentity(message: string): string {
  return message.replace(DIAGNOSTIC_LOCATION_PREFIX_RE, "");
}

/**
 * Remembers which diagnostic identities have been reported per file and returns
 * only the fresh ones, so the model is not re-charged for diagnostics it has
 * already seen. State is per instance and per file.
 */
export class DiagnosticsLedger {
  private readonly seen = new Map<string, Set<string>>();

  /**
   * Given the CURRENT diagnostic messages for a file, return only the messages
   * whose identity was not already seen for that file, then replace the file's
   * seen-set with the current identities (not a union). An empty current set
   * clears the file's entry, so a problem that vanishes and returns is fresh.
   */
  reduce(absPath: string, messages: string[]): string[] {
    const previous = this.seen.get(absPath);
    const current = new Set<string>();
    const fresh: string[] = [];

    for (const message of messages) {
      const identity = diagnosticIdentity(message);
      current.add(identity);
      if (!previous?.has(identity)) {
        fresh.push(message);
      }
    }

    if (current.size === 0) {
      this.seen.delete(absPath);
    } else {
      this.seen.set(absPath, current);
    }

    return fresh;
  }
}
