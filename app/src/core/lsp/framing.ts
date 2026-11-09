/**
 * framing.ts — the Content-Length JSON-RPC framer for the LSP transport.
 *
 * LSP does NOT use the newline-delimited frames MCP does. Every message is a
 * JSON body preceded by a header block, the two separated by a blank line, and
 * the body length announced in bytes:
 *
 *   Content-Length: 123\r\n
 *   \r\n
 *   {"jsonrpc":"2.0",...}
 *
 * `encodeMessage` builds one such frame. `LspFramer` is the decode half: bytes
 * arrive in arbitrary chunks (a header split across two reads, two whole
 * messages in one read, a body that straddles a boundary), and `drain()`
 * returns every COMPLETE message object the buffer currently holds, keeping the
 * partial tail for the next `push`.
 *
 * Resynchronisation is the one defensive rule worth stating: a header block
 * that carries no parseable `Content-Length` is skipped past (to the byte after
 * its terminating blank line) rather than stalling the stream forever — a
 * malformed server frame costs that one frame, not the whole connection. A body
 * whose bytes are not JSON is likewise skipped with a logged reason; the framer
 * never throws into the read loop.
 */

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

/** The header/body separator: a bare CRLF after the last header line. */
const HEADER_TERMINATOR = "\r\n\r\n";

/**
 * Encode one JSON-RPC message as a Content-Length framed buffer. The length is
 * the BYTE length of the UTF-8 body, not its character count (a multi-byte
 * character would otherwise desynchronise the peer's reader).
 */
export function encodeMessage(message: unknown): Uint8Array {
  const body = textEncoder.encode(JSON.stringify(message) ?? "null");
  const header = textEncoder.encode(`Content-Length: ${body.length}\r\n\r\n`);
  const out = new Uint8Array(header.length + body.length);
  out.set(header, 0);
  out.set(body, header.length);
  return out;
}

/** The parsed `Content-Length` of a header block, or undefined when absent/garbage. */
function parseContentLength(header: string): number | undefined {
  for (const line of header.split("\r\n")) {
    const colon = line.indexOf(":");
    if (colon < 0) continue;
    if (line.slice(0, colon).trim().toLowerCase() !== "content-length") continue;
    const value = Number.parseInt(line.slice(colon + 1).trim(), 10);
    if (Number.isInteger(value) && value >= 0) return value;
  }
  return undefined;
}

/**
 * A streaming Content-Length JSON-RPC decoder. Feed it raw bytes with `push`;
 * take the complete decoded messages with `drain`. State across chunks is the
 * accumulated byte buffer; nothing is lost at a chunk boundary.
 */
export class LspFramer {
  /** The unconsumed bytes: a partial frame waiting for the rest of its body. */
  private buffer = new Uint8Array(0);
  private readonly onNotice: ((message: string) => void) | undefined;

  constructor(onNotice?: (message: string) => void) {
    this.onNotice = onNotice;
  }

  /** Append a chunk of transport bytes to the pending buffer. */
  push(chunk: Uint8Array): void {
    if (chunk.length === 0) return;
    const next = new Uint8Array(this.buffer.length + chunk.length);
    next.set(this.buffer, 0);
    next.set(chunk, this.buffer.length);
    this.buffer = next;
  }

  /**
   * Return every complete message the buffer now holds, in order, consuming
   * them from the buffer. A frame whose header has no Content-Length is skipped
   * (the stream resyncs past it); a body that is not JSON is dropped with a
   * notice. Both are bounded: the loop always makes progress or stops.
   */
  drain(): unknown[] {
    const out: unknown[] = [];
    for (;;) {
      const message = this.next();
      if (message === NO_MESSAGE) break;
      if (message !== SKIP) out.push(message);
    }
    return out;
  }

  /** One decode step: a message, SKIP (resynced past junk), or NO_MESSAGE (need bytes). */
  private next(): unknown {
    const text = textDecoder.decode(this.buffer);
    const sep = text.indexOf(HEADER_TERMINATOR);
    if (sep < 0) return NO_MESSAGE; // the header block is not complete yet

    // The header occupies the bytes up to and including the blank-line terminator.
    const headerText = text.slice(0, sep);
    const headerByteLen = textEncoder.encode(headerText).length + HEADER_TERMINATOR.length;
    const length = parseContentLength(headerText);

    if (length === undefined) {
      // No Content-Length: this is not a frame we can measure. Resync past the
      // header block so one malformed frame cannot stall the whole stream.
      this.buffer = this.buffer.slice(headerByteLen);
      this.onNotice?.("lsp framer: skipped a header block with no Content-Length");
      return SKIP;
    }

    const frameEnd = headerByteLen + length;
    if (this.buffer.length < frameEnd) return NO_MESSAGE; // body not fully arrived

    const bodyBytes = this.buffer.slice(headerByteLen, frameEnd);
    this.buffer = this.buffer.slice(frameEnd);
    try {
      return JSON.parse(textDecoder.decode(bodyBytes)) as unknown;
    } catch {
      this.onNotice?.("lsp framer: dropped a frame whose body was not JSON");
      return SKIP;
    }
  }
}

/** Sentinels for the single-step decoder; never leak outside this module. */
const NO_MESSAGE = Symbol("lsp-framer-no-message");
const SKIP = Symbol("lsp-framer-skip");
