/**
 * clipboard.ts — copy with OSC 52 then platform fallbacks (docs/13 D17 reduced).
 */

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import type { ChatMsg } from "../contracts";
import { lastOfRole, osc52 } from "../core/convo";

export type ClipboardRoute = "osc52" | "pbcopy" | "wl-copy" | "xclip" | "clip.exe" | "wsl-clip" | "tmux" | "none";

export interface ClipboardResult {
  ok: boolean;
  route: ClipboardRoute;
  detail?: string;
}

function trySpawn(cmd: string, args: string[], input: string): boolean {
  try {
    const r = spawnSync(cmd, args, { input, stdio: ["pipe", "ignore", "ignore"], timeout: 2000 });
    return r.status === 0;
  } catch {
    return false;
  }
}

export function isWslLinux(env: Record<string, string | undefined> = process.env): boolean {
  if (process.platform !== "linux") return false;
  if (env.WSL_DISTRO_NAME || env.WSLENV) return true;
  try {
    return readFileSync("/proc/version", "utf8").toLowerCase().includes("microsoft");
  } catch {
    return false;
  }
}

/** Try OSC 52 on `write`, then a platform helper. Never throws. */
export function copyText(text: string, write: (chunk: string) => void = (c) => process.stdout.write(c)): ClipboardResult {
  if (text === "") return { ok: false, route: "none", detail: "empty" };
  try {
    write(osc52(text));
  } catch {
    /* terminal gone */
  }
  const platform = process.platform;
  const env = process.env as Record<string, string | undefined>;
  if (platform === "darwin" && trySpawn("pbcopy", [], text)) {
    return { ok: true, route: "pbcopy" };
  }
  if (platform === "linux") {
    if (env.WAYLAND_DISPLAY && trySpawn("wl-copy", [], text)) {
      return { ok: true, route: "wl-copy" };
    }
    if (isWslLinux(env) && trySpawn("clip.exe", [], text)) {
      return { ok: true, route: "wsl-clip" };
    }
    if (env.TMUX && trySpawn("tmux", ["load-buffer", "-"], text)) {
      return { ok: true, route: "tmux" };
    }
    if (trySpawn("xclip", ["-selection", "clipboard"], text)) {
      return { ok: true, route: "xclip" };
    }
  }
  if (platform === "win32" && trySpawn("clip.exe", [], text)) {
    return { ok: true, route: "clip.exe" };
  }
  return { ok: true, route: "osc52", detail: "terminal OSC 52 only (helper unavailable)" };
}

/** Human notice after `/copy` (scrollback and fullscreen). */
export function formatCopyNotice(res: ClipboardResult, charCount: number): string {
  if (!res.ok) return `copy failed${res.detail ? `: ${res.detail}` : ""}`;
  return `copied ${charCount} character(s) via ${res.route}${res.detail ? ` (${res.detail})` : ""}`;
}

/** Copy the latest assistant message from session history. */
export function copyAssistantFromHistory(
  history: readonly ChatMsg[] | undefined,
  write: (chunk: string) => void = (c) => process.stdout.write(c),
): { res: ClipboardResult; notice: string } {
  const text = history ? lastOfRole(history, "assistant") : undefined;
  if (text === undefined) return { res: { ok: false, route: "none", detail: "empty" }, notice: "nothing to copy yet" };
  const res = copyText(text, write);
  return { res, notice: formatCopyNotice(res, text.length) };
}
