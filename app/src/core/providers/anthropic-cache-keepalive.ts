/**
 * Optional Anthropic prompt-cache keep-alive scheduler (B-4 reduced).
 *
 * Off unless `HZ_ANTHROPIC_CACHE_KEEPALIVE_MS` is a positive integer (min 60s).
 * Emits a notice on each tick — no provider HTTP; live prefix re-send is open.
 */

export type AnthropicCacheKeepaliveStop = () => void;

export type KeepaliveIntervalHandle = {
  unref?: () => void;
};

export type KeepaliveScheduler = {
  setInterval: (fn: () => void, ms: number) => KeepaliveIntervalHandle;
  clearInterval: (handle: KeepaliveIntervalHandle) => void;
};

const defaultScheduler: KeepaliveScheduler = {
  setInterval: (fn, ms) => {
    const handle = setInterval(fn, ms);
    handle.unref?.();
    return handle;
  },
  clearInterval: (handle) => {
    clearInterval(handle as ReturnType<typeof setInterval>);
  },
};

export function parseAnthropicCacheKeepaliveMs(
  env: Record<string, string | undefined> = process.env as Record<string, string | undefined>,
): number | undefined {
  const raw =
    typeof env.HZ_ANTHROPIC_CACHE_KEEPALIVE_MS === "string"
      ? env.HZ_ANTHROPIC_CACHE_KEEPALIVE_MS.trim()
      : "";
  if (raw === "") return undefined;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 60_000) return undefined;
  return n;
}

/**
 * Start periodic no-op keep-alive notices when enabled. Returns `stop()`; no-op
 * when disabled. Injectable `scheduler` supports hermetic fake-timer tests.
 */
export function formatAnthropicCacheKeepaliveNotice(measureLine?: string): string {
  const base =
    "anthropic cache keep-alive: scheduled no-op ping (stub — no API call; enable breakpoints separately)";
  if (measureLine !== undefined && measureLine.trim() !== "") return `${base}; ${measureLine.trim()}`;
  return base;
}

export function startAnthropicCacheKeepalive(opts: {
  intervalMs?: number;
  onNotice?: (message: string) => void;
  /** Local prefix measure line (ruling 282); never calls the provider. */
  onMeasure?: () => string | undefined;
  scheduler?: KeepaliveScheduler;
} = {}): AnthropicCacheKeepaliveStop {
  const intervalMs = opts.intervalMs ?? parseAnthropicCacheKeepaliveMs();
  if (intervalMs === undefined) return () => undefined;
  const scheduler = opts.scheduler ?? defaultScheduler;
  let stopped = false;
  const tick = (): void => {
    if (stopped) return;
    opts.onNotice?.(formatAnthropicCacheKeepaliveNotice(opts.onMeasure?.()));
  };
  const handle = scheduler.setInterval(tick, intervalMs);
  return () => {
    stopped = true;
    scheduler.clearInterval(handle);
  };
}
