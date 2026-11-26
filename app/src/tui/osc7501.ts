/**
 * osc7501.ts — OSC 7501 Program Status Protocol emitter.
 *
 * Emits `ESC ] 7501 ; state=<idle|working|done|blocked|error>[:kind=<permission|question>]:app=horizoncode ESC \`
 * gated cleanly on TTY + not `TERM=dumb`/`unknown` and opt-out `HZ_OSC7501=0`.
 */

export type Osc7501State = "idle" | "working" | "done" | "blocked" | "error";
export type Osc7501Kind = "permission" | "question";

export interface Osc7501Options {
  kind?: Osc7501Kind;
  app?: string;
}

export function osc7501Enabled(
  env: Record<string, string | undefined> = process.env,
  isTTY: boolean = Boolean((process.stdout as { isTTY?: boolean } | undefined)?.isTTY),
): boolean {
  if (!isTTY) return false;
  if (env.HZ_OSC7501 === "0" || env.HZ_OSC7501 === "false") return false;
  const term = (env.TERM ?? "").toLowerCase();
  if (term === "dumb" || term === "unknown") return false;
  return true;
}

export function encodeOsc7501(state: Osc7501State, opts: Osc7501Options = {}): string {
  const parts = [`state=${state}`];
  if (opts.kind !== undefined) parts.push(`kind=${opts.kind}`);
  const app = (opts.app ?? "horizoncode").replace(/[^a-zA-Z0-9._-]/g, "") || "horizoncode";
  parts.push(`app=${app}`);
  return `\x1b]7501;${parts.join(":")}\x1b\\`;
}

export function emitOsc7501(
  write: (chunk: string) => void,
  state: Osc7501State,
  opts: Osc7501Options = {},
  env: Record<string, string | undefined> = process.env,
  isTTY: boolean = Boolean((process.stdout as { isTTY?: boolean } | undefined)?.isTTY),
): boolean {
  if (!osc7501Enabled(env, isTTY)) return false;
  try {
    write(encodeOsc7501(state, opts));
    return true;
  } catch {
    return false;
  }
}
