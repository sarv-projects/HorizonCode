/**
 * lazy-boot.ts — Lightweight, concurrency-safe lazy resource provisioning (Wave 2 / Track 2B).
 *
 * Enables fast CLI subcommands to pay zero boot overhead for expensive subsystems
 * (sandboxes, MCP servers, language servers) while guaranteeing that concurrent
 * `get()` callers share a single initialization attempt and `dispose()` cleans up
 * safely without resurrecting stale initializations.
 */

export interface LazyResourceOptions<T> {
  /** Factory invoked at most once per lifecycle until disposed or failed. */
  init: () => Promise<T> | T;
  /** Optional cleanup hook invoked on `dispose()` when initialized (or if a late init completes after dispose). */
  dispose?: (value: T) => Promise<void> | void;
  /** Optional timeout in milliseconds for `init()`. */
  timeoutMs?: number;
  /** Optional human-readable name for error messages. */
  name?: string;
}

export class LazyBootTimeoutError extends Error {
  readonly resourceName: string;
  readonly timeoutMs: number;

  constructor(resourceName: string, timeoutMs: number) {
    super(`lazy boot "${resourceName}" timed out after ${timeoutMs}ms`);
    this.name = "LazyBootTimeoutError";
    this.resourceName = resourceName;
    this.timeoutMs = timeoutMs;
  }
}

export class LazyResource<T> {
  private readonly initFn: () => Promise<T> | T;
  private readonly disposeFn?: (value: T) => Promise<void> | void;
  private readonly timeoutMs?: number;
  private readonly resourceName: string;

  private initialized = false;
  private value: T | undefined;
  private inflight: Promise<T> | undefined;
  /** Monotonic generation counter incremented on every dispose() to fence stale in-flight inits. */
  private generation = 0;

  constructor(opts: LazyResourceOptions<T>) {
    if (typeof opts?.init !== "function") {
      throw new TypeError("LazyResource requires an init() function");
    }
    this.initFn = opts.init;
    this.disposeFn = opts.dispose;
    this.timeoutMs = opts.timeoutMs !== undefined && opts.timeoutMs > 0 ? opts.timeoutMs : undefined;
    this.resourceName = opts.name?.trim() || "resource";
  }

  /** True once `init()` has resolved and the resource has not been disposed. */
  isInitialized(): boolean {
    return this.initialized;
  }

  /** True while an `init()` call is currently in flight. */
  isInitializing(): boolean {
    return this.inflight !== undefined;
  }

  /** Return the initialized value synchronously if ready, otherwise undefined. */
  peek(): T | undefined {
    return this.initialized ? this.value : undefined;
  }

  /**
   * Return the resource, initializing it on first call.
   * Concurrent calls share the same in-flight promise.
   */
  get(): Promise<T> {
    if (this.initialized) {
      return Promise.resolve(this.value as T);
    }
    if (this.inflight !== undefined) {
      return this.inflight;
    }

    const gen = this.generation;
    const rawPromise = Promise.resolve().then(() => this.initFn());
    const boundedPromise = this.withTimeout(rawPromise);

    const tracked = boundedPromise.then(
      async (resolved) => {
        if (this.generation !== gen) {
          // Resource was disposed while init was in flight; clean up late value immediately.
          await this.safeDisposeValue(resolved);
          throw new Error(`lazy boot "${this.resourceName}" was disposed during initialization`);
        }
        this.value = resolved;
        this.initialized = true;
        this.inflight = undefined;
        return resolved;
      },
      (err) => {
        if (this.generation === gen) {
          this.inflight = undefined;
        }
        throw err;
      },
    );

    this.inflight = tracked;
    return tracked;
  }

  /**
   * Dispose the resource if initialized and fence any in-flight initialization.
   * Idempotent: calling `dispose()` when uninitialized is a safe no-op.
   */
  async dispose(): Promise<void> {
    this.generation += 1;
    const prevValue = this.value;
    const wasInitialized = this.initialized;
    this.initialized = false;
    this.value = undefined;
    this.inflight = undefined;

    if (wasInitialized) {
      await this.safeDisposeValue(prevValue as T);
    }
  }

  private withTimeout(promise: Promise<T>): Promise<T> {
    if (this.timeoutMs === undefined) return promise;
    const ms = this.timeoutMs;
    return new Promise<T>((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(new LazyBootTimeoutError(this.resourceName, ms));
      }, ms);

      promise.then(
        (val) => {
          if (settled) {
            // Init finished after timeout; clean up leaked resource best-effort.
            void this.safeDisposeValue(val);
            return;
          }
          settled = true;
          clearTimeout(timer);
          resolve(val);
        },
        (err) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          reject(err);
        },
      );
    });
  }

  private async safeDisposeValue(val: T): Promise<void> {
    if (!this.disposeFn) return;
    try {
      await this.disposeFn(val);
    } catch {
      /* disposal errors are swallowed to keep teardown deterministic */
    }
  }
}

/** Factory helper for creating a concurrency-safe lazy-booted resource. */
export function createLazyBoot<T>(opts: LazyResourceOptions<T>): LazyResource<T> {
  return new LazyResource<T>(opts);
}
