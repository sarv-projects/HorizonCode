/**
 * request-dump.ts — forgecode T-9: HZ_DEBUG_REQUESTS (docs/33 §5.11).
 *
 * Appends one JSON line per outgoing provider request. Secrets are masked; file
 * mode 0600 on create. Workspace config must never enable this.
 */

import { appendFileSync, chmodSync, existsSync, mkdirSync } from "node:fs";
import * as path from "node:path";
import { maskSecrets } from "../compaction";
import { nowIso } from "../../contracts";

let noticed = false;

function ensureFile(file: string): void {
  const dir = path.dirname(file);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (!existsSync(file)) {
    appendFileSync(file, "", { mode: 0o600 });
    try {
      chmodSync(file, 0o600);
    } catch {
      /* best effort */
    }
  }
}

/** Append one masked request record when HZ_DEBUG_REQUESTS names a writable path. */
export function maybeDumpProviderRequest(provider: string, body: Record<string, unknown>): void {
  const raw = process.env.HZ_DEBUG_REQUESTS;
  if (typeof raw !== "string" || raw.trim() === "") return;
  const file = path.resolve(raw.trim());
  try {
    ensureFile(file);
    const line =
      JSON.stringify({
        at: nowIso(),
        provider,
        body: JSON.parse(maskSecrets(JSON.stringify(body))),
      }) + "\n";
    appendFileSync(file, line, { mode: 0o600 });
    if (!noticed) {
      noticed = true;
      process.stderr.write(`hzcode: provider requests logged to ${file} (HZ_DEBUG_REQUESTS)\n`);
    }
  } catch (err) {
    process.stderr.write(`hzcode: HZ_DEBUG_REQUESTS write failed: ${err instanceof Error ? err.message : String(err)}\n`);
  }
}
