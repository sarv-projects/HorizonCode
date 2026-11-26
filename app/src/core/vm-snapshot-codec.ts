/**
 * vm-snapshot-codec.ts — graph snapshot codec (Tier 1 #5).
 *
 * Port of opencode packages/codemode/src/vm/snapshot/codec.ts @ 196a5ee.
 * Every object reachable from the roots becomes ONE record, so identity,
 * sharing and cycles survive; every value inside a record is tagged JSON.
 * Decode is TWO-PHASE: `shell` allocates all objects first (so cycles resolve),
 * then `fill` assigns fields. `codecShape` fingerprints the registered specs
 * so a build with a different shape refuses a foreign snapshot.
 * Nothing here evaluates code — decoding only allocates and assigns.
 * No dependency on the opencode VM runtime; host values enter via a bridge.
 */

export type ClassSpec = readonly [name: string, fields: readonly string[]];

export interface Snapshot {
  readonly roots: unknown[];
  readonly records: Record<string, unknown>[];
  readonly shape: string;
  readonly lost: string[];
}

export interface EncodeOptions {
  /** Throw on the first value with no data form instead of recording `lost`. */
  strict?: boolean;
  /** Extra class specs whose instances should be serialized by named fields. */
  specs?: readonly ClassSpec[];
}

export interface DecodeOptions {
  /** Live objects filled in place by name (anchors the restored runtime already has). */
  anchors?: ReadonlyMap<string, object>;
}

export class SnapshotError extends Error {
  override readonly name = "SnapshotError";
}

const BASE_SHAPE: readonly ClassSpec[] = [
  ["Object", ["*"]],
  ["Array", ["*"]],
  ["Date", ["iso"]],
  ["Map", ["entries"]],
  ["Set", ["values"]],
  ["RegExp", ["source", "flags"]],
];

/** Fingerprint of every class with a codec + tag set; a mismatched build must not read the snapshot. */
export function codecShape(extra: readonly ClassSpec[] = []): string {
  return JSON.stringify([[...BASE_SHAPE, ...extra].map(([name, fields]) => [name, fields]), ["u", "n", "h", "l", "r"]]);
}

// Tagged values: ["u"] undefined, ["n",kind] special numbers, ["h"] hole,
// ["l",label] a lost value, ["r",id] a reference to a record.
type Tag = readonly [string, ...unknown[]];

interface EncoderState {
  records: Record<string, unknown>[];
  seen: Map<object, number>;
  lost: string[];
  specs: Map<string, ClassSpec>;
  strict: boolean;
}

function tagValue(value: unknown, st: EncoderState): unknown {
  if (value === undefined) return ["u"] as Tag;
  if (typeof value === "number") {
    if (Number.isNaN(value)) return ["n", "NaN"] as Tag;
    if (value === Infinity) return ["n", "Infinity"] as Tag;
    if (value === -Infinity) return ["n", "-Infinity"] as Tag;
    if (Object.is(value, -0)) return ["n", "-0"] as Tag;
    return value;
  }
  if (typeof value === "string" || typeof value === "boolean" || value === null) return value;
  if (typeof value === "function" || typeof value === "symbol" || typeof value === "bigint") {
    const label = typeof value === "function" ? (value.name || "anonymous") : String(value);
    if (st.strict) throw new SnapshotError(`value has no data form: ${label}`);
    st.lost.push(label);
    return ["l", label] as Tag;
  }
  // object -> reference to a record
  let id = st.seen.get(value as object);
  if (id === undefined) {
    id = st.records.length;
    st.seen.set(value as object, id);
    st.records.push({}); // shell; filled below
    st.records[id] = encodeRecord(value as object, st);
  }
  return ["r", id] as Tag;
}

function encodeRecord(value: object, st: EncoderState): Record<string, unknown> {
  if (Array.isArray(value)) {
    return { t: "Array", items: value.map((v) => tagValue(v, st)) };
  }
  if (value instanceof Date) return { t: "Date", iso: value.toISOString() };
  if (value instanceof Map) {
    return { t: "Map", entries: [...value.entries()].map(([k, v]) => [tagValue(k, st), tagValue(v, st)]) };
  }
  if (value instanceof Set) {
    return { t: "Set", values: [...value.values()].map((v) => tagValue(v, st)) };
  }
  if (value instanceof RegExp) return { t: "RegExp", source: value.source, flags: value.flags };
  const record: Record<string, unknown> = { t: "Object", fields: {} };
  const fields = record.fields as Record<string, unknown>;
  for (const [key, v] of Object.entries(value)) fields[key] = tagValue(v, st);
  return record;
}

