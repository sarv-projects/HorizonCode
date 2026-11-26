/** Text body and manual refresh helper for TUI `/models` (pure; tested without a runtime). */

import {
  refreshModelsCatalog,
  type RefreshModelsCatalogOpts,
  type RefreshModelsCatalogResult,
} from "../core/catalog/catalog-poll";

export const MODELS_LIST_CAP = 48;

export function formatModelsNotice(provider: string, list: readonly string[], cap = MODELS_LIST_CAP): string {
  if (list.length === 0) {
    return `no models listed for provider ${provider} — set models[] in user config or run hzcode models refresh when online`;
  }
  const body = list.slice(0, cap).join("\n");
  const tail = list.length > cap ? `\n\u2026 +${list.length - cap} more` : "";
  return `models for ${provider} (${list.length}):\n${body}${tail}`;
}

/** True when the `/models` slash-command argument requests a manual catalog refresh. */
export function isModelsRefreshCommand(arg: string | undefined): boolean {
  return typeof arg === "string" && arg.trim().toLowerCase() === "refresh";
}

/** Format the result of `/models refresh` into a single concise TUI notice. */
export function formatModelsRefreshNotice(result: RefreshModelsCatalogResult): string {
  if (result.status === "updated") {
    const counts =
      result.providerCount !== undefined && result.modelCount !== undefined
        ? `${result.providerCount} providers, ${result.modelCount} models`
        : result.providerCount !== undefined
          ? `${result.providerCount} providers`
          : "catalog updated";
    return `models catalog refreshed (${counts})${result.diff ? ` — ${result.diff}` : ""}`;
  }
  if (result.status === "not-modified" || result.status === "unchanged-digest") {
    return "models catalog already up to date";
  }
  return result.message;
}

/** Execute `/models refresh` with `force: true` (bypassing 5m TTL and ETag). */
export async function runModelsSlashRefresh(
  opts: Omit<RefreshModelsCatalogOpts, "force"> = {},
): Promise<{ result: RefreshModelsCatalogResult; notice: string }> {
  const result = await refreshModelsCatalog({ ...opts, force: true });
  return { result, notice: formatModelsRefreshNotice(result) };
}
