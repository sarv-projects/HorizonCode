/**
 * Workspace snapshot capture honesty (docs/12 S-50…S-52, F1; ruling 270).
 *
 * Full workspace capture/restore is disabled until a verified Guard-and-EffectHost
 * path exists. Message-scope rewind stays on checkpoints.jsonl + the change
 * journal (/rewind); that path is ADAPTed from per-turn checkpoints, not a blob
 * store snapshot.
 */

/** docs/12 §5 — workspace capture requested while the guarded path is disabled. */
export const SNAPSHOT_CAPTURE_UNAVAILABLE = "SNAPSHOT_CAPTURE_UNAVAILABLE" as const;

/** docs/12 §5 — workspace restore requested while disabled. */
export const SNAPSHOT_RESTORE_UNAVAILABLE = "SNAPSHOT_RESTORE_UNAVAILABLE" as const;

export type WorkspaceSnapshotUnavailableCode =
  | typeof SNAPSHOT_CAPTURE_UNAVAILABLE
  | typeof SNAPSHOT_RESTORE_UNAVAILABLE;

export type WorkspaceSnapshotScope = "message" | "workspace";

export class WorkspaceSnapshotError extends Error {
  readonly code: WorkspaceSnapshotUnavailableCode;

  constructor(code: WorkspaceSnapshotUnavailableCode, detail: string) {
    super(detail);
    this.name = "WorkspaceSnapshotError";
    this.code = code;
  }
}

/** Shipped slice: workspace capture is always off (S-50). */
export function workspaceSnapshotCaptureEnabled(): boolean {
  return false;
}

export function parseWorkspaceSnapshotScope(raw: string | undefined): WorkspaceSnapshotScope {
  const s = (raw ?? "message").trim().toLowerCase();
  if (s === "workspace" || s === "--workspace") return "workspace";
  if (s === "message" || s === "" || s === "checkpoint" || s === "journal") return "message";
  throw new WorkspaceSnapshotError(
    SNAPSHOT_CAPTURE_UNAVAILABLE,
    `unknown snapshot scope ${JSON.stringify(raw)} (use message or workspace)`,
  );
}

export type WorkspaceSnapshotCaptureRequest = {
  scope: WorkspaceSnapshotScope;
  label?: string;
};

const CAPTURE_DETAIL =
  "workspace snapshot capture is disabled (S-50): SNAPSHOT_CAPTURE_UNAVAILABLE — " +
  "no verified Guard-and-EffectHost path; message-scope /rewind via checkpoints.jsonl + change journal still works";

const RESTORE_DETAIL =
  "workspace snapshot restore is disabled (S-50–S-52): SNAPSHOT_RESTORE_UNAVAILABLE — " +
  "no verified restore path; use /rewind for journaled file content only (no delete branch)";

/** Fail-closed entry for workspace-scope capture (never returns). */
export function refuseWorkspaceSnapshotCapture(_scope: "workspace" = "workspace"): never {
  throw new WorkspaceSnapshotError(SNAPSHOT_CAPTURE_UNAVAILABLE, CAPTURE_DETAIL);
}

/** Fail-closed entry for workspace-scope restore (never returns). */
export function refuseWorkspaceSnapshotRestore(): never {
  throw new WorkspaceSnapshotError(SNAPSHOT_RESTORE_UNAVAILABLE, RESTORE_DETAIL);
}

/**
 * Capture hook at a turn boundary. Message scope is satisfied by `recordCheckpoint`;
 * workspace scope refuses typed (S-50).
 */
export function requestWorkspaceSnapshotCapture(req: WorkspaceSnapshotCaptureRequest): void {
  if (req.scope === "workspace") refuseWorkspaceSnapshotCapture("workspace");
}

export type WorkspaceSnapshotHonesty = {
  captureEnabled: boolean;
  captureCode: typeof SNAPSHOT_CAPTURE_UNAVAILABLE;
  restoreCode: typeof SNAPSHOT_RESTORE_UNAVAILABLE;
  detail: string;
  lines: string[];
};

export function workspaceSnapshotHonesty(): WorkspaceSnapshotHonesty {
  return {
    captureEnabled: false,
    captureCode: SNAPSHOT_CAPTURE_UNAVAILABLE,
    restoreCode: SNAPSHOT_RESTORE_UNAVAILABLE,
    detail: CAPTURE_DETAIL,
    lines: [
      "workspace capture: DISABLED (S-50)",
      `refusal code: ${SNAPSHOT_CAPTURE_UNAVAILABLE}`,
      "message-scope restore: checkpoints.jsonl + change journal (/rewind)",
      `restore when enabled would use ${SNAPSHOT_RESTORE_UNAVAILABLE} while disabled`,
    ],
  };
}

/** Lines for TUI `/snapshot` (pure; tested without a terminal). */
export function formatWorkspaceSnapshotSlashLines(): string[] {
  return workspaceSnapshotHonesty().lines;
}
