/**
 * receipt-inspector.ts — structured R172 receipt chain panes (docs/28 ruling 284).
 *
 * Pure formatters: effect record, receipt summary, postimage digests, chain hashes.
 * Shell process terminal reduced (**292**); RC-7 run terminal reduced (**298**).
 */

import type { Receipt } from "../contracts";
import type { EffectRecord } from "../core/effect-host";
import {
  formatRunTerminalCapabilityLines,
  latestRunCompleteFromEvents,
} from "../core/receipt-run-terminal";
import { existsSync, readFileSync } from "node:fs";
import { sessionEventsPath } from "../core/session-kernel-reconcile";
import type { ReceiptChainVerifyVerdict } from "../core/receipt-chain-verify";
import {
  mergedChildEffectIds,
  resolveChildReceiptLinks,
  type ChildReceiptLink,
} from "../core/receipt-child-list";
import { formatChildSessionStreamLines } from "../core/receipt-child-session-stream";
import {
  deriveShellEffectTerminalView,
  formatShellEffectTerminalLines,
} from "../core/receipt-shell-terminal";

export type ReceiptInspectorPaneId =
  | "effect"
  | "receipt"
  | "postimage"
  | "chain"
  | "verify"
  | "terminal"
  | "run_terminal"
  | "children";

export interface ReceiptInspectorPane {
  id: ReceiptInspectorPaneId;
  title: string;
  lines: string[];
}

export interface ReceiptInspectorModel {
  panes: ReceiptInspectorPane[];
  /** Flattened logical lines (section headers + body) for scrollback or overlay. */
  bodyLines: string[];
}

function sectionHeader(title: string): string {
  return `── ${title} ──`;
}

function readSessionEvents(workspace: string, sessionId: string): Record<string, unknown>[] {
  const file = sessionEventsPath(workspace, sessionId);
  if (!existsSync(file)) return [];
  const out: Record<string, unknown>[] = [];
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as Record<string, unknown>);
    } catch {
      /* skip */
    }
  }
  return out;
}

function effectPane(record: EffectRecord): ReceiptInspectorPane {
  const lines = [
    `effectId ${record.effectId}`,
    `tool ${record.tool}`,
    `callId ${record.callId}`,
    `steps ${record.steps.length}`,
  ];
  for (const step of record.steps) {
    const bits = [step.phase, step.at];
    if (step.ok !== undefined) bits.push(step.ok ? "ok" : "fail");
    if (step.leaseId) bits.push(`lease ${step.leaseId}`);
    if (step.receiptId) bits.push(`receipt ${step.receiptId}`);
    if (step.receiptSeq !== undefined) bits.push(`r#${step.receiptSeq}`);
    if (step.postimageDigest) bits.push(`postimage ${step.postimageDigest}`);
    if (step.postimageObservationStable === false) bits.push("postimage unstable");
    if (step.resultDigestEvidenceStable === false) bits.push("result digest unstable");
    if (step.postimageMissingAtObserve) bits.push("postimage missing at observe");
    if (step.resourceKey) bits.push(`resource ${step.resourceKey}`);
    lines.push(`  · ${bits.join(" · ")}`);
  }
  return { id: "effect", title: "Effect record", lines };
}

function receiptPane(receipt: Receipt, sessionId?: string): ReceiptInspectorPane {
  const lines = [
    `receiptId ${receipt.id}`,
    `seq ${receipt.seq}`,
    `action ${receipt.action}`,
    `tool ${receipt.tool}`,
    `ts ${receipt.ts}`,
    `argsDigest ${receipt.argsDigest}`,
    `resultDigest ${receipt.resultDigest}`,
  ];
  if (receipt.leaseId) lines.push(`leaseId ${receipt.leaseId}`);
  if (receipt.effectId) lines.push(`effectId ${receipt.effectId}`);
  if (sessionId) lines.push(`sessionId ${sessionId}`);
  lines.push("(RC-7 run terminal + terminal.run snapshot: Terminal (run) pane when session log present)");
  return { id: "receipt", title: "Receipt summary", lines };
}

function runTerminalPane(
  workspace: string | undefined,
  sessionId: string | undefined,
): ReceiptInspectorPane | undefined {
  if (!workspace || !sessionId) return undefined;
  const runComplete = latestRunCompleteFromEvents(readSessionEvents(workspace, sessionId));
  if (!runComplete) return undefined;
  return {
    id: "run_terminal",
    title: "Terminal (run / RC-7)",
    lines: formatRunTerminalCapabilityLines(runComplete.terminalRunCapability, runComplete.exit),
  };
}

function terminalPane(
  record: EffectRecord | undefined,
  opts: { workspace?: string; sessionId?: string },
): ReceiptInspectorPane | undefined {
  const view = deriveShellEffectTerminalView(record, opts);
  if (!view) return undefined;
  return {
    id: "terminal",
    title: "Terminal (process)",
    lines: formatShellEffectTerminalLines(view),
  };
}

