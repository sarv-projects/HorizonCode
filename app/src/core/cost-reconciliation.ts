/**
 * cost-reconciliation.ts — F-4: compare recorded eval cost against a provider
 * invoice export (JSON or CSV fixture).
 *
 * PURE. No network, no clock, no filesystem writes: callers hand in the text of
 * an invoice export and the costs the eval runner recorded, and get back a
 * structured matched/mismatched report. This is deliberately a *reconciliation*
 * of two numbers, not a billing-truth claim: a recorded cost whose source is
 * `harness-estimate` is an estimate (see `usage-cost.ts`), and the report says
 * so. A recorded cost whose source is `reported` came from the provider.
 *
 * FAIL CLOSED: malformed JSON, a CSV with a missing/unknown column, a
 * non-numeric or negative or non-finite cost, an empty model/period — all are
 * refused with a typed `CostReconciliationError` naming the reason and the row.
 * A corrupt invoice is never read as "zero spend" (that would launder a
 * mismatch into a pass).
 *
 * Grouping is by `(model, period)` — the natural grain of both a provider
 * invoice line and a run's recorded cost. An invoice with several lines for the
 * same key is summed; recorded entries for the same key are summed too.
 */

/** Why an invoice or a comparison input was refused. */
export type CostReconciliationReason =
  | "invalid-json"
  | "invalid-shape"
  | "invalid-row"
  | "invalid-cost"
  | "invalid-recorded"
  | "invalid-tolerance";

export class CostReconciliationError extends Error {
  readonly reason: CostReconciliationReason;
  readonly detail: string;

  constructor(reason: CostReconciliationReason, detail: string) {
    super(`${reason}: ${detail}`);
    this.name = "CostReconciliationError";
    this.reason = reason;
    this.detail = detail;
  }
}

/** One invoice line, as parsed from an export. */
export interface InvoiceLine {
  model: string;
  period: string;
  costUsd: number;
}

/** A cost the eval runner recorded for one case (or an aggregate of cases). */
export interface RecordedCostEntry {
  model: string;
  period: string;
  costUsd: number;
  costSource: "none" | "harness-estimate" | "reported";
}

export interface ParsedInvoice {
  format: "json" | "csv";
  lines: InvoiceLine[];
  /** Invoice totals keyed by `model|period`. */
  totals: Record<string, number>;
}

const KEY_SEP = "|";
export function costKey(model: string, period: string): string {
  return `${model}${KEY_SEP}${period}`;
}

function isFiniteNonNegative(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function checkLine(raw: { model: unknown; period: unknown; costUsd: unknown }, where: string): InvoiceLine {
  const model = typeof raw.model === "string" ? raw.model.trim() : "";
  const period = typeof raw.period === "string" ? raw.period.trim() : "";
  if (model === "" || period === "") {
    throw new CostReconciliationError("invalid-row", `${where}: model and period must be non-blank strings`);
  }
  if (!isFiniteNonNegative(raw.costUsd)) {
    throw new CostReconciliationError(
      "invalid-cost",
      `${where}: costUsd must be a finite non-negative number (got ${JSON.stringify(raw.costUsd)})`,
    );
  }
  return { model, period, costUsd: raw.costUsd };
}

function totalsFor(lines: readonly InvoiceLine[]): Record<string, number> {
  const totals: Record<string, number> = {};
  for (const line of lines) {
    const key = costKey(line.model, line.period);
    totals[key] = (totals[key] ?? 0) + line.costUsd;
  }
  return totals;
}

/**
 * Parse a JSON invoice export. Accepts either a top-level array of lines or an
 * object with a `lines`/`invoices`/`rows` array. Each line needs
 * `{ model, period, costUsd }`.
 */
export function parseInvoiceJson(text: string, source = "invoice.json"): ParsedInvoice {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new CostReconciliationError(
      "invalid-json",
      `${source}: not valid JSON (${err instanceof Error ? err.message : String(err)})`,
    );
  }
  const arr = Array.isArray(parsed)
    ? parsed
    : parsed !== null &&
        typeof parsed === "object" &&
        (Array.isArray((parsed as { lines?: unknown }).lines)
          ? (parsed as { lines: unknown[] }).lines
          : Array.isArray((parsed as { invoices?: unknown }).invoices)
            ? (parsed as { invoices: unknown[] }).invoices
            : Array.isArray((parsed as { rows?: unknown }).rows)
              ? (parsed as { rows: unknown[] }).rows
              : undefined);
  if (arr === undefined) {
    throw new CostReconciliationError(
      "invalid-shape",
      `${source}: expected an array of lines (or an object with lines/invoices/rows)`,
    );
  }
  const lines = arr.map((raw, index) => {
    const row = raw as Partial<InvoiceLine> | null;
    if (row === null || typeof row !== "object") {
      throw new CostReconciliationError("invalid-row", `${source}[${index}]: line is not an object`);
    }
    return checkLine(
      { model: row.model, period: row.period, costUsd: row.costUsd },
      `${source}[${index}]`,
    );
  });
  return { format: "json", lines, totals: totalsFor(lines) };
}

