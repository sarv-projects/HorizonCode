/**
 * DeepSeek PTC reduced: per-minute sub-call allowance from wall-clock budget.
 */

export const DEFAULT_MAX_SUB_CALLS_PER_MINUTE = 1024;

export function ptcSubCallAllowance(timeoutMs: number, maxPerMinute = DEFAULT_MAX_SUB_CALLS_PER_MINUTE): number {
  const ms = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 60_000;
  const minutes = Math.floor(ms / 60_000);
  const slots = minutes < 1 ? 1 : minutes;
  return slots * maxPerMinute;
}

export function ptcLimitTerminationMessage(allowance: number, observed: number): string {
  return (
    `code_mode stopped: tool sub-call allowance exceeded (${observed}/${allowance}). ` +
    `Limit is floor(timeoutMs/60000)×maxSubCallsPerMinute (default ${DEFAULT_MAX_SUB_CALLS_PER_MINUTE}/min). ` +
    "Reduce parallelism or raise timeout_ms."
  );
}
