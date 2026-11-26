/**
 * frame-reader.ts — cancel-safe length-prefixed frame decoder
 * (grok leader FrameReader ADAPT). Source: xai-grok-shell/src/leader/protocol.rs:9-99.
 *
 * Format: 4-byte big-endian u32 length + body; MAX 64 MiB. Pure — feed arbitrary
 * chunks and receive complete frames; a partial frame is buffered, never emitted
 * or desynchronized (the cancel-safety property). No socket, no I/O, no authority.
 */

export const FRAME_HEADER_LEN = 4;
export const MAX_FRAME_SIZE = 64 * 1024 * 1024;

export interface FrameReader {
  /** Feed a chunk; returns the complete frames now available. */
  feed(chunk: Uint8Array): string[];
  /** End of stream: clean when the buffer is empty, else a typed error. */
  end(): string[];
  readonly bufferedBytes: number;
}

/** Encode a UTF-8 string as a length-prefixed frame (for tests/peers). */
export function encodeFrame(text: string): Uint8Array {
  const body = new TextEncoder().encode(text);
  const out = new Uint8Array(FRAME_HEADER_LEN + body.length);
  new DataView(out.buffer).setUint32(0, body.length, false);
  out.set(body, FRAME_HEADER_LEN);
  return out;
}

export function createFrameReader(maxFrame = MAX_FRAME_SIZE): FrameReader {
  let buf = new Uint8Array(0);
  const append = (chunk: Uint8Array): void => {
    if (chunk.length === 0) return;
    const next = new Uint8Array(buf.length + chunk.length);
    next.set(buf, 0);
    next.set(chunk, buf.length);
    buf = next;
  };
  const decode = (): string[] => {
    const out: string[] = [];
    while (buf.length >= FRAME_HEADER_LEN) {
      const len = new DataView(buf.buffer, buf.byteOffset, buf.byteLength).getUint32(0, false);
      if (len > maxFrame) throw new Error(`HZ_PRECONDITION_FAILED: frame too large (${len} > ${maxFrame})`);
      const total = FRAME_HEADER_LEN + len;
      if (buf.length < total) break; // partial body: wait for more
      out.push(new TextDecoder().decode(buf.subarray(FRAME_HEADER_LEN, total)));
      buf = buf.subarray(total);
    }
    return out;
  };
  return {
    feed(chunk: Uint8Array): string[] {
      append(chunk);
      return decode();
    },
    end(): string[] {
      if (buf.length !== 0) throw new Error("HZ_PRECONDITION_FAILED: EOF inside incomplete frame");
      return [];
    },
    get bufferedBytes(): number {
      return buf.length;
    },
  };
}
