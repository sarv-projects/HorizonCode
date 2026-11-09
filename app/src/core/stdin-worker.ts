/**
 * stdin-worker.ts: a Worker that does BLOCKING reads of fd 0 and posts each
 * chunk to the main thread as it arrives. Bun 1.2.x delivers pipe stdin to
 * process.stdin / readline / Bun.stdin.stream() only at EOF, so an interactive
 * `hzcode serve` client would see no reply until it closed its end. A blocking
 * read on its own thread has no such batching and never blocks the main loop.
 */
import * as fs from "node:fs";

declare const self: {
  postMessage(msg: { chunk: string } | { end: true }): void;
};

const buf = Buffer.alloc(65536);
const decoder = new TextDecoder("utf-8");
for (;;) {
  let n = 0;
  try {
    n = fs.readSync(0, buf, 0, buf.length, null);
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === "EAGAIN") {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
      continue;
    }
    break; // EOF / closed fd
  }
  if (n === 0) break;
  self.postMessage({ chunk: decoder.decode(buf.subarray(0, n), { stream: true }) });
}
const tail = decoder.decode();
if (tail !== "") self.postMessage({ chunk: tail });
self.postMessage({ end: true });
