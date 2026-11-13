/**
 * fake-dap-server.ts — DAP protocol fixture for client/session tests (docs/33 §5.1).
 *
 * Mimics oh-my-pi-compatible adapter behaviour: `launch` does not respond until
 * after `configurationDone` (many real adapters block that way).
 */

import { createFakeDapConnection } from "./fake-dap-handler";

const conn = createFakeDapConnection((frame) => {
  process.stdout.write(frame);
});

process.stdin.on("data", (chunk: Buffer) => {
  conn.push(new Uint8Array(chunk));
});
