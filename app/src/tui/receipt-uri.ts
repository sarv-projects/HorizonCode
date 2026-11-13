/**
 * hz://receipt/<id> palette / URI helpers (docs/13 R173; ruling **288**).
 */

const RECEIPT_URI_RE = /^hz:\/\/receipt\/([^/?#\s]+)\/?$/i;

export function parseHzReceiptUri(input: string): string | undefined {
  const m = RECEIPT_URI_RE.exec(input.trim());
  const id = m?.[1]?.trim();
  return id === "" || id === undefined ? undefined : id;
}

export function formatHzReceiptUri(receiptId: string): string {
  return `hz://receipt/${receiptId.trim()}`;
}

export function isHzReceiptPaletteCommand(commandName: string): boolean {
  return parseHzReceiptUri(commandName) !== undefined;
}