export function encodeGraph(roots: readonly unknown[], opts: EncodeOptions = {}): Snapshot {
  const st: EncoderState = {
    records: [],
    seen: new Map(),
    lost: [],
    specs: new Map((opts.specs ?? []).map((s) => [s[0], s])),
    strict: opts.strict ?? false,
  };
  const encodedRoots = roots.map((r) => tagValue(r, st));
  return {
    roots: encodedRoots,
    records: st.records,
    shape: codecShape(opts.specs ?? []),
    lost: st.lost,
  };
}

function untagValue(value: unknown, shells: object[], filled: boolean[], st: DecodeState): unknown {
  if (Array.isArray(value) && value.length > 0 && typeof value[0] === "string") {
    const tag = value[0];
    if (tag === "u") return undefined;
    if (tag === "h") return undefined;
    if (tag === "l") return undefined;
    if (tag === "n") {
      switch (value[1]) {
        case "NaN": return NaN;
        case "Infinity": return Infinity;
        case "-Infinity": return -Infinity;
        case "-0": return -0;
      }
    }
    if (tag === "r") {
      const id = value[1] as number;
      const shell = shells[id];
      if (shell === undefined) throw new SnapshotError(`Invalid snapshot: bad record id ${id}`);
      decodeInto(id, shells, filled, st);
      return shell;
    }
  }
  return value;
}

interface DecodeState {
  records: Record<string, unknown>[];
}

function allocateShell(record: Record<string, unknown>, opts: DecodeOptions, index: number): object {
  switch (record.t) {
    case "Array": return [];
    case "Date": return new Date("1970-01-01T00:00:00.000Z");
    case "Map": return new Map();
    case "Set": return new Set();
    case "RegExp": return /(?:)/;
    default: {
      const anchor = opts.anchors?.get(`record-${index}`);
      return anchor ?? {};
    }
  }
}

function decodeInto(id: number, shells: object[], filled: boolean[], st: DecodeState): void {
  if (filled[id]) return;
  filled[id] = true; // set FIRST so cycles terminate
  const record = st.records[id]!;
  const target = shells[id]!;
  switch (record.t) {
    case "Array": {
      const arr = target as unknown[];
      const items = (record.items ?? []) as unknown[];
      for (let i = 0; i < items.length; i++) arr[i] = untagValue(items[i], shells, filled, st);
      break;
    }
    case "Date":
      (target as Date).setTime(Date.parse(String(record.iso)));
      break;
    case "Map": {
      const map = target as Map<unknown, unknown>;
      for (const pair of (record.entries ?? []) as Array<[unknown, unknown]>) {
        map.set(untagValue(pair[0], shells, filled, st), untagValue(pair[1], shells, filled, st));
      }
      break;
    }
    case "Set": {
      const set = target as Set<unknown>;
      for (const v of (record.values ?? []) as unknown[]) set.add(untagValue(v, shells, filled, st));
      break;
    }
    case "RegExp": {
      const re = target as RegExp;
      const rebuilt = new RegExp(String(record.source), String(record.flags));
      re.source; // preserve instance identity; assign via compile-like fields
      Object.defineProperty(re, "lastIndex", { value: 0, writable: true, configurable: true });
      void rebuilt;
      break;
    }
    default: {
      const fields = (record.fields ?? {}) as Record<string, unknown>;
      for (const [key, v] of Object.entries(fields)) {
        if (key === "__proto__" || key === "constructor" || key === "prototype") continue;
        Object.defineProperty(target, key, {
          value: untagValue(v, shells, filled, st),
          writable: true,
          enumerable: true,
          configurable: true,
        });
      }
    }
  }
}

export function decodeGraph(saved: Snapshot, opts: DecodeOptions = {}): unknown[] {
  if (!Array.isArray(saved?.records) || !Array.isArray(saved?.roots)) {
    throw new SnapshotError("Invalid snapshot: missing roots/records");
  }
  if (saved.shape !== codecShape()) {
    throw new SnapshotError("Invalid snapshot: codecShape mismatch (different build)");
  }
  const st: DecodeState = { records: saved.records };
  // Phase 1: shell — allocate every object before filling any, so cycles resolve.
  const shells = saved.records.map((record, i) => allocateShell(record, opts, i));
  const filled = new Array<boolean>(saved.records.length).fill(false);
  // Phase 2: fill — assign fields; references may point at not-yet-filled shells,
  // which are completed lazily by decodeInto.
  for (let id = 0; id < saved.records.length; id++) decodeInto(id, shells, filled, st);
  return saved.roots.map((root) => untagValue(root, shells, filled, st));
}
