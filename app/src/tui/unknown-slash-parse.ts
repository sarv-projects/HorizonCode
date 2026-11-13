/**
 * unknown-slash-parse.ts — `/unknown` subcommands (docs/13 R169 reduced; ruling 282).
 */

export type UnknownSlashCommand =
  | { kind: "list" }
  | { kind: "status" }
  | { kind: "inspect"; target: string }
  | { kind: "reconcile"; probe: boolean }
  | { kind: "export" }
  | { kind: "release" };

function reconcileProbeFlag(tail: string): { rest: string; probe: boolean } {
  const parts = tail.split(/\s+/).filter(Boolean);
  let probe = false;
  const kept: string[] = [];
  for (const p of parts) {
    if (p === "--probe") probe = true;
    else kept.push(p);
  }
  return { rest: kept.join(" "), probe };
}

export function parseUnknownSlashArgs(arg?: string): UnknownSlashCommand {
  const raw = typeof arg === "string" ? arg.trim() : "";
  if (raw === "") return { kind: "list" };
  const [verb, ...rest] = raw.split(/\s+/);
  const tail = rest.join(" ").trim();
  switch (verb.toLowerCase()) {
    case "inspect":
      if (tail === "") return { kind: "list" };
      return { kind: "inspect", target: tail };
    case "reconcile": {
      const { probe } = reconcileProbeFlag(tail);
      return { kind: "reconcile", probe };
    }
    case "status":
      return { kind: "status" };
    case "export":
      return { kind: "export" };
    case "release":
    case "clear":
      return { kind: "release" };
    default:
      return { kind: "inspect", target: raw };
  }
}

export const UNKNOWN_ACTION_HINTS: readonly string[] = [
  "actions (reduced R169): /unknown inspect <effect-id|receipt-id>",
  "  /unknown status            — reconcile-block latch + UNKNOWN summary",
  "  /unknown release           — clear reconcile-block latch after clean probe",
  "  /unknown reconcile       — observe-only log/receipt enrichment",
  "  /unknown reconcile --probe — read-only ledger vs kernel mismatch report",
  "  /unknown export            — write evidence JSON under .hz/state/exports/",
];
