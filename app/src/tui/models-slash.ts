/** Text body for TUI `/models` (pure; tested without a runtime). */

export const MODELS_LIST_CAP = 48;

export function formatModelsNotice(provider: string, list: readonly string[], cap = MODELS_LIST_CAP): string {
  if (list.length === 0) {
    return `no models listed for provider ${provider} — set models[] in user config or run hzcode models refresh when online`;
  }
  const body = list.slice(0, cap).join("\n");
  const tail = list.length > cap ? `\n\u2026 +${list.length - cap} more` : "";
  return `models for ${provider} (${list.length}):\n${body}${tail}`;
}
