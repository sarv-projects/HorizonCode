/**
 * cancel-safe-line-reader.ts — Tier 3 grok line_reader ADAPT.
 * Source: repo_take/grok-build/crates/codegen/xai-acp-lib/src/line_reader.rs:25-55.
 *
 * Pure NDJSON framing: feed arbitrary chunks, emit ONLY complete
 * `\n`-delimited lines; a partial trailing line is retained and never emitted
 * early (the property that makes a `select!` caller cancel-safe). A 64 MiB cap
 * refuses a peer that never sends newlines. The caller owns the actual stdin /
 * socket and its cancellation — this is the framing seam, not an async reader.
 */

export const MAX_NDJSON_LINE_BYTES = 64 * 1024 * 1024;

export interface LineFramer {
  /** Feed a chunk; returns the complete lines now available (in order). */
  feed(chunk: string): string[];
  /** The retained incomplete trailing line. */
  readonly buffered: string;
  /** End of stream: any retained partial is dropped (never emitted as a line). */
  finish(): string[];
}

export function createLineFramer(maxBytes = MAX_NDJSON_LINE_BYTES): LineFramer {
  let buf = "";
  return {
    feed(chunk: string): string[] {
      buf += chunk;
      if (buf.length > maxBytes) {
        throw new Error(`HZ_PRECONDITION_FAILED: cancel-safe line too large (>${maxBytes} bytes)`);
      }
      const out: string[] = [];
      let nl: number;
      while ((nl = buf.indexOf("\n")) !== -1) {
        let line = buf.slice(0, nl);
        if (line.endsWith("\r")) line = line.slice(0, -1);
        if (line !== "") out.push(line);
        buf = buf.slice(nl + 1);
      }
      return out;
    },
    get buffered(): string {
      return buf;
    },
    finish(): string[] {
      buf = "";
      return [];
    },
  };
}
