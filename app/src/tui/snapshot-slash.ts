/**
 * /snapshot — workspace capture honesty (docs/12 S-50; ruling 270).
 */

import type { Renderer } from "./render";
import { formatWorkspaceSnapshotSlashLines } from "../core/workspace-snapshot";

export function runSnapshotSlash(renderer: Renderer): void {
  for (const line of formatWorkspaceSnapshotSlashLines()) renderer.line(line);
}
