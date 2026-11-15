/**
 * In-process session grant expiry cache (Wave C §8 #6).
 *
 * Records `makeGrant` expiries so the approval card can show remaining TTL.
 * Not authoritative — kernel grants win; this is display-only honesty.
 */

import type { GuardAction, GuardKind } from "../contracts";
import type { KernelClient } from "./kernel";
import { shellSavedGrantTargets } from "./shell-split";

function grantKey(sessionId: string, kind: string, target: string): string {
  return `${sessionId}\0${kind}\0${target}`;
}

const expiresAtMs = new Map<string, number>();

/** Remember grant expiry after kernel `makeGrant` or hydrate. */
export function recordSessionGrantExpiry(
  sessionId: string,
  kind: GuardKind | string,
  target: string,
  expiryIso: string,
): void {
  const sid = sessionId.trim();
  if (sid === "") return;
  const expiry = Date.parse(expiryIso);
  if (!Number.isFinite(expiry)) return;
  const targets =
    kind === "shell.exec" ? shellSavedGrantTargets("shell.exec", target) : [target.trim()];
  for (const t of targets) {
    if (t === "") continue;
    expiresAtMs.set(grantKey(sid, kind, t), expiry);
  }
}

/** Milliseconds until the cached grant expires; undefined when unknown or elapsed. */
export function sessionGrantRemainingMs(sessionId: string, kind: string, target: string): number | undefined {
  const sid = sessionId.trim();
  const t = target.trim();
  if (sid === "" || t === "") return undefined;
  const expiry = expiresAtMs.get(grantKey(sid, kind, t));
  if (expiry === undefined) return undefined;
  const rem = expiry - Date.now();
  return rem > 0 ? rem : undefined;
}

/** Pull expiry from the kernel grant table into the display cache when present. */
export async function hydrateSessionGrantFromKernel(
  kernel: Pick<KernelClient, "queryActiveGrantForAction">,
  sessionId: string,
  kind: GuardKind | string,
  target: string,
): Promise<boolean> {
  const sid = sessionId.trim();
  const tgt = target.trim();
  if (sid === "" || tgt === "") return false;
  const action: GuardAction = { kind: kind as GuardKind, target: tgt };
  const grant = await kernel.queryActiveGrantForAction(action, sid);
  const expiry = grant?.expiry;
  if (expiry === undefined || expiry.trim() === "") return false;
  recordSessionGrantExpiry(sid, kind, tgt, expiry);
  return true;
}

/** Test-only. */
export function __resetSessionGrantClockForTests(): void {
  expiresAtMs.clear();
}