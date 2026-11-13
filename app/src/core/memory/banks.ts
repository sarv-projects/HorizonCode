/**
 * banks.ts — mnemopi-style named memory banks (docs/30 §8 #4 ADAPT).
 *
 * Reduced form: three logical banks (`project`, `user`, `shared`) stored as
 * partitioned FTS rows (bank UNINDEXED column), not separate SQLite files per bank.
 * `project` lives in the workspace memory.db (MEMORY.md seeds this bank only).
 * `user` and `shared` live in the user config memory.db (~/.config/horizon or legacy).
 */

import * as path from "node:path";
import { userConfigDir } from "../paths";

/** Default bank: workspace MEMORY.md + topic files. */
export const PROJECT_BANK = "project" as const;
/** Cross-workspace user facts (user config dir). */
export const USER_BANK = "user" as const;
/** Cross-agent surface memory (user config dir, isolated partition). */
export const SHARED_BANK = "shared" as const;

export type MemoryBankId = typeof PROJECT_BANK | typeof USER_BANK | typeof SHARED_BANK;

export const MEMORY_BANKS: readonly MemoryBankId[] = [PROJECT_BANK, USER_BANK, SHARED_BANK];

/** Banks searched by shared-style cross-bank recall (`shared_*` ADAPT). */
export const SHARED_RECALL_BANKS: readonly MemoryBankId[] = [PROJECT_BANK, USER_BANK, SHARED_BANK];

const BANK_NAME_RE = /^[a-z0-9_-]{1,64}$/;

export function isMemoryBankId(name: string): name is MemoryBankId {
  return (MEMORY_BANKS as readonly string[]).includes(name);
}

export function parseMemoryBankId(name: string): MemoryBankId | undefined {
  const trimmed = name.trim().toLowerCase();
  return isMemoryBankId(trimmed) ? trimmed : undefined;
}

/** Validate arbitrary bank labels (mnemopi allows custom names; we allow the three + reject junk). */
export function validateBankName(name: string): MemoryBankId | undefined {
  const trimmed = name.trim().toLowerCase();
  if (!BANK_NAME_RE.test(trimmed)) return undefined;
  return parseMemoryBankId(trimmed);
}

export function userMemoryDbPath(home?: string): string {
  return path.join(userConfigDir(home), "memory.db");
}

export function bankStorageKind(bank: MemoryBankId): "workspace" | "user" {
  return bank === PROJECT_BANK ? "workspace" : "user";
}
