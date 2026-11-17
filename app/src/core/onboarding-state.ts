/**
 * onboarding-state.ts — I-8 residual: persist "the first-run onboarding notice
 * has been seen" under the workspace state dir so it is shown ONCE.
 *
 * Layout (docs/03 D12 owner-only): `<workspace state dir>/onboarding.json`,
 * file 0600, parent dir 0700. The state is deliberately small and fail-closed:
 * a missing, corrupt, or wrong-version file means "not seen" (show again),
 * never a crash. `HZ_NO_ONBOARDING=1` is handled by the pure gate in
 * interactive.ts (`needsOnboarding`) — this module only records the seen bit.
 *
 * No dependency on config.ts; pure parse helper for tests.
 */

import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { workspaceStateDir } from "./paths";

const isUnix = process.platform !== "win32";
export const ONBOARDING_SEEN_VERSION = 1;
const SEEN_FILE = "onboarding.json";

export interface OnboardingSeenState {
  version: number;
  seen: boolean;
}

/** Absolute path of the persisted seen-once marker for `workspace`. */
export function onboardingSeenFile(workspace: string): string {
  return path.join(workspaceStateDir(workspace), SEEN_FILE);
}

/** Pure: parse persisted bytes; only a matching version with `seen:true` counts. */
export function parseOnboardingSeen(text: string): boolean {
  try {
    const value = JSON.parse(text) as Partial<OnboardingSeenState>;
    return value?.version === ONBOARDING_SEEN_VERSION && value.seen === true;
  } catch {
    return false;
  }
}

/** True when a well-formed seen-once marker exists. Missing/corrupt ⇒ false. */
export function hasSeenOnboarding(workspace: string): boolean {
  try {
    return parseOnboardingSeen(readFileSync(onboardingSeenFile(workspace), "utf8"));
  } catch {
    return false;
  }
}

/**
 * Persist the seen bit owner-only: 0700 dir, 0600 file (umask-proof via a
 * post-write chmod). Best-effort by contract — a state-dir that cannot be
 * written degrades to "show again next run", never a thrown error.
 */
export function markOnboardingSeen(workspace: string): void {
  const file = onboardingSeenFile(workspace);
  const dir = path.dirname(file);
  try {
    mkdirSync(dir, { recursive: true });
    if (isUnix) chmodSync(dir, 0o700);
  } catch {
    /* best effort */
  }
  try {
    const body = JSON.stringify({ version: ONBOARDING_SEEN_VERSION, seen: true });
    writeFileSync(file, body, { encoding: "utf8", mode: 0o600 });
    if (isUnix) chmodSync(file, 0o600);
  } catch {
    /* best effort */
  }
}
