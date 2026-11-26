/**
 * defect-tunnel.ts — port of opencode's DeclinedError tunneling + CorrectedError steering.
 * Source: repo_take/opencode/packages/core/src/permission.ts:67-76,272-278.
 *
 * A user's PLAIN decline (`PermissionDeclinedError` / `UserDeclinedDefect`) is an
 * uncaught defect: leaf tools and wrappers with blanket `catch` / `mapError`
 * handlers must NEVER swallow or convert a user decline into model-facing tool
 * output. We re-throw it via `tunnelDecline` so the outer boundary handles it.
 *
 * A decline WITH steering feedback (`PermissionCorrectedError` / `CorrectedError`)
 * stays structured and propagates the user's exact steering instruction cleanly
 * back to the agent loop (`loop.ts`) so the model can adapt without crashing the
 * session.
 *
 * Pure TS — no Effect dependency, no authority change.
 */

/** Branded symbol identifying non-recoverable user permission declines across realms. */
export const PERMISSION_DECLINED_BRAND: unique symbol = Symbol.for(
  "horizoncode.permission.declined",
) as unknown as typeof PERMISSION_DECLINED_BRAND;

/** Branded symbol identifying structured user permission rejections with steering feedback. */
export const PERMISSION_CORRECTED_BRAND: unique symbol = Symbol.for(
  "horizoncode.permission.corrected",
) as unknown as typeof PERMISSION_CORRECTED_BRAND;

export interface PermissionErrorMeta {
  readonly kind?: string;
  readonly target?: string;
}

/**
 * Structured outcome returned by 3-stage approval prompts or handlers.
 * Backwards-compatible with legacy boolean `ApprovalHandler` returns.
 */
export type StructuredApprovalOutcome =
  | { readonly decision: "approved"; readonly scope: "once" | "always" }
  | { readonly decision: "declined" }
  | { readonly decision: "rejected_with_steering"; readonly feedback: string };

export type ApprovalOutcome = boolean | StructuredApprovalOutcome;

/** Normalize a legacy boolean or structured approval outcome into a structured record. */
export function normalizeApprovalOutcome(raw: ApprovalOutcome): StructuredApprovalOutcome {
  if (typeof raw === "boolean") {
    return raw ? { decision: "approved", scope: "once" } : { decision: "declined" };
  }
  return raw;
}

/**
 * A plain user decline (non-recoverable): must tunnel through tool catch/mapping
 * layers as a defect and never be converted into a generic tool error string.
 */
export class PermissionDeclinedError extends Error {
  readonly [PERMISSION_DECLINED_BRAND] = true;
  readonly _tag = "Permission.DeclinedError" as const;
  override readonly name: string = "PermissionDeclinedError";
  readonly kind?: string;
  readonly target?: string;

  constructor(message = "user declined the permission request", meta?: PermissionErrorMeta) {
    super(message);
    this.kind = meta?.kind;
    this.target = meta?.target;
  }
}

/** Backwards-compatible alias for `PermissionDeclinedError`. */
export class UserDeclinedDefect extends PermissionDeclinedError {
  override readonly name = "UserDeclinedDefect";
  constructor(meta?: PermissionErrorMeta) {
    super("user declined the permission request", meta);
  }
}

/**
 * A user rejection WITH corrective steering feedback: stays structured so the
 * agent loop feeds the exact steering instruction back to the model without
 * crashing the session.
 */
export class PermissionCorrectedError extends Error {
  readonly [PERMISSION_CORRECTED_BRAND] = true;
  readonly _tag = "Permission.CorrectedError" as const;
  override readonly name: string = "PermissionCorrectedError";
  readonly feedback: string;
  readonly kind?: string;
  readonly target?: string;

  constructor(feedback: string, meta?: PermissionErrorMeta) {
    const trimmed = feedback.trim();
    super(trimmed);
    this.feedback = trimmed;
    this.kind = meta?.kind;
    this.target = meta?.target;
  }
}

/** Backwards-compatible alias for `PermissionCorrectedError`. */
export class CorrectedError extends PermissionCorrectedError {
  override readonly name = "CorrectedError";
  constructor(feedback: string, meta?: PermissionErrorMeta) {
    super(feedback, meta);
  }
}

/** Type guard for `PermissionDeclinedError` (supports both class and branded symbol checks). */
export function isPermissionDeclinedError(err: unknown): err is PermissionDeclinedError {
  if (err instanceof PermissionDeclinedError) return true;
  if (typeof err === "object" && err !== null) {
    const rec = err as Record<PropertyKey, unknown>;
    if (rec[PERMISSION_DECLINED_BRAND] === true) return true;
    if (rec._tag === "Permission.DeclinedError") return true;
  }
  return false;
}

/** Type guard for `PermissionCorrectedError` (supports both class and branded symbol checks). */
export function isPermissionCorrectedError(err: unknown): err is PermissionCorrectedError {
  if (err instanceof PermissionCorrectedError) return true;
  if (typeof err === "object" && err !== null) {
    const rec = err as Record<PropertyKey, unknown>;
    if (rec[PERMISSION_CORRECTED_BRAND] === true && typeof rec.feedback === "string") return true;
    if (rec._tag === "Permission.CorrectedError" && typeof rec.feedback === "string") return true;
  }
  return false;
}

/** Re-throw a plain decline; a corrected error or ordinary error is not a defect. */
export function tunnelDecline(err: unknown): void {
  if (isPermissionDeclinedError(err)) throw err;
}

/**
 * Re-throw either a plain decline defect or a structured steering correction so
 * blanket tool `catch` wrappers never swallow permission outcomes into generic
 * tool error strings.
 */
export function tunnelPermissionError(err: unknown): void {
  if (isPermissionDeclinedError(err) || isPermissionCorrectedError(err)) throw err;
}

/** Format user steering feedback cleanly for model-facing tool output. */
export function formatSteeringToolOutput(feedback: string): string {
  const clean = feedback.trim();
  return clean === ""
    ? "User rejected this action."
    : `User rejected this action with steering instructions: ${clean}`;
}

/**
 * Run `fn` and map its errors via `mapError`, EXCEPT a plain user decline,
 * which tunnels through as a defect. This is the TS equivalent of opencode's
 * `Effect.catchTag("Permission.DeclinedError", (e) => Effect.die(e))`.
 */
export function mapToolErrorKeepingDecline<T>(
  fn: () => T,
  mapError: (err: unknown) => T,
): T {
  try {
    return fn();
  } catch (err) {
    tunnelDecline(err);
    return mapError(err);
  }
}

/**
 * Async variant of `mapToolErrorKeepingDecline`: runs an async tool operation
 * and maps ordinary errors via `mapError`, while always tunneling
 * `PermissionDeclinedError` (and optionally `PermissionCorrectedError` when
 * `tunnelCorrected` is true) straight through without swallowing.
 */
export async function mapToolErrorKeepingDeclineAsync<T>(
  fn: () => Promise<T>,
  mapError: (err: unknown) => T | Promise<T>,
  opts?: { tunnelCorrected?: boolean },
): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    tunnelDecline(err);
    if (opts?.tunnelCorrected && isPermissionCorrectedError(err)) throw err;
    return await mapError(err);
  }
}
