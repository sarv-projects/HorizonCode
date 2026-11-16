/**
 * H-1 reduced: `accepts_settings` negotiation (aider-style).
 *
 * Unsupported optional provider params are stripped (or refused) with a warning
 * instead of being sent to a host that would 400. Declarative YAML model
 * settings + user override layers remain OPEN.
 */

import type { CatalogModel } from "./catalog";

/** Settings HorizonCode may negotiate against catalog `accepts_settings`. */
export const NEGOTIABLE_SETTINGS = ["reasoning_effort"] as const;
export type NegotiableSetting = (typeof NEGOTIABLE_SETTINGS)[number];

export type RequestedSettings = Partial<Record<NegotiableSetting, string>>;

export interface NegotiateAcceptsSettingsResult {
  /** Settings safe to place on the provider wire. */
  accepted: RequestedSettings;
  /** Requested keys that were stripped because the model rejects them. */
  stripped: NegotiableSetting[];
  /** Human-readable notices (empty when nothing was stripped). */
  warnings: string[];
}

/**
 * Resolve the model's accepted optional-settings list.
 *
 * Precedence: explicit `acceptsSettings` (including `[]`) → derive from
 * `capabilities.reasoning` → `undefined` (unknown / no catalog row → permissive).
 */
export function resolveCatalogAcceptsSettings(model: CatalogModel | undefined): string[] | undefined {
  if (model === undefined) return undefined;
  if (model.acceptsSettings !== undefined) return model.acceptsSettings;
  if (model.capabilities?.reasoning === true) return ["reasoning_effort"];
  if (model.capabilities?.reasoning === false) return [];
  return undefined;
}

/**
 * Parse `HZ_CHECK_MODEL_ACCEPTS_SETTINGS`: unset/`1`/`true` → check (default-on);
 * `0`/`false`/`off` → force-send unsupported params (aider `--no-check-…` parity).
 */
export function parseCheckModelAcceptsSettingsFlag(raw: string | undefined): boolean {
  if (raw === undefined) return true;
  const v = raw.trim().toLowerCase();
  if (v === "" || v === "1" || v === "true" || v === "on" || v === "yes") return true;
  if (v === "0" || v === "false" || v === "off" || v === "no") return false;
  return true;
}

/**
 * Strip (or keep) requested optional settings against a model's accepts list.
 *
 * - `check === false`: keep all requested values (no strip, no warnings).
 * - `accepts === undefined`: permissive keep (unknown model / no catalog row).
 * - otherwise: keep only keys listed in `accepts`; strip the rest with warnings.
 */
export function negotiateAcceptsSettings(
  requested: RequestedSettings,
  accepts: string[] | undefined,
  opts?: { modelName?: string; check?: boolean },
): NegotiateAcceptsSettingsResult {
  const options = opts ?? {};
  const check = options.check !== false;
  const named = options.modelName?.trim() ?? "";
  const modelName = named !== "" ? named : "model";
  const accepted: RequestedSettings = {};
  const stripped: NegotiableSetting[] = [];
  const warnings: string[] = [];

  for (const key of NEGOTIABLE_SETTINGS) {
    const value = requested[key];
    if (value === undefined) continue;
    const text = value.trim();
    if (text === "") continue;

    if (!check || accepts === undefined || accepts.includes(key)) {
      accepted[key] = text;
      continue;
    }
    stripped.push(key);
    warnings.push(
      `${modelName} does not accept '${key}', ignoring. Set HZ_CHECK_MODEL_ACCEPTS_SETTINGS=0 to force.`,
    );
  }

  return { accepted, stripped, warnings };
}

/** Convenience: negotiate a single optional `reasoning_effort` wire value. */
export function negotiateReasoningEffort(
  effort: string | undefined,
  accepts: string[] | undefined,
  opts?: { modelName?: string; check?: boolean },
): { effort?: string; warnings: string[] } {
  if (effort === undefined || effort.trim() === "") return { warnings: [] };
  const result = negotiateAcceptsSettings({ reasoning_effort: effort }, accepts, opts);
  return {
    effort: result.accepted.reasoning_effort,
    warnings: result.warnings,
  };
}
