/**
 * model-tool-routing.ts — the declarative model->tool routing table.
 *
 * Some models speak a different editing dialect than others: the GPT-5/Codex
 * family is trained to emit the `apply_patch` freeform grammar, where
 * Anthropic/others do better with the find/replace `edit` tool. Rather than
 * scatter `model.includes("codex")` checks through the loop and the tools, the
 * decision lives in ONE data-driven rule table, evaluated ONCE per run against
 * the active model + provider (see research/compare-cline-claude.md A.7, whose
 * `ToolRoutingRule` + `resolveToolRoutingConfig` this mirrors in reduced form).
 *
 * A rule matches on case-insensitive substrings of the model id and/or the
 * provider id; a matching rule contributes `enableTools` and `disableTools`.
 * The invariant inside a rule is ENABLE WINS OVER DISABLE: disable is applied
 * first, then enable, so a rule that lists the same tool in both ends up
 * enabling it. Across rules the union is taken in table order, each folded with
 * the same enable-wins discipline.
 *
 * The resolver returns a decision usable as a predicate (`isToolEnabled`) plus
 * a `toToolFilter(prev?)` helper that composes with an existing tool filter, so
 * the loop can intersect routing with the subagent's own tool restriction
 * without rewriting its internals. Nothing here touches the kernel: this is
 * TS-side tool visibility/admission, not an authority decision.
 */

/** `mode` is carried for parity with the reference table; HorizonCode's plan/act toggle is binary, so `any` is the only value that affects a decision today. */
export type ToolRoutingMode = "act" | "plan" | "any";

/**
 * One routing rule. A rule with no `modelIdIncludes` and no `providerIdIncludes`
 * matches every run (a blanket default); otherwise EVERY listed predicate class
 * that is present must have at least one matching substring (model OR provider,
 * see `ruleMatches`). Enable/disable name the tool-registry names (`apply_patch`,
 * `edit`, ...).
 */
export interface ToolRoutingRule {
  /** A human-readable label for the rule (diagnostics only). */
  name?: string;
  /** Reserved for a future plan/act split; `any` (or absent) always applies. */
  mode?: ToolRoutingMode;
  /** Case-insensitive substrings; a match on any one satisfies the model side. */
  modelIdIncludes?: string[];
  /** Case-insensitive substrings; a match on any one satisfies the provider side. */
  providerIdIncludes?: string[];
  /** Tools this rule forces ON (enable wins over disable within the rule). */
  enableTools?: string[];
  /** Tools this rule forces OFF. */
  disableTools?: string[];
}

/**
 * The shipped defaults: the GPT/Codex family (by provider `openai` OR a model
 * id containing `codex`/`gpt`) gets `apply_patch` enabled and the find/replace
 * `edit` tool disabled; everything else is untouched (no rule matches, so `edit`
 * stays enabled and `apply_patch` is not forced off — it simply is not forced
 * on). Two rules rather than one so either signal alone (provider or model id)
 * routes, exactly as the reference ships it.
 */
export const DEFAULT_MODEL_TOOL_ROUTING_RULES: readonly ToolRoutingRule[] = [
  {
    name: "openai-native-apply-patch",
    mode: "any",
    providerIdIncludes: ["openai"],
    enableTools: ["apply_patch"],
    disableTools: ["edit"],
  },
  {
    name: "gpt-codex-family-apply-patch",
    mode: "any",
    modelIdIncludes: ["codex", "gpt"],
    enableTools: ["apply_patch"],
    disableTools: ["edit"],
  },
] as const;

/** The resolved routing decision for one run: the explicit enable/disable sets. */
export interface ToolRoutingDecision {
  /** Tools forced ON by a matching rule (enable wins over disable). */
  readonly enabled: ReadonlySet<string>;
  /** Tools forced OFF by a matching rule and not re-enabled. */
  readonly disabled: ReadonlySet<string>;
  /** True when the tool is not routing-disabled (unmentioned tools are enabled). */
  isToolEnabled(name: string): boolean;
  /**
   * Compose with an existing tool filter: the result keeps a tool only when the
   * prior filter keeps it AND routing has not disabled it. Routing never
   * *widens* a prior filter (a tool the subagent already excluded stays
   * excluded); it only removes routing-disabled tools.
   */
  toToolFilter(prev?: (name: string) => boolean): (name: string) => boolean;
}

/** Case-insensitive "does any needle appear as a substring of hay?" */
function includesAny(hay: string, needles: readonly string[] | undefined): boolean {
  if (needles === undefined || needles.length === 0) return false;
  const lower = hay.toLowerCase();
  return needles.some((needle) => typeof needle === "string" && needle !== "" && lower.includes(needle.toLowerCase()));
}

/**
 * Does this rule match the active model/provider? A rule with neither predicate
 * class is a blanket match. When a class is present it is a disjunction within
 * the class (any listed substring) and the model and provider classes are OR'd
 * with each other — matching the reference, where `providerIdIncludes:["openai"]`
 * alone routes, and `modelIdIncludes:["codex","gpt"]` alone routes.
 */
function ruleMatches(rule: ToolRoutingRule, model: string, provider: string): boolean {
  const hasModel = Array.isArray(rule.modelIdIncludes) && rule.modelIdIncludes.length > 0;
  const hasProvider = Array.isArray(rule.providerIdIncludes) && rule.providerIdIncludes.length > 0;
  if (!hasModel && !hasProvider) return true;
  if (hasModel && includesAny(model, rule.modelIdIncludes)) return true;
  if (hasProvider && includesAny(provider, rule.providerIdIncludes)) return true;
  return false;
}

export interface ResolveToolRoutingArgs {
  /** The active model id (e.g. `gpt-4o-mini`, `claude-sonnet-4-5`). */
  model: string;
  /** The active provider id (e.g. `openai`, `anthropic`). */
  provider: string;
  /** Override the rule table (tests); defaults to the shipped defaults. */
  rules?: readonly ToolRoutingRule[];
}

/**
 * Fold every MATCHING rule into one enable/disable decision, evaluated ONCE per
 * run. Within each rule disable is applied first and enable second, so enable
 * wins over disable; across rules the sets accumulate in table order under the
 * same discipline (a later enable overrides an earlier disable and vice versa,
 * last-writer-per-tool, with enable winning on a same-rule tie). Unmatched
 * tools are left alone — `isToolEnabled` answers true for anything not in the
 * disabled set.
 */
export function resolveToolRoutingConfig(args: ResolveToolRoutingArgs): ToolRoutingDecision {
  const model = typeof args.model === "string" ? args.model : "";
  const provider = typeof args.provider === "string" ? args.provider : "";
  const rules = args.rules ?? DEFAULT_MODEL_TOOL_ROUTING_RULES;

  const enabled = new Set<string>();
  const disabled = new Set<string>();

  for (const rule of rules) {
    if (!ruleMatches(rule, model, provider)) continue;
    // Disable first, then enable: enable wins over disable within the rule.
    for (const name of rule.disableTools ?? []) {
      if (typeof name !== "string" || name === "") continue;
      disabled.add(name);
      enabled.delete(name);
    }
    for (const name of rule.enableTools ?? []) {
      if (typeof name !== "string" || name === "") continue;
      enabled.add(name);
      disabled.delete(name);
    }
  }

  const isToolEnabled = (name: string): boolean => !disabled.has(name);

  return {
    enabled,
    disabled,
    isToolEnabled,
    toToolFilter(prev?: (name: string) => boolean): (name: string) => boolean {
      return (name: string): boolean => {
        if (prev !== undefined && !prev(name)) return false;
        return isToolEnabled(name);
      };
    },
  };
}