/**
 * Parse a CSV invoice export. The header must contain `model`, `period` and a
 * cost column named `costUsd` (case-insensitive header names). Extra columns are
 * ignored. Quoted fields (including commas inside quotes) are supported.
 */
export function parseInvoiceCsv(text: string, source = "invoice.csv"): ParsedInvoice {
  const rows = parseCsvRows(text, source);
  if (rows.length === 0) {
    throw new CostReconciliationError("invalid-shape", `${source}: CSV has no header row`);
  }
  const header = rows[0]!.map((cell) => cell.trim().toLowerCase());
  const col = (name: string): number => header.indexOf(name.toLowerCase());
  const modelIdx = col("model");
  const periodIdx = col("period");
  const costIdx = col("costusd");
  if (modelIdx < 0 || periodIdx < 0 || costIdx < 0) {
    throw new CostReconciliationError(
      "invalid-shape",
      `${source}: CSV header must include model, period, costUsd (got ${header.join(", ")})`,
    );
  }
  const lines: InvoiceLine[] = [];
  for (let i = 1; i < rows.length; i += 1) {
    const cells = rows[i]!;
    const where = `${source}:${i + 1}`;
    const rawCost = cells[costIdx] ?? "";
    const costUsd = Number(rawCost);
    lines.push(
      checkLine(
        { model: cells[modelIdx] ?? "", period: cells[periodIdx] ?? "", costUsd },
        where,
      ),
    );
  }
  return { format: "csv", lines, totals: totalsFor(lines) };
}

/** Minimal RFC-4180-style CSV row parser (quoted cells, doubled quotes, CRLF). */
function parseCsvRows(text: string, source: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let inQuotes = false;
  let closedQuote = false;
  const pushCell = (): void => {
    row.push(cell);
    cell = "";
    closedQuote = false;
  };
  const pushRow = (): void => {
    pushCell();
    rows.push(row);
    row = [];
  };
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]!;
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i += 1;
        } else {
          inQuotes = false;
          closedQuote = true;
        }
      } else {
        cell += ch;
      }
      continue;
    }
    if (ch === '"') {
      if (cell === "") inQuotes = true;
      else throw new CostReconciliationError("invalid-row", `${source}: unexpected quote mid-cell`);
    } else if (ch === ",") {
      pushCell();
    } else if (ch === "\n") {
      if (cell.endsWith("\r")) cell = cell.slice(0, -1);
      pushRow();
    } else {
      if (closedQuote) {
        throw new CostReconciliationError("invalid-row", `${source}: unexpected character after closing quote`);
      }
      cell += ch;
    }
  }
  if (cell !== "" || row.length > 0) {
    if (cell.endsWith("\r")) cell = cell.slice(0, -1);
    pushRow();
  }
  return rows;
}

/** Sniff the format and parse: a leading `[` or `{` is JSON, else CSV. */
export function parseInvoiceExport(text: string, source = "invoice"): ParsedInvoice {
  const first = text.trimStart()[0];
  if (first === "[" || first === "{") return parseInvoiceJson(text, source);
  return parseInvoiceCsv(text, source);
}

export interface ReconciliationRow {
  model: string;
  period: string;
  invoiceUsd: number;
  recordedUsd: number;
  /** recordedUsd - invoiceUsd. */
  deltaUsd: number;
  /** The distinct cost sources present in the recorded entries for this key. */
  recordedSources: RecordedCostEntry["costSource"][];
}

export interface ReconciliationMismatch extends ReconciliationRow {
  /** Human-readable reason the two totals disagree. */
  reason: string;
}

export interface ReconciliationReport {
  ok: boolean;
  /** Absolute per-key tolerance used for the match decision. */
  toleranceUsd: number;
  matched: ReconciliationRow[];
  mismatched: ReconciliationMismatch[];
  /** Keys present in the invoice but with no recorded cost. */
  onlyInInvoice: ReconciliationRow[];
  /** Keys with a recorded cost but no invoice line. */
  onlyInRecorded: ReconciliationRow[];
  invoiceTotalUsd: number;
  recordedTotalUsd: number;
}

