/**
 * DeepSeek-harness capability-seam reduced (docs/30 §5.7).
 *
 * One swappable surface for subprocess execution (owned spawn + sandbox wrap).
 * Local tools use `localExecutionCapability()`; tests or a remote sandbox can
 * replace `setExecutionCapability` without forking each tool call site.
 */

import { spawnOwned, type OwnedSpawn, type SpawnOwnedOptions } from "./owned-spawn";

export interface ExecutionCapability {
  spawnOwned(cmd: string[], opts: SpawnOwnedOptions): Promise<OwnedSpawn>;
}

export function localExecutionCapability(): ExecutionCapability {
  return { spawnOwned };
}

let active: ExecutionCapability = localExecutionCapability();

/** Active execution backend (default: local `spawnOwned`). */
export function getExecutionCapability(): ExecutionCapability {
  return active;
}

/** Test-only or remote-sandbox hook; restores with `resetExecutionCapability`. */
export function setExecutionCapability(cap: ExecutionCapability): void {
  active = cap;
}

export function resetExecutionCapability(): void {
  active = localExecutionCapability();
}
