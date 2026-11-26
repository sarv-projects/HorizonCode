/**
 * reverse-jsonl-scanner.ts — codex rollout ReverseJsonlScanner ADAPT.
 * Source: codex-rs/rollout/src/reverse_jsonl_scanner.rs:11-110.
 *
 * Pure scan of an in-memory NDJSON blob from the END: records are returned
 * newest-first, blank lines skipped, invalid JSON returned as `rejected`
 * without aborting, records over `maxRecordBytes` skipped without parsing, and
 * `endByteOffset` limits the scan to a frozen prefix. No IO, no authority.
 */

export type ScanOutcome =
  | { kind: "parsed"; value: unknown }
  | { kind: "rejected"; error: string };

export interface ReverseScanOptions {
  /** Logical end of the scan (bytes); scans only records before this offset. */
  endByteOffset?: number;
  /** Records larger than this are skipped (default 64 KiB, matching upstream chunk size). */
  maxRecordBytes?: number;
}

export function scanReverseJsonl(blob: string, opts: ReverseScanOptions = {}): ScanOutcome[] {
  const buf = new TextEncoder().encode(blob);
  const end = Math.min(Math.max(0, opts.endByteOffset ?? buf.length), buf.length);
  const maxBytes = Math.max(1, opts.maxRecordBytes ?? 64 * 1024);
  const out: ScanOutcome[] = [];

  // Walk backward from `end`, tracking newline boundaries.
  let recordEnd = end;
  // Drop a trailing partial line only when the logical end sits mid-line.
  if (recordEnd > 0 && buf[recordEnd - 1] !== 0x0a) {
    let nl = recordEnd - 1;
    while (nl >= 0 && buf[nl] !== 0x0a) nl -= 1;
    recordEnd = nl + 1; // skip the partial tail
  }
  let cursor = recordEnd;
  while (cursor > 0) {
    let start = cursor - 1;
    while (start >= 0 && buf[start] !== 0x0a) start -= 1;
    const lineBytes = buf.subarray(start + 1, cursor);
    cursor = start; // move before the newline for the next record
    if (lineBytes.length === 0) continue; // blank line
    if (lineBytes.length > maxBytes) continue; // oversized: skip without parsing
    const text = new TextDecoder().decode(lineBytes).trim();
    if (text === "") continue;
    try {
      out.push({ kind: "parsed", value: JSON.parse(text) as unknown });
    } catch (err) {
      out.push({ kind: "rejected", error: err instanceof Error ? err.message : String(err) });
    }
  }
  return out;
}

/** Convenience scanner returning only successfully parsed records newest-first. */
export function scanReverseJsonlRecords<T = unknown>(
  blob: string,
  opts: ReverseScanOptions & { maxRecords?: number } = {},
): T[] {
  const outcomes = scanReverseJsonl(blob, opts);
  const results: T[] = [];
  for (const outcome of outcomes) {
    if (outcome.kind === "parsed") {
      results.push(outcome.value as T);
      if (opts.maxRecords !== undefined && results.length >= opts.maxRecords) break;
    }
  }
  return results;
}