function postimagePane(record: EffectRecord | undefined, receipt: Receipt | undefined): ReceiptInspectorPane {
  const lines: string[] = [];
  if (receipt?.postimagePath) lines.push(`postimagePath ${receipt.postimagePath}`);
  if (receipt?.postimageDigest) lines.push(`postimageDigest ${receipt.postimageDigest}`);
  const observe = record?.steps.filter((s) => s.phase === "observe");
  for (const step of observe ?? []) {
    if (step.postimageDigest && !receipt?.postimageDigest) {
      lines.push(`observe postimage ${step.postimageDigest}`);
    }
    if (step.postimageObservationStable === false) {
      lines.push("independent double-read: unstable");
    }
    if (step.postimageMissingAtObserve) lines.push("expected postimage file missing");
    if (step.resourceKey) lines.push(`resourceKey ${step.resourceKey}`);
  }
  if (lines.length === 0) lines.push("(no postimage observation recorded)");
  return { id: "postimage", title: "Postimage digests", lines };
}

function chainPane(receipt: Receipt | undefined): ReceiptInspectorPane {
  if (!receipt) {
    return {
      id: "chain",
      title: "Receipt chain",
      lines: ["(no receipt row in session log — chain inspect open)"],
    };
  }
  const lines = [
    `hash ${receipt.hash}`,
    `prevHash ${receipt.prevHash ?? "(genesis)"}`,
    `linked effectId ${receipt.effectId ?? "(none)"}`,
  ];
  return { id: "chain", title: "Receipt chain", lines };
}

function childReceiptsPane(
  links: readonly ChildReceiptLink[],
  opts?: { workspace?: string; parentSessionId?: string },
): ReceiptInspectorPane {
  if (links.length === 0) {
    return {
      id: "children",
      title: "Child receipts",
      lines: ["(no child effect links on this record)"],
    };
  }
  const lines = links.map((link) => {
    const bits = [`child effect ${link.childEffectId}`];
    if (link.tool) bits.push(`tool ${link.tool}`);
    if (link.receiptId) bits.push(`receipt ${link.receiptId}`);
    if (link.receiptSeq !== undefined) bits.push(`r#${link.receiptSeq}`);
    if (!link.receiptId) bits.push("(receipt not in workspace chain)");
    return `  · ${bits.join(" · ")}`;
  });
  if (links.length > 0 && opts?.workspace && opts.parentSessionId) {
    lines.push(...formatChildSessionStreamLines(opts.workspace, opts.parentSessionId, links.length));
  } else if (links.length > 0) {
    lines.push("(child session streams: pass workspace + sessionId for agent.spawn summary)");
  }
  return { id: "children", title: "Child receipts", lines };
}

function verifyPane(verdict: ReceiptChainVerifyVerdict | undefined): ReceiptInspectorPane {
  if (verdict === undefined) {
    return { id: "verify", title: "Chain verify", lines: ["(local verify not run)"] };
  }
  if (verdict.refusal) {
    return {
      id: "verify",
      title: "Chain verify",
      lines: [`status refused`, verdict.refusal],
    };
  }
  if (verdict.ok) {
    return {
      id: "verify",
      title: "Chain verify",
      lines: [
        "status ok",
        `count ${verdict.count}`,
        verdict.count > 0 ? `this receipt at seq ≤ ${verdict.count}` : "(empty chain)",
        verdict.anchor?.ok === false
          ? `anchor: broken at seq ${verdict.anchor.brokenAt ?? "?"}`
          : verdict.anchor?.refusal
            ? `anchor: refused`
            : verdict.anchor?.anchorAbsent
              ? "anchor: legacy (no .head)"
              : "anchor: ok when .head present",
        "(session verify: `hzcode session verify`; evidence gate **295**)",
      ],
    };
  }
  return {
    id: "verify",
    title: "Chain verify",
    lines: [
      "status broken",
      `brokenAt seq ${verdict.brokenAt ?? "?"}`,
      `verified prefix count ${verdict.count}`,
    ],
  };
}

export function buildReceiptInspectorModel(opts: {
  record?: EffectRecord;
  receipt?: Receipt;
  sessionId?: string;
  workspace?: string;
  chainVerify?: ReceiptChainVerifyVerdict;
}): ReceiptInspectorModel | undefined {
  if (!opts.record && !opts.receipt) return undefined;
  const panes: ReceiptInspectorPane[] = [];
  if (opts.record) panes.push(effectPane(opts.record));
  if (opts.receipt) panes.push(receiptPane(opts.receipt, opts.sessionId));
  const runTerm = runTerminalPane(opts.workspace, opts.sessionId);
  if (runTerm) panes.push(runTerm);
  const term = terminalPane(opts.record, { workspace: opts.workspace, sessionId: opts.sessionId });
  if (term) panes.push(term);
  panes.push(postimagePane(opts.record, opts.receipt));
  panes.push(chainPane(opts.receipt));
  const childIds = mergedChildEffectIds(opts.record, opts.receipt);
  panes.push(
    childReceiptsPane(resolveChildReceiptLinks(opts.workspace, childIds, opts.record?.tool ?? opts.receipt?.tool), {
      workspace: opts.workspace,
      parentSessionId: opts.sessionId,
    }),
  );
  panes.push(verifyPane(opts.chainVerify));

  const bodyLines: string[] = ["Receipt inspector (R172 reduced)"];
  for (const pane of panes) {
    bodyLines.push(sectionHeader(pane.title));
    for (const line of pane.lines) bodyLines.push(`  ${line}`);
  }
  return { panes, bodyLines };
}

/** Scrollback-friendly lines (headers un-indented, body indented). */
export function formatReceiptInspectorScrollbackLines(model: ReceiptInspectorModel): string[] {
  return model.bodyLines;
}
