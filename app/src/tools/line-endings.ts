/**
 * line-endings.ts -- the shared LF-view contract for `edit` and `write`.
 *
 * The model never sees a file's CRLF endings: `read` strips "\r", so models
 * emit LF-only text. These helpers let the mutating tools match and normalise
 * against that LF view while keeping each file's real on-disk endings.
 *
 * The contract, in three rules:
 *   - models emit LF-only text (reads strip "\r");
 *   - an existing file keeps its detected EOL (CRLF stays CRLF, never rewritten
 *     to LF wholesale);
 *   - a new file has no EOL to preserve, so it takes the ending its own content
 *     chose, defaulting to LF.
 *
 * Deliberately dependency-free: no `node:os` coupling. HorizonCode is a
 * cross-platform agent, so new-file normalisation does NOT gate on `os.EOL`
 * (unlike cline's executors/line-endings.ts, which forces CRLF on Windows). The
 * ending is driven purely by the content's own detected ending.
 */

export type LineEnding = "\r\n" | "\n";

/**
 * The file's line ending: "\r\n" if "\r\n" appears ANYWHERE in `content`, else
 * "\n" -- including content with no line break at all.
 *
 * Files are uniformly CRLF or uniformly LF in practice; the mixed case that
 * matters is a CRLF file into which an earlier release of these tools inserted
 * LF-only lines. Any surviving "\r\n", wherever it sits, should pull the file
 * back to CRLF, which is why this checks for "\r\n" anywhere rather than only
 * the first line break.
 */
export function detectLineEnding(content: string): LineEnding {
  return content.includes("\r\n") ? "\r\n" : "\n";
}

/**
 * Re-join `text` on `eol`: split on any existing ending ("\r\n" or "\n") and
 * put them all back as `eol`. A pure-LF input normalised to "\n" is returned
 * byte-identical, so this is a no-op on the common case.
 */
export function normalizeLineEndings(text: string, eol: LineEnding): string {
  return text.split(/\r\n|\n/).join(eol);
}
