/**
 * anthropic-cache-measure.ts — local prefix size estimate (B-4 reduced; ruling 282).
 *
 * No provider HTTP — counts messages/bytes in the largest stable cacheable prefix.
 */

import type { ChatMsg } from "../../contracts";
import { cacheableMessagesCutIndex, cacheableMessagesPrefix } from "./cacheable-messages-prefix";

export interface CacheablePrefixMeasure {
  totalMessages: number;
  stablePrefixMessages: number;
  stablePrefixUtf8Bytes: number;
  cutIndex: number;
}

function utf8ByteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

export function measureCacheablePrefix(messages: readonly ChatMsg[]): CacheablePrefixMeasure {
  const cutIndex = cacheableMessagesCutIndex(messages);
  const prefix = cacheableMessagesPrefix(messages);
  let bytes = 0;
  for (const msg of prefix) {
    bytes += utf8ByteLength(msg.content ?? "");
    bytes += utf8ByteLength(msg.role);
  }
  return {
    totalMessages: messages.length,
    stablePrefixMessages: prefix.length,
    stablePrefixUtf8Bytes: bytes,
    cutIndex,
  };
}

export function formatCacheablePrefixMeasure(m: CacheablePrefixMeasure): string {
  return (
    `cacheable prefix: ${m.stablePrefixMessages}/${m.totalMessages} messages, ` +
    `~${m.stablePrefixUtf8Bytes} UTF-8 bytes (cut index ${m.cutIndex}; local measure only — no API cache-hit)`
  );
}
