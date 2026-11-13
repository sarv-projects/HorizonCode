/**
 * scrollback-receipt-shortcut.ts — Ctrl+I + hz:// receipt entry (ruling **290**).
 */

import type { Runtime } from "../contracts";
import { buildUnknownInspectLines } from "./unknown-slash";
import { parseHzReceiptUri } from "./receipt-uri";
import type { Renderer } from "./render";
import { dim } from "./style";

export function resolveScrollbackReceiptInspectTarget(
  unknownReceiptId: string | undefined,
  explicit?: string,
): string | undefined {
  const fromUri = explicit !== undefined ? parseHzReceiptUri(explicit) ?? explicit.trim() : undefined;
  if (fromUri && fromUri !== "") return fromUri;
  const ctx = unknownReceiptId?.trim() ?? "";
  return ctx === "" ? undefined : ctx;
}

export function scrollbackReceiptInspectNoticeNoTarget(): string {
  return "Ctrl+I: no receipt in context — type hz://receipt/<id>, /palette hz://receipt/<id>, or /unknown inspect";
}

export function printScrollbackReceiptInspect(
  runtime: Runtime,
  renderer: Renderer,
  target: string,
): boolean {
  const lines = buildUnknownInspectLines(runtime, target);
  if (!lines || lines.length === 0) {
    renderer.notice(`no UNKNOWN effect or receipt matched "${target}"`);
    return false;
  }
  for (const line of lines) {
    renderer.line(line.startsWith("  ") || line.startsWith("──") ? dim(line) : line);
  }
  return true;
}

export function tryScrollbackHzReceiptUriLine(
  runtime: Runtime,
  renderer: Renderer,
  text: string,
): boolean {
  const id = parseHzReceiptUri(text);
  if (id === undefined) return false;
  return printScrollbackReceiptInspect(runtime, renderer, id);
}
