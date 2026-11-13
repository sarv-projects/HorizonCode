/**
 * Optional Anthropic prompt caching marker on the system block (docs/30 B-4 reduced).
 *
 * Off by default. When `HZ_ANTHROPIC_CACHE_SYSTEM=1`, the wire `system` field is a
 * one-element block array with `cache_control: { type: "ephemeral" }` instead of
 * a plain string. Keep-alive scheduler stub lives in `anthropic-cache-keepalive.ts`.
 */

/** Whether to attach an ephemeral cache marker on the system prompt block. */
export function anthropicCacheSystemMarker(): boolean {
  return process.env.HZ_ANTHROPIC_CACHE_SYSTEM === "1";
}

/** Wire `system` field: plain string (default) or a single cached text block. */
export function anthropicSystemField(systemText: string): string | Array<Record<string, unknown>> {
  if (!anthropicCacheSystemMarker() || systemText === "") return systemText;
  return [{ type: "text", text: systemText, cache_control: { type: "ephemeral" } }];
}