function validateRecorded(entries: readonly RecordedCostEntry[]): void {
  if (!Array.isArray(entries)) {
    throw new CostReconciliationError("invalid-recorded", "recorded entries must be an array");
  }
  const validSources: RecordedCostEntry["costSource"][] = ["none", "harness-estimate", "reported"];
  entries.forEach((entry, index) => {
    if (entry === null || typeof entry !== "object") {
      throw new CostReconciliationError("invalid-recorded", `recorded[${index}] is not an object`);
    }
    if (typeof entry.model !== "string" || entry.model.trim() === "" ||
        typeof entry.period !== "string" || entry.period.trim() === "") {
      throw new CostReconciliationError("invalid-recorded", `recorded[${index}] needs non-blank model and period`);
    }
    if (!isFiniteNonNegative(entry.costUsd)) {
      throw new CostReconciliationError("invalid-recorded", `recorded[${index}] needs a finite non-negative costUsd`);
    }
    if (!validSources.includes(entry.costSource)) {
      throw new CostReconciliationError("invalid-recorded", `recorded[${index}] has an unknown costSource`);
    }
  });
}

/**
 * Compare an invoice export with recorded eval costs. `toleranceUsd` is the
 * absolute per-key threshold below which a delta counts as matched (default
 * 1e-6 — six-decimal USD display precision, the same grain `evals.ts` reports).
 */
export function reconcileCosts(
  invoice: ParsedInvoice,
  recorded: readonly RecordedCostEntry[],
  toleranceUsd = 1e-6,
): ReconciliationReport {
  if (!isFiniteNonNegative(toleranceUsd)) {
    throw new CostReconciliationError("invalid-tolerance", "toleranceUsd must be a finite non-negative number");
  }
  validateRecorded(recorded);

  const recordedTotals: Record<string, number> = {};
  const recordedSources: Record<string, Set<RecordedCostEntry["costSource"]>> = {};
  for (const entry of recorded) {
    const key = costKey(entry.model, entry.period);
    recordedTotals[key] = (recordedTotals[key] ?? 0) + entry.costUsd;
    const set = recordedSources[key] ?? new Set();
    set.add(entry.costSource);
    recordedSources[key] = set;
  }

  const keys = [...new Set([...Object.keys(invoice.totals), ...Object.keys(recordedTotals)])].sort();
  const matched: ReconciliationRow[] = [];
  const mismatched: ReconciliationMismatch[] = [];
  const onlyInInvoice: ReconciliationRow[] = [];
  const onlyInRecorded: ReconciliationRow[] = [];

  for (const key of keys) {
    const [model = "", period = ""] = key.split(KEY_SEP);
    const inInvoice = Object.prototype.hasOwnProperty.call(invoice.totals, key);
    const inRecorded = Object.prototype.hasOwnProperty.call(recordedTotals, key);
    const invoiceUsd = inInvoice ? invoice.totals[key]! : 0;
    const recordedUsd = inRecorded ? recordedTotals[key]! : 0;
    const row: ReconciliationRow = {
      model,
      period,
      invoiceUsd,
      recordedUsd,
      deltaUsd: recordedUsd - invoiceUsd,
      recordedSources: [...(recordedSources[key] ?? new Set())],
    };
    if (!inRecorded) {
      onlyInInvoice.push(row);
    } else if (!inInvoice) {
      onlyInRecorded.push(row);
    } else if (Math.abs(row.deltaUsd) <= toleranceUsd) {
      matched.push(row);
    } else {
      mismatched.push({ ...row, reason: `recorded ($${recordedUsd.toFixed(6)}) differs from invoice ($${invoiceUsd.toFixed(6)}) by $${Math.abs(row.deltaUsd).toFixed(6)}` });
    }
  }

  const invoiceTotalUsd = Object.values(invoice.totals).reduce((s, v) => s + v, 0);
  const recordedTotalUsd = Object.values(recordedTotals).reduce((s, v) => s + v, 0);
  return {
    ok: matched.length > 0 && mismatched.length === 0 && onlyInInvoice.length === 0 && onlyInRecorded.length === 0,
    toleranceUsd,
    matched,
    mismatched,
    onlyInInvoice,
    onlyInRecorded,
    invoiceTotalUsd,
    recordedTotalUsd,
  };
}
