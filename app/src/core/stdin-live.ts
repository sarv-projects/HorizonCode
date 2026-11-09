/**
 * stdin-live.ts: an async iterable over process stdin that yields each chunk
 * as it arrives (see stdin-worker.ts for why process.stdin is not used).
 */

export function liveStdin(): AsyncIterable<string> {
  return {
    [Symbol.asyncIterator](): AsyncIterator<string> {
      const worker = new Worker(new URL("./stdin-worker.ts", import.meta.url).href);
      const queue: string[] = [];
      let ended = false;
      let wake: (() => void) | undefined;
      const poke = (): void => {
        const w = wake;
        wake = undefined;
        w?.();
      };
      worker.onmessage = (ev: MessageEvent<{ chunk?: string; end?: true }>) => {
        if (typeof ev.data.chunk === "string") queue.push(ev.data.chunk);
        else ended = true;
        poke();
      };
      worker.onerror = () => {
        ended = true;
        poke();
      };
      return {
        async next(): Promise<IteratorResult<string>> {
          while (queue.length === 0 && !ended) await new Promise<void>((r) => (wake = r));
          const chunk = queue.shift();
          if (chunk !== undefined) return { value: chunk, done: false };
          worker.terminate();
          return { value: undefined, done: true };
        },
        async return(): Promise<IteratorResult<string>> {
          worker.terminate();
          return { value: undefined, done: true };
        },
      };
    },
  };
}
